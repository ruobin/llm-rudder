import { shortHash } from "../ids.js";
import type { JsonObject } from "../types.js";

const SESSION_HEADERS = [
  "x-claude-code-session-id",
  "x-session-id",
  "x-session-affinity",
  "session-id",
  "session_id",
  "x-openwebui-chat-id",
];
const MAX_TEXT_CHARS = 4000;

function textOf(content: unknown): string {
  if (content === undefined || content === null) return "";
  const text = typeof content === "string" ? content : JSON.stringify(content);
  return text.slice(0, MAX_TEXT_CHARS);
}

const messageText = (message: unknown) => textOf((message as JsonObject | null)?.content);

/**
 * Identifies a conversation. Clients that send no session id are recognized by
 * their first system and user messages, which stay the same on every turn.
 */
export function deriveSessionKey(
  headers: Record<string, unknown>,
  body: JsonObject,
  clientId: string,
): string {
  for (const name of SESSION_HEADERS) {
    const value = headers[name];
    if (typeof value === "string" && value !== "") {
      return shortHash(`${clientId}\u0000header\u0000${value}`);
    }
  }
  if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key !== "") {
    return shortHash(`${clientId}\u0000cache\u0000${body.prompt_cache_key}`);
  }
  // The Responses API calls its messages "input", and may send plain text there.
  const history = body.messages ?? body.input;
  const messages = Array.isArray(history) ? (history as JsonObject[]) : [];
  const system =
    textOf(body.system ?? body.instructions) ||
    messageText(messages.find((m) => m?.role === "system" || m?.role === "developer"));
  const user =
    typeof history === "string"
      ? textOf(history)
      : messageText(messages.find((m) => m?.role === "user"));
  return shortHash(`${clientId}\u0000derived\u0000${system}\u0000${user}`);
}
