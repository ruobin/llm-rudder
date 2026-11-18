import { ulid } from "../ids.js";
import type { Classified, JsonObject, Usage } from "../types.js";
import { AnthropicUsage, classifyAnthropicEmbedded } from "../upstream/anthropic.js";
import type { SseEvent } from "../upstream/sse.js";
import type { ClientStreamEncoder, EncodeTarget, ResponseContext } from "./codec.js";
import {
  asArray,
  asNumber,
  asString,
  isObject,
  parseEffort,
  parseJsonObject,
  textOf,
  type Block,
  type ContentBlock,
  type FinishReason,
  type IRMessage,
  type IRRequest,
  type IRResponse,
  type IRStreamEvent,
  type IRToolChoice,
  type ToolCallBlock,
} from "./ir.js";
import { cleanCallId, unwrapCustomInput, wrapCustomInput } from "./names.js";

/** Claude Code's attribution line, which only Anthropic's API understands. */
const ATTRIBUTION_PREFIX = "x-anthropic-billing-header:";
const DEFAULT_MAX_TOKENS = 16_000;
const DEFAULT_MAX_TOKENS_STREAM = 64_000;

const STOP_TO_IR: Record<string, FinishReason> = {
  end_turn: "stop",
  stop_sequence: "stop",
  pause_turn: "stop",
  max_tokens: "length",
  model_context_window_exceeded: "length",
  tool_use: "tool_calls",
  refusal: "refusal",
};

const STOP_FROM_IR: Record<FinishReason, string> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  content_filter: "refusal",
  refusal: "refusal",
};

function decodeImageLike(block: JsonObject): ContentBlock | null {
  const source = isObject(block.source) ? block.source : {};
  const fields = {
    ...(typeof source.media_type === "string" ? { mediaType: source.media_type } : {}),
    ...(source.type === "base64" && typeof source.data === "string" ? { data: source.data } : {}),
    ...(source.type === "url" && typeof source.url === "string" ? { url: source.url } : {}),
    ...(source.type === "file" && typeof source.file_id === "string"
      ? { fileId: source.file_id }
      : {}),
  };
  if (block.type === "image") return { type: "image", ...fields };
  if (source.type === "text" && typeof source.data === "string") {
    return { type: "text", text: source.data };
  }
  return {
    type: "document",
    ...fields,
    ...(typeof block.title === "string" ? { filename: block.title } : {}),
  };
}

function decodeResultContent(content: unknown, loaded: Set<string>): ContentBlock[] {
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
  const blocks: ContentBlock[] = [];
  for (const part of asArray(content)) {
    if (!isObject(part)) continue;
    if (part.type === "text" && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image" || part.type === "document") {
      const block = decodeImageLike(part);
      if (block) blocks.push(block);
    } else if (part.type === "tool_reference" && typeof part.tool_name === "string") {
      loaded.add(part.tool_name);
      blocks.push({ type: "text", text: `The tool ${part.tool_name} is now available.` });
    }
  }
  return blocks;
}

function decodeBlocks(content: unknown, loaded: Set<string>): Block[] {
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
  const blocks: Block[] = [];
  for (const block of asArray(content)) {
    if (!isObject(block)) continue;
    switch (block.type) {
      case "text":
        if (typeof block.text === "string" && block.text !== "") {
          blocks.push({ type: "text", text: block.text });
        }
        break;
      case "image":
      case "document": {
        const decoded = decodeImageLike(block);
        if (decoded) blocks.push(decoded);
        break;
      }
      case "tool_use":
        blocks.push({
          type: "tool_call",
          id: asString(block.id) ?? "",
          name: asString(block.name) ?? "",
          input: JSON.stringify(block.input ?? {}),
          kind: "function",
        });
        break;
      case "tool_result":
        blocks.push({
          type: "tool_result",
          callId: asString(block.tool_use_id) ?? "",
          content: decodeResultContent(block.content, loaded),
          ...(block.is_error === true ? { isError: true } : {}),
        });
        break;
      case "thinking":
      case "redacted_thinking":
        blocks.push({
          type: "reasoning",
          family: "anthropic",
          ...(typeof block.thinking === "string" ? { text: block.thinking } : {}),
          raw: block,
        });
        break;
      default:
        // Server tool blocks only make sense to the provider that ran them.
        break;
    }
  }
  return blocks;
}

function decodeToolChoice(value: unknown): { choice?: IRToolChoice; parallel?: boolean } {
  if (!isObject(value)) return {};
  const parallel = value.disable_parallel_tool_use === true ? { parallel: false } : {};
  if (value.type === "auto") return { choice: "auto", ...parallel };
  if (value.type === "none") return { choice: "none", ...parallel };
  if (value.type === "any") return { choice: "required", ...parallel };
  if (value.type === "tool" && typeof value.name === "string") {
    return { choice: { name: value.name }, ...parallel };
  }
  return parallel;
}

export function decodeMessagesRequest(body: JsonObject): IRRequest {
  const ir: IRRequest = {
    system: [],
    messages: [],
    tools: [],
    hostedTools: [],
    hostedToolsRequired: false,
  };
  const loadedTools = new Set<string>();

  const systemBlocks =
    typeof body.system === "string" ? [{ text: body.system }] : asArray(body.system);
  for (const block of systemBlocks) {
    const text = isObject(block) ? asString(block.text) : undefined;
    if (text && !text.startsWith(ATTRIBUTION_PREFIX)) ir.system.push(text);
  }

  for (const entry of asArray(body.messages)) {
    if (!isObject(entry)) continue;
    const blocks = decodeBlocks(entry.content, loadedTools);
    if (blocks.length === 0) continue;
    const role: IRMessage["role"] =
      entry.role === "assistant" ? "assistant" : entry.role === "system" ? "system" : "user";
    ir.messages.push({ role, blocks });
  }

  let forcedHostedTool = false;
  const { choice, parallel } = decodeToolChoice(body.tool_choice);
  for (const tool of asArray(body.tools)) {
    if (!isObject(tool)) continue;
    if (tool.type !== undefined && tool.type !== "custom") {
      const type = String(tool.type);
      ir.hostedTools.push({ family: "anthropic", type, raw: tool });
      if (typeof choice === "object" && choice.name === tool.name) forcedHostedTool = true;
      continue;
    }
    const name = asString(tool.name) ?? "";
    // Deferred tools stay hidden until a search has loaded them.
    if (tool.defer_loading === true && !loadedTools.has(name)) continue;
    ir.tools.push({
      name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      parameters: isObject(tool.input_schema)
        ? tool.input_schema
        : { type: "object", properties: {} },
      kind: "function",
    });
  }
  ir.hostedToolsRequired = ir.hostedTools.length > 0 && (forcedHostedTool || ir.tools.length === 0);

  const output = isObject(body.output_config) ? body.output_config : {};
  const thinking = isObject(body.thinking) ? body.thinking : {};
  const effort =
    parseEffort(output.effort) ?? (thinking.type === "disabled" ? ("none" as const) : undefined);
  const format = isObject(output.format) ? output.format : null;
  const maxTokens = asNumber(body.max_tokens);
  const temperature = asNumber(body.temperature);
  const topP = asNumber(body.top_p);
  const stop = asArray(body.stop_sequences).filter((s): s is string => typeof s === "string");

  if (choice) ir.toolChoice = choice;
  if (parallel !== undefined) ir.parallelToolCalls = parallel;
  if (maxTokens !== undefined) ir.maxOutputTokens = maxTokens;
  if (temperature !== undefined) ir.temperature = temperature;
  if (topP !== undefined) ir.topP = topP;
  if (stop.length > 0) ir.stop = stop;
  if (effort) ir.effort = effort;
  if (thinking.display === "summarized") ir.reasoningSummary = true;
  if (format?.type === "json_schema" && isObject(format.schema)) {
    ir.responseFormat = { type: "json_schema", name: "response", schema: format.schema };
  }
  return ir;
}

function encodeMedia(block: ContentBlock): JsonObject {
  if (block.type === "text") return { type: "text", text: block.text };
  const source = block.data
    ? { type: "base64", media_type: block.mediaType, data: block.data }
    : block.fileId
      ? { type: "file", file_id: block.fileId }
      : { type: "url", url: block.url };
  if (block.type === "image") return { type: "image", source };
  return {
    type: "document",
    source: block.data ? { ...source, media_type: block.mediaType ?? "application/pdf" } : source,
    ...(block.filename ? { title: block.filename } : {}),
  };
}

function toolInput(call: ToolCallBlock): unknown {
  const text = call.kind === "custom" ? wrapCustomInput(call.input) : call.input;
  return parseJsonObject(text || "{}") ?? {};
}

function encodeAssistant(blocks: Block[], target: EncodeTarget): JsonObject[] {
  const content: JsonObject[] = [];
  const calls = blocks.filter((b): b is ToolCallBlock => b.type === "tool_call");
  for (const block of blocks) {
    if (block.type === "reasoning" && block.family === "anthropic" && block.raw) {
      content.push(block.raw);
    }
  }
  // Thinking the gateway kept for this turn goes first, as the API requires.
  if (content.length === 0 && calls[0]) {
    for (const item of target.replay(calls[0].id) ?? []) content.push(item as JsonObject);
  }
  for (const block of blocks) {
    if (block.type === "text" && block.text !== "")
      content.push({ type: "text", text: block.text });
    else if (block.type === "tool_call") {
      content.push({
        type: "tool_use",
        id: cleanCallId(block.id),
        name: target.names.wire(block.name, block.namespace),
        input: toolInput(block),
      });
    }
  }
  return content;
}

function encodeUser(blocks: Block[]): JsonObject[] {
  const results: JsonObject[] = [];
  const others: JsonObject[] = [];
  for (const block of blocks) {
    if (block.type === "tool_result") {
      results.push({
        type: "tool_result",
        tool_use_id: cleanCallId(block.callId),
        ...(block.content.length > 0 ? { content: block.content.map(encodeMedia) } : {}),
        ...(block.isError ? { is_error: true } : {}),
      });
    } else if (block.type === "text" || block.type === "image" || block.type === "document") {
      if (block.type !== "text" || block.text !== "") others.push(encodeMedia(block));
    }
  }
  // Tool results must come first in the turn that follows the calls.
  return [...results, ...others];
}

export function maxTokensFor(
  requested: number | undefined,
  stream: boolean,
  limit: number | undefined,
): number {
  const value = requested ?? (stream ? DEFAULT_MAX_TOKENS_STREAM : DEFAULT_MAX_TOKENS);
  return limit === undefined ? value : Math.min(value, limit);
}

export function encodeMessagesRequest(
  ir: IRRequest,
  target: EncodeTarget,
  stream: boolean,
): JsonObject {
  const { profile, names } = target;
  const system: JsonObject[] = ir.system
    .filter((text) => text !== "")
    .map((text) => ({ type: "text", text }));
  if (ir.responseFormat?.type === "json_object") {
    system.push({ type: "text", text: "Respond with a single JSON object and no other text." });
  }

  const messages: { role: string; content: JsonObject[] }[] = [];
  const add = (role: string, content: JsonObject[]) => {
    if (content.length === 0) return;
    const last = messages.at(-1);
    // Consecutive turns from one side are merged, keeping tool results first.
    if (last?.role === role && role !== "system") last.content.push(...content);
    else messages.push({ role, content });
  };
  for (const message of ir.messages) {
    if (message.role === "assistant") add("assistant", encodeAssistant(message.blocks, target));
    else if (message.role === "user") add("user", encodeUser(message.blocks));
    else if (profile.systemMessages) {
      add("system", [{ type: "text", text: textOf(message.blocks) }]);
    } else {
      add("user", [
        { type: "text", text: `<system-reminder>\n${textOf(message.blocks)}\n</system-reminder>` },
      ]);
    }
  }

  const last = messages.at(-1);
  if (
    last?.role === "assistant" &&
    !profile.prefill &&
    !last.content.some((b) => b.type === "tool_use")
  ) {
    // Current models reject a reply that starts from a prefilled assistant turn.
    const text = last.content
      .map((block) => (block.type === "text" ? String(block.text) : ""))
      .join("");
    messages.pop();
    add("user", [
      {
        type: "text",
        text: `Your previous response was interrupted and ended with:\n${text}\nContinue from where you left off.`,
      },
    ]);
  }
  if (messages[0]?.role === "assistant") {
    messages.unshift({ role: "user", content: [{ type: "text", text: "Continue." }] });
  }

  const body: JsonObject = {
    model: target.model,
    max_tokens: maxTokensFor(ir.maxOutputTokens, stream, profile.maxOutputTokens),
    messages,
    stream,
  };
  if (system.length > 0) body.system = system;
  if (ir.tools.length > 0) {
    body.tools = ir.tools.map((tool) => ({
      name: names.wire(tool.name, tool.namespace),
      ...(tool.description ? { description: tool.description } : {}),
      input_schema: tool.parameters,
    }));
    const noParallel = ir.parallelToolCalls === false ? { disable_parallel_tool_use: true } : {};
    let choice: JsonObject = { type: "auto", ...noParallel };
    if (ir.toolChoice === "none") choice = { type: "none" };
    else if (profile.forcedToolChoice && ir.toolChoice === "required") {
      choice = { type: "any", ...noParallel };
    } else if (profile.forcedToolChoice && typeof ir.toolChoice === "object") {
      choice = {
        type: "tool",
        name: names.wire(ir.toolChoice.name, ir.toolChoice.namespace),
        ...noParallel,
      };
    }
    body.tool_choice = choice;
  }
  if (profile.sampling) {
    if (ir.temperature !== undefined) body.temperature = ir.temperature;
    else if (ir.topP !== undefined) body.top_p = ir.topP;
  }
  const stop = ir.stop?.filter((item) => item.trim() !== "");
  if (stop?.length) body.stop_sequences = stop;
  if (profile.adaptiveThinking) {
    body.thinking = { type: "adaptive", display: ir.reasoningSummary ? "summarized" : "omitted" };
  }

  const outputConfig: JsonObject = {};
  if (target.effort) outputConfig.effort = target.effort;
  if (ir.responseFormat?.type === "json_schema") {
    outputConfig.format = { type: "json_schema", schema: ir.responseFormat.schema };
  }
  if (Object.keys(outputConfig).length > 0) body.output_config = outputConfig;

  if (target.autoCache) body.cache_control = { type: "ephemeral" };
  else if (system.length > 0) system.at(-1)!.cache_control = { type: "ephemeral" };
  return body;
}

export function messagesUsage(usage: Usage): JsonObject {
  const write5m = usage.cacheWrite5mTokens ?? 0;
  const write1h = usage.cacheWrite1hTokens ?? 0;
  return {
    input_tokens: usage.inputTokens,
    cache_creation_input_tokens: write5m + write1h,
    cache_read_input_tokens: usage.cachedTokens,
    cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h },
    output_tokens: usage.outputTokens,
  };
}

function wireToolCall(block: JsonObject, ctx: ResponseContext): ToolCallBlock {
  const { name, namespace } = ctx.names.original(asString(block.name) ?? "");
  const custom = ctx.customTools.has(name);
  const text = JSON.stringify(block.input ?? {});
  return {
    type: "tool_call",
    id: asString(block.id) ?? `toolu_${ulid()}`,
    name,
    ...(namespace ? { namespace } : {}),
    input: custom ? unwrapCustomInput(text) : text,
    kind: custom ? "custom" : "function",
  };
}

export function decodeMessagesResponse(
  parsed: JsonObject,
  ctx: ResponseContext,
): IRResponse | Classified {
  if (parsed.type === "error" || parsed.error) return classifyAnthropicEmbedded(parsed);
  if (parsed.type !== "message") {
    return {
      outcome: "upstream_error",
      retryElsewhere: true,
      scope: "model",
      code: "invalid_response",
      message: "The upstream sent no message.",
    };
  }
  const blocks: IRResponse["blocks"] = [];
  for (const block of asArray(parsed.content)) {
    if (!isObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      blocks.push(wireToolCall(block, ctx));
    } else if (block.type === "thinking" || block.type === "redacted_thinking") {
      blocks.push({
        type: "reasoning",
        family: "anthropic",
        ...(typeof block.thinking === "string" ? { text: block.thinking } : {}),
        raw: block,
      });
    }
  }
  const tokens = new AnthropicUsage();
  tokens.add(parsed.usage);
  return {
    ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
    ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
    blocks,
    finish: STOP_TO_IR[asString(parsed.stop_reason) ?? ""] ?? "stop",
    usage: tokens.value,
  };
}

export function encodeMessagesResponse(
  response: IRResponse,
  ctx: ResponseContext,
  _notice: string | null,
): JsonObject {
  const content: JsonObject[] = [];
  for (const block of response.blocks) {
    if (block.type === "text") content.push({ type: "text", text: block.text });
    else if (block.type === "tool_call") {
      content.push({
        type: "tool_use",
        id: cleanCallId(block.id),
        name: block.name,
        input: toolInput(block),
      });
    }
  }
  return {
    id: `msg_${ulid()}`,
    type: "message",
    role: "assistant",
    model: ctx.requestedModel,
    content,
    stop_reason: STOP_FROM_IR[response.finish],
    stop_sequence: null,
    usage: messagesUsage(
      response.usage ?? { inputTokens: ctx.inputEstimate, cachedTokens: 0, outputTokens: 0 },
    ),
  };
}

/** Turns an upstream Messages stream into common events. */
export class MessagesStreamDecoder {
  private readonly tokens = new AnthropicUsage();
  private readonly openTools = new Set<number>();
  private thinking: JsonObject | null = null;

  constructor(private readonly ctx: ResponseContext) {}

  private usageEvent(): IRStreamEvent[] {
    const usage = this.tokens.value;
    return usage ? [{ type: "usage", usage }] : [];
  }

  push(event: SseEvent): IRStreamEvent[] {
    if (event.data === null) return [];
    const payload = parseJsonObject(event.data);
    if (!payload) return [];
    const index = asNumber(payload.index) ?? 0;

    switch (payload.type ?? event.event) {
      case "message_start": {
        const message = isObject(payload.message) ? payload.message : {};
        this.tokens.add(message.usage);
        return [
          {
            type: "meta",
            ...(typeof message.id === "string" ? { id: message.id } : {}),
            ...(typeof message.model === "string" ? { model: message.model } : {}),
          },
          ...this.usageEvent(),
        ];
      }
      case "content_block_start": {
        const block = isObject(payload.content_block) ? payload.content_block : {};
        if (block.type === "text") {
          return block.text ? [{ type: "text", text: String(block.text) }] : [];
        }
        if (block.type === "tool_use") {
          const { name, namespace } = this.ctx.names.original(asString(block.name) ?? "");
          this.openTools.add(index);
          return [
            {
              type: "tool_start",
              index,
              id: asString(block.id) ?? `toolu_${ulid()}`,
              name,
              ...(namespace ? { namespace } : {}),
              kind: this.ctx.customTools.has(name) ? "custom" : "function",
            },
          ];
        }
        if (block.type === "thinking" || block.type === "redacted_thinking") {
          this.thinking = { ...block };
        }
        return [];
      }
      case "content_block_delta": {
        const delta = isObject(payload.delta) ? payload.delta : {};
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          return [{ type: "text", text: delta.text }];
        }
        if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          return delta.partial_json
            ? [{ type: "tool_delta", index, text: delta.partial_json }]
            : [];
        }
        if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          if (this.thinking) {
            this.thinking.thinking = `${asString(this.thinking.thinking) ?? ""}${delta.thinking}`;
          }
          return delta.thinking ? [{ type: "reasoning", text: delta.thinking }] : [];
        }
        if (delta.type === "signature_delta" && typeof delta.signature === "string") {
          if (this.thinking) {
            this.thinking.signature = `${asString(this.thinking.signature) ?? ""}${delta.signature}`;
          }
        }
        return [];
      }
      case "content_block_stop":
        if (this.openTools.delete(index)) return [{ type: "tool_end", index }];
        if (this.thinking) {
          const item = this.thinking;
          this.thinking = null;
          return [{ type: "artifact", family: "anthropic", item }];
        }
        return [];
      case "message_delta": {
        this.tokens.add(payload.usage);
        const delta = isObject(payload.delta) ? payload.delta : {};
        const reason = asString(delta.stop_reason);
        return [
          ...this.usageEvent(),
          ...(reason ? [{ type: "finish", reason: STOP_TO_IR[reason] ?? "stop" } as const] : []),
        ];
      }
      case "message_stop":
        return [{ type: "done" }];
      case "error":
        return [{ type: "error", cause: classifyAnthropicEmbedded(payload) }];
      default:
        return [];
    }
  }
}

const sse = (type: string, data: JsonObject = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

interface PendingTool {
  index: number;
  id: string;
  name: string;
  text: string;
}

/** Writes common events as a Messages stream for the client. */
export class MessagesStreamEncoder implements ClientStreamEncoder {
  private started = false;
  private nextIndex = 0;
  private open: { kind: "text" } | { kind: "tool"; source: number } | null = null;
  private openIndex = 0;
  private readonly pending: PendingTool[] = [];
  private usage: Usage | null = null;
  private finish: FinishReason = "stop";

  constructor(private readonly ctx: ResponseContext) {}

  private start(): string {
    if (this.started) return "";
    this.started = true;
    return sse("message_start", {
      message: {
        id: `msg_${ulid()}`,
        type: "message",
        role: "assistant",
        model: this.ctx.requestedModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.ctx.inputEstimate, output_tokens: 1 },
      },
    });
  }

  private closeOpen(): string {
    if (!this.open) return "";
    this.open = null;
    return sse("content_block_stop", { index: this.openIndex });
  }

  private openBlock(contentBlock: JsonObject, open: NonNullable<typeof this.open>): string {
    this.openIndex = this.nextIndex;
    this.nextIndex += 1;
    this.open = open;
    return sse("content_block_start", { index: this.openIndex, content_block: contentBlock });
  }

  private toolBlock(id: string, name: string): JsonObject {
    return { type: "tool_use", id: cleanCallId(id), name, input: {} };
  }

  /** Tools that overlapped another tool are written whole, one after the other. */
  private flushPending(): string {
    let text = "";
    for (const tool of this.pending.splice(0)) {
      text += this.closeOpen();
      text += this.openBlock(this.toolBlock(tool.id, tool.name), {
        kind: "tool",
        source: tool.index,
      });
      if (tool.text) {
        text += sse("content_block_delta", {
          index: this.openIndex,
          delta: { type: "input_json_delta", partial_json: tool.text },
        });
      }
    }
    return text;
  }

  // Claude Code shows warnings in its status line, not in the model's reply.
  notice(): string {
    return "";
  }

  push(event: IRStreamEvent): string {
    switch (event.type) {
      case "text": {
        let text = this.start();
        if (this.open?.kind !== "text") {
          text += this.closeOpen() + this.flushPending() + this.closeOpen();
          text += this.openBlock({ type: "text", text: "" }, { kind: "text" });
        }
        return (
          text +
          sse("content_block_delta", {
            index: this.openIndex,
            delta: { type: "text_delta", text: event.text },
          })
        );
      }
      case "tool_start": {
        let text = this.start();
        if (this.open?.kind === "tool") {
          this.pending.push({ index: event.index, id: event.id, name: event.name, text: "" });
          return text;
        }
        text += this.closeOpen();
        return (
          text +
          this.openBlock(this.toolBlock(event.id, event.name), {
            kind: "tool",
            source: event.index,
          })
        );
      }
      case "tool_delta": {
        if (this.open?.kind === "tool" && this.open.source === event.index) {
          return sse("content_block_delta", {
            index: this.openIndex,
            delta: { type: "input_json_delta", partial_json: event.text },
          });
        }
        const waiting = this.pending.find((tool) => tool.index === event.index);
        if (waiting) waiting.text += event.text;
        return "";
      }
      case "usage":
        this.usage = event.usage;
        return "";
      case "finish":
        this.finish = event.reason;
        return this.start();
      default:
        return "";
    }
  }

  close(): string {
    let text = this.start() + this.closeOpen() + this.flushPending() + this.closeOpen();
    text += sse("message_delta", {
      delta: { stop_reason: STOP_FROM_IR[this.finish], stop_sequence: null },
      usage: messagesUsage(
        this.usage ?? { inputTokens: this.ctx.inputEstimate, cachedTokens: 0, outputTokens: 0 },
      ),
    });
    return text + sse("message_stop");
  }
}
