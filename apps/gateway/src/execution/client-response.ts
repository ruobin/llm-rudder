import type { ServerResponse } from "node:http";
import type { FastifyReply } from "fastify";
import { errorBody } from "../errors.js";

/** Writes to the client as either one JSON response or an event stream. */
export class ClientResponse {
  private readonly raw: ServerResponse;
  private readonly headers: Record<string, string> = {};
  private streamStarted = false;
  private finished = false;
  private startTimer: NodeJS.Timeout | undefined;
  private keepaliveTimer: NodeJS.Timeout | undefined;
  private lastWriteAt = 0;

  constructor(
    private readonly reply: FastifyReply,
    private readonly now: () => number = Date.now,
  ) {
    this.raw = reply.raw;
  }

  get started(): boolean {
    return this.streamStarted;
  }

  get gone(): boolean {
    return this.finished || this.raw.destroyed || this.raw.writableEnded;
  }

  setHeaders(headers: Record<string, string>): void {
    Object.assign(this.headers, headers);
  }

  startStream(): void {
    if (this.streamStarted) return;
    this.streamStarted = true;
    this.reply.hijack();
    this.raw.writeHead(200, {
      ...this.headers,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    this.lastWriteAt = this.now();
  }

  async write(text: string): Promise<boolean> {
    if (this.gone) return false;
    this.lastWriteAt = this.now();
    if (this.raw.write(text)) return true;
    await new Promise<void>((resolve) => {
      const done = () => {
        this.raw.off("drain", done);
        this.raw.off("close", done);
        resolve();
      };
      this.raw.once("drain", done);
      this.raw.once("close", done);
    });
    return !this.gone;
  }

  /**
   * After a quiet period, opens the stream so proxies and clients do not time
   * out, then sends comments whenever nothing else has been written.
   */
  startKeepalive(afterMs: number, everyMs: number): void {
    this.startTimer = setTimeout(() => {
      if (!this.gone) this.startStream();
    }, afterMs);
    this.startTimer.unref();
    this.keepaliveTimer = setInterval(
      () => {
        if (this.streamStarted && !this.gone && this.now() - this.lastWriteAt >= everyMs) {
          void this.write(": keep-alive\n\n");
        }
      },
      Math.max(50, Math.floor(everyMs / 2)),
    );
    this.keepaliveTimer.unref();
  }

  /** Cancels the delayed stream start, once real output is about to be sent. */
  cancelDelayedStart(): void {
    clearTimeout(this.startTimer);
  }

  stopKeepalive(): void {
    clearTimeout(this.startTimer);
    clearInterval(this.keepaliveTimer);
  }

  endStream(): void {
    this.stopKeepalive();
    if (!this.finished) {
      this.finished = true;
      if (!this.raw.destroyed) this.raw.end();
    }
  }

  async sendJson(status: number, body: string): Promise<void> {
    this.stopKeepalive();
    if (this.streamStarted || this.reply.sent || this.gone) return;
    this.finished = true;
    await this.reply
      .code(status)
      .headers(this.headers)
      .type("application/json; charset=utf-8")
      .send(body);
  }

  /** Reports an error with a status code, or as an event if streaming began. */
  async sendError(
    status: number,
    message: string,
    type: string,
    code: string | null,
    param: string | null = null,
    headers: Record<string, string> = {},
  ): Promise<void> {
    this.setHeaders(headers);
    const body = JSON.stringify(errorBody(message, type, code, param));
    if (this.streamStarted) {
      await this.write(`data: ${body}\n\n`);
      await this.write("data: [DONE]\n\n");
      this.endStream();
      return;
    }
    await this.sendJson(status, body);
  }
}
