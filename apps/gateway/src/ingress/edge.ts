import type { EdgePlan, EdgeStep } from "@llm-router/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ClientConfig, Config } from "../config/load.js";
import { RouterError } from "../errors.js";
import type { Runtime } from "../runtime.js";
import { clientAuthHook } from "./auth.js";

const MAX_REPORT_BYTES = 16 * 1024;

/** Names like "five_hour" or "7d_opus". Tokens contain dashes, so they cannot match. */
const windowName = z
  .string()
  .max(32)
  .regex(/^[a-z0-9]+(_[a-z0-9]+){0,3}$/);

/** Strict, so a report cannot carry anything except plan state. */
const reportSchema = z.strictObject({
  edgeVersion: z
    .string()
    .max(32)
    .regex(/^[0-9A-Za-z.+]+$/),
  limits: z
    .array(
      z.strictObject({
        scope: z.string().regex(/^(\*|family:[a-z]{1,16})$/),
        resetsAt: z.number().int().positive().optional(),
        claim: windowName.optional(),
      }),
    )
    .max(16),
  usage: z.record(windowName, z.number().min(0).max(10)),
});

/** Lists, for each Claude model pattern, what the edge should try and in what order. */
export function buildEdgePlan(config: Config, client: ClientConfig): EdgePlan {
  const edge = config.edge!;

  const canServe = (tierName: string) =>
    config.tiers.get(tierName)!.targets.some((target) => {
      const account = config.accounts.get(target.accountId);
      return (
        account?.enabled &&
        account.api === "anthropic.messages" &&
        (!client.allowAccounts || client.allowAccounts.has(account.id))
      );
    });

  const stepsFor = (tierName: string): EdgeStep[] => {
    const tier = config.tiers.get(tierName)!;
    const chain = client.allowFallback ? [tierName, ...tier.fallbackTiers] : [tierName];
    const planStep = (name: string, index: number): EdgeStep | null => {
      // The first step uses whichever model Claude Code asked for.
      if (index === 0) return { kind: "plan" };
      const model = edge.planModels.get(name);
      return model ? { kind: "plan", model } : null;
    };
    const gatewayStep = (name: string): EdgeStep | null =>
      canServe(name) ? { kind: "gateway", tier: name } : null;

    const steps =
      tier.prefer === "cost"
        ? [...chain.map(planStep), ...chain.map(gatewayStep)]
        : chain.flatMap((name, index) => [planStep(name, index), gatewayStep(name)]);
    return steps.filter((step) => step !== null);
  };

  return {
    version: 1,
    reportIntervalS: edge.reportIntervalS,
    routes: config.aliases
      .filter((alias) => /claude/i.test(alias.match))
      .map((alias) => ({ match: alias.match, tier: alias.tier, steps: stepsFor(alias.tier) })),
  };
}

export function registerEdgeRoutes(app: FastifyInstance, runtime: Runtime): void {
  const authenticate = clientAuthHook(runtime);

  const authenticateEdge = async (request: FastifyRequest) => {
    await authenticate(request);
    if (!runtime.config.edge) {
      throw new RouterError(404, "not_found", "The edge is not configured.");
    }
    if (!request.llmrClient?.edge) {
      throw new RouterError(403, "not_an_edge", "This key is not allowed to act as an edge.");
    }
  };

  app.get("/router/edge/plan", { onRequest: authenticateEdge }, async (request) =>
    buildEdgePlan(runtime.config, request.llmrClient as ClientConfig),
  );

  app.post(
    "/router/edge/report",
    { onRequest: authenticateEdge, bodyLimit: MAX_REPORT_BYTES },
    async (request) => {
      const parsed = reportSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new RouterError(400, "invalid_report", "The report is not valid.");
      }
      const report = parsed.data;
      runtime.quota.applyReportedLimits(
        runtime.config.edge!.planAccount,
        report.limits.map((limit) => ({
          scope: limit.scope,
          detail: limit.claim ?? "plan_limit",
          ...(limit.resetsAt === undefined ? {} : { retryAt: limit.resetsAt }),
        })),
      );
      runtime.edgeReports.set((request.llmrClient as ClientConfig).id, {
        at: runtime.now(),
        edgeVersion: report.edgeVersion,
        usage: report.usage,
      });
      return { status: "ok" };
    },
  );
}
