import type { Classified, JsonObject, Usage } from "../../types.js";
import { classifyEmbeddedError, classifyHttpError } from "../../upstream/classify.js";
import { buildUpstreamBody } from "../../upstream/request.js";
import { effortToAdd } from "../effort.js";
import type { SseEvent } from "../../upstream/sse.js";
import { StreamToolExtras } from "../../upstream/tool-extras.js";
import { parseUsage } from "../../upstream/usage.js";
import { addNoticeToMessage, noticeChunk } from "../notice.js";
import type {
  Attempt,
  CompleteReply,
  StreamReader,
  StreamStep,
  WireProtocol,
} from "../protocol.js";
import { asObject, parseObject } from "../../json.js";
import { invalidResponse } from "../protocol.js";

const REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text", "refusal"];

function firstChoice(chunk: JsonObject): JsonObject | null {
  return Array.isArray(chunk.choices) ? asObject(chunk.choices[0]) : null;
}

const isNonEmpty = (value: unknown) =>
  (typeof value === "string" && value.length > 0) || (Array.isArray(value) && value.length > 0);

/** The commit point: the first chunk that carries model output or a finish. */
export function chunkHasOutput(chunk: JsonObject): boolean {
  const choice = firstChoice(chunk);
  if (!choice) return false;
  if (choice.finish_reason) return true;
  const delta = asObject(choice.delta);
  if (!delta) return false;
  return (
    isNonEmpty(delta.content) ||
    isNonEmpty(delta.tool_calls) ||
    delta.function_call !== undefined ||
    REASONING_FIELDS.some((field) => isNonEmpty(delta[field]))
  );
}

function deltaChars(chunk: JsonObject): number {
  const delta = asObject(firstChoice(chunk)?.delta);
  if (!delta) return 0;
  let total = typeof delta.content === "string" ? delta.content.length : 0;
  if (Array.isArray(delta.tool_calls)) total += JSON.stringify(delta.tool_calls).length;
  return total;
}

const isUsageOnly = (chunk: JsonObject) =>
  chunk.usage !== undefined &&
  chunk.usage !== null &&
  Array.isArray(chunk.choices) &&
  chunk.choices.length === 0;

/** Turns a complete response into the events of an equivalent stream. */
function responseToEvents(response: JsonObject): SseEvent[] {
  const choice = firstChoice(response) ?? {};
  const message = asObject(choice.message) ?? {};
  const toolCalls = Array.isArray(message.tool_calls)
    ? (message.tool_calls as JsonObject[]).map((call, index) => ({ index, ...call }))
    : undefined;
  const chunk = {
    id: response.id,
    object: "chat.completion.chunk",
    created: response.created,
    model: response.model,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          ...(message.content === undefined || message.content === null
            ? {}
            : { content: message.content }),
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: choice.finish_reason ?? "stop",
      },
    ],
    ...(response.usage ? { usage: response.usage } : {}),
  };
  const data = JSON.stringify(chunk);
  return [{ raw: `data: ${data}`, data, event: null, isComment: false }];
}

class ChatStreamReader implements StreamReader {
  usage: Usage | null = null;
  returnedModel: string | null = null;
  outputChars = 0;
  finished = false;
  private readonly extras: StreamToolExtras | null;
  private readonly wantsUsage: boolean;
  private template: JsonObject | null = null;
  private heldRole = false;

  constructor({ rt, ctx, account }: Attempt) {
    this.wantsUsage = ctx.wantsUsage;
    this.extras = account.compat.toolExtras
      ? new StreamToolExtras(rt.toolExtras, ctx.client.id)
      : null;
  }

  read(event: SseEvent): StreamStep {
    if (event.data === null) return { kind: "ignore" };
    if (event.data.trim() === "[DONE]") {
      this.finished = true;
      return { kind: "end" };
    }
    const chunk = parseObject(event.data);
    if (!chunk) return { kind: "ignore" };
    if (chunk.error) return { kind: "failed", cause: classifyEmbeddedError(chunk) };

    if (typeof chunk.model === "string") this.returnedModel ??= chunk.model;
    this.usage = parseUsage(chunk.usage) ?? this.usage;
    const choice = firstChoice(chunk);
    this.extras?.capture(choice?.delta);
    if (choice?.finish_reason) this.finished = true;
    this.outputChars += deltaChars(chunk);

    if (isUsageOnly(chunk) && !this.wantsUsage) return { kind: "ignore" };
    if (chunkHasOutput(chunk)) {
      this.template ??= chunk;
      return { kind: "output" };
    }
    if (asObject(choice?.delta)?.role) this.heldRole = true;
    return { kind: "pending", keepUntilCommit: true };
  }

  noticeEvent(text: string): string {
    return noticeChunk(this.template ?? {}, text, !this.heldRole);
  }

  closingText(): string {
    return "data: [DONE]\n\n";
  }

  fromDocument(text: string, now: number): SseEvent[] | Classified {
    const parsed = parseObject(text);
    if (parsed?.error && !parsed.choices) return classifyEmbeddedError(parsed, now);
    if (!parsed || !Array.isArray(parsed.choices)) {
      return invalidResponse("The upstream did not return a stream.");
    }
    return responseToEvents(parsed);
  }
}

export const openAiChat: WireProtocol = {
  supportsNotice: true,

  send(attempt, { stream, signal }) {
    const { rt, ctx, target, account } = attempt;
    const effort = effortToAdd(attempt, ctx.body.reasoning_effort);
    const request = effort ? { ...ctx.body, reasoning_effort: effort } : ctx.body;
    const body = buildUpstreamBody(request, target, account, stream, ctx.client.id, rt.toolExtras);
    return rt.upstream.sendChat(account, body, { stream, signal });
  },

  classifyHttpError,

  readComplete({ rt, ctx, account }, text, now): CompleteReply | Classified {
    const parsed = parseObject(text);
    if (parsed?.error && !parsed.choices) return classifyEmbeddedError(parsed, now);
    if (!parsed || !Array.isArray(parsed.choices) || parsed.choices.length === 0) {
      return invalidResponse("The upstream response had no choices.");
    }
    const message = firstChoice(parsed)?.message;
    if (account.compat.toolExtras) rt.toolExtras.captureMessage(ctx.client.id, message);
    return {
      usage: parseUsage(parsed.usage),
      returnedModel: typeof parsed.model === "string" ? parsed.model : null,
      outputChars: JSON.stringify(message ?? "").length,
      render(notice) {
        if (!notice) return text;
        addNoticeToMessage(parsed, notice);
        return JSON.stringify(parsed);
      },
    };
  },

  newStreamReader: (attempt) => new ChatStreamReader(attempt),
  successHeaders: () => ({}),
  forwardedError: () => null,
  allFailed: (_outcomes, capacity) => ({ status: capacity ? 429 : 502, headers: {} }),
};
