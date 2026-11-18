import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, parseConfig } from "../src/config/load.js";
import { errorStep } from "../src/dev/fake-upstream.js";
import { telegramSink } from "../src/notify/notifier.js";
import { fetchBalance } from "../src/upstream/balance.js";
import type { AccountConfig } from "../src/config/load.js";
import {
  ADMIN_KEY,
  BASE_CONFIG,
  CHAT_KEY,
  MODELS,
  PRICING,
  readJson,
  startGateway,
  userMessage,
  type TestGateway,
} from "./helpers.js";

const METRICS_KEY = "llmr_metrics_key_0123456789abcdefghijklmn";
const METRICS_CONFIG = BASE_CONFIG.replace(
  "admin: { key_env: ADMIN_KEY }",
  "admin: { key_env: ADMIN_KEY, metrics_key_env: METRICS_KEY }",
);

let gateway: TestGateway;
const scrape = (key: string | null) =>
  fetch(`${gateway.url}/metrics`, key ? { headers: { authorization: `Bearer ${key}` } } : {});

describe("metrics", () => {
  beforeEach(async () => {
    vi.stubEnv("METRICS_KEY", METRICS_KEY);
    gateway = await startGateway({ yaml: METRICS_CONFIG, models: MODELS });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await gateway.close();
  });

  it("is private, and its own key opens nothing else", async () => {
    expect((await scrape(null)).status).toBe(401);
    expect((await scrape(CHAT_KEY)).status).toBe(401);
    expect((await scrape(ADMIN_KEY)).status).toBe(200);
    expect((await scrape(METRICS_KEY)).status).toBe(200);
    const status = await fetch(`${gateway.url}/router/status`, {
      headers: { authorization: `Bearer ${METRICS_KEY}` },
    });
    expect(status.status).toBe(401);
  });

  it("counts requests, attempts, fallbacks, tokens and latency", async () => {
    gateway.upstream.script("f-one", errorStep(429, "insufficient_quota", "Out"));
    gateway.upstream.script("f-two", errorStep(429, "insufficient_quota", "Out"));
    await (await gateway.post({ model: "frontier", messages: userMessage("private text") })).text();

    const response = await scrape(METRICS_KEY);
    expect(response.headers.get("content-type")).toContain("text/plain; version=0.0.4");
    const text = await response.text();
    expect(text).toContain('llmr_requests_total{client="chat",tier="frontier",outcome="ok"} 1');
    expect(text).toContain(
      'llmr_attempts_total{account="gateway-a",model="f-one",outcome="quota_exhausted"} 1',
    );
    expect(text).toContain('llmr_tier_fallbacks_total{requested="frontier",served="medium"} 1');
    expect(text).toMatch(
      /llmr_tokens_total\{account="gemini-key",model="m-one",kind="output"\} \d+/,
    );
    expect(text).toMatch(/llmr_cost_usd_total\{account="gemini-key"\} [0-9.e-]+/);
    expect(text).toContain(
      'llmr_attempt_duration_seconds_bucket{account="gemini-key",model="m-one",le="+Inf"} 1',
    );
    expect(text).toContain(
      'llmr_target_available{tier="frontier",account="gateway-a",model="f-one"} 0',
    );
    expect(text).toContain(
      'llmr_target_available{tier="medium",account="gemini-key",model="m-one"} 1',
    );
    expect(text).toContain("llmr_active_requests 0");
    expect(text).not.toContain("private text");
    for (const line of text.trim().split("\n")) {
      expect(line).toMatch(/^(# (HELP|TYPE) .+|[a-z_]+(\{.*\})? -?[0-9.e+-]+)$/);
    }
  });
});

describe("Telegram notifications", () => {
  let server: Server;
  let url: string;
  let received: { path: string; body: Record<string, unknown> }[];
  let status: number;

  beforeEach(async () => {
    received = [];
    status = 200;
    server = createServer((req, res) => {
      let text = "";
      req.on("data", (part) => (text += part));
      req.on("end", () => {
        received.push({ path: req.url ?? "", body: JSON.parse(text) });
        res.writeHead(status).end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => server.close());

  const event = { at: 1, kind: "budget_reached" as const, subject: "a", message: "Budget reached" };

  it("sends the message to the chosen chat", async () => {
    await telegramSink("TOKEN", "42", url)(event);
    expect(received).toEqual([
      {
        path: "/botTOKEN/sendMessage",
        body: {
          chat_id: "42",
          text: "llm-rudder: Budget reached",
          disable_web_page_preview: true,
        },
      },
    ]);
  });

  it("reports failure without exposing the bot token", async () => {
    status = 401;
    const failure = await telegramSink("SECRET-TOKEN", "42", url)(event).catch((e: Error) => e);
    expect(String(failure)).not.toContain("SECRET-TOKEN");
    expect(String(failure)).toContain("did not accept");
  });

  const parse = (lines: string, env: Record<string, string> = {}) =>
    parseConfig(BASE_CONFIG.replace("timeouts:", `notifications:\n${lines}\ntimeouts:`), PRICING, {
      ADMIN_KEY,
      CHAT_KEY,
      SCRIPT_KEY: "s".repeat(32),
      LIMITED_KEY: "l".repeat(32),
      UPSTREAM_URL: "http://127.0.0.1:1/v1",
      GATEWAY_KEY: "k",
      OPENAI_KEY: "k",
      GEMINI_KEY: "k",
      ...env,
    });

  it("is configured with both settings or neither", () => {
    const both = "  telegram_bot_token_env: BOT\n  telegram_chat_id_env: CHAT";
    expect(parse(both, { BOT: "b", CHAT: "c" }).config.notifications.telegram).toEqual({
      botToken: "b",
      chatId: "c",
    });
    expect(() => parse("  telegram_bot_token_env: BOT")).toThrow(ConfigError);
  });
});

describe("balance checks", () => {
  let server: Server;
  let answers: Record<string, unknown>;
  let baseUrl: string;

  beforeEach(async () => {
    answers = {};
    server = createServer((req, res) => {
      const answer = answers[req.url ?? ""];
      const authorized = req.headers.authorization === "Bearer upstream-gateway-key";
      res
        .writeHead(answer && authorized ? 200 : 404, { "content-type": "application/json" })
        .end(JSON.stringify(answer ?? {}));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterEach(() => server.close());

  const account = (compatName: string) =>
    ({ id: "a", compatName, baseUrl, apiKey: "upstream-gateway-key" }) as AccountConfig;

  it("reads New API and OpenRouter balances", async () => {
    answers["/v1/dashboard/billing/subscription"] = { hard_limit_usd: 25 };
    answers["/v1/dashboard/billing/usage"] = { total_usage: 1050 };
    answers["/v1/key"] = { data: { limit_remaining: 3.5 } };
    expect(await fetchBalance(account("new_api"))).toBe(14.5);
    expect(await fetchBalance(account("openrouter"))).toBe(3.5);
    expect(await fetchBalance(account("generic"))).toBeNull();
  });

  it("treats a key without a limit as nothing to report", async () => {
    answers["/v1/dashboard/billing/subscription"] = { hard_limit_usd: 100_000_000 };
    answers["/v1/dashboard/billing/usage"] = { total_usage: 5 };
    answers["/v1/key"] = { data: { limit_remaining: null } };
    expect(await fetchBalance(account("new_api"))).toBeNull();
    expect(await fetchBalance(account("openrouter"))).toBeNull();
  });

  it("warns once when a balance is low and shows it in the status", async () => {
    answers["/v1/dashboard/billing/subscription"] = { hard_limit_usd: 10 };
    answers["/v1/dashboard/billing/usage"] = { total_usage: 900 };
    const yaml = BASE_CONFIG.replace(
      "compat: new_api, cost_class: prepaid, trust: self_hosted }",
      "compat: new_api, cost_class: prepaid, trust: self_hosted, balance: { warn_below_usd: 5 } }",
    );
    gateway = await startGateway({ yaml, models: MODELS });
    gateway.runtime.config.accounts.get("gateway-a")!.baseUrl = baseUrl;
    await gateway.runtime.balances.check();
    await gateway.runtime.balances.check();
    await gateway.runtime.notifier.flush();
    const low = gateway.events.filter((item) => item.kind === "balance_low");
    expect(low).toHaveLength(1);
    expect(low[0]!.message).toContain("$1.00 left");
    const status = await readJson(
      await fetch(`${gateway.url}/router/status`, {
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      }),
    );
    const entry = status.accounts.find((item: { id: string }) => item.id === "gateway-a");
    expect(entry.balance).toMatchObject({ usd: 1, warnBelowUsd: 5 });
    expect(
      await (
        await fetch(`${gateway.url}/metrics`, { headers: { authorization: `Bearer ${ADMIN_KEY}` } })
      ).text(),
    ).toContain('llmr_balance_usd{account="gateway-a"} 1');
    await gateway.close();
  });

  it("refuses balance checks on an account that cannot report one", () => {
    const yaml = BASE_CONFIG.replace(
      "compat: openai, cost_class: metered, budget: { daily_usd: 1 } }",
      "compat: openai, cost_class: metered, budget: { daily_usd: 1 }, balance: { warn_below_usd: 5 } }",
    );
    expect(() =>
      parseConfig(yaml, PRICING, {
        ADMIN_KEY,
        CHAT_KEY,
        SCRIPT_KEY: "s".repeat(32),
        LIMITED_KEY: "l".repeat(32),
        UPSTREAM_URL: "http://127.0.0.1:1/v1",
        GATEWAY_KEY: "k",
        OPENAI_KEY: "k",
        GEMINI_KEY: "k",
      }),
    ).toThrow(/balance checks need/);
  });
});
