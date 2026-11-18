import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { hashKey } from "../auth/keys.js";
import type { CostClass, JsonObject, NoticeMode, Target, Trust } from "../types.js";
import { COMPAT_PROFILES, type CompatProfile } from "./compat.js";
import { configSchema, pricingSchema, type RawConfig } from "./schema.js";

export interface ClientConfig {
  id: string;
  keyHash: Buffer;
  notice: NoticeMode;
  rpm?: number;
  maxConcurrent: number;
  allowAccounts?: Set<string>;
  allowFallback: boolean;
}

export interface AccountConfig {
  id: string;
  baseUrl: string;
  apiKey: string | null;
  compatName: string;
  compat: CompatProfile;
  costClass: CostClass;
  trust: Trust;
  enabled: boolean;
  budget: { dailyMicroUsd?: number; monthlyMicroUsd?: number } | null;
}

export interface TierConfig {
  name: string;
  fallbackTiers: string[];
  prefer: "quality" | "cost";
  contextWindow?: number;
  maxOutputTokens?: number;
  targets: Target[];
}

export interface Price {
  input: number;
  output: number;
  cachedInput?: number;
}

export interface Pricing {
  version: string;
  fallback: Price;
  models: Map<string, Price>;
}

export interface Config {
  server: { host: string; port: number; trustProxy: boolean; maxBodyBytes: number };
  adminKeyHash: Buffer;
  clients: ClientConfig[];
  accounts: Map<string, AccountConfig>;
  tiers: Map<string, TierConfig>;
  aliases: { pattern: RegExp; tier: string }[];
  routing: { maxAttemptsPerTier: number; deadlineMs: number };
  timeouts: {
    connectMs: number;
    firstByteMs: number;
    commitMs: number;
    streamIdleMs: number;
    keepaliveAfterMs: number;
    keepaliveIntervalMs: number;
  };
  notifications: { ntfyUrl?: string; webhookUrl?: string; repeatAfterMs: number };
  pricing: Pricing;
}

export interface LoadedConfig {
  config: Config;
  warnings: string[];
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

const MIN_KEY_LENGTH = 32;
const SECRET_PATTERN =
  /^(sk-[\w-]{16,}|llmr_[0-9A-Za-z]{16,}|AIza[\w-]{20,}|ghp_[0-9A-Za-z]{20,}|xai-[0-9A-Za-z]{32,})/;
const toMicroUsd = (usd: number | undefined) =>
  usd === undefined ? undefined : Math.round(usd * 1_000_000);

function findInlineSecrets(value: unknown, path: string, found: string[]): void {
  if (typeof value === "string") {
    if (SECRET_PATTERN.test(value)) found.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => findInlineSecrets(item, `${path}[${index}]`, found));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      findInlineSecrets(item, path ? `${path}.${key}` : key, found);
    }
  }
}

export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function formatZodError(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
}

export function parsePricing(text: string): Pricing {
  const result = pricingSchema.safeParse(parseYaml(text));
  if (!result.success) {
    throw new ConfigError(formatZodError(result.error).map((p) => `pricing: ${p}`));
  }
  const convert = (p: { input: number; output: number; cached_input?: number }): Price => ({
    input: p.input,
    output: p.output,
    ...(p.cached_input === undefined ? {} : { cachedInput: p.cached_input }),
  });
  return {
    version: result.data.version,
    fallback: convert(result.data.default),
    models: new Map(Object.entries(result.data.models).map(([k, v]) => [k, convert(v)])),
  };
}

export function buildConfig(
  raw: RawConfig,
  pricing: Pricing,
  env: Record<string, string | undefined>,
): LoadedConfig {
  const problems: string[] = [];
  const warnings: string[] = [];

  const requireEnv = (name: string, where: string): string => {
    const value = env[name];
    if (!value) {
      problems.push(`${where}: environment variable ${name} is not set`);
      return "";
    }
    return value;
  };
  const requireKey = (name: string, where: string): string => {
    const value = requireEnv(name, where);
    if (value && value.length < MIN_KEY_LENGTH) {
      problems.push(`${where}: ${name} must be at least ${MIN_KEY_LENGTH} characters`);
    }
    return value;
  };

  const adminKey = requireKey(raw.admin.key_env, "admin");

  const seenClientIds = new Set<string>();
  const seenKeys = new Set<string>(adminKey ? [adminKey] : []);
  const clients: ClientConfig[] = raw.clients.map((client) => {
    if (seenClientIds.has(client.id)) problems.push(`clients: duplicate id ${client.id}`);
    seenClientIds.add(client.id);
    const key = requireKey(client.key_env, `clients.${client.id}`);
    if (key && seenKeys.has(key)) {
      problems.push(`clients.${client.id}: ${client.key_env} repeats another key`);
    }
    seenKeys.add(key);
    return {
      id: client.id,
      keyHash: hashKey(key),
      notice: client.notice,
      maxConcurrent: client.max_concurrent,
      allowFallback: client.allow_fallback,
      ...(client.rpm === undefined ? {} : { rpm: client.rpm }),
      ...(client.allow_accounts === undefined
        ? {}
        : { allowAccounts: new Set(client.allow_accounts) }),
    };
  });

  const accounts = new Map<string, AccountConfig>();
  for (const [accountId, account] of Object.entries(raw.accounts)) {
    const where = `accounts.${accountId}`;
    const baseUrl = (account.base_url ?? requireEnv(account.base_url_env as string, where)).replace(
      /\/+$/,
      "",
    );
    if (baseUrl && !/^https?:\/\//.test(baseUrl)) {
      problems.push(`${where}: base URL must start with http:// or https://`);
    }
    const base: CompatProfile = COMPAT_PROFILES[account.compat];
    const overrides = account.compat_overrides ?? {};
    if (account.cost_class === "metered" && !account.budget) {
      warnings.push(`${where}: metered account has no budget`);
    }
    accounts.set(accountId, {
      id: accountId,
      baseUrl,
      apiKey: account.api_key_env ? requireEnv(account.api_key_env, where) : null,
      compatName: account.compat,
      compat: {
        maxTokensField: overrides.max_tokens_field ?? base.maxTokensField,
        streamUsage: overrides.stream_usage ?? base.streamUsage,
        systemRole: overrides.system_role ?? base.systemRole,
        dropFields: overrides.drop_fields ?? base.dropFields,
        toolExtras: overrides.tool_extras ?? base.toolExtras,
        effortMap: overrides.effort_map ?? base.effortMap,
      },
      costClass: account.cost_class,
      trust: account.trust,
      enabled: account.enabled,
      budget: account.budget
        ? {
            ...(account.budget.daily_usd === undefined
              ? {}
              : { dailyMicroUsd: toMicroUsd(account.budget.daily_usd) as number }),
            ...(account.budget.monthly_usd === undefined
              ? {}
              : { monthlyMicroUsd: toMicroUsd(account.budget.monthly_usd) as number }),
          }
        : null,
    });
  }

  const tiers = new Map<string, TierConfig>();
  for (const [tierName, tier] of Object.entries(raw.tiers)) {
    const seen = new Set<string>();
    const targets: Target[] = [];
    tier.targets.forEach((target, index) => {
      if (!accounts.has(target.account)) {
        problems.push(`tiers.${tierName}.targets[${index}]: unknown account ${target.account}`);
      }
      const targetId = `${tierName}/${target.account}/${target.model}`;
      if (seen.has(targetId)) problems.push(`tiers.${tierName}: duplicate target ${targetId}`);
      seen.add(targetId);
      targets.push({
        id: targetId,
        tier: tierName,
        accountId: target.account,
        model: target.model,
        params: target.params as JsonObject,
      });
    });
    if (targets.length === 1) {
      warnings.push(
        `tiers.${tierName}: only one target, so failover inside the tier is impossible`,
      );
    }
    tiers.set(tierName, {
      name: tierName,
      fallbackTiers: tier.fallback_tiers,
      prefer: tier.prefer,
      targets,
      ...(tier.context_window === undefined ? {} : { contextWindow: tier.context_window }),
      ...(tier.max_output_tokens === undefined ? {} : { maxOutputTokens: tier.max_output_tokens }),
    });
  }
  if (tiers.size === 0) problems.push("tiers: at least one tier is required");

  for (const tier of tiers.values()) {
    for (const fallback of tier.fallbackTiers) {
      if (fallback === tier.name) problems.push(`tiers.${tier.name}: cannot fall back to itself`);
      else if (!tiers.has(fallback)) {
        problems.push(`tiers.${tier.name}: unknown fallback tier ${fallback}`);
      }
    }
  }

  for (const client of clients) {
    for (const accountId of client.allowAccounts ?? []) {
      if (!accounts.has(accountId)) {
        problems.push(`clients.${client.id}: unknown account ${accountId}`);
      }
    }
  }

  const aliases = raw.aliases.map((alias) => {
    if (!tiers.has(alias.tier)) problems.push(`aliases: unknown tier ${alias.tier}`);
    return { pattern: globToRegExp(alias.match), tier: alias.tier };
  });

  if (problems.length > 0) throw new ConfigError(problems);

  const seconds = (value: number) => Math.round(value * 1000);
  const notifications = raw.notifications;
  const ntfyUrl = notifications.ntfy_url_env ? env[notifications.ntfy_url_env] : undefined;
  const webhookUrl = notifications.webhook_url_env ? env[notifications.webhook_url_env] : undefined;
  if (!ntfyUrl && !webhookUrl) {
    warnings.push("notifications: no ntfy or webhook URL is set, so push warnings are off");
  }

  return {
    warnings,
    config: {
      server: {
        host: raw.server.host,
        port: raw.server.port,
        trustProxy: raw.server.trust_proxy,
        maxBodyBytes: Math.round(raw.server.max_body_mb * 1024 * 1024),
      },
      adminKeyHash: hashKey(adminKey),
      clients,
      accounts,
      tiers,
      aliases,
      routing: {
        maxAttemptsPerTier: raw.routing.max_attempts_per_tier,
        deadlineMs: seconds(raw.routing.deadline_s),
      },
      timeouts: {
        connectMs: seconds(raw.timeouts.connect_s),
        firstByteMs: seconds(raw.timeouts.first_byte_s),
        commitMs: seconds(raw.timeouts.commit_s),
        streamIdleMs: seconds(raw.timeouts.stream_idle_s),
        keepaliveAfterMs: seconds(raw.timeouts.keepalive_after_s),
        keepaliveIntervalMs: seconds(raw.timeouts.keepalive_interval_s),
      },
      notifications: {
        repeatAfterMs: seconds(notifications.repeat_after_s),
        ...(ntfyUrl ? { ntfyUrl } : {}),
        ...(webhookUrl ? { webhookUrl } : {}),
      },
      pricing,
    },
  };
}

export function parseConfig(
  yamlText: string,
  pricingText: string,
  env: Record<string, string | undefined>,
): LoadedConfig {
  const document: unknown = parseYaml(yamlText);
  const secrets: string[] = [];
  findInlineSecrets(document, "", secrets);
  if (secrets.length > 0) {
    throw new ConfigError(
      secrets.map((path) => `${path}: looks like a secret; reference an environment variable`),
    );
  }
  const result = configSchema.safeParse(document);
  if (!result.success) throw new ConfigError(formatZodError(result.error));
  return buildConfig(result.data, parsePricing(pricingText), env);
}

export function loadConfig(
  path: string,
  env: Record<string, string | undefined> = process.env,
): LoadedConfig {
  const yamlText = readFileSync(path, "utf8");
  const document = parseYaml(yamlText) as { pricing_file?: unknown } | null;
  const pricingFile =
    typeof document?.pricing_file === "string" ? document.pricing_file : "pricing.yaml";
  const pricingText = readFileSync(resolve(dirname(path), pricingFile), "utf8");
  return parseConfig(yamlText, pricingText, env);
}
