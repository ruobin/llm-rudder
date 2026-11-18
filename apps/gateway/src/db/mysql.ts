import { fileURLToPath } from "node:url";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { createPool, type Pool } from "mysql2/promise";
import type { Logger } from "pino";
import type { SpendRow } from "../billing/budgets.js";
import type { LedgerEntry, Persistence } from "../ledger/records.js";
import type { RouterEvent } from "../notify/notifier.js";
import type { PinEntry } from "../routing/pins.js";
import type { QuotaEntry, QuotaStatus } from "../state/quota.js";
import * as schema from "./schema.js";

const MAX_QUEUED_WRITES = 10_000;
const MAX_WRITE_ATTEMPTS = 3;
const MIGRATION_LOCK = "llm_rudder_migrations";
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
