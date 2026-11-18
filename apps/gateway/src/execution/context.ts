import type { ClientConfig } from "../config/load.js";
import type { JsonObject } from "../types.js";

/** Everything the router needs to know about one client request. */
export interface RequestContext {
  requestId: string;
  client: ClientConfig;
  body: JsonObject;
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
