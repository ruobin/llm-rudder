import { request as httpRequest } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config/load.js";
import {
  anthropicErrorEvent,
  anthropicErrorStep,
  anthropicMessageBody,
  anthropicStreamEnd,
  anthropicStreamStart,
  anthropicTextEvents,
  anthropicTextStream,
  type FakeStep,
} from "../src/dev/fake-upstream.js";
import type { MemoryPersistence } from "../src/ledger/records.js";
import {
  ADMIN_KEY,
  ANTHROPIC_UPSTREAM_KEY,
  BACKUP_UPSTREAM_KEY,
  CHAT_KEY,
  CLAUDE_CONFIG,
  CLAUDE_KEY,
  PRICING,
  readJson,
  startGateway,
  userMessage,
  type TestGateway,
} from "./helpers.js";

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const BACKUP = "backup-opus";

let gateway: TestGateway;

interface SendOptions {
  key?: string;
  headers?: Record<string, string>;
  path?: string;
}

function send(body: unknown, options: SendOptions = {}) {
  return fetch(`${gateway.url}${options.path ?? "/v1/messages"}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.key ?? CLAUDE_KEY}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...options.headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const request = (overrides: Record<string, unknown> = {}) => ({
  model: OPUS,
  max_tokens: 100,
  messages: userMessage(),
  ...overrides,
});

const ledger = () => (gateway.persistence as MemoryPersistence).ledger;

async function sendWithConfig(yaml: string) {
  await gateway.close();
  gateway = await startGateway({ yaml });
}

beforeEach(async () => {
  gateway = await startGateway({ yaml: CLAUDE_CONFIG });
});

afterEach(async () => {
  await gateway.close();
});

describe("POST /v1/messages", () => {
  it("streams to the official Anthropic SDK", async () => {
    const client = new Anthropic({ apiKey: CLAUDE_KEY, baseURL: gateway.url, maxRetries: 0 });
    const stream = client.messages.stream(request() as never);
    const seen: string[] = [];
    stream.on("text", (text) => seen.push(text));
    const message = await stream.finalMessage();

    expect(seen.join("")).toBe(`Hello from ${OPUS}`);
    expect(message.stop_reason).toBe("end_turn");
    expect(message.usage.output_tokens).toBe(20);
    expect(gateway.upstream.requests[0]?.path).toBe("/v1/messages");
  });

  it("answers non-streaming requests through the SDK", async () => {
    const client = new Anthropic({ apiKey: CLAUDE_KEY, baseURL: gateway.url, maxRetries: 0 });
    const message = await client.messages.create(request() as never);
    expect(message).toMatchObject({ type: "message", model: OPUS });
  });

  it("changes nothing in the body except the model", async () => {
    // Parsing and re-encoding this would reorder keys and change the number.
    const prefix =
      '{"tools":[{"name":"t","input_schema":{"properties":{"b":{},"2":{},"1":{}}}}],"temperature":1.0,' +
      '"system":[{"type":"text","text":"a\\u00e9","cache_control":{"type":"ephemeral","ttl":"1h"}}],';
    const suffix =
      ',"max_tokens":10,"messages":[{"role":"user","content":"hi"}],"future_field":{}}';

    await send(`${prefix}"model":"strong"${suffix}`);
    expect(gateway.upstream.requests[0]?.rawBody.toString()).toBe(
      `${prefix}"model":"${OPUS}"${suffix}`,
    );

    await send(`${prefix}"model":"${OPUS}"${suffix}`);
    expect(gateway.upstream.requests[1]?.rawBody.toString()).toBe(
      `${prefix}"model":"${OPUS}"${suffix}`,
    );
  });

  it("sends only the account's key and strips client credentials", async () => {
    const response = await fetch(`${gateway.url}/v1/messages?beta=true&other=1`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${CLAUDE_KEY}`,
        cookie: "session=client-cookie",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20,context-1m",
        "anthropic-future": "kept",
        "x-claude-code-session-id": "session-1",
      },
      body: JSON.stringify(request()),
    });
    expect(response.status).toBe(200);

    const seen = gateway.upstream.requests[0]!;
    expect(seen.path).toBe("/v1/messages?beta=true");
    expect(seen.headers["x-api-key"]).toBe(ANTHROPIC_UPSTREAM_KEY);
    expect(seen.headers.authorization).toBeUndefined();
    expect(seen.headers.cookie).toBeUndefined();
    expect(seen.headers["anthropic-version"]).toBe("2023-06-01");
    expect(seen.headers["anthropic-beta"]).toBe("context-1m");
    expect(seen.headers["anthropic-future"]).toBe("kept");
    expect(JSON.stringify(seen.headers)).not.toContain(CLAUDE_KEY);
  });

  it("removes the beta header when only a login value was present", async () => {
    await send(request(), { headers: { "anthropic-beta": "oauth-2025-04-20" } });
    expect(gateway.upstream.requests[0]?.headers["anthropic-beta"]).toBeUndefined();
  });

  it("returns upstream headers that clients read", async () => {
    gateway.upstream.script(OPUS, {
      ...anthropicTextStream(OPUS, "ok"),
      headers: { "request-id": "req_up", "anthropic-ratelimit-tokens-remaining": "9" },
    } as never);
    const response = await send(request({ stream: true }));
    await response.text();
    expect(response.headers.get("request-id")).toBe("req_up");
    expect(response.headers.get("anthropic-ratelimit-tokens-remaining")).toBe("9");
    expect(response.headers.get("content-type")).toContain("text/event-stream");
  });

  it("passes the stream through event by event", async () => {
    const response = await send(request({ stream: true }));
    const text = await response.text();
    const names = [...text.matchAll(/^event: (\w+)$/gm)].map((match) => match[1]);
    expect(names).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(text).not.toContain("[DONE]");
  });

  it("forwards pings once output has started", async () => {
    gateway.upstream.script(OPUS, {
      type: "stream",
      events: [
        ...anthropicStreamStart(OPUS),
        ...anthropicTextEvents("a"),
        'event: ping\ndata: {"type":"ping"}',
        ...anthropicStreamEnd(),
      ],
    });
    const text = await (await send(request({ stream: true }))).text();
    expect(text.match(/event: ping/g)).toHaveLength(1);
    expect(text.indexOf("event: ping")).toBeGreaterThan(text.indexOf("content_block_start"));
  });

  it("uses bearer auth for accounts configured that way", async () => {
    gateway.upstream.script(OPUS, anthropicErrorStep(529, "overloaded_error", "Overloaded"));
    const response = await send(request());
    expect(response.status).toBe(200);
    const seen = gateway.upstream.requestsFor(BACKUP)[0]!;
    expect(seen.headers.authorization).toBe(`Bearer ${BACKUP_UPSTREAM_KEY}`);
    expect(seen.headers["x-api-key"]).toBeUndefined();
  });

  it("fails over on an overloaded upstream and says so in headers", async () => {
    gateway.upstream.script(OPUS, anthropicErrorStep(529, "overloaded_error", "Overloaded"));
    const response = await send(request({ stream: true }));
    expect(await response.text()).toContain(`Hello from ${BACKUP}`.split(" ")[0]);
    expect(response.headers.get("x-llmr-target")).toBe(`frontier/backup/${BACKUP}`);
    expect(response.headers.get("x-llmr-fallback")).toBe("anthropic-key:overloaded");
    expect(response.headers.get("x-llmr-attempts")).toBe("2");
  });

  it("fails over when the stream reports an error before any output", async () => {
    gateway.upstream.script(OPUS, {
      type: "stream",
      events: [
        ...anthropicStreamStart(OPUS),
        anthropicErrorEvent("overloaded_error", "Overloaded"),
      ],
    });
    const response = await send(request({ stream: true }));
    const text = await response.text();
    expect(response.headers.get("x-llmr-target")).toContain(BACKUP);
    expect(text).not.toContain("event: error");
    expect(text.match(/event: message_start/g)).toHaveLength(1);
    expect(text).toContain(`"model":"${BACKUP}"`);
  });

  it("reports an error event, and never switches, after output has started", async () => {
    gateway.upstream.script(OPUS, {
      type: "stream",
      events: [
        ...anthropicStreamStart(OPUS),
        ...anthropicTextEvents("partial"),
        anthropicErrorEvent("overloaded_error", "Overloaded"),
      ],
    });
    const text = await (await send(request({ stream: true }))).text();
    expect(text).toContain("partial");
    expect(text).toContain("event: error");
    expect(text).toContain('"type":"overloaded_error"');
    expect(text).not.toContain("message_stop");
    expect(gateway.upstream.requestsFor(BACKUP)).toHaveLength(0);
  });

  it("reports an error when the upstream connection drops mid-stream", async () => {
    gateway.upstream.script(OPUS, {
      type: "stream",
      events: [...anthropicStreamStart(OPUS), ...anthropicTextEvents("partial")],
      end: "drop",
    });
    const text = await (await send(request({ stream: true }))).text();
    expect(text).toContain("event: error");
    expect(text).toContain('"type":"api_error"');
  });

  it("returns client errors unchanged, without trying other targets", async () => {
    const step = anthropicErrorStep(400, "invalid_request_error", "messages: bad block", {
      "request-id": "req_bad",
      "x-should-retry": "false",
    });
    gateway.upstream.script(OPUS, step);
    const response = await send(request());
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(JSON.stringify((step as { body: unknown }).body));
    expect(response.headers.get("request-id")).toBe("req_bad");
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(response.headers.get("x-llmr-upstream-error")).toBe("1");
    expect(gateway.upstream.requestsFor(BACKUP)).toHaveLength(0);
  });

  it("returns context overflow unchanged on streaming requests too", async () => {
    gateway.upstream.script(
      OPUS,
      anthropicErrorStep(400, "invalid_request_error", "prompt is too long: 300000 tokens"),
    );
    const response = await send(request({ stream: true }));
    expect(response.status).toBe(400);
    expect(((await readJson(response)) as any).error.message).toContain("prompt is too long"); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(gateway.upstream.requestsFor(BACKUP)).toHaveLength(0);
  });

  it("treats a tier spend cap as exhausted until next month", async () => {
    gateway.upstream.script(OPUS, {
      type: "json",
      status: 429,
      body: {
        type: "error",
        error: {
          type: "rate_limit_error",
          message: "Monthly spend cap reached",
          details: { error_code: "enforced_spend_limit_reached" },
        },
      },
    });
    const response = await send(request());
    expect(response.headers.get("x-llmr-target")).toContain(BACKUP);
    const state = gateway.runtime.quota
      .snapshot()
      .find((entry) => entry.accountId === "anthropic-key");
    expect(state?.state.status).toBe("exhausted");
    expect(new Date(state!.state.retryAt!).getUTCDate()).toBe(1);
  });

  it("falls to the next tier when a tier is used up", async () => {
    for (const model of [OPUS, BACKUP]) {
      gateway.upstream.script(model, anthropicErrorStep(429, "rate_limit_error", "Slow down"));
    }
    const response = await send(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("x-llmr-tier-fallback")).toBe("frontier->medium");
    expect(gateway.events.map((event) => event.kind)).toContain("tier_fallback_started");
    // Claude Code warns through the status line, so the reply itself is untouched.
    expect(JSON.stringify(await readJson(response))).not.toContain("llm-rudder");
  });

  it("reports exhaustion in Anthropic's format", async () => {
    const quota = anthropicErrorStep(
      400,
      "invalid_request_error",
      "Your credit balance is too low",
    );
    gateway.upstream.setAlways(OPUS, quota);
    gateway.upstream.setAlways(SONNET, quota);
    gateway.upstream.setAlways("claude-haiku-5-5", quota);
    gateway.upstream.setAlways(
      BACKUP,
      anthropicErrorStep(402, "billing_error", "Payment required"),
    );

    const response = await send(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(response.headers.get("x-llmr-upstream-error")).toBeNull();
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await readJson(response)).toMatchObject({
      type: "error",
      error: { type: "rate_limit_error" },
    });
  });

  it("returns 529 when every target is overloaded", async () => {
    const overloaded = anthropicErrorStep(529, "overloaded_error", "Overloaded");
    for (const model of [OPUS, BACKUP, SONNET, "claude-haiku-5-5"]) {
      gateway.upstream.setAlways(model, overloaded);
    }
    const response = await send(request());
    expect(response.status).toBe(529);
    expect(await readJson(response)).toMatchObject({ error: { type: "overloaded_error" } });
  });

  it("uses Anthropic's error format for its own errors", async () => {
    const denied = await send(request(), { key: "llmr_wrong_key_0123456789abcdefghijklmn" });
    expect(denied.status).toBe(401);
    expect(await readJson(denied)).toMatchObject({
      type: "error",
      error: { type: "authentication_error", message: "Invalid API key." },
    });

    const malformed = await send("{not json");
    expect(malformed.status).toBe(400);
    expect(await readJson(malformed)).toMatchObject({ error: { type: "invalid_request_error" } });

    const noModel = await send({ messages: [] });
    expect(noModel.status).toBe(400);

    const unknown = await send(request({ model: "not-a-model" }));
    expect(unknown.status).toBe(404);
    expect(await readJson(unknown)).toMatchObject({ error: { type: "not_found_error" } });

    // Declares a large body without sending it, so the result does not depend on timing.
    const large = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
      const upload = httpRequest(
        `${gateway.url}/v1/messages`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${CLAUDE_KEY}`,
            "content-type": "application/json",
            "content-length": 2 * 1024 * 1024,
          },
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (part: string) => (body += part));
          response.on("end", () => {
            resolve({ status: response.statusCode, body });
            upload.destroy();
          });
        },
      );
      upload.on("error", reject);
      upload.flushHeaders();
    });
    expect(large.status).toBe(413);
    expect(JSON.parse(large.body)).toMatchObject({ error: { type: "request_too_large" } });
  });

  it("tries accounts in the client's own format first", async () => {
    await send(request());
    expect(gateway.upstream.requests.at(-1)?.path).toBe("/v1/messages");

    const chat = await gateway.post({ model: "frontier", messages: userMessage() });
    expect(chat.status).toBe(200);
    expect(gateway.upstream.requests.at(-1)?.path).toBe("/v1/chat/completions");
    expect(gateway.upstream.requests.at(-1)?.body.model).toBe("gpt-frontier");
  });

  it("records tokens and cost, including prompt cache writes", async () => {
    await (await send(request({ stream: true }))).text();
    const attempt = ledger().at(-1)!.attempts[0]!;
    expect(attempt).toMatchObject({
      inputTokens: 100,
      cachedTokens: 500,
      cacheWriteTokens: 40,
      outputTokens: 20,
      usageComplete: true,
      // 100 x 4 + 500 x 0.2 + 40 x 5 + 20 x 20
      costMicroUsd: 1100,
    });
    expect(gateway.runtime.budgets.snapshot("anthropic-key").dayMicroUsd).toBe(1100);
  });

  it("bills one-hour cache writes at their own price", async () => {
    gateway.upstream.script(OPUS, {
      type: "json",
      body: {
        ...anthropicMessageBody(OPUS, "ok"),
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 30,
          cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
        },
      },
    });
    await send(request());
    // 10 x 5 + 20 x 8
    expect(ledger().at(-1)!.attempts[0]!.costMicroUsd).toBe(210);
  });

  it("sends comments while waiting for the first output", async () => {
    await sendWithConfig(
      CLAUDE_CONFIG.replace(
        "keepalive_after_s: 30, keepalive_interval_s: 15",
        "keepalive_after_s: 0.03, keepalive_interval_s: 0.03",
      ),
    );
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    gateway.upstream.script(OPUS, {
      ...anthropicTextStream(OPUS, "late"),
      pause: { afterEvents: 0, until: released },
    } as FakeStep);

    const response = await send(request({ stream: true }));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value);
    // The upstream has sent nothing yet, so this can only be a keep-alive.
    expect(text.startsWith(": keep-alive")).toBe(true);

    release();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect(text).toContain("message_stop");
  });
});

describe("requests from an edge", () => {
  const edgeHeaders = {
    "x-llmr-tier": "medium",
    "x-llmr-no-fallback": "1",
    "x-llmr-requested-tier": "frontier",
    "x-llmr-plan-exhausted": "1",
  };

  it("records that the plan ran out and which tier was wanted", async () => {
    const response = await send(request(), { headers: edgeHeaders });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-llmr-target")).toBe(`medium/anthropic-key/${SONNET}`);
    expect(response.headers.get("x-llmr-tier-fallback")).toBe("frontier->medium");
    expect(response.headers.get("x-llmr-fallback")).toBe("claude-plan:exhausted");

    expect(ledger().at(-1)!.request).toMatchObject({
      requestedTier: "frontier",
      servedTier: "medium",
    });
    const kinds = gateway.events.map((event) => event.kind);
    expect(kinds).toContain("tier_fallback_started");
    expect(kinds).toContain("metered_first_use");
  });

  it("stays inside the tier it was told to use", async () => {
    gateway.upstream.setAlways(SONNET, anthropicErrorStep(529, "overloaded_error", "Overloaded"));
    const response = await send(request(), { headers: edgeHeaders });
    expect(response.status).toBe(529);
    expect(response.headers.get("x-llmr-upstream-error")).toBeNull();
    expect(gateway.upstream.requestsFor("claude-haiku-5-5")).toHaveLength(0);
  });

  it("ignores those claims from clients that are not edges", async () => {
    const response = await send(request(), { key: CHAT_KEY, headers: edgeHeaders });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-llmr-tier-fallback")).toBeNull();
    expect(response.headers.get("x-llmr-fallback")).toBeNull();
    expect(ledger().at(-1)!.request.requestedTier).toBe("medium");
  });
});

describe("POST /v1/messages/count_tokens", () => {
  const path = "/v1/messages/count_tokens";

  it("forwards to an Anthropic account", async () => {
    const response = await send(request(), { path });
    expect(await readJson(response)).toEqual({ input_tokens: 123 });
    const seen = gateway.upstream.requests[0]!;
    expect(seen.path).toBe(path);
    expect(seen.headers["x-api-key"]).toBe(ANTHROPIC_UPSTREAM_KEY);
    expect(ledger()).toHaveLength(0);
  });

  it("tries the next account, then reports that counting is unavailable", async () => {
    gateway.upstream.script(OPUS, anthropicErrorStep(429, "rate_limit_error", "Slow"));
    expect((await send(request(), { path })).status).toBe(200);

    const failing = anthropicErrorStep(500, "api_error", "Broken");
    for (const model of [OPUS, BACKUP, SONNET, "claude-haiku-5-5"]) {
      gateway.upstream.setAlways(model, failing);
    }
    const response = await send(request(), { path });
    expect(response.status).toBe(404);
    expect(await readJson(response)).toMatchObject({ error: { type: "not_found_error" } });
  });

  it("returns a client error unchanged and marks it as the upstream's", async () => {
    gateway.upstream.script(
      OPUS,
      anthropicErrorStep(400, "invalid_request_error", "Invalid `signature` in `thinking` block"),
    );
    const response = await send(request(), { path });
    expect(response.status).toBe(400);
    expect(response.headers.get("x-llmr-upstream-error")).toBe("1");
    expect(await response.text()).toContain("Invalid `signature`");
  });

  it("does not mark an account as failed", async () => {
    gateway.upstream.script(OPUS, anthropicErrorStep(429, "rate_limit_error", "Slow"));
    await send(request(), { path });
    expect(gateway.runtime.quota.snapshot()).toHaveLength(0);
  });
});

describe("edge endpoints", () => {
  const getPlan = (key = CLAUDE_KEY) =>
    fetch(`${gateway.url}/router/edge/plan`, { headers: { authorization: `Bearer ${key}` } });
  const report = (body: unknown, key = CLAUDE_KEY) =>
    fetch(`${gateway.url}/router/edge/report`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const status = async () =>
    readJson(
      await fetch(`${gateway.url}/router/status`, {
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      }),
    );
  const planAccount = (data: { accounts: { id: string }[] }) =>
    data.accounts.find((account) => account.id === "claude-plan") as never as {
      state: string;
      limits: { scope: string; status: string; retryAt?: string; detail?: string }[];
    };

  it("describes what to try for each Claude model", async () => {
    const plan = await readJson(await getPlan());
    expect(plan.version).toBe(1);
    expect(plan.routes.map((route: { match: string }) => route.match)).toEqual([
      "claude-opus-*",
      "claude-sonnet-*",
      "claude-haiku-*",
    ]);
    expect(plan.routes[0]).toEqual({
      match: "claude-opus-*",
      tier: "frontier",
      steps: [
        { kind: "plan" },
        { kind: "gateway", tier: "frontier" },
        { kind: "plan", model: SONNET },
        { kind: "gateway", tier: "medium" },
        { kind: "plan", model: "claude-haiku-5-5" },
        { kind: "gateway", tier: "flash" },
      ],
    });
  });

  it("tries every plan step first when a tier prefers cost", async () => {
    await sendWithConfig(
      CLAUDE_CONFIG.replace(
        "frontier:\n    fallback_tiers: [medium, flash]",
        "frontier:\n    prefer: cost\n    fallback_tiers: [medium]",
      ),
    );
    const plan = await readJson(await getPlan());
    expect(plan.routes[0].steps).toEqual([
      { kind: "plan" },
      { kind: "plan", model: SONNET },
      { kind: "gateway", tier: "frontier" },
      { kind: "gateway", tier: "medium" },
    ]);
  });

  it("leaves out gateway steps for tiers with no usable account", async () => {
    await sendWithConfig(
      CLAUDE_CONFIG.replace(
        "edge: true, allow_accounts: [anthropic-key, backup] }",
        "edge: true, allow_accounts: [backup] }",
      ),
    );
    const plan = await readJson(await getPlan());
    expect(plan.routes[1].steps).toEqual([
      { kind: "plan" },
      { kind: "plan", model: "claude-haiku-5-5" },
    ]);
  });

  it("only serves clients marked as edges", async () => {
    expect((await getPlan(CHAT_KEY)).status).toBe(403);
    expect((await getPlan("llmr_wrong_key_0123456789abcdefghijklmn")).status).toBe(401);
    expect((await report({ edgeVersion: "1", limits: [], usage: {} }, CHAT_KEY)).status).toBe(403);
  });

  it("shows reported plan state, with one warning and one recovery", async () => {
    const resetsAt = Date.now() + 3_600_000;
    const limited = {
      edgeVersion: "0.1.0",
      limits: [{ scope: "*", resetsAt, claim: "five_hour" }],
      usage: { five_hour: 1, seven_day: 0.4 },
    };
    expect((await report(limited)).status).toBe(200);
    await report(limited);

    const data = await status();
    expect(planAccount(data).state).toBe("exhausted");
    expect(planAccount(data).limits[0]).toMatchObject({
      scope: "*",
      detail: "five_hour",
      retryAt: new Date(resetsAt).toISOString(),
    });
    expect(data.edges[0]).toMatchObject({
      client: "claude-code",
      usage: { five_hour: 1, seven_day: 0.4 },
    });
    expect(gateway.events.filter((event) => event.kind === "account_exhausted")).toHaveLength(1);

    await report({ edgeVersion: "0.1.0", limits: [], usage: { five_hour: 0 } });
    expect(planAccount(await status()).state).toBe("ok");
    expect(gateway.events.filter((event) => event.kind === "account_recovered")).toHaveLength(1);
  });

  it("rejects reports with anything unexpected", async () => {
    const base = { edgeVersion: "1", limits: [], usage: {} };
    expect((await report({ ...base, token: "sk-ant-oat01-secret" })).status).toBe(400);
    expect(
      (await report({ ...base, limits: [{ scope: "Bearer sk-ant-oat01-secret" }] })).status,
    ).toBe(400);
    expect((await report({ ...base, usage: { "sk-ant-oat01-secret": 1 } })).status).toBe(400);
  });
});

describe("configuration", () => {
  const env = {
    ADMIN_KEY,
    CHAT_KEY,
    CLAUDE_KEY,
    ANTHROPIC_KEY: "a",
    BACKUP_KEY: "b",
    OPENAI_KEY: "c",
    UPSTREAM_URL: "https://upstream.example/v1",
  };
  const problems = (yaml: string) => {
    try {
      parseConfig(yaml, PRICING, env);
      return [];
    } catch (error) {
      if (error instanceof ConfigError) return error.problems;
      throw error;
    }
  };

  it("accepts the Claude setup and removes /v1 from Anthropic URLs", () => {
    const { config } = parseConfig(CLAUDE_CONFIG, PRICING, env);
    expect(config.accounts.get("anthropic-key")).toMatchObject({
      baseUrl: "https://upstream.example",
      authHeader: "x-api-key",
    });
    expect(config.accounts.get("openai-key")?.baseUrl).toBe("https://upstream.example/v1");
    expect(config.accounts.get("backup")?.authHeader).toBe("bearer");
  });

  it("rejects routing through an edge-only account", () => {
    const yaml = CLAUDE_CONFIG.replace("account: backup, model", "account: claude-plan, model");
    expect(problems(yaml).join()).toContain("only usable by llmr-edge");
  });

  it("rejects an edge-only account with a URL", () => {
    const yaml = CLAUDE_CONFIG.replace(
      "claude-plan: { kind: edge_only,",
      "claude-plan: { kind: edge_only, base_url: https://x.example,",
    );
    expect(problems(yaml).join()).toContain("edge_only");
  });

  it("rejects params on passthrough targets", () => {
    const yaml = CLAUDE_CONFIG.replace(
      "account: backup, model: backup-opus",
      "account: backup, model: backup-opus, params: { temperature: 1 }",
    );
    expect(problems(yaml).join()).toContain("params only apply");
  });

  it("checks the edge section", () => {
    expect(
      problems(CLAUDE_CONFIG.replace("plan_account: claude-plan", "plan_account: backup")).join(),
    ).toContain("must be an edge_only account");
    expect(
      problems(CLAUDE_CONFIG.replace("{ frontier: claude-opus-5-5,", "{ nope: x,")).join(),
    ).toContain("unknown tier nope");
    expect(problems(CLAUDE_CONFIG.slice(0, CLAUDE_CONFIG.indexOf("edge:\n"))).join()).toContain(
      "edge requires an edge section",
    );
  });
});
