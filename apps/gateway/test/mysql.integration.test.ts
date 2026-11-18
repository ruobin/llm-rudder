import { randomUUID } from "node:crypto";
import { createConnection, type RowDataPacket } from "mysql2/promise";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MysqlPersistence } from "../src/db/mysql.js";
import { ulid } from "../src/ids.js";

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
});
