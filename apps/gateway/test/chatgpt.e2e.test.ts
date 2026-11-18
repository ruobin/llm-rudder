import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { CHATGPT_USAGE_URL } from "@llm-router/shared";
import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialPath, importCredential } from "../src/chatgpt/session.js";
import { FakeChatGptAuth } from "../src/dev/fake-chatgpt.js";
import {
  errorStep,
  responsesEnd,
  responsesFailedEvent,
  responsesStart,
  responsesTextEvents,
  responsesTextStream,
  responsesToolStream,
  type FakeStep,
} from "../src/dev/fake-upstream.js";
import type { JsonObject } from "../src/types.js";
import {
  ADMIN_KEY,
  CHATGPT_CONFIG,
  CLAUDE_KEY,
  MODELS,
  readEvents,
  readJson,
  SCRIPT_KEY,
  startGateway,
  userMessage,
  type TestGateway,
} from "./helpers.js";

const PLAN = "chatgpt-plan";
const GPT = "gpt-6.2-astra";
const SOL = "gpt-6.2-sol";
const BACKUP = "backup-model";
const LIMIT = "subscription_sharing_usage_limit_exceeded";
const UNSUPPORTED_FIELDS = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "previous_response_id",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
];
const WEATHER = {
  type: "function" as const,
  function: {
    name: "get_weather",
    description: "Reads the weather",
    parameters: { type: "object", properties: { city: { type: "string" } } },
  },
};
const CLOCK = {
  type: "function" as const,
  function: { name: "get_time", parameters: { type: "object", properties: {} } },
};

let auth: FakeChatGptAuth;
let stateDir: string;
let gateway: TestGateway;
let time: number;

/** Moves the clock, including past the interval for noticing a new sign-in. */
const advance = (ms: number) => {
  time += ms;
};
const file = () => credentialPath(stateDir, PLAN);
const saved = () => JSON.parse(readFileSync(file(), "utf8")) as JsonObject;
const signIn = (overrides = {}) =>
  importCredential(stateDir, PLAN, auth.credential(time, overrides));
const planRequests = () =>
  gateway.upstream.requests.filter((request) => request.path === "/v1/responses");
const lastPlanBody = () => planRequests().at(-1)!.body;
const quotaState = (scope = "*") =>
  gateway.runtime.quota
    .snapshot()
    .find((entry) => entry.accountId === PLAN && entry.scope === scope)?.state;
const eventsOf = (kind: string) => gateway.events.filter((event) => event.kind === kind);
const openai = () =>
  new OpenAI({ apiKey: SCRIPT_KEY, baseURL: `${gateway.url}/v1`, maxRetries: 0 });

let conversation = 0;

/** Each call is a new conversation, so none of them is pinned to an earlier target. */
async function ask(model = "frontier") {
  conversation += 1;
  return gateway.post(
    { model, messages: userMessage(`Question ${conversation}`) },
    { key: SCRIPT_KEY },
  );
}

async function answer(model = "frontier") {
  const response = await ask(model);
  return {
    status: response.status,
    target: response.headers.get("x-llmr-target"),
    fallback: response.headers.get("x-llmr-fallback"),
    body: await readJson(response),
  };
}

const toolCall = (callId: string, city: string) =>
  responsesToolStream(GPT, callId, "get_weather", { city }, undefined, "tools");

beforeEach(async () => {
  time = Date.parse("2026-11-18T00:00:00Z");
  stateDir = mkdtempSync(join(tmpdir(), "llmr-chatgpt-"));
  auth = await new FakeChatGptAuth().start();
  signIn();
  gateway = await startGateway({
    yaml: CHATGPT_CONFIG,
    models: MODELS,
    now: () => time,
    chatgpt: { authUrl: auth.url, stateDir },
  });
});

afterEach(async () => {
  await gateway.close();
  await auth.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("requests sent to the plan", () => {
  it("follows the plan route's rules for a Chat Completions client", async () => {
    const completion = await openai().chat.completions.create({
      model: "frontier",
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 50,
      user: "someone",
      metadata: { a: "b" },
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Paris"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "Sunny" },
        { role: "system", content: "Answer in French." },
      ],
      tools: [WEATHER],
    });
    expect(completion.choices[0]!.message.content).toBe(`Hello from ${GPT}`);

    const request = planRequests().at(-1)!;
    const { body } = request;
    expect(request.headers.authorization).toBe(`Bearer ${auth.accessToken}`);
    expect(request.headers["x-llmr-hop"]).toBeUndefined();
    expect(body).toMatchObject({ model: GPT, store: false, stream: true });
    expect(Array.isArray(body.input)).toBe(true);
    for (const field of UNSUPPORTED_FIELDS) expect(body).not.toHaveProperty(field);

    const input = body.input as JsonObject[];
    expect(input.some((item) => item.role === "system")).toBe(false);
    expect(input.filter((item) => item.role === "developer")).toHaveLength(2);
    expect(input.find((item) => item.type === "function_call")).toMatchObject({
      name: "get_weather",
      namespace: "tools",
    });
    expect(body.tools).toEqual([
      {
        type: "namespace",
        name: "tools",
        description: expect.any(String),
        tools: [expect.objectContaining({ type: "function", name: "get_weather" })],
      },
    ]);
  });

  it("rewrites a Responses client's request and answers it without streaming", async () => {
    const response = await openai().responses.create({
      model: "frontier",
      instructions: "Be brief.",
      input: "Hi",
      temperature: 0.2,
      max_output_tokens: 20,
      metadata: { a: "b" },
      user: "someone",
      store: true,
      prompt_cache_retention: "24h",
    } as never);
    expect((response as unknown as { output_text: string }).output_text).toBe(`Hello from ${GPT}`);
    const { body } = planRequests().at(-1)!;
    expect(body).toMatchObject({ store: false, stream: true });
    for (const field of UNSUPPORTED_FIELDS) expect(body).not.toHaveProperty(field);
  });

  it("serves a streaming Claude-format client", async () => {
    const client = new Anthropic({ apiKey: CLAUDE_KEY, baseURL: gateway.url, maxRetries: 0 });
    const stream = client.messages.stream({
      model: "claude-opus-5-5",
      max_tokens: 100,
      messages: userMessage(),
    } as never);
    const message = await stream.finalMessage();
    expect(message.content[0]).toMatchObject({ type: "text", text: `Hello from ${GPT}` });
    expect(lastPlanBody()).not.toHaveProperty("max_output_tokens");
  });

  it("returns tool calls without the namespace it added", async () => {
    gateway.upstream.script(GPT, toolCall("call_9", "Oslo"), toolCall("call_10", "Rome"));
    const chat = await openai().chat.completions.create({
      model: "frontier",
      messages: userMessage() as never,
      tools: [WEATHER],
    });
    expect(chat.choices[0]!.finish_reason).toBe("tool_calls");
    expect(chat.choices[0]!.message.tool_calls![0]).toMatchObject({
      id: "call_9",
      function: { name: "get_weather", arguments: '{"city":"Oslo"}' },
    });

    const responses = await openai().responses.create({
      model: "frontier",
      input: "Hi",
      tools: [
        {
          type: "function",
          name: "get_weather",
          parameters: WEATHER.function.parameters,
          strict: false,
        },
      ],
    });
    const call = responses.output.find(
      (item) => item.type === "function_call",
    ) as unknown as JsonObject;
    expect(call).toMatchObject({ name: "get_weather", call_id: "call_10" });
    expect(call).not.toHaveProperty("namespace");
  });

  it("keeps the reasoning summary for a client that did not ask to stream", async () => {
    const event = (type: string, data: JsonObject) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}`;
    gateway.upstream.script(GPT, {
      type: "stream",
      events: [
        ...responsesStart(GPT),
        event("response.reasoning_summary_text.delta", { output_index: 0, delta: "Thinking it " }),
        event("response.reasoning_summary_text.delta", { output_index: 0, delta: "through" }),
        event("response.output_item.done", {
          output_index: 0,
          item: { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "sealed" },
        }),
        ...responsesTextEvents("Done"),
        ...responsesEnd(GPT),
      ],
    });
    const response = await openai().responses.create({
      model: "frontier",
      input: "Hi",
      reasoning: { summary: "auto" },
    });
    const reasoning = response.output.find((item) => item.type === "reasoning");
    expect(reasoning?.summary).toEqual([{ type: "summary_text", text: "Thinking it through" }]);
    expect(JSON.stringify(response.output)).not.toContain("sealed");
  });

  it("offers only the tool a client forces", async () => {
    await openai().chat.completions.create({
      model: "frontier",
      messages: userMessage() as never,
      tools: [WEATHER, CLOCK],
      tool_choice: { type: "function", function: { name: "get_time" } },
    });
    const body = lastPlanBody();
    expect(body.tool_choice).toBe("required");
    const [group] = body.tools as { tools: { name: string }[] }[];
    expect(group!.tools.map((tool) => tool.name)).toEqual(["get_time"]);
  });

  it("keeps web search and leaves out hosted tools the plan cannot run", async () => {
    await openai().responses.create({
      model: "frontier",
      input: "Hi",
      tools: [
        { type: "function", name: "lookup", parameters: {}, strict: false },
        { type: "web_search" },
        { type: "code_interpreter", container: { type: "auto" } },
      ],
    } as never);
    const tools = lastPlanBody().tools as JsonObject[];
    expect(tools.map((tool) => tool.type)).toEqual(["namespace", "web_search"]);
  });

  it.each([
    ["a required hosted tool it cannot run", { tools: [{ type: "image_generation" }] }],
    ["stored conversation state", { previous_response_id: "resp_1" }],
    [
      "an uploaded file",
      {
        input: [{ role: "user", content: [{ type: "input_file", file_id: "file_1" }] }],
      },
    ],
  ])("skips the plan for %s", async (_label, fields) => {
    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${SCRIPT_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: GPT, input: "Hi", ...fields }),
    });
    await response.text();
    expect(
      planRequests().filter((request) => request.headers.authorization?.includes("access")),
    ).toHaveLength(0);
  });
});

describe("responses from the plan", () => {
  it("reads the stream whatever content type it is labelled with", async () => {
    gateway.upstream.script(GPT, {
      ...responsesTextStream(GPT, "Still read"),
      headers: { "content-type": "application/octet-stream" },
    } as FakeStep);
    const response = await gateway.post(
      { model: "frontier", stream: true, messages: userMessage() },
      { key: SCRIPT_KEY },
    );
    expect(response.headers.get("x-llmr-target")).toContain(PLAN);
    expect((await readEvents(response)).content).toBe("Still read");
  });
});

describe("usage limits", () => {
  it("moves on when the plan is out, says where to manage it, and rechecks later", async () => {
    gateway.upstream.script(GPT, errorStep(429, LIMIT, "Limit reached"));
    const first = await answer();
    expect(first.target).toContain("backup");
    expect(first.fallback).toContain(`${PLAN}:quota_exhausted`);
    expect(quotaState()).toMatchObject({ status: "backoff", backoffS: 900 });
    expect(eventsOf("account_exhausted")[0]!.message).toContain(CHATGPT_USAGE_URL);

    // No reset time is known, so the plan is left alone during the backoff.
    const calls = gateway.upstream.requestsFor(GPT).length;
    await answer();
    expect(gateway.upstream.requestsFor(GPT)).toHaveLength(calls);

    // The first recheck finds it still out, so the wait doubles.
    advance(901_000);
    gateway.upstream.script(GPT, errorStep(429, LIMIT, "Limit reached"));
    await answer();
    expect(quotaState()).toMatchObject({ status: "backoff", backoffS: 1800 });

    advance(1_801_000);
    const recovered = await answer();
    expect(recovered.target).toContain(PLAN);
    expect(quotaState()).toBeUndefined();
    expect(eventsOf("account_recovered")).toHaveLength(1);
  });

  it("treats a limit reported in the stream before any output as a normal failover", async () => {
    gateway.upstream.script(GPT, {
      type: "stream",
      events: [...responsesStart(GPT), responsesFailedEvent(LIMIT, "Limit reached")],
    });
    const { target, body } = await answer();
    expect(target).toContain("backup");
    expect(body.choices[0].message.content).toBe(`Hello from ${BACKUP}`);
    expect(quotaState()).toMatchObject({ status: "backoff" });
  });

  it("reports a limit after output started and pauses the plan", async () => {
    gateway.upstream.script(GPT, {
      type: "stream",
      events: [
        ...responsesStart(GPT),
        ...responsesTextEvents("Partial "),
        responsesFailedEvent(LIMIT, "Limit reached"),
      ],
    });
    const response = await gateway.post(
      { model: "frontier", stream: true, messages: userMessage() },
      { key: SCRIPT_KEY },
    );
    const { chunks, content } = await readEvents(response);
    expect(content).toContain("Partial");
    expect(chunks.at(-1)!.error.code).toBe("stream_interrupted");
    expect(quotaState()).toMatchObject({ status: "backoff", detail: LIMIT });
    expect((await answer()).target).toContain("backup");
  });

  it("does not count a stream that ends without response.completed as success", async () => {
    gateway.upstream.script(GPT, {
      type: "stream",
      events: [...responsesStart(GPT), ...responsesTextEvents("Partial")],
    });
    const { target } = await answer();
    expect(target).toContain("backup");
  });

  it("delivers a finished stream to a client that did not ask to stream", async () => {
    gateway.upstream.script(GPT, {
      type: "stream",
      events: [...responsesStart(GPT), ...responsesTextEvents("All of it"), ...responsesEnd(GPT)],
    });
    expect((await answer()).body.choices[0].message.content).toBe("All of it");
  });
});

describe("rejections", () => {
  it("backs off briefly, then longer, while usage cannot be checked", async () => {
    const unavailable = errorStep(503, "subscription_sharing_usage_unavailable", "Try later");
    gateway.upstream.script(GPT, unavailable);
    expect((await answer()).target).toContain("backup");
    expect(quotaState()).toMatchObject({ status: "cooldown", failures: 1 });
    expect(quotaState()!.retryAt).toBe(time + 15_000);
    expect(eventsOf("account_exhausted")).toHaveLength(0);

    advance(16_000);
    gateway.upstream.script(GPT, unavailable);
    await answer();
    expect(quotaState()!.retryAt).toBe(time + 30_000);
    expect(saved().refresh_token).toBe(auth.refreshToken);
  });

  it("pauses when the route answers 503 with only a detail message", async () => {
    gateway.upstream.script(GPT, {
      type: "json",
      status: 503,
      body: { detail: "Direct routing is unavailable" },
    });
    expect((await answer()).target).toContain("backup");
    expect(quotaState()).toMatchObject({ status: "cooldown", detail: "chatgpt_unavailable" });
  });

  it("stops using the plan when admission is refused", async () => {
    gateway.upstream.script(GPT, {
      type: "json",
      status: 403,
      body: { detail: "Not available from this region" },
    });
    expect((await answer()).target).toContain("backup");
    expect(quotaState()).toMatchObject({ status: "disabled", detail: "chatgpt_admission_denied" });
    expect(eventsOf("account_disabled")[0]!.message).toContain("region");
    expect(saved().refresh_token).toBe(auth.refreshToken);
  });

  it("does not suggest signing in again when the account is not eligible", async () => {
    const code = "subscription_sharing_user_not_eligible";
    gateway.upstream.script(GPT, errorStep(403, code, "Not eligible"));
    await answer();
    expect(quotaState()).toMatchObject({ status: "disabled", detail: code });
    expect(eventsOf("account_disabled")[0]!.message).toContain("will not change");
  });

  it("blames only the request for an unsupported capability", async () => {
    gateway.upstream.script(GPT, {
      type: "json",
      status: 400,
      body: {
        error: {
          code: "subscription_sharing_unsupported_capability",
          message: "Not available",
          param: "input[0]",
        },
      },
    });
    expect((await answer()).target).toContain("backup");
    expect(quotaState(`model:${GPT}`)).toBeUndefined();
    expect((await answer()).target).toContain(PLAN);
  });

  it("rests the model when the capability it lacks is the model", async () => {
    gateway.upstream.script(GPT, {
      type: "json",
      status: 400,
      body: {
        error: {
          code: "subscription_sharing_unsupported_capability",
          message: "Not on this plan",
          param: "model",
        },
      },
    });
    await answer();
    expect(quotaState(`model:${GPT}`)).toMatchObject({ status: "cooldown" });
  });
});

describe("the sign-in", () => {
  it("renews a rejected token once and retries", async () => {
    gateway.upstream.script(GPT, errorStep(401, "token_expired", "Expired"));
    const { target } = await answer();
    expect(target).toContain(PLAN);
    expect(auth.refreshes).toHaveLength(1);
    expect(auth.refreshes[0]!.get("grant_type")).toBe("refresh_token");
    expect(auth.refreshes[0]!.get("client_id")).toBe("oaiapp_fake");
    expect(auth.refreshes[0]!.get("resource")).toBe("https://api.openai.com/v1");
    expect(auth.refreshes[0]!.has("scope")).toBe(false);
    expect(planRequests().at(-1)!.headers.authorization).toBe("Bearer access-1");
    expect(saved()).toMatchObject({ access_token: "access-1", refresh_token: "refresh-1" });
  });

  it("stops after one retry when the new token is rejected as well", async () => {
    const rejected = errorStep(401, "subscription_sharing_invalid_user", "Invalid user");
    gateway.upstream.script(GPT, rejected, rejected);
    expect((await answer()).target).toContain("backup");
    expect(auth.refreshes).toHaveLength(1);
    expect(quotaState()).toMatchObject({ status: "disabled" });
  });

  it("refreshes an expired token only once for many simultaneous requests", async () => {
    advance(3_600_000);
    auth.delayMs = 50;
    const results = await Promise.all(Array.from({ length: 8 }, () => answer()));
    expect(results.every((result) => result.target?.includes(PLAN))).toBe(true);
    expect(auth.refreshes).toHaveLength(1);
  });

  it("asks you to sign in again when the refresh token is finished", async () => {
    advance(3_600_000);
    auth.answers.push({ status: 400, body: { error: "refresh_token_expired" } });
    expect((await answer()).target).toContain("backup");

    expect(saved()).not.toHaveProperty("access_token");
    expect(saved()).not.toHaveProperty("refresh_token");
    expect(saved().client_id).toBe("oaiapp_fake");
    expect(quotaState()).toMatchObject({ status: "disabled", detail: "refresh_token_expired" });
    expect(eventsOf("account_disabled")[0]!.message).toContain("llmr-edge chatgpt login --for");

    // The next requests skip the plan without trying it.
    const calls = auth.refreshes.length;
    advance(6000);
    expect((await answer()).target).toContain("backup");
    expect(auth.refreshes).toHaveLength(calls);

    // A new sign-in copied to the VPS is picked up without a restart.
    auth.generation = 5;
    signIn();
    advance(6000);
    expect((await answer()).target).toContain(PLAN);
    expect(quotaState()).toBeUndefined();
    expect(eventsOf("account_recovered")).toHaveLength(1);
  });

  it("keeps the tokens through a temporary refresh failure", async () => {
    advance(3_600_000);
    auth.answers.push({ status: 500, body: { error: "server_error" } });
    expect((await answer()).target).toContain("backup");
    expect(saved().refresh_token).toBe("refresh-0");
    expect(quotaState()).toBeUndefined();
    advance(121_000);
    expect((await answer()).target).toContain(PLAN);
  });

  it("skips the plan quietly when nobody has signed in", async () => {
    rmSync(file());
    advance(6000);
    const { target, fallback } = await answer();
    expect(target).toContain("backup");
    expect(fallback).toBeNull();
    expect(planRequests()).toHaveLength(0);
  });
});

describe("after a restart", () => {
  const restart = async () => {
    const { persistence } = gateway;
    await gateway.close();
    gateway = await startGateway({
      yaml: CHATGPT_CONFIG,
      models: MODELS,
      now: () => time,
      persistence,
      chatgpt: { authUrl: auth.url, stateDir },
    });
  };

  it("tries a stopped account again if it still has tokens", async () => {
    gateway.upstream.script(GPT, {
      type: "json",
      status: 403,
      body: { detail: "Not available from this region" },
    });
    await answer();
    expect(quotaState()).toMatchObject({ status: "disabled" });
    await restart();
    expect(quotaState()).toBeUndefined();
    expect((await answer()).target).toContain(PLAN);
  });

  it("keeps waiting for a sign-in when the tokens are gone", async () => {
    advance(3_600_000);
    auth.answers.push({ status: 400, body: { error: "refresh_token_expired" } });
    await answer();
    await restart();
    expect(quotaState()).toMatchObject({ status: "disabled" });
    expect((await answer()).target).toContain("backup");
  });

  it("does not forget a usage limit", async () => {
    gateway.upstream.script(GPT, errorStep(429, LIMIT, "Limit reached"));
    await answer();
    await restart();
    expect(quotaState()).toMatchObject({ status: "backoff", backoffS: 900 });
    expect((await answer()).target).toContain("backup");
  });
});

describe("the plan's model list", () => {
  it("skips models the plan does not offer and shows the rest without secrets", async () => {
    gateway.upstream.planModels = [
      { slug: SOL, display_name: "Sol", visibility: "list" },
      { slug: "hidden-model", visibility: "hide" },
    ];
    await gateway.runtime.chatgpt.get(PLAN)!.maintain();
    expect(gateway.upstream.requests.at(-1)!.headers.authorization).toBe(
      `Bearer ${auth.accessToken}`,
    );

    expect((await answer()).target).toContain("backup");
    expect((await answer("planonly")).target).toContain(PLAN);

    const response = await fetch(`${gateway.url}/router/status`, {
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    const text = await response.text();
    const status = JSON.parse(text);
    expect(status.chatgpt[0]).toMatchObject({
      account: PLAN,
      state: "ok",
      usingPlan: true,
      manageUsage: CHATGPT_USAGE_URL,
      models: [SOL],
    });
    expect(text).not.toContain(auth.accessToken);
    expect(text).not.toContain(auth.refreshToken);
    expect(text).not.toContain("person@example.com");
  });
});
