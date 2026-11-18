import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ClientConflictError } from "../auth/clients.js";
import { RouterError } from "../errors.js";
import type { AttemptRecord, RequestRecord } from "../ledger/records.js";
import { buildUsageReport, dayOf } from "../ledger/usage.js";
import type { Runtime } from "../runtime.js";
import { ACCOUNT_SCOPE } from "../state/quota.js";
import { authenticateAdmin, authenticateMetrics } from "./auth.js";

const DAY_MS = 86_400_000;
const clientId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "must be a lowercase identifier");

const usageQuery = z.strictObject({ days: z.coerce.number().int().min(1).max(366).default(30) });

const requestsQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z
    .string()
    .regex(/^[0-9A-Z]{26}$/)
    .optional(),
  client: z.string().max(64).optional(),
  outcome: z.string().max(32).optional(),
  tier: z.string().max(64).optional(),
  model: z.string().max(128).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});

const eventsQuery = z.strictObject({ limit: z.coerce.number().int().min(1).max(500).default(100) });

const newClient = z.strictObject({
  id: clientId,
  notice: z.enum(["text", "none"]).optional(),
  rpm: z.number().int().positive().optional(),
  maxConcurrent: z.number().int().positive().max(1000).optional(),
  allowAccounts: z.array(z.string().min(1)).optional(),
  allowFallback: z.boolean().optional(),
});

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue?.path.join(".");
  throw new RouterError(
    400,
    "invalid_request",
    `${where ? `${where}: ` : ""}${issue?.message ?? "Invalid request."}`,
    "invalid_request_error",
  );
}

const usdAmount = (microUsd: number | null) => (microUsd === null ? null : microUsd / 1_000_000);

function requestView(request: RequestRecord) {
  return {
    ...request,
    startedAt: new Date(request.startedAt).toISOString(),
    finishedAt: new Date(request.finishedAt).toISOString(),
    durationMs: request.finishedAt - request.startedAt,
  };
}

function attemptView({ costMicroUsd, listMicroUsd, startedAt, ...attempt }: AttemptRecord) {
  return {
    ...attempt,
    startedAt: new Date(startedAt).toISOString(),
    costUsd: usdAmount(costMicroUsd),
    listValueUsd: usdAmount(listMicroUsd),
  };
}

function admin(runtime: Runtime) {
  return async (request: FastifyRequest): Promise<void> => {
    authenticateAdmin(request, runtime);
  };
}

const usd = (microUsd: number | undefined) =>
  microUsd === undefined ? undefined : Math.round(microUsd / 100) / 10_000;
const iso = (time: number | undefined) =>
  time === undefined ? undefined : new Date(time).toISOString();

export function buildStatus(runtime: Runtime) {
  const { config, quota, budgets, episodes, notifier, now, startedAt, draining } = runtime;
  const quotaEntries = quota.snapshot();

  return {
    uptimeS: Math.floor((now() - startedAt) / 1000),
    draining,
    pricingVersion: config.pricing.version,
    pinnedConversations: runtime.pins.size,
    chatgpt: [...runtime.chatgpt].map(([account, session]) => ({
      account,
      ...session.status(),
    })),
    fallbacks: episodes.list().map((episode) => ({ ...episode, since: iso(episode.since) })),
    tiers: [...config.tiers.values()].map((tier) => ({
      name: tier.name,
      fallbackTiers: tier.fallbackTiers,
      prefer: tier.prefer,
      targets: tier.targets.map((target) => {
        const state = quota.check(target);
        const enabled = config.accounts.get(target.accountId)?.enabled ?? false;
        return {
          id: target.id,
          account: target.accountId,
          model: target.model,
          available: enabled && state.available,
          ...(enabled ? {} : { reason: "disabled in config" }),
          ...(state.available ? {} : { reason: state.reason, retryAt: iso(state.retryAt) }),
        };
      }),
    })),
    accounts: [...config.accounts.values()].map((account) => {
      const spend = budgets.snapshot(account.id);
      const balance = runtime.balances.current().get(account.id);
      const states = quotaEntries.filter((entry) => entry.accountId === account.id);
      return {
        id: account.id,
        costClass: account.costClass,
        trust: account.trust,
        kind: account.kind,
        api: account.api,
        compat: account.compatName,
        enabled: account.enabled,
        state:
          states.find((entry) => entry.scope === ACCOUNT_SCOPE)?.state.status ??
          (account.enabled ? "ok" : "disabled"),
        limits: states.map((entry) => ({
          scope: entry.scope,
          status: entry.state.status,
          retryAt: iso(entry.state.retryAt),
          detail: entry.state.detail,
        })),
        spend: {
          dayUsd: usd(spend.dayMicroUsd),
          monthUsd: usd(spend.monthMicroUsd),
          dayLimitUsd: usd(spend.dayLimitMicroUsd),
          monthLimitUsd: usd(spend.monthLimitMicroUsd),
        },
        ...(balance
          ? {
              balance: {
                usd: balance.usd,
                checkedAt: iso(balance.checkedAt),
                ...(account.balanceWarnUsd === undefined
                  ? {}
                  : { warnBelowUsd: account.balanceWarnUsd }),
              },
            }
          : {}),
      };
    }),
    edges: [...runtime.edgeReports].map(([client, report]) => ({
      client,
      at: iso(report.at),
      edgeVersion: report.edgeVersion,
      usage: report.usage,
    })),
    recentEvents: notifier.recent().map((event) => ({ ...event, at: iso(event.at) })),
  };
}

/** The running settings, without keys or URLs that may contain secrets. */
export function buildSettings(runtime: Runtime) {
  const { config } = runtime;
  return {
    pricingVersion: config.pricing.version,
    routing: config.routing,
    timeouts: config.timeouts,
    retention: config.retention,
    notifications: {
      ntfy: Boolean(config.notifications.ntfyUrl),
      webhook: Boolean(config.notifications.webhookUrl),
      telegram: Boolean(config.notifications.telegram),
      repeatAfterMs: config.notifications.repeatAfterMs,
    },
    aliases: config.aliases.map(({ match, tier }) => ({ match, tier })),
    tiers: [...config.tiers.values()].map((tier) => ({
      name: tier.name,
      fallbackTiers: tier.fallbackTiers,
      prefer: tier.prefer,
      targets: tier.targets.map(({ id, accountId, model }) => ({ id, account: accountId, model })),
    })),
  };
}

export function registerAdminRoutes(app: FastifyInstance, runtime: Runtime): void {
  const onRequest = admin(runtime);

  app.get(
    "/metrics",
    {
      onRequest: async (request) => {
        authenticateMetrics(request, runtime);
      },
    },
    async (_request, reply) =>
      reply
        .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
        .send(runtime.metrics.render(runtime)),
  );

  app.get("/router/status", { onRequest }, async () => buildStatus(runtime));

  app.get("/router/settings", { onRequest }, async () => buildSettings(runtime));

  app.post<{ Params: { id: string } }>(
    "/router/accounts/:id/reset",
    { onRequest },
    async (request) => {
      const { id } = request.params;
      if (!runtime.config.accounts.has(id)) {
        throw new RouterError(404, "account_not_found", `Unknown account "${id}".`);
      }
      return { account: id, cleared: runtime.quota.reset(id) };
    },
  );

  app.get("/router/usage", { onRequest }, async (request) => {
    const { days } = parsed(usageQuery, request.query);
    const now = runtime.now();
    const to = dayOf(now);
    const from = dayOf(now - (days - 1) * DAY_MS);
    const rows = await runtime.persistence.usageRows(from, to, now);
    return buildUsageReport(rows, from, to);
  });

  app.get("/router/requests", { onRequest }, async (request) => {
    const query = parsed(requestsQuery, request.query);
    const items = await runtime.persistence.listRequests({
      // One extra row shows whether another page exists.
      limit: query.limit + 1,
      ...(query.before ? { before: query.before } : {}),
      ...(query.client ? { clientId: query.client } : {}),
      ...(query.outcome ? { outcome: query.outcome } : {}),
      ...(query.tier ? { tier: query.tier } : {}),
      ...(query.model ? { model: query.model } : {}),
      ...(query.from ? { from: Date.parse(query.from) } : {}),
      ...(query.to ? { to: Date.parse(query.to) } : {}),
    });
    const page = items.slice(0, query.limit);
    return {
      items: page.map(requestView),
      nextBefore: items.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  });

  app.get<{ Params: { id: string } }>("/router/requests/:id", { onRequest }, async (request) => {
    const entry = await runtime.persistence.getRequest(request.params.id);
    if (!entry) throw new RouterError(404, "request_not_found", "No such request.");
    return { ...requestView(entry.request), attempts: entry.attempts.map(attemptView) };
  });

  app.get("/router/events", { onRequest }, async (request) => {
    const { limit } = parsed(eventsQuery, request.query);
    const events = await runtime.persistence.listEvents(limit);
    return { items: events.map((event) => ({ ...event, at: new Date(event.at).toISOString() })) };
  });

  app.get("/router/clients", { onRequest }, async () => ({ items: runtime.clients.list() }));

  app.post("/router/clients", { onRequest }, async (request, reply) => {
    const input = parsed(newClient, request.body);
    for (const account of input.allowAccounts ?? []) {
      if (!runtime.config.accounts.has(account)) {
        throw new RouterError(
          400,
          "account_not_found",
          `Unknown account "${account}".`,
          "invalid_request_error",
        );
      }
    }
    try {
      const { key } = await runtime.clients.create({
        id: input.id,
        ...(input.notice ? { notice: input.notice } : {}),
        ...(input.rpm === undefined ? {} : { rpm: input.rpm }),
        ...(input.maxConcurrent === undefined ? {} : { maxConcurrent: input.maxConcurrent }),
        ...(input.allowAccounts ? { allowAccounts: input.allowAccounts } : {}),
        ...(input.allowFallback === undefined ? {} : { allowFallback: input.allowFallback }),
      });
      const client = runtime.clients.list().find((item) => item.id === input.id);
      return await reply.code(201).header("cache-control", "no-store").send({ client, key });
    } catch (error) {
      if (error instanceof ClientConflictError) {
        throw new RouterError(409, "client_exists", error.message, "invalid_request_error");
      }
      throw error;
    }
  });

  app.delete<{ Params: { id: string } }>("/router/clients/:id", { onRequest }, async (request) => {
    const result = await runtime.clients.revoke(request.params.id);
    if (result === "unknown") throw new RouterError(404, "client_not_found", "No such client.");
    if (result === "from_config") {
      throw new RouterError(
        409,
        "client_from_config",
        "This client is defined in the config file, so remove it there.",
        "invalid_request_error",
      );
    }
    return { id: request.params.id, revoked: true };
  });
}
