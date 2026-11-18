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
  /**
   * Model output. This is the commit point. `last` stops reading afterwards.
   * `text` replaces the event, and is rendered once the commit has happened.
   */
  | { kind: "output"; last?: boolean; text?: () => string };

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

/** How the gateway talks to the client, whichever upstream answers. */
export interface ClientProtocol {
  readonly supportsNotice: boolean;
  /** Adapts an upstream's rejection of the request for this kind of client. */
  describeRejection?(result: Classified): {
    message?: string;
    headers: Record<string, string>;
  };
  /** Status and headers for "every target failed". */
  allFailed(
    outcomes: Outcome[],
    capacity: boolean,
  ): {
    status: number;
    headers: Record<string, string>;
  };
}

/** How one attempt talks to its upstream and reads the answer. */
export interface UpstreamProtocol {
  /** This upstream always streams, even when the client wants one response. */
  streamOnly?: boolean;
  /** Reads a stream into one response, for clients that did not ask to stream. */
  readStream?(
    attempt: Attempt,
    body: AsyncIterable<Uint8Array>,
    now: number,
  ): Promise<CompleteReply | Classified>;
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
}

/** A format served from an upstream of the same format, with no translation. */
export type WireProtocol = ClientProtocol & UpstreamProtocol;

export const isClassified = (value: object): value is Classified => "outcome" in value;
