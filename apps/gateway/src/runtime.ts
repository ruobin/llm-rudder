import { randomUUID } from "node:crypto";
import { chatGptEndpoints, CHATGPT_USAGE_URL, type ChatGptEndpoints } from "@llm-rudder/shared";
import { pino, type Logger } from "pino";
import { ClientRegistry } from "./auth/clients.js";
import { ClientLimits, FailedAuthThrottle } from "./auth/limits.js";
import { BudgetManager, dayPeriod, monthPeriod } from "./billing/budgets.js";
import { ChatGptSession, credentialPath, SIGN_IN_COMMAND } from "./chatgpt/session.js";
import {
  ConfigError,
  loadConfig,
  type AccountConfig,
  type Config,
  type LoadedConfig,
} from "./config/load.js";
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
import { TargetHealth } from "./state/health.js";
import { QuotaManager } from "./state/quota.js";
import { PIN_IDLE_MS, PinStore } from "./routing/pins.js";
import { ReasoningStore } from "./translate/artifacts.js";
import { AccountChecks } from "./upstream/account-check.js";
import { BalanceMonitor } from "./upstream/balance.js";
import { HttpUpstreamClient, type UpstreamClient } from "./upstream/client.js";
import { ToolExtrasStore } from "./upstream/tool-extras.js";

export interface Runtime {
  /** Replaced by a config reload. Read it when needed rather than keeping a copy. */
  config: Config;
  /** Where the config was loaded from, when it can be reloaded. */
  configPath?: string;
  log: Logger;
  now: () => number;
  instanceId: string;
  startedAt: number;
  quota: QuotaManager;
  health: TargetHealth;
  budgets: BudgetManager;
  notifier: Notifier;
  episodes: FallbackEpisodes;
  toolExtras: ToolExtrasStore;
  reasoning: ReasoningStore;
  pins: PinStore;
  /** One signed-in session for each ChatGPT plan account. */
  chatgpt: Map<string, ChatGptSession>;
  addChatGptSessions(accounts: Iterable<AccountConfig>): void;
  upstream: UpstreamClient;
  persistence: Persistence;
  /** Clients from the config file and from the dashboard. */
  clients: ClientRegistry;
  metrics: Metrics;
  balances: BalanceMonitor;
  accountChecks: AccountChecks;
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
  configPath?: string;
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
    runtime.config.accounts.get(accountId)?.kind === "chatgpt_plan";

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
  const addChatGptSessions = (accounts: Iterable<AccountConfig>) => {
    for (const account of accounts) {
      if (account.kind !== "chatgpt_plan" || chatgpt.has(account.id)) continue;
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
  };
  addChatGptSessions(config.accounts.values());

  const runtime: Runtime = {
    config,
    ...(options.configPath ? { configPath: options.configPath } : {}),
    addChatGptSessions,
    log,
    now,
    instanceId,
    startedAt: now(),
    quota,
    health: new TargetHealth(now),
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
      () => runtime.config.accounts.values(),
      notifier,
      now,
      (account, error) => log.warn({ account, err: error }, "balance check failed"),
    ),
    accountChecks: new AccountChecks(
      now,
      (target, failure) => quota.recordFailure(target, failure),
      (account, error) => log.warn({ account, err: error }, "account check failed"),
    ),
    limits: new ClientLimits(now),
    authThrottle: new FailedAuthThrottle(now),
    meteredSeen: new Set(),
    edgeReports: new Map(),
    draining: false,
  };
  return runtime;
}

export interface ConfigReload {
  warnings: string[];
  /** Settings that changed but only take effect after a restart. */
  restartNeeded: string[];
}

/** Switches to a new config. Requests already running finish as planned. */
export function applyConfig(runtime: Runtime, { config, warnings }: LoadedConfig): ConfigReload {
  const previous = runtime.config;
  const restartNeeded: string[] = [];
  if (JSON.stringify(previous.server) !== JSON.stringify(config.server)) {
    restartNeeded.push("server");
  }
  if (JSON.stringify(previous.notifications) !== JSON.stringify(config.notifications)) {
    restartNeeded.push("notifications");
  }
  if (previous.timeouts.connectMs !== config.timeouts.connectMs) {
    restartNeeded.push("timeouts.connect_s");
  }
  runtime.config = config;
  runtime.clients.setConfigClients(config.clients);
  runtime.budgets.setAccounts(config.accounts);
  runtime.upstream.setConfig?.(config);
  runtime.addChatGptSessions(config.accounts.values());
  return { warnings, restartNeeded };
}

/** Reads the config file again. A bad file changes nothing and throws ConfigError. */
export function reloadConfig(runtime: Runtime): ConfigReload {
  if (!runtime.configPath) throw new ConfigError(["this gateway was not started from a file"]);
  const result = applyConfig(runtime, loadConfig(runtime.configPath));
  runtime.log.info({ restartNeeded: result.restartNeeded }, "configuration reloaded");
  return result;
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
