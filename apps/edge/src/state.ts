import type { EdgeLimitReport } from "@llm-router/shared";
import { readJsonFile, writePrivateFile } from "./files.js";
import { modelFamily, type PlanSignal } from "./plan-limit.js";

const FIRST_BACKOFF_S = 900;
const MAX_BACKOFF_S = 14_400;
const ACCOUNT_SCOPE = "*";

export interface PlanLimit {
  scope: string;
  since: number;
  /** The next time the plan is worth trying. */
  until: number;
  /** True when Anthropic stated the reset time. */
  knownReset: boolean;
  backoffS?: number;
  claim?: string;
}

export interface ServedBy {
  kind: "plan" | "gateway";
  model?: string;
  tier?: string;
  at: number;
}

export interface EdgeSnapshot {
  limits: PlanLimit[];
  usage: Record<string, number>;
  servedBy: ServedBy | null;
  gatewayReachable: boolean | null;
  updatedAt: number;
}

export type PlanChange =
  | { kind: "limited"; limit: PlanLimit }
  | { kind: "recovered"; scope: string }
  | { kind: "overflow"; tier: string };

type PlanLimitSignal = Extract<PlanSignal, { kind: "plan_limit" }>;

/** What the edge knows about the Claude plan. It survives restarts. */
export class PlanState {
  private readonly limits = new Map<string, PlanLimit>();
  private usage: Record<string, number> = {};
  private servedBy: ServedBy | null = null;
  private gatewayReachable: boolean | null = null;

  constructor(
    private readonly file: string,
    private readonly now: () => number,
    private readonly onChange: (change: PlanChange) => void = () => {},
  ) {}

  load(): void {
    const saved = readJsonFile(this.file) as Partial<EdgeSnapshot> | null;
    for (const limit of saved?.limits ?? []) this.limits.set(limit.scope, limit);
    this.usage = saved?.usage ?? {};
    this.servedBy = saved?.servedBy ?? null;
  }

  private scopesFor(model: string): string[] {
    const family = modelFamily(model);
    return family ? [ACCOUNT_SCOPE, `family:${family}`] : [ACCOUNT_SCOPE];
  }

  /** Whether to skip the plan for this model right now. */
  isBlocked(model: string): boolean {
    const now = this.now();
    return this.scopesFor(model).some((scope) => {
      const limit = this.limits.get(scope);
      return limit !== undefined && now < limit.until;
    });
  }

  /** True when any limit is recorded, including one waiting to be retried. */
  get limited(): boolean {
    return this.limits.size > 0;
  }

  recordLimit(signal: PlanLimitSignal): void {
    const now = this.now();
    const previous = this.limits.get(signal.scope);
    let until = signal.resetsAt;
    let backoffS: number | undefined;
    if (until === undefined) {
      backoffS = previous?.backoffS
        ? Math.min(previous.backoffS * 2, MAX_BACKOFF_S)
        : FIRST_BACKOFF_S;
      until = now + backoffS * 1000;
    }
    const limit: PlanLimit = {
      scope: signal.scope,
      since: previous?.since ?? now,
      until,
      knownReset: signal.resetsAt !== undefined,
      ...(backoffS === undefined ? {} : { backoffS }),
      ...(signal.claim === undefined ? {} : { claim: signal.claim }),
    };
    this.limits.set(signal.scope, limit);
    this.save();
    if (!previous) this.onChange({ kind: "limited", limit });
  }

  /** The plan answered a real request, so the limits covering this model are over. */
  recordPlanSuccess(model: string): void {
    this.servedBy = { kind: "plan", model, at: this.now() };
    let cleared = false;
    for (const scope of this.scopesFor(model)) {
      if (this.limits.delete(scope)) {
        cleared = true;
        this.onChange({ kind: "recovered", scope });
      }
    }
    if (cleared) this.save();
  }

  recordGatewayServed(tier: string): void {
    const wasOnGateway = this.servedBy?.kind === "gateway";
    this.servedBy = { kind: "gateway", tier, at: this.now() };
    this.gatewayReachable = true;
    this.save();
    if (!wasOnGateway) this.onChange({ kind: "overflow", tier });
  }

  setGatewayReachable(reachable: boolean): void {
    this.gatewayReachable = reachable;
  }

  observeUsage(usage: Record<string, number>): void {
    if (Object.keys(usage).length > 0) this.usage = { ...this.usage, ...usage };
  }

  reportLimits(): EdgeLimitReport[] {
    return [...this.limits.values()].map((limit) => ({
      scope: limit.scope,
      ...(limit.knownReset ? { resetsAt: Math.round(limit.until) } : {}),
      ...(limit.claim === undefined ? {} : { claim: limit.claim }),
    }));
  }

  usageReport(): Record<string, number> {
    return { ...this.usage };
  }

  snapshot(): EdgeSnapshot {
    return {
      limits: [...this.limits.values()],
      usage: { ...this.usage },
      servedBy: this.servedBy,
      gatewayReachable: this.gatewayReachable,
      updatedAt: this.now(),
    };
  }

  private save(): void {
    try {
      writePrivateFile(this.file, `${JSON.stringify(this.snapshot())}\n`);
    } catch {
      // The state is rebuilt from the next responses if it cannot be saved.
    }
  }
}
