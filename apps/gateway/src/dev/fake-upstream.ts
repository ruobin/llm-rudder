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
      headers?: Record<string, string>;
      /** Stops after this many events until the promise resolves. */
      pause?: { afterEvents: number; until: Promise<unknown> };
    }
  | { type: "hang" };

export interface RecordedRequest {
  path: string;
  headers: IncomingMessage["headers"];
  body: JsonObject;
  rawBody: Buffer;
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

const anthropicEvent = (type: string, data: JsonObject = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}`;

export const ANTHROPIC_USAGE = {
  input_tokens: 100,
  cache_creation_input_tokens: 40,
  cache_read_input_tokens: 500,
  output_tokens: 20,
};

export function anthropicMessageBody(model: string, text: string): JsonObject {
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: ANTHROPIC_USAGE,
  };
}

/** The events that come before any model output. */
export function anthropicStreamStart(model: string): string[] {
  return [
    anthropicEvent("message_start", {
      message: {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...ANTHROPIC_USAGE, output_tokens: 1 },
      },
    }),
    anthropicEvent("ping"),
  ];
}

export function anthropicTextEvents(text: string): string[] {
  return [
    anthropicEvent("content_block_start", {
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    ...text.split(/(?<= )/).map((word) =>
      anthropicEvent("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: word },
      }),
    ),
    anthropicEvent("content_block_stop", { index: 0 }),
  ];
}

export function anthropicStreamEnd(): string[] {
  return [
    anthropicEvent("message_delta", {
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: ANTHROPIC_USAGE.output_tokens },
    }),
    anthropicEvent("message_stop"),
  ];
}

export function anthropicTextStream(model: string, text: string): FakeStep {
  return {
    type: "stream",
    events: [...anthropicStreamStart(model), ...anthropicTextEvents(text), ...anthropicStreamEnd()],
  };
}

export const anthropicErrorEvent = (type: string, message: string) =>
  anthropicEvent("error", { error: { type, message } });

export function anthropicErrorStep(
  status: number,
  type: string,
  message: string,
  headers: Record<string, string> = {},
): FakeStep {
  return {
    type: "json",
    status,
    headers,
    body: { type: "error", error: { type, message }, request_id: "req_fake" },
  };
}

/** A small scriptable server that speaks the OpenAI and Anthropic formats. */
export class FakeUpstream {
  readonly requests: RecordedRequest[] = [];
  /** Responses whose connection closed before they finished. */
  abandoned = 0;
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
    res.once("close", () => {
      if (!res.writableFinished) this.abandoned += 1;
    });
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part as Buffer);
    const rawBody = Buffer.concat(parts);
    let body: JsonObject = {};
    try {
      body = JSON.parse(rawBody.toString() || "{}") as JsonObject;
    } catch {
      // Some tests send bodies that are not JSON.
    }
    const path = req.url ?? "";
    this.requests.push({ path, headers: req.headers, body, rawBody });

    const model = String(body.model);
    const scripted = this.scripts.get(model)?.shift() ?? this.always.get(model);
    await this.play(scripted ?? this.defaultStep(path, model, body.stream === true), res);
  }

  private defaultStep(path: string, model: string, stream: boolean): FakeStep {
    const route = path.split("?")[0];
    const text = `Hello from ${model}`;
    if (route === "/v1/messages/count_tokens") {
      return { type: "json", body: { input_tokens: 123 } };
    }
    if (route === "/v1/messages") {
      return stream
        ? anthropicTextStream(model, text)
        : { type: "json", body: anthropicMessageBody(model, text) };
    }
    return stream ? textStream(model, text) : { type: "json", body: completionBody(model, text) };
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
        res.writeHead(200, { "content-type": "text/event-stream", ...step.headers });
        res.flushHeaders();
        if (step.firstDelayMs) await pause(step.firstDelayMs);
        for (const [index, event] of step.events.entries()) {
          if (step.pause?.afterEvents === index) await step.pause.until;
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
