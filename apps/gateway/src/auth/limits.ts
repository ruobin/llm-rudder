import type { ClientConfig } from "../config/load.js";
import { RouterError } from "../errors.js";

const WINDOW_MS = 60_000;
const MAX_FAILURES_PER_WINDOW = 10;
const MAX_TRACKED_ADDRESSES = 10_000;

/** Slows down key guessing by blocking addresses with repeated auth failures. */
export class FailedAuthThrottle {
  private readonly failures = new Map<string, { count: number; windowStart: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  isBlocked(address: string): boolean {
    const entry = this.failures.get(address);
    if (!entry) return false;
    if (this.now() - entry.windowStart >= WINDOW_MS) {
      this.failures.delete(address);
      return false;
    }
    return entry.count >= MAX_FAILURES_PER_WINDOW;
  }

  recordFailure(address: string): void {
    const now = this.now();
    const entry = this.failures.get(address);
    if (!entry || now - entry.windowStart >= WINDOW_MS) {
      if (this.failures.size >= MAX_TRACKED_ADDRESSES) this.prune(now);
      this.failures.set(address, { count: 1, windowStart: now });
    } else {
      entry.count += 1;
    }
  }

  private prune(now: number): void {
    for (const [address, entry] of this.failures) {
      if (now - entry.windowStart >= WINDOW_MS) this.failures.delete(address);
    }
    if (this.failures.size >= MAX_TRACKED_ADDRESSES) this.failures.clear();
  }
}

/** Per-client request rate and concurrency limits. */
export class ClientLimits {
  private readonly state = new Map<
    string,
    { active: number; windowStart: number; count: number }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  activeRequests(): number {
    let total = 0;
    for (const entry of this.state.values()) total += entry.active;
    return total;
  }

  acquire(client: ClientConfig): () => void {
    const now = this.now();
    let entry = this.state.get(client.id);
    if (!entry) {
      entry = { active: 0, windowStart: now, count: 0 };
      this.state.set(client.id, entry);
    }
    if (now - entry.windowStart >= WINDOW_MS) {
      entry.windowStart = now;
      entry.count = 0;
    }
    if (client.rpm !== undefined && entry.count >= client.rpm) {
      const retryAfter = Math.max(1, Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000));
      throw new RouterError(
        429,
        "client_rate_limited",
        `Client ${client.id} is over its limit of ${client.rpm} requests per minute.`,
        "rate_limit_error",
        { "retry-after": String(retryAfter) },
      );
    }
    if (entry.active >= client.maxConcurrent) {
      throw new RouterError(
        429,
        "client_concurrency_limited",
        `Client ${client.id} is over its limit of ${client.maxConcurrent} concurrent requests.`,
        "rate_limit_error",
        { "retry-after": "1" },
      );
    }
    entry.count += 1;
    entry.active += 1;
    const held = entry;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        held.active -= 1;
      }
    };
  }
}
