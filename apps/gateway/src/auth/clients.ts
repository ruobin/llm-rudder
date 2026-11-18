import type { ClientConfig } from "../config/load.js";
import type { NoticeMode } from "../types.js";
import { generateKey, hashKey, keysMatch } from "./keys.js";

const TOUCH_INTERVAL_MS = 60_000;
const KEY_PREFIX_LENGTH = 12;
const DEFAULT_MAX_CONCURRENT = 32;

/** A client created from the dashboard. The key itself is never stored. */
export interface StoredClientKey {
  id: string;
  /** SHA-256 of the key, in hex. */
  keyHash: string;
  keyPrefix: string;
  notice: NoticeMode;
  rpm?: number;
  maxConcurrent: number;
  allowAccounts?: string[];
  allowFallback: boolean;
  createdAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
}

export interface ClientKeyStore {
  loadClientKeys(): Promise<StoredClientKey[]>;
  /** Resolves once the key is stored, and rejects if the ID already exists. */
  saveClientKey(key: StoredClientKey): Promise<void>;
  revokeClientKey(id: string, at: number): Promise<void>;
  touchClientKey(id: string, at: number): void;
}

export interface NewClient {
  id: string;
  notice?: NoticeMode;
  rpm?: number;
  maxConcurrent?: number;
  allowAccounts?: string[];
  allowFallback?: boolean;
}

export class ClientConflictError extends Error {}

interface ManagedClient {
  stored: StoredClientKey;
  client: ClientConfig;
  touchedAt: number;
}

function toClient(key: StoredClientKey): ClientConfig {
  return {
    id: key.id,
    keyHash: Buffer.from(key.keyHash, "hex"),
    notice: key.notice,
    maxConcurrent: key.maxConcurrent,
    allowFallback: key.allowFallback,
    edge: false,
    ...(key.rpm === undefined ? {} : { rpm: key.rpm }),
    ...(key.allowAccounts ? { allowAccounts: new Set(key.allowAccounts) } : {}),
  };
}

/** Every client that may call the gateway, from the config file or the dashboard. */
export class ClientRegistry {
  private readonly managed = new Map<string, ManagedClient>();

  constructor(
    private configClients: ClientConfig[],
    private readonly store: ClientKeyStore,
    private readonly now: () => number = Date.now,
  ) {}

  load(keys: StoredClientKey[]): void {
    for (const stored of keys) {
      this.managed.set(stored.id, { stored, client: toClient(stored), touchedAt: 0 });
    }
  }

  setConfigClients(clients: ClientConfig[]): void {
    this.configClients = clients;
  }

  /** Every key is compared, so timing does not reveal which one was close. */
  authenticate(presented: Buffer): ClientConfig | null {
    let match: ClientConfig | null = null;
    let matchedManaged: ManagedClient | null = null;
    for (const client of this.configClients) {
      if (keysMatch(presented, client.keyHash)) match = client;
    }
    for (const entry of this.managed.values()) {
      if (keysMatch(presented, entry.client.keyHash) && entry.stored.revokedAt === undefined) {
        match = entry.client;
        matchedManaged = entry;
      }
    }
    if (matchedManaged) this.touch(matchedManaged);
    return match;
  }

  private touch(entry: ManagedClient): void {
    const now = this.now();
    entry.stored.lastUsedAt = now;
    if (now - entry.touchedAt < TOUCH_INTERVAL_MS) return;
    entry.touchedAt = now;
    this.store.touchClientKey(entry.stored.id, now);
  }

  /** Creates a client and returns its key, which cannot be shown again. */
  async create(input: NewClient): Promise<{ key: string; stored: StoredClientKey }> {
    const taken =
      this.managed.has(input.id) || this.configClients.some((client) => client.id === input.id);
    if (taken) throw new ClientConflictError(`Client "${input.id}" already exists.`);
    const key = generateKey();
    const stored: StoredClientKey = {
      id: input.id,
      keyHash: hashKey(key).toString("hex"),
      keyPrefix: key.slice(0, KEY_PREFIX_LENGTH),
      notice: input.notice ?? "none",
      maxConcurrent: input.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
      allowFallback: input.allowFallback ?? true,
      createdAt: this.now(),
      ...(input.rpm === undefined ? {} : { rpm: input.rpm }),
      ...(input.allowAccounts ? { allowAccounts: input.allowAccounts } : {}),
    };
    await this.store.saveClientKey(stored);
    this.managed.set(stored.id, { stored, client: toClient(stored), touchedAt: 0 });
    return { key, stored };
  }

  /** Stops a dashboard client's key from working. Config clients cannot be revoked here. */
  async revoke(id: string): Promise<"revoked" | "unknown" | "from_config"> {
    if (this.configClients.some((client) => client.id === id)) return "from_config";
    const entry = this.managed.get(id);
    if (!entry) return "unknown";
    if (entry.stored.revokedAt === undefined) {
      const at = this.now();
      await this.store.revokeClientKey(id, at);
      entry.stored.revokedAt = at;
    }
    return "revoked";
  }

  list() {
    const fromConfig = this.configClients.map((client) => ({
      id: client.id,
      source: "config" as const,
      notice: client.notice,
      maxConcurrent: client.maxConcurrent,
      allowFallback: client.allowFallback,
      edge: client.edge,
      ...(client.rpm === undefined ? {} : { rpm: client.rpm }),
      ...(client.allowAccounts ? { allowAccounts: [...client.allowAccounts] } : {}),
    }));
    const managed = [...this.managed.values()].map(({ stored }) => ({
      id: stored.id,
      source: "dashboard" as const,
      notice: stored.notice,
      maxConcurrent: stored.maxConcurrent,
      allowFallback: stored.allowFallback,
      edge: false,
      keyPrefix: stored.keyPrefix,
      createdAt: new Date(stored.createdAt).toISOString(),
      ...(stored.rpm === undefined ? {} : { rpm: stored.rpm }),
      ...(stored.allowAccounts ? { allowAccounts: stored.allowAccounts } : {}),
      ...(stored.lastUsedAt === undefined
        ? {}
        : { lastUsedAt: new Date(stored.lastUsedAt).toISOString() }),
      ...(stored.revokedAt === undefined
        ? {}
        : { revokedAt: new Date(stored.revokedAt).toISOString() }),
    }));
    return [...fromConfig, ...managed];
  }
}
