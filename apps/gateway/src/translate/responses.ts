import { ulid } from "../ids.js";
import type { Classified, JsonObject, Usage } from "../types.js";
import { classifyEmbeddedError } from "../upstream/classify.js";
import type { SseEvent } from "../upstream/sse.js";
import { parseUsage } from "../upstream/usage.js";
import { decodeResponseFormat } from "./chat.js";
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
  type IRRequest,
  type IRResponse,
  type IRStreamEvent,
  type IRToolChoice,
  type ToolCallBlock,
} from "./ir.js";
import { CUSTOM_TOOL_PARAMETERS, unwrapCustomInput } from "./names.js";

/** Of the tools OpenAI hosts, the ChatGPT plan route accepts only web search. */
export const isPlanHostedTool = (type: string): boolean => type.startsWith("web_search");

function decodeContent(content: unknown): ContentBlock[] {
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
  const blocks: ContentBlock[] = [];
  for (const part of asArray(content)) {
    if (!isObject(part)) continue;
    if (
      (part.type === "input_text" || part.type === "output_text" || part.type === "text") &&
      typeof part.text === "string"
    ) {
      if (part.text !== "") blocks.push({ type: "text", text: part.text });
    } else if (part.type === "refusal" && typeof part.refusal === "string") {
      blocks.push({ type: "text", text: part.refusal });
    } else if (part.type === "input_image") {
      const url = asString(part.image_url) ?? "";
      const inline = parseDataUrl(url);
      blocks.push({
        type: "image",
        ...(inline ?? (url ? { url } : {})),
        ...(typeof part.file_id === "string" ? { fileId: part.file_id } : {}),
        ...(typeof part.detail === "string" ? { detail: part.detail } : {}),
      });
    } else if (part.type === "input_file") {
      const inline = parseDataUrl(asString(part.file_data) ?? "");
      blocks.push({
        type: "document",
        ...(inline ?? {}),
        ...(typeof part.file_url === "string" ? { url: part.file_url } : {}),
        ...(typeof part.file_id === "string" ? { fileId: part.file_id } : {}),
        ...(typeof part.filename === "string" ? { filename: part.filename } : {}),
      });
    }
  }
  return blocks;
}

function decodeToolChoice(value: unknown): { choice?: IRToolChoice; hosted?: boolean } {
  if (value === "auto" || value === "none" || value === "required") return { choice: value };
  if (!isObject(value)) return {};
  if ((value.type === "function" || value.type === "custom") && typeof value.name === "string") {
    return { choice: { name: value.name } };
  }
  if (value.type === "allowed_tools")
    return { choice: value.mode === "required" ? "required" : "auto" };
  return { hosted: true };
}

export function decodeResponsesRequest(body: JsonObject): IRRequest {
  const ir: IRRequest = {
    system: [],
    messages: [],
    tools: [],
    hostedTools: [],
    hostedToolsRequired: false,
  };
  if (typeof body.instructions === "string" && body.instructions !== "") {
    ir.system.push(body.instructions);
  }

  const append = (role: "user" | "assistant", blocks: Block[]) => {
    if (blocks.length === 0) return;
    const last = ir.messages.at(-1);
    if (last?.role === role) last.blocks.push(...blocks);
    else ir.messages.push({ role, blocks });
  };

  const input =
    typeof body.input === "string"
      ? [{ type: "message", role: "user", content: body.input }]
      : asArray(body.input);
  for (const item of input) {
    if (!isObject(item)) continue;
    switch (item.type ?? "message") {
      case "message": {
        const blocks = decodeContent(item.content);
        if (item.role === "system" || item.role === "developer") {
          if (ir.messages.length === 0) ir.system.push(textOf(blocks));
          else if (blocks.length > 0) ir.messages.push({ role: "system", blocks });
        } else {
          append(item.role === "assistant" ? "assistant" : "user", blocks);
        }
        break;
      }
      case "function_call":
        append("assistant", [
          {
            type: "tool_call",
            id: asString(item.call_id) ?? "",
            name: asString(item.name) ?? "",
            ...(typeof item.namespace === "string" ? { namespace: item.namespace } : {}),
            input: asString(item.arguments) ?? "{}",
            kind: "function",
          },
        ]);
        break;
      case "custom_tool_call":
        append("assistant", [
          {
            type: "tool_call",
            id: asString(item.call_id) ?? "",
            name: asString(item.name) ?? "",
            input: asString(item.input) ?? "",
            kind: "custom",
          },
        ]);
        break;
      case "function_call_output":
      case "custom_tool_call_output":
        append("user", [
          {
            type: "tool_result",
            callId: asString(item.call_id) ?? "",
            content: decodeContent(item.output),
            ...(item.type === "custom_tool_call_output" ? { kind: "custom" as const } : {}),
          },
        ]);
        break;
      case "reasoning":
        // Without its encrypted form, a reasoning item cannot be replayed.
        if (typeof item.encrypted_content === "string") {
          append("assistant", [{ type: "reasoning", family: "openai", raw: item }]);
        }
        break;
      default:
        break;
    }
  }

  const addFunction = (tool: JsonObject, namespace?: string) => {
    ir.tools.push({
      name: asString(tool.name) ?? "",
      ...(namespace ? { namespace } : {}),
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      parameters: isObject(tool.parameters) ? tool.parameters : { type: "object", properties: {} },
      kind: "function",
    });
  };
  for (const tool of asArray(body.tools)) {
    if (!isObject(tool)) continue;
    if (tool.type === "function") addFunction(tool);
    else if (tool.type === "namespace") {
      for (const inner of asArray(tool.tools)) {
        if (isObject(inner)) addFunction(inner, asString(tool.name));
      }
    } else if (tool.type === "custom") {
      ir.tools.push({
        name: asString(tool.name) ?? "",
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        parameters: CUSTOM_TOOL_PARAMETERS,
        kind: "custom",
      });
    } else {
      ir.hostedTools.push({ family: "openai", type: String(tool.type), raw: tool });
    }
  }

  const { choice, hosted } = decodeToolChoice(body.tool_choice);
  ir.hostedToolsRequired = ir.hostedTools.length > 0 && (hosted === true || ir.tools.length === 0);
  if (choice) ir.toolChoice = choice;
  if (typeof body.parallel_tool_calls === "boolean") {
    ir.parallelToolCalls = body.parallel_tool_calls;
  }
  const maxTokens = asNumber(body.max_output_tokens);
  const temperature = asNumber(body.temperature);
  const topP = asNumber(body.top_p);
  const reasoning = isObject(body.reasoning) ? body.reasoning : {};
  const effort = parseEffort(reasoning.effort);
  const text = isObject(body.text) ? body.text : {};
  const format = decodeResponseFormat(text.format);
  if (maxTokens !== undefined) ir.maxOutputTokens = maxTokens;
  if (temperature !== undefined) ir.temperature = temperature;
  if (topP !== undefined) ir.topP = topP;
  if (effort) ir.effort = effort;
  if (typeof reasoning.summary === "string" && reasoning.summary !== "none") {
    ir.reasoningSummary = true;
  }
  if (format) ir.responseFormat = format;
  return ir;
}

function encodeInputContent(blocks: ContentBlock[]): JsonObject[] {
  return blocks.map((block) => {
    if (block.type === "text") return { type: "input_text", text: block.text };
    if (block.type === "image") {
      return {
        type: "input_image",
        ...(block.fileId ? { file_id: block.fileId } : {}),
        ...(block.data
          ? { image_url: dataUrl(block.mediaType, block.data) }
          : block.url
            ? { image_url: block.url }
            : {}),
        detail: block.detail ?? "auto",
      };
    }
    return {
      type: "input_file",
      ...(block.fileId ? { file_id: block.fileId } : {}),
      ...(block.data ? { file_data: dataUrl(block.mediaType, block.data) } : {}),
      ...(block.url ? { file_url: block.url } : {}),
      ...(block.filename ? { filename: block.filename } : {}),
    };
  });
}

const textMessage = (role: string, text: string): JsonObject => ({
  type: "message",
  role,
  content: [{ type: "input_text", text }],
});

function encodeToolOutput(content: ContentBlock[], isError?: boolean): unknown {
  if (content.every((block) => block.type === "text")) {
    const text = textOf(content);
    return isError ? `Error: ${text}` : text;
  }
  return encodeInputContent(content);
}

/** The tool fields for the plan route, which takes client tools only in a namespace. */
function planToolFields(
  ir: IRRequest,
  tools: { name: string }[],
  namespace: string,
  forcedTool: string | null,
): JsonObject {
  // A namespaced tool cannot be named in tool_choice, so a forced tool is the only one offered.
  const forced = tools.filter((tool) => tool.name === forcedTool);
  const offered = forced.length > 0 ? forced : tools;
  const hosted = ir.hostedTools
    .filter((tool) => tool.family === "openai" && isPlanHostedTool(tool.type))
    .map((tool) => tool.raw);
  const list = [
    ...(offered.length > 0
      ? [
          {
            type: "namespace",
            name: namespace,
            description: "The tools available in this conversation.",
            tools: offered,
          },
        ]
      : []),
    ...hosted,
  ];
  if (list.length === 0) return {};
  const choice = forced.length > 0 ? "required" : ir.toolChoice;
  return {
    tools: list,
    ...(typeof choice === "string" ? { tool_choice: choice } : {}),
    ...(offered.length > 0 && ir.parallelToolCalls !== undefined
      ? { parallel_tool_calls: ir.parallelToolCalls }
      : {}),
  };
}

export function encodeResponsesRequest(
  ir: IRRequest,
  target: EncodeTarget,
  stream: boolean,
): JsonObject {
  const { names, profile, planRoute } = target;
  const namespaced = planRoute ? { namespace: planRoute.toolNamespace } : {};
  const input: JsonObject[] = [];
  // Sent as the first input item, so it stays in the cached prefix.
  if (ir.system.length > 0) input.push(textMessage("developer", ir.system.join("\n\n")));

  for (const message of ir.messages) {
    if (message.role === "system") {
      input.push(textMessage("developer", textOf(message.blocks)));
      continue;
    }
    let content: ContentBlock[] = [];
    const flush = () => {
      if (content.length === 0) return;
      if (message.role === "assistant") {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: textOf(content), annotations: [] }],
        });
      } else {
        input.push({ type: "message", role: "user", content: encodeInputContent(content) });
      }
      content = [];
    };
    for (const block of message.blocks) {
      switch (block.type) {
        case "text":
        case "image":
        case "document":
          content.push(block);
          break;
        case "reasoning":
          flush();
          if (block.family === "openai" && block.raw) input.push(block.raw);
          break;
        case "tool_call":
          flush();
          for (const item of target.replay(block.id) ?? []) input.push(item as JsonObject);
          input.push(
            block.kind === "custom"
              ? {
                  type: "custom_tool_call",
                  call_id: block.id,
                  name: names.wire(block.name, block.namespace),
                  input: block.input,
                  ...namespaced,
                }
              : {
                  type: "function_call",
                  call_id: block.id,
                  name: names.wire(block.name, block.namespace),
                  arguments: block.input || "{}",
                  ...namespaced,
                },
          );
          break;
        case "tool_result":
          flush();
          input.push({
            type: block.kind === "custom" ? "custom_tool_call_output" : "function_call_output",
            call_id: block.callId,
            output: encodeToolOutput(block.content, block.isError),
          });
          break;
      }
    }
    flush();
  }

  const body: JsonObject = {
    model: target.model,
    input,
    stream,
    store: false,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: target.sessionKey,
  };
  const tools = ir.tools.map((tool) =>
    tool.kind === "custom"
      ? {
          type: "custom",
          name: names.wire(tool.name, tool.namespace),
          ...(tool.description ? { description: tool.description } : {}),
        }
      : {
          type: "function",
          name: names.wire(tool.name, tool.namespace),
          ...(tool.description ? { description: tool.description } : {}),
          parameters: tool.parameters,
          strict: false,
        },
  );
  const forcedTool =
    typeof ir.toolChoice === "object"
      ? names.wire(ir.toolChoice.name, ir.toolChoice.namespace)
      : null;
  if (planRoute) {
    Object.assign(body, planToolFields(ir, tools, planRoute.toolNamespace, forcedTool));
  } else if (tools.length > 0) {
    body.tools = tools;
    if (ir.parallelToolCalls !== undefined) body.parallel_tool_calls = ir.parallelToolCalls;
    if (forcedTool) body.tool_choice = { type: "function", name: forcedTool };
    else if (ir.toolChoice) body.tool_choice = ir.toolChoice;
  }
  // The plan route rejects these fields.
  if (!planRoute) {
    if (target.maxOutputTokens !== undefined) body.max_output_tokens = target.maxOutputTokens;
    if (profile.sampling) {
      if (ir.temperature !== undefined) body.temperature = ir.temperature;
      if (ir.topP !== undefined) body.top_p = ir.topP;
    }
  }
  const reasoning: JsonObject = {};
  if (target.effort) reasoning.effort = target.effort;
  if (ir.reasoningSummary) reasoning.summary = "auto";
  if (Object.keys(reasoning).length > 0) body.reasoning = reasoning;
  if (ir.responseFormat) {
    body.text = {
      format:
        ir.responseFormat.type === "json_object"
          ? { type: "json_object" }
          : {
              type: "json_schema",
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

export function responsesUsage(usage: Usage): JsonObject {
  const input = totalInputTokens(usage);
  return {
    input_tokens: input,
    input_tokens_details: {
      cached_tokens: usage.cachedTokens,
      cache_write_tokens: (usage.cacheWrite5mTokens ?? 0) + (usage.cacheWrite1hTokens ?? 0),
    },
    output_tokens: usage.outputTokens,
    output_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 },
    total_tokens: input + usage.outputTokens,
  };
}

function incompleteFinish(reason: unknown): FinishReason {
  return reason === "content_filter" ? "content_filter" : "length";
}

function failureOf(response: JsonObject): Classified {
  const error = isObject(response.error) ? response.error : {};
  return classifyEmbeddedError({ error: { message: "The response failed.", ...error } });
}

function wireCall(item: JsonObject, ctx: ResponseContext): ToolCallBlock {
  const { name, namespace } = ctx.names.original(asString(item.name) ?? "");
  const sent = asString(item.namespace);
  const declaredNamespace = sent && sent !== ctx.toolNamespace ? sent : namespace;
  const custom = item.type === "custom_tool_call";
  const clientCustom = ctx.customTools.has(name);
  const text = custom ? (asString(item.input) ?? "") : (asString(item.arguments) ?? "{}");
  return {
    type: "tool_call",
    id: asString(item.call_id) ?? `call_${ulid()}`,
    name,
    ...(declaredNamespace ? { namespace: declaredNamespace } : {}),
    input: clientCustom && !custom ? unwrapCustomInput(text) : text,
    kind: custom || clientCustom ? "custom" : "function",
  };
}

export function decodeResponsesResponse(
  parsed: JsonObject,
  ctx: ResponseContext,
): IRResponse | Classified {
  if (parsed.status === "failed" || (parsed.error && !parsed.output)) return failureOf(parsed);
  if (!Array.isArray(parsed.output)) {
    return {
      outcome: "upstream_error",
      retryElsewhere: true,
      scope: "model",
      code: "invalid_response",
      message: "The upstream sent no output.",
    };
  }
  const blocks: IRResponse["blocks"] = [];
  let hasCalls = false;
  let refused = false;
  for (const item of parsed.output) {
    if (!isObject(item)) continue;
    if (item.type === "message") {
      for (const part of asArray(item.content)) {
        if (!isObject(part)) continue;
        if (part.type === "output_text" && typeof part.text === "string") {
          blocks.push({ type: "text", text: part.text });
        } else if (part.type === "refusal" && typeof part.refusal === "string") {
          refused = true;
          blocks.push({ type: "text", text: part.refusal });
        }
      }
    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
      hasCalls = true;
      blocks.push(wireCall(item, ctx));
    } else if (item.type === "reasoning") {
      const summary = asArray(item.summary)
        .map((part) => (isObject(part) ? (asString(part.text) ?? "") : ""))
        .join("");
      blocks.push({
        type: "reasoning",
        family: "openai",
        ...(summary ? { text: summary } : {}),
        raw: item,
      });
    }
  }
  const details = isObject(parsed.incomplete_details) ? parsed.incomplete_details : {};
  const finish: FinishReason =
    parsed.status === "incomplete"
      ? incompleteFinish(details.reason)
      : refused
        ? "refusal"
        : hasCalls
          ? "tool_calls"
          : "stop";
  return {
    ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
    ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
    blocks,
    finish,
    usage: parseUsage(parsed.usage),
  };
}

function outputItems(response: IRResponse, notice: string | null): JsonObject[] {
  const items: JsonObject[] = [];
  let text = notice ?? "";
  const flush = () => {
    if (text === "") return;
    items.push(messageItem(`msg_${ulid()}`, text, "completed"));
    text = "";
  };
  for (const block of response.blocks) {
    if (block.type === "text") text += block.text;
    else if (block.type === "tool_call") {
      flush();
      items.push({ ...callItem(`fc_${ulid()}`, block.id, block), status: "completed" });
    } else if (block.text) {
      flush();
      items.push({
        id: `rs_${ulid()}`,
        type: "reasoning",
        summary: [{ type: "summary_text", text: block.text }],
      });
    }
  }
  flush();
  return items;
}

function messageItem(id: string, text: string, status: string): JsonObject {
  return {
    id,
    type: "message",
    status,
    role: "assistant",
    content: text === "" ? [] : [{ type: "output_text", text, annotations: [] }],
  };
}

function callItem(
  id: string,
  callId: string,
  call: { name: string; namespace?: string; kind: "function" | "custom"; input: string },
): JsonObject {
  return call.kind === "custom"
    ? { id, type: "custom_tool_call", call_id: callId, name: call.name, input: call.input }
    : {
        id,
        type: "function_call",
        call_id: callId,
        name: call.name,
        ...(call.namespace ? { namespace: call.namespace } : {}),
        arguments: call.input,
      };
}

function responseShell(id: string, ctx: ResponseContext, status: string): JsonObject {
  return {
    id,
    object: "response",
    created_at: Math.floor(ctx.now / 1000),
    status,
    error: null,
    incomplete_details: null,
    model: ctx.requestedModel,
    output: [],
    parallel_tool_calls: true,
    store: false,
    tools: [],
  };
}

function finishFields(finish: FinishReason): JsonObject {
  return finish === "length"
    ? { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }
    : finish === "content_filter" || finish === "refusal"
      ? { status: "incomplete", incomplete_details: { reason: "content_filter" } }
      : { status: "completed" };
}

export function encodeResponsesResponse(
  response: IRResponse,
  ctx: ResponseContext,
  notice: string | null,
): JsonObject {
  return {
    ...responseShell(`resp_${ulid()}`, ctx, "completed"),
    ...finishFields(response.finish),
    output: outputItems(response, notice),
    ...(response.usage ? { usage: responsesUsage(response.usage) } : {}),
  };
}

/** Turns an upstream Responses stream into common events. */
export class ResponsesStreamDecoder {
  private readonly calls = new Map<number, { sawDelta: boolean; custom: boolean }>();
  private hasCalls = false;
  private refused = false;

  constructor(private readonly ctx: ResponseContext) {}

  private terminal(response: JsonObject, reason: FinishReason): IRStreamEvent[] {
    const usage = parseUsage(response.usage);
    return [
      ...(usage ? [{ type: "usage", usage } as const] : []),
      { type: "finish", reason },
      { type: "done" },
    ];
  }

  push(event: SseEvent): IRStreamEvent[] {
    if (event.data === null) return [];
    const payload = parseJsonObject(event.data);
    if (!payload) return [];
    const index = asNumber(payload.output_index) ?? 0;
    const response = isObject(payload.response) ? payload.response : {};
    const item = isObject(payload.item) ? payload.item : {};
    const delta = asString(payload.delta) ?? "";

    switch (payload.type ?? event.event) {
      case "response.created":
        return [
          {
            type: "meta",
            ...(typeof response.id === "string" ? { id: response.id } : {}),
            ...(typeof response.model === "string" ? { model: response.model } : {}),
          },
        ];
      case "response.output_item.added":
        if (item.type !== "function_call" && item.type !== "custom_tool_call") return [];
        {
          const call = wireCall(item, this.ctx);
          this.hasCalls = true;
          this.calls.set(index, { sawDelta: false, custom: item.type === "custom_tool_call" });
          return [
            {
              type: "tool_start",
              index,
              id: call.id,
              name: call.name,
              ...(call.namespace ? { namespace: call.namespace } : {}),
              kind: call.kind,
            },
          ];
        }
      case "response.function_call_arguments.delta":
      case "response.custom_tool_call_input.delta": {
        const call = this.calls.get(index);
        if (call) call.sawDelta = true;
        return delta ? [{ type: "tool_delta", index, text: delta }] : [];
      }
      case "response.output_text.delta":
        return delta ? [{ type: "text", text: delta }] : [];
      case "response.refusal.delta":
        this.refused = true;
        return delta ? [{ type: "text", text: delta }] : [];
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        return delta ? [{ type: "reasoning", text: delta }] : [];
      case "response.output_item.done": {
        if (item.type === "reasoning") return [{ type: "artifact", family: "openai", item }];
        const call = this.calls.get(index);
        if (!call) return [];
        this.calls.delete(index);
        const whole = call.custom ? asString(item.input) : asString(item.arguments);
        return [
          ...(!call.sawDelta && whole ? [{ type: "tool_delta", index, text: whole } as const] : []),
          { type: "tool_end", index },
        ];
      }
      case "response.completed":
        return this.terminal(
          response,
          this.refused ? "refusal" : this.hasCalls ? "tool_calls" : "stop",
        );
      case "response.incomplete": {
        const details = isObject(response.incomplete_details) ? response.incomplete_details : {};
        return this.terminal(response, incompleteFinish(details.reason));
      }
      case "response.failed":
        return [{ type: "error", cause: failureOf(response) }];
      case "error": {
        const error = isObject(payload.error) ? payload.error : payload;
        return [{ type: "error", cause: classifyEmbeddedError({ error }) }];
      }
      default:
        return [];
    }
  }
}

interface OpenItem {
  id: string;
  outputIndex: number;
  kind: "message" | "reasoning" | "function_call" | "custom_tool_call";
  text: string;
  callId?: string;
  name?: string;
  namespace?: string;
}

/** Writes common events as a Responses stream for the client. */
export class ResponsesStreamEncoder implements ClientStreamEncoder {
  private readonly id = `resp_${ulid()}`;
  private started = false;
  private sequence = 0;
  private nextOutput = 0;
  private message: OpenItem | null = null;
  private reasoning: OpenItem | null = null;
  private readonly calls = new Map<number, OpenItem>();
  private readonly output: JsonObject[] = [];
  private usage: Usage | null = null;
  private finish: FinishReason = "stop";

  constructor(private readonly ctx: ResponseContext) {}

  private event(type: string, data: JsonObject): string {
    const payload = { type, sequence_number: this.sequence, ...data };
    this.sequence += 1;
    return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  }

  private start(): string {
    if (this.started) return "";
    this.started = true;
    const response = responseShell(this.id, this.ctx, "in_progress");
    return (
      this.event("response.created", { response }) +
      this.event("response.in_progress", { response })
    );
  }

  private newItem(kind: OpenItem["kind"], prefix: string): OpenItem {
    const item: OpenItem = {
      id: `${prefix}_${ulid()}`,
      outputIndex: this.nextOutput,
      kind,
      text: "",
    };
    this.nextOutput += 1;
    return item;
  }

  private closeMessage(): string {
    const item = this.message;
    if (!item) return "";
    this.message = null;
    const where = { item_id: item.id, output_index: item.outputIndex, content_index: 0 };
    const part = { type: "output_text", text: item.text, annotations: [] };
    const done = messageItem(item.id, item.text, "completed");
    this.output.push(done);
    return (
      this.event("response.output_text.done", { ...where, text: item.text, logprobs: [] }) +
      this.event("response.content_part.done", { ...where, part }) +
      this.event("response.output_item.done", { output_index: item.outputIndex, item: done })
    );
  }

  private closeReasoning(): string {
    const item = this.reasoning;
    if (!item) return "";
    this.reasoning = null;
    const where = { item_id: item.id, output_index: item.outputIndex, summary_index: 0 };
    const part = { type: "summary_text", text: item.text };
    const done = { id: item.id, type: "reasoning", summary: [part] };
    this.output.push(done);
    return (
      this.event("response.reasoning_summary_text.done", { ...where, text: item.text }) +
      this.event("response.reasoning_summary_part.done", { ...where, part }) +
      this.event("response.output_item.done", { output_index: item.outputIndex, item: done })
    );
  }

  private textDelta(text: string): string {
    let output = this.start() + this.closeReasoning();
    if (!this.message) {
      this.message = this.newItem("message", "msg");
      const { id, outputIndex } = this.message;
      output += this.event("response.output_item.added", {
        output_index: outputIndex,
        item: messageItem(id, "", "in_progress"),
      });
      output += this.event("response.content_part.added", {
        item_id: id,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    }
    this.message.text += text;
    return (
      output +
      this.event("response.output_text.delta", {
        item_id: this.message.id,
        output_index: this.message.outputIndex,
        content_index: 0,
        delta: text,
        logprobs: [],
      })
    );
  }

  notice(text: string): string {
    return this.textDelta(text);
  }

  private closeCall(index: number): string {
    const call = this.calls.get(index);
    if (!call) return "";
    this.calls.delete(index);
    const custom = call.kind === "custom_tool_call";
    const input = custom ? unwrapCustomInput(call.text) : call.text || "{}";
    const done = {
      ...callItem(call.id, call.callId ?? "", {
        name: call.name ?? "",
        ...(call.namespace ? { namespace: call.namespace } : {}),
        kind: custom ? "custom" : "function",
        input,
      }),
      status: "completed",
    };
    this.output.push(done);
    const where = { item_id: call.id, output_index: call.outputIndex };
    return (
      (custom
        ? this.event("response.custom_tool_call_input.delta", { ...where, delta: input }) +
          this.event("response.custom_tool_call_input.done", { ...where, input })
        : this.event("response.function_call_arguments.done", { ...where, arguments: input })) +
      this.event("response.output_item.done", { output_index: call.outputIndex, item: done })
    );
  }

  push(event: IRStreamEvent): string {
    switch (event.type) {
      case "text":
        return this.textDelta(event.text);
      case "reasoning": {
        if (!this.ctx.showReasoning) return "";
        let output = this.start();
        if (!this.reasoning) {
          this.reasoning = this.newItem("reasoning", "rs");
          const { id, outputIndex } = this.reasoning;
          output += this.event("response.output_item.added", {
            output_index: outputIndex,
            item: { id, type: "reasoning", summary: [] },
          });
          output += this.event("response.reasoning_summary_part.added", {
            item_id: id,
            output_index: outputIndex,
            summary_index: 0,
            part: { type: "summary_text", text: "" },
          });
        }
        this.reasoning.text += event.text;
        return (
          output +
          this.event("response.reasoning_summary_text.delta", {
            item_id: this.reasoning.id,
            output_index: this.reasoning.outputIndex,
            summary_index: 0,
            delta: event.text,
          })
        );
      }
      case "tool_start": {
        let output = this.start() + this.closeReasoning() + this.closeMessage();
        const custom = event.kind === "custom";
        const item = this.newItem(
          custom ? "custom_tool_call" : "function_call",
          custom ? "ctc" : "fc",
        );
        item.callId = event.id;
        item.name = event.name;
        if (event.namespace) item.namespace = event.namespace;
        this.calls.set(event.index, item);
        output += this.event("response.output_item.added", {
          output_index: item.outputIndex,
          item: {
            ...callItem(item.id, event.id, {
              name: event.name,
              ...(event.namespace ? { namespace: event.namespace } : {}),
              kind: event.kind,
              input: "",
            }),
            status: "in_progress",
          },
        });
        return output;
      }
      case "tool_delta": {
        const call = this.calls.get(event.index);
        if (!call) return "";
        call.text += event.text;
        // Custom input may be wrapped in JSON, so it is sent once complete.
        if (call.kind === "custom_tool_call") return "";
        return this.event("response.function_call_arguments.delta", {
          item_id: call.id,
          output_index: call.outputIndex,
          delta: event.text,
        });
      }
      case "tool_end":
        return this.closeCall(event.index);
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
    let text = this.start() + this.closeReasoning() + this.closeMessage();
    for (const index of [...this.calls.keys()]) text += this.closeCall(index);
    const fields = finishFields(this.finish);
    const response = {
      ...responseShell(this.id, this.ctx, "completed"),
      ...fields,
      output: this.output,
      usage: responsesUsage(
        this.usage ?? { inputTokens: this.ctx.inputEstimate, cachedTokens: 0, outputTokens: 0 },
      ),
    };
    const name = fields.status === "completed" ? "response.completed" : "response.incomplete";
    return text + this.event(name, { response });
  }
}
