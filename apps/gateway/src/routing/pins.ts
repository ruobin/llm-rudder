export interface PinEntry {
  clientId: string;
  sessionHash: string;
  tier: string;
  targetId: string;
  updatedAt: number;
}

export interface PinPersistence {
  savePin(entry: PinEntry): void;
  deletePin(clientId: string, sessionHash: string, tier: string): void;
  deletePinsBefore(time: number): void;
  loadPins(since: number): Promise<PinEntry[]>;
}

/** About as long as a provider keeps a conversation's prompt cache. */
export const PIN_IDLE_MS = 10 * 60_000;
const SAVE_INTERVAL_MS = 60_000;

interface Pin {
  targetId: string;
  touchedAt: number;
  savedAt: number;
}

/**
 * Remembers which target is serving each conversation. Moving a conversation
 * means sending its whole prompt again uncached, so it stays where it is.
 */
export class PinStore {
  private readonly pins = new Map<string, Pin>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly persistence?: PinPersistence,
  ) {}

  private key = (clientId: string, sessionHash: string, tier: string) =>
    `${clientId}\u0000${sessionHash}\u0000${tier}`;

  load(entries: PinEntry[]): void {
    for (const entry of entries) {
      this.pins.set(this.key(entry.clientId, entry.sessionHash, entry.tier), {
        targetId: entry.targetId,
        touchedAt: entry.updatedAt,
        savedAt: entry.updatedAt,
      });
    }
  }

  get(clientId: string, sessionHash: string, tier: string): string | null {
    const key = this.key(clientId, sessionHash, tier);
    const pin = this.pins.get(key);
    if (!pin) return null;
    if (this.now() - pin.touchedAt >= PIN_IDLE_MS) {
      this.pins.delete(key);
      this.persistence?.deletePin(clientId, sessionHash, tier);
      return null;
    }
    return pin.targetId;
  }

  /**
   * Records the target that served a request. `seenAtStart` is the pin the request
   * began with: if it has changed since, a concurrent request got there first.
   */
  set(
    clientId: string,
    sessionHash: string,
    tier: string,
    targetId: string,
    seenAtStart: string | null,
  ): void {
    const key = this.key(clientId, sessionHash, tier);
    const now = this.now();
    const current = this.pins.get(key);
    const currentTarget =
      current && now - current.touchedAt < PIN_IDLE_MS ? current.targetId : null;
    if (currentTarget !== seenAtStart && currentTarget !== targetId) return;

    const changed = currentTarget !== targetId;
    const save = changed || now - (current?.savedAt ?? 0) >= SAVE_INTERVAL_MS;
    this.pins.set(key, {
      targetId,
      touchedAt: now,
      savedAt: save ? now : (current?.savedAt ?? now),
    });
    if (save) {
      this.persistence?.savePin({ clientId, sessionHash, tier, targetId, updatedAt: now });
    }
  }

  release(clientId: string, sessionHash: string, tier: string): void {
    if (this.pins.delete(this.key(clientId, sessionHash, tier))) {
      this.persistence?.deletePin(clientId, sessionHash, tier);
    }
  }

  /** Forgets idle conversations. */
  prune(): void {
    const cutoff = this.now() - PIN_IDLE_MS;
    for (const [key, pin] of this.pins) {
      if (pin.touchedAt < cutoff) this.pins.delete(key);
    }
    this.persistence?.deletePinsBefore(cutoff);
  }

  get size(): number {
    return this.pins.size;
  }
}
