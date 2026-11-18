import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { pino } from "pino";
import { buildApp } from "./app.js";
import { generateKey, hashKey } from "./auth/keys.js";
import type { AccountConfig, ClientConfig, Config, TierConfig } from "./config/load.js";
import { MemoryPersistence } from "./ledger/records.js";
import { createRuntime, restoreState, type Runtime } from "./runtime.js";
import type { JsonObject, Target } from "./types.js";
import { fetchModelList, type ModelList } from "./upstream/account-check.js";
import { fetchBalance } from "./upstream/balance.js";

export type CheckStatus = "ok" | "warning" | "failed" | "skipped";

export interface CheckLine {
  status: CheckStatus;
  text: string;
}

export interface AccountReport {
  accountId: string;
  heading: string;
  lines: CheckLine[];
}

export interface CheckOptions {
  /** The accounts to check. Every account when this is empty. */
  accounts?: string[];
  /** Also sends two short real requests to each model. */
  live?: boolean;
}

const REQUEST_TIMEOUT_MS = 90_000;
/** Enough room for a reasoning model. A short question stops well before this. */
const MAX_OUTPUT_TOKENS = 1_000;
const BALANCE_SERVICES = new Set(["new_api", "openrouter"]);
const STATUS_LABELS: Record<CheckStatus, string> = {
  ok: "ok",
  warning: "warn",
  failed: "FAIL",
  skipped: "skip",
};

const TIME_TOOL = {
  type: "function",
  function: {
    name: "get_time",
    description: "Returns the current time in a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
  },
};

/** The targets that use an account, once per model, in the order tiers are listed. */
function targetsOf(config: Config, accountId: string): Target[] {
  const models = new Set<string>();
  return [...config.tiers.values()]
    .flatMap((tier) => tier.targets)
    .filter((target) => {
      if (target.accountId !== accountId || models.has(target.model)) return false;
      models.add(target.model);
      return true;
    });
}

const targetKey = (target: Target) => `${target.accountId}\u0000${target.model}`;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const messageOf = (error: unknown) => {
  const cause = (error as { cause?: { code?: unknown } }).cause?.code;
  return typeof cause === "string" ? cause : (error as Error).message;
};

/**
 * A private gateway with one tier per target and no database, so a check takes the same
 * path as real traffic without touching saved state, budgets or notifications.
 */
class ProbeGateway {
  private constructor(
    private readonly app: FastifyInstance,
    private readonly runtime: Runtime,
    private readonly persistence: MemoryPersistence,
    private readonly url: string,
    private readonly key: string,
    private readonly tierNames: Map<string, string>,
  ) {}

  static async start(config: Config, accounts: AccountConfig[]): Promise<ProbeGateway> {
    const key = generateKey();
    const client: ClientConfig = {
      id: "account-check",
      keyHash: hashKey(key),
      notice: "none",
      maxConcurrent: 1,
      allowFallback: false,
      edge: false,
    };
    const tierNames = new Map<string, string>();
    const tiers = new Map<string, TierConfig>();
    for (const account of accounts) {
      for (const target of targetsOf(config, account.id)) {
        const name = `check-${tiers.size + 1}`;
        tierNames.set(targetKey(target), name);
        tiers.set(name, {
          name,
          fallbackTiers: [],
          prefer: "quality",
          targets: [{ ...target, tier: name, id: `${name}/${target.accountId}/${target.model}` }],
        });
      }
    }
    const probeConfig: Config = {
      ...config,
      server: { ...config.server, host: "127.0.0.1", port: 0 },
      clients: [client],
      accounts: new Map(accounts.map((account) => [account.id, { ...account, budget: null }])),
      tiers,
      aliases: [],
      notifications: { repeatAfterMs: config.notifications.repeatAfterMs },
    };
    delete probeConfig.edge;

    const persistence = new MemoryPersistence();
    const runtime = createRuntime(probeConfig, {
      log: pino({ level: "silent" }),
      persistence,
      sinks: [],
    });
    await restoreState(runtime);
    const app = buildApp(runtime);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    return new ProbeGateway(app, runtime, persistence, `http://127.0.0.1:${port}`, key, tierNames);
  }

  /** Says why a request failed, using the attempt the gateway recorded. */
  private async whyFailed(response: Response, account: AccountConfig): Promise<string> {
    const requestId = response.headers.get("x-llmr-request-id");
    const find = () => this.persistence.ledger.find((entry) => entry.request.id === requestId);
    for (let turn = 0; turn < 50 && !find(); turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const attempt = find()?.attempts.at(-1);
    if (!attempt) return `the model catalog rules this out on ${account.api}`;
    return [
      attempt.outcome.replaceAll("_", " "),
      ...(attempt.httpStatus === null ? [] : [`HTTP ${attempt.httpStatus}`]),
      ...(attempt.errorCode ? [attempt.errorCode] : []),
    ].join(", ");
  }

  /** Sends one streamed request and returns what came back, or why nothing did. */
  async ask(account: AccountConfig, target: Target, extra: JsonObject, content: string) {
    // One failure must not put the model on hold for the next check.
    this.runtime.quota.reset(account.id);
    const startedAt = performance.now();
    const response = await fetch(`${this.url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.tierNames.get(targetKey(target)),
        stream: true,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [{ role: "user", content }],
        ...extra,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const raw = await response.text();
    let text = "";
    let toolName = "";
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data: {")) continue;
      const delta = (
        JSON.parse(line.slice(6)) as {
          choices?: {
            delta?: {
              content?: string | null;
              tool_calls?: { function?: { name?: string } }[];
            };
          }[];
        }
      ).choices?.[0]?.delta;
      text += delta?.content ?? "";
      toolName += delta?.tool_calls?.[0]?.function?.name ?? "";
    }
    const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
    const failure =
      response.ok && (text !== "" || toolName !== "")
        ? null
        : await this.whyFailed(response, account);
    return { failure, seconds, toolName };
  }

  async stop(): Promise<void> {
    await this.runtime.accountChecks.settled();
    await this.app.close();
    await this.runtime.upstream.close();
  }
}

async function checkTargetLive(
  probe: ProbeGateway,
  account: AccountConfig,
  target: Target,
): Promise<{ parts: string[]; failed: boolean }> {
  try {
    const reply = await probe.ask(account, target, {}, "Reply with exactly: ok");
    if (reply.failure) return { parts: [`no reply (${reply.failure})`], failed: true };
    const parts = [`reply in ${reply.seconds}s`];
    const call = await probe.ask(
      account,
      target,
      { tools: [TIME_TOOL], tool_choice: "required" },
      "What time is it in Singapore? Use the tool.",
    );
    if (call.failure) return { parts: [...parts, `no tool call (${call.failure})`], failed: true };
    if (call.toolName !== TIME_TOOL.function.name) {
      return { parts: [...parts, "answered without calling the tool"], failed: true };
    }
    return { parts: [...parts, `tool call in ${call.seconds}s`], failed: false };
  } catch (error) {
    return { parts: [`request failed (${messageOf(error)})`], failed: true };
  }
}

function serviceLine(list: ModelList): CheckLine {
  if (list.status === 401 || list.status === 403) {
    return { status: "failed", text: `the service refused this key (HTTP ${list.status})` };
  }
  if (list.ids === null) {
    return {
      status: "warning",
      text: `no model list is available (HTTP ${list.status}), so model names were not checked`,
    };
  }
  return { status: "ok", text: `the service answered and lists ${list.ids.length} models` };
}

async function balanceLine(account: AccountConfig): Promise<CheckLine | null> {
  if (!BALANCE_SERVICES.has(account.compatName)) return null;
  try {
    const usd = await fetchBalance(account);
    if (usd === null) return { status: "ok", text: "no spending limit is reported for this key" };
    return usd > 0
      ? { status: "ok", text: `$${usd.toFixed(2)} is left on this key` }
      : { status: "failed", text: "this key has no balance left" };
  } catch (error) {
    return { status: "warning", text: `the balance is unavailable (${messageOf(error)})` };
  }
}

async function checkHttpAccount(
  config: Config,
  account: AccountConfig,
  probe: ProbeGateway | null,
): Promise<CheckLine[]> {
  let list: ModelList;
  try {
    list = await fetchModelList(account);
  } catch (error) {
    return [{ status: "failed", text: `the service is unreachable (${messageOf(error)})` }];
  }
  const lines = [serviceLine(list)];
  if (lines[0]!.status === "failed") return lines;

  const balance = await balanceLine(account);
  if (balance) lines.push(balance);

  const targets = targetsOf(config, account.id);
  if (targets.length === 0) {
    lines.push({ status: "warning", text: "no tier uses this account" });
  }
  const listed = list.ids === null ? null : new Set(list.ids);
  for (const target of targets) {
    const name = `${target.tier}/${target.model}`;
    if (listed && !listed.has(target.model)) {
      lines.push({ status: "failed", text: `${name}: the service does not list this model` });
      continue;
    }
    const parts = listed ? ["listed"] : [];
    let failed = false;
    if (probe) {
      const live = await checkTargetLive(probe, account, target);
      parts.push(...live.parts);
      failed = live.failed;
    }
    lines.push({
      status: failed ? "failed" : parts.length > 0 ? "ok" : "skipped",
      text: `${name}: ${parts.join(", ") || "not checked without --live"}`,
    });
  }
  return lines;
}

function headingOf(account: AccountConfig): string {
  if (account.kind === "http") return `${account.id} (${account.api}, ${hostOf(account.baseUrl)})`;
  return `${account.id} (${account.kind.replace("_", " ")})`;
}

function skipReason(account: AccountConfig): string | null {
  if (!account.enabled) return "turned off in the config";
  if (account.kind === "edge_only")
    return "used by llmr-edge; run `llmr-edge doctor` on your computer";
  if (account.kind === "chatgpt_plan") return "run `node dist/cli.js chatgpt status` to check it";
  return null;
}

/** Checks that accounts work, and that the models your tiers name are really there. */
export async function checkAccounts(
  config: Config,
  options: CheckOptions = {},
): Promise<AccountReport[]> {
  const wanted = options.accounts?.length ? new Set(options.accounts) : null;
  const accounts = [...config.accounts.values()].filter(
    (account) => !wanted || wanted.has(account.id),
  );
  const testable = accounts.filter((account) => skipReason(account) === null);
  const probe =
    options.live && testable.length > 0 ? await ProbeGateway.start(config, testable) : null;
  try {
    const reports: AccountReport[] = [];
    for (const account of accounts) {
      const reason = skipReason(account);
      reports.push({
        accountId: account.id,
        heading: headingOf(account),
        lines: reason
          ? [{ status: "skipped", text: reason }]
          : await checkHttpAccount(config, account, probe),
      });
    }
    return reports;
  } finally {
    await probe?.stop();
  }
}

export const hasFailures = (reports: AccountReport[]): boolean =>
  reports.some((report) => report.lines.some((line) => line.status === "failed"));

export function formatReports(reports: AccountReport[]): string {
  return reports
    .map((report) =>
      [
        report.heading,
        ...report.lines.map((line) => `  ${STATUS_LABELS[line.status].padEnd(5)}${line.text}`),
      ].join("\n"),
    )
    .join("\n\n");
}
