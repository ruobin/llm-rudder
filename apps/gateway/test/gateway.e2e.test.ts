import { request as httpRequest } from "node:http";
import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chunk,
  completionBody,
  errorStep,
  FakeUpstream,
  textStream,
  usageChunk,
} from "../src/dev/fake-upstream.js";
import { MemoryPersistence } from "../src/ledger/records.js";
import {
  ADMIN_KEY,
  BASE_CONFIG,
  CHAT_KEY,
  LIMITED_KEY,
  readEvents,
  readJson,
  SCRIPT_KEY,
  startGateway,
  userMessage,
  type TestGateway,
} from "./helpers.js";

const quotaError = errorStep(403, "insufficient_user_quota", "Insufficient quota", "new_api_error");
const openAiQuotaError = errorStep(
  429,
  "insufficient_quota",
  "You exceeded your current quota",
  "insufficient_quota",
);

function exhaustFrontier(gateway: TestGateway): void {
  gateway.upstream.setAlways("f-one", quotaError).setAlways("f-two", openAiQuotaError);
}

describe("gateway", () => {
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startGateway();
  });

  afterEach(async () => {
    await gateway.close();
  });

  describe("authentication and limits", () => {
    it("rejects a missing or wrong key in OpenAI's error format", async () => {
      const missing = await fetch(`${gateway.url}/v1/models`);
      expect(missing.status).toBe(401);
      expect((await readJson(missing)).error.code).toBe("invalid_api_key");

      const wrong = await gateway.post(
        { model: "frontier", messages: userMessage() },
        { key: "x" },
      );
      expect(wrong.status).toBe(401);
      expect(gateway.upstream.requests).toHaveLength(0);
    });

    it("blocks an address after repeated failures", async () => {
      for (let i = 0; i < 10; i += 1) {
        await gateway.post({ model: "frontier", messages: userMessage() }, { key: "bad" });
      }
      const blocked = await gateway.post({ model: "frontier", messages: userMessage() });
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("retry-after")).toBe("60");
    });

    it("accepts x-api-key", async () => {
      const response = await fetch(`${gateway.url}/v1/models`, {
        headers: { "x-api-key": SCRIPT_KEY },
      });
      expect(response.status).toBe(200);
    });

    it("applies a client's request rate limit", async () => {
      const ask = () =>
        gateway.post({ model: "f-one", messages: userMessage() }, { key: LIMITED_KEY });
      expect((await ask()).status).toBe(200);
      expect((await ask()).status).toBe(200);
      const limited = await ask();
      expect(limited.status).toBe(429);
      expect((await readJson(limited)).error.code).toBe("client_rate_limited");
    });

    it("keeps a client to its allowed accounts", async () => {
      gateway.upstream.setAlways("f-one", quotaError);
      const response = await gateway.post(
        { model: "frontier", messages: userMessage() },
        { key: LIMITED_KEY },
      );
      expect(response.status).toBe(429);
      expect(gateway.upstream.requestsFor("f-two")).toHaveLength(0);
    });

    const statusForDeclaredBody = (key: string) =>
      new Promise<number | undefined>((resolve, reject) => {
        // Declares a large body without sending it, so the result does not depend on timing.
        const request = httpRequest(
          `${gateway.url}/v1/chat/completions`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${key}`,
              "content-type": "application/json",
              "content-length": 2 * 1024 * 1024,
            },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode);
            request.destroy(); // the declared body will never be sent
          },
        );
        request.on("error", reject);
        request.flushHeaders();
      });

    it("rejects an oversized body", async () => {
      expect(await statusForDeclaredBody(CHAT_KEY)).toBe(413);
      expect(gateway.upstream.requests).toHaveLength(0);
    });

    it("checks the key before accepting a body", async () => {
      expect(await statusForDeclaredBody("wrong-key")).toBe(401);
    });

    it("refuses a request that looped back", async () => {
      const response = await gateway.post(
        { model: "frontier", messages: userMessage() },
        { headers: { "x-llmr-hop": gateway.runtime.instanceId } },
      );
      expect(response.status).toBe(508);
    });
  });

  describe("basic routes", () => {
    it("lists tiers", async () => {
      const response = await fetch(`${gateway.url}/v1/models`, {
        headers: { authorization: `Bearer ${CHAT_KEY}` },
      });
      const body = await readJson(response);
      expect(body.data.map((model: { id: string }) => model.id)).toEqual([
        "frontier",
        "medium",
        "flash",
      ]);
      expect(body.data[0].context_window).toBe(200000);
    });

    it("reports health", async () => {
      expect((await fetch(`${gateway.url}/healthz`)).status).toBe(200);
      expect((await fetch(`${gateway.url}/readyz`)).status).toBe(200);
      gateway.runtime.draining = true;
      expect((await fetch(`${gateway.url}/readyz`)).status).toBe(503);
    });

    it("returns 404 for an unknown model, listing tiers", async () => {
      const response = await gateway.post({ model: "nope", messages: userMessage() });
      expect(response.status).toBe(404);
      const body = await readJson(response);
      expect(body.error.code).toBe("model_not_found");
      expect(body.error.message).toContain("frontier");
    });

    it("validates the request", async () => {
      const response = await gateway.post({ model: "frontier", messages: [] });
      expect(response.status).toBe(400);
      expect((await readJson(response)).error.param).toBe("messages");
    });
  });

  describe("routing", () => {
    it("sends a tier to its first target with the account's key", async () => {
      const response = await gateway.post({
        model: "frontier",
        messages: userMessage(),
        custom_field: "kept",
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-llmr-target")).toBe("frontier/gateway-a/f-one");
      expect(response.headers.get("x-llmr-served-tier")).toBe("frontier");
      expect((await readJson(response)).choices[0].message.content).toBe("Hello from f-one");

      const [sent] = gateway.upstream.requests;
      expect(sent?.path).toBe("/v1/chat/completions");
      expect(sent?.headers.authorization).toBe("Bearer upstream-gateway-key");
      expect(sent?.body.model).toBe("f-one");
      expect(sent?.body.custom_field).toBe("kept");
    });

    it("resolves aliases, the tier header and exact model names", async () => {
      const alias = await gateway.post({ model: "claude-opus-9", messages: userMessage() });
      expect(alias.headers.get("x-llmr-served-tier")).toBe("frontier");

      const header = await gateway.post(
        { model: "anything", messages: userMessage() },
        { headers: { "x-llmr-tier": "flash" } },
      );
      expect(header.headers.get("x-llmr-target")).toBe("flash/gemini-key/l-one");

      const exact = await gateway.post({ model: "m-one", messages: userMessage() });
      expect(exact.headers.get("x-llmr-target")).toBe("medium/gemini-key/m-one");
      expect(exact.headers.get("x-llmr-requested-tier")).toBeNull();
    });

    it("does not fall back to another tier for an exact model", async () => {
      gateway.upstream.setAlways("m-one", errorStep(500, "boom", "failed"));
      const response = await gateway.post({ model: "m-one", messages: userMessage() });
      expect(response.status).toBe(502);
      expect(gateway.upstream.requestsFor("l-one")).toHaveLength(0);
    });
  });

  describe("failover inside a tier", () => {
    it("moves on after a quota error and remembers it", async () => {
      gateway.upstream.setAlways("f-one", quotaError);
      const first = await gateway.post({ model: "frontier", messages: userMessage() });
      expect(first.status).toBe(200);
      expect(first.headers.get("x-llmr-target")).toBe("frontier/openai-key/f-two");
      expect(first.headers.get("x-llmr-fallback")).toBe("gateway-a:quota_exhausted");
      expect(first.headers.get("x-llmr-tier-fallback")).toBeNull();

      await gateway.post({ model: "frontier", messages: userMessage() });
      expect(gateway.upstream.requestsFor("f-one")).toHaveLength(1);
      expect(gateway.events.map((event) => event.kind)).toContain("account_exhausted");
    });

    it.each([
      ["a rate limit", { type: "json", status: 429, body: { error: { message: "slow down" } } }],
      ["an HTML error page", { type: "text", status: 502, text: "<html>Bad gateway</html>" }],
      [
        "a 200 body containing an error",
        { type: "json", body: { error: { message: "boom", code: 500 } } },
      ],
      ["a response with no choices", { type: "json", body: { id: "x" } }],
    ] as const)("fails over on %s", async (_name, step) => {
      gateway.upstream.script("f-one", step);
      const response = await gateway.post({ model: "frontier", messages: userMessage() });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-llmr-target")).toBe("frontier/openai-key/f-two");
    });

    it("fails over when the upstream cannot be reached", async () => {
      await gateway.close();
      const upstream = await new FakeUpstream().start();
      const unreachable = BASE_CONFIG.replace(
        "gateway-a: { base_url_env: UPSTREAM_URL",
        "gateway-a: { base_url: 'http://127.0.0.1:9'",
      );
      gateway = await startGateway({ yaml: unreachable, upstream });
      const response = await gateway.post({ model: "frontier", messages: userMessage() });
      expect(response.headers.get("x-llmr-target")).toBe("frontier/openai-key/f-two");
      await upstream.stop();
    });
  });

  describe("errors that must not fail over", () => {
    it("returns a client error from the upstream", async () => {
      gateway.upstream.setAlways("f-one", errorStep(400, "invalid_value", "Bad input", "invalid"));
      const response = await gateway.post({ model: "frontier", messages: userMessage() });
      expect(response.status).toBe(400);
      expect((await readJson(response)).error.message).toBe("Bad input");
      expect(gateway.upstream.requestsFor("f-two")).toHaveLength(0);
    });

    it("normalizes context overflow so clients can compact", async () => {
      gateway.upstream.setAlways(
        "f-one",
        errorStep(400, "", "This model's maximum context length is 1000 tokens"),
      );
      const response = await gateway.post({ model: "frontier", messages: userMessage() });
      expect(response.status).toBe(400);
      const { error } = await readJson(response);
      expect(error.code).toBe("context_length_exceeded");
      expect(gateway.upstream.requestsFor("f-two")).toHaveLength(0);
    });

    it("does not look for another model after a refusal", async () => {
      gateway.upstream.setAlways(
        "f-one",
        errorStep(400, "sensitive_words_detected", "Blocked", "new_api_error"),
      );
      const response = await gateway.post({ model: "frontier", messages: userMessage() });
      expect(response.status).toBe(400);
      expect(gateway.upstream.requestsFor("f-two")).toHaveLength(0);
      expect(gateway.upstream.requestsFor("m-one")).toHaveLength(0);
    });
  });

  describe("tier fallback and warnings", () => {
    it("falls back with headers, one note and one notification", async () => {
      exhaustFrontier(gateway);
      const response = await gateway.post({
        model: "frontier",
        stream: true,
        messages: userMessage("first conversation"),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-llmr-requested-tier")).toBe("frontier");
      expect(response.headers.get("x-llmr-served-tier")).toBe("medium");
      expect(response.headers.get("x-llmr-tier-fallback")).toBe("frontier->medium");

      const { content, done } = await readEvents(response);
      expect(done).toBe(true);
      expect(content).toContain("`frontier` is unavailable (quota exhausted)");
      expect(content).toContain("`medium` (m-one)");
      expect(content.endsWith("Hello from m-one")).toBe(true);

      const again = await gateway.post({
        model: "frontier",
        stream: true,
        messages: userMessage("first conversation"),
      });
      expect((await readEvents(again)).content).toBe("Hello from m-one");

      await gateway.runtime.notifier.flush();
      expect(gateway.events.filter((e) => e.kind === "tier_fallback_started")).toHaveLength(1);
      expect(gateway.events.filter((e) => e.kind === "tier_fallback_continuing")).toHaveLength(0);
    });

    it("adds the note once to each conversation", async () => {
      exhaustFrontier(gateway);
      const ask = async (text: string) => {
        const response = await gateway.post({ model: "frontier", messages: userMessage(text) });
        return (await readJson(response)).choices[0].message.content as string;
      };
      expect(await ask("one")).toContain("llm-router");
      expect(await ask("one")).toBe("Hello from m-one");
      expect(await ask("two")).toContain("llm-router");
    });

    it("uses a session header to recognize a conversation", async () => {
      exhaustFrontier(gateway);
      const ask = async (text: string) => {
        const response = await gateway.post(
          { model: "frontier", messages: userMessage(text) },
          { headers: { "x-session-id": "same" } },
        );
        return (await readJson(response)).choices[0].message.content as string;
      };
      expect(await ask("one")).toContain("llm-router");
      expect(await ask("different text")).toBe("Hello from m-one");
    });

    it("keeps scripts and structured output free of notes", async () => {
      exhaustFrontier(gateway);
      const script = await gateway.post(
        { model: "frontier", messages: userMessage() },
        { key: SCRIPT_KEY },
      );
      expect(script.headers.get("x-llmr-tier-fallback")).toBe("frontier->medium");
      expect((await readJson(script)).choices[0].message.content).toBe("Hello from m-one");

      const structured = await gateway.post({
        model: "frontier",
        messages: userMessage(),
        response_format: { type: "json_object" },
      });
      expect((await readJson(structured)).choices[0].message.content).toBe("Hello from m-one");
    });

    it("respects X-LLMR-No-Fallback", async () => {
      exhaustFrontier(gateway);
      const response = await gateway.post(
        { model: "frontier", messages: userMessage() },
        { headers: { "x-llmr-no-fallback": "1" } },
      );
      expect(response.status).toBe(429);
      expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
      expect((await readJson(response)).error.code).toBe("all_targets_exhausted");
      expect(gateway.upstream.requestsFor("m-one")).toHaveLength(0);
    });

    it("continues down the chain to the last tier", async () => {
      exhaustFrontier(gateway);
      gateway.upstream.setAlways("m-one", errorStep(500, "boom", "failed"));
      const response = await gateway.post({ model: "frontier", messages: userMessage() });
      expect(response.headers.get("x-llmr-served-tier")).toBe("flash");
    });

    it("returns 429 with a retry time when every tier is used up", async () => {
      exhaustFrontier(gateway);
      gateway.upstream.setAlways("m-one", quotaError);
      const response = await gateway.post({ model: "frontier", messages: userMessage() });
      expect(response.status).toBe(429);
      expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    });

    it("reports fallbacks in the status endpoint", async () => {
      exhaustFrontier(gateway);
      await gateway.post({ model: "frontier", messages: userMessage() });
      const denied = await fetch(`${gateway.url}/router/status`, {
        headers: { authorization: `Bearer ${CHAT_KEY}` },
      });
      expect(denied.status).toBe(401);

      const status = await fetch(`${gateway.url}/router/status`, {
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      }).then(readJson);
      expect(status.fallbacks[0]).toMatchObject({
        requestedTier: "frontier",
        servedTier: "medium",
      });
      const account = status.accounts.find((a: { id: string }) => a.id === "gateway-a");
      expect(account.state).toBe("backoff");
    });

    it("lets you reset an account", async () => {
      exhaustFrontier(gateway);
      await gateway.post({ model: "frontier", messages: userMessage() });
      gateway.upstream.clear("f-one");
      const reset = await fetch(`${gateway.url}/router/accounts/gateway-a/reset`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(reset.status).toBe(200);
      const response = await gateway.post({ model: "frontier", messages: userMessage() });
      expect(response.headers.get("x-llmr-target")).toBe("frontier/gateway-a/f-one");
      await gateway.runtime.notifier.flush();
      expect(gateway.events.map((event) => event.kind)).toContain("tier_fallback_ended");
    });
  });

  describe("streaming", () => {
    it("works with the official OpenAI SDK", async () => {
      const client = new OpenAI({ baseURL: `${gateway.url}/v1`, apiKey: CHAT_KEY, maxRetries: 0 });
      const stream = await client.chat.completions.create({
        model: "frontier",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      });
      let text = "";
      for await (const part of stream) text += part.choices[0]?.delta.content ?? "";
      expect(text).toBe("Hello from f-one");

      const reply = await client.chat.completions.create({
        model: "medium",
        messages: [{ role: "user", content: "Hello" }],
      });
      expect(reply.choices[0]?.message.content).toBe("Hello from m-one");
    });

    it("streams a tool call through the SDK", async () => {
      gateway.upstream.script("f-one", {
        type: "stream",
        events: [
          chunk("f-one", { role: "assistant", content: null }),
          chunk("f-one", {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "read", arguments: "" },
              },
            ],
          }),
          chunk("f-one", { tool_calls: [{ index: 0, function: { arguments: '{"path":"a"}' } }] }),
          chunk("f-one", {}, "tool_calls"),
          "data: [DONE]",
        ],
      });
      const client = new OpenAI({ baseURL: `${gateway.url}/v1`, apiKey: CHAT_KEY, maxRetries: 0 });
      const stream = client.chat.completions.stream({
        model: "frontier",
        messages: [{ role: "user", content: "Read a" }],
        tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
      });
      const final = await stream.finalChatCompletion();
      const call = final.choices[0]?.message.tool_calls?.[0];
      expect(call?.type === "function" ? call.function.arguments : "").toBe('{"path":"a"}');
      expect(final.choices[0]?.finish_reason).toBe("tool_calls");
    });

    it("always asks the upstream for usage but hides it unless requested", async () => {
      const plain = await gateway.post({
        model: "frontier",
        stream: true,
        messages: userMessage(),
      });
      const events = await readEvents(plain);
      expect(events.chunks.some((item) => item.usage)).toBe(false);
      expect(gateway.upstream.requests[0]?.body.stream_options).toEqual({ include_usage: true });

      const withUsage = await gateway.post({
        model: "frontier",
        stream: true,
        stream_options: { include_usage: true },
        messages: userMessage(),
      });
      const usageEvents = await readEvents(withUsage);
      expect(usageEvents.chunks.at(-1)?.usage.total_tokens).toBe(120);
    });

    it("fails over when an error arrives before any output", async () => {
      gateway.upstream.script("f-one", {
        type: "stream",
        events: [
          chunk("f-one", { role: "assistant" }),
          'data: {"error":{"code":"insufficient_user_quota","message":"Quota","type":"new_api_error"}}',
        ],
      });
      const response = await gateway.post({
        model: "frontier",
        stream: true,
        messages: userMessage(),
      });
      expect(response.headers.get("x-llmr-target")).toBe("frontier/openai-key/f-two");
      expect((await readEvents(response)).content).toBe("Hello from f-two");
    });

    it("fails over when a stream ends with no output", async () => {
      gateway.upstream.script("f-one", { type: "stream", events: ["data: [DONE]"] });
      const response = await gateway.post({
        model: "frontier",
        stream: true,
        messages: userMessage(),
      });
      expect(response.headers.get("x-llmr-target")).toBe("frontier/openai-key/f-two");
    });

    it("accepts a JSON answer to a stream request", async () => {
      gateway.upstream.script("f-one", { type: "json", body: completionBody("f-one", "Whole") });
      const response = await gateway.post({
        model: "frontier",
        stream: true,
        messages: userMessage(),
      });
      const { content, done } = await readEvents(response);
      expect(content).toBe("Whole");
      expect(done).toBe(true);
    });

    it("reports a failure after output instead of splicing another answer", async () => {
      gateway.upstream.script("f-one", {
        type: "stream",
        events: [chunk("f-one", { role: "assistant", content: "Partial" })],
        end: "drop",
      });
      const response = await gateway.post({
        model: "frontier",
        stream: true,
        messages: userMessage(),
      });
      const { chunks, content, done } = await readEvents(response);
      expect(content).toBe("Partial");
      expect(chunks.at(-1)?.error.code).toBe("stream_interrupted");
      expect(done).toBe(true);
      expect(gateway.upstream.requestsFor("f-two")).toHaveLength(0);

      const retry = await gateway.post({ model: "frontier", messages: userMessage() });
      expect(retry.headers.get("x-llmr-target")).toBe("frontier/openai-key/f-two");
    });

    it("reports an error event sent after output", async () => {
      gateway.upstream.script("f-one", {
        type: "stream",
        events: [
          chunk("f-one", { content: "Partial" }),
          'data: {"error":{"code":"upstream_error","message":"lost"}}',
        ],
      });
      const client = new OpenAI({ baseURL: `${gateway.url}/v1`, apiKey: CHAT_KEY, maxRetries: 0 });
      const stream = await client.chat.completions.create({
        model: "frontier",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      });
      await expect(async () => {
        for await (const _part of stream) void _part;
      }).rejects.toThrow(/after output had started/);
    });

    it("aborts the upstream when the client disconnects", async () => {
      gateway.upstream.setAlways("f-one", {
        type: "stream",
        events: Array.from({ length: 100 }, () => chunk("f-one", { content: "x" })),
        delayMs: 20,
      });
      const controller = new AbortController();
      const response = await fetch(`${gateway.url}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${CHAT_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "frontier", stream: true, messages: userMessage() }),
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      await reader.read();
      controller.abort();
      await expect.poll(() => (gateway.persistence as MemoryPersistence).ledger.length).toBe(1);
      const [entry] = (gateway.persistence as MemoryPersistence).ledger;
      expect(entry?.request.outcome).toBe("client_aborted");
    });
  });

  describe("Gemini tool-call signatures", () => {
    const signature = { google: { thought_signature: "signature-1" } };
    const toolCall = {
      id: "call_1",
      type: "function",
      function: { name: "read", arguments: "{}" },
    };

    it("restores a signature the client dropped, and hides it from other providers", async () => {
      gateway.upstream.script("m-one", {
        type: "stream",
        events: [
          chunk("m-one", { role: "assistant" }),
          chunk("m-one", { tool_calls: [{ index: 0, ...toolCall, extra_content: signature }] }),
          chunk("m-one", {}, "tool_calls"),
          usageChunk("m-one"),
          "data: [DONE]",
        ],
      });
      await readEvents(
        await gateway.post({ model: "medium", stream: true, messages: userMessage() }),
      );

      const history = [
        ...userMessage(),
        { role: "assistant", content: null, tool_calls: [toolCall] },
        { role: "tool", tool_call_id: "call_1", content: "result" },
      ];
      await gateway.post({ model: "medium", messages: history });
      const toGemini = gateway.upstream.requestsFor("m-one").at(-1)?.body.messages as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(toGemini[1].tool_calls[0].extra_content).toEqual(signature);

      await gateway.post({
        model: "f-one",
        messages: [
          ...userMessage(),
          {
            role: "assistant",
            content: null,
            tool_calls: [{ ...toolCall, extra_content: signature }],
          },
          { role: "tool", tool_call_id: "call_1", content: "result" },
        ],
      });
      const toOther = gateway.upstream.requestsFor("f-one").at(-1)?.body.messages as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(toOther[1].tool_calls[0].extra_content).toBeUndefined();
    });

    it("uses Google's bypass value for history from another model", async () => {
      await gateway.post({
        model: "medium",
        messages: [
          ...userMessage(),
          { role: "assistant", content: null, tool_calls: [{ ...toolCall, id: "other" }] },
          { role: "tool", tool_call_id: "other", content: "result" },
        ],
      });
      const sent = gateway.upstream.requestsFor("m-one").at(-1)?.body.messages as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(sent[1].tool_calls[0].extra_content.google.thought_signature).toBe(
        "skip_thought_signature_validator",
      );
    });
  });

  describe("ledger", () => {
    it("records attempts, tokens and cost without prompt content", async () => {
      gateway.upstream.setAlways("f-one", quotaError);
      await gateway.post({ model: "frontier", messages: userMessage("very private text") });
      const { ledger } = gateway.persistence as MemoryPersistence;
      expect(ledger).toHaveLength(1);
      const [entry] = ledger;
      expect(entry?.request).toMatchObject({
        clientId: "chat",
        requestedTier: "frontier",
        servedTarget: "frontier/openai-key/f-two",
        outcome: "ok",
        attemptCount: 2,
      });
      expect(entry?.attempts[0]).toMatchObject({
        outcome: "quota_exhausted",
        accountId: "gateway-a",
      });
      expect(entry?.attempts[1]).toMatchObject({
        outcome: "ok",
        inputTokens: 100,
        outputTokens: 20,
        costMicroUsd: 4000,
      });
      expect(JSON.stringify(entry)).not.toContain("very private text");
    });

    it("stores no cost for prepaid accounts but keeps list value", async () => {
      await gateway.post({ model: "frontier", messages: userMessage() });
      const attempt = (gateway.persistence as MemoryPersistence).ledger[0]?.attempts[0];
      expect(attempt?.costMicroUsd).toBeNull();
      expect(attempt?.listMicroUsd).toBe(2000);
    });
  });
});

describe("keep-alives", () => {
  const fastKeepalive = BASE_CONFIG.replace(
    "keepalive_after_s: 30, keepalive_interval_s: 15",
    "keepalive_after_s: 0.05, keepalive_interval_s: 0.05",
  );
  let gateway: TestGateway;

  beforeEach(async () => {
    gateway = await startGateway({ yaml: fastKeepalive });
  });

  afterEach(async () => {
    await gateway.close();
  });

  it("keeps a slow stream open with comments", async () => {
    gateway.upstream.script("f-one", {
      ...textStream("f-one", "Slow"),
      firstDelayMs: 200,
    } as never);
    const response = await gateway.post({
      model: "frontier",
      stream: true,
      messages: userMessage(),
    });
    expect(response.status).toBe(200);
    const { comments, content } = await readEvents(response);
    expect(comments.length).toBeGreaterThan(0);
    expect(comments[0]).toBe(": keep-alive");
    expect(content).toBe("Slow");
  });

  it("reports failure as an event once the stream has started", async () => {
    const slowError = {
      type: "stream",
      events: ['data: {"error":{"code":"boom"}}'],
      firstDelayMs: 150,
    };
    gateway.upstream.setAlways("f-one", slowError as never);
    gateway.upstream.setAlways("f-two", slowError as never);
    gateway.upstream.setAlways("m-one", slowError as never);
    gateway.upstream.setAlways("l-one", slowError as never);
    const response = await gateway.post({
      model: "frontier",
      stream: true,
      messages: userMessage(),
    });
    expect(response.status).toBe(200);
    const { chunks, done } = await readEvents(response);
    expect(chunks.at(-1)?.error.code).toBe("all_targets_failed");
    expect(done).toBe(true);
  });
});

describe("timeouts and recovery", () => {
  it("fails over when the first output takes too long", async () => {
    const yaml = BASE_CONFIG.replace(
      "keepalive_after_s: 30, keepalive_interval_s: 15",
      "keepalive_after_s: 30, keepalive_interval_s: 15, commit_s: 0.1",
    );
    const gateway = await startGateway({ yaml });
    gateway.upstream.script("f-one", { type: "stream", events: [], firstDelayMs: 2000 });
    const response = await gateway.post({
      model: "frontier",
      stream: true,
      messages: userMessage(),
    });
    expect(response.headers.get("x-llmr-target")).toBe("frontier/openai-key/f-two");
    expect(response.headers.get("x-llmr-fallback")).toBe("gateway-a:timeout");
    await readEvents(response);
    await gateway.close();
  });

  it("probes an account after its backoff, then announces recovery", async () => {
    let now = Date.now();
    const gateway = await startGateway({ now: () => now });
    exhaustFrontier(gateway);
    await gateway.post({ model: "frontier", messages: userMessage() });
    expect(gateway.upstream.requestsFor("f-one")).toHaveLength(1);

    now += 10 * 60 * 1000;
    await gateway.post({ model: "frontier", messages: userMessage() });
    expect(gateway.upstream.requestsFor("f-one")).toHaveLength(1);

    now += 6 * 60 * 1000;
    gateway.upstream.clear("f-one");
    const recovered = await gateway.post({ model: "frontier", messages: userMessage() });
    expect(recovered.headers.get("x-llmr-target")).toBe("frontier/gateway-a/f-one");
    await gateway.runtime.notifier.flush();
    const kinds = gateway.events.map((event) => event.kind);
    expect(kinds).toContain("account_recovered");
    expect(kinds).toContain("tier_fallback_ended");
    await gateway.close();
  });
});

describe("budgets and restarts", () => {
  it("skips a metered account at its budget, and remembers across a restart", async () => {
    const persistence = new MemoryPersistence();
    const upstream = await new FakeUpstream().start();
    upstream.setAlways("f-one", quotaError);

    const yaml = BASE_CONFIG.replace("daily_usd: 1", "daily_usd: 0.02");
    let gateway = await startGateway({ yaml, persistence, upstream });
    // Each call costs $0.004, so five calls reach the $0.02 budget.
    const small = { model: "frontier", max_tokens: 10, messages: userMessage("hi") };
    const first = await gateway.post(small);
    expect(first.headers.get("x-llmr-target")).toBe("frontier/openai-key/f-two");
    for (let i = 0; i < 4; i += 1) await gateway.post(small);
    const blocked = await gateway.post(small);
    expect(blocked.headers.get("x-llmr-target")).toBe("medium/gemini-key/m-one");
    expect(blocked.headers.get("x-llmr-fallback")).toContain("openai-key:budget");
    await gateway.runtime.notifier.flush();
    expect(gateway.events.map((event) => event.kind)).toContain("budget_reached");
    await gateway.close();

    const callsBefore = upstream.requestsFor("f-one").length;
    gateway = await startGateway({ yaml, persistence, upstream });
    const afterRestart = await gateway.post(small);
    expect(afterRestart.headers.get("x-llmr-target")).toBe("medium/gemini-key/m-one");
    expect(upstream.requestsFor("f-one")).toHaveLength(callsBefore);
    await gateway.close();
    await upstream.stop();
  });
});
