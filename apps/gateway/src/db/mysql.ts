import { fileURLToPath } from "node:url";
import { and, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { createPool, type Pool, type ResultSetHeader } from "mysql2/promise";
import type { RowDataPacket } from "mysql2/promise";
import type { Logger } from "pino";
import type { StoredClientKey } from "../auth/clients.js";
import type { SpendRow } from "../billing/budgets.js";
import type {
  AttemptRecord,
  LedgerEntry,
  Persistence,
  RequestQuery,
  RequestRecord,
  UsageRow,
} from "../ledger/records.js";
import { LIVE_USAGE_DAYS, startOfDay, dayOf } from "../ledger/usage.js";
import type { RouterEvent } from "../notify/notifier.js";
import type { PinEntry } from "../routing/pins.js";
import type { QuotaEntry, QuotaStatus } from "../state/quota.js";
import type { NoticeMode, Outcome } from "../types.js";
import * as schema from "./schema.js";

const MAX_QUEUED_WRITES = 10_000;
const MAX_WRITE_ATTEMPTS = 3;
const MIGRATION_LOCK = "llm_rudder_migrations";
const DELETE_BATCH = 5000;
const DAY_MS = 86_400_000;

/** Totals grouped by day, client, account and model, for a time range. */
const USAGE_SELECT = `
  SELECT DATE_FORMAT(a.started_at, '%Y-%m-%d') AS day,
         r.client_id AS clientId,
         a.account_id AS accountId,
         a.model AS model,
         SUM(a.outcome = 'ok') AS served,
         SUM(a.outcome NOT IN ('ok', 'client_aborted')) AS failed,
         COALESCE(SUM(a.input_tokens), 0) AS inputTokens,
         COALESCE(SUM(a.cached_tokens), 0) AS cachedTokens,
         COALESCE(SUM(a.cache_write_tokens), 0) AS cacheWriteTokens,
         COALESCE(SUM(a.output_tokens), 0) AS outputTokens,
         COALESCE(SUM(a.cost_micro_usd), 0) AS costMicroUsd,
         COALESCE(SUM(a.list_micro_usd), 0) AS listMicroUsd
    FROM attempts a
    JOIN requests r ON r.id = a.request_id
   WHERE a.started_at >= ? AND a.started_at < ?
   GROUP BY day, r.client_id, a.account_id, a.model`;

const ROLLUP_COLUMNS = `day, client_id, account_id, model, served, failed, input_tokens,
  cached_tokens, cache_write_tokens, output_tokens, cost_micro_usd, list_micro_usd`;

function usageRow(row: RowDataPacket): UsageRow {
  return {
    day: String(row.day),
    clientId: String(row.clientId),
    accountId: String(row.accountId),
    model: String(row.model),
    served: Number(row.served),
    failed: Number(row.failed),
    inputTokens: Number(row.inputTokens),
    cachedTokens: Number(row.cachedTokens),
    cacheWriteTokens: Number(row.cacheWriteTokens),
    outputTokens: Number(row.outputTokens),
    costMicroUsd: Number(row.costMicroUsd),
    listMicroUsd: Number(row.listMicroUsd),
  };
}

function requestRecord(row: typeof schema.requests.$inferSelect): RequestRecord {
  return {
    ...row,
    startedAt: row.startedAt.getTime(),
    finishedAt: (row.finishedAt ?? row.startedAt).getTime(),
    outcome: (row.outcome ?? "upstream_error") as Outcome,
  };
}

function attemptRecord(row: typeof schema.attempts.$inferSelect): AttemptRecord {
  return {
    ...row,
    startedAt: row.startedAt.getTime(),
    durationMs: row.durationMs ?? 0,
    outcome: row.outcome as Outcome,
  };
}
const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

const toDate = (time: number | undefined | null) =>
  time === undefined || time === null ? null : new Date(time);

/** Runs database writes one at a time, so a slow database never delays a response. */
class WriteQueue {
  private readonly tasks: (() => Promise<unknown>)[] = [];
  private draining: Promise<void> | null = null;
  private dropped = 0;

  constructor(private readonly log: Logger) {}

  push(task: () => Promise<unknown>): void {
    if (this.tasks.length >= MAX_QUEUED_WRITES) {
      this.dropped += 1;
      if (this.dropped % 1000 === 1) {
        this.log.error({ dropped: this.dropped }, "database write queue is full");
      }
      return;
    }
    this.tasks.push(task);
    this.draining ??= this.drain().finally(() => {
      this.draining = null;
    });
  }

  private async drain(): Promise<void> {
    for (let task = this.tasks.shift(); task; task = this.tasks.shift()) {
      for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
        try {
          await task();
          break;
        } catch (error) {
          if (attempt === MAX_WRITE_ATTEMPTS) {
            this.log.error({ err: error }, "database write failed");
          } else {
            await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
          }
        }
      }
    }
  }

  async flush(): Promise<void> {
    while (this.draining) await this.draining;
  }
}

export class MysqlPersistence implements Persistence {
  private readonly queue: WriteQueue;

  private constructor(
    private readonly pool: Pool,
    private readonly db: MySql2Database<typeof schema>,
    log: Logger,
  ) {
    this.queue = new WriteQueue(log);
  }

  static connect(url: string, log: Logger): MysqlPersistence {
    const pool = createPool({ uri: url, connectionLimit: 8, timezone: "Z", dateStrings: false });
    const db = drizzle(pool, { schema, mode: "default" });
    return new MysqlPersistence(pool, db, log);
  }

  /** Applies migrations, holding a lock so that instances do not race. */
  async migrate(): Promise<void> {
    const connection = await this.pool.getConnection();
    try {
      await connection.query("SELECT GET_LOCK(?, 60)", [MIGRATION_LOCK]);
      await migrate(this.db, { migrationsFolder });
    } finally {
      await connection.query("SELECT RELEASE_LOCK(?)", [MIGRATION_LOCK]);
      connection.release();
    }
  }

  async loadQuota(): Promise<QuotaEntry[]> {
    const rows = await this.db.select().from(schema.quotaState);
    return rows.map((row) => ({
      accountId: row.accountId,
      scope: row.scope,
      state: {
        status: row.status as QuotaStatus,
        ...(row.retryAt ? { retryAt: row.retryAt.getTime() } : {}),
        ...(row.backoffS ? { backoffS: row.backoffS } : {}),
        ...(row.detail ? { detail: row.detail } : {}),
      },
    }));
  }

  async loadSpend(periods: string[]): Promise<SpendRow[]> {
    return this.db.select().from(schema.spend).where(inArray(schema.spend.period, periods));
  }

  saveQuota(entry: QuotaEntry): void {
    const values = {
      status: entry.state.status,
      retryAt: toDate(entry.state.retryAt),
      backoffS: entry.state.backoffS ?? null,
      detail: entry.state.detail?.slice(0, 255) ?? null,
      updatedAt: new Date(),
    };
    this.queue.push(() =>
      this.db
        .insert(schema.quotaState)
        .values({ accountId: entry.accountId, scope: entry.scope, ...values })
        .onDuplicateKeyUpdate({ set: values }),
    );
  }

  deleteQuota(accountId: string, scope: string): void {
    this.queue.push(() =>
      this.db
        .delete(schema.quotaState)
        .where(and(eq(schema.quotaState.accountId, accountId), eq(schema.quotaState.scope, scope))),
    );
  }

  addSpend(accountId: string, period: string, microUsd: number): void {
    this.queue.push(() =>
      this.db
        .insert(schema.spend)
        .values({ accountId, period, spentMicroUsd: microUsd })
        .onDuplicateKeyUpdate({
          set: { spentMicroUsd: sql`${schema.spend.spentMicroUsd} + ${microUsd}` },
        }),
    );
  }

  savePin(entry: PinEntry): void {
    const values = { targetId: entry.targetId, updatedAt: new Date(entry.updatedAt) };
    this.queue.push(() =>
      this.db
        .insert(schema.sessionPins)
        .values({
          clientId: entry.clientId,
          sessionHash: entry.sessionHash,
          tier: entry.tier,
          ...values,
        })
        .onDuplicateKeyUpdate({ set: values }),
    );
  }

  deletePin(clientId: string, sessionHash: string, tier: string): void {
    this.queue.push(() =>
      this.db
        .delete(schema.sessionPins)
        .where(
          and(
            eq(schema.sessionPins.clientId, clientId),
            eq(schema.sessionPins.sessionHash, sessionHash),
            eq(schema.sessionPins.tier, tier),
          ),
        ),
    );
  }

  deletePinsBefore(time: number): void {
    this.queue.push(() =>
      this.db.delete(schema.sessionPins).where(lt(schema.sessionPins.updatedAt, new Date(time))),
    );
  }

  async loadPins(since: number): Promise<PinEntry[]> {
    const rows = await this.db
      .select()
      .from(schema.sessionPins)
      .where(gte(schema.sessionPins.updatedAt, new Date(since)));
    return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.getTime() }));
  }

  saveEvent(event: RouterEvent): void {
    this.queue.push(() =>
      this.db.insert(schema.events).values({
        at: new Date(event.at),
        kind: event.kind,
        subject: event.subject.slice(0, 160),
        message: event.message.slice(0, 500),
      }),
    );
  }

  saveLedger({ request, attempts }: LedgerEntry): void {
    this.queue.push(() =>
      this.db.transaction(async (tx) => {
        await tx.insert(schema.requests).values({
          ...request,
          startedAt: new Date(request.startedAt),
          finishedAt: new Date(request.finishedAt),
        });
        if (attempts.length > 0) {
          await tx.insert(schema.attempts).values(
            attempts.map((attempt) => ({
              ...attempt,
              startedAt: new Date(attempt.startedAt),
              errorCode: attempt.errorCode?.slice(0, 128) ?? null,
              returnedModel: attempt.returnedModel?.slice(0, 128) ?? null,
            })),
          );
        }
      }),
    );
  }

  /** Recent days come from the ledger, so they are always current. */
  async usageRows(fromDay: string, toDay: string, now: number): Promise<UsageRow[]> {
    const liveFrom = startOfDay(now) - (LIVE_USAGE_DAYS - 1) * DAY_MS;
    const from = Date.parse(`${fromDay}T00:00:00Z`);
    const to = Date.parse(`${toDay}T00:00:00Z`) + DAY_MS;
    const rows: UsageRow[] = [];
    if (from < liveFrom) {
      const [stored] = await this.pool.query<RowDataPacket[]>(
        `SELECT day, client_id AS clientId, account_id AS accountId, model, served, failed,
                input_tokens AS inputTokens, cached_tokens AS cachedTokens,
                cache_write_tokens AS cacheWriteTokens, output_tokens AS outputTokens,
                cost_micro_usd AS costMicroUsd, list_micro_usd AS listMicroUsd
           FROM usage_daily WHERE day >= ? AND day <= ? AND day < ?`,
        [fromDay, toDay, dayOf(liveFrom)],
      );
      rows.push(...stored.map(usageRow));
    }
    if (to > liveFrom) {
      const [live] = await this.pool.query<RowDataPacket[]>(USAGE_SELECT, [
        new Date(Math.max(from, liveFrom)),
        new Date(to),
      ]);
      rows.push(...live.map(usageRow));
    }
    return rows;
  }

  async listRequests(query: RequestQuery): Promise<RequestRecord[]> {
    const { requests } = schema;
    const conditions: (SQL | undefined)[] = [
      query.before === undefined ? undefined : lt(requests.id, query.before),
      query.clientId === undefined ? undefined : eq(requests.clientId, query.clientId),
      query.outcome === undefined ? undefined : eq(requests.outcome, query.outcome),
      query.model === undefined ? undefined : eq(requests.requestedModel, query.model),
      query.tier === undefined
        ? undefined
        : or(eq(requests.requestedTier, query.tier), eq(requests.servedTier, query.tier)),
      query.from === undefined ? undefined : gte(requests.startedAt, new Date(query.from)),
      query.to === undefined ? undefined : lt(requests.startedAt, new Date(query.to)),
    ];
    const rows = await this.db
      .select()
      .from(requests)
      .where(and(...conditions))
      .orderBy(desc(requests.id))
      .limit(query.limit);
    return rows.map(requestRecord);
  }

  async getRequest(id: string): Promise<LedgerEntry | null> {
    const [request] = await this.db
      .select()
      .from(schema.requests)
      .where(eq(schema.requests.id, id))
      .limit(1);
    if (!request) return null;
    const attempts = await this.db
      .select()
      .from(schema.attempts)
      .where(eq(schema.attempts.requestId, id))
      .orderBy(schema.attempts.n);
    return { request: requestRecord(request), attempts: attempts.map(attemptRecord) };
  }

  async listEvents(limit: number): Promise<RouterEvent[]> {
    const rows = await this.db
      .select()
      .from(schema.events)
      .orderBy(desc(schema.events.id))
      .limit(limit);
    return rows.map((row) => ({
      at: row.at.getTime(),
      kind: row.kind as RouterEvent["kind"],
      subject: row.subject,
      message: row.message,
    }));
  }

  async rollUp(now: number): Promise<void> {
    const today = startOfDay(now);
    const recent = today - LIVE_USAGE_DAYS * DAY_MS;
    // Older days are only filled in once, because their detail may be partly deleted.
    await this.pool.query(`INSERT IGNORE INTO usage_daily (${ROLLUP_COLUMNS}) ${USAGE_SELECT}`, [
      new Date(0),
      new Date(recent),
    ]);
    await this.pool.query(
      `INSERT INTO usage_daily (${ROLLUP_COLUMNS})
       SELECT * FROM (${USAGE_SELECT}) AS totals
       ON DUPLICATE KEY UPDATE
         served = totals.served, failed = totals.failed,
         input_tokens = totals.inputTokens, cached_tokens = totals.cachedTokens,
         cache_write_tokens = totals.cacheWriteTokens, output_tokens = totals.outputTokens,
         cost_micro_usd = totals.costMicroUsd, list_micro_usd = totals.listMicroUsd`,
      [new Date(recent), new Date(today)],
    );
  }

  private async deleteInBatches(statement: string, before: Date): Promise<number> {
    let removed = 0;
    for (;;) {
      const [result] = await this.pool.query<ResultSetHeader>(statement, [before, DELETE_BATCH]);
      removed += result.affectedRows;
      if (result.affectedRows < DELETE_BATCH) return removed;
    }
  }

  async deleteOldRecords(ledgerBefore: number, eventsBefore: number): Promise<number> {
    const ledger = new Date(ledgerBefore);
    return (
      (await this.deleteInBatches("DELETE FROM attempts WHERE started_at < ? LIMIT ?", ledger)) +
      (await this.deleteInBatches("DELETE FROM requests WHERE started_at < ? LIMIT ?", ledger)) +
      (await this.deleteInBatches(
        "DELETE FROM events WHERE at < ? LIMIT ?",
        new Date(eventsBefore),
      ))
    );
  }

  async loadClientKeys(): Promise<StoredClientKey[]> {
    const rows = await this.db.select().from(schema.clientKeys);
    return rows.map((row) => ({
      id: row.id,
      keyHash: row.keyHash,
      keyPrefix: row.keyPrefix,
      notice: row.notice as NoticeMode,
      maxConcurrent: row.maxConcurrent,
      allowFallback: row.allowFallback,
      createdAt: row.createdAt.getTime(),
      ...(row.rpm === null ? {} : { rpm: row.rpm }),
      ...(row.allowAccounts ? { allowAccounts: row.allowAccounts } : {}),
      ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt.getTime() } : {}),
      ...(row.revokedAt ? { revokedAt: row.revokedAt.getTime() } : {}),
    }));
  }

  async saveClientKey(key: StoredClientKey): Promise<void> {
    await this.db.insert(schema.clientKeys).values({
      id: key.id,
      keyHash: key.keyHash,
      keyPrefix: key.keyPrefix,
      notice: key.notice,
      rpm: key.rpm ?? null,
      maxConcurrent: key.maxConcurrent,
      allowAccounts: key.allowAccounts ?? null,
      allowFallback: key.allowFallback,
      createdAt: new Date(key.createdAt),
    });
  }

  async revokeClientKey(id: string, at: number): Promise<void> {
    await this.db
      .update(schema.clientKeys)
      .set({ revokedAt: new Date(at) })
      .where(and(eq(schema.clientKeys.id, id), isNull(schema.clientKeys.revokedAt)));
  }

  touchClientKey(id: string, at: number): void {
    this.queue.push(() =>
      this.db
        .update(schema.clientKeys)
        .set({ lastUsedAt: new Date(at) })
        .where(eq(schema.clientKeys.id, id)),
    );
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async flush(): Promise<void> {
    await this.queue.flush();
  }

  async close(): Promise<void> {
    await this.flush();
    await this.pool.end();
  }
}
