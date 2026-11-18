import { randomUUID } from "node:crypto";
import type { SpendWindow } from "../cluster/backend.js";
import type { Cluster } from "../cluster/cluster.js";
import type { AccountConfig } from "../config/load.js";

const DAY_MS = 86_400_000;
const DAY_TOTAL_TTL_MS = 3 * DAY_MS;
const MONTH_TOTAL_TTL_MS = 40 * DAY_MS;
/** A hold outlives any normal request, and disappears if its instance dies. */
const HOLD_TTL_MS = 60 * 60_000;

export interface SpendRow {
  accountId: string;
  period: string;
  spentMicroUsd: number;
}

export interface SpendPersistence {
  addSpend(accountId: string, period: string, microUsd: number): void;
}

export interface BudgetHold {
  accountId: string;
  amount: number;
  periods: string[];
  /** Set when other instances can see this hold too. */
  shared?: { id: string; windows: SpendWindow[] };
}

interface SharedSpend {
  accountId: string;
  periods: string[];
  amount: number;
}

export interface SpendSnapshot {
  dayMicroUsd: number;
  monthMicroUsd: number;
  dayLimitMicroUsd?: number;
  monthLimitMicroUsd?: number;
}

export const dayPeriod = (now: number) => `day:${new Date(now).toISOString().slice(0, 10)}`;
export const monthPeriod = (now: number) => `month:${new Date(now).toISOString().slice(0, 7)}`;

/** Time at which an account's exhausted budget window ends. */
function nextReset(account: AccountConfig, spent: (period: string) => number, now: number) {
  const date = new Date(now);
  const monthLimit = account.budget?.monthlyMicroUsd;
  if (monthLimit !== undefined && spent(monthPeriod(now)) >= monthLimit) {
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  }
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

/** Tracks spend per account. Only metered accounts cost money. */
export class BudgetManager {
  private readonly spent = new Map<string, number>();
  private readonly reserved = new Map<string, number>();
  /** Spend from while the shared state was away, which it has yet to hear about. */
  private readonly unshared = new Map<string, number>();

  constructor(
    private accounts: Map<string, AccountConfig>,
    private readonly now: () => number = Date.now,
    private readonly persistence?: SpendPersistence,
    private readonly cluster?: Cluster,
  ) {}

  setAccounts(accounts: Map<string, AccountConfig>): void {
    this.accounts = accounts;
  }

  load(rows: SpendRow[]): void {
    for (const row of rows) this.spent.set(`${row.accountId}|${row.period}`, row.spentMicroUsd);
  }

  /** Starts following the spending of other instances. */
  joinCluster(): void {
    this.cluster?.on<SharedSpend>("budget.spent", ({ accountId, periods, amount }) =>
      this.addSpent(accountId, periods, amount),
    );
    this.cluster?.onSync(() => this.syncSpend());
    this.cluster?.on("budget.resync", () => this.cluster?.background(() => this.syncSpend()));
  }

  private addSpent(accountId: string, periods: string[], amount: number): void {
    for (const period of periods) {
      const key = `${accountId}|${period}`;
      this.spent.set(key, (this.spent.get(key) ?? 0) + amount);
    }
  }

  private spentIn(accountId: string, period: string): number {
    return this.spent.get(`${accountId}|${period}`) ?? 0;
  }

  private reservedIn(accountId: string, period: string): number {
    return this.reserved.get(`${accountId}|${period}`) ?? 0;
  }

  private limits(account: AccountConfig, now: number): { period: string; limit?: number }[] {
    return [
      { period: dayPeriod(now), limit: account.budget?.dailyMicroUsd },
      { period: monthPeriod(now), limit: account.budget?.monthlyMicroUsd },
    ];
  }

  private windows(account: AccountConfig, now: number): SpendWindow[] {
    return this.limits(account, now).map(({ period, limit }) => ({
      id: `${account.id}|${period}`,
      ttlMs: period.startsWith("day:") ? DAY_TOTAL_TTL_MS : MONTH_TOTAL_TTL_MS,
      ...(limit === undefined ? {} : { limit }),
    }));
  }

  /**
   * Whether an attempt with this estimated cost fits every budget window. With `instances`
   * above 1, only this instance's fair share of what remains counts.
   */
  allows(accountId: string, estimateMicroUsd: number, instances = 1): boolean {
    const account = this.accounts.get(accountId);
    if (!account || account.costClass !== "metered") return true;
    const now = this.now();
    return this.limits(account, now).every(
      ({ period, limit }) =>
        limit === undefined ||
        this.reservedIn(accountId, period) + estimateMicroUsd <=
          (limit - this.spentIn(accountId, period)) / instances,
    );
  }

  private hold(account: AccountConfig, amount: number): BudgetHold {
    const periods = this.limits(account, this.now()).map(({ period }) => period);
    for (const period of periods) {
      const key = `${account.id}|${period}`;
      this.reserved.set(key, (this.reserved.get(key) ?? 0) + amount);
    }
    return { accountId: account.id, amount, periods };
  }

  reserve(accountId: string, estimateMicroUsd: number, instances = 1): BudgetHold | null {
    const account = this.accounts.get(accountId);
    if (!account || account.costClass !== "metered") {
      return { accountId, amount: 0, periods: [] };
    }
    if (!this.allows(accountId, estimateMicroUsd, instances)) return null;
    return this.hold(account, estimateMicroUsd);
  }

  /**
   * Reserves across every instance when it can. Without the shared state, this instance
   * limits itself to its share of what remains, so together they stay within the budget.
   */
  async acquire(accountId: string, estimateMicroUsd: number): Promise<BudgetHold | null> {
    const account = this.accounts.get(accountId);
    const { cluster } = this;
    if (!cluster?.enabled || !account || account.costClass !== "metered") {
      return this.reserve(accountId, estimateMicroUsd);
    }
    if (!this.allows(accountId, estimateMicroUsd)) return null;
    const now = this.now();
    const amount = Math.ceil(estimateMicroUsd);
    const windows = this.windows(account, now);
    const id = randomUUID();
    const reserved = await cluster.attempt((backend) =>
      backend.reserveSpend(windows, id, amount, now, now + HOLD_TTL_MS),
    );
    if (!reserved.ok) return this.reserve(accountId, estimateMicroUsd, cluster.instanceCount);
    return reserved.value ? { ...this.hold(account, amount), shared: { id, windows } } : null;
  }

  private releaseLocal(hold: BudgetHold): void {
    for (const period of hold.periods) {
      const key = `${hold.accountId}|${period}`;
      const remaining = (this.reserved.get(key) ?? 0) - hold.amount;
      if (remaining > 0) this.reserved.set(key, remaining);
      else this.reserved.delete(key);
    }
  }

  release(hold: BudgetHold): void {
    this.releaseLocal(hold);
    const { shared } = hold;
    if (shared) {
      this.cluster?.background((backend) =>
        backend.releaseSpend(shared.windows, shared.id, hold.amount),
      );
    }
  }

  /** Replaces a reservation with the actual cost. */
  settle(hold: BudgetHold, actualMicroUsd: number): void {
    if (hold.periods.length === 0 || actualMicroUsd <= 0) {
      this.release(hold);
      return;
    }
    this.releaseLocal(hold);
    this.addSpent(hold.accountId, hold.periods, actualMicroUsd);
    for (const period of hold.periods) {
      this.persistence?.addSpend(hold.accountId, period, actualMicroUsd);
    }
    const { cluster } = this;
    if (!cluster?.enabled) return;
    const { accountId, periods, shared } = hold;
    cluster.publish("budget.spent", {
      accountId,
      periods,
      amount: actualMicroUsd,
    } satisfies SharedSpend);
    if (shared) {
      cluster.background((backend) =>
        backend.settleSpend(shared.windows, shared.id, hold.amount, Math.round(actualMicroUsd)),
      );
      return;
    }
    for (const period of periods) {
      const key = `${accountId}|${period}`;
      this.unshared.set(key, (this.unshared.get(key) ?? 0) + actualMicroUsd);
    }
  }

  /** Brings this instance and the shared totals up to date with each other. */
  private async syncSpend(): Promise<void> {
    const cluster = this.cluster as Cluster;
    const now = this.now();
    let added = false;
    for (const account of this.accounts.values()) {
      if (account.costClass !== "metered") continue;
      const windows = this.windows(account, now);
      const totals = await cluster.attempt(async (backend) => {
        for (const window of windows) {
          const pending = this.unshared.get(window.id) ?? 0;
          // After a restart of the shared state, the saved totals are the starting point.
          const known = (this.spent.get(window.id) ?? 0) - pending;
          await backend.seedSpend(window, Math.max(Math.round(known), 0));
          if (pending > 0) {
            await backend.settleSpend([window], "unshared", 0, Math.round(pending));
            this.unshared.delete(window.id);
            added = true;
          }
        }
        return backend.readSpend(windows.map(({ id }) => id));
      });
      if (!totals.ok) continue;
      windows.forEach(({ id }, index) => {
        this.spent.set(id, Math.max(this.spent.get(id) ?? 0, totals.value[index] ?? 0));
      });
    }
    if (added) cluster.publish("budget.resync", {});
  }

  /** When a budget-blocked account can next spend. */
  resetsAt(accountId: string): number | undefined {
    const account = this.accounts.get(accountId);
    if (!account?.budget) return undefined;
    const now = this.now();
    return nextReset(account, (period) => this.spentIn(accountId, period), now);
  }

  snapshot(accountId: string): SpendSnapshot {
    const account = this.accounts.get(accountId);
    const now = this.now();
    return {
      dayMicroUsd: this.spentIn(accountId, dayPeriod(now)),
      monthMicroUsd: this.spentIn(accountId, monthPeriod(now)),
      ...(account?.budget?.dailyMicroUsd === undefined
        ? {}
        : { dayLimitMicroUsd: account.budget.dailyMicroUsd }),
      ...(account?.budget?.monthlyMicroUsd === undefined
        ? {}
        : { monthLimitMicroUsd: account.budget.monthlyMicroUsd }),
    };
  }
}
