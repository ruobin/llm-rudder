import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SharedBackend, SpendWindow } from "../src/cluster/backend.js";
import { MemorySharedState } from "../src/cluster/memory-backend.js";
import { RedisBackend } from "../src/cluster/redis-backend.js";

const REDIS_URL = process.env.TEST_REDIS_URL;
const MINUTE = 60_000;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !check(); turn += 1) await pause(5);
}

interface Backends {
  connect(): SharedBackend;
}

const memoryBackends = (): Backends => {
  const shared = new MemorySharedState();
  return { connect: () => shared.connect() };
};
const redisBackends = (): Backends => {
  const prefix = `llmr-test:${randomUUID()}:`;
  return { connect: () => new RedisBackend(REDIS_URL!, prefix) };
};

const KINDS: [string, () => Backends][] = [
  ["memory", memoryBackends],
  ...(REDIS_URL ? ([["redis", redisBackends]] as [string, () => Backends][]) : []),
];

describe.each(KINDS)("shared state in %s", (_kind, create) => {
  let first: SharedBackend;
  let second: SharedBackend;
  const received: string[] = [];

  beforeEach(async () => {
    received.length = 0;
    const backends = create();
    first = backends.connect();
    second = backends.connect();
    const ignore = { onReady: () => undefined, onLost: () => undefined };
    await first.start({ ...ignore, onMessage: () => undefined });
    await second.start({ ...ignore, onMessage: (text) => received.push(text) });
    await until(() => first.ready && second.ready);
  });

  afterEach(async () => {
    await first.stop();
    await second.stop();
  });

  const window = (id: string, limit?: number): SpendWindow => ({
    id,
    ttlMs: MINUTE,
    ...(limit === undefined ? {} : { limit }),
  });

  it("delivers published messages to other instances", async () => {
    await pause(30); // a subscription takes effect shortly after connecting
    await first.publish("hello");
    await until(() => received.length > 0);
    expect(received).toEqual(["hello"]);
  });

  it("keeps maps", async () => {
    await first.mapSet("things", "a", "1");
    await first.mapSet("things", "b\u0000c", "2");
    await second.mapDelete("things", "a");
    expect([...(await second.mapEntries("things"))]).toEqual([["b\u0000c", "2"]]);
  });

  it("lets one instance hold a claim until it expires or is given up", async () => {
    expect(await first.claim("job", 40)).toBe(true);
    expect(await second.claim("job", 40)).toBe(false);
    await pause(60);
    expect(await second.claim("job", MINUTE)).toBe(true);
    await second.unclaim("job");
    expect(await first.claim("job", MINUTE)).toBe(true);
    await second.forceClaim("other", MINUTE);
    expect(await first.claim("other", MINUTE)).toBe(false);
  });

  it("stores values that expire", async () => {
    await first.putValue("kept", "yes", MINUTE);
    await first.putValue("brief", "soon", 30);
    await pause(50);
    expect(await second.getValues(["kept", "brief", "missing"])).toEqual(["yes", null, null]);
    expect(await second.getValues([])).toEqual([]);
  });

  describe("conversation pins", () => {
    it("lets the first move win and keeps a pin on its target", async () => {
      expect(await first.setPin("c", null, "a", 1000, MINUTE)).toBe("a");
      expect(await second.setPin("c", null, "b", 1001, MINUTE)).toBe("a");
      expect(await second.setPin("c", "a", "b", 1002, MINUTE)).toBe("b");
      expect(await first.setPin("c", "a", "c", 1003, MINUTE)).toBe("b");
      expect(await first.setPin("c", "a", "b", 1004, MINUTE)).toBe("b");
    });

    it("ignores a pin that has gone idle", async () => {
      await first.setPin("c", null, "a", 1000, MINUTE);
      expect(await second.setPin("c", null, "b", 1000 + MINUTE, MINUTE)).toBe("b");
    });
  });

  describe("budgets", () => {
    const now = 1_000_000;
    const later = now + MINUTE;

    it("never lets instances reserve more than the limit", async () => {
      const windows = [window("a|day", 100), window("a|month", 1000)];
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          (index % 2 ? first : second).reserveSpend(windows, `h${index}`, 30, now, later),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(3);
    });

    it("reserves in every window or in none", async () => {
      const day = window("b|day", 1000);
      const month = window("b|month", 50);
      expect(await first.reserveSpend([day, month], "h1", 60, now, later)).toBe(false);
      expect(await first.reserveSpend([day], "h2", 1000, now, later)).toBe(true);
    });

    it("gives back a released hold", async () => {
      const windows = [window("c|day", 100)];
      expect(await first.reserveSpend(windows, "h1", 100, now, later)).toBe(true);
      expect(await second.reserveSpend(windows, "h2", 1, now, later)).toBe(false);
      await first.releaseSpend(windows, "h1", 100);
      expect(await second.reserveSpend(windows, "h2", 1, now, later)).toBe(true);
    });

    it("replaces a hold with the real cost", async () => {
      const windows = [window("d|day", 100)];
      await first.reserveSpend(windows, "h1", 80, now, later);
      await first.settleSpend(windows, "h1", 80, 30);
      expect(await second.readSpend(["d|day", "unknown"])).toEqual([30, 0]);
      expect(await second.reserveSpend(windows, "h2", 70, now, later)).toBe(true);
      expect(await second.reserveSpend(windows, "h3", 1, now, later)).toBe(false);
    });

    it("forgets a hold whose instance never finished", async () => {
      const windows = [window("e|day", 100)];
      await first.reserveSpend(windows, "lost", 100, now, now + 10);
      expect(await second.reserveSpend(windows, "h2", 100, now + 11, later)).toBe(true);
    });

    it("allows anything in a window without a limit", async () => {
      expect(await first.reserveSpend([window("f|day")], "h1", 1e9, now, later)).toBe(true);
    });

    it("takes saved totals only when it has none", async () => {
      await first.seedSpend(window("g|day"), 40);
      await second.seedSpend(window("g|day"), 99);
      expect(await first.readSpend(["g|day"])).toEqual([40]);
    });
  });

  describe("client limits", () => {
    it("counts requests from every instance in one window", async () => {
      expect((await first.countRequest("rpm", 200)).count).toBe(1);
      const next = await second.countRequest("rpm", 200);
      expect(next.count).toBe(2);
      expect(next.resetInMs).toBeGreaterThan(0);
      expect(next.resetInMs).toBeLessThanOrEqual(200);
      await pause(230);
      expect((await first.countRequest("rpm", 200)).count).toBe(1);
    });

    it("limits how many places are taken at once", async () => {
      const now = 1_000_000;
      expect(await first.takeLease("busy", "a", 2, now, now + MINUTE)).toBe(true);
      expect(await second.takeLease("busy", "b", 2, now, now + MINUTE)).toBe(true);
      expect(await second.takeLease("busy", "c", 2, now, now + MINUTE)).toBe(false);
      await first.returnLease("busy", "a");
      expect(await second.takeLease("busy", "c", 2, now, now + MINUTE)).toBe(true);
      expect(await first.takeLease("busy", "d", 2, now + MINUTE + 1, now + 2 * MINUTE)).toBe(true);
    });
  });
});

describe("a shared state that goes away", () => {
  it("rejects calls until it comes back", async () => {
    const shared = new MemorySharedState();
    const backend = shared.connect();
    const changes: string[] = [];
    await backend.start({
      onMessage: () => undefined,
      onReady: () => changes.push("ready"),
      onLost: () => changes.push("lost"),
    });

    shared.setAvailable(false);
    expect(backend.ready).toBe(false);
    await expect(backend.claim("x", MINUTE)).rejects.toThrow("unavailable");

    shared.setAvailable(true);
    expect(await backend.claim("x", MINUTE)).toBe(true);
    expect(changes).toEqual(["ready", "lost", "ready"]);
  });
});

describe.runIf(REDIS_URL)("an unreachable Redis", () => {
  it("fails quickly instead of holding requests up", async () => {
    const backend = new RedisBackend("redis://127.0.0.1:1/0", `llmr-test:${randomUUID()}:`);
    const lost: Error[] = [];
    await backend.start({
      onMessage: () => undefined,
      onReady: () => undefined,
      onLost: (error) => lost.push(error),
    });
    const startedAt = Date.now();
    await expect(backend.claim("x", MINUTE)).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(100);
    expect(backend.ready).toBe(false);
    expect(lost.length).toBeGreaterThan(0);
    await backend.stop();
  });
});
