import {
  bigint,
  boolean,
  char,
  datetime,
  index,
  int,
  mysqlTable,
  primaryKey,
  smallint,
  varchar,
} from "drizzle-orm/mysql-core";

const time = (name: string) => datetime(name, { mode: "date", fsp: 3 });

export const requests = mysqlTable(
  "requests",
  {
    id: char("id", { length: 26 }).primaryKey(),
    startedAt: time("started_at").notNull(),
    finishedAt: time("finished_at"),
    clientId: varchar("client_id", { length: 64 }).notNull(),
    sessionHash: char("session_hash", { length: 16 }).notNull(),
    requestedModel: varchar("requested_model", { length: 128 }).notNull(),
    requestedTier: varchar("requested_tier", { length: 64 }),
    servedTier: varchar("served_tier", { length: 64 }),
    servedTarget: varchar("served_target", { length: 255 }),
    stream: boolean("stream").notNull(),
    outcome: varchar("outcome", { length: 32 }),
    httpStatus: smallint("http_status"),
    attemptCount: smallint("attempt_count").notNull().default(0),
  },
  (table) => [
    index("requests_started").on(table.startedAt),
    index("requests_client_started").on(table.clientId, table.startedAt),
  ],
);

export const attempts = mysqlTable(
  "attempts",
  {
    requestId: char("request_id", { length: 26 }).notNull(),
    n: smallint("n").notNull(),
    targetId: varchar("target_id", { length: 255 }).notNull(),
    accountId: varchar("account_id", { length: 64 }).notNull(),
    model: varchar("model", { length: 128 }).notNull(),
    returnedModel: varchar("returned_model", { length: 128 }),
    startedAt: time("started_at").notNull(),
    ttftMs: int("ttft_ms"),
    durationMs: int("duration_ms"),
    httpStatus: smallint("http_status"),
    outcome: varchar("outcome", { length: 32 }).notNull(),
    errorCode: varchar("error_code", { length: 128 }),
    inputTokens: int("input_tokens"),
    cachedTokens: int("cached_tokens"),
    cacheWriteTokens: int("cache_write_tokens"),
    outputTokens: int("output_tokens"),
    usageComplete: boolean("usage_complete").notNull().default(true),
    costMicroUsd: bigint("cost_micro_usd", { mode: "number" }),
    listMicroUsd: bigint("list_micro_usd", { mode: "number" }),
  },
  (table) => [
    primaryKey({ columns: [table.requestId, table.n] }),
    index("attempts_account_started").on(table.accountId, table.startedAt),
  ],
);

export const spend = mysqlTable(
  "spend",
  {
    accountId: varchar("account_id", { length: 64 }).notNull(),
    period: varchar("period", { length: 16 }).notNull(),
    spentMicroUsd: bigint("spent_micro_usd", { mode: "number" }).notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.period] })],
);

export const quotaState = mysqlTable(
  "quota_state",
  {
    accountId: varchar("account_id", { length: 64 }).notNull(),
    scope: varchar("scope", { length: 160 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    retryAt: time("retry_at"),
    backoffS: int("backoff_s"),
    detail: varchar("detail", { length: 255 }),
    updatedAt: time("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.scope] })],
);

export const events = mysqlTable(
  "events",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    at: time("at").notNull(),
    kind: varchar("kind", { length: 48 }).notNull(),
    subject: varchar("subject", { length: 160 }).notNull(),
    message: varchar("message", { length: 500 }).notNull(),
  },
  (table) => [index("events_at").on(table.at)],
);
