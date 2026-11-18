import type { Classified, Target } from "../types.js";

export type QuotaStatus = "ok" | "cooldown" | "exhausted" | "backoff" | "probing" | "disabled";

export interface QuotaState {
  status: QuotaStatus;
  retryAt?: number;
  backoffS?: number;
  failures?: number;
  probeStartedAt?: number;
  detail?: string;
}

export interface QuotaEntry {
  accountId: string;
  scope: string;
  state: QuotaState;
}

export interface QuotaPersistence {
  saveQuota(entry: QuotaEntry): void;
  deleteQuota(accountId: string, scope: string): void;
}

export type QuotaChange =
  | { kind: "exhausted"; accountId: string; retryAt?: number; detail?: string }
  | { kind: "recovered"; accountId: string }
  | { kind: "disabled"; accountId: string; detail?: string };

export type Availability =
  { available: true } | { available: false; reason: QuotaStatus; retryAt?: number };

export const ACCOUNT_SCOPE = "*";
const PROBE_TIMEOUT_MS = 120_000;
const FIRST_BACKOFF_S = 900;
const MAX_BACKOFF_S = 14_400;
const MAX_RATE_LIMIT_S = 300;
const FIRST_ACCOUNT_PAUSE_S = 15;

const modelScope = (model: string) => `model:${model}`;
const keyOf = (accountId: string, scope: string) => `${accountId}\u0000${scope}`;
const isLongLived = (status: QuotaStatus) =>
  status === "exhausted" || status === "backoff" || status === "disabled";

export class QuotaManager {
  private readonly states = new Map<string, QuotaEntry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly persistence?: QuotaPersistence,
    private readonly onChange?: (change: QuotaChange) => void,
  ) {}

  load(entries: QuotaEntry[]): void {
    for (const entry of entries) this.states.set(keyOf(entry.accountId, entry.scope), entry);
  }

  private scopes(target: Target): string[] {
    return [ACCOUNT_SCOPE, modelScope(target.model)];
  }

  private read(accountId: string, scope: string): QuotaState | undefined {
    return this.states.get(keyOf(accountId, scope))?.state;
  }

  private write(accountId: string, scope: string, state: QuotaState): void {
    const entry = { accountId, scope, state };
    this.states.set(keyOf(accountId, scope), entry);
    if (isLongLived(state.status)) this.persistence?.saveQuota(entry);
  }

  private remove(accountId: string, scope: string): void {
    if (this.states.delete(keyOf(accountId, scope))) {
      this.persistence?.deleteQuota(accountId, scope);
    }
  }

  private blockedBy(state: QuotaState, now: number): Availability | null {
    switch (state.status) {
      case "disabled":
        return { available: false, reason: "disabled" };
      case "probing":
        return now - (state.probeStartedAt ?? 0) < PROBE_TIMEOUT_MS
          ? { available: false, reason: "probing" }
          : null;
      case "cooldown":
      case "exhausted":
      case "backoff":
        return state.retryAt !== undefined && now < state.retryAt
          ? { available: false, reason: state.status, retryAt: state.retryAt }
          : null;
      default:
        return null;
    }
  }

  check(target: Target): Availability {
    const now = this.now();
    for (const scope of this.scopes(target)) {
      const state = this.read(target.accountId, scope);
      const blocked = state && this.blockedBy(state, now);
      if (blocked) return blocked;
    }
    return { available: true };
  }

  /** Confirms a target just before use. After a reset only one request may probe it. */
  tryAdmit(target: Target): boolean {
    if (!this.check(target).available) return false;
    const now = this.now();
    for (const scope of this.scopes(target)) {
      const state = this.read(target.accountId, scope);
      if (state?.status === "exhausted" || state?.status === "backoff") {
        this.states.set(keyOf(target.accountId, scope), {
          accountId: target.accountId,
          scope,
          state: { ...state, status: "probing", probeStartedAt: now },
        });
      } else if (state?.status === "probing") {
        state.probeStartedAt = now;
      }
    }
    return true;
  }

  /** Records that a target answered, which clears any failure state. */
  recordSuccess(target: Target): void {
    for (const scope of this.scopes(target)) {
      const state = this.read(target.accountId, scope);
      if (!state) continue;
      this.remove(target.accountId, scope);
      if (scope === ACCOUNT_SCOPE && state.status !== "cooldown") {
        this.onChange?.({ kind: "recovered", accountId: target.accountId });
      }
    }
  }

  /** Restores a probe slot when the target was not actually called. */
  releaseProbe(target: Target): void {
    for (const scope of this.scopes(target)) {
      const state = this.read(target.accountId, scope);
      if (state?.status === "probing") {
        state.status = state.backoffS ? "backoff" : "exhausted";
        delete state.probeStartedAt;
      }
    }
  }

  recordFailure(target: Target, result: Classified): void {
    const now = this.now();
    const accountId = target.accountId;
    const model = modelScope(target.model);
    const detail = result.code ?? result.outcome;

    // This request could not run here, which says nothing about the next one.
    if (result.scope === "request") {
      this.releaseProbe(target);
      return;
    }
    if (
      result.scope === "account" &&
      (result.outcome === "rate_limited" || result.outcome === "overloaded")
    ) {
      this.pauseAccount(accountId, result, detail);
      return;
    }

    const cooldown = (seconds: number, failures: number) =>
      this.write(accountId, model, {
        status: "cooldown",
        retryAt: now + seconds * 1000,
        failures,
        detail,
      });
    const failureCount = () => (this.read(accountId, model)?.failures ?? 0) + 1;

    switch (result.outcome) {
      case "quota_exhausted":
      case "billing": {
        const scope = result.scope === "model" ? model : ACCOUNT_SCOPE;
        const previous = this.read(accountId, scope);
        if (result.resetsAt !== undefined) {
          this.write(accountId, scope, { status: "exhausted", retryAt: result.resetsAt, detail });
        } else {
          const backoffS = previous?.backoffS
            ? Math.min(previous.backoffS * 2, MAX_BACKOFF_S)
            : FIRST_BACKOFF_S;
          this.write(accountId, scope, {
            status: "backoff",
            retryAt: now + backoffS * 1000,
            backoffS,
            detail,
          });
        }
        const retryAt = this.read(accountId, scope)?.retryAt;
        this.onChange?.({
          kind: "exhausted",
          accountId,
          detail,
          ...(retryAt === undefined ? {} : { retryAt }),
        });
        break;
      }
      case "auth":
        this.write(accountId, ACCOUNT_SCOPE, { status: "disabled", detail });
        this.onChange?.({ kind: "disabled", accountId, detail });
        break;
      case "rate_limited": {
        const failures = failureCount();
        const backoff = Math.min(5 * 2 ** (failures - 1), 60);
        cooldown(Math.min(result.retryAfterS ?? backoff, MAX_RATE_LIMIT_S), failures);
        break;
      }
      case "overloaded":
        cooldown(Math.min(result.retryAfterS ?? 15, MAX_RATE_LIMIT_S), failureCount());
        break;
      case "upstream_error": {
        const failures = failureCount();
        cooldown(Math.min(10 * 2 ** (failures - 1), 120), failures);
        break;
      }
      case "timeout":
      case "mid_stream_failure":
        cooldown(30, failureCount());
        break;
      case "unsupported":
        cooldown(600, failureCount());
        break;
      default:
        break;
    }
  }

  /** A short pause for a whole account, which grows while the failure continues. */
  private pauseAccount(accountId: string, result: Classified, detail: string): void {
    const previous = this.read(accountId, ACCOUNT_SCOPE);
    if (previous?.status === "disabled") return;
    const failures = (previous?.failures ?? 0) + 1;
    const backoffS = Math.min(FIRST_ACCOUNT_PAUSE_S * 2 ** (failures - 1), MAX_RATE_LIMIT_S);
    const seconds = Math.min(result.retryAfterS ?? backoffS, MAX_RATE_LIMIT_S);
    const retryAt = this.now() + seconds * 1000;
    if (previous && previous.status !== "cooldown") {
      // A usage limit was being re-checked, and its longer backoff still applies.
      const state: QuotaState = {
        ...previous,
        status: previous.backoffS ? "backoff" : "exhausted",
        retryAt,
      };
      delete state.probeStartedAt;
      this.write(accountId, ACCOUNT_SCOPE, state);
      return;
    }
    this.write(accountId, ACCOUNT_SCOPE, { status: "cooldown", retryAt, failures, detail });
  }

  /**
   * Replaces an account's limits with what an outside observer reports. Used for
   * the Claude plan, which only the local edge can see.
   */
  applyReportedLimits(
    accountId: string,
    limits: { scope: string; retryAt?: number; detail?: string }[],
  ): void {
    const wanted = new Set(limits.map((limit) => limit.scope));
    let removed = false;
    for (const entry of [...this.states.values()]) {
      if (entry.accountId === accountId && !wanted.has(entry.scope)) {
        this.remove(accountId, entry.scope);
        removed = true;
      }
    }
    let added = false;
    for (const { scope, retryAt, detail } of limits) {
      const previous = this.read(accountId, scope);
      if (!previous) added = true;
      this.write(accountId, scope, {
        status: "exhausted",
        ...(retryAt === undefined ? {} : { retryAt }),
        ...(detail === undefined ? {} : { detail }),
      });
    }
    if (added) {
      const retryAt = limits.map((limit) => limit.retryAt).find((value) => value !== undefined);
      this.onChange?.({
        kind: "exhausted",
        accountId,
        ...(retryAt === undefined ? {} : { retryAt }),
      });
    } else if (removed && limits.length === 0) {
      this.onChange?.({ kind: "recovered", accountId });
    }
  }

  /** Stops using an account until someone fixes it. */
  disable(accountId: string, detail: string): void {
    this.write(accountId, ACCOUNT_SCOPE, { status: "disabled", detail });
    this.onChange?.({ kind: "disabled", accountId, detail });
  }

  /** Lets an account be tried again without touching any usage limit it has. */
  clearDisabled(accountId: string): void {
    if (this.read(accountId, ACCOUNT_SCOPE)?.status === "disabled") {
      this.remove(accountId, ACCOUNT_SCOPE);
    }
  }

  /** Clears every state for an account, after you have fixed the problem. */
  reset(accountId: string): number {
    let cleared = 0;
    for (const entry of [...this.states.values()]) {
      if (entry.accountId === accountId) {
        this.remove(entry.accountId, entry.scope);
        cleared += 1;
      }
    }
    return cleared;
  }

  snapshot(): QuotaEntry[] {
    return [...this.states.values()].map((entry) => ({ ...entry, state: { ...entry.state } }));
  }
}
