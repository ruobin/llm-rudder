import { ulid } from "../ids.js";
import type { Classified, JsonObject, Usage } from "../types.js";
import { classifyEmbeddedError } from "../upstream/classify.js";
import type { SseEvent } from "../upstream/sse.js";
import { parseUsage } from "../upstream/usage.js";
import type { ClientStreamEncoder, EncodeTarget, ResponseContext } from "./codec.js";
import {
  asArray,
  asNumber,
  asString,
  dataUrl,
  isObject,
  parseDataUrl,
  parseEffort,
  parseJsonObject,
  textOf,
  totalInputTokens,
  type Block,
  type ContentBlock,
  type FinishReason,
  type IRMessage,
  type IRRequest,
  type IRResponse,
  type IRResponseFormat,
  type IRStreamEvent,
  type IRTool,
  type IRToolChoice,
  type ToolCallBlock,
  type ToolResultBlock,
} from "./ir.js";
import {
  CUSTOM_TOOL_PARAMETERS,
  geminiSchema,
  unwrapCustomInput,
  wrapCustomInput,
  type ToolNames,
} from "./names.js";

const FINISH_TO_IR: Record<string, FinishReason> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool_calls",
  function_call: "tool_calls",
  content_filter: "content_filter",
};

const FINISH_FROM_IR: Record<FinishReason, string> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool_calls",
  content_filter: "content_filter",
  refusal: "content_filter",
};

function decodeContent(content: unknown): ContentBlock[] {
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
  const blocks: ContentBlock[] = [];
  for (const part of asArray(content)) {
    if (!isObject(part)) continue;
    if (part.type === "text" && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image_url") {
      const image = isObject(part.image_url) ? part.image_url : {};
      const url = asString(image.url) ?? asString(part.image_url) ?? "";
      const inline = parseDataUrl(url);
      const detail = asString(image.detail);
      blocks.push({
        type: "image",
        ...(inline ? inline : { url }),
        ...(detail ? { detail } : {}),
      });
    } else if (part.type === "file" && isObject(part.file)) {
      const file = part.file;
      const inline = parseDataUrl(asString(file.file_data) ?? "");
      blocks.push({
        type: "document",
        ...(inline ?? {}),
        ...(typeof file.file_id === "string" ? { fileId: file.file_id } : {}),
        ...(typeof file.filename === "string" ? { filename: file.filename } : {}),
      });
    }
  }
  return blocks;
}

function decodeToolCalls(value: unknown): ToolCallBlock[] {
  const calls: ToolCallBlock[] = [];
  for (const call of asArray(value)) {
    if (!isObject(call)) continue;
    const id = asString(call.id) ?? "";
    if (call.type === "custom" && isObject(call.custom)) {
      calls.push({
        type: "tool_call",
        id,
        name: asString(call.custom.name) ?? "",
        input: asString(call.custom.input) ?? "",
        kind: "custom",
      });
    } else if (isObject(call.function)) {
      calls.push({
        type: "tool_call",
        id,
        name: asString(call.function.name) ?? "",
        input: asString(call.function.arguments) ?? "{}",
        kind: "function",
      });
    }
  }
  return calls;
}

function decodeToolChoice(value: unknown): IRToolChoice | undefined {
  if (value === "auto" || value === "none" || value === "required") return value;
  if (isObject(value)) {
    const fn = isObject(value.function)
      ? value.function
      : isObject(value.custom)
        ? value.custom
        : {};
    if (typeof fn.name === "string") return { name: fn.name };
  }
  return undefined;
}

export function decodeResponseFormat(value: unknown): IRResponseFormat | undefined {
  if (!isObject(value)) return undefined;
  if (value.type === "json_object") return { type: "json_object" };
  const spec = isObject(value.json_schema) ? value.json_schema : value;
  if (value.type === "json_schema" && isObject(spec.schema)) {
    return {
      type: "json_schema",
      name: asString(spec.name) ?? "response",
      schema: spec.schema,
      ...(typeof spec.strict === "boolean" ? { strict: spec.strict } : {}),
      ...(typeof spec.description === "string" ? { description: spec.description } : {}),
    };
  }
  return undefined;
}

export function decodeChatRequest(body: JsonObject): IRRequest {
  const ir: IRRequest = {
    system: [],
    messages: [],
    tools: [],
    hostedTools: [],
    hostedToolsRequired: false,
  };
  const push = (role: IRMessage["role"], blocks: Block[]) => {
    if (blocks.length > 0) ir.messages.push({ role, blocks });
  };

  for (const entry of asArray(body.messages)) {
    if (!isObject(entry)) continue;
    const blocks = decodeContent(entry.content);
    switch (entry.role) {
      case "system":
      case "developer":
        if (ir.messages.length === 0) ir.system.push(textOf(blocks));
        else push("system", blocks);
        break;
      case "assistant": {
        const reasoning = asString(entry.reasoning_content) ?? asString(entry.reasoning);
        push("assistant", [
          ...(reasoning ? [{ type: "reasoning", family: "other", text: reasoning } as const] : []),
          ...blocks,
          ...decodeToolCalls(entry.tool_calls),
        ]);
        break;
      }
      case "tool": {
        const result: ToolResultBlock = {
          type: "tool_result",
          callId: asString(entry.tool_call_id) ?? "",
          content: blocks,
        };
        const last = ir.messages.at(-1);
        // Results of parallel calls belong to one turn.
        if (last?.role === "user" && last.blocks.every((block) => block.type === "tool_result")) {
          last.blocks.push(result);
        } else {
          push("user", [result]);
        }
        break;
      }
      default:
        push("user", blocks);
    }
  }

  for (const tool of asArray(body.tools)) {
    if (!isObject(tool)) continue;
    if (tool.type === "custom" && isObject(tool.custom)) {
      const custom = tool.custom;
      ir.tools.push({
        name: asString(custom.name) ?? "",
        ...(typeof custom.description === "string" ? { description: custom.description } : {}),
        parameters: CUSTOM_TOOL_PARAMETERS,
        kind: "custom",
      });
    } else if (isObject(tool.function)) {
      const fn = tool.function;
      ir.tools.push({
        name: asString(fn.name) ?? "",
        ...(typeof fn.description === "string" ? { description: fn.description } : {}),
        parameters: isObject(fn.parameters) ? fn.parameters : { type: "object", properties: {} },
        kind: "function",
      });
    }
  }

  const toolChoice = decodeToolChoice(body.tool_choice);
  const maxTokens = asNumber(body.max_completion_tokens) ?? asNumber(body.max_tokens);
  const temperature = asNumber(body.temperature);
  const topP = asNumber(body.top_p);
  const effort = parseEffort(body.reasoning_effort);
  const responseFormat = decodeResponseFormat(body.response_format);
  const stop =
    typeof body.stop === "string"
      ? [body.stop]
      : asArray(body.stop).filter((item): item is string => typeof item === "string");
  if (toolChoice) ir.toolChoice = toolChoice;
  if (typeof body.parallel_tool_calls === "boolean") {
    ir.parallelToolCalls = body.parallel_tool_calls;
  }
  if (maxTokens !== undefined) ir.maxOutputTokens = maxTokens;
  if (temperature !== undefined) ir.temperature = temperature;
  if (topP !== undefined) ir.topP = topP;
  if (stop.length > 0) ir.stop = stop;
  if (effort) ir.effort = effort;
  if (responseFormat) ir.responseFormat = responseFormat;
  return ir;
}

function encodeContent(blocks: ContentBlock[]): unknown {
  if (blocks.every((block) => block.type === "text")) return textOf(blocks);
  return blocks.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "image") {
      const url = block.data ? dataUrl(block.mediaType, block.data) : block.url;
      return {
        type: "image_url",
        image_url: { url, ...(block.detail ? { detail: block.detail } : {}) },
      };
    }
    return {
      type: "file",
      file: {
        ...(block.data ? { file_data: dataUrl(block.mediaType, block.data) } : {}),
        ...(block.fileId ? { file_id: block.fileId } : {}),
        ...(block.filename ? { filename: block.filename } : {}),
      },
    };
  });
}

const isContent = (block: Block): block is ContentBlock =>
  block.type === "text" || block.type === "image" || block.type === "document";

function encodeToolCall(call: ToolCallBlock, names: ToolNames): JsonObject {
  return {
    id: call.id,
    type: "function",
    function: {
      name: names.wire(call.name, call.namespace),
      arguments: call.kind === "custom" ? wrapCustomInput(call.input) : call.input || "{}",
    },
  };
}

/** Tool results can hold only text here, so media moves to a user message after them. */
function encodeUserMessage(blocks: Block[]): JsonObject[] {
  const output: JsonObject[] = [];
  const media: ContentBlock[] = [];
  for (const block of blocks) {
    if (block.type !== "tool_result") continue;
    const text = textOf(block.content);
    media.push(...block.content.filter((item) => item.type !== "text"));
    output.push({
      role: "tool",
      tool_call_id: block.callId,
      content: block.isError ? `Error: ${text}` : text,
    });
  }
  const content = [...media, ...blocks.filter(isContent)];
  if (content.length > 0) output.push({ role: "user", content: encodeContent(content) });
  return output;
}

function encodeTools(tools: IRTool[], target: EncodeTarget): JsonObject[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: target.names.wire(tool.name, tool.namespace),
      ...(tool.description ? { description: tool.description } : {}),
      parameters: target.geminiSchemas ? geminiSchema(tool.parameters) : tool.parameters,
    },
  }));
}

export function encodeChatRequest(
  ir: IRRequest,
  target: EncodeTarget,
  stream: boolean,
): JsonObject {
  const { names, profile } = target;
  const messages: JsonObject[] = [];
  if (ir.system.length > 0) messages.push({ role: "system", content: ir.system.join("\n\n") });
  for (const message of ir.messages) {
    if (message.role === "system") {
      messages.push({ role: "system", content: textOf(message.blocks) });
    } else if (message.role === "user") {
      messages.push(...encodeUserMessage(message.blocks));
    } else {
      const calls = message.blocks.filter((b): b is ToolCallBlock => b.type === "tool_call");
      const text = textOf(message.blocks);
      // A turn that held only reasoning has nothing this format can carry.
      if (text === "" && calls.length === 0) continue;
      messages.push({
        role: "assistant",
        content: text === "" && calls.length > 0 ? null : text,
        ...(calls.length > 0
          ? { tool_calls: calls.map((call) => encodeToolCall(call, names)) }
          : {}),
      });
    }
  }

  const body: JsonObject = { model: target.model, messages, stream };
  if (ir.tools.length > 0) {
    body.tools = encodeTools(ir.tools, target);
    if (ir.parallelToolCalls !== undefined) body.parallel_tool_calls = ir.parallelToolCalls;
  }
  if (ir.toolChoice && (ir.tools.length > 0 || ir.toolChoice === "none")) {
    body.tool_choice =
      typeof ir.toolChoice === "string"
        ? ir.toolChoice
        : {
            type: "function",
            function: { name: names.wire(ir.toolChoice.name, ir.toolChoice.namespace) },
          };
  }
  if (target.maxOutputTokens !== undefined) body.max_tokens = target.maxOutputTokens;
  if (profile.sampling) {
    if (ir.temperature !== undefined) body.temperature = ir.temperature;
    if (ir.topP !== undefined) body.top_p = ir.topP;
  }
  if (ir.stop) body.stop = ir.stop;
  if (target.effort) body.reasoning_effort = target.effort;
  if (ir.responseFormat) {
    body.response_format =
      ir.responseFormat.type === "json_object"
        ? { type: "json_object" }
        : {
            type: "json_schema",
            json_schema: {
              name: ir.responseFormat.name,
              schema: ir.responseFormat.schema,
              ...(ir.responseFormat.strict === undefined
                ? {}
                : { strict: ir.responseFormat.strict }),
            },
          };
  }
  return body;
}

function toolCallFromWire(
  id: string,
  wireName: string,
  argumentsText: string,
  ctx: ResponseContext,
): ToolCallBlock {
  const { name, namespace } = ctx.names.original(wireName);
  const custom = ctx.customTools.has(name);
  return {
    type: "tool_call",
    id: id || `call_${ulid()}`,
    name,
    ...(namespace ? { namespace } : {}),
    input: custom ? unwrapCustomInput(argumentsText) : argumentsText,
    kind: custom ? "custom" : "function",
  };
}

export function decodeChatResponse(
  parsed: JsonObject,
  ctx: ResponseContext,
): IRResponse | Classified {
  if (parsed.error && !parsed.choices) return classifyEmbeddedError(parsed);
  const choice = asArray(parsed.choices)[0];
  if (!isObject(choice)) {
    return {
      outcome: "upstream_error",
      retryElsewhere: true,
      scope: "model",
      code: "invalid_response",
      message: "The upstream response had no choices.",
    };
  }
  const message = isObject(choice.message) ? choice.message : {};
  const blocks: IRResponse["blocks"] = [];
  const reasoning = asString(message.reasoning_content) ?? asString(message.reasoning);
  if (reasoning) blocks.push({ type: "reasoning", family: "other", text: reasoning });
  const text = asString(message.content);
  if (text) blocks.push({ type: "text", text });
  for (const call of decodeToolCalls(message.tool_calls)) {
    blocks.push(toolCallFromWire(call.id, call.name, call.input, ctx));
  }
  return {
    ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
    ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
    blocks,
    finish: FINISH_TO_IR[asString(choice.finish_reason) ?? ""] ?? "stop",
    usage: parseUsage(parsed.usage),
  };
}

export function chatUsage(usage: Usage): JsonObject {
  const prompt = totalInputTokens(usage);
  return {
    prompt_tokens: prompt,
    completion_tokens: usage.outputTokens,
    total_tokens: prompt + usage.outputTokens,
    prompt_tokens_details: { cached_tokens: usage.cachedTokens },
    completion_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 },
  };
}

function encodeResponseCalls(calls: ToolCallBlock[]): JsonObject[] {
  return calls.map((call) =>
    call.kind === "custom"
      ? { id: call.id, type: "custom", custom: { name: call.name, input: call.input } }
      : {
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.input || "{}" },
        },
  );
}

export function encodeChatResponse(
  response: IRResponse,
  ctx: ResponseContext,
  notice: string | null,
): JsonObject {
  const calls = response.blocks.filter((b): b is ToolCallBlock => b.type === "tool_call");
  const text = textOf(response.blocks as Block[]);
  const reasoning = response.blocks
    .map((block) => (block.type === "reasoning" ? (block.text ?? "") : ""))
    .join("");
  const content = (notice ?? "") + text;
  return {
    id: response.id ?? `chatcmpl-${ulid()}`,
    object: "chat.completion",
    created: Math.floor(ctx.now / 1000),
    model: ctx.servedModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content === "" && calls.length > 0 ? null : content,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(calls.length > 0 ? { tool_calls: encodeResponseCalls(calls) } : {}),
        },
        finish_reason: FINISH_FROM_IR[response.finish],
      },
    ],
    ...(response.usage ? { usage: chatUsage(response.usage) } : {}),
  };
}

interface OpenChatCall {
  started: boolean;
  id: string;
  name: string;
  pending: string;
}

/** Turns an upstream Chat Completions stream into common events. */
export class ChatStreamDecoder {
  private readonly calls = new Map<number, OpenChatCall>();
  private finish: FinishReason | null = null;

  constructor(
    private readonly ctx: ResponseContext,
    private readonly onDelta?: (delta: unknown) => void,
  ) {}

  push(event: SseEvent): IRStreamEvent[] {
    if (event.data === null) return [];
    if (event.data.trim() === "[DONE]") return [...this.closeCalls(), { type: "done" }];
    const chunk = parseJsonObject(event.data);
    if (!chunk) return [];
    if (chunk.error) return [{ type: "error", cause: classifyEmbeddedError(chunk) }];

    const events: IRStreamEvent[] = [];
    if (typeof chunk.id === "string" || typeof chunk.model === "string") {
      events.push({
        type: "meta",
        ...(typeof chunk.id === "string" ? { id: chunk.id } : {}),
        ...(typeof chunk.model === "string" ? { model: chunk.model } : {}),
      });
    }
    const usage = parseUsage(chunk.usage);
    if (usage) events.push({ type: "usage", usage });

    const choice = asArray(chunk.choices)[0];
    if (!isObject(choice)) return events;
    const delta = isObject(choice.delta) ? choice.delta : {};
    this.onDelta?.(delta);

    const reasoning = asString(delta.reasoning_content) ?? asString(delta.reasoning);
    if (reasoning) events.push({ type: "reasoning", text: reasoning });
    if (typeof delta.content === "string" && delta.content !== "") {
      events.push({ type: "text", text: delta.content });
    }
    for (const entry of asArray(delta.tool_calls)) {
      if (isObject(entry)) events.push(...this.readCall(entry));
    }
    const reason = asString(choice.finish_reason);
    if (reason && !this.finish) {
      this.finish = FINISH_TO_IR[reason] ?? "stop";
      events.push(...this.closeCalls(), { type: "finish", reason: this.finish });
    }
    return events;
  }

  private readCall(entry: JsonObject): IRStreamEvent[] {
    const index = asNumber(entry.index) ?? 0;
    const fn = isObject(entry.function) ? entry.function : {};
    let call = this.calls.get(index);
    if (!call) {
      call = { started: false, id: "", name: "", pending: "" };
      this.calls.set(index, call);
    }
    call.id ||= asString(entry.id) ?? "";
    call.name ||= asString(fn.name) ?? "";
    const events: IRStreamEvent[] = [];
    const text = asString(fn.arguments) ?? "";
    if (!call.started) {
      call.pending += text;
      if (!call.name) return events;
      call.started = true;
      const original = this.ctx.names.original(call.name);
      events.push({
        type: "tool_start",
        index,
        id: call.id || `call_${ulid()}`,
        name: original.name,
        ...(original.namespace ? { namespace: original.namespace } : {}),
        kind: this.ctx.customTools.has(original.name) ? "custom" : "function",
      });
      if (call.pending) events.push({ type: "tool_delta", index, text: call.pending });
      call.pending = "";
    } else if (text) {
      events.push({ type: "tool_delta", index, text });
    }
    return events;
  }

  private closeCalls(): IRStreamEvent[] {
    const events: IRStreamEvent[] = [];
    for (const [index, call] of this.calls) {
      if (call.started) events.push({ type: "tool_end", index });
    }
    this.calls.clear();
    return events;
  }
}

/** Writes common events as a Chat Completions stream for the client. */
export class ChatStreamEncoder implements ClientStreamEncoder {
  private readonly id = `chatcmpl-${ulid()}`;
  private roleSent = false;
  private usage: Usage | null = null;
  private finish: FinishReason = "stop";
  private readonly callIndexes = new Map<number, number>();
  /** Custom tool input may arrive wrapped in JSON, so it is sent once complete. */
  private readonly customCalls = new Map<number, { id: string; name: string; text: string }>();

  constructor(private readonly ctx: ResponseContext) {}

  private chunk(delta: JsonObject, finishReason: string | null = null): string {
    return `data: ${JSON.stringify({
      id: this.id,
      object: "chat.completion.chunk",
      created: Math.floor(this.ctx.now / 1000),
      model: this.ctx.servedModel,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  }

  private withRole(delta: JsonObject): JsonObject {
    if (this.roleSent) return delta;
    this.roleSent = true;
    return { role: "assistant", ...delta };
  }

  notice(text: string): string {
    return this.chunk(this.withRole({ content: text }));
  }

  push(event: IRStreamEvent): string {
    switch (event.type) {
      case "text":
        return this.chunk(this.withRole({ content: event.text }));
      case "reasoning":
        return this.ctx.showReasoning
          ? this.chunk(this.withRole({ reasoning_content: event.text }))
          : "";
      case "tool_start": {
        const position = this.callIndexes.size;
        this.callIndexes.set(event.index, position);
        if (event.kind === "custom") {
          this.customCalls.set(event.index, { id: event.id, name: event.name, text: "" });
          return "";
        }
        return this.chunk(
          this.withRole({
            tool_calls: [
              {
                index: position,
                id: event.id,
                type: "function",
                function: { name: event.name, arguments: "" },
              },
            ],
          }),
        );
      }
      case "tool_delta": {
        const custom = this.customCalls.get(event.index);
        if (custom) {
          custom.text += event.text;
          return "";
        }
        return this.chunk({
          tool_calls: [
            { index: this.callIndexes.get(event.index) ?? 0, function: { arguments: event.text } },
          ],
        });
      }
      case "tool_end": {
        const custom = this.customCalls.get(event.index);
        if (!custom) return "";
        this.customCalls.delete(event.index);
        return this.chunk(
          this.withRole({
            tool_calls: [
              {
                index: this.callIndexes.get(event.index) ?? 0,
                id: custom.id,
                type: "custom",
                custom: { name: custom.name, input: unwrapCustomInput(custom.text) },
              },
            ],
          }),
        );
      }
      case "usage":
        this.usage = event.usage;
        return "";
      case "finish":
        this.finish = event.reason;
        return this.roleSent ? "" : this.chunk(this.withRole({ content: "" }));
      default:
        return "";
    }
  }

  close(): string {
    let text = this.chunk({}, FINISH_FROM_IR[this.finish]);
    if (this.usage && this.ctx.wantsUsage) {
      text += `data: ${JSON.stringify({
        id: this.id,
        object: "chat.completion.chunk",
        created: Math.floor(this.ctx.now / 1000),
        model: this.ctx.servedModel,
        choices: [],
        usage: chatUsage(this.usage),
      })}\n\n`;
    }
    return `${text}data: [DONE]\n\n`;
  }
}
