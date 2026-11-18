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

function messageText(message: unknown): string {
  const content = (message as JsonObject | null)?.content;
  const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
  return text.slice(0, MAX_TEXT_CHARS);
}

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
  const messages = Array.isArray(body.messages) ? (body.messages as JsonObject[]) : [];
  const system = messages.find((m) => m?.role === "system" || m?.role === "developer");
  const user = messages.find((m) => m?.role === "user");
  return shortHash(
    `${clientId}\u0000derived\u0000${messageText(system)}\u0000${messageText(user)}`,
  );
}
