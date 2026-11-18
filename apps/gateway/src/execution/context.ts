import type { ClientConfig } from "../config/load.js";
import type { Dialect, JsonObject } from "../types.js";

/** Everything the router needs to know about one client request. */
export interface RequestContext {
  requestId: string;
  client: ClientConfig;
  dialect: Dialect;
  body: JsonObject;
  /** The original bytes, for dialects that pass the request through. */
  rawBody?: Buffer;
  /** Client headers that may be sent to the upstream. */
  upstreamHeaders?: Record<string, string>;
  /** Query string of the client request, including the "?". */
  upstreamQuery?: string;
  /** The tier the client wanted, when an edge has already moved on from it. */
  originalTier?: string;
  /** Earlier failures that happened before this request reached the gateway. */
  priorFailures?: string[];
  requestedModel: string;
  tierHeader?: string;
  stream: boolean;
  /** The client asked for usage in the stream. */
  wantsUsage: boolean;
  /** Hash that identifies the conversation. */
  sessionKey: string;
  allowFallback: boolean;
  startedAt: number;
  /** Latest time to reach the first model output. */
  deadlineAt: number;
  signal: AbortSignal;
  bodyChars: number;
  maxOutputTokens?: number;
}
