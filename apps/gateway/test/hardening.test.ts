import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  credentialPath,
  importCredential,
  readCredential,
  stateKey,
} from "../src/chatgpt/session.js";
import { FakeChatGptAuth } from "../src/dev/fake-chatgpt.js";
import { errorStep } from "../src/dev/fake-upstream.js";
import { TargetHealth } from "../src/state/health.js";
import { QuotaManager } from "../src/state/quota.js";
import type { Target } from "../src/types.js";
import {
  ADMIN_KEY,
  BASE_CONFIG,
  CHAT_KEY,
  MODELS,
  PRICING,
  readJson,
  SCRIPT_KEY,
  startGateway,
  userMessage,
  type TestGateway,
} from "./helpers.js";

let gateway: TestGateway;
let dir: string;
let time: number;
let counter = 0;

const environment = () => ({
  ADMIN_KEY,
  CHAT_KEY,
  SCRIPT_KEY,
  LIMITED_KEY: "llmr_limited_key_0123456789abcdefghijklm",
  UPSTREAM_URL: gateway.upstream.url,
  GATEWAY_KEY: "upstream-gateway-key",
  OPENAI_KEY: "upstream-openai-key",
  GEMINI_KEY: "upstream-gemini-key",
});

const writeConfig = (yaml: string) => {
  writeFileSync(join(dir, "config.yaml"), yaml);
  writeFileSync(join(dir, "pricing.yaml"), PRICING);
  writeFileSync(join(dir, "models.yaml"), MODELS);
};

const reload = () =>
  fetch(`${gateway.url}/router/config/reload`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_KEY}` },
  });

const ask = async (model = "frontier") => {
  counter += 1;
  const response = await gateway.post({ model, messages: userMessage(`Question ${counter}`) });
  await response.text();
  return response;
};

beforeEach(async () => {
  time = Date.parse("2026-11-18T12:00:00Z");
  dir = mkdtempSync(join(tmpdir(), "llmr-hardening-"));
  gateway = await startGateway({ yaml: BASE_CONFIG, models: MODELS, now: () => time });
  for (const [name, value] of Object.entries(environment())) vi.stubEnv(name, value);
  writeConfig(BASE_CONFIG);
  gateway.runtime.configPath = join(dir, "config.yaml");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await gateway.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("config reload", () => {
  it("uses a changed routing table for new requests", async () => {
    expect((await ask()).headers.get("x-llmr-target")).toContain("f-one");
    writeConfig(
      BASE_CONFIG.replace(
        "{ account: gateway-a, model: f-one }",
        "{ account: gateway-a, model: f-new }",
      ),
    );
    const response = await reload();
    expect(await readJson(response)).toMatchObject({ reloaded: true, restartNeeded: [] });
    expect((await ask()).headers.get("x-llmr-target")).toContain("f-new");
  });

  it("keeps running on the old config when the new one is bad", async () => {
    writeConfig(
      BASE_CONFIG.replace(
        "tiers:",
        "tiers:\n  broken: { targets: [{ account: missing, model: x }] }",
      ),
    );
    const response = await reload();
    expect(response.status).toBe(422);
    expect(await readJson(response)).toMatchObject({
      reloaded: false,
      problems: [expect.stringContaining("missing")],
    });
    expect((await ask()).status).toBe(200);
  });

  it("adds and removes clients and says what needs a restart", async () => {
    writeConfig(
      BASE_CONFIG.replace("  - { id: script, key_env: SCRIPT_KEY, notice: none }\n", "").replace(
        "max_body_mb: 1",
        "max_body_mb: 2",
      ),
    );
    expect(await readJson(await reload())).toMatchObject({ restartNeeded: ["server"] });
    const removed = await gateway.post(
      { model: "fast", messages: userMessage() },
      { key: SCRIPT_KEY },
    );
    expect(removed.status).toBe(401);
  });

  it("needs the admin key", async () => {
    const response = await fetch(`${gateway.url}/router/config/reload`, { method: "POST" });
    expect(response.status).toBe(401);
  });

  it("finishes a request whose account disappears", async () => {
    let resolveRelease: () => void = () => {};
    const released = new Promise<void>((resolve) => (resolveRelease = resolve));
    gateway.upstream.script("f-one", errorStep(500, "server_error", "Failed"));
    const original = gateway.runtime.upstream.sendChat.bind(gateway.runtime.upstream);
    gateway.runtime.upstream.sendChat = async (...args) => {
      const response = await original(...args);
      resolveRelease();
      return response;
    };
    const pending = ask();
    await released;
    writeConfig(
      BASE_CONFIG.replace(/  openai-key: .*\n/, "").replace(
        /      - \{ account: openai-key, model: f-two \}\n/,
        "",
      ),
    );
    await reload();
    expect((await pending).status).toBeLessThan(600);
    expect((await ask("fast")).status).toBe(200);
  });
});

describe("circuit breaker", () => {
  const target = { id: "t/a/m", accountId: "a", model: "m", tier: "t" } as Target;

  it("trips when half of recent attempts fail, not on occasional errors", () => {
    let now = 0;
    const health = new TargetHealth(() => now);
    for (const outcome of ["ok", "upstream_error", "ok", "ok", "ok", "ok"] as const) {
      expect(health.record(target.id, outcome)).toBe(false);
    }
    expect(health.isDegraded(target.id)).toBe(false);
    expect(health.record(target.id, "timeout")).toBe(false);
    expect(health.isDegraded(target.id)).toBe(true);
    expect(health.record(target.id, "overloaded")).toBe(false);
    expect(health.record(target.id, "upstream_error")).toBe(false);
    expect(health.record(target.id, "mid_stream_failure")).toBe(true);
    expect(health.isDegraded(target.id)).toBe(false);
    now += 6 * 60_000;
    expect(health.record(target.id, "upstream_error")).toBe(false);
  });

  it("ignores failures that are not about the target's health", () => {
    const health = new TargetHealth(() => 0);
    for (let i = 0; i < 10; i += 1) {
      expect(health.record(target.id, "quota_exhausted")).toBe(false);
      expect(health.record(target.id, "client_error")).toBe(false);
    }
    expect(health.isDegraded(target.id)).toBe(false);
  });

  it("waits longer each time and lets one request test the target", () => {
    let now = 0;
    const quota = new QuotaManager(() => now);
    const wait = () => (quota.snapshot()[0]!.state.retryAt! - now) / 1000;
    quota.tripCircuit(target);
    expect(wait()).toBe(30);
    expect(quota.check(target).available).toBe(false);
    now += 30_000;
    expect(quota.tryAdmit(target)).toBe(true);
    expect(quota.tryAdmit(target)).toBe(false);
    quota.recordFailure(target, {
      outcome: "upstream_error",
      retryElsewhere: true,
      scope: "model",
    });
    quota.tripCircuit(target);
    expect(wait()).toBe(60);
    now += 60_000;
    quota.tryAdmit(target);
    quota.recordSuccess(target);
    expect(quota.snapshot()).toEqual([]);
  });

  it("rests a flapping target and sends traffic elsewhere", async () => {
    for (let i = 0; i < 3; i += 1) {
      gateway.upstream.script("f-one", errorStep(500, "server_error", "Failed"));
      await ask();
      if (i === 2) break;
      time += 121_000;
      await ask();
      time += 1000;
    }
    const state = gateway.runtime.quota.snapshot().find((entry) => entry.scope === "model:f-one");
    expect(state?.state).toMatchObject({ status: "backoff", detail: "circuit_open" });
    const calls = gateway.upstream.requestsFor("f-one").length;
    expect((await ask()).headers.get("x-llmr-target")).toContain("f-two");
    expect(gateway.upstream.requestsFor("f-one")).toHaveLength(calls);
  });

  it("prefers a healthy target of the same cost, but never a dearer one", async () => {
    const yaml = BASE_CONFIG.replace(
      "      - { account: openai-key, model: f-two }\n",
      "      - { account: gateway-a, model: f-spare }\n      - { account: openai-key, model: f-two }\n",
    );
    await gateway.close();
    gateway = await startGateway({ yaml, models: MODELS, now: () => time });
    const first = gateway.runtime.config.tiers.get("frontier")!.targets[0]!;
    for (const outcome of ["ok", "ok", "ok", "upstream_error", "upstream_error"] as const) {
      gateway.runtime.health.record(first.id, outcome);
    }
    expect((await ask()).headers.get("x-llmr-target")).toContain("f-spare");

    const spare = gateway.runtime.config.tiers.get("frontier")!.targets[1]!;
    for (const outcome of ["ok", "ok", "ok", "upstream_error", "upstream_error"] as const) {
      gateway.runtime.health.record(spare.id, outcome);
    }
    // Both prepaid targets are unwell, and the metered one still waits its turn.
    expect((await ask()).headers.get("x-llmr-target")).toContain("gateway-a");
  });
});

describe("encrypted sign-ins", () => {
  const KEY = Buffer.alloc(32, 7).toString("base64");
  let auth: FakeChatGptAuth;

  beforeEach(async () => {
    auth = await new FakeChatGptAuth().start();
  });
  afterEach(() => auth.stop());

  it("stores no readable tokens when a key is set", () => {
    vi.stubEnv("LLMR_STATE_KEY", KEY);
    importCredential(dir, "plan", auth.credential(time));
    const raw = readFileSync(credentialPath(dir, "plan"), "utf8");
    expect(raw).toContain("A256GCM");
    expect(raw).not.toContain(auth.accessToken);
    expect(raw).not.toContain(auth.refreshToken);
    expect(raw).not.toContain("person@example.com");
    expect(readCredential(credentialPath(dir, "plan"))).toMatchObject({
      refresh_token: auth.refreshToken,
    });
  });

  it("does not read a sealed sign-in with the wrong key, or under another name", () => {
    vi.stubEnv("LLMR_STATE_KEY", KEY);
    importCredential(dir, "plan", auth.credential(time));
    const file = credentialPath(dir, "plan");
    const other = credentialPath(dir, "other");
    writeFileSync(other, readFileSync(file));
    expect(readCredential(other)).toBeNull();
    vi.stubEnv("LLMR_STATE_KEY", Buffer.alloc(32, 8).toString("base64"));
    expect(readCredential(file)).toBeNull();
    vi.stubEnv("LLMR_STATE_KEY", "");
    expect(readCredential(file)).toBeNull();
  });

  it("still reads an older plain file, and seals it on the next save", () => {
    importCredential(dir, "plan", auth.credential(time));
    const file = credentialPath(dir, "plan");
    expect(readFileSync(file, "utf8")).toContain(auth.refreshToken);
    vi.stubEnv("LLMR_STATE_KEY", KEY);
    const credential = readCredential(file)!;
    expect(credential.refresh_token).toBe(auth.refreshToken);
    importCredential(dir, "plan", credential);
    expect(readFileSync(file, "utf8")).not.toContain(auth.refreshToken);
  });

  it("rejects a key of the wrong size", () => {
    expect(() => stateKey({ LLMR_STATE_KEY: "c2hvcnQ=" })).toThrow(/32 bytes/);
    expect(stateKey({})).toBeNull();
  });
});
