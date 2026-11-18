import type { ReasoningFamily } from "./ir.js";

const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export interface ReasoningEntry {
  family: ReasoningFamily;
  accountId: string;
  items: unknown[];
}

interface Entry extends ReasoningEntry {
  bytes: number;
  expiresAt: number;
}

/**
 * Keeps reasoning that a client in another format cannot carry, keyed by the
 * tool call it led to. Providers need it back during a tool loop, and it is only
 * ever returned to the same account that produced it.
 */
export class ReasoningStore {
  private readonly entries = new Map<string, Entry>();
  private totalBytes = 0;
  /** Called for each new entry, so other instances can find it. */
  onStored: ((clientId: string, callId: string, entry: ReasoningEntry) => void) | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  private remove(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
  }

  set(clientId: string, callId: string, value: ReasoningEntry): void {
    this.restore(clientId, callId, value);
    this.onStored?.(clientId, callId, value);
  }

  has(clientId: string, callId: string): boolean {
    const entry = this.entries.get(`${clientId}\u0000${callId}`);
    return entry !== undefined && entry.expiresAt > this.now();
  }

  /** Stores an entry that another instance already shared. */
  restore(clientId: string, callId: string, value: ReasoningEntry): void {
    const key = `${clientId}\u0000${callId}`;
    const existing = this.entries.get(key);
    if (existing) this.remove(key, existing);
    const bytes = JSON.stringify(value.items).length;
    if (bytes > MAX_TOTAL_BYTES) return;
    this.entries.set(key, { ...value, bytes, expiresAt: this.now() + TTL_MS });
    this.totalBytes += bytes;
    for (const [oldestKey, oldest] of this.entries) {
      if (this.totalBytes <= MAX_TOTAL_BYTES) break;
      this.remove(oldestKey, oldest);
    }
  }

  get(
    clientId: string,
    callId: string,
    family: ReasoningFamily,
    accountId: string,
  ): unknown[] | undefined {
    const key = `${clientId}\u0000${callId}`;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.remove(key, entry);
      return undefined;
    }
    return entry.family === family && entry.accountId === accountId ? entry.items : undefined;
  }
}
