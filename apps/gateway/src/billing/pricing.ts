import type { Price, Pricing } from "../config/load.js";
import type { Usage } from "../types.js";

export const DEFAULT_OUTPUT_ESTIMATE = 8000;

export function priceFor(pricing: Pricing, model: string): Price {
  return pricing.models.get(model) ?? pricing.fallback;
}

/** A price in USD per million tokens is the same number in micro-USD per token. */
export function costMicroUsd(usage: Usage, price: Price): number {
  return Math.ceil(
    usage.inputTokens * price.input +
      usage.cachedTokens * (price.cachedInput ?? price.input) +
      usage.outputTokens * price.output,
  );
}

export function estimateUsage(bodyChars: number, maxOutputTokens: number | undefined): Usage {
  return {
    inputTokens: Math.ceil(bodyChars / 4),
    cachedTokens: 0,
    outputTokens: Math.min(maxOutputTokens ?? DEFAULT_OUTPUT_ESTIMATE, DEFAULT_OUTPUT_ESTIMATE),
  };
}
