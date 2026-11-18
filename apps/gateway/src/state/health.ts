import type { Outcome } from "../types.js";

const WINDOW_MS = 5 * 60_000;
const MAX_SAMPLES = 20;
const MIN_SAMPLES = 5;
const TRIP_FAILURE_SHARE = 0.5;
const DEGRADED_FAILURE_SHARE = 0.25;

/** Failures that say the target itself is unwell, rather than busy or out of quota. */
const HEALTH_FAILURES = new Set<Outcome>([
  "upstream_error",
  "overloaded",
  "timeout",
  "mid_stream_failure",
]);

interface Sample {
  at: number;
  failed: boolean;
}

/** Remembers how each target has behaved over the last few minutes. */
export class TargetHealth {
  private readonly samples = new Map<string, Sample[]>();

  constructor(private readonly now: () => number = Date.now) {}

  private recent(targetId: string): Sample[] {
    const since = this.now() - WINDOW_MS;
    const kept = (this.samples.get(targetId) ?? []).filter((sample) => sample.at >= since);
    this.samples.set(targetId, kept);
    return kept;
  }

  private failureShare(targetId: string): number {
    const samples = this.recent(targetId);
    if (samples.length < MIN_SAMPLES) return 0;
    return samples.filter((sample) => sample.failed).length / samples.length;
  }

  /** Records an attempt. Returns true when the target has failed too often. */
  record(targetId: string, outcome: Outcome): boolean {
    const failed = HEALTH_FAILURES.has(outcome);
    if (!failed && outcome !== "ok") return false;
    const samples = this.recent(targetId);
    samples.push({ at: this.now(), failed });
    if (samples.length > MAX_SAMPLES) samples.shift();
    if (!failed || this.failureShare(targetId) < TRIP_FAILURE_SHARE) return false;
    // The target starts with a clean record when it is tried again.
    this.samples.delete(targetId);
    return true;
  }

  isDegraded(targetId: string): boolean {
    return this.failureShare(targetId) >= DEGRADED_FAILURE_SHARE;
  }
}
