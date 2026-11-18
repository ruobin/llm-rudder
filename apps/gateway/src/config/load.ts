import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { globToRegExp } from "@llm-router/shared";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { hashKey } from "../auth/keys.js";
import type { CostClass, Dialect, JsonObject, NoticeMode, Target, Trust } from "../types.js";
import { COMPAT_PROFILES, type CompatProfile } from "./compat.js";
import { EMPTY_CATALOG, parseModelCatalog, type ModelCatalog } from "./models.js";
import { configSchema, pricingSchema, type RawConfig } from "./schema.js";

export interface ClientConfig {
  id: string;
  keyHash: Buffer;
  notice: NoticeMode;
  rpm?: number;
  maxConcurrent: number;
  allowAccounts?: Set<string>;
  allowFallback: boolean;
  edge: boolean;
}

export interface AccountConfig {
  id: string;
  kind: "http" | "edge_only";
  api: Dialect;
  authHeader: "bearer" | "x-api-key";
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

export interface TokenPrices {
  input: number;
  output: number;
  cachedInput?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}

export interface Price extends TokenPrices {
  longContext?: TokenPrices & { overInputTokens: number };
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
  aliases: { match: string; pattern: RegExp; tier: string }[];
  routing: { maxAttemptsPerTier: number; deadlineMs: number; preferSameFormat: boolean };
  timeouts: {
    connectMs: number;
    firstByteMs: number;
    commitMs: number;
    streamIdleMs: number;
    keepaliveAfterMs: number;
    keepaliveIntervalMs: number;
  };
  notifications: { ntfyUrl?: string; webhookUrl?: string; repeatAfterMs: number };
  edge?: { planAccount: string; planModels: Map<string, string>; reportIntervalS: number };
  pricing: Pricing;
  models: ModelCatalog;
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

function formatZodError(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
}

type RawLongContext = {
  over_input_tokens: number;
  input: number;
  output: number;
  cached_input?: number | undefined;
  cache_write_5m?: number | undefined;
  cache_write_1h?: number | undefined;
};

export function parsePricing(text: string): Pricing {
  const result = pricingSchema.safeParse(parseYaml(text));
  if (!result.success) {
    throw new ConfigError(formatZodError(result.error).map((p) => `pricing: ${p}`));
  }
  type RawPrices = {
    input: number;
    output: number;
    cached_input?: number | undefined;
    cache_write_5m?: number | undefined;
    cache_write_1h?: number | undefined;
  };
  const prices = (p: RawPrices): TokenPrices => ({
    input: p.input,
    output: p.output,
    ...(p.cached_input === undefined ? {} : { cachedInput: p.cached_input }),
    ...(p.cache_write_5m === undefined ? {} : { cacheWrite5m: p.cache_write_5m }),
    ...(p.cache_write_1h === undefined ? {} : { cacheWrite1h: p.cache_write_1h }),
  });
  const convert = (p: RawPrices & { long_context?: RawLongContext | undefined }): Price => ({
    ...prices(p),
    ...(p.long_context
      ? {
          longContext: {
            ...prices(p.long_context),
            overInputTokens: p.long_context.over_input_tokens,
          },
        }
      : {}),
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
  models: ModelCatalog = EMPTY_CATALOG,
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
      edge: client.edge,
      ...(client.rpm === undefined ? {} : { rpm: client.rpm }),
      ...(client.allow_accounts === undefined
        ? {}
        : { allowAccounts: new Set(client.allow_accounts) }),
    };
  });

  const accounts = new Map<string, AccountConfig>();
  for (const [accountId, account] of Object.entries(raw.accounts)) {
    const where = `accounts.${accountId}`;
    const configuredUrl =
      account.kind === "edge_only"
        ? ""
        : (account.base_url ?? requireEnv(account.base_url_env as string, where));
    const trimmedUrl = configuredUrl.replace(/\/+$/, "");
    // The Anthropic client adds /v1/messages itself.
    const baseUrl =
      account.api === "anthropic.messages" ? trimmedUrl.replace(/\/v1$/, "") : trimmedUrl;
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
      kind: account.kind,
      api: account.api,
      authHeader:
        account.auth_header ?? (account.api === "anthropic.messages" ? "x-api-key" : "bearer"),
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
        schemaStyle: overrides.schema_style ?? base.schemaStyle,
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
      const where = `tiers.${tierName}.targets[${index}]`;
      const account = accounts.get(target.account);
      if (!account) {
        problems.push(`${where}: unknown account ${target.account}`);
      } else if (account.kind === "edge_only") {
        problems.push(`${where}: ${target.account} is only usable by llmr-edge`);
      } else if (account.api !== "openai.chat" && Object.keys(target.params).length > 0) {
        problems.push(`${where}: params only apply to openai.chat accounts; use effort instead`);
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
        ...(target.effort === undefined ? {} : { effort: target.effort }),
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
    return { match: alias.match, pattern: globToRegExp(alias.match), tier: alias.tier };
  });

  if (raw.edge) {
    if (accounts.get(raw.edge.plan_account)?.kind !== "edge_only") {
      problems.push(`edge.plan_account: ${raw.edge.plan_account} must be an edge_only account`);
    }
    for (const tier of Object.keys(raw.edge.plan_models)) {
      if (!tiers.has(tier)) problems.push(`edge.plan_models: unknown tier ${tier}`);
    }
    if (!clients.some((client) => client.edge)) {
      warnings.push("edge: no client has edge: true, so llmr-edge cannot connect");
    }
  } else {
    for (const client of clients) {
      if (client.edge) problems.push(`clients.${client.id}: edge requires an edge section`);
    }
  }

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
        preferSameFormat: raw.routing.prefer_same_format,
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
      ...(raw.edge
        ? {
            edge: {
              planAccount: raw.edge.plan_account,
              planModels: new Map(Object.entries(raw.edge.plan_models)),
              reportIntervalS: raw.edge.report_interval_s,
            },
          }
        : {}),
      pricing,
      models,
    },
  };
}

export function parseConfig(
  yamlText: string,
  pricingText: string,
  env: Record<string, string | undefined>,
  modelsText?: string,
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
  let models = EMPTY_CATALOG;
  if (modelsText !== undefined) {
    const parsed = parseModelCatalog(modelsText);
    if (Array.isArray(parsed)) throw new ConfigError(parsed);
    models = parsed;
  }
  const loaded = buildConfig(result.data, parsePricing(pricingText), env, models);
  if (modelsText === undefined) {
    loaded.warnings.push("models: no model catalog was found, so every model is assumed capable");
  }
  return loaded;
}

export function loadConfig(
  path: string,
  env: Record<string, string | undefined> = process.env,
): LoadedConfig {
  const yamlText = readFileSync(path, "utf8");
  const document = parseYaml(yamlText) as { pricing_file?: unknown; models_file?: unknown } | null;
  const pricingFile =
    typeof document?.pricing_file === "string" ? document.pricing_file : "pricing.yaml";
  const modelsFile =
    typeof document?.models_file === "string" ? document.models_file : "models.yaml";
  const pricingText = readFileSync(resolve(dirname(path), pricingFile), "utf8");
  const modelsPath = resolve(dirname(path), modelsFile);
  const modelsText = existsSync(modelsPath) ? readFileSync(modelsPath, "utf8") : undefined;
  return parseConfig(yamlText, pricingText, env, modelsText);
}
