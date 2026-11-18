import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorStep } from "../src/dev/fake-upstream.js";
import type { MemoryPersistence } from "../src/ledger/records.js";
import { buildUsageReport, runLedgerMaintenance } from "../src/ledger/usage.js";
import {
  ADMIN_KEY,
  BASE_CONFIG,
  CHAT_KEY,
  MODELS,
  readJson,
  SCRIPT_KEY,
  startGateway,
  userMessage,
  type TestGateway,
} from "./helpers.js";

const DAY_MS = 86_400_000;

let gateway: TestGateway;
let time: number;

const admin = (path: string, init: RequestInit = {}, key = ADMIN_KEY) =>
  fetch(`${gateway.url}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${key}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });

const createClient = (body: unknown) =>
  admin("/router/clients", { method: "POST", body: JSON.stringify(body) });

const ask = (key: string, model = "frontier", content = "Hello") =>
  gateway.post({ model, messages: userMessage(content) }, { key });

beforeEach(async () => {
  time = Date.parse("2026-11-18T12:00:00Z");
  gateway = await startGateway({ yaml: BASE_CONFIG, models: MODELS, now: () => time });
});

afterEach(async () => {
  await gateway.close();
});

describe("access", () => {
  it.each([
    "/router/usage",
    "/router/requests",
    "/router/requests/01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "/router/events",
    "/router/clients",
    "/router/settings",
  ])("%s needs the admin key", async (path) => {
    expect((await fetch(`${gateway.url}${path}`)).status).toBe(401);
    expect((await admin(path, {}, CHAT_KEY)).status).toBe(401);
  });

  it("refuses client changes without the admin key", async () => {
    const create = await fetch(`${gateway.url}/router/clients`, {
      method: "POST",
      headers: { authorization: `Bearer ${CHAT_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "intruder" }),
    });
    expect(create.status).toBe(401);
    expect((await admin("/router/clients/chat", { method: "DELETE" }, CHAT_KEY)).status).toBe(401);
  });
});

describe("usage", () => {
  it("adds up what each client, account and model used", async () => {
    await (await ask(CHAT_KEY, "frontier", "one")).text();
    await (await ask(SCRIPT_KEY, "frontier", "two")).text();
    gateway.upstream.script("f-one", errorStep(500, "server_error", "Broken"));
    await (await ask(SCRIPT_KEY, "frontier", "three")).text();
    time += DAY_MS;
    await (await ask(CHAT_KEY, "fast", "four")).text();

    const report = await readJson(await admin("/router/usage?days=3"));
    expect(report).toMatchObject({ from: "2026-11-17", to: "2026-11-19" });
    expect(
      report.byDay.map((day: { day: string; served: number }) => [day.day, day.served]),
    ).toEqual([
      ["2026-11-17", 0],
      ["2026-11-18", 3],
      ["2026-11-19", 1],
    ]);
    expect(report.totals).toMatchObject({ served: 4, failed: 1 });
    expect(report.totals.inputTokens).toBeGreaterThan(0);
    const chat = report.byClient.find((row: { clientId: string }) => row.clientId === "chat");
    expect(chat.served).toBe(2);
    const metered = report.byAccount.find(
      (row: { accountId: string }) => row.accountId === "openai-key",
    );
    expect(metered.costUsd).toBeGreaterThan(0);
    const prepaid = report.byAccount.find(
      (row: { accountId: string }) => row.accountId === "gateway-a",
    );
    expect(prepaid.costUsd).toBe(0);
    expect(prepaid.listValueUsd).toBeGreaterThan(0);
    expect(report.byModel.map((row: { model: string }) => row.model).sort()).toEqual([
      "f-one",
      "f-two",
      "l-one",
    ]);
  });

  it("rejects an unreasonable range", async () => {
    expect((await admin("/router/usage?days=0")).status).toBe(400);
    expect((await admin("/router/usage?days=9999")).status).toBe(400);
    expect((await admin("/router/usage?other=1")).status).toBe(400);
  });

  it("orders groups by value and fills empty days", () => {
    const row = {
      day: "2026-01-02",
      clientId: "a",
      accountId: "x",
      model: "m",
      served: 1,
      failed: 0,
      inputTokens: 1,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1,
      costMicroUsd: 0,
      listMicroUsd: 1_000_000,
    };
    const report = buildUsageReport(
      [row, { ...row, clientId: "b", listMicroUsd: 3_000_000 }],
      "2026-01-01",
      "2026-01-03",
    );
    expect(report.byClient.map((client) => client.clientId)).toEqual(["b", "a"]);
    expect(report.byDay.map((day) => day.listValueUsd)).toEqual([0, 4, 0]);
  });
});

describe("requests", () => {
  it("lists, filters and pages through requests without their content", async () => {
    for (const content of ["secret one", "secret two", "secret three"]) {
      await (await ask(CHAT_KEY, "frontier", content)).text();
      time += 1000;
    }
    await (await ask(SCRIPT_KEY, "fast", "secret four")).text();

    const first = await readJson(await admin("/router/requests?limit=2"));
    expect(first.items).toHaveLength(2);
    expect(first.items[0]).toMatchObject({ clientId: "script", requestedModel: "fast" });
    expect(first.nextBefore).toBe(first.items[1].id);

    const second = await readJson(
      await admin(`/router/requests?limit=2&before=${first.nextBefore}`),
    );
    expect(second.items).toHaveLength(2);
    expect(second.nextBefore).toBeNull();
    const ids = [...first.items, ...second.items].map((item: { id: string }) => item.id);
    expect(new Set(ids).size).toBe(4);

    const chat = await readJson(await admin("/router/requests?client=chat"));
    expect(chat.items).toHaveLength(3);
    const flash = await readJson(await admin("/router/requests?tier=flash"));
    expect(flash.items).toHaveLength(1);
    const none = await readJson(await admin("/router/requests?outcome=refusal"));
    expect(none.items).toHaveLength(0);
    const ranged = await readJson(
      await admin(`/router/requests?from=${new Date(time).toISOString()}`),
    );
    expect(ranged.items).toHaveLength(1);

    const text = JSON.stringify([first, second, chat, flash]);
    expect(text).not.toContain("secret");
  });

  it("shows every attempt of one request", async () => {
    gateway.upstream.script("f-one", errorStep(500, "server_error", "Broken"));
    const response = await ask(SCRIPT_KEY);
    const id = response.headers.get("x-llmr-request-id");
    await response.text();

    const detail = await readJson(await admin(`/router/requests/${id}`));
    expect(detail).toMatchObject({ id, clientId: "script", outcome: "ok", attemptCount: 2 });
    expect(
      detail.attempts.map((a: { model: string; outcome: string }) => [a.model, a.outcome]),
    ).toEqual([
      ["f-one", "upstream_error"],
      ["f-two", "ok"],
    ]);
    expect(detail.attempts[1].costUsd).toBeGreaterThan(0);
    expect((await admin("/router/requests/nothing")).status).toBe(404);
  });

  it("rejects a malformed filter", async () => {
    expect((await admin("/router/requests?before=x")).status).toBe(400);
    expect((await admin("/router/requests?limit=1000")).status).toBe(400);
    expect((await admin("/router/requests?from=yesterday")).status).toBe(400);
  });
});

describe("clients", () => {
  it("creates a working key that is shown only once", async () => {
    const response = await createClient({ id: "phone", notice: "text", rpm: 10 });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { key, client } = await readJson(response);
    expect(key).toMatch(/^llmr_[0-9A-Za-z]{43}$/);
    expect(client).toMatchObject({
      id: "phone",
      source: "dashboard",
      notice: "text",
      rpm: 10,
      keyPrefix: key.slice(0, 12),
    });

    const answer = await ask(key);
    expect(answer.status).toBe(200);
    await answer.text();

    const text = await (await admin("/router/clients")).text();
    expect(text).not.toContain(key);
    expect(text).not.toContain("keyHash");
    const { items } = JSON.parse(text);
    expect(items.map((item: { id: string }) => item.id)).toEqual(
      expect.arrayContaining(["chat", "script", "limited", "phone"]),
    );
    expect(items.find((item: { id: string }) => item.id === "phone").lastUsedAt).toBe(
      new Date(time).toISOString(),
    );
    const requests = await readJson(await admin("/router/requests?client=phone"));
    expect(requests.items).toHaveLength(1);
  });

  it("stores only a hash of the key", async () => {
    const { key } = await readJson(await createClient({ id: "phone" }));
    const stored = (gateway.persistence as MemoryPersistence).clientKeys.get("phone")!;
    expect(JSON.stringify(stored)).not.toContain(key);
    expect(stored.keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("applies the limits chosen for the client", async () => {
    const { key } = await readJson(
      await createClient({ id: "narrow", allowAccounts: ["gemini-key"], rpm: 2 }),
    );
    const answer = await ask(key);
    expect(answer.headers.get("x-llmr-target")).toContain("gemini-key");
    await answer.text();
    await (await ask(key)).text();
    expect((await ask(key)).status).toBe(429);
  });

  it("stops a revoked key at once and keeps its record", async () => {
    const { key } = await readJson(await createClient({ id: "old-laptop" }));
    expect((await ask(key)).status).toBe(200);

    const revoked = await admin("/router/clients/old-laptop", { method: "DELETE" });
    expect(await readJson(revoked)).toEqual({ id: "old-laptop", revoked: true });
    expect((await ask(key)).status).toBe(401);

    const { items } = await readJson(await admin("/router/clients"));
    expect(items.find((item: { id: string }) => item.id === "old-laptop").revokedAt).toBe(
      new Date(time).toISOString(),
    );
    expect((await admin("/router/clients/old-laptop", { method: "DELETE" })).status).toBe(200);
  });

  it("does not reuse a name, even after it is revoked", async () => {
    await createClient({ id: "phone" });
    expect((await createClient({ id: "phone" })).status).toBe(409);
    await admin("/router/clients/phone", { method: "DELETE" });
    expect((await createClient({ id: "phone" })).status).toBe(409);
    expect((await createClient({ id: "chat" })).status).toBe(409);
  });

  it("leaves clients from the config file alone", async () => {
    const response = await admin("/router/clients/chat", { method: "DELETE" });
    expect(response.status).toBe(409);
    expect((await readJson(response)).error.code).toBe("client_from_config");
    expect((await ask(CHAT_KEY)).status).toBe(200);
  });

  it("rejects bad input", async () => {
    expect((await createClient({ id: "Bad Name" })).status).toBe(400);
    expect((await createClient({ id: "x", extra: true })).status).toBe(400);
    expect((await createClient({ id: "x", rpm: 0 })).status).toBe(400);
    expect((await createClient({ id: "x", allowAccounts: ["missing"] })).status).toBe(400);
    expect((await admin("/router/clients/none", { method: "DELETE" })).status).toBe(404);
  });

  it("keeps keys working after a restart", async () => {
    const { key } = await readJson(await createClient({ id: "phone" }));
    await createClient({ id: "gone" });
    const gone = (await readJson(await createClient({ id: "gone-2" }))).key;
    await admin("/router/clients/gone-2", { method: "DELETE" });
    const { persistence } = gateway;
    await gateway.close();
    gateway = await startGateway({
      yaml: BASE_CONFIG,
      models: MODELS,
      now: () => time,
      persistence,
    });
    expect((await ask(key)).status).toBe(200);
    expect((await ask(gone)).status).toBe(401);
  });
});

describe("events and settings", () => {
  it("lists recorded events, newest first", async () => {
    gateway.runtime.notifier.emit("budget_reached", "a", "First");
    gateway.runtime.notifier.emit("budget_reached", "b", "Second");
    const { items } = await readJson(await admin("/router/events?limit=1"));
    expect(items).toEqual([expect.objectContaining({ subject: "b", message: "Second" })]);
  });

  it("shows settings without keys or notification addresses", async () => {
    const text = await (await admin("/router/settings")).text();
    const settings = JSON.parse(text);
    expect(settings.retention).toEqual({ ledgerDays: 90, eventsDays: 90 });
    expect(settings.notifications).toMatchObject({ ntfy: false, webhook: false });
    expect(settings.tiers[0]).toMatchObject({ name: "frontier" });
    expect(text).not.toMatch(/upstream-|keyHash|apiKey|llmr_/);
  });
});

describe("retention", () => {
  it("removes old detail on schedule", async () => {
    await (await ask(CHAT_KEY)).text();
    gateway.runtime.notifier.emit("budget_reached", "a", "Old");
    time += 91 * DAY_MS;
    await (await ask(CHAT_KEY)).text();
    await runLedgerMaintenance(gateway.runtime);
    const memory = gateway.persistence as MemoryPersistence;
    expect(memory.ledger).toHaveLength(1);
    expect(memory.events).toHaveLength(0);
  });
});
