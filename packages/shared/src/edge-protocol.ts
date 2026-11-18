import { globToRegExp } from "./glob.js";

/** What the gateway tells a local edge, and what the edge reports back. */

export type EdgeStep =
  /** Send to Anthropic with the local login. `model` replaces the requested model. */
  | { kind: "plan"; model?: string }
  /** Send to the gateway, without any Claude credential. */
  | { kind: "gateway"; tier: string };

export interface EdgeRoute {
  /** Pattern for the requested model, where `*` matches anything. */
  match: string;
  tier: string;
  steps: EdgeStep[];
}

export interface EdgePlan {
  version: 1;
  routes: EdgeRoute[];
  reportIntervalS: number;
}

export interface EdgeLimitReport {
  /** "*" for the whole plan, or "family:opus" and similar. */
  scope: string;
  /** Epoch milliseconds, when known. */
  resetsAt?: number;
  /** The window that ran out, such as "five_hour". */
  claim?: string;
}

/** Contains plan state only. It has no field that could carry a credential. */
export interface EdgeReport {
  edgeVersion: string;
  limits: EdgeLimitReport[];
  /** Share of each plan window used, from 0 to 1. */
  usage: Record<string, number>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseStep(value: unknown): EdgeStep | null {
  if (!isObject(value)) return null;
  if (value.kind === "plan") {
    if (value.model === undefined) return { kind: "plan" };
    return typeof value.model === "string" ? { kind: "plan", model: value.model } : null;
  }
  if (value.kind === "gateway" && typeof value.tier === "string") {
    return { kind: "gateway", tier: value.tier };
  }
  return null;
}

/** Validates a plan from the network or the local cache. */
export function parseEdgePlan(value: unknown): EdgePlan | null {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.routes)) return null;
  const routes: EdgeRoute[] = [];
  for (const route of value.routes) {
    if (!isObject(route) || typeof route.match !== "string" || typeof route.tier !== "string") {
      return null;
    }
    if (!Array.isArray(route.steps)) return null;
    const steps = route.steps.map(parseStep);
    if (steps.some((step) => step === null)) return null;
    routes.push({ match: route.match, tier: route.tier, steps: steps as EdgeStep[] });
  }
  const interval = value.reportIntervalS;
  return {
    version: 1,
    routes,
    reportIntervalS: typeof interval === "number" && interval > 0 ? interval : 300,
  };
}

export function findEdgeRoute(plan: EdgePlan, model: string): EdgeRoute | null {
  return plan.routes.find((route) => globToRegExp(route.match).test(model)) ?? null;
}
