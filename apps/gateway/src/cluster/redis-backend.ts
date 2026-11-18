import { Redis, type RedisOptions } from "ioredis";
import {
  holdMember,
  pinValue,
  type BackendEvents,
  type SharedBackend,
  type SpendWindow,
} from "./backend.js";

/** A slow answer is treated as no answer, because a request is waiting on it. */
const COMMAND_TIMEOUT_MS = 250;
const CONNECT_TIMEOUT_MS = 2_000;
const MAX_RETRY_DELAY_MS = 2_000;
const CHANNEL = "events";

/** Returns the pinned target after this attempt. */
const SET_PIN = `
local current = redis.call('HGET', KEYS[1], ARGV[1])
if current then
  local separator = string.find(current, '|', 1, true)
  local at = tonumber(string.sub(current, 1, separator - 1))
  local target = string.sub(current, separator + 1)
  local live = at + tonumber(ARGV[5]) > tonumber(ARGV[4])
  if live and target ~= ARGV[2] and target ~= ARGV[3] then return target end
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[6])
return ARGV[3]
`;

/** KEYS holds a total and a set of holds for each window. */
const RESERVE_SPEND = `
local member, amount, now, expires = ARGV[1], tonumber(ARGV[2]), ARGV[3], ARGV[4]
local windows = #KEYS / 2
for index = 1, windows do
  local total, holds = KEYS[index * 2 - 1], KEYS[index * 2]
  redis.call('ZREMRANGEBYSCORE', holds, '-inf', now)
  local limit = tonumber(ARGV[4 + index * 2 - 1])
  if limit >= 0 then
    local used = tonumber(redis.call('GET', total) or '0')
    for _, held in ipairs(redis.call('ZRANGE', holds, 0, -1)) do
      used = used + tonumber(string.match(held, ':(%d+)$'))
    end
    if used + amount > limit then return 0 end
  end
end
for index = 1, windows do
  redis.call('ZADD', KEYS[index * 2], expires, member)
  redis.call('PEXPIRE', KEYS[index * 2], ARGV[4 + index * 2])
end
return 1
`;

const SETTLE_SPEND = `
local member, actual = ARGV[1], tonumber(ARGV[2])
for index = 1, #KEYS / 2 do
  redis.call('ZREM', KEYS[index * 2], member)
  if actual > 0 then
    redis.call('INCRBY', KEYS[index * 2 - 1], actual)
    redis.call('PEXPIRE', KEYS[index * 2 - 1], ARGV[2 + index])
  end
end
return 1
`;

const COUNT_REQUEST = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return { count, redis.call('PTTL', KEYS[1]) }
`;

const TAKE_LEASE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return 1
`;

interface ScriptedRedis extends Redis {
  llmrSetPin(key: string, ...args: (string | number)[]): Promise<string>;
  llmrReserveSpend(count: number, ...args: (string | number)[]): Promise<number>;
  llmrSettleSpend(count: number, ...args: (string | number)[]): Promise<number>;
  llmrCountRequest(key: string, windowMs: number): Promise<[number, number]>;
  llmrTakeLease(key: string, ...args: (string | number)[]): Promise<number>;
}

const retryDelay = (attempt: number) => Math.min(attempt * 200, MAX_RETRY_DELAY_MS);

export class RedisBackend implements SharedBackend {
  private readonly commands: ScriptedRedis;
  private readonly subscriber: Redis;

  constructor(
    url: string,
    private readonly prefix = "llmr:",
  ) {
    const shared: RedisOptions = {
      lazyConnect: true,
      connectTimeout: CONNECT_TIMEOUT_MS,
      retryStrategy: retryDelay,
    };
    this.commands = new Redis(url, {
      ...shared,
      // Work must not queue up behind a lost connection.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      commandTimeout: COMMAND_TIMEOUT_MS,
    }) as ScriptedRedis;
    this.subscriber = new Redis(url, { ...shared, maxRetriesPerRequest: null });
    this.commands.defineCommand("llmrSetPin", { numberOfKeys: 1, lua: SET_PIN });
    this.commands.defineCommand("llmrReserveSpend", { lua: RESERVE_SPEND });
    this.commands.defineCommand("llmrSettleSpend", { lua: SETTLE_SPEND });
    this.commands.defineCommand("llmrCountRequest", { numberOfKeys: 1, lua: COUNT_REQUEST });
    this.commands.defineCommand("llmrTakeLease", { numberOfKeys: 1, lua: TAKE_LEASE });
  }

  get ready(): boolean {
    return this.commands.status === "ready";
  }

  private key(name: string): string {
    return `${this.prefix}${name}`;
  }

  async start(events: BackendEvents): Promise<void> {
    const channel = this.key(CHANNEL);
    this.commands.on("ready", () => events.onReady());
    this.commands.on("error", (error: Error) => events.onLost(error));
    this.commands.on("close", () => events.onLost(new Error("The connection closed.")));
    // The subscriber reconnects by itself, so its errors only need to be handled.
    this.subscriber.on("error", () => undefined);
    this.subscriber.on("message", (_channel: string, text: string) => events.onMessage(text));
    // Messages sent while it was away are gone, so a new subscription starts with a sync.
    this.subscriber.on("ready", () => {
      this.subscriber.subscribe(channel).then(
        () => events.onReady(),
        () => undefined,
      );
    });
    // A first failure is not fatal. Both connections keep trying in the background.
    await Promise.allSettled([this.subscriber.connect(), this.commands.connect()]);
  }

  async stop(): Promise<void> {
    this.commands.disconnect();
    this.subscriber.disconnect();
  }

  async publish(text: string): Promise<void> {
    await this.commands.publish(this.key(CHANNEL), text);
  }

  async mapSet(map: string, field: string, value: string): Promise<void> {
    await this.commands.hset(this.key(map), field, value);
  }

  async mapDelete(map: string, field: string): Promise<void> {
    await this.commands.hdel(this.key(map), field);
  }

  async mapEntries(map: string): Promise<Map<string, string>> {
    return new Map(Object.entries(await this.commands.hgetall(this.key(map))));
  }

  async claim(key: string, ttlMs: number): Promise<boolean> {
    return (await this.commands.set(this.key(key), "1", "PX", ttlMs, "NX")) === "OK";
  }

  async forceClaim(key: string, ttlMs: number): Promise<void> {
    await this.commands.set(this.key(key), "1", "PX", ttlMs);
  }

  async unclaim(key: string): Promise<void> {
    await this.commands.del(this.key(key));
  }

  async putValue(key: string, value: string, ttlMs: number): Promise<void> {
    await this.commands.set(this.key(key), value, "PX", ttlMs);
  }

  async getValues(keys: string[]): Promise<(string | null)[]> {
    if (keys.length === 0) return [];
    return this.commands.mget(keys.map((key) => this.key(key)));
  }

  setPin(
    field: string,
    expected: string | null,
    target: string,
    now: number,
    idleMs: number,
  ): Promise<string> {
    return this.commands.llmrSetPin(
      this.key("pins"),
      field,
      expected ?? "",
      target,
      now,
      idleMs,
      pinValue(now, target),
    );
  }

  private spendKeys(windows: SpendWindow[]): string[] {
    return windows.flatMap(({ id }) => [this.key(`spend:${id}`), this.key(`holds:${id}`)]);
  }

  async reserveSpend(
    windows: SpendWindow[],
    holdId: string,
    amount: number,
    now: number,
    expiresAt: number,
  ): Promise<boolean> {
    const keys = this.spendKeys(windows);
    const limits = windows.flatMap(({ limit, ttlMs }) => [limit ?? -1, ttlMs]);
    const reserved = await this.commands.llmrReserveSpend(
      keys.length,
      ...keys,
      holdMember(holdId, amount),
      amount,
      now,
      expiresAt,
      ...limits,
    );
    return reserved === 1;
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
    const keys = this.spendKeys(windows);
    await this.commands.llmrSettleSpend(
      keys.length,
      ...keys,
      holdMember(holdId, amount),
      actual,
      ...windows.map(({ ttlMs }) => ttlMs),
    );
  }

  async readSpend(windowIds: string[]): Promise<number[]> {
    if (windowIds.length === 0) return [];
    const values = await this.commands.mget(windowIds.map((id) => this.key(`spend:${id}`)));
    return values.map((value) => Number(value ?? 0));
  }

  async seedSpend(window: SpendWindow, value: number): Promise<void> {
    await this.commands.set(this.key(`spend:${window.id}`), value, "PX", window.ttlMs, "NX");
  }

  async countRequest(key: string, windowMs: number) {
    const [count, resetInMs] = await this.commands.llmrCountRequest(this.key(key), windowMs);
    return { count, resetInMs: Math.max(resetInMs, 0) };
  }

  async takeLease(
    key: string,
    leaseId: string,
    limit: number,
    now: number,
    expiresAt: number,
  ): Promise<boolean> {
    const taken = await this.commands.llmrTakeLease(
      this.key(key),
      now,
      limit,
      expiresAt,
      leaseId,
      Math.max(expiresAt - now, 1),
    );
    return taken === 1;
  }

  async returnLease(key: string, leaseId: string): Promise<void> {
    await this.commands.zrem(this.key(key), leaseId);
  }
}
