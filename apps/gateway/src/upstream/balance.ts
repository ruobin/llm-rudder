import type { AccountConfig } from "../config/load.js";
import type { Notifier } from "../notify/notifier.js";

const REQUEST_TIMEOUT_MS = 10_000;
/** New API reports this value for keys without a limit. */
const UNLIMITED_USD = 100_000_000;

export interface Balance {
  usd: number;
  checkedAt: number;
}

async function getJson(account: AccountConfig, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${account.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${account.apiKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

const numberOf = (value: unknown) => (typeof value === "number" ? value : null);

/** Asks a gateway what is left on this key. Null means it has no limit to report. */
export async function fetchBalance(account: AccountConfig): Promise<number | null> {
  if (account.compatName === "new_api") {
    const [subscription, usage] = await Promise.all([
      getJson(account, "/dashboard/billing/subscription"),
      getJson(account, "/dashboard/billing/usage"),
    ]);
    const limit = numberOf(subscription.hard_limit_usd);
    const usedCents = numberOf(usage.total_usage);
    if (limit === null || usedCents === null || limit >= UNLIMITED_USD) return null;
    return limit - usedCents / 100;
  }
  if (account.compatName === "openrouter") {
    const body = await getJson(account, "/key");
    const data = (body.data ?? {}) as Record<string, unknown>;
    return numberOf(data.limit_remaining);
  }
  return null;
}

/** Checks balances from time to time and warns before an account runs out. */
export class BalanceMonitor {
  private readonly balances = new Map<string, Balance>();

  constructor(
    private readonly accounts: () => Iterable<AccountConfig>,
    private readonly notifier: Notifier,
    private readonly now: () => number,
    private readonly onError: (accountId: string, error: unknown) => void,
  ) {}

  current(): Map<string, Balance> {
    return this.balances;
  }

  async check(): Promise<void> {
    for (const account of this.accounts()) {
      if (account.balanceWarnUsd === undefined || !account.enabled) continue;
      try {
        const usd = await fetchBalance(account);
        if (usd === null) {
          this.balances.delete(account.id);
          continue;
        }
        this.balances.set(account.id, { usd, checkedAt: this.now() });
        if (usd < account.balanceWarnUsd) {
          this.notifier.emit(
            "balance_low",
            account.id,
            `${account.id} has $${usd.toFixed(2)} left, below your warning level of $${account.balanceWarnUsd.toFixed(2)}.`,
          );
        } else {
          this.notifier.clear("balance_low", account.id);
        }
      } catch (error) {
        this.onError(account.id, error);
      }
    }
  }
}
