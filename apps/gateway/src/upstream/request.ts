import type { AccountConfig } from "../config/load.js";
import type { JsonObject, Target } from "../types.js";
import type { ToolExtrasStore } from "./tool-extras.js";

/** Google's documented value for history that has no thought signature. */
const SKIP_SIGNATURE = { google: { thought_signature: "skip_thought_signature_validator" } };

function rewriteMessages(
  messages: unknown[],
  account: AccountConfig,
  clientId: string,
  extras: ToolExtrasStore,
): unknown[] {
  const { compat } = account;
  return messages.map((entry) => {
    if (entry === null || typeof entry !== "object") return entry;
    let message = entry as JsonObject;

    if (compat.systemRole === "system" && message.role === "developer") {
      message = { ...message, role: "system" };
    }

    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      const calls = (message.tool_calls as JsonObject[]).map((call, index) => {
        const { extra_content: existing, ...rest } = call;
        if (!compat.toolExtras) return rest;
        const id = typeof call.id === "string" ? call.id : "";
        const restored = existing ?? extras.get(clientId, id);
        if (restored !== undefined) return { ...rest, extra_content: restored };
        // Google checks the first call of each step.
        return index === 0 ? { ...rest, extra_content: SKIP_SIGNATURE } : rest;
      });
      message = { ...message, tool_calls: calls };
    }
    return message;
  });
}

/** Builds the upstream request. Unknown client fields are kept. */
export function buildUpstreamBody(
  clientBody: JsonObject,
  target: Target,
  account: AccountConfig,
  stream: boolean,
  clientId: string,
  extras: ToolExtrasStore,
): JsonObject {
  const { compat } = account;
  const body: JsonObject = { ...clientBody, model: target.model };

  for (const [key, value] of Object.entries(target.params)) {
    if (body[key] === undefined) body[key] = value;
  }

  if (stream && compat.streamUsage) {
    const existing = (body.stream_options ?? {}) as JsonObject;
    body.stream_options = { ...existing, include_usage: true };
  } else if (!compat.streamUsage || !stream) {
    delete body.stream_options;
  }

  if (compat.maxTokensField === "max_completion_tokens" && body.max_tokens !== undefined) {
    body.max_completion_tokens ??= body.max_tokens;
    delete body.max_tokens;
  } else if (compat.maxTokensField === "max_tokens" && body.max_completion_tokens !== undefined) {
    body.max_tokens ??= body.max_completion_tokens;
    delete body.max_completion_tokens;
  }

  if (typeof body.reasoning_effort === "string") {
    body.reasoning_effort = compat.effortMap[body.reasoning_effort] ?? body.reasoning_effort;
  }

  for (const field of compat.dropFields) delete body[field];

  if (Array.isArray(body.messages)) {
    body.messages = rewriteMessages(body.messages, account, clientId, extras);
  }
  return body;
}
