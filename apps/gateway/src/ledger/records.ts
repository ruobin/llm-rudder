import type { ClientKeyStore, StoredClientKey } from "../auth/clients.js";
import type { SpendPersistence, SpendRow } from "../billing/budgets.js";
import type { EventPersistence, RouterEvent } from "../notify/notifier.js";
import type { PinEntry, PinPersistence } from "../routing/pins.js";
import type { QuotaEntry, QuotaPersistence } from "../state/quota.js";
import type { Outcome } from "../types.js";
import { addUsage, attemptUsage, dayOf } from "./usage.js";

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

/** Totals for one day, client, account and model. */
export interface UsageRow {
  day: string;
  clientId: string;
  accountId: string;
  model: string;
  served: number;
  failed: number;
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  listMicroUsd: number;
}

export interface RequestQuery {
  limit: number;
  /** Returns requests older than this ID. */
  before?: string;
  clientId?: string;
  outcome?: string;
  tier?: string;
  model?: string;
  from?: number;
  to?: number;
}

/** Storage for the dashboard's reports and client keys. */
export interface ReportStore extends ClientKeyStore {
  usageRows(fromDay: string, toDay: string, now: number): Promise<UsageRow[]>;
  listRequests(query: RequestQuery): Promise<RequestRecord[]>;
  getRequest(id: string): Promise<LedgerEntry | null>;
  listEvents(limit: number): Promise<RouterEvent[]>;
  /** Saves daily totals for recent days, and for any older day that has none yet. */
  rollUp(now: number): Promise<void>;
  /** Deletes old detail, keeping daily totals. Returns how many rows were removed. */
  deleteOldRecords(ledgerBefore: number, eventsBefore: number): Promise<number>;
}

/** Storage used by the router. Write methods must never throw or block. */
export interface Persistence
  extends QuotaPersistence, SpendPersistence, EventPersistence, PinPersistence, ReportStore {
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
  readonly clientKeys = new Map<string, StoredClientKey>();

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

  async usageRows(fromDay: string, toDay: string): Promise<UsageRow[]> {
    const rows = new Map<string, UsageRow>();
    for (const { request, attempts } of this.ledger) {
      for (const attempt of attempts) {
        const day = dayOf(attempt.startedAt);
        if (day < fromDay || day > toDay) continue;
        addUsage(rows, attemptUsage(day, request.clientId, attempt));
      }
    }
    return [...rows.values()];
  }

  async listRequests(query: RequestQuery): Promise<RequestRecord[]> {
    return this.ledger
      .map((entry) => entry.request)
      .filter(
        (request) =>
          (query.before === undefined || request.id < query.before) &&
          (query.clientId === undefined || request.clientId === query.clientId) &&
          (query.outcome === undefined || request.outcome === query.outcome) &&
          (query.tier === undefined ||
            request.requestedTier === query.tier ||
            request.servedTier === query.tier) &&
          (query.model === undefined || request.requestedModel === query.model) &&
          (query.from === undefined || request.startedAt >= query.from) &&
          (query.to === undefined || request.startedAt < query.to),
      )
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .slice(0, query.limit);
  }

  async getRequest(id: string): Promise<LedgerEntry | null> {
    return this.ledger.find((entry) => entry.request.id === id) ?? null;
  }

  async listEvents(limit: number): Promise<RouterEvent[]> {
    return this.events.slice(-limit).reverse();
  }

  async rollUp(): Promise<void> {}

  async deleteOldRecords(ledgerBefore: number, eventsBefore: number): Promise<number> {
    const before = this.ledger.length + this.events.length;
    const ledger = this.ledger.filter((entry) => entry.request.startedAt >= ledgerBefore);
    const events = this.events.filter((event) => event.at >= eventsBefore);
    this.ledger.splice(0, this.ledger.length, ...ledger);
    this.events.splice(0, this.events.length, ...events);
    return before - this.ledger.length - this.events.length;
  }

  async loadClientKeys(): Promise<StoredClientKey[]> {
    return [...this.clientKeys.values()];
  }

  async saveClientKey(key: StoredClientKey): Promise<void> {
    if (this.clientKeys.has(key.id)) throw new Error(`Client ${key.id} already exists.`);
    this.clientKeys.set(key.id, key);
  }

  async revokeClientKey(id: string, at: number): Promise<void> {
    const key = this.clientKeys.get(id);
    if (key) key.revokedAt = at;
  }

  touchClientKey(id: string, at: number): void {
    const key = this.clientKeys.get(id);
    if (key) key.lastUsedAt = at;
  }

  async ping(): Promise<void> {}
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}
