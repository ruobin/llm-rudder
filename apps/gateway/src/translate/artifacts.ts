import type { ReasoningFamily } from "./ir.js";

const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

interface Entry {
  family: ReasoningFamily;
  accountId: string;
  items: unknown[];
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

  constructor(private readonly now: () => number = Date.now) {}

  private remove(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
  }

  set(clientId: string, callId: string, value: Omit<Entry, "bytes" | "expiresAt">): void {
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
