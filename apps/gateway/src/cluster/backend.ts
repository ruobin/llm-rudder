/** One budget period that a reservation counts against. */
export interface SpendWindow {
  /** Names the account and period, such as "openai-key|day:2026-11-19". */
  id: string;
  /** The most that may be spent in this period, in micro-dollars. */
  limit?: number;
  /** How long the period's totals are worth keeping. */
  ttlMs: number;
}

export interface BackendEvents {
  onMessage(text: string): void;
  /** The connection is usable, for the first time or again. */
  onReady(): void;
  onLost(error: Error): void;
}

/**
 * What several gateway instances share. Every method either finishes as one atomic step
 * or rejects, and callers carry on with their own state when it rejects.
 */
export interface SharedBackend {
  readonly ready: boolean;
  start(events: BackendEvents): Promise<void>;
  stop(): Promise<void>;

  /** Sends a message to every instance. */
  publish(text: string): Promise<void>;

  mapSet(map: string, field: string, value: string): Promise<void>;
  mapDelete(map: string, field: string): Promise<void>;
  mapEntries(map: string): Promise<Map<string, string>>;

  /** Takes a key if nobody holds it. Returns whether this caller got it. */
  claim(key: string, ttlMs: number): Promise<boolean>;
  /** Takes a key even if somebody holds it. */
  forceClaim(key: string, ttlMs: number): Promise<void>;
  unclaim(key: string): Promise<void>;

  putValue(key: string, value: string, ttlMs: number): Promise<void>;
  getValues(keys: string[]): Promise<(string | null)[]>;

  /**
   * Moves a conversation to a target, unless another instance already moved it somewhere
   * other than `expected`. Returns the target that now holds the conversation.
   */
  setPin(
    field: string,
    expected: string | null,
    target: string,
    now: number,
    idleMs: number,
  ): Promise<string>;

  /** Holds an amount in every window, or in none if any would go over its limit. */
  reserveSpend(
    windows: SpendWindow[],
    holdId: string,
    amount: number,
    now: number,
    expiresAt: number,
  ): Promise<boolean>;
  releaseSpend(windows: SpendWindow[], holdId: string, amount: number): Promise<void>;
  /** Replaces a hold with what the request actually cost. */
  settleSpend(
    windows: SpendWindow[],
    holdId: string,
    amount: number,
    actual: number,
  ): Promise<void>;
  readSpend(windowIds: string[]): Promise<number[]>;
  /** Sets a window's total from saved records, unless it already has one. */
  seedSpend(window: SpendWindow, value: number): Promise<void>;

  /** Counts a request in a fixed window. */
  countRequest(key: string, windowMs: number): Promise<{ count: number; resetInMs: number }>;
  /** Takes one of a limited number of places, each of which expires by itself. */
  takeLease(
    key: string,
    leaseId: string,
    limit: number,
    now: number,
    expiresAt: number,
  ): Promise<boolean>;
  returnLease(key: string, leaseId: string): Promise<void>;
}

export const holdMember = (holdId: string, amount: number) => `${holdId}:${amount}`;

/** The value stored for a pinned conversation. */
export const pinValue = (at: number, target: string) => `${at}|${target}`;

export function parsePinValue(value: string): { at: number; target: string } | null {
  const separator = value.indexOf("|");
  if (separator < 1) return null;
  const at = Number(value.slice(0, separator));
  return Number.isFinite(at) ? { at, target: value.slice(separator + 1) } : null;
}
