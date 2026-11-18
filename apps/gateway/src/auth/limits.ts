import { randomUUID } from "node:crypto";
import type { Cluster } from "../cluster/cluster.js";
import type { ClientConfig } from "../config/load.js";
import { RouterError } from "../errors.js";

const WINDOW_MS = 60_000;
const MAX_FAILURES_PER_WINDOW = 10;
const MAX_TRACKED_ADDRESSES = 10_000;
/** A place held by a request. It expires by itself if the instance dies. */
const LEASE_TTL_MS = 60 * 60_000;

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

const overRate = (client: ClientConfig, retryAfterS: number) =>
  new RouterError(
    429,
    "client_rate_limited",
    `Client ${client.id} is over its limit of ${client.rpm} requests per minute.`,
    "rate_limit_error",
    { "retry-after": String(retryAfterS) },
  );

const overConcurrency = (client: ClientConfig) =>
  new RouterError(
    429,
    "client_concurrency_limited",
    `Client ${client.id} is over its limit of ${client.maxConcurrent} concurrent requests.`,
    "rate_limit_error",
    { "retry-after": "1" },
  );

/** Per-client request rate and concurrency limits, shared by every instance when possible. */
export class ClientLimits {
  private readonly state = new Map<
    string,
    { active: number; windowStart: number; count: number }
  >();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly cluster?: Cluster,
  ) {}

  activeRequests(): number {
    let total = 0;
    for (const entry of this.state.values()) total += entry.active;
    return total;
  }

  /** Applies the limits across instances. Returns null if the shared state is unavailable. */
  private async acquireShared(client: ClientConfig): Promise<(() => void) | null> {
    const cluster = this.cluster as Cluster;
    if (client.rpm !== undefined) {
      const counted = await cluster.attempt((backend) =>
        backend.countRequest(`rpm:${client.id}`, WINDOW_MS),
      );
      if (!counted.ok) return null;
      if (counted.value.count > client.rpm) {
        throw overRate(client, Math.max(1, Math.ceil(counted.value.resetInMs / 1000)));
      }
    }
    const key = `active:${client.id}`;
    const leaseId = randomUUID();
    const now = this.now();
    const leased = await cluster.attempt((backend) =>
      backend.takeLease(key, leaseId, client.maxConcurrent, now, now + LEASE_TTL_MS),
    );
    if (!leased.ok) return null;
    if (!leased.value) throw overConcurrency(client);
    return () => cluster.background((backend) => backend.returnLease(key, leaseId));
  }

  private track(client: ClientConfig, enforce: boolean): () => void {
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
    if (enforce && client.rpm !== undefined && entry.count >= client.rpm) {
      throw overRate(client, Math.max(1, Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000)));
    }
    if (enforce && entry.active >= client.maxConcurrent) throw overConcurrency(client);
    entry.count += 1;
    entry.active += 1;
    const held = entry;
    return () => {
      held.active -= 1;
    };
  }

  async acquire(client: ClientConfig): Promise<() => void> {
    const shared = this.cluster?.connected ? await this.acquireShared(client) : null;
    const local = this.track(client, shared === null);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      local();
      shared?.();
    };
  }
}
