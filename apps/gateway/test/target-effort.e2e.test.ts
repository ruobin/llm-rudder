import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHAT_KEY, MODELS, startGateway, type TestGateway } from "./helpers.js";

const CONFIG = `
version: 1
server: { host: 127.0.0.1, port: 0, max_body_mb: 1 }
admin: { key_env: ADMIN_KEY }
clients:
  - { id: chat, key_env: CHAT_KEY, notice: none }
accounts:
  chat-key: { base_url_env: UPSTREAM_URL, api_key_env: OPENAI_KEY, cost_class: metered }
  responses-key:
    api: openai.responses
    base_url_env: UPSTREAM_URL
    api_key_env: OPENAI_KEY
    cost_class: metered
  messages-key:
    api: anthropic.messages
    base_url_env: UPSTREAM_URL
    api_key_env: ANTHROPIC_KEY
    cost_class: metered
tiers:
  chat-tier:
    targets: [{ account: chat-key, model: chat-model, effort: high }]
  plain:
    targets: [{ account: chat-key, model: plain-model }]
  responses-tier:
    targets: [{ account: responses-key, model: responses-model, effort: high }]
  messages-tier:
    targets: [{ account: messages-key, model: messages-model, effort: high }]
  limited:
    targets: [{ account: chat-key, model: gemini-4-hydrogen, effort: max }]
timeouts: { keepalive_after_s: 30, keepalive_interval_s: 15 }
`;

let gateway: TestGateway;

const send = async (path: string, text: string) => {
  const response = await fetch(`${gateway.url}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CHAT_KEY}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: text,
  });
  await response.text();
  expect(response.status).toBe(200);
  return gateway.upstream.requests.at(-1)!;
};

beforeEach(async () => {
  gateway = await startGateway({ yaml: CONFIG, models: MODELS });
});

afterEach(() => gateway.close());

describe("a target's reasoning effort on untranslated requests", () => {
  const user = '"messages":[{"role":"user","content":"Hi"}]';

  it("is added to a Chat Completions request that sets none", async () => {
    const request = await send("/v1/chat/completions", `{"model":"chat-tier",${user}}`);
    expect(request.body.reasoning_effort).toBe("high");
  });

  it("gives way to the client's own choice", async () => {
    const request = await send(
      "/v1/chat/completions",
      `{"model":"chat-tier","reasoning_effort":"low",${user}}`,
    );
    expect(request.body.reasoning_effort).toBe("low");
  });

  it("is not invented for a target without one", async () => {
    const request = await send("/v1/chat/completions", `{"model":"plain",${user}}`);
    expect(request.body).not.toHaveProperty("reasoning_effort");
  });

  it("uses the closest level the model accepts", async () => {
    const request = await send("/v1/chat/completions", `{"model":"limited",${user}}`);
    expect(request.body.reasoning_effort).toBe("xhigh");
  });

  it("is added to a Responses request, leaving the other bytes alone", async () => {
    const request = await send(
      "/v1/responses",
      '{"model":"responses-tier","n": 1.50,"input":"Hi"}',
    );
    expect(request.rawBody.toString()).toBe(
      '{"model":"responses-model","n": 1.50,"input":"Hi","reasoning":{"effort":"high"}}',
    );
  });

  it("joins other reasoning settings in a Responses request", async () => {
    const request = await send(
      "/v1/responses",
      '{"model":"responses-tier","reasoning":{"summary":"auto"},"input":"Hi"}',
    );
    expect(request.rawBody.toString()).toBe(
      '{"model":"responses-model","reasoning":{"summary":"auto","effort":"high"},"input":"Hi"}',
    );
  });

  it("leaves a Responses request that chose its own level untouched", async () => {
    const request = await send(
      "/v1/responses",
      '{"model":"responses-tier","reasoning":{"effort":"low"},"input":"Hi"}',
    );
    expect(request.rawBody.toString()).toBe(
      '{"model":"responses-model","reasoning":{"effort":"low"},"input":"Hi"}',
    );
  });

  it("is added to a Messages request without changing the conversation", async () => {
    const request = await send(
      "/v1/messages",
      `{"model":"messages-tier","max_tokens":10, ${user}}`,
    );
    expect(request.rawBody.toString()).toBe(
      `{"model":"messages-model","max_tokens":10, ${user},"output_config":{"effort":"high"}}`,
    );
  });

  it("leaves a Messages request that chose its own level untouched", async () => {
    const request = await send(
      "/v1/messages",
      `{"model":"messages-tier","max_tokens":10,"output_config":{"effort":"low"},${user}}`,
    );
    expect(request.rawBody.toString()).toBe(
      `{"model":"messages-model","max_tokens":10,"output_config":{"effort":"low"},${user}}`,
    );
  });
});
