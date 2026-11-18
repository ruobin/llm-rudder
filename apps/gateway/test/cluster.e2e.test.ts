import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedBackend } from "../src/cluster/backend.js";
import { MemorySharedState } from "../src/cluster/memory-backend.js";
import { RedisBackend } from "../src/cluster/redis-backend.js";
import {
  anthropicToolStream,
  chatToolStream,
  errorStep,
  FakeUpstream,
  textStream,
} from "../src/dev/fake-upstream.js";
import { MemoryPersistence } from "../src/ledger/records.js";
import {
  ADMIN_KEY,
  CHAT_KEY,
  CLAUDE_KEY,
  LIMITED_KEY,
  MODELS,
  PRICING,
  readJson,
  SCRIPT_KEY,
  startGateway,
  userMessage,
  type TestGateway,
} from "./helpers.js";

const CONFIG = `
version: 1
server: { host: 127.0.0.1, port: 0, max_body_mb: 1 }
admin: { key_env: ADMIN_KEY }
clients:
  - { id: chat, key_env: CHAT_KEY, notice: text }
  - { id: script, key_env: SCRIPT_KEY, notice: none, rpm: 3 }
  - { id: limited, key_env: LIMITED_KEY, notice: none, max_concurrent: 1 }
  - { id: claude-code, key_env: CLAUDE_KEY, edge: true }
accounts:
  claude-plan: { kind: edge_only, cost_class: prepaid, trust: first_party }
  paid:
    base_url_env: UPSTREAM_URL
    api_key_env: OPENAI_KEY
    compat: openai
    cost_class: metered
    trust: first_party
    budget: { daily_usd: 0.0001 }
  spare: { base_url_env: UPSTREAM_URL, api_key_env: GATEWAY_KEY, cost_class: prepaid, trust: first_party }
  gemini: { base_url_env: UPSTREAM_URL, api_key_env: GEMINI_KEY, compat: gemini, cost_class: prepaid, trust: first_party }
  claude: { api: anthropic.messages, base_url_env: UPSTREAM_URL, api_key_env: ANTHROPIC_KEY, cost_class: prepaid, trust: first_party }
tiers:
  both:
    targets:
      - { account: spare, model: main-model }
      - { account: gemini, model: other-model }
  solo:
    fallback_tiers: [rest]
    targets: [{ account: spare, model: solo-model }]
  rest:
    targets: [{ account: gemini, model: rest-model }]
  gem:
    targets: [{ account: gemini, model: gem-model }]
  opus:
    targets: [{ account: claude, model: claude-opus-5-5 }]
edge:
  plan_account: claude-plan
  plan_models: { solo: claude-opus-5-5 }
timeouts: { keepalive_after_s: 30, keepalive_interval_s: 15 }
`;

const RELOAD_CONFIG = `
version: 1
admin: { key_env: ADMIN_KEY }
clients: [{ id: chat, key_env: CHAT_KEY }]
accounts:
  spare: { base_url: "http://127.0.0.1:9/v1", api_key_env: GATEWAY_KEY, cost_class: prepaid }
tiers:
  both: { targets: [{ account: spare, model: main-model }] }
`;

const OUT_OF_QUOTA = errorStep(429, "insufficient_quota", "You exceeded your quota.");
const HOUR = 3_600_000;

let clock = Date.parse("2026-11-19T06:00:00Z");
const REDIS_URL = process.env.TEST_REDIS_URL;
const BACKENDS = ["memory", ...(REDIS_URL ? ["redis"] : [])] as const;

let kind: (typeof BACKENDS)[number] = "memory";
let redisPrefix = "";
let shared: MemorySharedState;
let upstream: FakeUpstream;
let persistence: MemoryPersistence;
let gateways: TestGateway[] = [];
let a: TestGateway;
let b: TestGateway;

const connectBackend = (): SharedBackend =>
  kind === "redis" ? new RedisBackend(REDIS_URL!, redisPrefix) : shared.connect();

async function startInstance(yaml = CONFIG, configPath?: string): Promise<TestGateway> {
  const gateway = await startGateway({
    yaml,
    models: MODELS,
    upstream,
    persistence,
    now: () => clock,
    sharedBackend: connectBackend(),
    ...(configPath ? { configPath } : {}),
  });
  gateways.push(gateway);
  return gateway;
}

async function startPair(yaml = CONFIG, configPath?: string): Promise<void> {
  shared = new MemorySharedState(() => clock);
  redisPrefix = `llmr-test:${randomUUID()}:`;
  upstream = await new FakeUpstream().start();
  persistence = new MemoryPersistence();
  a = await startInstance(yaml, configPath);
  b = await startInstance(yaml, configPath);
  await settle();
}

/** Waits for background work and messages to reach every instance. */
async function settle(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await Promise.all(
      gateways.flatMap(({ runtime }) => [runtime.cluster.settled(), runtime.notifier.flush()]),
    );
    // Redis delivers messages over a real connection.
    await new Promise((resolve) => setTimeout(resolve, kind === "redis" ? 8 : 0));
  }
}

const ask = (gateway: TestGateway, model: string, content = "Hello", key = CHAT_KEY) =>
  gateway.post({ model, messages: userMessage(content) }, { key });

async function targetOf(response: Response): Promise<string | null> {
  await response.text();
  return response.headers.get("x-llmr-target");
}

const admin = (gateway: TestGateway, path: string, init: RequestInit = {}) =>
  fetch(`${gateway.url}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${ADMIN_KEY}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
const statusOf = async (gateway: TestGateway) => readJson(await admin(gateway, "/router/status"));
const eventKinds = () => gateways.flatMap(({ events }) => events.map(({ kind }) => kind));
const accountState = async (gateway: TestGateway, id: string) =>
  (await statusOf(gateway)).accounts.find((account: { id: string }) => account.id === id).state;

afterEach(async () => {
  await Promise.all(gateways.map((gateway) => gateway.close()));
  gateways = [];
  await upstream.stop();
  vi.unstubAllEnvs();
});

describe.each(BACKENDS)("with %s as the shared state", (backend) => {
  beforeEach(() => {
    kind = backend;
  });

  describe("instances working together", () => {
    it("know about each other", async () => {
      await startPair();
      const { cluster } = await statusOf(a);
      expect(cluster).toMatchObject({ mode: "shared", connected: true });
      expect(cluster.instances).toHaveLength(2);
      expect(a.runtime.cluster.instanceCount).toBe(2);
    });

    it("recognize a request that looped through any of them", async () => {
      await startPair();
      expect(a.runtime.hopId).toBe(b.runtime.hopId);
      const looped = await b.post(
        { model: "both", messages: userMessage() },
        { headers: { "x-llmr-hop": a.runtime.hopId } },
      );
      expect(looped.status).toBe(508);
    });

    it("all skip an account that one of them found out of quota", async () => {
      await startPair();
      upstream.setAlways("main-model", OUT_OF_QUOTA);

      expect(await targetOf(await ask(a, "both"))).toBe("both/gemini/other-model");
      await settle();
      expect(await accountState(b, "spare")).toBe("backoff");

      const response = await ask(b, "both", "Another conversation");
      expect(await targetOf(response)).toBe("both/gemini/other-model");
      expect(response.headers.get("x-llmr-attempts")).toBe("1");
      expect(upstream.requestsFor("main-model")).toHaveLength(1);
    });

    it("all see an account come back when one resets it", async () => {
      await startPair();
      upstream.script("main-model", OUT_OF_QUOTA);
      await ask(a, "both").then((response) => response.text());
      await settle();

      const reset = await admin(b, "/router/accounts/spare/reset", { method: "POST" });
      expect(reset.status).toBe(200);
      await settle();
      expect(await accountState(a, "spare")).toBe("ok");
      expect(await targetOf(await ask(a, "both", "Next"))).toBe("both/spare/main-model");
    });

    it("let only one of them recheck a paused account", async () => {
      await startPair();
      upstream.script("main-model", OUT_OF_QUOTA);
      await ask(a, "both").then((response) => response.text());
      await settle();
      clock += HOUR;

      const target = a.runtime.config.tiers.get("both")!.targets[0]!;
      expect(a.runtime.quota.tryAdmit(target)).toBe(true);
      await settle();
      expect(b.runtime.quota.tryAdmit(target)).toBe(false);
    });

    it("keep a conversation on its target, whichever instance it reaches", async () => {
      await startPair();
      upstream.script("main-model", errorStep(500, "", "Failed"));
      expect(await targetOf(await ask(a, "both", "Stay here"))).toBe("both/gemini/other-model");
      await settle();

      // The failed model rests for a moment, and then new conversations can use it again.
      clock += 60_000;
      expect(await targetOf(await ask(b, "both", "Stay here"))).toBe("both/gemini/other-model");
      expect(await targetOf(await ask(b, "both", "A new one"))).toBe("both/spare/main-model");
    });

    it("agree on one target when a conversation moves on two at once", async () => {
      await startPair();
      a.runtime.pins.set("chat", "s", "both", "both/spare/main-model", null);
      b.runtime.pins.set("chat", "s", "both", "both/gemini/other-model", null);
      await settle();
      const pinned = a.runtime.pins.get("chat", "s", "both");
      expect(pinned).not.toBeNull();
      expect(b.runtime.pins.get("chat", "s", "both")).toBe(pinned);
    });

    it("give a joining instance the conversations and limits already known", async () => {
      await startPair();
      upstream.script("main-model", OUT_OF_QUOTA);
      await ask(a, "both", "Before").then((response) => response.text());
      await settle();

      const late = await startInstance();
      await settle();
      expect(await accountState(late, "spare")).toBe("backoff");
      expect(await targetOf(await ask(late, "both", "Before"))).toBe("both/gemini/other-model");
    });
  });

  describe("fallback warnings across instances", () => {
    async function startFallback(): Promise<void> {
      await startPair();
      upstream.setAlways("solo-model", OUT_OF_QUOTA);
      await ask(a, "solo", "First").then((response) => response.text());
      await settle();
    }

    it("send each notification once", async () => {
      await startFallback();
      await ask(b, "solo", "Second").then((response) => response.text());
      await settle();
      expect(eventKinds().filter((kind) => kind === "tier_fallback_started")).toHaveLength(1);
      expect(eventKinds().filter((kind) => kind === "account_exhausted")).toHaveLength(1);
    });

    it("show the same events and fallbacks on every instance", async () => {
      await startFallback();
      for (const gateway of [a, b]) {
        const status = await statusOf(gateway);
        expect(status.fallbacks).toMatchObject([{ requestedTier: "solo", servedTier: "rest" }]);
        expect(status.recentEvents.map(({ kind }: { kind: string }) => kind)).toContain(
          "tier_fallback_started",
        );
      }
    });

    it("tell each conversation once, wherever it goes", async () => {
      await startPair();
      upstream.setAlways("solo-model", OUT_OF_QUOTA);
      const content = async (response: Response) =>
        (await readJson(response)).choices[0].message.content as string;

      expect(await content(await ask(a, "solo", "Same"))).toContain("llm-rudder");
      await settle();
      expect(await content(await ask(b, "solo", "Same"))).not.toContain("llm-rudder");
      expect(await content(await ask(b, "solo", "Different"))).toContain("llm-rudder");
    });

    it("end the episode everywhere when the tier recovers", async () => {
      await startFallback();
      upstream.clear("solo-model");
      a.runtime.quota.reset("spare");
      await settle();

      expect(await targetOf(await ask(b, "solo", "Later"))).toBe("solo/spare/solo-model");
      await settle();
      expect((await statusOf(a)).fallbacks).toEqual([]);
      expect(eventKinds().filter((kind) => kind === "tier_fallback_ended")).toHaveLength(1);
    });
  });

  describe("limits across instances", () => {
    it("counts a client's requests per minute together", async () => {
      await startPair();
      expect((await ask(a, "both", "1", SCRIPT_KEY)).status).toBe(200);
      expect((await ask(b, "both", "2", SCRIPT_KEY)).status).toBe(200);
      expect((await ask(a, "both", "3", SCRIPT_KEY)).status).toBe(200);

      const over = await ask(b, "both", "4", SCRIPT_KEY);
      expect(over.status).toBe(429);
      expect((await readJson(over)).error.code).toBe("client_rate_limited");
      expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    });

    it("counts a client's open requests together", async () => {
      await startPair();
      let finish = () => undefined as void;
      const finished = new Promise<void>((resolve) => (finish = resolve));
      upstream.script("main-model", {
        ...textStream("main-model", "Hello there"),
        pause: { afterEvents: 2, until: finished },
      } as never);
      const running = await a.post(
        { model: "both", stream: true, messages: userMessage("Long") },
        { key: LIMITED_KEY },
      );
      expect(running.status).toBe(200);

      const refused = await ask(b, "both", "Short", LIMITED_KEY);
      expect(refused.status).toBe(429);
      expect((await readJson(refused)).error.code).toBe("client_concurrency_limited");

      finish();
      await running.text();
      await settle();
      expect((await ask(b, "both", "Short", LIMITED_KEY)).status).toBe(200);
    });

    it("never lets instances together spend past a budget", async () => {
      await startPair();
      const budgets = [a.runtime.budgets, b.runtime.budgets];
      const holds = await Promise.all(
        Array.from({ length: 10 }, (_, index) => budgets[index % 2]!.acquire("paid", 30)),
      );
      expect(holds.filter(Boolean)).toHaveLength(3);
    });

    it("shares what has been spent", async () => {
      await startPair();
      const hold = await a.runtime.budgets.acquire("paid", 80);
      a.runtime.budgets.settle(hold!, 60);
      await settle();

      expect(b.runtime.budgets.snapshot("paid").dayMicroUsd).toBe(60);
      expect(await b.runtime.budgets.acquire("paid", 50)).toBeNull();
      expect(await b.runtime.budgets.acquire("paid", 40)).not.toBeNull();
    });

    it("gives back what a failed attempt reserved", async () => {
      await startPair();
      const hold = await a.runtime.budgets.acquire("paid", 100);
      expect(await b.runtime.budgets.acquire("paid", 1)).toBeNull();
      a.runtime.budgets.release(hold!);
      await settle();
      expect(await b.runtime.budgets.acquire("paid", 100)).not.toBeNull();
    });
  });

  describe("settings across instances", () => {
    it("accepts a new client key everywhere, and revokes it everywhere", async () => {
      await startPair();
      const created = await admin(a, "/router/clients", {
        method: "POST",
        body: JSON.stringify({ id: "phone" }),
      });
      const { key } = await readJson(created);
      await settle();
      await vi.waitFor(async () => expect((await ask(b, "both", "Hi", key)).status).toBe(200));

      await admin(b, "/router/clients/phone", { method: "DELETE" });
      await settle();
      await vi.waitFor(async () => expect((await ask(a, "both", "Hi", key)).status).toBe(401));
    });

    it("shows what a Claude Code helper reported to any instance", async () => {
      await startPair();
      const reported = await fetch(`${a.url}/router/edge/report`, {
        method: "POST",
        headers: { authorization: `Bearer ${CLAUDE_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({
          edgeVersion: "1.0.0",
          limits: [{ scope: "*", claim: "five_hour" }],
          usage: { five_hour: 1 },
        }),
      });
      expect(reported.status).toBe(200);
      await settle();
      const status = await statusOf(b);
      expect(status.edges).toMatchObject([{ client: "claude-code", edgeVersion: "1.0.0" }]);
      expect(await accountState(b, "claude-plan")).toBe("exhausted");
    });

    it("reloads the config on every instance", async () => {
      const dir = mkdtempSync(join(tmpdir(), "llmr-cluster-"));
      try {
        vi.stubEnv("ADMIN_KEY", ADMIN_KEY);
        vi.stubEnv("CHAT_KEY", CHAT_KEY);
        vi.stubEnv("GATEWAY_KEY", "upstream-gateway-key");
        const path = join(dir, "config.yaml");
        writeFileSync(join(dir, "pricing.yaml"), PRICING);
        writeFileSync(path, RELOAD_CONFIG);
        await startPair(RELOAD_CONFIG, path);

        writeFileSync(
          path,
          readFileSync(path, "utf8").replace(
            "tiers:\n",
            "tiers:\n  added: { targets: [{ account: spare, model: new-model }] }\n",
          ),
        );
        const reloaded = await admin(a, "/router/config/reload", { method: "POST" });
        expect(reloaded.status).toBe(200);
        await settle();
        expect(b.runtime.config.tiers.has("added")).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("tool loops across instances", () => {
    const tools = [
      {
        type: "function",
        function: { name: "weather", parameters: { type: "object", properties: {} } },
      },
    ];
    const asked = { role: "user", content: "Weather?" };
    const followUp = (id: string) => [
      asked,
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id, type: "function", function: { name: "weather", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: id, content: "Sunny" },
    ];
    const lastRequest = (model: string) => upstream.requestsFor(model).at(-1)!;

    it("return reasoning that another instance kept", async () => {
      await startPair();
      upstream.script(
        "claude-opus-5-5",
        anthropicToolStream(
          "claude-opus-5-5",
          "toolu_1",
          "weather",
          {},
          { text: "Need weather", signature: "claude-signature" },
        ),
      );
      const first = await a.post({ model: "opus", stream: true, messages: [asked], tools });
      await first.text();
      await settle();

      expect((await b.post({ model: "opus", messages: followUp("toolu_1"), tools })).status).toBe(
        200,
      );
      expect(lastRequest("claude-opus-5-5").body.messages).toMatchObject([
        { role: "user" },
        { role: "assistant", content: [{ type: "thinking", signature: "claude-signature" }, {}] },
        { role: "user" },
      ]);
    });

    it("return tool-call extras that another instance kept", async () => {
      await startPair();
      const signature = { google: { thought_signature: "gemini-signature" } };
      upstream.script("gem-model", chatToolStream("gem-model", "call_g", "weather", {}, signature));
      const first = await a.post({ model: "gem", stream: true, messages: [asked], tools });
      await first.text();
      await settle();

      expect((await b.post({ model: "gem", messages: followUp("call_g"), tools })).status).toBe(
        200,
      );
      const sent = lastRequest("gem-model").body.messages as {
        tool_calls?: { extra_content?: unknown }[];
      }[];
      expect(sent[1]!.tool_calls![0]!.extra_content).toEqual(signature);
    });
  });
});

describe("when messages between instances are lost", () => {
  beforeEach(async () => {
    kind = "memory";
    await startPair();
    shared.dropMessages = true;
  });

  const catchUp = () => b.runtime.cluster.resync();

  it("still learns of a paused account", async () => {
    upstream.script("main-model", OUT_OF_QUOTA);
    await ask(a, "both").then((response) => response.text());
    await settle();
    expect(await accountState(b, "spare")).toBe("ok");

    await catchUp();
    expect(await accountState(b, "spare")).toBe("backoff");
  });

  it("does not bring back a state that was cleared", async () => {
    shared.dropMessages = false;
    upstream.script("main-model", OUT_OF_QUOTA);
    await ask(a, "both").then((response) => response.text());
    await settle();
    shared.dropMessages = true;

    a.runtime.quota.reset("spare");
    await settle();
    expect(await accountState(b, "spare")).toBe("backoff");

    await catchUp();
    await a.runtime.cluster.resync();
    expect(await accountState(b, "spare")).toBe("ok");
    expect(await accountState(a, "spare")).toBe("ok");
  });

  it("still learns of new client keys", async () => {
    const created = await admin(a, "/router/clients", {
      method: "POST",
      body: JSON.stringify({ id: "tablet" }),
    });
    const { key } = await readJson(created);
    await settle();
    expect((await ask(b, "both", "Hi", key)).status).toBe(401);

    await catchUp();
    await vi.waitFor(async () => expect((await ask(b, "both", "Hi", key)).status).toBe(200));
  });

  it("still learns that a fallback has ended", async () => {
    shared.dropMessages = false;
    upstream.script("solo-model", OUT_OF_QUOTA);
    await ask(a, "solo").then((response) => response.text());
    await settle();
    shared.dropMessages = true;
    expect((await statusOf(b)).fallbacks).toHaveLength(1);

    a.runtime.quota.reset("spare");
    await ask(a, "solo", "Now").then((response) => response.text());
    await settle();
    clock += 60_000;
    await catchUp();
    expect((await statusOf(b)).fallbacks).toEqual([]);
  });
});

describe("when the shared state is lost", () => {
  beforeEach(() => {
    kind = "memory";
  });

  it("keeps serving, with each instance on its own", async () => {
    await startPair();
    shared.setAvailable(false);
    expect((await statusOf(a)).cluster.connected).toBe(false);

    upstream.script("main-model", OUT_OF_QUOTA);
    expect(await targetOf(await ask(a, "both"))).toBe("both/gemini/other-model");
    await settle();
    expect(await accountState(b, "spare")).toBe("ok");
    expect(await targetOf(await ask(b, "both", "Other"))).toBe("both/spare/main-model");
  });

  it("still applies client limits on each instance", async () => {
    await startPair();
    shared.setAvailable(false);
    for (let index = 0; index < 3; index += 1) {
      expect((await ask(a, "both", String(index), SCRIPT_KEY)).status).toBe(200);
    }
    expect((await ask(a, "both", "over", SCRIPT_KEY)).status).toBe(429);
  });

  it("keeps each instance to its share of a budget", async () => {
    await startPair();
    shared.setAvailable(false);

    expect(await a.runtime.budgets.acquire("paid", 60)).toBeNull();
    expect(await a.runtime.budgets.acquire("paid", 50)).not.toBeNull();
    expect(await a.runtime.budgets.acquire("paid", 1)).toBeNull();
  });

  it("catches up when it returns", async () => {
    await startPair();
    shared.setAvailable(false);
    upstream.script("main-model", OUT_OF_QUOTA);
    await ask(a, "both").then((response) => response.text());
    const hold = a.runtime.budgets.reserve("paid", 10);
    a.runtime.budgets.settle(hold!, 10);
    await settle();

    shared.setAvailable(true);
    await settle();
    expect(await accountState(b, "spare")).toBe("backoff");
    expect(b.runtime.budgets.snapshot("paid").dayMicroUsd).toBe(10);
  });

  it("restores spending totals after losing its data", async () => {
    await startPair();
    const hold = await a.runtime.budgets.acquire("paid", 80);
    a.runtime.budgets.settle(hold!, 80);
    await settle();

    shared.setAvailable(false);
    shared.clear();
    shared.setAvailable(true);
    await settle();
    expect(await b.runtime.budgets.acquire("paid", 30)).toBeNull();
    expect(await b.runtime.budgets.acquire("paid", 20)).not.toBeNull();
  });
});

describe("a single gateway", () => {
  it("reports that it runs alone", async () => {
    const gateway = await startGateway();
    upstream = await new FakeUpstream().start();
    gateways.push(gateway);
    expect((await statusOf(gateway)).cluster).toMatchObject({
      mode: "single",
      connected: false,
      instances: [],
    });
  });
});
