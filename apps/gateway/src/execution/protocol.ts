import type { AccountConfig } from "../config/load.js";
import type { Runtime } from "../runtime.js";
import type { Classified, Outcome, Target, Usage } from "../types.js";
import type { HeaderBag } from "../upstream/classify.js";
import type { UpstreamResponse } from "../upstream/client.js";
import type { SseEvent } from "../upstream/sse.js";
import type { RequestContext } from "./context.js";

/** One attempt to serve a request from one target. */
export interface Attempt {
  rt: Runtime;
  ctx: RequestContext;
  target: Target;
  account: AccountConfig;
}

export interface CompleteReply {
  usage: Usage | null;
  returnedModel: string | null;
  outputChars: number;
  /** The text to send, with a note added when one is due. */
  render(notice: string | null): string;
}

/** What the executor should do with one upstream stream event. */
export type StreamStep =
  | { kind: "ignore" }
  /** The upstream ended the stream. Nothing is forwarded. */
  | { kind: "end" }
  | { kind: "failed"; cause: Classified }
  /** Not output yet. Forwarded once the stream is committed. */
  | { kind: "pending"; keepUntilCommit: boolean }
  /** Model output. This is the commit point. `last` stops reading afterwards. */
  | { kind: "output"; last?: boolean };

export interface StreamReader {
  readonly usage: Usage | null;
  readonly returnedModel: string | null;
  readonly outputChars: number;
  /** The upstream finished normally. */
  readonly finished: boolean;
  read(event: SseEvent): StreamStep;
  /** An event that shows a note to the user, if this format can carry one. */
  noticeEvent(text: string): string | null;
  /** Text that closes a successful stream. */
  closingText(): string | null;
  /** Handles a stream request that was answered with one JSON document. */
  fromDocument(text: string, now: number): SseEvent[] | Classified;
}

export interface ForwardedError {
  body: string;
  contentType: string;
  headers: Record<string, string>;
}

/** Everything that differs between the API formats the gateway serves. */
export interface WireProtocol {
  readonly supportsNotice: boolean;
  send(
    attempt: Attempt,
    options: { stream: boolean; signal: AbortSignal },
  ): Promise<UpstreamResponse>;
  classifyHttpError(status: number, headers: HeaderBag, text: string, now: number): Classified;
  readComplete(attempt: Attempt, text: string, now: number): CompleteReply | Classified;
  newStreamReader(attempt: Attempt): StreamReader;
  /** Upstream response headers to pass to the client. */
  successHeaders(headers: HeaderBag): Record<string, string>;
  /** An upstream error to return unchanged, when this format calls for that. */
  forwardedError(status: number, headers: HeaderBag, text: string): ForwardedError | null;
  /** Status and headers for "every target failed". */
  allFailed(
    outcomes: Outcome[],
    capacity: boolean,
  ): {
    status: number;
    headers: Record<string, string>;
  };
}

export const isClassified = (value: object): value is Classified => "outcome" in value;
