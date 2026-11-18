import { createHash, randomUUID } from "node:crypto";
import { createConnection, type RowDataPacket } from "mysql2/promise";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MysqlPersistence } from "../src/db/mysql.js";
import { ulid } from "../src/ids.js";
import type { Outcome } from "../src/types.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("MySQL persistence", () => {
  let persistence: MysqlPersistence;
  const accountId = `test-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    persistence = MysqlPersistence.connect(url as string, pino({ level: "silent" }));
    await persistence.migrate();
    await persistence.migrate(); // running migrations twice must be harmless
  });

  afterAll(async () => {
    await persistence.close();
  });

  it("stores, updates, loads and removes session pins", async () => {
    const entry = {
      clientId: accountId,
      sessionHash: "0123456789abcdef",
      tier: "frontier",
      targetId: "frontier/a/one",
      updatedAt: Date.parse("2030-01-02T03:04:05.678Z"),
    };
    persistence.savePin(entry);
    persistence.savePin({ ...entry, targetId: "frontier/b/two" });
    await persistence.flush();
    const mine = async () =>
      (await persistence.loadPins(entry.updatedAt - 1000)).filter((p) => p.clientId === accountId);
    expect(await mine()).toEqual([{ ...entry, targetId: "frontier/b/two" }]);

    persistence.deletePinsBefore(entry.updatedAt);
    await persistence.flush();
    expect(await mine()).toHaveLength(1);
    persistence.deletePin(entry.clientId, entry.sessionHash, entry.tier);
    await persistence.flush();
    expect(await mine()).toHaveLength(0);
  });

  it("answers a health check", async () => {
    await expect(persistence.ping()).resolves.toBeUndefined();
  });

  it("stores, updates and deletes quota state", async () => {
    const retryAt = Date.parse("2030-01-02T03:04:05.678Z");
    persistence.saveQuota({
      accountId,
      scope: "*",
      state: { status: "backoff", retryAt, backoffS: 900 },
    });
    persistence.saveQuota({
      accountId,
      scope: "*",
      state: { status: "exhausted", retryAt, detail: "quota" },
    });
    await persistence.flush();

    const saved = (await persistence.loadQuota()).find((entry) => entry.accountId === accountId);
    expect(saved?.state).toEqual({ status: "exhausted", retryAt, detail: "quota" });

    persistence.deleteQuota(accountId, "*");
    await persistence.flush();
    const remaining = await persistence.loadQuota();
    expect(remaining.some((entry) => entry.accountId === accountId)).toBe(false);
  });

  it("adds spend atomically and loads only requested periods", async () => {
    for (let i = 0; i < 20; i += 1) persistence.addSpend(accountId, "day:2030-01-02", 5);
    persistence.addSpend(accountId, "day:2030-01-03", 7);
    await persistence.flush();
    const rows = await persistence.loadSpend(["day:2030-01-02"]);
    expect(rows.filter((row) => row.accountId === accountId)).toEqual([
      { accountId, period: "day:2030-01-02", spentMicroUsd: 100 },
    ]);
  });

  it("writes a request with its attempts, and events", async () => {
    const id = ulid();
    const now = Date.now();
    persistence.saveLedger({
      request: {
        id,
        startedAt: now,
        finishedAt: now + 5,
        clientId: accountId,
        sessionHash: "0123456789abcdef",
        requestedModel: "frontier",
        requestedTier: "frontier",
        servedTier: "medium",
        servedTarget: "medium/a/m",
        stream: true,
        outcome: "ok",
        httpStatus: 200,
        attemptCount: 1,
      },
      attempts: [
        {
          requestId: id,
          n: 1,
          targetId: "medium/a/m",
          accountId,
          model: "m",
          returnedModel: "m",
          startedAt: now,
          ttftMs: 1,
          durationMs: 5,
          httpStatus: 200,
          outcome: "ok",
          errorCode: null,
          inputTokens: 10,
          cacheWriteTokens: 0,
          cachedTokens: 0,
          outputTokens: 2,
          usageComplete: true,
          costMicroUsd: 42,
          listMicroUsd: 42,
        },
      ],
    });
    persistence.saveEvent({ at: now, kind: "budget_reached", subject: accountId, message: "m" });
    await persistence.flush();

    const connection = await createConnection(url as string);
    const [attempts] = await connection.query<RowDataPacket[]>(
      "SELECT cost_micro_usd FROM attempts WHERE request_id = ?",
      [id],
    );
    const [events] = await connection.query<RowDataPacket[]>(
      "SELECT kind FROM events WHERE subject = ?",
      [accountId],
    );
    await connection.end();
    expect(Number(attempts[0]?.cost_micro_usd)).toBe(42);
    expect(events[0]?.kind).toBe("budget_reached");
  });

  describe("reports", () => {
    const client = `client-${accountId}`;
    const now = Date.parse("2031-03-10T12:00:00Z");
    const day = (value: string) => Date.parse(`${value}T06:00:00Z`);

    const entry = (startedAt: number, outcome: Outcome, inputTokens = 100) => {
      const id = ulid(startedAt);
      return {
        request: {
          id,
          startedAt,
          finishedAt: startedAt + 50,
          clientId: client,
          sessionHash: "0123456789abcdef",
          requestedModel: "frontier",
          requestedTier: "frontier",
          servedTier: "frontier",
          servedTarget: `frontier/${accountId}/m`,
          stream: true,
          outcome,
          httpStatus: outcome === "ok" ? 200 : 500,
          attemptCount: 1,
        },
        attempts: [
          {
            requestId: id,
            n: 1,
            targetId: `frontier/${accountId}/m`,
            accountId,
            model: "m",
            returnedModel: "m",
            startedAt,
            ttftMs: 10,
            durationMs: 50,
            httpStatus: outcome === "ok" ? 200 : 500,
            outcome,
            errorCode: outcome === "ok" ? null : "server_error",
            inputTokens,
            cachedTokens: 5,
            cacheWriteTokens: 1,
            outputTokens: 20,
            usageComplete: true,
            costMicroUsd: 7,
            listMicroUsd: 11,
          },
        ],
      };
    };
    const mine = async (from: string, to: string) =>
      (await persistence.usageRows(from, to, now)).filter((row) => row.clientId === client);

    it("reads recent usage from the ledger and keeps old totals after cleanup", async () => {
      const old = entry(day("2031-03-01"), "ok");
      persistence.saveLedger(old);
      persistence.saveLedger(entry(day("2031-03-01") + 1000, "upstream_error", 0));
      persistence.saveLedger(entry(day("2031-03-09"), "ok"));
      await persistence.flush();
      await persistence.rollUp(now);

      const expected = {
        day: "2031-03-01",
        clientId: client,
        accountId,
        model: "m",
        served: 1,
        failed: 1,
        inputTokens: 100,
        cachedTokens: 10,
        cacheWriteTokens: 2,
        outputTokens: 40,
        costMicroUsd: 14,
        listMicroUsd: 22,
      };
      const rows = await mine("2031-03-01", "2031-03-10");
      expect(rows.find((row) => row.day === "2031-03-01")).toEqual(expected);
      expect(rows.find((row) => row.day === "2031-03-09")).toMatchObject({ served: 1, failed: 0 });

      // A new record for a recent day shows up before any rollup runs.
      persistence.saveLedger(entry(day("2031-03-09") + 5000, "ok"));
      await persistence.flush();
      expect((await mine("2031-03-09", "2031-03-09"))[0]).toMatchObject({ served: 2 });

      expect(await persistence.getRequest(old.request.id)).toMatchObject({
        request: { id: old.request.id, outcome: "ok", startedAt: old.request.startedAt },
        attempts: [{ n: 1, accountId, inputTokens: 100, costMicroUsd: 7 }],
      });
      const newest = await persistence.listRequests({ limit: 2, clientId: client });
      expect(newest.map((request) => request.startedAt)).toEqual([
        day("2031-03-09") + 5000,
        day("2031-03-09"),
      ]);
      const older = await persistence.listRequests({
        limit: 10,
        clientId: client,
        before: newest[1]!.id,
        outcome: "upstream_error",
        tier: "frontier",
        model: "frontier",
        from: day("2031-03-01"),
        to: day("2031-03-02"),
      });
      expect(older).toHaveLength(1);

      const removed = await persistence.deleteOldRecords(
        Date.parse("2031-03-05T00:00:00Z"),
        Date.parse("2000-01-01T00:00:00Z"),
      );
      expect(removed).toBeGreaterThanOrEqual(4);
      expect(await persistence.getRequest(old.request.id)).toBeNull();
      await persistence.rollUp(now);
      expect((await mine("2031-03-01", "2031-03-01"))[0]).toEqual(expected);
    });

    it("does not overwrite a finished day from partly deleted detail", async () => {
      const partial = entry(day("2031-02-01"), "ok");
      persistence.saveLedger(partial);
      persistence.saveLedger(entry(day("2031-02-01") + 1000, "ok"));
      await persistence.flush();
      await persistence.rollUp(now);
      await persistence.deleteOldRecords(
        day("2031-02-01") + 500,
        Date.parse("2000-01-01T00:00:00Z"),
      );
      await persistence.rollUp(now);
      expect((await mine("2031-02-01", "2031-02-01"))[0]).toMatchObject({ served: 2 });
    });

    it("stores events and client keys", async () => {
      const at = Date.parse("2032-01-01T00:00:00.000Z");
      persistence.saveEvent({ at, kind: "budget_reached", subject: accountId, message: "Hello" });
      await persistence.flush();
      expect((await persistence.listEvents(1))[0]).toEqual({
        at,
        kind: "budget_reached",
        subject: accountId,
        message: "Hello",
      });

      const id = `key-${accountId}`;
      const stored = {
        id,
        keyHash: createHash("sha256").update(id).digest("hex"),
        keyPrefix: "llmr_abc",
        notice: "text" as const,
        rpm: 5,
        maxConcurrent: 2,
        allowAccounts: ["one"],
        allowFallback: false,
        createdAt: at,
      };
      await persistence.saveClientKey(stored);
      await expect(persistence.saveClientKey(stored)).rejects.toThrow();
      persistence.touchClientKey(id, at + 1000);
      await persistence.flush();
      await persistence.revokeClientKey(id, at + 2000);
      const [loaded] = (await persistence.loadClientKeys()).filter((key) => key.id === id);
      expect(loaded).toEqual({ ...stored, lastUsedAt: at + 1000, revokedAt: at + 2000 });
    });
  });
});
