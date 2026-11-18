import type { JsonObject } from "../types.js";
import type { RequestContext } from "./context.js";

export function noticeText(requested: string, served: string, model: string, reason: string) {
  return `> ⚠️ llm-rudder: \`${requested}\` is unavailable (${reason}), so this reply uses \`${served}\` (${model}).\n\n`;
}

/** Structured output, multiple choices and opted-out clients never get a note. */
export function canAddNotice(ctx: RequestContext): boolean {
  if (ctx.client.notice !== "text") return false;
  if (ctx.body.response_format !== undefined) return false;
  const choices = ctx.body.n;
  return choices === undefined || choices === null || choices === 1;
}

/** Summarizes why the requested tier could not serve, from "account:reason" entries. */
export function reasonLabel(reasons: string[]): string {
  const kinds = reasons.map((entry) => entry.slice(entry.lastIndexOf(":") + 1));
  const has = (...names: string[]) => kinds.some((kind) => names.includes(kind));
  if (has("quota_exhausted", "exhausted", "backoff", "probing", "billing")) {
    return "quota exhausted";
  }
  if (has("budget")) return "budget reached";
  if (has("rate_limited", "cooldown")) return "rate limited";
  return "temporarily unavailable";
}

export function noticeChunk(template: JsonObject, text: string, includeRole: boolean): string {
  const delta: JsonObject = includeRole ? { role: "assistant", content: text } : { content: text };
  const chunk = {
    id: template.id ?? "chatcmpl-llmr",
    object: "chat.completion.chunk",
    created: template.created ?? Math.floor(Date.now() / 1000),
    model: template.model ?? "llm-rudder",
    choices: [{ index: 0, delta, finish_reason: null }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** Adds the note to the first choice of a complete response. */
export function addNoticeToMessage(response: JsonObject, text: string): void {
  const choice = (response.choices as JsonObject[] | undefined)?.[0];
  const message = choice?.message as JsonObject | undefined;
  if (!message) return;
  if (typeof message.content === "string") {
    message.content = text + message.content;
  } else if (Array.isArray(message.content)) {
    message.content = [{ type: "text", text }, ...message.content];
  } else {
    message.content = text.trimEnd();
  }
}
