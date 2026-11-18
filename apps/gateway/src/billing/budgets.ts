import type { AccountConfig } from "../config/load.js";

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

  constructor(
    private readonly accounts: Map<string, AccountConfig>,
    private readonly now: () => number = Date.now,
    private readonly persistence?: SpendPersistence,
  ) {}

  load(rows: SpendRow[]): void {
    for (const row of rows) this.spent.set(`${row.accountId}|${row.period}`, row.spentMicroUsd);
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

  /** Whether an attempt with this estimated cost fits every budget window. */
  allows(accountId: string, estimateMicroUsd: number): boolean {
    const account = this.accounts.get(accountId);
    if (!account || account.costClass !== "metered") return true;
    const now = this.now();
    return this.limits(account, now).every(
      ({ period, limit }) =>
        limit === undefined ||
        this.spentIn(accountId, period) + this.reservedIn(accountId, period) + estimateMicroUsd <=
          limit,
    );
  }

  reserve(accountId: string, estimateMicroUsd: number): BudgetHold | null {
    const account = this.accounts.get(accountId);
    if (!account || account.costClass !== "metered") {
      return { accountId, amount: 0, periods: [] };
    }
    if (!this.allows(accountId, estimateMicroUsd)) return null;
    const periods = this.limits(account, this.now()).map(({ period }) => period);
    for (const period of periods) {
      const key = `${accountId}|${period}`;
      this.reserved.set(key, (this.reserved.get(key) ?? 0) + estimateMicroUsd);
    }
    return { accountId, amount: estimateMicroUsd, periods };
  }

  release(hold: BudgetHold): void {
    for (const period of hold.periods) {
      const key = `${hold.accountId}|${period}`;
      const remaining = (this.reserved.get(key) ?? 0) - hold.amount;
      if (remaining > 0) this.reserved.set(key, remaining);
      else this.reserved.delete(key);
    }
  }

  /** Replaces a reservation with the actual cost. */
  settle(hold: BudgetHold, actualMicroUsd: number): void {
    this.release(hold);
    if (hold.periods.length === 0 || actualMicroUsd <= 0) return;
    for (const period of hold.periods) {
      const key = `${hold.accountId}|${period}`;
      this.spent.set(key, (this.spent.get(key) ?? 0) + actualMicroUsd);
      this.persistence?.addSpend(hold.accountId, period, actualMicroUsd);
    }
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
