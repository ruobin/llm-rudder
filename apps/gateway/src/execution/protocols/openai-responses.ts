import { replaceTopLevelString, setTopLevelField } from "@llm-rudder/shared";
import { ulid } from "../../ids.js";
import type { Classified, JsonObject, Usage } from "../../types.js";
import {
  classifyEmbeddedError,
  classifyHttpError,
  type HeaderBag,
} from "../../upstream/classify.js";
import type { SseEvent } from "../../upstream/sse.js";
import { parseUsage } from "../../upstream/usage.js";
import { effortToAdd } from "../effort.js";
import type { CompleteReply, StreamReader, StreamStep, WireProtocol } from "../protocol.js";
import { parseObject } from "../../json.js";
import { invalidResponse } from "../protocol.js";

const OUTPUT_EVENTS = new Set([
  "response.output_text.delta",
  "response.refusal.delta",
  "response.function_call_arguments.delta",
  "response.custom_tool_call_input.delta",
  "response.reasoning_summary_text.delta",
  "response.reasoning_text.delta",
]);
/** Placed after any real output, so the note cannot collide with an upstream item. */
const NOTICE_OUTPUT_INDEX = 1_000_000;

function failure(response: JsonObject | undefined): Classified {
  return classifyEmbeddedError({
    error: { message: "The response failed.", ...(response?.error as JsonObject) },
  });
}

function responseHeaders(headers: HeaderBag): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const wanted =
      name === "retry-after" ||
      name === "x-request-id" ||
      name.startsWith("x-ratelimit-") ||
      name.startsWith("x-codex-");
    if (wanted && typeof value === "string") kept[name] = value;
  }
  return kept;
}

class ResponsesStreamReader implements StreamReader {
  usage: Usage | null = null;
  returnedModel: string | null = null;
  outputChars = 0;
  finished = false;

  read(event: SseEvent): StreamStep {
    if (event.data === null) return { kind: "ignore" };
    const payload = parseObject(event.data);
    if (!payload) return { kind: "ignore" };
    const type = String(payload.type ?? event.event ?? "");
    const response = payload.response as JsonObject | undefined;

    if (type === "response.created" && typeof response?.model === "string") {
      this.returnedModel = response.model;
    }
    if (type === "response.failed") return { kind: "failed", cause: failure(response) };
    if (type === "error") {
      const error = (payload.error as JsonObject | undefined) ?? payload;
      return { kind: "failed", cause: classifyEmbeddedError({ error }) };
    }
    if (type === "response.completed" || type === "response.incomplete") {
      this.usage = parseUsage(response?.usage) ?? this.usage;
      this.finished = true;
      return { kind: "output", last: true };
    }
    if (OUTPUT_EVENTS.has(type)) {
      if (typeof payload.delta === "string") this.outputChars += payload.delta.length;
      return { kind: "output" };
    }
    if (type === "response.output_item.done") {
      const item = payload.item as JsonObject | undefined;
      // A tool call can arrive whole, with no deltas before it.
      if (item?.type !== "reasoning") return { kind: "output" };
    }
    return { kind: "pending", keepUntilCommit: true };
  }

  noticeEvent(text: string): string {
    const item = {
      id: `msg_${ulid()}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    const output_index = NOTICE_OUTPUT_INDEX;
    const line = (type: string, data: JsonObject) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    return (
      line("response.output_item.added", { output_index, item }) +
      line("response.output_item.done", { output_index, item })
    );
  }

  closingText(): null {
    return null;
  }

  fromDocument(text: string, _now: number): SseEvent[] | Classified {
    const parsed = parseObject(text);
    if (parsed?.error) return classifyEmbeddedError(parsed);
    return invalidResponse("The upstream did not return a stream.");
  }
}

/** Serves Responses clients from Responses upstreams, passing the bytes through. */
export const openAiResponses: WireProtocol = {
  supportsNotice: true,

  send(attempt, { stream, signal }) {
    const { rt, ctx, target, account } = attempt;
    let body = replaceTopLevelString(ctx.rawBody as Buffer, "model", target.model);
    if (!body) throw new Error("The request has no model field.");
    const reasoning = (ctx.body.reasoning ?? {}) as JsonObject;
    const effort = effortToAdd(attempt, reasoning.effort);
    if (effort) body = setTopLevelField(body, "reasoning", { ...reasoning, effort }) ?? body;
    return rt.upstream.sendResponses(account, { body, stream, signal });
  },

  classifyHttpError,

  readComplete(_attempt, text, now): CompleteReply | Classified {
    const parsed = parseObject(text);
    if (parsed?.status === "failed") return failure(parsed);
    if (parsed?.error && !parsed.output) return classifyEmbeddedError(parsed, now);
    if (!parsed || !Array.isArray(parsed.output)) {
      return invalidResponse("The upstream sent no output.");
    }
    return {
      usage: parseUsage(parsed.usage),
      returnedModel: typeof parsed.model === "string" ? parsed.model : null,
      outputChars: JSON.stringify(parsed.output).length,
      render(notice) {
        if (!notice) return text;
        (parsed.output as JsonObject[]).unshift({
          id: `msg_${ulid()}`,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: notice, annotations: [] }],
        });
        return JSON.stringify(parsed);
      },
    };
  },

  newStreamReader: () => new ResponsesStreamReader(),
  successHeaders: responseHeaders,
  forwardedError: (_status, headers, text) => ({
    body: text,
    contentType: "application/json",
    headers: responseHeaders(headers),
  }),
  allFailed: (_outcomes, capacity) => ({ status: capacity ? 429 : 502, headers: {} }),
};
