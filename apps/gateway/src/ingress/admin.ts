import type { FastifyInstance } from "fastify";
import { RouterError } from "../errors.js";
import type { Runtime } from "../runtime.js";
import { ACCOUNT_SCOPE } from "../state/quota.js";
import { authenticateAdmin } from "./auth.js";

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

export function registerAdminRoutes(app: FastifyInstance, runtime: Runtime): void {
  app.get("/router/status", async (request) => {
    authenticateAdmin(request, runtime);
    return buildStatus(runtime);
  });

  app.post<{ Params: { id: string } }>("/router/accounts/:id/reset", async (request) => {
    authenticateAdmin(request, runtime);
    const { id } = request.params;
    if (!runtime.config.accounts.has(id)) {
      throw new RouterError(404, "account_not_found", `Unknown account "${id}".`);
    }
    return { account: id, cleared: runtime.quota.reset(id) };
  });
}
