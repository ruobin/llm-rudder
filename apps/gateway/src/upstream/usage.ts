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
  const cacheWrites = Math.min(prompt - cached, count(details.cache_write_tokens));
  const outputDetails = (usage.completion_tokens_details ??
    usage.output_tokens_details ??
    {}) as JsonObject;
  const reasoning = count(outputDetails.reasoning_tokens);
  return {
    inputTokens: prompt - cached - cacheWrites,
    cachedTokens: cached,
    outputTokens: output,
    ...(cacheWrites > 0 ? { cacheWrite5mTokens: cacheWrites } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}
