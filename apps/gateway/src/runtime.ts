import { randomUUID } from "node:crypto";
import { chatGptEndpoints, CHATGPT_USAGE_URL, type ChatGptEndpoints } from "@llm-rudder/shared";
import { pino, type Logger } from "pino";
import { ClientRegistry } from "./auth/clients.js";
import { ClientLimits, FailedAuthThrottle } from "./auth/limits.js";
import { BudgetManager, dayPeriod, monthPeriod } from "./billing/budgets.js";
import { ChatGptSession, credentialPath, SIGN_IN_COMMAND } from "./chatgpt/session.js";
import type { Config } from "./config/load.js";
import { MemoryPersistence, type Persistence } from "./ledger/records.js";
import { Metrics } from "./metrics.js";
import { FallbackEpisodes } from "./notify/episodes.js";
import {
  Notifier,
  ntfySink,
  telegramSink,
  webhookSink,
  type EventSink,
} from "./notify/notifier.js";
import { QuotaManager } from "./state/quota.js";
import { PIN_IDLE_MS, PinStore } from "./routing/pins.js";
import { ReasoningStore } from "./translate/artifacts.js";
import { BalanceMonitor } from "./upstream/balance.js";
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
  reasoning: ReasoningStore;
  pins: PinStore;
  /** One signed-in session for each ChatGPT plan account. */
  chatgpt: Map<string, ChatGptSession>;
  upstream: UpstreamClient;
  persistence: Persistence;
  /** Clients from the config file and from the dashboard. */
  clients: ClientRegistry;
  metrics: Metrics;
  balances: BalanceMonitor;
  limits: ClientLimits;
  authThrottle: FailedAuthThrottle;
  meteredSeen: Set<string>;
  /** The latest report from each connected edge. */
  edgeReports: Map<string, EdgeStatus>;
  draining: boolean;
}

export interface EdgeStatus {
  at: number;
  edgeVersion: string;
  usage: Record<string, number>;
}

export interface RuntimeOptions {
  log?: Logger;
  now?: () => number;
  persistence?: Persistence;
  upstream?: UpstreamClient;
  sinks?: EventSink[];
  /** Where sign-ins are kept. */
  stateDir?: string;
  chatGptEndpoints?: ChatGptEndpoints;
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

function chatGptRejection(accountId: string, detail = "auth"): string {
  if (detail === "subscription_sharing_user_not_eligible") {
    return `OpenAI says ${accountId} cannot use its ChatGPT plan here (${detail}). Signing in again will not change that.`;
  }
  if (detail === "chatgpt_admission_denied") {
    return `OpenAI refused requests from ${accountId}, possibly because of account policy or the VPS region (${detail}).`;
  }
  return `${accountId} needs a new ChatGPT sign-in (${detail}). Run: ${SIGN_IN_COMMAND}`;
}

export function createRuntime(config: Config, options: RuntimeOptions = {}): Runtime {
  const now = options.now ?? Date.now;
  const log = options.log ?? createLogger();
  const persistence = options.persistence ?? new MemoryPersistence();
  const instanceId = randomUUID();

  const sinks: EventSink[] = options.sinks ?? [
    ...(config.notifications.ntfyUrl ? [ntfySink(config.notifications.ntfyUrl)] : []),
    ...(config.notifications.webhookUrl ? [webhookSink(config.notifications.webhookUrl)] : []),
    ...(config.notifications.telegram
      ? [telegramSink(config.notifications.telegram.botToken, config.notifications.telegram.chatId)]
      : []),
  ];
  const notifier = new Notifier(
    sinks,
    config.notifications.repeatAfterMs,
    now,
    persistence,
    (error) => log.warn({ err: error }, "notification delivery failed"),
  );

  const isChatGptPlan = (accountId: string) =>
    config.accounts.get(accountId)?.kind === "chatgpt_plan";

  const quota = new QuotaManager(now, persistence, (change) => {
    if (change.kind === "exhausted") {
      const until = change.retryAt ? ` until ${new Date(change.retryAt).toISOString()}` : "";
      notifier.clear("account_recovered", change.accountId);
      notifier.emit(
        "account_exhausted",
        change.accountId,
        isChatGptPlan(change.accountId)
          ? `${change.accountId} reached a ChatGPT usage limit, so it is paused and rechecked ` +
              `from time to time. Manage usage: ${CHATGPT_USAGE_URL}`
          : `${change.accountId} is out of quota${until}.`,
      );
    } else if (change.kind === "recovered") {
      notifier.clear("account_exhausted", change.accountId);
      notifier.emit("account_recovered", change.accountId, `${change.accountId} is working again.`);
    } else {
      notifier.emit(
        "account_disabled",
        change.accountId,
        isChatGptPlan(change.accountId)
          ? chatGptRejection(change.accountId, change.detail)
          : `${change.accountId} was rejected by its provider (${change.detail ?? "auth"}). Check its key, then reset it.`,
      );
    }
  });

  const stateDir = options.stateDir ?? process.env.LLMR_STATE_DIR ?? "data";
  const endpoints = options.chatGptEndpoints ?? chatGptEndpoints();
  const chatgpt = new Map<string, ChatGptSession>();
  for (const account of config.accounts.values()) {
    if (account.kind !== "chatgpt_plan") continue;
    chatgpt.set(
      account.id,
      new ChatGptSession({
        file: credentialPath(stateDir, account.id),
        endpoints,
        now,
        onSignInRequired: (code) => quota.disable(account.id, code),
        onSignedIn: () => {
          const wasBlocked = quota.reset(account.id) > 0;
          notifier.clear("account_disabled", account.id);
          notifier.clear("account_exhausted", account.id);
          if (wasBlocked) {
            notifier.emit("account_recovered", account.id, `${account.id} is signed in again.`);
          }
        },
        onWarning: (message) => log.warn({ account: account.id }, message),
      }),
    );
  }

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
    reasoning: new ReasoningStore(now),
    pins: new PinStore(now, persistence),
    chatgpt,
    upstream: options.upstream ?? new HttpUpstreamClient(config, instanceId),
    persistence,
    clients: new ClientRegistry(config.clients, persistence, now),
    metrics: new Metrics(),
    balances: new BalanceMonitor(
      () => config.accounts.values(),
      notifier,
      now,
      (account, error) => log.warn({ account, err: error }, "balance check failed"),
    ),
    limits: new ClientLimits(now),
    authThrottle: new FailedAuthThrottle(now),
    meteredSeen: new Set(),
    edgeReports: new Map(),
    draining: false,
  };
}

/** Loads saved quota state and this period's spend. */
export async function restoreState(runtime: Runtime): Promise<void> {
  const now = runtime.now();
  const [quota, spend, pins, clientKeys] = await Promise.all([
    runtime.persistence.loadQuota(),
    runtime.persistence.loadSpend([dayPeriod(now), monthPeriod(now)]),
    runtime.persistence.loadPins(now - PIN_IDLE_MS),
    runtime.persistence.loadClientKeys(),
  ]);
  runtime.clients.load(clientKeys);
  runtime.quota.load(quota);
  // Tokens on disk mean a sign-in arrived or survived, so it deserves another try.
  for (const [accountId, session] of runtime.chatgpt) {
    if (session.usable) runtime.quota.clearDisabled(accountId);
  }
  runtime.budgets.load(spend);
  runtime.pins.load(pins);
}
