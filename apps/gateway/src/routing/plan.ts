import { costMicroUsd, estimateUsage, priceFor } from "../billing/pricing.js";
import type { RequestContext } from "../execution/context.js";
import type { Runtime } from "../runtime.js";
import type { Target } from "../types.js";
import { resolveModel } from "./resolve.js";

export interface PlanStep {
  target: Target;
  /** Served by a tier other than the requested one. */
  isFallback: boolean;
}

export interface SkippedTarget {
  target: Target;
  reason: string;
  retryAt?: number;
}

export interface Plan {
  /** Null when the client named an exact upstream model. */
  requestedTier: string | null;
  steps: PlanStep[];
  skipped: SkippedTarget[];
}

function uniqueByAccountModel(targets: Target[]): Target[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.accountId}\u0000${target.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function estimateCost(ctx: RequestContext, target: Target, rt: Runtime): number {
  const price = priceFor(rt.config.pricing, target.model);
  return costMicroUsd(estimateUsage(ctx.bodyChars, ctx.maxOutputTokens), price);
}

function whyBlocked(
  target: Target,
  ctx: RequestContext,
  rt: Runtime,
): Omit<SkippedTarget, "target"> | null {
  const account = rt.config.accounts.get(target.accountId);
  if (!account?.enabled) return { reason: "disabled" };
  if (ctx.client.allowAccounts && !ctx.client.allowAccounts.has(target.accountId)) {
    return { reason: "not_allowed" };
  }
  const availability = rt.quota.check(target);
  if (!availability.available) {
    return {
      reason: availability.reason,
      ...(availability.retryAt === undefined ? {} : { retryAt: availability.retryAt }),
    };
  }
  if (!rt.budgets.allows(target.accountId, estimateCost(ctx, target, rt))) {
    rt.notifier.emit(
      "budget_reached",
      target.accountId,
      `${target.accountId} has reached its spending budget and is being skipped.`,
    );
    const retryAt = rt.budgets.resetsAt(target.accountId);
    return { reason: "budget", ...(retryAt === undefined ? {} : { retryAt }) };
  }
  return null;
}

/** Expands a request into the ordered targets to try. */
export function buildPlan(ctx: RequestContext, rt: Runtime): Plan {
  const { config } = rt;
  const resolution = resolveModel(ctx.requestedModel, ctx.tierHeader, config);

  let requestedTier: string | null = null;
  let ordered: Target[];
  if (resolution.kind === "model") {
    ordered = resolution.targets;
  } else {
    requestedTier = resolution.tier;
    const tier = config.tiers.get(resolution.tier)!;
    const chain = ctx.allowFallback ? [tier.name, ...tier.fallbackTiers] : [tier.name];
    const all = uniqueByAccountModel(chain.flatMap((name) => config.tiers.get(name)!.targets));
    const isMetered = (target: Target) =>
      config.accounts.get(target.accountId)?.costClass === "metered";
    ordered =
      tier.prefer === "cost"
        ? [...all.filter((t) => !isMetered(t)), ...all.filter(isMetered)]
        : all;
  }

  const steps: PlanStep[] = [];
  const skipped: SkippedTarget[] = [];
  const usedPerTier = new Map<string, number>();
  for (const target of ordered) {
    const blocked = whyBlocked(target, ctx, rt);
    if (blocked) {
      skipped.push({ target, ...blocked });
      continue;
    }
    const used = usedPerTier.get(target.tier) ?? 0;
    if (used >= config.routing.maxAttemptsPerTier) continue;
    usedPerTier.set(target.tier, used + 1);
    steps.push({
      target,
      isFallback: requestedTier !== null && target.tier !== requestedTier,
    });
  }
  return { requestedTier, steps, skipped };
}
