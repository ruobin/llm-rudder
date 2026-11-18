import {
  anthropicResponseHeaders,
  replaceTopLevelString,
  setTopLevelField,
} from "@llm-rudder/shared";
import type { Classified, JsonObject, Usage } from "../../types.js";
import {
  AnthropicUsage,
  classifyAnthropicEmbedded,
  classifyAnthropicHttpError,
} from "../../upstream/anthropic.js";
import type { SseEvent } from "../../upstream/sse.js";
import { effortToAdd } from "../effort.js";
import type { CompleteReply, StreamReader, StreamStep, WireProtocol } from "../protocol.js";
import { parseObject } from "../../json.js";
import { invalidResponse } from "../protocol.js";

function deltaChars(delta: JsonObject | undefined): number {
  if (!delta) return 0;
  for (const field of ["text", "partial_json", "thinking"]) {
    const value = delta[field];
    if (typeof value === "string") return value.length;
  }
  return 0;
}

class MessagesStreamReader implements StreamReader {
  returnedModel: string | null = null;
  outputChars = 0;
  finished = false;
  private readonly tokens = new AnthropicUsage();

  get usage(): Usage | null {
    return this.tokens.value;
  }

  read(event: SseEvent): StreamStep {
    if (event.data === null) return { kind: "ignore" };
    const payload = parseObject(event.data);
    if (!payload) return { kind: "ignore" };

    switch (payload.type ?? event.event) {
      case "ping":
        // Keep-alives are not worth replaying once output starts.
        return { kind: "pending", keepUntilCommit: false };
      case "message_start": {
        const message = payload.message as JsonObject | undefined;
        if (typeof message?.model === "string") this.returnedModel = message.model;
        this.tokens.add(message?.usage);
        return { kind: "pending", keepUntilCommit: true };
      }
      case "content_block_start":
      case "content_block_stop":
        return { kind: "output" };
      case "content_block_delta":
        this.outputChars += deltaChars(payload.delta as JsonObject | undefined);
        return { kind: "output" };
      case "message_delta":
        this.tokens.add(payload.usage);
        if ((payload.delta as JsonObject | undefined)?.stop_reason) this.finished = true;
        return { kind: "output" };
      case "message_stop":
        this.finished = true;
        return { kind: "output", last: true };
      case "error":
        return { kind: "failed", cause: classifyAnthropicEmbedded(payload) };
      default:
        // New event types can appear at any time, so they are passed along.
        return { kind: "pending", keepUntilCommit: true };
    }
  }

  // Claude Code gets its warning from the status line, not from model output.
  noticeEvent(): null {
    return null;
  }

  closingText(): null {
    return null;
  }

  fromDocument(text: string, now: number): SseEvent[] | Classified {
    const parsed = parseObject(text);
    if (parsed?.type === "error" || parsed?.error) return classifyAnthropicEmbedded(parsed, now);
    return invalidResponse("The upstream did not return a stream.");
  }
}

export const anthropicMessages: WireProtocol = {
  supportsNotice: false,

  // Claude Code compacts its conversation when it sees this wording.
  describeRejection: (result) => ({
    ...(result.outcome === "context_overflow"
      ? { message: "prompt is too long for the model that served this request" }
      : {}),
    headers: { "x-llmr-upstream-error": "1" },
  }),

  send(attempt, { stream, signal }) {
    const { rt, ctx, target, account } = attempt;
    // Messages stay byte for byte the same, so prompt caching and signatures keep working.
    let body = replaceTopLevelString(ctx.rawBody as Buffer, "model", target.model);
    if (!body) throw new Error("The request has no model field.");
    const output = (ctx.body.output_config ?? {}) as JsonObject;
    const effort = effortToAdd(attempt, output.effort);
    if (effort) body = setTopLevelField(body, "output_config", { ...output, effort }) ?? body;
    return rt.upstream.sendAnthropic(account, {
      path: "/v1/messages",
      query: ctx.upstreamQuery ?? "",
      body,
      headers: ctx.upstreamHeaders ?? {},
      stream,
      signal,
    });
  },

  classifyHttpError: classifyAnthropicHttpError,

  readComplete(_attempt, text, now): CompleteReply | Classified {
    const parsed = parseObject(text);
    if (parsed?.type === "error" || parsed?.error) return classifyAnthropicEmbedded(parsed, now);
    if (parsed?.type !== "message") return invalidResponse("The upstream sent no message.");
    const tokens = new AnthropicUsage();
    tokens.add(parsed.usage);
    return {
      usage: tokens.value,
      returnedModel: typeof parsed.model === "string" ? parsed.model : null,
      outputChars: JSON.stringify(parsed.content ?? "").length,
      render: () => text,
    };
  },

  newStreamReader: () => new MessagesStreamReader(),
  successHeaders: anthropicResponseHeaders,

  // Claude Code recovers from many errors by matching their exact wording.
  forwardedError(_status, headers, text) {
    return {
      body: text,
      contentType: "application/json",
      headers: { ...anthropicResponseHeaders(headers), "x-llmr-upstream-error": "1" },
    };
  },

  allFailed(outcomes, capacity): { status: number; headers: Record<string, string> } {
    if (capacity) return { status: 429, headers: { "x-should-retry": "false" } };
    const overloaded = outcomes.length > 0 && outcomes.every((item) => item === "overloaded");
    return { status: overloaded ? 529 : 502, headers: {} };
  },
};
