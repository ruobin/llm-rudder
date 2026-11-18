import type { AccountConfig } from "../config/load.js";
import type { Classified, Target } from "../types.js";
import { fetchBalance } from "./balance.js";

const REQUEST_TIMEOUT_MS = 5_000;
const MIN_INTERVAL_MS = 60_000;

async function keyIsRefused(account: AccountConfig): Promise<boolean> {
  const headers: Record<string, string> = {};
  if (account.apiKey) {
    if (account.authHeader === "bearer") headers.authorization = `Bearer ${account.apiKey}`;
    else headers["x-api-key"] = account.apiKey;
  }
  // The base URL of a Messages account leaves out /v1.
  const path = account.api === "anthropic.messages" ? "/v1/models" : "/models";
  const response = await fetch(`${account.baseUrl}${path}`, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await response.body?.cancel();
  return response.status === 401 || response.status === 403;
}

/** Asks the service itself whether a reported account problem is really about this key. */
export async function confirmsAccountFailure(
  account: AccountConfig,
  failure: Classified,
): Promise<boolean> {
  if (await keyIsRefused(account)) return true;
  if (failure.outcome !== "quota_exhausted") return false;
  const usd = await fetchBalance(account);
  return usd !== null && usd <= 0;
}

/**
 * Checks accounts on services that pass on their upstreams' errors. Requests move on
 * right away, and the whole account stops only if the check confirms the failure.
 */
export class AccountChecks {
  private readonly lastStarted = new Map<string, number>();
  private readonly running = new Set<Promise<void>>();

  constructor(
    private readonly now: () => number,
    private readonly onConfirmed: (target: Target, failure: Classified) => void,
    private readonly onError: (accountId: string, error: unknown) => void,
  ) {}

  request(account: AccountConfig, target: Target, failure: Classified): void {
    const startedAt = this.lastStarted.get(account.id);
    if (startedAt !== undefined && this.now() - startedAt < MIN_INTERVAL_MS) return;
    this.lastStarted.set(account.id, this.now());
    const check = confirmsAccountFailure(account, failure)
      .then((confirmed) => {
        if (confirmed) this.onConfirmed(target, failure);
      })
      .catch((error: unknown) => this.onError(account.id, error))
      .finally(() => this.running.delete(check));
    this.running.add(check);
  }

  /** Resolves when the checks in progress have finished. */
  async settled(): Promise<void> {
    await Promise.all(this.running);
  }
}
