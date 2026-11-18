import type { AccountConfig } from "../config/load.js";
import type { Classified, Target } from "../types.js";
import { fetchBalance } from "./balance.js";

const REQUEST_TIMEOUT_MS = 5_000;
const MIN_INTERVAL_MS = 60_000;

function requestModels(account: AccountConfig): Promise<Response> {
  const headers: Record<string, string> = {};
  if (account.apiKey) {
    if (account.authHeader === "bearer") headers.authorization = `Bearer ${account.apiKey}`;
    else headers["x-api-key"] = account.apiKey;
  }
  // The base URL of a Messages account leaves out /v1.
  const messages = account.api === "anthropic.messages";
  if (messages) headers["anthropic-version"] = "2023-06-01";
  return fetch(`${account.baseUrl}${messages ? "/v1/models" : "/models"}`, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function keyIsRefused(account: AccountConfig): Promise<boolean> {
  const response = await requestModels(account);
  await response.body?.cancel();
  return response.status === 401 || response.status === 403;
}

export interface ModelList {
  status: number;
  /** Null when the service did not return a readable list. */
  ids: string[] | null;
}

/** Reads the models a service offers, in the shapes OpenAI-compatible services use. */
export async function fetchModelList(account: AccountConfig): Promise<ModelList> {
  const response = await requestModels(account);
  if (!response.ok) {
    await response.body?.cancel();
    return { status: response.status, ids: null };
  }
  const body = (await response.json().catch(() => null)) as {
    data?: unknown;
    models?: unknown;
  } | null;
  const entries = body?.data ?? body?.models;
  if (!Array.isArray(entries)) return { status: response.status, ids: null };
  const ids = entries.flatMap((entry: { id?: unknown; name?: unknown } | null) => {
    const id = entry?.id ?? entry?.name;
    // Gemini writes its model names as "models/gemini-...".
    return typeof id === "string" ? [id.replace(/^models\//, "")] : [];
  });
  return { status: response.status, ids };
}

const KEY_REFUSED: Classified = {
  outcome: "auth",
  retryElsewhere: true,
  scope: "account",
  code: "key_refused",
  message: "The service refused this key.",
};

/**
 * Asks the service itself whether a reported account problem is really about this key.
 * Returns the failure to record for the whole account, or null if the account is fine.
 */
export async function confirmAccountFailure(
  account: AccountConfig,
  failure: Classified,
): Promise<Classified | null> {
  if (await keyIsRefused(account)) return KEY_REFUSED;
  if (failure.outcome !== "quota_exhausted" && failure.outcome !== "billing") return null;
  const usd = await fetchBalance(account);
  return usd !== null && usd <= 0 ? failure : null;
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
    const check = confirmAccountFailure(account, failure)
      .then((confirmed) => {
        if (confirmed) this.onConfirmed(target, confirmed);
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
