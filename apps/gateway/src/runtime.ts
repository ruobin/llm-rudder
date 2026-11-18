import { randomUUID } from "node:crypto";
import { pino, type Logger } from "pino";
import { ClientLimits, FailedAuthThrottle } from "./auth/limits.js";
import { BudgetManager, dayPeriod, monthPeriod } from "./billing/budgets.js";
import type { Config } from "./config/load.js";
import { MemoryPersistence, type Persistence } from "./ledger/records.js";
import { FallbackEpisodes } from "./notify/episodes.js";
import { Notifier, ntfySink, webhookSink, type EventSink } from "./notify/notifier.js";
import { QuotaManager } from "./state/quota.js";
import { HttpUpstreamClient, type UpstreamClient } from "./upstream/client.js";
import { ToolExtrasStore } from "./upstream/tool-extras.js";

export interface Runtime {
  config: Config;
  log: Logger;
  now: () => number;
  instanceId: string;
  startedAt: number;
  quota: QuotaManager;
  budgets: BudgetManager;
  notifier: Notifier;
  episodes: FallbackEpisodes;
  toolExtras: ToolExtrasStore;
  upstream: UpstreamClient;
  persistence: Persistence;
  limits: ClientLimits;
  authThrottle: FailedAuthThrottle;
  meteredSeen: Set<string>;
  draining: boolean;
}

export interface RuntimeOptions {
  log?: Logger;
  now?: () => number;
  persistence?: Persistence;
  upstream?: UpstreamClient;
  sinks?: EventSink[];
}

const REDACTED_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  "authorization",
  "apiKey",
];

export function createLogger(level: string = process.env.LOG_LEVEL ?? "info"): Logger {
  return pino({ level, redact: { paths: REDACTED_PATHS, censor: "[redacted]" } });
}

export function createRuntime(config: Config, options: RuntimeOptions = {}): Runtime {
  const now = options.now ?? Date.now;
  const log = options.log ?? createLogger();
  const persistence = options.persistence ?? new MemoryPersistence();
  const instanceId = randomUUID();

  const sinks: EventSink[] = options.sinks ?? [
    ...(config.notifications.ntfyUrl ? [ntfySink(config.notifications.ntfyUrl)] : []),
    ...(config.notifications.webhookUrl ? [webhookSink(config.notifications.webhookUrl)] : []),
  ];
  const notifier = new Notifier(
    sinks,
    config.notifications.repeatAfterMs,
    now,
    persistence,
    (error) => log.warn({ err: error }, "notification delivery failed"),
  );

  const quota = new QuotaManager(now, persistence, (change) => {
    if (change.kind === "exhausted") {
      const until = change.retryAt ? ` until ${new Date(change.retryAt).toISOString()}` : "";
      notifier.clear("account_recovered", change.accountId);
      notifier.emit(
        "account_exhausted",
        change.accountId,
        `${change.accountId} is out of quota${until}.`,
      );
    } else if (change.kind === "recovered") {
      notifier.clear("account_exhausted", change.accountId);
      notifier.emit("account_recovered", change.accountId, `${change.accountId} is working again.`);
    } else {
      notifier.emit(
        "account_disabled",
        change.accountId,
        `${change.accountId} was rejected by its provider (${change.detail ?? "auth"}). Check its key, then reset it.`,
      );
    }
  });

  return {
    config,
    log,
    now,
    instanceId,
    startedAt: now(),
    quota,
    budgets: new BudgetManager(config.accounts, now, persistence),
    notifier,
    episodes: new FallbackEpisodes(notifier, now),
    toolExtras: new ToolExtrasStore(now),
    upstream: options.upstream ?? new HttpUpstreamClient(config, instanceId),
    persistence,
    limits: new ClientLimits(now),
    authThrottle: new FailedAuthThrottle(now),
    meteredSeen: new Set(),
    draining: false,
  };
}

/** Loads saved quota state and this period's spend. */
export async function restoreState(runtime: Runtime): Promise<void> {
  const now = runtime.now();
  const [quota, spend] = await Promise.all([
    runtime.persistence.loadQuota(),
    runtime.persistence.loadSpend([dayPeriod(now), monthPeriod(now)]),
  ]);
  runtime.quota.load(quota);
  runtime.budgets.load(spend);
}
