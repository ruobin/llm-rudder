export type JsonObject = Record<string, unknown>;

export type CostClass = "prepaid" | "free" | "metered";
export type NoticeMode = "text" | "none";
export type Trust = "first_party" | "self_hosted" | "third_party";
/** The request format a client speaks and an upstream accepts. */
export type Dialect = "openai.chat" | "anthropic.messages";

export type Outcome =
  | "ok"
  | "quota_exhausted"
  | "rate_limited"
  | "billing"
  | "overloaded"
  | "upstream_error"
  | "timeout"
  | "auth"
  | "unsupported"
  | "context_overflow"
  | "client_error"
  | "refusal"
  | "mid_stream_failure"
  | "client_aborted";

/** The router's reading of one upstream result. */
export interface Classified {
  outcome: Outcome;
  retryElsewhere: boolean;
  scope?: "account" | "model";
  retryAfterS?: number;
  /** Epoch milliseconds, when the upstream states a reset time. */
  resetsAt?: number;
  code?: string;
  message?: string;
  /** HTTP status to return if this error reaches the client. */
  clientStatus?: number;
}

export interface Usage {
  /** Input tokens excluding cached tokens. */
  inputTokens: number;
  cachedTokens: number;
  /** Output tokens including reasoning tokens. */
  outputTokens: number;
  /** Prompt-cache writes, which Anthropic bills above the input price. */
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
}

export interface Target {
  /** For example "frontier/openai-key/gpt-6-astra". */
  id: string;
  tier: string;
  accountId: string;
  model: string;
  params: JsonObject;
}
