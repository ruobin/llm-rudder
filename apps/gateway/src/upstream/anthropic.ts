import type { Classified, JsonObject, Usage } from "../types.js";
import { classifyEmbeddedError, classifyHttpError, type HeaderBag } from "./classify.js";

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

interface RawUsage {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  output?: number;
}

/** Combines usage from stream events, where later values replace earlier ones. */
export class AnthropicUsage {
  private readonly raw: RawUsage = {};

  add(value: unknown): void {
    const usage = asObject(value);
    if (!usage) return;
    const breakdown = asObject(usage.cache_creation);
    const fields: [keyof RawUsage, unknown][] = [
      ["input", usage.input_tokens],
      ["cacheRead", usage.cache_read_input_tokens],
      ["cacheWrite", usage.cache_creation_input_tokens],
      ["cacheWrite5m", breakdown?.ephemeral_5m_input_tokens],
      ["cacheWrite1h", breakdown?.ephemeral_1h_input_tokens],
      ["output", usage.output_tokens],
    ];
    for (const [key, field] of fields) {
      const parsed = count(field);
      if (parsed !== undefined) this.raw[key] = parsed;
    }
  }

  get value(): Usage | null {
    const { input, cacheRead = 0, cacheWrite = 0, cacheWrite1h = 0, output } = this.raw;
    if (input === undefined && output === undefined) return null;
    // Writes without a breakdown use the default five-minute lifetime.
    const write1h = Math.min(cacheWrite1h, cacheWrite);
    const write5m = this.raw.cacheWrite5m ?? cacheWrite - write1h;
    return {
      inputTokens: input ?? 0,
      cachedTokens: cacheRead,
      outputTokens: output ?? 0,
      cacheWrite5mTokens: write5m,
      cacheWrite1hTokens: write1h,
    };
  }
}

function errorDetails(body: unknown) {
  const error = asObject(asObject(body)?.error);
  const details = asObject(error?.details);
  return {
    type: typeof error?.type === "string" ? error.type : "",
    message: typeof error?.message === "string" ? error.message : "",
    errorCode: typeof details?.error_code === "string" ? details.error_code : "",
  };
}

function refine(base: Classified, body: unknown, now: number): Classified {
  const { type, message, errorCode } = errorDetails(body);
  const code = errorCode || type || base.code;
  const refined: Classified = { ...base, ...(code ? { code } : {}) };

  // The usage tier's monthly cap: access returns at the start of next month.
  if (errorCode === "enforced_spend_limit_reached") {
    const date = new Date(now);
    return {
      ...refined,
      outcome: "quota_exhausted",
      retryElsewhere: true,
      scope: "account",
      resetsAt: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
    };
  }
  // A spend limit you set on the account arrives as a 400.
  if (message.startsWith("You have reached your specified API usage limits")) {
    return { ...refined, outcome: "quota_exhausted", retryElsewhere: true, scope: "account" };
  }
  return refined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function classifyAnthropicHttpError(
  status: number,
  headers: HeaderBag,
  text: string,
  now: number = Date.now(),
): Classified {
  return refine(classifyHttpError(status, headers, text, now), parseJson(text), now);
}

const EMBEDDED_STATUS: Record<string, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
};

/** Classifies an `error` stream event or an error document sent with status 200. */
export function classifyAnthropicEmbedded(body: unknown, now: number = Date.now()): Classified {
  const { type } = errorDetails(body);
  const status = EMBEDDED_STATUS[type];
  const base =
    status === undefined
      ? classifyEmbeddedError(body, now)
      : classifyHttpError(status, {}, JSON.stringify(body), now);
  return refine(base, body, now);
}
