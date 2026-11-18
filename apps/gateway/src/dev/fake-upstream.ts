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

/** A tool call in the Anthropic stream format. */
export function anthropicToolStream(
  model: string,
  id: string,
  name: string,
  input: JsonObject,
  thinking?: { text: string; signature: string },
): FakeStep {
  const json = JSON.stringify(input);
  const middle = Math.floor(json.length / 2);
  const offset = thinking ? 1 : 0;
  return {
    type: "stream",
    events: [
      ...anthropicStreamStart(model),
      ...(thinking
        ? [
            anthropicEvent("content_block_start", {
              index: 0,
              content_block: { type: "thinking", thinking: "", signature: "" },
            }),
            anthropicEvent("content_block_delta", {
              index: 0,
              delta: { type: "thinking_delta", thinking: thinking.text },
            }),
            anthropicEvent("content_block_delta", {
              index: 0,
              delta: { type: "signature_delta", signature: thinking.signature },
            }),
            anthropicEvent("content_block_stop", { index: 0 }),
          ]
        : []),
      anthropicEvent("content_block_start", {
        index: offset,
        content_block: { type: "tool_use", id, name, input: {} },
      }),
      anthropicEvent("content_block_delta", {
        index: offset,
        delta: { type: "input_json_delta", partial_json: json.slice(0, middle) },
      }),
      anthropicEvent("content_block_delta", {
        index: offset,
        delta: { type: "input_json_delta", partial_json: json.slice(middle) },
      }),
      anthropicEvent("content_block_stop", { index: offset }),
      anthropicEvent("message_delta", {
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: ANTHROPIC_USAGE.output_tokens },
      }),
      anthropicEvent("message_stop"),
    ],
  };
}

/** A tool call in the Chat Completions stream format. */
export function chatToolStream(
  model: string,
  id: string,
  name: string,
  input: JsonObject,
  extraContent?: JsonObject,
): FakeStep {
  const json = JSON.stringify(input);
  const middle = Math.floor(json.length / 2);
  return {
    type: "stream",
    events: [
      chunk(model, { role: "assistant", content: "" }),
      chunk(model, {
        tool_calls: [
          {
            index: 0,
            id,
            type: "function",
            function: { name, arguments: json.slice(0, middle) },
            ...(extraContent ? { extra_content: extraContent } : {}),
          },
        ],
      }),
      chunk(model, { tool_calls: [{ index: 0, function: { arguments: json.slice(middle) } }] }),
      chunk(model, {}, "tool_calls"),
      usageChunk(model),
      "data: [DONE]",
    ],
  };
}

const RESPONSES_USAGE = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 40 },
  output_tokens: 20,
  output_tokens_details: { reasoning_tokens: 5 },
  total_tokens: 120,
};

const responsesEvent = (type: string, data: JsonObject = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}`;

function responseObject(model: string, status: string, output: JsonObject[] = []): JsonObject {
  return { id: "resp_fake", object: "response", created_at: 1_800_000_000, model, status, output };
}

export function responsesBody(model: string, text: string): JsonObject {
  return {
    ...responseObject(model, "completed", [
      {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ]),
    usage: RESPONSES_USAGE,
  };
}

export function responsesStart(model: string): string[] {
  const response = responseObject(model, "in_progress");
  return [
    responsesEvent("response.created", { response }),
    responsesEvent("response.in_progress", { response }),
  ];
}

export function responsesTextEvents(text: string): string[] {
  const item = {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    status: "in_progress",
    content: [],
  };
  const where = { item_id: "msg_fake", output_index: 0, content_index: 0 };
  const part = { type: "output_text", text, annotations: [] };
  return [
    responsesEvent("response.output_item.added", { output_index: 0, item }),
    responsesEvent("response.content_part.added", {
      ...where,
      part: { type: "output_text", text: "", annotations: [] },
    }),
    ...text
      .split(/(?<= )/)
      .map((delta) => responsesEvent("response.output_text.delta", { ...where, delta })),
    responsesEvent("response.output_text.done", { ...where, text }),
    responsesEvent("response.content_part.done", { ...where, part }),
    responsesEvent("response.output_item.done", {
      output_index: 0,
      item: { ...item, status: "completed", content: [part] },
    }),
  ];
}

export function responsesEnd(model: string, output: JsonObject[] = []): string[] {
  return [
    responsesEvent("response.completed", {
      response: { ...responseObject(model, "completed", output), usage: RESPONSES_USAGE },
    }),
  ];
}

export function responsesTextStream(model: string, text: string): FakeStep {
  return {
    type: "stream",
    events: [...responsesStart(model), ...responsesTextEvents(text), ...responsesEnd(model)],
  };
}

/** A tool call in the Responses stream format, optionally after a reasoning item. */
export function responsesToolStream(
  model: string,
  callId: string,
  name: string,
  input: JsonObject,
  reasoning?: JsonObject,
  namespace?: string,
): FakeStep {
  const json = JSON.stringify(input);
  const middle = Math.floor(json.length / 2);
  const index = reasoning ? 1 : 0;
  const item = {
    id: "fc_fake",
    type: "function_call",
    call_id: callId,
    name,
    ...(namespace ? { namespace } : {}),
    arguments: "",
  };
  const where = { item_id: "fc_fake", output_index: index };
  return {
    type: "stream",
    events: [
      ...responsesStart(model),
      ...(reasoning
        ? [responsesEvent("response.output_item.done", { output_index: 0, item: reasoning })]
        : []),
      responsesEvent("response.output_item.added", { output_index: index, item }),
      responsesEvent("response.function_call_arguments.delta", {
        ...where,
        delta: json.slice(0, middle),
      }),
      responsesEvent("response.function_call_arguments.delta", {
        ...where,
        delta: json.slice(middle),
      }),
      responsesEvent("response.function_call_arguments.done", { ...where, arguments: json }),
      responsesEvent("response.output_item.done", {
        output_index: index,
        item: { ...item, arguments: json, status: "completed" },
      }),
      ...responsesEnd(model),
    ],
  };
}

export function responsesFailedEvent(code: string, message: string): string {
  return responsesEvent("response.failed", {
    response: { ...responseObject("m", "failed"), error: { code, message } },
  });
}

/** A small scriptable server that speaks every format the gateway supports. */
export class FakeUpstream {
  readonly requests: RecordedRequest[] = [];
  /** Responses whose connection closed before they finished. */
  abandoned = 0;
  /** What GET /v1/models returns for a ChatGPT plan. */
  planModels: JsonObject[] | null = null;
  private readonly scripts = new Map<string, FakeStep[]>();
  private readonly always = new Map<string, FakeStep>();
  private readonly paths = new Map<string, FakeStep>();
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

  /** Sets the response for every request to a path, such as /v1/models. */
  setPath(path: string, step: FakeStep): this {
    this.paths.set(path, step);
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
    const scripted =
      this.scripts.get(model)?.shift() ??
      this.always.get(model) ??
      this.paths.get(path.split("?")[0] ?? path);
    await this.play(scripted ?? this.defaultStep(path, model, body.stream === true), res);
  }

  private defaultStep(path: string, model: string, stream: boolean): FakeStep {
    const route = path.split("?")[0];
    const text = `Hello from ${model}`;
    if (route === "/v1/models" && this.planModels) {
      return { type: "json", body: { models: this.planModels } };
    }
    if (route === "/v1/messages/count_tokens") {
      return { type: "json", body: { input_tokens: 123 } };
    }
    if (route === "/v1/messages") {
      return stream
        ? anthropicTextStream(model, text)
        : { type: "json", body: anthropicMessageBody(model, text) };
    }
    if (route === "/v1/responses") {
      return stream
        ? responsesTextStream(model, text)
        : { type: "json", body: responsesBody(model, text) };
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
