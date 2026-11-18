import type { Runtime } from "../runtime.js";
import type { AttemptRecord, UsageRow } from "./records.js";

const DAY_MS = 86_400_000;

/** Days whose totals are read straight from the ledger, so they are never stale. */
export const LIVE_USAGE_DAYS = 3;

export const startOfDay = (time: number): number => Math.floor(time / DAY_MS) * DAY_MS;
export const dayOf = (time: number): string => new Date(time).toISOString().slice(0, 10);

export function attemptUsage(day: string, clientId: string, attempt: AttemptRecord): UsageRow {
  return {
    day,
    clientId,
    accountId: attempt.accountId,
    model: attempt.model,
    served: attempt.outcome === "ok" ? 1 : 0,
    failed: attempt.outcome === "ok" || attempt.outcome === "client_aborted" ? 0 : 1,
    inputTokens: attempt.inputTokens ?? 0,
    cachedTokens: attempt.cachedTokens ?? 0,
    cacheWriteTokens: attempt.cacheWriteTokens ?? 0,
    outputTokens: attempt.outputTokens ?? 0,
    costMicroUsd: attempt.costMicroUsd ?? 0,
    listMicroUsd: attempt.listMicroUsd ?? 0,
  };
}

type Totals = Omit<UsageRow, "day" | "clientId" | "accountId" | "model">;

const TOTAL_FIELDS = [
  "served",
  "failed",
  "inputTokens",
  "cachedTokens",
  "cacheWriteTokens",
  "outputTokens",
  "costMicroUsd",
  "listMicroUsd",
] as const satisfies readonly (keyof Totals)[];

function add(target: Totals, row: Totals): void {
  for (const field of TOTAL_FIELDS) target[field] += row[field];
}

const emptyTotals = (): Totals => ({
  served: 0,
  failed: 0,
  inputTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  costMicroUsd: 0,
  listMicroUsd: 0,
});

/** Adds a row to totals grouped by day, client, account and model. */
export function addUsage(rows: Map<string, UsageRow>, row: UsageRow): void {
  const key = [row.day, row.clientId, row.accountId, row.model].join("\u0000");
  const existing = rows.get(key);
  if (existing) add(existing, row);
  else rows.set(key, { ...row });
}

function present(totals: Totals) {
  const { costMicroUsd, listMicroUsd, ...rest } = totals;
  return {
    ...rest,
    costUsd: costMicroUsd / 1_000_000,
    listValueUsd: listMicroUsd / 1_000_000,
  };
}

function groupBy<K extends string>(rows: UsageRow[], name: K, keyOf: (row: UsageRow) => string) {
  const groups = new Map<string, Totals>();
  for (const row of rows) {
    const key = keyOf(row);
    let totals = groups.get(key);
    if (!totals) {
      totals = emptyTotals();
      groups.set(key, totals);
    }
    add(totals, row);
  }
  return [...groups].map(([key, totals]) => ({ [name]: key, ...present(totals) })) as ({
    [P in K]: string;
  } & ReturnType<typeof present>)[];
}

const byValue = (a: { listValueUsd: number }, b: { listValueUsd: number }) =>
  b.listValueUsd - a.listValueUsd;

/** Turns stored totals into the views the dashboard shows. */
export function buildUsageReport(rows: UsageRow[], from: string, to: string) {
  const totals = emptyTotals();
  for (const row of rows) add(totals, row);

  const recordedDays = new Map(groupBy(rows, "day", (row) => row.day).map((d) => [d.day, d]));
  const byDay = [];
  for (let time = Date.parse(`${from}T00:00:00Z`); dayOf(time) <= to; time += DAY_MS) {
    const day = dayOf(time);
    byDay.push(recordedDays.get(day) ?? { day, ...present(emptyTotals()) });
  }
  return {
    from,
    to,
    totals: present(totals),
    byDay,
    byClient: groupBy(rows, "clientId", (row) => row.clientId).sort(byValue),
    byAccount: groupBy(rows, "accountId", (row) => row.accountId).sort(byValue),
    byModel: groupBy(rows, "model", (row) => row.model).sort(byValue),
  };
}

/** Saves daily totals, then removes detail older than the retention settings. */
export async function runLedgerMaintenance(runtime: Runtime): Promise<void> {
  const { persistence, config, log } = runtime;
  const now = runtime.now();
  try {
    await persistence.flush();
    await persistence.rollUp(now);
    const removed = await persistence.deleteOldRecords(
      startOfDay(now) - config.retention.ledgerDays * DAY_MS,
      startOfDay(now) - config.retention.eventsDays * DAY_MS,
    );
    if (removed > 0) log.info({ removed }, "old request records were removed");
  } catch (error) {
    log.warn({ err: error }, "ledger maintenance failed");
  }
}
