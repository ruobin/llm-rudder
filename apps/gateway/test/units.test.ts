import { describe, expect, it } from "vitest";
import { generateKey } from "../src/auth/keys.js";
import { BudgetManager } from "../src/billing/budgets.js";
import { costMicroUsd } from "../src/billing/pricing.js";
import { COMPAT_PROFILES } from "../src/config/compat.js";
import { ConfigError, parseConfig, type AccountConfig } from "../src/config/load.js";
import { chunkHasOutput } from "../src/execution/protocols/openai-chat.js";
import { canAddNotice, reasonLabel } from "../src/execution/notice.js";
import { ulid } from "../src/ids.js";
import { deriveSessionKey } from "../src/ingress/session.js";
import { QuotaManager } from "../src/state/quota.js";
import type { Classified, Target } from "../src/types.js";
import {
  classifyEmbeddedError,
  classifyHttpError,
  classifyTransportError,
  parseDurationS,
} from "../src/upstream/classify.js";
import { buildUpstreamBody } from "../src/upstream/request.js";
import { SseDecoder } from "../src/upstream/sse.js";
import { ToolExtrasStore } from "../src/upstream/tool-extras.js";
import { parseUsage } from "../src/upstream/usage.js";
import { ADMIN_KEY, BASE_CONFIG, CHAT_KEY, LIMITED_KEY, PRICING, SCRIPT_KEY } from "./helpers.js";

const encoder = new TextEncoder();
const NOW = Date.parse("2026-11-18T12:00:00Z");
const target: Target = { id: "t/a/m", tier: "t", accountId: "a", model: "m", params: {} };

describe("SSE decoder", () => {
  it("handles events split across chunks and multi-byte characters", () => {
    const decoder = new SseDecoder();
    const bytes = encoder.encode('data: {"text":"é"}\n\ndata: [DONE]\n\n');
    const events = [];
    for (const byte of bytes) events.push(...decoder.push(new Uint8Array([byte])));
    expect(events.map((event) => event.data)).toEqual(['{"text":"é"}', "[DONE]"]);
  });

  it("handles CRLF, comments, named events and several data lines", () => {
    const decoder = new SseDecoder();
    const events = decoder.push(
      encoder.encode(": ping\r\n\r\nevent: note\r\ndata: a\r\ndata: b\r\n\r\n"),
    );
    expect(events[0]).toMatchObject({ isComment: true, data: null });
    expect(events[1]).toMatchObject({ event: "note", data: "a\nb" });
  });

  it("returns a last event with no trailing blank line", () => {
    const decoder = new SseDecoder();
    expect(decoder.push(encoder.encode("data: end"))).toEqual([]);
    expect(decoder.flush()[0]?.data).toBe("end");
  });
});

describe("error classification", () => {
  const json = (error: unknown) => JSON.stringify({ error });

  it.each([
    [
      "OpenAI out of credit",
      429,
      { code: "insufficient_quota", message: "exceeded" },
      "quota_exhausted",
    ],
    ["OpenAI rate limit", 429, { code: "rate_limit_exceeded", message: "slow" }, "rate_limited"],
    [
      "New API user quota",
      403,
      { code: "insufficient_user_quota", message: "x", type: "new_api_error" },
      "quota_exhausted",
    ],
    [
      "New API token quota",
      403,
      { code: "pre_consume_token_quota_failed", message: "x" },
      "quota_exhausted",
    ],
    ["New API no model", 503, { code: "model_not_found", message: "no channel" }, "unsupported"],
    ["New API no channel", 503, { code: "get_channel_failed", message: "x" }, "unsupported"],
    ["New API no key", 500, { code: "channel:no_available_key", message: "x" }, "unsupported"],
    [
      "New API invalid token",
      401,
      { code: "", message: "Invalid token", type: "new_api_error" },
      "auth",
    ],
    ["New API blocked", 400, { code: "sensitive_words_detected", message: "x" }, "refusal"],
    ["Chinese quota message", 403, { message: "用户额度不足" }, "quota_exhausted"],
    ["OpenRouter credits", 402, { code: 402, message: "Insufficient credits" }, "quota_exhausted"],
    ["forbidden", 403, { message: "region not allowed" }, "billing"],
    ["missing model", 404, { message: "not here" }, "unsupported"],
    ["unsupported parameter", 400, { message: "Unknown parameter: foo" }, "unsupported"],
    ["bad request", 400, { message: "messages is malformed" }, "client_error"],
    ["overloaded", 529, { message: "busy" }, "overloaded"],
    ["server error", 500, { message: "oops" }, "upstream_error"],
    ["gateway timeout", 504, { message: "late" }, "timeout"],
  ])("reads %s", (_name, status, error, outcome) => {
    expect(classifyHttpError(status, {}, json(error), NOW).outcome).toBe(outcome);
  });

  it("marks only recoverable failures for another target", () => {
    expect(classifyHttpError(400, {}, json({ message: "bad" }), NOW).retryElsewhere).toBe(false);
    expect(classifyHttpError(500, {}, json({ message: "x" }), NOW).retryElsewhere).toBe(true);
  });

  it("recognizes context overflow only on client errors", () => {
    const message = "This model's maximum context length is 8192 tokens";
    const overflow = classifyHttpError(400, {}, json({ message }), NOW);
    expect(overflow).toMatchObject({
      outcome: "context_overflow",
      code: "context_length_exceeded",
      retryElsewhere: false,
    });
    expect(
      classifyHttpError(
        429,
        {},
        json({ code: "rate_limit_exceeded", message: "too many tokens" }),
        NOW,
      ).outcome,
    ).toBe("rate_limited");
  });

  it("treats Gemini's RESOURCE_EXHAUSTED as a rate limit and reads its delay", () => {
    const body = JSON.stringify([
      {
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: "You exceeded your current quota",
          details: [{ retryDelay: "17s" }],
        },
      },
    ]);
    expect(classifyHttpError(429, {}, body, NOW)).toMatchObject({
      outcome: "rate_limited",
      retryAfterS: 17,
    });
  });

  it("treats OpenRouter's in-flight budget as temporary", () => {
    const error = {
      code: 402,
      message: "budget",
      metadata: { limit_source: "openrouter_in_flight_budget" },
    };
    expect(classifyHttpError(402, { "retry-after": "3" }, json(error), NOW)).toMatchObject({
      outcome: "rate_limited",
      retryAfterS: 3,
    });
  });

  it("uses a stated reset time", () => {
    const resets = "2026-11-18T13:00:00Z";
    const error = {
      code: 403,
      message: "limit",
      metadata: { limit_source: "openrouter_key_limit", resets_at: resets },
    };
    expect(classifyHttpError(403, {}, json(error), NOW)).toMatchObject({
      outcome: "quota_exhausted",
      resetsAt: Date.parse(resets),
    });
  });

  it("reads retry timing from headers", () => {
    const date = new Date(NOW + 30_000).toUTCString();
    expect(classifyHttpError(429, { "retry-after": date }, "{}", NOW).retryAfterS).toBe(30);
    expect(
      classifyHttpError(
        429,
        { "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-tokens": "1m30s" },
        "{}",
        NOW,
      ).retryAfterS,
    ).toBe(90);
    expect(parseDurationS("200ms")).toBe(0.2);
  });

  it("treats non-JSON error pages as upstream failures", () => {
    expect(classifyHttpError(502, {}, "<html></html>", NOW)).toMatchObject({
      outcome: "upstream_error",
      retryElsewhere: true,
    });
    expect(classifyHttpError(401, {}, "<html>denied</html>", NOW).outcome).toBe("auth");
  });

  it("reads errors embedded in successful responses", () => {
    expect(classifyEmbeddedError({ error: { code: 429, message: "slow" } }, NOW).outcome).toBe(
      "rate_limited",
    );
    expect(classifyEmbeddedError({ error: { message: "something failed" } }, NOW)).toMatchObject({
      outcome: "upstream_error",
      retryElsewhere: true,
    });
    expect(
      classifyEmbeddedError({ error: { code: "insufficient_user_quota", message: "x" } }, NOW)
        .outcome,
    ).toBe("quota_exhausted");
  });

  it("separates timeouts from other network errors", () => {
    expect(classifyTransportError({ code: "UND_ERR_HEADERS_TIMEOUT" }).outcome).toBe("timeout");
    expect(classifyTransportError({ code: "ECONNRESET" }).outcome).toBe("upstream_error");
  });
});

describe("quota state", () => {
  function setup() {
    let now = NOW;
    const changes: string[] = [];
    const saved = new Map<string, string>();
    const quota = new QuotaManager(
      () => now,
      {
        saveQuota: (entry) => saved.set(entry.scope, entry.state.status),
        deleteQuota: (_account, scope) => saved.delete(scope),
      },
      (change) => changes.push(change.kind),
    );
    return { quota, changes, saved, advance: (ms: number) => (now += ms) };
  }
  const quotaFailure: Classified = { outcome: "quota_exhausted", retryElsewhere: true };

  it("backs off, allows one probe, and doubles when still exhausted", () => {
    const { quota, advance } = setup();
    quota.recordFailure(target, quotaFailure);
    expect(quota.check(target)).toMatchObject({ available: false, reason: "backoff" });

    advance(15 * 60 * 1000);
    expect(quota.check(target).available).toBe(true);
    expect(quota.tryAdmit(target)).toBe(true);
    expect(quota.tryAdmit(target)).toBe(false);

    quota.recordFailure(target, quotaFailure);
    advance(15 * 60 * 1000);
    expect(quota.check(target).available).toBe(false);
    advance(15 * 60 * 1000);
    expect(quota.check(target).available).toBe(true);
  });

  it("recovers after a successful probe", () => {
    const { quota, changes, saved, advance } = setup();
    quota.recordFailure(target, quotaFailure);
    expect(saved.get("*")).toBe("backoff");
    advance(15 * 60 * 1000);
    quota.tryAdmit(target);
    quota.recordSuccess(target);
    expect(quota.snapshot()).toEqual([]);
    expect(saved.size).toBe(0);
    expect(changes).toEqual(["exhausted", "recovered"]);
  });

  it("uses a known reset time", () => {
    const { quota, advance } = setup();
    quota.recordFailure(target, { ...quotaFailure, resetsAt: NOW + 60_000 });
    expect(quota.check(target)).toMatchObject({ reason: "exhausted", retryAt: NOW + 60_000 });
    advance(60_000);
    expect(quota.check(target).available).toBe(true);
  });

  it("limits cooldowns to one model", () => {
    const { quota } = setup();
    quota.recordFailure(target, {
      outcome: "rate_limited",
      retryElsewhere: true,
      retryAfterS: 9999,
    });
    const [entry] = quota.snapshot();
    expect(entry?.scope).toBe("model:m");
    expect(entry?.state.retryAt).toBe(NOW + 300_000);
    expect(quota.check({ ...target, model: "other" }).available).toBe(true);
  });

  it("grows the wait for repeated rate limits", () => {
    const { quota } = setup();
    const failure: Classified = { outcome: "rate_limited", retryElsewhere: true };
    quota.recordFailure(target, failure);
    expect(quota.snapshot()[0]?.state.retryAt).toBe(NOW + 5000);
    quota.recordFailure(target, failure);
    expect(quota.snapshot()[0]?.state.retryAt).toBe(NOW + 10_000);
  });

  it("disables an account on authentication failure until reset", () => {
    const { quota, changes, advance } = setup();
    quota.recordFailure(target, { outcome: "auth", retryElsewhere: true });
    advance(24 * 3600 * 1000);
    expect(quota.check(target)).toMatchObject({ available: false, reason: "disabled" });
    expect(changes).toEqual(["disabled"]);
    expect(quota.reset("a")).toBe(1);
    expect(quota.check(target).available).toBe(true);
  });

  it("gives up a probe that was never sent", () => {
    const { quota, advance } = setup();
    quota.recordFailure(target, quotaFailure);
    advance(15 * 60 * 1000);
    quota.tryAdmit(target);
    quota.releaseProbe(target);
    expect(quota.tryAdmit(target)).toBe(true);
  });
});

describe("budgets", () => {
  const account = (budget: AccountConfig["budget"], costClass = "metered"): AccountConfig =>
    ({ id: "a", costClass, budget }) as AccountConfig;

  it("counts reservations and actual spend against the limit", () => {
    const budgets = new BudgetManager(new Map([["a", account({ dailyMicroUsd: 100 })]]), () => NOW);
    const hold = budgets.reserve("a", 60);
    expect(hold).not.toBeNull();
    expect(budgets.reserve("a", 60)).toBeNull();
    budgets.settle(hold!, 30);
    expect(budgets.snapshot("a").dayMicroUsd).toBe(30);
    expect(budgets.allows("a", 70)).toBe(true);
    expect(budgets.allows("a", 71)).toBe(false);
  });

  it("releases a reservation when nothing was billed", () => {
    const budgets = new BudgetManager(
      new Map([["a", account({ monthlyMicroUsd: 100 })]]),
      () => NOW,
    );
    budgets.release(budgets.reserve("a", 100)!);
    expect(budgets.allows("a", 100)).toBe(true);
  });

  it("does not limit or charge prepaid accounts", () => {
    const budgets = new BudgetManager(new Map([["a", account(null, "prepaid")]]), () => NOW);
    const hold = budgets.reserve("a", 1_000_000)!;
    budgets.settle(hold, 1_000_000);
    expect(budgets.snapshot("a").dayMicroUsd).toBe(0);
  });

  it("knows when a budget window ends", () => {
    const daily = new BudgetManager(new Map([["a", account({ dailyMicroUsd: 1 })]]), () => NOW);
    expect(daily.resetsAt("a")).toBe(Date.parse("2026-11-19T00:00:00Z"));
    const monthly = new BudgetManager(new Map([["a", account({ monthlyMicroUsd: 1 })]]), () => NOW);
    monthly.settle(monthly.reserve("a", 1)!, 1);
    expect(monthly.resetsAt("a")).toBe(Date.parse("2026-12-01T00:00:00Z"));
  });

  it("prices tokens by category", () => {
    const usage = { inputTokens: 1000, cachedTokens: 1000, outputTokens: 100 };
    expect(costMicroUsd(usage, { input: 2, output: 10, cachedInput: 0.1 })).toBe(3100);
  });
});

describe("configuration", () => {
  const env = {
    ADMIN_KEY,
    CHAT_KEY,
    SCRIPT_KEY,
    LIMITED_KEY,
    UPSTREAM_URL: "http://127.0.0.1:1/v1/",
    GATEWAY_KEY: "g",
    OPENAI_KEY: "o",
    GEMINI_KEY: "m",
  };
  const problems = (yaml: string, overrides: Record<string, string | undefined> = {}) => {
    try {
      parseConfig(yaml, PRICING, { ...env, ...overrides });
      return [];
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return (error as ConfigError).problems;
    }
  };

  it("accepts the base config and normalizes URLs", () => {
    const { config, warnings } = parseConfig(BASE_CONFIG, PRICING, env);
    expect(config.accounts.get("gateway-a")?.baseUrl).toBe("http://127.0.0.1:1/v1");
    expect(warnings.some((w) => w.includes("gemini-key") && w.includes("budget"))).toBe(true);
  });

  it("reports a missing secret by name only", () => {
    const found = problems(BASE_CONFIG, { OPENAI_KEY: undefined });
    expect(found.join()).toContain("OPENAI_KEY is not set");
  });

  it("rejects short and repeated client keys", () => {
    expect(problems(BASE_CONFIG, { CHAT_KEY: "short" }).join()).toContain("at least 32");
    expect(problems(BASE_CONFIG, { CHAT_KEY: SCRIPT_KEY }).join()).toContain("repeats");
  });

  it("rejects secrets written into the file", () => {
    const yaml = BASE_CONFIG.replace("server:", "extra: sk-abcdef0123456789abcdef\nserver:");
    expect(problems(yaml).join()).toContain("looks like a secret");
  });

  it("rejects unknown references", () => {
    expect(problems(BASE_CONFIG.replace("account: gateway-a", "account: nope")).join()).toContain(
      "unknown account nope",
    );
    expect(problems(BASE_CONFIG.replace("[medium, flash]", "[missing]")).join()).toContain(
      "unknown fallback tier",
    );
    expect(problems(BASE_CONFIG.replace("[medium, flash]", "[frontier]")).join()).toContain(
      "cannot fall back to itself",
    );
    expect(problems(BASE_CONFIG.replace("tier: flash", "tier: nope")).join()).toContain(
      "unknown tier",
    );
  });

  it("rejects unknown settings", () => {
    expect(problems(`${BASE_CONFIG}\nsurprise: true\n`).length).toBeGreaterThan(0);
  });
});

describe("upstream request", () => {
  const account = (name: keyof typeof COMPAT_PROFILES) =>
    ({ id: "a", compat: COMPAT_PROFILES[name] }) as AccountConfig;
  const build = (body: object, name: keyof typeof COMPAT_PROFILES, stream = false, params = {}) =>
    buildUpstreamBody(
      body as never,
      { ...target, params },
      account(name),
      stream,
      "client",
      new ToolExtrasStore(),
    );

  it("does not change the client's object", () => {
    const body = { model: "frontier", max_tokens: 5, messages: [] };
    build(body, "openai");
    expect(body).toEqual({ model: "frontier", max_tokens: 5, messages: [] });
  });

  it("maps the output limit for each upstream", () => {
    expect(build({ max_tokens: 5 }, "openai")).toMatchObject({ max_completion_tokens: 5 });
    expect(build({ max_tokens: 5 }, "openai").max_tokens).toBeUndefined();
    expect(build({ max_completion_tokens: 5 }, "gemini")).toMatchObject({ max_tokens: 5 });
    expect(build({ max_tokens: 5 }, "new_api")).toMatchObject({ max_tokens: 5 });
  });

  it("applies target parameters without overriding the client", () => {
    expect(build({}, "openai", false, { reasoning_effort: "high" }).reasoning_effort).toBe("high");
    expect(
      build({ reasoning_effort: "low" }, "openai", false, { reasoning_effort: "high" })
        .reasoning_effort,
    ).toBe("low");
  });

  it("applies Gemini's differences", () => {
    const body = build(
      {
        reasoning_effort: "minimal",
        store: true,
        messages: [{ role: "developer", content: "Be brief" }],
      },
      "gemini",
    );
    expect(body.reasoning_effort).toBe("low");
    expect(body.store).toBeUndefined();
    expect((body.messages as { role: string }[])[0]?.role).toBe("system");
  });

  it("removes stream options from non-stream requests", () => {
    expect(
      build({ stream_options: { include_usage: true } }, "openai").stream_options,
    ).toBeUndefined();
  });
});

describe("small helpers", () => {
  it("recognizes the commit point", () => {
    const withDelta = (delta: object, finish: string | null = null) => ({
      choices: [{ delta, finish_reason: finish }],
    });
    expect(chunkHasOutput(withDelta({ role: "assistant", content: "" }))).toBe(false);
    expect(chunkHasOutput(withDelta({ content: "a" }))).toBe(true);
    expect(chunkHasOutput(withDelta({ tool_calls: [{ id: "1" }] }))).toBe(true);
    expect(chunkHasOutput(withDelta({ reasoning_content: "thinking" }))).toBe(true);
    expect(chunkHasOutput(withDelta({}, "stop"))).toBe(true);
    expect(chunkHasOutput({ choices: [], usage: {} })).toBe(false);
  });

  it("summarizes fallback reasons", () => {
    expect(reasonLabel(["a:quota_exhausted", "b:timeout"])).toBe("quota exhausted");
    expect(reasonLabel(["a:budget"])).toBe("budget reached");
    expect(reasonLabel(["a:cooldown"])).toBe("rate limited");
    expect(reasonLabel(["a:timeout"])).toBe("temporarily unavailable");
  });

  it("decides when a note may be added", () => {
    const ctx = (notice: string, body: object) => ({ client: { notice }, body }) as never;
    expect(canAddNotice(ctx("text", {}))).toBe(true);
    expect(canAddNotice(ctx("none", {}))).toBe(false);
    expect(canAddNotice(ctx("text", { response_format: {} }))).toBe(false);
    expect(canAddNotice(ctx("text", { n: 2 }))).toBe(false);
  });

  it("keeps a session key stable across turns", () => {
    const first = { messages: [{ role: "user", content: "start" }] };
    const later = {
      messages: [
        { role: "user", content: "start" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "more" },
      ],
    };
    expect(deriveSessionKey({}, first, "c")).toBe(deriveSessionKey({}, later, "c"));
    expect(deriveSessionKey({}, first, "c")).not.toBe(deriveSessionKey({}, first, "other"));
    expect(deriveSessionKey({ "x-openwebui-chat-id": "1" }, first, "c")).not.toBe(
      deriveSessionKey({ "x-openwebui-chat-id": "2" }, first, "c"),
    );
  });

  it("tells Responses conversations apart without a session header", () => {
    const key = (body: Record<string, unknown>) => deriveSessionKey({}, body, "c");
    const user = (text: string) => ({ role: "user", content: text });
    expect(key({ input: "First" })).not.toBe(key({ input: "Second" }));
    expect(key({ input: [user("First")] })).not.toBe(key({ input: [user("Second")] }));
    expect(key({ input: [user("First")] })).toBe(
      key({ input: [user("First"), { role: "assistant", content: "Hi" }, user("More")] }),
    );
    expect(key({ instructions: "A", input: "Hi" })).not.toBe(
      key({ instructions: "B", input: "Hi" }),
    );
  });

  it("uses the Messages system prompt to tell conversations apart", () => {
    const messages = [{ role: "user", content: "Hi" }];
    expect(deriveSessionKey({}, { system: "A", messages }, "c")).not.toBe(
      deriveSessionKey({}, { system: "B", messages }, "c"),
    );
  });

  it("normalizes usage", () => {
    expect(
      parseUsage({
        prompt_tokens: 100,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 40 },
      }),
    ).toEqual({ inputTokens: 60, cachedTokens: 40, outputTokens: 10 });
    expect(parseUsage(null)).toBeNull();
  });

  it("creates sortable ids and strong keys", () => {
    expect(ulid(1000) < ulid(2000)).toBe(true);
    expect(ulid()).toHaveLength(26);
    expect(generateKey()).toMatch(/^llmr_[0-9A-Za-z]{43}$/);
  });

  it("expires tool extras", () => {
    let now = NOW;
    const store = new ToolExtrasStore(() => now);
    store.set("c", "1", "value");
    expect(store.get("c", "1")).toBe("value");
    expect(store.get("other", "1")).toBeUndefined();
    now += 7 * 3600 * 1000;
    expect(store.get("c", "1")).toBeUndefined();
  });
});
