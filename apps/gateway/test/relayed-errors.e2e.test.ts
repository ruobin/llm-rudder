import { afterEach, describe, expect, it } from "vitest";
import { errorStep } from "../src/dev/fake-upstream.js";
import { MemoryPersistence } from "../src/ledger/records.js";
import type { Classified, Target } from "../src/types.js";
import { asRelayedFailure, classifyHttpError } from "../src/upstream/classify.js";
import { readJson, startGateway, userMessage, type TestGateway } from "./helpers.js";

const CONFIG = `
version: 1
server: { host: 127.0.0.1, port: 0, max_body_mb: 1 }
admin: { key_env: ADMIN_KEY }
clients:
  - { id: chat, key_env: CHAT_KEY, notice: text }
accounts:
  gateway: { base_url_env: UPSTREAM_URL, api_key_env: GATEWAY_KEY, compat: new_api, cost_class: prepaid }
  direct: { base_url_env: UPSTREAM_URL, api_key_env: OPENAI_KEY, compat: openai, cost_class: prepaid, trust: first_party }
tiers:
  frontier:
    targets:
      - { account: gateway, model: gw-frontier }
      - { account: direct, model: direct-frontier }
  medium:
    targets:
      - { account: gateway, model: gw-medium }
  solo:
    targets:
      - { account: direct, model: direct-solo }
timeouts: { keepalive_after_s: 30, keepalive_interval_s: 15 }
`;

const CHANNEL_AUTH_ERROR = errorStep(401, "", "No token provided", "openai_error");
const OUT_OF_QUOTA = errorStep(
  403,
  "insufficient_user_quota",
  "Insufficient quota",
  "new_api_error",
);

let gateway: TestGateway;
let clock = 1_000_000;

const closeGateway = () => gateway.close();

async function start(yaml = CONFIG): Promise<void> {
  clock = 1_000_000;
  gateway = await startGateway({ yaml, now: () => clock });
}

const ask = (model: string) => gateway.post({ model, messages: userMessage() });
const targetOf = (tier: string, index = 0): Target =>
  gateway.runtime.config.tiers.get(tier)!.targets[index]!;
const availability = (tier: string) => gateway.runtime.quota.check(targetOf(tier));
const keyChecks = () => gateway.upstream.requests.filter(({ path }) => path === "/v1/models");

async function eventKinds(): Promise<string[]> {
  await gateway.runtime.accountChecks.settled();
  await gateway.runtime.notifier.flush();
  return gateway.events.map(({ kind }) => kind);
}

describe("errors relayed by a gateway", () => {
  afterEach(closeGateway);

  it("keeps the gateway in use when one of its channels reports a bad key", async () => {
    await start();
    gateway.upstream.setAlways("gw-frontier", CHANNEL_AUTH_ERROR);

    const first = await ask("frontier");
    expect(first.status).toBe(200);
    expect(first.headers.get("x-llmr-fallback")).toBe("gateway:auth");
    expect((await readJson(first)).model).toBe("direct-frontier");
    expect(await eventKinds()).not.toContain("account_disabled");
    expect(keyChecks()).toHaveLength(1);
    expect(keyChecks()[0]!.headers.authorization).toBe("Bearer upstream-gateway-key");

    const other = await ask("medium");
    expect(other.status).toBe(200);
    expect((await readJson(other)).model).toBe("gw-medium");
  });

  it("stops using the gateway when the gateway itself refuses the key", async () => {
    await start();
    gateway.upstream
      .setAlways("gw-frontier", errorStep(401, "", "Invalid token", "new_api_error"))
      .setPath("/v1/models", errorStep(401, "", "Invalid token", "new_api_error"));

    expect((await ask("frontier")).status).toBe(200);
    expect(await eventKinds()).toContain("account_disabled");
    expect(availability("medium")).toMatchObject({ available: false, reason: "disabled" });
  });

  it("ignores a quota error when the gateway still has balance or no limit", async () => {
    await start();
    gateway.upstream
      .setAlways("gw-frontier", OUT_OF_QUOTA)
      .setPath("/v1/dashboard/billing/subscription", {
        type: "json",
        body: { hard_limit_usd: 100_000_000 },
      })
      .setPath("/v1/dashboard/billing/usage", { type: "json", body: { total_usage: 500 } });

    expect((await ask("frontier")).status).toBe(200);
    expect(await eventKinds()).not.toContain("account_exhausted");
    expect(availability("medium")).toEqual({ available: true });
  });

  it("pauses the gateway when its own balance has run out", async () => {
    await start();
    gateway.upstream
      .setAlways("gw-frontier", OUT_OF_QUOTA)
      .setPath("/v1/dashboard/billing/subscription", { type: "json", body: { hard_limit_usd: 5 } })
      .setPath("/v1/dashboard/billing/usage", { type: "json", body: { total_usage: 500 } });

    expect((await ask("frontier")).status).toBe(200);
    expect(await eventKinds()).toContain("account_exhausted");
    expect(availability("medium")).toMatchObject({ available: false, reason: "backoff" });
  });

  it("pauses the gateway on a billing error when its balance has run out", async () => {
    await start();
    gateway.upstream
      .setAlways("gw-frontier", errorStep(403, "", "Access denied", "new_api_error"))
      .setPath("/v1/dashboard/billing/subscription", { type: "json", body: { hard_limit_usd: 5 } })
      .setPath("/v1/dashboard/billing/usage", { type: "json", body: { total_usage: 500 } });

    expect((await ask("frontier")).status).toBe(200);
    expect(await eventKinds()).toContain("account_exhausted");
    expect(availability("medium")).toMatchObject({ available: false, reason: "backoff" });
  });

  it("treats a refused key as the cause, whatever error the request got", async () => {
    await start();
    gateway.upstream
      .setAlways("gw-frontier", OUT_OF_QUOTA)
      .setPath("/v1/models", errorStep(401, "", "Invalid token", "new_api_error"));

    expect((await ask("frontier")).status).toBe(200);
    expect(await eventKinds()).toContain("account_disabled");
    expect(availability("medium")).toMatchObject({ available: false, reason: "disabled" });
  });

  it("does not trust a key check that fails or says nothing", async () => {
    await start();
    gateway.upstream
      .setAlways("gw-frontier", CHANNEL_AUTH_ERROR)
      .setPath("/v1/models", { type: "text", status: 500, text: "broken" });

    expect((await ask("frontier")).status).toBe(200);
    expect(await eventKinds()).not.toContain("account_disabled");
    expect(availability("medium")).toEqual({ available: true });
  });

  it("checks a key at most once a minute", async () => {
    await start();
    gateway.upstream
      .setAlways("gw-frontier", CHANNEL_AUTH_ERROR)
      .setAlways("gw-medium", CHANNEL_AUTH_ERROR);

    await ask("frontier");
    await ask("medium");
    await gateway.runtime.accountChecks.settled();
    expect(keyChecks()).toHaveLength(1);

    clock += 130_000;
    await ask("medium");
    await gateway.runtime.accountChecks.settled();
    expect(keyChecks()).toHaveLength(2);
  });

  it("rests a model only briefly when a channel does not have it", async () => {
    await start();
    gateway.upstream.setAlways("gw-frontier", errorStep(404, "", "Not on this channel"));

    expect((await ask("frontier")).status).toBe(200);
    const state = availability("frontier");
    expect(state).toMatchObject({ available: false, reason: "cooldown" });
    expect((state as { retryAt: number }).retryAt - clock).toBeLessThanOrEqual(10_000);
    expect(keyChecks()).toHaveLength(0);

    clock += 10_001;
    expect(availability("frontier")).toEqual({ available: true });
  });

  it("still rests a target that keeps failing", async () => {
    await start();
    gateway.upstream.setAlways("gw-medium", CHANNEL_AUTH_ERROR);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await ask("medium");
      // Each pause outlasts the growing cooldown but stays inside the health window.
      clock += 10_000 * 2 ** attempt + 1_000;
    }
    await gateway.runtime.accountChecks.settled();
    const entry = gateway.runtime.quota
      .snapshot()
      .find(({ accountId, scope }) => accountId === "gateway" && scope === "model:gw-medium");
    expect(entry?.state).toMatchObject({ status: "backoff", detail: "circuit_open" });
  });

  it("takes a provider's own errors at face value", async () => {
    await start();
    gateway.upstream.setAlways(
      "direct-solo",
      errorStep(401, "invalid_api_key", "Incorrect API key", "invalid_request_error"),
    );

    expect((await ask("solo")).status).toBeGreaterThanOrEqual(500);
    expect(await eventKinds()).toContain("account_disabled");
    expect(availability("solo")).toMatchObject({ available: false, reason: "disabled" });
    expect(keyChecks()).toHaveLength(0);
  });
});

describe("a stopped account after a restart", () => {
  afterEach(closeGateway);

  const restart = async (persistence: MemoryPersistence) => {
    await gateway.close();
    gateway = await startGateway({ yaml: CONFIG, now: () => clock, persistence });
  };

  it("gets another try, because a restart is how a new key takes effect", async () => {
    const persistence = new MemoryPersistence();
    clock = 1_000_000;
    gateway = await startGateway({ yaml: CONFIG, now: () => clock, persistence });
    gateway.upstream.setAlways("direct-solo", errorStep(401, "", "Invalid key"));
    expect((await ask("solo")).status).toBeGreaterThanOrEqual(400);
    expect(availability("solo")).toMatchObject({ available: false, reason: "disabled" });

    await restart(persistence);
    expect(availability("solo")).toEqual({ available: true });
    expect((await ask("solo")).status).toBe(200);
  });

  it("still waits out a usage limit", async () => {
    const persistence = new MemoryPersistence();
    clock = 1_000_000;
    gateway = await startGateway({ yaml: CONFIG, now: () => clock, persistence });
    gateway.upstream.setAlways("direct-solo", errorStep(429, "insufficient_quota", "No quota"));
    expect((await ask("solo")).status).toBeGreaterThanOrEqual(400);

    await restart(persistence);
    expect(availability("solo")).toMatchObject({ available: false, reason: "backoff" });
  });
});

describe("which accounts relay errors", () => {
  afterEach(closeGateway);

  const ACCOUNTS = `
accounts:
  unnamed: { base_url_env: UPSTREAM_URL, api_key_env: GATEWAY_KEY, cost_class: prepaid }
  own-gateway: { base_url_env: UPSTREAM_URL, api_key_env: GATEWAY_KEY, cost_class: prepaid, trust: self_hosted }
  provider: { base_url_env: UPSTREAM_URL, api_key_env: GATEWAY_KEY, cost_class: prepaid, trust: first_party }
  known: { base_url_env: UPSTREAM_URL, api_key_env: GATEWAY_KEY, compat: openai, cost_class: prepaid }
  router: { base_url_env: UPSTREAM_URL, api_key_env: GATEWAY_KEY, compat: openrouter, cost_class: prepaid }
  new-api: { base_url_env: UPSTREAM_URL, api_key_env: GATEWAY_KEY, compat: new_api, cost_class: prepaid }
  opted-out: { base_url_env: UPSTREAM_URL, api_key_env: GATEWAY_KEY, compat: new_api, compat_overrides: { relays_errors: false }, cost_class: prepaid }
  opted-in: { base_url_env: UPSTREAM_URL, api_key_env: GATEWAY_KEY, compat: openai, compat_overrides: { relays_errors: true }, cost_class: prepaid }
  plan: { kind: chatgpt_plan, cost_class: prepaid }
tiers:
  frontier:
    targets:
      - { account: unnamed, model: a }
`;

  it("assumes it of unnamed services and gateways, but not of known providers", async () => {
    await start(CONFIG.replace(/accounts:[\s\S]*?timeouts:/, `${ACCOUNTS}timeouts:`));
    const relays = Object.fromEntries(
      [...gateway.runtime.config.accounts].map(([id, account]) => [
        id,
        account.compat.relaysErrors,
      ]),
    );
    expect(relays).toEqual({
      unnamed: true,
      "own-gateway": true,
      provider: false,
      known: false,
      router: false,
      "new-api": true,
      "opted-out": false,
      "opted-in": true,
      plan: false,
    });
  });
});

describe("reading a relayed failure", () => {
  const failure = (fields: Partial<Classified>): Classified => ({
    outcome: "upstream_error",
    retryElsewhere: true,
    ...fields,
  });

  it.each(["quota_exhausted", "billing", "auth"] as const)(
    "treats %s as a problem with one route",
    (outcome) => {
      const relayed = asRelayedFailure(
        failure({ outcome, scope: "account", code: "x", resetsAt: 123 }),
      );
      expect(relayed).toEqual({
        outcome: "upstream_error",
        retryElsewhere: true,
        scope: "model",
        code: "x",
      });
    },
  );

  it("leaves failures of one request and ordinary failures alone", () => {
    const oneRequest = failure({ outcome: "unsupported", scope: "request" });
    const limited = failure({ outcome: "rate_limited", scope: "model", retryAfterS: 3 });
    expect(asRelayedFailure(oneRequest)).toBe(oneRequest);
    expect(asRelayedFailure(limited)).toBe(limited);
  });

  it("narrows an account-wide limit to the model", () => {
    expect(asRelayedFailure(failure({ outcome: "rate_limited", scope: "account" }))).toMatchObject({
      outcome: "rate_limited",
      scope: "model",
    });
  });

  it.each([
    ["a protocol the channel lacks", { code: "protocol_not_supported", message: "x" }],
    ["a model outside the token's group", { code: "model_not_in_group", message: "x" }],
    ["a Chinese unsupported message", { message: "模型不支持 chat completions 协议" }],
  ])("sends %s to another target", (_name, error) => {
    expect(classifyHttpError(400, {}, JSON.stringify({ error }), 0)).toMatchObject({
      outcome: "unsupported",
      retryElsewhere: true,
    });
  });
});
