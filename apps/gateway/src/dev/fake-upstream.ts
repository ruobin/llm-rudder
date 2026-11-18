import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { JsonObject } from "../types.js";

export type FakeStep =
  | { type: "json"; status?: number; body: unknown; headers?: Record<string, string> }
  | { type: "text"; status: number; text: string; headers?: Record<string, string> }
  | {
      type: "stream";
      events: string[];
      delayMs?: number;
      firstDelayMs?: number;
      /** "drop" closes the connection after the events, with no finish. */
      end?: "clean" | "drop";
    }
  | { type: "hang" };

export interface RecordedRequest {
  path: string;
  headers: IncomingMessage["headers"];
  body: JsonObject;
}

const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
const sse = (value: unknown) => `data: ${JSON.stringify(value)}`;

export function completionBody(model: string, text: string): JsonObject {
  return {
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: 1_800_000_000,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage,
  };
}

export function chunk(model: string, delta: JsonObject, finishReason: string | null = null) {
  return sse({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 1_800_000_000,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

export function usageChunk(model: string) {
  return sse({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 1_800_000_000,
    model,
    choices: [],
    usage,
  });
}

/** A normal streamed answer, split into a role chunk, words, finish and usage. */
export function textStream(model: string, text: string): FakeStep {
  return {
    type: "stream",
    events: [
      chunk(model, { role: "assistant", content: "" }),
      ...text.split(/(?<= )/).map((word) => chunk(model, { content: word })),
      chunk(model, {}, "stop"),
      usageChunk(model),
      "data: [DONE]",
    ],
  };
}

export function errorStep(
  status: number,
  code: string,
  message: string,
  type = "upstream_error",
): FakeStep {
  return { type: "json", status, body: { error: { code, message, type } } };
}

/** A small scriptable OpenAI-compatible server. */
export class FakeUpstream {
  readonly requests: RecordedRequest[] = [];
  private readonly scripts = new Map<string, FakeStep[]>();
  private readonly always = new Map<string, FakeStep>();
  private readonly sockets = new Set<Socket>();
  private server: Server | null = null;
  url = "";

  /** Queues responses for a model, used once each. */
  script(model: string, ...steps: FakeStep[]): this {
    this.scripts.set(model, [...(this.scripts.get(model) ?? []), ...steps]);
    return this;
  }

  /** Sets the response for every request to a model. */
  setAlways(model: string, step: FakeStep): this {
    this.always.set(model, step);
    return this;
  }

  clear(model: string): this {
    this.scripts.delete(model);
    this.always.delete(model);
    return this;
  }

  requestsFor(model: string): RecordedRequest[] {
    return this.requests.filter((request) => request.body.model === model);
  }

  async start(host = "127.0.0.1", port = 0): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
    const address = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${address.port}/v1`;
    return this;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise((resolve) => this.server?.close(resolve));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part as Buffer);
    const body = JSON.parse(Buffer.concat(parts).toString() || "{}") as JsonObject;
    this.requests.push({ path: req.url ?? "", headers: req.headers, body });

    const model = String(body.model);
    const step =
      this.scripts.get(model)?.shift() ??
      this.always.get(model) ??
      (body.stream === true
        ? textStream(model, `Hello from ${model}`)
        : ({ type: "json", body: completionBody(model, `Hello from ${model}`) } as FakeStep));
    await this.play(step, res);
  }

  private async play(step: FakeStep, res: ServerResponse): Promise<void> {
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    switch (step.type) {
      case "json":
        res.writeHead(step.status ?? 200, {
          "content-type": "application/json",
          ...step.headers,
        });
        res.end(JSON.stringify(step.body));
        return;
      case "text":
        res.writeHead(step.status, { "content-type": "text/html", ...step.headers });
        res.end(step.text);
        return;
      case "hang":
        return;
      case "stream": {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        if (step.firstDelayMs) await pause(step.firstDelayMs);
        for (const event of step.events) {
          if (res.destroyed) return;
          res.write(`${event}\n\n`);
          if (step.delayMs) await pause(step.delayMs);
        }
        if (step.end === "drop") {
          await pause(20); // lets the events reach the client before the connection dies
          res.destroy();
        } else {
          res.end();
        }
      }
    }
  }
}
