import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeStep } from "../src/dev/fake-upstream.js";
import { MemoryPersistence } from "../src/ledger/records.js";
import { asRelayedFailure, classifyHttpError } from "../src/upstream/classify.js";
import { CHAT_KEY, MODELS, startGateway, type TestGateway } from "./helpers.js";

/** What a real New API instance sent, so these tests do not depend on our own fakes. */
interface Recording {
  status: number;
  events?: string[];
  body?: unknown;
}

const recordings = JSON.parse(
  readFileSync(new URL("./fixtures/new-api.json", import.meta.url), "utf8"),
) as Record<string, Recording>;

const CONFIG = `
version: 1
server: { host: 127.0.0.1, port: 0, max_body_mb: 1 }
admin: { key_env: ADMIN_KEY }
clients:
  - { id: chat, key_env: CHAT_KEY, notice: none }
accounts:
  via-responses:
    api: openai.responses
    base_url_env: UPSTREAM_URL
    api_key_env: GATEWAY_KEY
    compat: new_api
    cost_class: prepaid
  via-chat: { base_url_env: UPSTREAM_URL, api_key_env: GATEWAY_KEY, compat: new_api, cost_class: prepaid }
tiers:
  responses-route:
    targets: [{ account: via-responses, model: gpt-6.1-terra }]
  chat-route:
    targets: [{ account: via-chat, model: chat-model }]
timeouts: { keepalive_after_s: 30, keepalive_interval_s: 15 }
`;

const TOOL_PARAMETERS = {
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
  additionalProperties: false,
};
const ASK_TOOL = "What time is it in Singapore? Use the tool.";

let gateway: TestGateway;
let persistence: MemoryPersistence;

const replay = (name: string, model: string) => {
  const recording = recordings[name]!;
  const step: FakeStep = recording.events
    ? { type: "stream", events: recording.events }
    : { type: "json", status: recording.status, body: recording.body as never };
  gateway.upstream.setAlways(model, step);
};

async function post(path: string, body: unknown): Promise<{ status: number; text: string }> {
  const response = await fetch(`${gateway.url}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CHAT_KEY}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

const dataEvents = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, any>); // eslint-disable-line @typescript-eslint/no-explicit-any

function readChat(text: string) {
  let content = "";
  let name = "";
  let args = "";
  for (const event of dataEvents(text)) {
    const delta = event.choices?.[0]?.delta;
    content += delta?.content ?? "";
    name += delta?.tool_calls?.[0]?.function?.name ?? "";
    args += delta?.tool_calls?.[0]?.function?.arguments ?? "";
  }
  return { content, name, args };
}

function readResponses(text: string) {
  let content = "";
  let call: Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const event of dataEvents(text)) {
    if (event.type === "response.output_text.delta") content += event.delta;
    if (event.type === "response.output_item.done" && event.item.type === "function_call") {
      call = event.item;
    }
  }
  return { content, name: call?.name, args: call?.arguments };
}

function readMessages(text: string) {
  let content = "";
  let name = "";
  let args = "";
  for (const event of dataEvents(text)) {
    if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
      name = event.content_block.name;
    }
    if (event.type === "content_block_delta") {
      content += event.delta.text ?? "";
      args += event.delta.partial_json ?? "";
    }
  }
  return { content, name, args };
}

const chatRequest = (model: string, tool: boolean) => ({
  model,
  stream: true,
  messages: [{ role: "user", content: tool ? ASK_TOOL : "Reply with exactly: ok" }],
  ...(tool
    ? {
        tools: [{ type: "function", function: { name: "get_time", parameters: TOOL_PARAMETERS } }],
        tool_choice: "required",
      }
    : {}),
});
const responsesRequest = (model: string, tool: boolean) => ({
  model,
  stream: true,
  input: tool ? ASK_TOOL : "Reply with exactly: ok",
  ...(tool
    ? {
        tools: [{ type: "function", name: "get_time", parameters: TOOL_PARAMETERS }],
        tool_choice: "required",
      }
    : {}),
});
const messagesRequest = (model: string, tool: boolean) => ({
  model,
  stream: true,
  max_tokens: 300,
  messages: [{ role: "user", content: tool ? ASK_TOOL : "Reply with exactly: ok" }],
  ...(tool
    ? {
        tools: [{ name: "get_time", input_schema: TOOL_PARAMETERS }],
        tool_choice: { type: "any" },
      }
    : {}),
});

const CLIENTS = [
  ["Chat Completions", "/v1/chat/completions", chatRequest, readChat],
  ["Responses", "/v1/responses", responsesRequest, readResponses],
  ["Messages", "/v1/messages", messagesRequest, readMessages],
] as const;

const ROUTES = [
  [
    "Responses",
    "responses-route",
    "gpt-6.1-terra",
    "responses-text-stream",
    "responses-tool-stream",
  ],
  ["Chat Completions", "chat-route", "chat-model", "chat-text-stream", "chat-tool-stream"],
] as const;

beforeEach(async () => {
  persistence = new MemoryPersistence();
  gateway = await startGateway({ yaml: CONFIG, models: MODELS, persistence });
});

afterEach(() => gateway.close());

describe.each(ROUTES)("real New API %s streams", (_route, tier, model, textName, toolName) => {
  it.each(CLIENTS)("reach a %s client as text", async (_client, path, request, read) => {
    replay(textName, model);
    const reply = await post(path, request(tier, false));
    expect(reply.status).toBe(200);
    expect(read(reply.text).content).toBe("ok");
  });

  it.each(CLIENTS)("reach a %s client as a tool call", async (_client, path, request, read) => {
    replay(toolName, model);
    const reply = await post(path, request(tier, true));
    expect(reply.status).toBe(200);
    const { name, args } = read(reply.text);
    expect(name).toBe("get_time");
    expect(JSON.parse(args!)).toEqual({ city: "Singapore" });
  });
});

describe("real New API usage reports", () => {
  it("records cached tokens from a Responses stream", async () => {
    replay("responses-text-stream", "gpt-6.1-terra");
    await post("/v1/chat/completions", chatRequest("responses-route", false));
    const attempt = persistence.ledger.at(-1)!.attempts[0]!;
    expect(attempt).toMatchObject({ outcome: "ok", outputTokens: 5, cachedTokens: 3968 });
    expect(attempt.inputTokens).toBe(195);
    expect(attempt.returnedModel).toBe("gpt-6.1-terra");
  });

  it("reads a complete Chat Completions reply", async () => {
    replay("chat-text", "chat-model");
    const reply = await post("/v1/chat/completions", {
      ...chatRequest("chat-route", false),
      stream: false,
    });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.text).choices[0].message.content).toBe("ok");
    expect(persistence.ledger.at(-1)!.attempts[0]).toMatchObject({
      inputTokens: 11,
      outputTokens: 5,
    });
  });
});

describe("real New API errors", () => {
  const classify = (name: string) => {
    const { status, body } = recordings[name]!;
    return classifyHttpError(status, {}, JSON.stringify(body), 1_000);
  };

  it.each(["error-unknown-model-responses", "error-unknown-model-chat"])(
    "treats %s as a missing route for that model",
    (name) => {
      expect(classify(name)).toMatchObject({
        outcome: "unsupported",
        scope: "model",
        retryElsewhere: true,
        code: "model_not_found",
      });
    },
  );

  it.each(["error-invalid-key", "error-no-key"])(
    "needs confirmation before %s can stop the account",
    (name) => {
      const failure = classify(name);
      expect(failure).toMatchObject({ outcome: "auth", scope: "account" });
      expect(asRelayedFailure(failure)).toMatchObject({
        outcome: "upstream_error",
        scope: "model",
      });
    },
  );

  it("returns a request New API rejects to the client", () => {
    expect(classify("error-bad-request")).toMatchObject({
      outcome: "client_error",
      retryElsewhere: false,
      clientStatus: 400,
    });
  });
});
