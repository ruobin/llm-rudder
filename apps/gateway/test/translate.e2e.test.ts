import { zstdCompressSync } from "node:zlib";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  anthropicErrorEvent,
  anthropicErrorStep,
  anthropicStreamStart,
  anthropicTextEvents,
  anthropicToolStream,
  chatToolStream,
  errorStep,
  responsesEnd,
  responsesFailedEvent,
  responsesStart,
  responsesTextEvents,
  responsesToolStream,
  type FakeStep,
} from "../src/dev/fake-upstream.js";
import type { MemoryPersistence } from "../src/ledger/records.js";
import type { JsonObject } from "../src/types.js";
import {
  ANTHROPIC_UPSTREAM_KEY,
  BACKUP_UPSTREAM_KEY,
  CHAT_KEY,
  CLAUDE_KEY,
  MODELS,
  readJson,
  SCRIPT_KEY,
  startGateway,
  TRANSLATION_CONFIG,
  userMessage,
  type TestGateway,
} from "./helpers.js";

const OPUS = "claude-opus-5-5";
const GPT = "gpt-6.2-astra";
const GEMINI = "gemini-4-hydrogen";

let gateway: TestGateway;

async function restart(yaml: string, models = MODELS) {
  await gateway.close();
  gateway = await startGateway({ yaml, models });
}

beforeEach(async () => {
  gateway = await startGateway({ yaml: TRANSLATION_CONFIG, models: MODELS });
});

afterEach(async () => {
  await gateway.close();
});

const openai = (key = SCRIPT_KEY) =>
  new OpenAI({ apiKey: key, baseURL: `${gateway.url}/v1`, maxRetries: 0 });
const anthropic = () => new Anthropic({ apiKey: CLAUDE_KEY, baseURL: gateway.url, maxRetries: 0 });

const lastRequest = (model: string) => gateway.upstream.requestsFor(model).at(-1)!;

const weatherForChat = {
  type: "function" as const,
  function: {
    name: "weather",
    description: "Get weather",
    parameters: { type: "object", properties: { city: { type: "string" } } },
  },
};
const weatherForClaude = {
  name: "weather",
  description: "Get weather",
  input_schema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object" as const,
    additionalProperties: false,
    properties: { city: { type: "string" } },
  },
};

function postRaw(
  path: string,
  body: unknown,
  key = SCRIPT_KEY,
  headers: Record<string, string> = {},
) {
  return fetch(`${gateway.url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
    body: typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
}

describe("Chat Completions clients on other formats", () => {
  it("streams from an Anthropic account, with caching and usage", async () => {
    const stream = await openai().chat.completions.create({
      model: "claude",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hello" },
      ],
      stream: true,
      stream_options: { include_usage: true },
    });
    let text = "";
    let usage: OpenAI.CompletionUsage | undefined;
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta.content ?? "";
      usage = chunk.usage ?? usage;
    }
    expect(text).toBe(`Hello from ${OPUS}`);
    // 100 input + 500 cache reads + 40 cache writes
    expect(usage).toMatchObject({
      prompt_tokens: 640,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 500 },
    });

    const seen = lastRequest(OPUS);
    expect(seen.path).toBe("/v1/messages");
    expect(seen.headers["x-api-key"]).toBe(ANTHROPIC_UPSTREAM_KEY);
    expect(seen.headers.authorization).toBeUndefined();
    expect(seen.body).toMatchObject({
      system: [{ type: "text", text: "Be brief." }],
      cache_control: { type: "ephemeral" },
      max_tokens: 64_000,
      stream: true,
    });
  });

  it("charges cache reads and writes at their own prices", async () => {
    await openai().chat.completions.create({ model: "claude", messages: userMessage() as never });
    const attempt = (gateway.persistence as MemoryPersistence).ledger.at(-1)!.attempts[0]!;
    expect(attempt).toMatchObject({ inputTokens: 100, cachedTokens: 500, cacheWriteTokens: 40 });
    expect(attempt.costMicroUsd).toBe(1100);
  });

  it("answers without streaming", async () => {
    const reply = await openai().chat.completions.create({
      model: "gpt",
      messages: userMessage() as never,
    });
    expect(reply.choices[0]?.message.content).toBe(`Hello from ${GPT}`);
    expect(reply.usage).toMatchObject({ prompt_tokens: 100, completion_tokens: 20 });
    expect(lastRequest(GPT).path).toBe("/v1/responses");
  });

  it("runs a tool loop on Claude, replaying its thinking", async () => {
    gateway.upstream.script(
      OPUS,
      anthropicToolStream(
        OPUS,
        "toolu_1",
        "weather",
        { city: "Oslo" },
        {
          text: "Need weather",
          signature: "claude-signature",
        },
      ),
    );
    const client = openai();
    const first = await client.chat.completions
      .stream({
        model: "claude",
        messages: [{ role: "user", content: "Weather?" }],
        tools: [weatherForChat],
      })
      .finalChatCompletion();
    const call = first.choices[0]!.message.tool_calls![0]!;
    expect(call).toMatchObject({
      id: "toolu_1",
      function: { name: "weather", arguments: '{"city":"Oslo"}' },
    });
    expect(first.choices[0]!.finish_reason).toBe("tool_calls");

    await client.chat.completions.create({
      model: "claude",
      messages: [
        { role: "user", content: "Weather?" },
        first.choices[0]!.message as never,
        { role: "tool", tool_call_id: call.id, content: "Sunny" },
      ],
      tools: [weatherForChat],
    });
    expect(lastRequest(OPUS).body.messages).toMatchObject([
      { role: "user" },
      {
        role: "assistant",
        content: [
          { type: "thinking", signature: "claude-signature" },
          { type: "tool_use", id: "toolu_1", name: "weather", input: { city: "Oslo" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1" }] },
    ]);
  });

  it("runs a tool loop on GPT, replaying its reasoning", async () => {
    const reasoning = { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "enc-1" };
    gateway.upstream.script(
      GPT,
      responsesToolStream(GPT, "call_1", "weather", { city: "Oslo" }, reasoning),
    );
    const client = openai();
    const first = await client.chat.completions
      .stream({
        model: "gpt",
        messages: [{ role: "user", content: "Weather?" }],
        tools: [weatherForChat],
      })
      .finalChatCompletion();
    expect(first.choices[0]!.message.tool_calls![0]).toMatchObject({ id: "call_1" });
    expect(lastRequest(GPT).body).toMatchObject({
      reasoning: { effort: "high" },
      store: false,
      tools: [{ type: "function", name: "weather" }],
    });

    await client.chat.completions.create({
      model: "gpt",
      messages: [
        { role: "user", content: "Weather?" },
        first.choices[0]!.message as never,
        { role: "tool", tool_call_id: "call_1", content: "Sunny" },
      ],
    });
    expect(lastRequest(GPT).body.input).toMatchObject([
      { role: "user" },
      reasoning,
      { type: "function_call", call_id: "call_1" },
      { type: "function_call_output", call_id: "call_1", output: "Sunny" },
    ]);
  });

  it("does not replay reasoning to another account", async () => {
    gateway.upstream.script(
      OPUS,
      anthropicToolStream(OPUS, "toolu_1", "weather", {}, { text: "t", signature: "claude-sig" }),
    );
    await openai()
      .chat.completions.stream({
        model: "claude",
        messages: [{ role: "user", content: "Weather?" }],
        tools: [weatherForChat],
      })
      .finalChatCompletion();
    const history = [
      { role: "user", content: "Weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "toolu_1", type: "function", function: { name: "weather", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "toolu_1", content: "Sunny" },
    ];
    await openai().chat.completions.create({ model: "relay-claude", messages: history as never });
    expect(JSON.stringify(lastRequest("claude-sonnet-5-5").body)).not.toContain("claude-sig");
  });

  it("uses an explicit cache marker on third-party Anthropic accounts", async () => {
    await openai().chat.completions.create({
      model: "relay-claude",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
      ],
    });
    const seen = lastRequest("claude-sonnet-5-5");
    expect(seen.headers["x-api-key"]).toBe(BACKUP_UPSTREAM_KEY);
    expect(seen.body).not.toHaveProperty("cache_control");
    expect(seen.body.system).toMatchObject([{ cache_control: { type: "ephemeral" } }]);
  });

  it("shows the fallback note in a translated reply", async () => {
    await restart(
      TRANSLATION_CONFIG.replace("claude: { targets:", "claude: { fallback_tiers: [gpt], targets:"),
    );
    gateway.upstream.script(OPUS, anthropicErrorStep(529, "overloaded_error", "Busy"));
    const stream = await openai(CHAT_KEY).chat.completions.create({
      model: "claude",
      messages: userMessage() as never,
      stream: true,
    });
    let text = "";
    for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? "";
    expect(text).toMatch(/^> ⚠️ llm-router: `claude` is unavailable.*\n\nHello from gpt/s);
  });

  it("reports upstream errors in OpenAI's format", async () => {
    gateway.upstream.script(OPUS, anthropicErrorStep(400, "invalid_request_error", "Bad block"));
    await expect(
      openai().chat.completions.create({ model: "claude", messages: userMessage() as never }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("Bad block") });
  });
});

describe("Anthropic clients on other formats", () => {
  it("streams from a Responses account through the SDK", async () => {
    const stream = anthropic().messages.stream({
      model: "gpt",
      max_tokens: 200_000,
      system: [
        { type: "text", text: "x-anthropic-billing-header: cc_version=1;" },
        { type: "text", text: "Be brief." },
      ],
      messages: [{ role: "user", content: "Hello" }],
      metadata: { user_id: "private-user" },
      thinking: { type: "adaptive" },
    } as never);
    const message = await stream.finalMessage();
    expect(message.model).toBe("gpt");
    expect(message.content).toMatchObject([{ type: "text", text: `Hello from ${GPT}` }]);
    expect(message.stop_reason).toBe("end_turn");
    expect(message.usage).toMatchObject({
      input_tokens: 60,
      cache_read_input_tokens: 40,
      output_tokens: 20,
    });

    const seen = lastRequest(GPT);
    const text = JSON.stringify(seen.body);
    expect(text).not.toContain("billing-header");
    expect(text).not.toContain("private-user");
    expect(seen.body).toMatchObject({
      max_output_tokens: 128_000,
      input: [{ role: "developer" }, { role: "user" }],
    });
  });

  it("runs a tool loop on Gemini, keeping its thought signature", async () => {
    const signature = { google: { thought_signature: "gemini-signature" } };
    gateway.upstream.script(
      GEMINI,
      chatToolStream(GEMINI, "call_g", "weather", { city: "Oslo" }, signature),
    );
    const client = anthropic();
    const first = await client.messages
      .stream({
        model: "gemini",
        max_tokens: 100,
        tools: [weatherForClaude],
        messages: [{ role: "user", content: "Weather?" }],
      })
      .finalMessage();
    const toolUse = first.content.find((block) => block.type === "tool_use")!;
    expect(toolUse).toMatchObject({ id: "call_g", name: "weather", input: { city: "Oslo" } });
    expect(first.stop_reason).toBe("tool_use");

    const parameters = (
      lastRequest(GEMINI).body.tools as { function: { parameters: JsonObject } }[]
    )[0]!.function.parameters;
    expect(parameters).toEqual({ type: "object", properties: { city: { type: "string" } } });

    await client.messages.create({
      model: "gemini",
      max_tokens: 100,
      tools: [weatherForClaude],
      messages: [
        { role: "user", content: "Weather?" },
        { role: "assistant", content: first.content as never },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_g", content: "Sunny" }],
        },
      ],
    });
    expect(lastRequest(GEMINI).body.messages).toMatchObject([
      { role: "user" },
      { role: "assistant", tool_calls: [{ id: "call_g", extra_content: signature }] },
      { role: "tool", tool_call_id: "call_g", content: "Sunny" },
    ]);
  });

  it("runs a tool loop on a Chat Completions gateway", async () => {
    gateway.upstream.script(
      "gw-model",
      chatToolStream("gw-model", "call_c", "weather", { city: "Rome" }),
    );
    const message = await anthropic()
      .messages.stream({
        model: "chatgw",
        max_tokens: 100,
        tools: [weatherForClaude],
        messages: [{ role: "user", content: "Weather?" }],
      })
      .finalMessage();
    expect(message.content).toMatchObject([
      { type: "tool_use", id: "call_c", input: { city: "Rome" } },
    ]);
  });

  it("fails over to another format before any output", async () => {
    gateway.upstream.script(OPUS, {
      type: "stream",
      events: [...anthropicStreamStart(OPUS), anthropicErrorEvent("overloaded_error", "Busy")],
    });
    const response = await postRaw(
      "/v1/messages",
      { model: "frontier", max_tokens: 10, stream: true, messages: userMessage() },
      CLAUDE_KEY,
    );
    const text = await response.text();
    expect(response.headers.get("x-llmr-target")).toBe(`frontier/openai-key/${GPT}`);
    expect(response.headers.get("x-llmr-fallback")).toBe("anthropic-key:overloaded");
    expect(text).toContain(`Hello from ${GPT}`.split(" ")[0]);
    expect(text).toContain("message_stop");
  });

  it("reports a failure after translated output has started", async () => {
    gateway.upstream.script(GPT, {
      type: "stream",
      events: [
        ...responsesStart(GPT),
        ...responsesTextEvents("partial").slice(0, 3),
        responsesFailedEvent("server_error", "Broken"),
      ],
    });
    const response = await postRaw(
      "/v1/messages",
      { model: "gpt", max_tokens: 10, stream: true, messages: userMessage() },
      CLAUDE_KEY,
    );
    const text = await response.text();
    expect(text).toContain("partial");
    expect(text).toContain("event: error");
    expect(text).not.toContain("message_stop");
  });

  it("returns upstream errors in Anthropic's format", async () => {
    gateway.upstream.script(
      GPT,
      errorStep(400, "invalid_value", "Bad value", "invalid_request_error"),
    );
    const response = await postRaw(
      "/v1/messages",
      { model: "gpt", max_tokens: 10, messages: userMessage() },
      CLAUDE_KEY,
    );
    expect(response.status).toBe(400);
    // An edge must pass this on, because it is about the request itself.
    expect(response.headers.get("x-llmr-upstream-error")).toBe("1");
    expect(await readJson(response)).toMatchObject({
      type: "error",
      error: { type: "invalid_request_error", message: "Bad value" },
    });
  });

  it("words a context overflow the way Claude Code recognizes", async () => {
    gateway.upstream.script(
      GPT,
      errorStep(
        400,
        "context_length_exceeded",
        "Input exceeds the context window",
        "invalid_request_error",
      ),
    );
    const response = await postRaw(
      "/v1/messages",
      { model: "gpt", max_tokens: 10, messages: userMessage() },
      CLAUDE_KEY,
    );
    expect(response.status).toBe(400);
    expect(((await readJson(response)) as any).error.message).toContain("prompt is too long"); // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  it("sends reasoning settings only to models known to accept them", async () => {
    await postRaw(
      "/v1/messages",
      {
        model: "chatgw",
        max_tokens: 10,
        messages: userMessage(),
        output_config: { effort: "high" },
      },
      CLAUDE_KEY,
    );
    expect(lastRequest("gw-model").body).not.toHaveProperty("reasoning_effort");

    await postRaw(
      "/v1/messages",
      {
        model: "gemini",
        max_tokens: 10,
        messages: userMessage(),
        output_config: { effort: "max" },
      },
      CLAUDE_KEY,
    );
    expect(lastRequest(GEMINI).body.reasoning_effort).toBe("high");
  });

  it("keeps provider-run tools with their provider", async () => {
    const response = await postRaw(
      "/v1/messages",
      {
        model: "gpt",
        max_tokens: 10,
        messages: userMessage(),
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      },
      CLAUDE_KEY,
    );
    expect(response.status).toBe(502);
    expect(gateway.upstream.requests).toHaveLength(0);

    const native = await postRaw(
      "/v1/messages",
      {
        model: "claude",
        max_tokens: 10,
        messages: userMessage(),
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      },
      CLAUDE_KEY,
    );
    expect(native.status).toBe(200);
  });
});

describe("Responses clients", () => {
  const input = [{ role: "user" as const, content: "Hello" }];

  it("passes through to a Responses account, changing only the model", async () => {
    const prefix = '{"tools":[],"n":1.0,"input":"Hi","store":false,"future":{"2":1,"1":2},';
    await postRaw("/v1/responses", `${prefix}"model":"gpt"}`);
    const seen = lastRequest(GPT);
    expect(seen.path).toBe("/v1/responses");
    expect(seen.rawBody.toString()).toBe(`${prefix}"model":"${GPT}"}`);
    expect(seen.headers.authorization).toBe("Bearer upstream-openai-key");
  });

  it("streams through the SDK", async () => {
    const stream = await openai().responses.create({ model: "gpt", input, stream: true });
    let text = "";
    let completed = false;
    for await (const event of stream) {
      if (event.type === "response.output_text.delta") text += event.delta;
      if (event.type === "response.completed") completed = true;
    }
    expect(text).toBe(`Hello from ${GPT}`);
    expect(completed).toBe(true);
  });

  it.each([
    ["claude", OPUS],
    ["chatgw", "gw-model"],
    ["gemini", GEMINI],
  ])("is translated for the %s tier", async (tier, model) => {
    const reply = await openai().responses.stream({ model: tier, input }).finalResponse();
    expect(reply.output_text).toBe(`Hello from ${model}`);
    expect(reply.status).toBe("completed");
    expect(reply.usage?.input_tokens).toBeGreaterThan(0);
  });

  it("answers without streaming when translated", async () => {
    const reply = await openai().responses.create({ model: "claude", input });
    expect(reply.output_text).toBe(`Hello from ${OPUS}`);
  });

  it("runs a tool loop with namespaced tools on Claude", async () => {
    gateway.upstream.script(OPUS, {
      type: "json",
      body: {
        type: "message",
        content: [{ type: "tool_use", id: "toolu_9", name: "agents__close", input: { id: 1 } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const tools = [
      {
        type: "namespace",
        name: "agents",
        description: "Agents",
        tools: [{ type: "function", name: "close", parameters: { type: "object" } }],
      },
      { type: "web_search", external_web_access: false },
    ];
    const reply = (await readJson(
      await postRaw("/v1/responses", { model: "claude", input: "Close it", tools }),
    )) as { output: JsonObject[] };
    expect(reply.output).toMatchObject([
      { type: "function_call", call_id: "toolu_9", name: "close", namespace: "agents" },
    ]);
    expect(lastRequest(OPUS).body.tools).toMatchObject([{ name: "agents__close" }]);

    await postRaw("/v1/responses", {
      model: "claude",
      tools,
      input: [
        { type: "message", role: "user", content: "Close it" },
        {
          type: "function_call",
          call_id: "toolu_9",
          name: "close",
          namespace: "agents",
          arguments: '{"id":1}',
        },
        { type: "function_call_output", call_id: "toolu_9", output: "Closed" },
      ],
    });
    expect(lastRequest(OPUS).body.messages).toMatchObject([
      { role: "user" },
      {
        role: "assistant",
        content: [{ type: "tool_use", name: "agents__close", input: { id: 1 } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9" }] },
    ]);
  });

  it("fails over when the upstream stream fails before output", async () => {
    gateway.upstream.script(GPT, {
      type: "stream",
      events: [...responsesStart(GPT), responsesFailedEvent("server_is_overloaded", "Busy")],
    });
    const response = await postRaw("/v1/responses", {
      model: "frontier",
      input: "Hi",
      stream: true,
    });
    const text = await response.text();
    // Responses targets go first for this client, then Claude takes over.
    expect(response.headers.get("x-llmr-target")).toBe(`frontier/anthropic-key/${OPUS}`);
    expect(text).toContain("response.completed");
    expect(text).not.toContain("response.failed");
  });

  it("sends response.failed when a stream breaks after output", async () => {
    gateway.upstream.script(GPT, {
      type: "stream",
      events: [...responsesStart(GPT), ...responsesTextEvents("partial").slice(0, 3)],
      end: "drop",
    });
    const text = await (
      await postRaw("/v1/responses", { model: "gpt", input: "Hi", stream: true })
    ).text();
    expect(text).toContain("partial");
    expect(text).toContain("event: response.failed");
    expect(text).not.toContain("response.completed");
  });

  it("passes usage through and records it", async () => {
    gateway.upstream.script(GPT, {
      type: "stream",
      events: [...responsesStart(GPT), ...responsesTextEvents("ok"), ...responsesEnd(GPT)],
    });
    await (await postRaw("/v1/responses", { model: "gpt", input: "Hi", stream: true })).text();
    expect((gateway.persistence as MemoryPersistence).ledger.at(-1)!.attempts[0]).toMatchObject({
      inputTokens: 60,
      cachedTokens: 40,
      outputTokens: 20,
    });
  });

  it("uses OpenAI's error format", async () => {
    const unknown = await postRaw("/v1/responses", { model: "no-such-model", input: "Hi" });
    expect(unknown.status).toBe(404);
    expect(await readJson(unknown)).toMatchObject({ error: { code: "model_not_found" } });

    const denied = await postRaw(
      "/v1/responses",
      { model: "gpt", input: "Hi" },
      "llmr_wrong_key_0123456789abcdefghijklmn",
    );
    expect(denied.status).toBe(401);
    expect(await readJson(denied)).toMatchObject({ error: { code: "invalid_api_key" } });

    expect((await postRaw("/v1/responses", { model: "gpt" })).status).toBe(400);
  });

  it("keeps stored conversations on Responses accounts", async () => {
    const body = { input: "Hi", previous_response_id: "resp_1" };
    expect((await postRaw("/v1/responses", { ...body, model: "gpt" })).status).toBe(200);
    expect((await postRaw("/v1/responses", { ...body, model: "claude" })).status).toBe(502);
  });

  it("accepts zstd-compressed bodies", async () => {
    const body = zstdCompressSync(Buffer.from(JSON.stringify({ model: "gpt", input: "Hi" })));
    const response = await postRaw("/v1/responses", body, SCRIPT_KEY, {
      "content-encoding": "zstd",
    });
    expect(response.status).toBe(200);
    expect(lastRequest(GPT).body.input).toBe("Hi");
  });

  it("rejects other encodings", async () => {
    const response = await postRaw("/v1/responses", "x", SCRIPT_KEY, { "content-encoding": "br" });
    expect(response.status).toBe(415);
  });

  it("adds the fallback note to a passthrough stream", async () => {
    await restart(
      TRANSLATION_CONFIG.replace("gpt: { targets:", "gpt: { fallback_tiers: [frontier], targets:"),
    );
    gateway.upstream.script(
      GPT,
      errorStep(429, "insufficient_quota", "No credit", "insufficient_quota"),
    );
    const text = await (
      await postRaw("/v1/responses", { model: "gpt", input: "Hi", stream: true }, CHAT_KEY)
    ).text();
    expect(text).toContain("llm-router: `gpt` is unavailable");
    expect(text.indexOf("llm-router")).toBeLessThan(text.indexOf("Hello"));
  });

  it("serves the Codex model catalog", async () => {
    const response = await fetch(`${gateway.url}/router/codex/models?client_version=0.168.0`, {
      headers: { authorization: `Bearer ${SCRIPT_KEY}` },
    });
    const { models } = (await readJson(response)) as { models: JsonObject[] };
    expect(models.map((model) => model.slug)).toEqual([
      "claude",
      "relay-claude",
      "gpt",
      "chatgw",
      "gemini",
      "frontier",
    ]);
    expect(models.at(-1)).toMatchObject({
      visibility: "list",
      supported_in_api: true,
      shell_type: "shell_command",
      context_window: 922_000,
      base_instructions: expect.stringContaining("coding agent"),
    });
  });
});

describe("choosing among formats", () => {
  const targetFor = async (path: string, body: unknown, key = SCRIPT_KEY) =>
    (await postRaw(path, body, key)).headers.get("x-llmr-target");
  const asked = async () => ({
    messages: await targetFor(
      "/v1/messages",
      { model: "frontier", max_tokens: 5, messages: userMessage() },
      CLAUDE_KEY,
    ),
    responses: await targetFor("/v1/responses", { model: "frontier", input: "Hi" }),
    chat: await targetFor("/v1/chat/completions", { model: "frontier", messages: userMessage() }),
  });

  it("tries each client's own format first", async () => {
    expect(await asked()).toEqual({
      messages: `frontier/anthropic-key/${OPUS}`,
      responses: `frontier/openai-key/${GPT}`,
      chat: `frontier/gemini-key/${GEMINI}`,
    });
  });

  it("follows the listed order when that preference is off", async () => {
    await restart(`${TRANSLATION_CONFIG}\nrouting: { prefer_same_format: false }\n`);
    const first = `frontier/anthropic-key/${OPUS}`;
    expect(await asked()).toEqual({ messages: first, responses: first, chat: first });
  });
});

describe("capability filter", () => {
  const yaml = TRANSLATION_CONFIG.replace(
    "  gemini: { targets:",
    `  mixed:
    targets:
      - { account: gateway-a, model: gpt-6.2-sol }
      - { account: gemini-key, model: no-vision }
      - { account: anthropic-key, model: ${OPUS} }
  gemini: { targets:`,
  );
  const models = `${MODELS}
  - match: "no-vision"
    images: false
`.replace("models:\n", 'models:\n  - match: "tiny"\n    context_window: 10\n');

  beforeEach(async () => {
    await restart(yaml, models);
  });

  it("skips a model that cannot call tools through this API", async () => {
    const reply = await openai()
      .chat.completions.create({
        model: "mixed",
        messages: userMessage() as never,
        tools: [weatherForChat],
      })
      .withResponse();
    expect(reply.response.headers.get("x-llmr-target")).toBe("mixed/gemini-key/no-vision");
  });

  it("uses that model when no tools are involved", async () => {
    const reply = await openai()
      .chat.completions.create({ model: "mixed", messages: userMessage() as never })
      .withResponse();
    expect(reply.response.headers.get("x-llmr-target")).toBe("mixed/gateway-a/gpt-6.2-sol");
  });

  it("skips a model that cannot read images", async () => {
    const reply = await openai()
      .chat.completions.create({
        model: "mixed",
        tools: [weatherForChat],
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "data:image/png;base64,QQ==" } }],
          },
        ],
      })
      .withResponse();
    expect(reply.response.headers.get("x-llmr-target")).toBe(`mixed/anthropic-key/${OPUS}`);
  });

  it("skips a model whose context window is too small", async () => {
    await restart(yaml.replace("model: no-vision", "model: tiny"), models);
    const reply = await openai()
      .chat.completions.create({
        model: "mixed",
        tools: [weatherForChat],
        messages: [{ role: "user", content: "x".repeat(200) }],
      })
      .withResponse();
    expect(reply.response.headers.get("x-llmr-target")).toBe(`mixed/anthropic-key/${OPUS}`);
  });
});

describe("edge plans", () => {
  it("include gateway steps for tiers without an Anthropic account", async () => {
    const response = await fetch(`${gateway.url}/router/edge/plan`, {
      headers: { authorization: `Bearer ${CLAUDE_KEY}` },
    });
    expect(await readJson(response)).toMatchObject({
      routes: [
        { tier: "frontier", steps: [{ kind: "plan" }, { kind: "gateway", tier: "frontier" }] },
      ],
    });
  });
});

describe("a slow first answer", () => {
  it("keeps the connection alive for translated streams", async () => {
    await restart(
      TRANSLATION_CONFIG.replace(
        "keepalive_after_s: 30, keepalive_interval_s: 15",
        "keepalive_after_s: 0.02, keepalive_interval_s: 0.02",
      ),
    );
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    gateway.upstream.script(OPUS, {
      type: "stream",
      events: [...anthropicStreamStart(OPUS), ...anthropicTextEvents("late")],
      pause: { afterEvents: 0, until: released },
    } as FakeStep);
    const response = await postRaw("/v1/chat/completions", {
      model: "claude",
      messages: userMessage(),
      stream: true,
    });
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first.startsWith(": keep-alive")).toBe(true);
    release();
    await reader.cancel();
  });
});
