const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;
const MAX_TRACKED = 1000;

/** Slows password guessing, per address and for the dashboard as a whole. */
export class LoginThrottle {
  private readonly failures = new Map<string, { count: number; startedAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  private current(key: string) {
    const entry = this.failures.get(key);
    if (entry && this.now() - entry.startedAt >= WINDOW_MS) {
      this.failures.delete(key);
      return undefined;
    }
    return entry;
  }

  isBlocked(address: string): boolean {
    const total = this.current("*")?.count ?? 0;
    return (this.current(address)?.count ?? 0) >= MAX_FAILURES || total >= MAX_FAILURES * 20;
  }

  recordFailure(address: string): void {
    if (this.failures.size >= MAX_TRACKED) this.failures.clear();
    for (const key of [address, "*"]) {
      const entry = this.current(key);
      if (entry) entry.count += 1;
      else this.failures.set(key, { count: 1, startedAt: this.now() });
    }
  }

  clear(address: string): void {
    this.failures.delete(address);
  }
}
