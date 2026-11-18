import type { Classified, JsonObject } from "../types.js";

export type HeaderBag = Record<string, string | string[] | undefined>;

const REFUSAL_CODES = new Set([
  "content_filter",
  "content_policy_violation",
  "guardrail_blocked",
  "moderation_blocked",
  "prompt_blocked",
  "refusal",
  "request_rejected",
  "response_rejected",
  "sensitive_words_detected",
]);

const QUOTA_CODES = new Set([
  "billing_hard_limit_reached",
  "credit_balance_exhausted",
  "insufficient_balance",
  "insufficient_credits",
  "insufficient_quota",
  "insufficient_user_quota",
  "organization_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "payment_required",
  "pre_consume_token_quota_failed",
  "project_spend_limit_exceeded",
  "subscription_sharing_usage_limit_exceeded",
]);

const NO_ROUTE_CODES = new Set([
  "channel:no_available_key",
  "get_channel_failed",
  "model_not_available",
  "model_not_found",
]);

/** ChatGPT plan answers that retrying will not fix until something changes. */
const ACCOUNT_REJECTED_CODES = new Set([
  "chatpass_v2_invalid_authorization_context",
  "chatpass_v2_scope_not_authorized",
  "subscription_sharing_invalid_user",
  "subscription_sharing_user_not_eligible",
]);

/** ChatGPT plan answers that a later retry may fix. */
const PLAN_UNAVAILABLE_CODES = new Set([
  "subscription_sharing_usage_unavailable",
  "subscription_sharing_user_unavailable",
]);

const QUOTA_TEXT =
  /insufficient[ _](user[ _])?(quota|balance|credits?|funds)|quota[ _](has been |is )?(exceeded|exhausted)|exceeded your current quota|out of (credits|quota)|credit balance|not enough (credits|quota|balance)|额度不足|余额不足|配额(不足|已用尽)/i;
const OVERFLOW_TEXT =
  /context[_ ]length|maximum context|context window|prompt is too long|input is too long|too many (input )?tokens|exceeds? the (maximum|model'?s?) .*(token|context)|reduce the length/i;
const UNSUPPORTED_TEXT =
  /unsupported|not supported|does not support|unknown (parameter|field|name)|unrecognized (request )?(argument|field|parameter)|extra inputs are not permitted|invalid model|no such model|model .*(does not exist|not found)/i;

interface ParsedError {
  code: string;
  numericCode?: number;
  type: string;
  status: string;
  message: string;
  /** The request field the error is about, when the upstream says. */
  param?: string;
  metadata: JsonObject;
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

/** Reads an error object, tolerating the shapes OpenAI-compatible services use. */
export function parseErrorObject(value: unknown): ParsedError {
  const root = Array.isArray(value) ? value[0] : value;
  const object = asObject(root) ?? {};
  const inner = asObject(object.error) ?? object;
  const text = typeof object.error === "string" ? object.error : undefined;
  const rawCode = inner.code;
  const metadata = asObject(inner.metadata) ?? {};
  const errorType =
    typeof metadata.error_type === "string"
      ? metadata.error_type
      : typeof inner.error_type === "string"
        ? inner.error_type
        : "";
  return {
    code: typeof rawCode === "string" && rawCode !== "" ? rawCode : errorType,
    ...(typeof rawCode === "number" ? { numericCode: rawCode } : {}),
    type: typeof inner.type === "string" ? inner.type : "",
    status: typeof inner.status === "string" ? inner.status : "",
    message:
      typeof inner.message === "string"
        ? inner.message
        : typeof inner.detail === "string"
          ? inner.detail
          : (text ?? ""),
    ...(typeof inner.param === "string" ? { param: inner.param } : {}),
    metadata,
  };
}

function headerValue(headers: HeaderBag, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Parses durations such as "6m0s", "1.5s" and "200ms". */
export function parseDurationS(value: string): number | undefined {
  let total = 0;
  let matched = false;
  for (const match of value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    const amount = Number(match[1]);
    if (match[2] === "ms") total += amount / 1000;
    else if (match[2] === "s") total += amount;
    else if (match[2] === "m") total += amount * 60;
    else total += amount * 3600;
  }
  return matched ? total : undefined;
}

export function parseRetryAfterS(
  headers: HeaderBag,
  rawBody: string,
  now: number,
): number | undefined {
  const retryAfter = headerValue(headers, "retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, (date - now) / 1000);
  }
  for (const kind of ["requests", "tokens"]) {
    if (headerValue(headers, `x-ratelimit-remaining-${kind}`) === "0") {
      const reset = headerValue(headers, `x-ratelimit-reset-${kind}`);
      const seconds = reset ? parseDurationS(reset) : undefined;
      if (seconds !== undefined) return seconds;
    }
  }
  const gemini = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(rawBody);
  return gemini ? Number(gemini[1]) : undefined;
}

function detail(error: ParsedError, status: number): Pick<Classified, "code" | "message"> {
  const code = error.code || (error.numericCode ?? status).toString();
  return { code, message: error.message.slice(0, 500) };
}

function classifyParsed(
  status: number,
  error: ParsedError,
  retryAfterS: number | undefined,
  now: number,
): Classified {
  const code = error.code.toLowerCase();
  const text = `${error.code} ${error.type} ${error.status} ${error.message}`;
  const info = detail(error, status);
  const limitSource =
    typeof error.metadata.limit_source === "string" ? error.metadata.limit_source : "";

  if (REFUSAL_CODES.has(code)) {
    return {
      ...info,
      outcome: "refusal",
      retryElsewhere: false,
      clientStatus: status >= 400 ? status : 400,
    };
  }

  if (
    (status === 400 || status === 413 || status === 422 || status < 300) &&
    (code === "context_length_exceeded" || OVERFLOW_TEXT.test(error.message))
  ) {
    return {
      ...info,
      code: "context_length_exceeded",
      outcome: "context_overflow",
      retryElsewhere: false,
      clientStatus: 400,
    };
  }

  // OpenRouter's in-flight budget is a transient limit, even though it is a 402.
  if (limitSource === "openrouter_in_flight_budget") {
    return {
      ...info,
      outcome: "rate_limited",
      retryElsewhere: true,
      scope: "model",
      ...(retryAfterS === undefined ? {} : { retryAfterS }),
    };
  }

  // Gemini uses this status for per-minute limits, whatever its message says.
  if (error.status === "RESOURCE_EXHAUSTED") {
    return {
      ...info,
      outcome: "rate_limited",
      retryElsewhere: true,
      scope: "model",
      ...(retryAfterS === undefined ? {} : { retryAfterS }),
    };
  }

  if (
    QUOTA_CODES.has(code) ||
    status === 402 ||
    limitSource === "openrouter_key_limit" ||
    QUOTA_TEXT.test(text)
  ) {
    const resetsAt =
      typeof error.metadata.resets_at === "string"
        ? Date.parse(error.metadata.resets_at)
        : Number.NaN;
    return {
      ...info,
      outcome: "quota_exhausted",
      retryElsewhere: true,
      scope: "account",
      ...(Number.isNaN(resetsAt) || resetsAt <= now ? {} : { resetsAt }),
    };
  }

  if (ACCOUNT_REJECTED_CODES.has(code)) {
    return { ...info, outcome: "auth", retryElsewhere: true, scope: "account" };
  }
  if (PLAN_UNAVAILABLE_CODES.has(code)) {
    return {
      ...info,
      outcome: "rate_limited",
      retryElsewhere: true,
      scope: "account",
      ...(retryAfterS === undefined ? {} : { retryAfterS }),
    };
  }
  if (code === "subscription_sharing_unsupported_capability") {
    // Usually one request's input or tool, so other requests may still be fine.
    return {
      ...info,
      ...(error.param ? { message: `${info.message} (${error.param})`.trim() } : {}),
      outcome: "unsupported",
      retryElsewhere: true,
      scope: error.param === "model" ? "model" : "request",
    };
  }
  if (NO_ROUTE_CODES.has(code) || code === "subscription_sharing_route_not_supported") {
    return { ...info, outcome: "unsupported", retryElsewhere: true, scope: "model" };
  }

  switch (status) {
    case 401:
      return { ...info, outcome: "auth", retryElsewhere: true, scope: "account" };
    case 403:
      return { ...info, outcome: "billing", retryElsewhere: true, scope: "account" };
    case 404:
      return { ...info, outcome: "unsupported", retryElsewhere: true, scope: "model" };
    case 408:
    case 504:
      return { ...info, outcome: "timeout", retryElsewhere: true, scope: "model" };
    case 429:
      return {
        ...info,
        outcome: "rate_limited",
        retryElsewhere: true,
        scope: "model",
        ...(retryAfterS === undefined ? {} : { retryAfterS }),
      };
    case 503:
    case 529:
      return {
        ...info,
        outcome: "overloaded",
        retryElsewhere: true,
        scope: "model",
        ...(retryAfterS === undefined ? {} : { retryAfterS }),
      };
    default:
      break;
  }

  if (status >= 400 && status < 500) {
    if (UNSUPPORTED_TEXT.test(error.message)) {
      return { ...info, outcome: "unsupported", retryElsewhere: true, scope: "model" };
    }
    return { ...info, outcome: "client_error", retryElsewhere: false, clientStatus: status };
  }
  return { ...info, outcome: "upstream_error", retryElsewhere: true, scope: "model" };
}

/** Classifies an upstream response with an HTTP error status. */
export function classifyHttpError(
  status: number,
  headers: HeaderBag,
  rawBody: string,
  now: number = Date.now(),
): Classified {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    parsed = null;
  }
  const retryAfterS = parseRetryAfterS(headers, rawBody, now);
  if (parsed === null) {
    // A proxy or CDN error page says nothing about the request itself.
    const text = rawBody.slice(0, 200);
    if (status === 401 || status === 402 || status === 403 || status === 429) {
      return classifyParsed(
        status,
        { code: "", type: "", status: "", message: text, metadata: {} },
        retryAfterS,
        now,
      );
    }
    return {
      outcome: status === 503 || status === 529 ? "overloaded" : "upstream_error",
      retryElsewhere: true,
      scope: "model",
      code: String(status),
      message: "The upstream returned a non-JSON error.",
    };
  }
  return classifyParsed(status, parseErrorObject(parsed), retryAfterS, now);
}

/**
 * Classifies a rejection from the ChatGPT plan route. It can refuse a request before
 * the Responses API runs, with only a "detail" message and no error code.
 */
export function classifyChatGptHttpError(
  status: number,
  headers: HeaderBag,
  rawBody: string,
  now: number = Date.now(),
): Classified {
  const result = classifyHttpError(status, headers, rawBody, now);
  if (result.code !== String(status)) return result;
  if (status === 403) {
    return {
      ...result,
      outcome: "auth",
      retryElsewhere: true,
      scope: "account",
      code: "chatgpt_admission_denied",
    };
  }
  if (status === 503) {
    return {
      ...result,
      outcome: "rate_limited",
      retryElsewhere: true,
      scope: "account",
      code: "chatgpt_unavailable",
    };
  }
  return result;
}

/** Classifies an error found in a 200 response body or a stream event. */
export function classifyEmbeddedError(value: unknown, now: number = Date.now()): Classified {
  const error = parseErrorObject(value);
  const code = error.numericCode;
  const status = code !== undefined && code >= 400 && code < 600 ? code : 502;
  const classified = classifyParsed(status, error, undefined, now);
  // An error without a usable status is an upstream failure, not the client's fault.
  if (status === 502 && classified.outcome === "client_error") {
    return { ...classified, outcome: "upstream_error", retryElsewhere: true, scope: "model" };
  }
  return classified;
}

const TIMEOUT_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ETIMEDOUT",
]);

/** Classifies a network failure. */
export function classifyTransportError(error: unknown): Classified {
  const code = (error as { code?: unknown } | null)?.code;
  const name = typeof code === "string" ? code : "transport_error";
  return {
    outcome: TIMEOUT_CODES.has(name) ? "timeout" : "upstream_error",
    retryElsewhere: true,
    scope: "model",
    code: name,
    message: "The upstream connection failed.",
  };
}
