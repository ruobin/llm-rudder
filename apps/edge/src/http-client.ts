import {
  Agent as HttpAgent,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { Readable } from "node:stream";

const CONNECT_TIMEOUT_MS = 15_000;
const RETRIABLE_ON_REUSED_SOCKET = new Set(["ECONNRESET", "EPIPE"]);

export interface SendOptions {
  method: string;
  headers: OutgoingHttpHeaders;
  body?: Buffer | Readable;
  signal?: AbortSignal;
  responseTimeoutMs: number;
}

/** Sends raw bytes and returns raw bytes, so nothing is decoded along the way. */
export class HttpClient {
  private readonly http = new HttpAgent({ keepAlive: true, maxSockets: 64 });
  private readonly https = new HttpsAgent({ keepAlive: true, maxSockets: 64 });

  async send(url: URL, options: SendOptions): Promise<IncomingMessage> {
    try {
      return await this.attempt(url, options);
    } catch (error) {
      // A kept-alive connection can be closed by the other side just as it is reused.
      const stale = (error as StaleSocketError).reusedSocket === true;
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (stale && RETRIABLE_ON_REUSED_SOCKET.has(code) && Buffer.isBuffer(options.body)) {
        return this.attempt(url, options);
      }
      throw error;
    }
  }

  private attempt(url: URL, options: SendOptions): Promise<IncomingMessage> {
    const secure = url.protocol === "https:";
    return new Promise((resolve, reject) => {
      const request: ClientRequest = (secure ? httpsRequest : httpRequest)(url, {
        method: options.method,
        headers: options.headers,
        agent: secure ? this.https : this.http,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const connectTimer = setTimeout(
        () => request.destroy(new Error("Timed out connecting.")),
        CONNECT_TIMEOUT_MS,
      );
      const responseTimer = setTimeout(
        () => request.destroy(new Error("Timed out waiting for a response.")),
        options.responseTimeoutMs,
      );
      const clearTimers = () => {
        clearTimeout(connectTimer);
        clearTimeout(responseTimer);
      };
      request.once("socket", (socket) => {
        if (!socket.connecting) clearTimeout(connectTimer);
        else socket.once(secure ? "secureConnect" : "connect", () => clearTimeout(connectTimer));
      });
      request.once("response", (response) => {
        clearTimers();
        resolve(response);
      });
      request.once("error", (error) => {
        clearTimers();
        (error as StaleSocketError).reusedSocket = request.reusedSocket;
        reject(error);
      });
      if (Buffer.isBuffer(options.body)) request.end(options.body);
      else if (options.body) options.body.pipe(request);
      else request.end();
    });
  }

  close(): void {
    this.http.destroy();
    this.https.destroy();
  }
}

interface StaleSocketError extends Error {
  reusedSocket?: boolean;
}

/** Reads a whole response, for errors and small JSON documents. */
export async function readResponse(response: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of response as AsyncIterable<Buffer>) {
    size += part.length;
    if (size > maxBytes) {
      response.destroy();
      throw new Error("The response is too large.");
    }
    parts.push(part);
  }
  return Buffer.concat(parts);
}
