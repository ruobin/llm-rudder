import { afterEach, describe, expect, it } from "vitest";
import { anthropicErrorStep } from "../src/dev/fake-upstream.js";
import { MemoryPersistence } from "../src/ledger/records.js";
import { PIN_IDLE_MS, PinStore } from "../src/routing/pins.js";
import { CLAUDE_KEY, readJson, startGateway, userMessage, type TestGateway } from "./helpers.js";

const YAML = `
version: 1
server: { host: 127.0.0.1, port: 0 }
admin: { key_env: ADMIN_KEY }
clients:
  - { id: claude-code, key_env: CLAUDE_KEY }
accounts:
  prepaid: { api: anthropic.messages, base_url_env: UPSTREAM_URL, api_key_env: ANTHROPIC_KEY, cost_class: prepaid, trust: first_party }
  other: { api: anthropic.messages, base_url_env: UPSTREAM_URL, api_key_env: BACKUP_KEY, cost_class: prepaid, trust: first_party }
  paid: { api: anthropic.messages, base_url_env: UPSTREAM_URL, api_key_env: OPENAI_KEY, cost_class: metered, trust: first_party }
tiers:
  frontier:
    fallback_tiers: [medium]
    targets:
      - { account: prepaid, model: first }
      - { account: other, model: second }
  medium:
    targets:
      - { account: other, model: lower }
  costly:
    targets:
      - { account: prepaid, model: free-one }
      - { account: paid, model: paid-one }
`;

const overloaded = () => anthropicErrorStep(529, "overloaded_error", "Busy");

let gateway: TestGateway;
let running = false;
let time: number;

async function start(persistence = new MemoryPersistence()) {
  time = Date.parse("2030-01-01T00:00:00Z");
  gateway = await startGateway({ yaml: YAML, now: () => time, persistence });
  running = true;
}

afterEach(async () => {
  if (running) await gateway.close();
  running = false;
});

async function ask(model: string, session = "session-1") {
  const response = await fetch(`${gateway.url}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CLAUDE_KEY}`,
      "content-type": "application/json",
      "x-claude-code-session-id": session,
    },
    body: JSON.stringify({ model, max_tokens: 10, messages: userMessage() }),
  });
  await readJson(response);
  return response.headers.get("x-llmr-target");
}

describe("session pins", () => {
  it("keeps a conversation where it failed over to, without going back", async () => {
    await start();
    gateway.upstream.script("first", overloaded());
    expect(await ask("frontier")).toBe("frontier/other/second");

    // The first target has recovered, but moving back would lose the prompt cache.
    time += 60_000;
    expect(await ask("frontier")).toBe("frontier/other/second");
    expect(await ask("frontier")).toBe("frontier/other/second");
    expect(gateway.upstream.requestsFor("first")).toHaveLength(1);
  });

  it("does not affect other conversations", async () => {
    await start();
    gateway.upstream.script("first", overloaded());
    await ask("frontier");
    time += 60_000;
    expect(await ask("frontier", "session-2")).toBe("frontier/prepaid/first");
  });

  it("moves the pin when the pinned target fails", async () => {
    await start();
    gateway.upstream.script("first", overloaded());
    await ask("frontier");
    time += 60_000;
    gateway.upstream.script("second", overloaded());
    expect(await ask("frontier")).toBe("frontier/prepaid/first");
    time += 60_000;
    expect(await ask("frontier")).toBe("frontier/prepaid/first");
    expect(gateway.upstream.requestsFor("second")).toHaveLength(2);
  });

  it("expires after the conversation has been idle", async () => {
    await start();
    gateway.upstream.script("first", overloaded());
    await ask("frontier");
    time += PIN_IDLE_MS + 1000;
    expect(await ask("frontier")).toBe("frontier/prepaid/first");
  });

  it("releases a fallback tier as soon as the requested tier works again", async () => {
    await start();
    gateway.upstream.script("first", overloaded());
    gateway.upstream.script("second", overloaded());
    expect(await ask("frontier")).toBe("medium/other/lower");
    time += 60_000;
    expect(await ask("frontier")).toBe("frontier/prepaid/first");
  });

  it("moves back from a paid target when a prepaid one recovers", async () => {
    await start();
    gateway.upstream.script("free-one", overloaded());
    expect(await ask("costly")).toBe("costly/paid/paid-one");
    expect(await ask("costly")).toBe("costly/paid/paid-one");
    time += 60_000;
    expect(await ask("costly")).toBe("costly/prepaid/free-one");
  });

  it("survives a restart", async () => {
    const persistence = new MemoryPersistence();
    await start(persistence);
    gateway.upstream.script("first", overloaded());
    await ask("frontier");
    await gateway.close();

    gateway = await startGateway({ yaml: YAML, now: () => time, persistence });
    time += 60_000;
    expect(await ask("frontier")).toBe("frontier/other/second");
  });
});

describe("short throttles", () => {
  /** Pins the conversation to `first` with one successful request. */
  async function pinned() {
    await start();
    expect(await ask("frontier")).toBe("frontier/prepaid/first");
  }

  it("waits and retries the pinned target once", async () => {
    await pinned();
    gateway.upstream.script(
      "first",
      anthropicErrorStep(429, "rate_limit_error", "Slow", { "retry-after": "0.05" }),
    );
    const startedAt = Date.now();
    expect(await ask("frontier")).toBe("frontier/prepaid/first");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
    expect(gateway.upstream.requestsFor("first")).toHaveLength(3);
    expect(gateway.upstream.requestsFor("second")).toHaveLength(0);
    expect(gateway.runtime.quota.snapshot()).toHaveLength(0);
  });

  it("fails over if the retry is throttled too", async () => {
    await pinned();
    const throttled = anthropicErrorStep(429, "rate_limit_error", "Slow", {
      "retry-after": "0.01",
    });
    gateway.upstream.script("first", throttled, throttled);
    expect(await ask("frontier")).toBe("frontier/other/second");
    expect(gateway.upstream.requestsFor("first")).toHaveLength(3);
  });

  it("does not wait for a long throttle", async () => {
    await pinned();
    gateway.upstream.script(
      "first",
      anthropicErrorStep(429, "rate_limit_error", "Slow", { "retry-after": "30" }),
    );
    expect(await ask("frontier")).toBe("frontier/other/second");
    expect(gateway.upstream.requestsFor("first")).toHaveLength(2);
  });

  it("does not wait for a target that is not pinned", async () => {
    await start();
    gateway.upstream.script(
      "first",
      anthropicErrorStep(429, "rate_limit_error", "Slow", { "retry-after": "5" }),
    );
    expect(await ask("frontier")).toBe("frontier/other/second");
    expect(gateway.upstream.requestsFor("first")).toHaveLength(1);
  });
});

describe("pin store", () => {
  it("does not overwrite a concurrent winner", () => {
    const store = new PinStore(() => 1000);
    store.set("c", "s", "t", "a", null);
    // This request started before the pin existed and lost the race.
    store.set("c", "s", "t", "b", null);
    expect(store.get("c", "s", "t")).toBe("a");
    store.set("c", "s", "t", "b", "a");
    expect(store.get("c", "s", "t")).toBe("b");
  });

  it("limits how often an unchanged pin is written", () => {
    let now = 0;
    const persistence = new MemoryPersistence();
    const saves: number[] = [];
    const original = persistence.savePin.bind(persistence);
    persistence.savePin = (entry) => {
      saves.push(entry.updatedAt);
      original(entry);
    };
    const store = new PinStore(() => now, persistence);
    store.set("c", "s", "t", "a", null);
    now = 30_000;
    store.set("c", "s", "t", "a", "a");
    now = 61_000;
    store.set("c", "s", "t", "a", "a");
    expect(saves).toEqual([0, 61_000]);
  });

  it("forgets idle conversations", () => {
    let now = 0;
    const store = new PinStore(() => now);
    store.set("c", "s", "t", "a", null);
    now = PIN_IDLE_MS + 1;
    store.prune();
    expect(store.size).toBe(0);
  });
});
