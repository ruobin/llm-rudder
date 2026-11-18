import {
  holdMember,
  parsePinValue,
  pinValue,
  type BackendEvents,
  type SharedBackend,
  type SpendWindow,
} from "./backend.js";

interface Expiring {
  value: string;
  expiresAt: number;
}

/**
 * Stands in for Redis inside one process, so that tests can run several gateways together
 * and take the shared state away from them.
 */
export class MemorySharedState {
  readonly maps = new Map<string, Map<string, string>>();
  readonly values = new Map<string, Expiring>();
  readonly spend = new Map<string, number>();
  readonly holds = new Map<string, Map<string, number>>();
  readonly leases = new Map<string, Map<string, number>>();
  readonly clients = new Set<MemoryBackend>();
  /** Loses every message, as a brief disconnect would. */
  dropMessages = false;
  private up = true;

  constructor(readonly now: () => number = Date.now) {}

  get available(): boolean {
    return this.up;
  }

  /** Takes the shared state away, or brings it back with its contents. */
  setAvailable(available: boolean): void {
    this.up = available;
    for (const client of this.clients) client.availabilityChanged(available);
  }

  /** Loses everything, as a restarted Redis without persistence would. */
  clear(): void {
    this.maps.clear();
    this.values.clear();
    this.spend.clear();
    this.holds.clear();
    this.leases.clear();
  }

  connect(): MemoryBackend {
    return new MemoryBackend(this);
  }
}

export class MemoryBackend implements SharedBackend {
  private events: BackendEvents | null = null;

  constructor(private readonly shared: MemorySharedState) {}

  get ready(): boolean {
    return this.events !== null && this.shared.available;
  }

  availabilityChanged(available: boolean): void {
    if (available) this.events?.onReady();
    else this.events?.onLost(new Error("The shared state is unavailable."));
  }

  deliver(text: string): void {
    this.events?.onMessage(text);
  }

  private check(): void {
    if (!this.ready) throw new Error("The shared state is unavailable.");
  }

  private map(name: string): Map<string, string> {
    let map = this.shared.maps.get(name);
    if (!map) {
      map = new Map();
      this.shared.maps.set(name, map);
    }
    return map;
  }

  private live(key: string): string | null {
    const entry = this.shared.values.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.shared.now()) {
      this.shared.values.delete(key);
      return null;
    }
    return entry.value;
  }

  private store(key: string, value: string, ttlMs: number): void {
    this.shared.values.set(key, { value, expiresAt: this.shared.now() + ttlMs });
  }

  private scored(owner: Map<string, Map<string, number>>, key: string, now: number) {
    let members = owner.get(key);
    if (!members) {
      members = new Map();
      owner.set(key, members);
    }
    for (const [member, expiresAt] of members) {
      if (expiresAt <= now) members.delete(member);
    }
    return members;
  }

  async start(events: BackendEvents): Promise<void> {
    this.events = events;
    this.shared.clients.add(this);
    if (this.shared.available) events.onReady();
  }

  async stop(): Promise<void> {
    this.shared.clients.delete(this);
    this.events = null;
  }

  async publish(text: string): Promise<void> {
    this.check();
    if (this.shared.dropMessages) return;
    for (const client of this.shared.clients) {
      // Redis delivers messages later too, so nothing may rely on them arriving at once.
      queueMicrotask(() => client.deliver(text));
    }
  }

  async mapSet(map: string, field: string, value: string): Promise<void> {
    this.check();
    this.map(map).set(field, value);
  }

  async mapDelete(map: string, field: string): Promise<void> {
    this.check();
    this.map(map).delete(field);
  }

  async mapEntries(map: string): Promise<Map<string, string>> {
    this.check();
    return new Map(this.map(map));
  }

  async claim(key: string, ttlMs: number): Promise<boolean> {
    this.check();
    if (this.live(key) !== null) return false;
    this.store(key, "1", ttlMs);
    return true;
  }

  async forceClaim(key: string, ttlMs: number): Promise<void> {
    this.check();
    this.store(key, "1", ttlMs);
  }

  async unclaim(key: string): Promise<void> {
    this.check();
    this.shared.values.delete(key);
  }

  async putValue(key: string, value: string, ttlMs: number): Promise<void> {
    this.check();
    this.store(key, value, ttlMs);
  }

  async getValues(keys: string[]): Promise<(string | null)[]> {
    this.check();
    return keys.map((key) => this.live(key));
  }

  async setPin(
    field: string,
    expected: string | null,
    target: string,
    now: number,
    idleMs: number,
  ): Promise<string> {
    this.check();
    const pins = this.map("pins");
    const stored = pins.get(field);
    const current = stored ? parsePinValue(stored) : null;
    if (
      current &&
      current.at + idleMs > now &&
      current.target !== expected &&
      current.target !== target
    ) {
      return current.target;
    }
    pins.set(field, pinValue(now, target));
    return target;
  }

  private heldIn(id: string, now: number): number {
    let total = 0;
    for (const member of this.scored(this.shared.holds, id, now).keys()) {
      total += Number(member.slice(member.lastIndexOf(":") + 1));
    }
    return total;
  }

  async reserveSpend(
    windows: SpendWindow[],
    holdId: string,
    amount: number,
    now: number,
    expiresAt: number,
  ): Promise<boolean> {
    this.check();
    for (const { id, limit } of windows) {
      const used = (this.shared.spend.get(id) ?? 0) + this.heldIn(id, now);
      if (limit !== undefined && used + amount > limit) return false;
    }
    for (const { id } of windows) {
      this.scored(this.shared.holds, id, now).set(holdMember(holdId, amount), expiresAt);
    }
    return true;
  }

  async releaseSpend(windows: SpendWindow[], holdId: string, amount: number): Promise<void> {
    await this.settleSpend(windows, holdId, amount, 0);
  }

  async settleSpend(
    windows: SpendWindow[],
    holdId: string,
    amount: number,
    actual: number,
  ): Promise<void> {
    this.check();
    for (const { id } of windows) {
      this.shared.holds.get(id)?.delete(holdMember(holdId, amount));
      if (actual > 0) this.shared.spend.set(id, (this.shared.spend.get(id) ?? 0) + actual);
    }
  }

  async readSpend(windowIds: string[]): Promise<number[]> {
    this.check();
    return windowIds.map((id) => this.shared.spend.get(id) ?? 0);
  }

  async seedSpend(window: SpendWindow, value: number): Promise<void> {
    this.check();
    if (!this.shared.spend.has(window.id)) this.shared.spend.set(window.id, value);
  }

  async countRequest(key: string, windowMs: number) {
    this.check();
    const now = this.shared.now();
    const entry = this.shared.values.get(key);
    if (!entry || entry.expiresAt <= now) {
      this.store(key, "1", windowMs);
      return { count: 1, resetInMs: windowMs };
    }
    const count = Number(entry.value) + 1;
    entry.value = String(count);
    return { count, resetInMs: entry.expiresAt - now };
  }

  async takeLease(
    key: string,
    leaseId: string,
    limit: number,
    now: number,
    expiresAt: number,
  ): Promise<boolean> {
    this.check();
    const leases = this.scored(this.shared.leases, key, now);
    if (leases.size >= limit) return false;
    leases.set(leaseId, expiresAt);
    return true;
  }

  async returnLease(key: string, leaseId: string): Promise<void> {
    this.check();
    this.shared.leases.get(key)?.delete(leaseId);
  }
}
