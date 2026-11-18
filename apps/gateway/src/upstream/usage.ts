import type { JsonObject, Usage } from "../types.js";

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** Normalizes an OpenAI-style usage object into separate token categories. */
export function parseUsage(value: unknown): Usage | null {
  if (value === null || typeof value !== "object") return null;
  const usage = value as JsonObject;
  const details = (usage.prompt_tokens_details ?? usage.input_tokens_details ?? {}) as JsonObject;
  const prompt = count(usage.prompt_tokens ?? usage.input_tokens);
  const output = count(usage.completion_tokens ?? usage.output_tokens);
  const cached = Math.min(
    prompt,
    count(details.cached_tokens ?? usage.cached_tokens ?? usage.prompt_cache_hit_tokens),
  );
  if (prompt === 0 && output === 0) return null;
  return { inputTokens: prompt - cached, cachedTokens: cached, outputTokens: output };
}
