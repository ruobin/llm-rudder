import {
  bigint,
  boolean,
  char,
  datetime,
  index,
  int,
  json,
  mysqlTable,
  primaryKey,
  smallint,
  uniqueIndex,
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
    index("attempts_started").on(table.startedAt),
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

export const sessionPins = mysqlTable(
  "session_pins",
  {
    clientId: varchar("client_id", { length: 64 }).notNull(),
    sessionHash: char("session_hash", { length: 16 }).notNull(),
    tier: varchar("tier", { length: 64 }).notNull(),
    targetId: varchar("target_id", { length: 255 }).notNull(),
    updatedAt: time("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.sessionHash, table.tier] }),
    index("session_pins_updated").on(table.updatedAt),
  ],
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

/** One row per day, client, account and model. It outlives the detailed ledger. */
export const usageDaily = mysqlTable(
  "usage_daily",
  {
    day: char("day", { length: 10 }).notNull(),
    clientId: varchar("client_id", { length: 64 }).notNull(),
    accountId: varchar("account_id", { length: 64 }).notNull(),
    model: varchar("model", { length: 128 }).notNull(),
    served: int("served").notNull(),
    failed: int("failed").notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull(),
    cachedTokens: bigint("cached_tokens", { mode: "number" }).notNull(),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).notNull(),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull(),
    costMicroUsd: bigint("cost_micro_usd", { mode: "number" }).notNull(),
    listMicroUsd: bigint("list_micro_usd", { mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.day, table.clientId, table.accountId, table.model] })],
);

/** Clients created from the dashboard. Only a hash of each key is stored. */
export const clientKeys = mysqlTable(
  "client_keys",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    keyHash: char("key_hash", { length: 64 }).notNull(),
    keyPrefix: varchar("key_prefix", { length: 16 }).notNull(),
    notice: varchar("notice", { length: 8 }).notNull(),
    rpm: int("rpm"),
    maxConcurrent: int("max_concurrent").notNull(),
    allowAccounts: json("allow_accounts").$type<string[]>(),
    allowFallback: boolean("allow_fallback").notNull(),
    createdAt: time("created_at").notNull(),
    lastUsedAt: time("last_used_at"),
    revokedAt: time("revoked_at"),
  },
  (table) => [uniqueIndex("client_keys_hash").on(table.keyHash)],
);
