import type { SpendPersistence, SpendRow } from "../billing/budgets.js";
import type { EventPersistence, RouterEvent } from "../notify/notifier.js";
import type { PinEntry, PinPersistence } from "../routing/pins.js";
import type { QuotaEntry, QuotaPersistence } from "../state/quota.js";
import type { Outcome } from "../types.js";

export interface RequestRecord {
  id: string;
  startedAt: number;
  finishedAt: number;
  clientId: string;
  sessionHash: string;
  requestedModel: string;
  requestedTier: string | null;
  servedTier: string | null;
  servedTarget: string | null;
  stream: boolean;
  outcome: Outcome;
  httpStatus: number | null;
  attemptCount: number;
}

export interface AttemptRecord {
  requestId: string;
  n: number;
  targetId: string;
  accountId: string;
  model: string;
  returnedModel: string | null;
  startedAt: number;
  ttftMs: number | null;
  durationMs: number;
  httpStatus: number | null;
  outcome: Outcome;
  errorCode: string | null;
  inputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  usageComplete: boolean;
  costMicroUsd: number | null;
  listMicroUsd: number | null;
}

export interface LedgerEntry {
  request: RequestRecord;
  attempts: AttemptRecord[];
}

/** Storage used by the router. Write methods must never throw or block. */
export interface Persistence
  extends QuotaPersistence, SpendPersistence, EventPersistence, PinPersistence {
  loadQuota(): Promise<QuotaEntry[]>;
  loadSpend(periods: string[]): Promise<SpendRow[]>;
  saveLedger(entry: LedgerEntry): void;
  ping(): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** Keeps everything in memory, for development, tests and running without MySQL. */
export class MemoryPersistence implements Persistence {
  readonly quota = new Map<string, QuotaEntry>();
  readonly spend = new Map<string, number>();
  readonly ledger: LedgerEntry[] = [];
  readonly events: RouterEvent[] = [];
  readonly pins = new Map<string, PinEntry>();

  async loadQuota(): Promise<QuotaEntry[]> {
    return [...this.quota.values()];
  }

  async loadSpend(periods: string[]): Promise<SpendRow[]> {
    const rows: SpendRow[] = [];
    for (const [key, spentMicroUsd] of this.spend) {
      const [accountId, period] = key.split("|") as [string, string];
      if (periods.includes(period)) rows.push({ accountId, period, spentMicroUsd });
    }
    return rows;
  }

  saveQuota(entry: QuotaEntry): void {
    this.quota.set(`${entry.accountId}\u0000${entry.scope}`, entry);
  }

  deleteQuota(accountId: string, scope: string): void {
    this.quota.delete(`${accountId}\u0000${scope}`);
  }

  addSpend(accountId: string, period: string, microUsd: number): void {
    const key = `${accountId}|${period}`;
    this.spend.set(key, (this.spend.get(key) ?? 0) + microUsd);
  }

  savePin(entry: PinEntry): void {
    this.pins.set(`${entry.clientId}\u0000${entry.sessionHash}\u0000${entry.tier}`, entry);
  }

  deletePin(clientId: string, sessionHash: string, tier: string): void {
    this.pins.delete(`${clientId}\u0000${sessionHash}\u0000${tier}`);
  }

  deletePinsBefore(time: number): void {
    for (const [key, entry] of this.pins) {
      if (entry.updatedAt < time) this.pins.delete(key);
    }
  }

  async loadPins(since: number): Promise<PinEntry[]> {
    return [...this.pins.values()].filter((entry) => entry.updatedAt >= since);
  }

  saveEvent(event: RouterEvent): void {
    this.events.push(event);
    if (this.events.length > 1000) this.events.shift();
  }

  saveLedger(entry: LedgerEntry): void {
    this.ledger.push(entry);
    if (this.ledger.length > 1000) this.ledger.shift();
  }

  async ping(): Promise<void> {}
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}
