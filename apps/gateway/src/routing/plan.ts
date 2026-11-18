import { costMicroUsd, estimateUsage, priceFor } from "../billing/pricing.js";
import type { RequestContext } from "../execution/context.js";
import type { Runtime } from "../runtime.js";
import type { Target } from "../types.js";
import { whyUnsuitable } from "./capabilities.js";
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
  /** The conversation's pinned target when the request arrived. */
  pinAtStart: string | null;
  /** Set when the first step is that pinned target. */
  pinnedTargetId: string | null;
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
  if (!account?.enabled || account.kind === "edge_only") return { reason: "disabled" };
  const unsuitable = whyUnsuitable(target, account, ctx, rt);
  if (unsuitable) return { reason: unsuitable };
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

/**
 * Keeps a conversation on its current target, unless a better one has recovered:
 * the tier it asked for, or a prepaid target ahead of a metered one.
 */
function applyPin(plan: Plan, ctx: RequestContext, rt: Runtime): Plan {
  const tier = plan.requestedTier;
  if (tier === null) return plan;
  const clientId = ctx.client.id;
  const pin = rt.pins.get(clientId, ctx.sessionKey, tier);
  if (pin === null) return plan;
  plan.pinAtStart = pin;

  const index = plan.steps.findIndex((step) => step.target.id === pin);
  if (index === -1) return plan;
  const pinned = plan.steps[index]!;
  const first = plan.steps[0]!;
  if (index > 0) {
    const costClass = (step: PlanStep) => rt.config.accounts.get(step.target.accountId)?.costClass;
    const requestedTierIsBack = pinned.isFallback && !first.isFallback;
    const prepaidIsBack = costClass(pinned) === "metered" && costClass(first) !== "metered";
    if (requestedTierIsBack || prepaidIsBack) {
      rt.pins.release(clientId, ctx.sessionKey, tier);
      plan.pinAtStart = null;
      return plan;
    }
    plan.steps.splice(index, 1);
    plan.steps.unshift(pinned);
  }
  plan.pinnedTargetId = pin;
  return plan;
}

/**
 * Moves failing targets behind others of the same tier and cost class. The order you
 * configured stands otherwise, so this never makes a request cost more.
 */
function healthiestFirst(targets: Target[], rt: Runtime): Target[] {
  const classOf = (target: Target) =>
    `${target.tier}\u0000${rt.config.accounts.get(target.accountId)?.costClass}`;
  const result: Target[] = [];
  for (let start = 0; start < targets.length;) {
    const group = classOf(targets[start]!);
    let end = start;
    while (end < targets.length && classOf(targets[end]!) === group) end += 1;
    const run = targets.slice(start, end);
    result.push(
      ...run.filter((target) => !rt.health.isDegraded(target.id)),
      ...run.filter((target) => rt.health.isDegraded(target.id)),
    );
    start = end;
  }
  return result;
}

/** Expands a request into the ordered targets to try. */
export function buildPlan(ctx: RequestContext, rt: Runtime): Plan {
  const { config } = rt;
  const resolution = resolveModel(ctx.requestedModel, ctx.tierHeader, config);

  // A target in the client's own format needs no translation, which keeps prompt
  // caching and reasoning intact, so it goes first within its tier.
  const sameFormatFirst = (targets: Target[]): Target[] => {
    if (!config.routing.preferSameFormat) return targets;
    // The ChatGPT plan rewrites every request anyway, so it keeps its place in the list.
    const isSame = (target: Target) => {
      const account = config.accounts.get(target.accountId);
      return account?.api === ctx.dialect || account?.kind === "chatgpt_plan";
    };
    return [...targets.filter(isSame), ...targets.filter((target) => !isSame(target))];
  };

  let requestedTier: string | null = null;
  let ordered: Target[];
  if (resolution.kind === "model") {
    ordered = sameFormatFirst(resolution.targets);
  } else {
    requestedTier = ctx.originalTier ?? resolution.tier;
    const tier = config.tiers.get(resolution.tier)!;
    const chain = ctx.allowFallback ? [tier.name, ...tier.fallbackTiers] : [tier.name];
    const all = uniqueByAccountModel(
      chain.flatMap((name) => sameFormatFirst(config.tiers.get(name)!.targets)),
    );
    const isMetered = (target: Target) =>
      config.accounts.get(target.accountId)?.costClass === "metered";
    ordered =
      tier.prefer === "cost"
        ? [...all.filter((t) => !isMetered(t)), ...all.filter(isMetered)]
        : all;
  }

  if (config.routing.healthOrder) ordered = healthiestFirst(ordered, rt);

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
  return applyPin(
    { requestedTier, steps, skipped, pinAtStart: null, pinnedTargetId: null },
    ctx,
    rt,
  );
}
