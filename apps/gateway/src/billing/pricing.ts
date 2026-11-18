import type { Price, Pricing } from "../config/load.js";
import type { Usage } from "../types.js";

export const DEFAULT_OUTPUT_ESTIMATE = 8000;

export function priceFor(pricing: Pricing, model: string): Price {
  return pricing.models.get(model) ?? pricing.fallback;
}

/** A price in USD per million tokens is the same number in micro-USD per token. */
export function costMicroUsd(usage: Usage, price: Price): number {
  const write5m = usage.cacheWrite5mTokens ?? 0;
  const write1h = usage.cacheWrite1hTokens ?? 0;
  const totalInput = usage.inputTokens + usage.cachedTokens + write5m + write1h;
  const rates =
    price.longContext && totalInput > price.longContext.overInputTokens ? price.longContext : price;
  return Math.ceil(
    usage.inputTokens * rates.input +
      usage.cachedTokens * (rates.cachedInput ?? rates.input) +
      write5m * (rates.cacheWrite5m ?? rates.input) +
      write1h * (rates.cacheWrite1h ?? rates.input) +
      usage.outputTokens * rates.output,
  );
}

export function estimateUsage(bodyChars: number, maxOutputTokens: number | undefined): Usage {
  return {
    inputTokens: Math.ceil(bodyChars / 4),
    cachedTokens: 0,
    outputTokens: Math.min(maxOutputTokens ?? DEFAULT_OUTPUT_ESTIMATE, DEFAULT_OUTPUT_ESTIMATE),
  };
}
