import type { IncomingHttpHeaders } from "node:http";

/**
 * Recognizes Claude plan limits from `anthropic-ratelimit-unified-*` headers.
 *
 * Anthropic documents the header family but not each name and value, so this
 * reads them defensively. Every 429 is recorded locally (see samples.ts), which
 * lets the rules be checked against what your account really returns.
 */

const PREFIX = "anthropic-ratelimit-unified-";
const ALLOWED_STATUS = new Set(["allowed", "allowed_warning"]);
/** Extra-usage state, which is reported as rejected even while the plan works. */
const IGNORED_WINDOWS = new Set(["overage"]);
const FAMILY = /opus|sonnet|haiku|fable/;
/** A wait this long is a real limit rather than a brief throttle. */
const LONG_RETRY_AFTER_S = 60;

export type PlanSignal =
  | { kind: "none" }
  /** A short rate limit, which Claude Code retries by itself. */
  | { kind: "throttle" }
  | { kind: "plan_limit"; scope: string; resetsAt?: number; claim?: string };

interface PlanWindow {
  name: string;
  status?: string;
  reset?: string;
  utilization?: number;
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function unifiedHeaders(headers: IncomingHttpHeaders): Map<string, string> {
  const found = new Map<string, string>();
  for (const name of Object.keys(headers)) {
    if (!name.startsWith(PREFIX)) continue;
    const value = header(headers, name);
    if (value !== undefined) found.set(name.slice(PREFIX.length), value);
  }
  return found;
}

const normalizeName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

function readWindows(unified: Map<string, string>): PlanWindow[] {
  const windows = new Map<string, PlanWindow>();
  for (const [suffix, value] of unified) {
    const match = /^(.+)-(status|reset|utilization)$/.exec(suffix);
    if (!match) continue;
    const name = normalizeName(match[1]!);
    if (IGNORED_WINDOWS.has(name)) continue;
    const entry = windows.get(name) ?? { name };
    if (match[2] === "status") entry.status = value.toLowerCase();
    else if (match[2] === "reset") entry.reset = value;
    else {
      const utilization = Number(value);
      if (Number.isFinite(utilization)) entry.utilization = utilization;
    }
    windows.set(name, entry);
  }
  return [...windows.values()];
}

const isRejected = (status: string | undefined) =>
  status !== undefined && !ALLOWED_STATUS.has(status.toLowerCase());

/** Accepts epoch seconds, epoch milliseconds or a date. */
function parseTime(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number < 1e11 ? number * 1000 : number;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : date;
}

function familyOf(text: string | undefined): string | undefined {
  return text ? FAMILY.exec(text)?.[0] : undefined;
}

export function modelFamily(model: string): string | undefined {
  return familyOf(model.toLowerCase());
}

/** Share of each plan window used, for the status line and the dashboard. */
export function readPlanUsage(headers: IncomingHttpHeaders): Record<string, number> {
  const usage: Record<string, number> = {};
  for (const window of readWindows(unifiedHeaders(headers))) {
    if (window.utilization !== undefined && window.utilization >= 0) {
      usage[window.name] = Math.min(window.utilization, 10);
    }
  }
  return usage;
}

export function classifyPlanResponse(
  status: number,
  headers: IncomingHttpHeaders,
  now: number,
): PlanSignal {
  if (status !== 429) return { kind: "none" };
  const unified = unifiedHeaders(headers);
  if (unified.size === 0) return { kind: "throttle" };

  const windows = readWindows(unified);
  const exhausted = windows.filter(
    (window) => isRejected(window.status) || (window.utilization ?? 0) >= 1,
  );
  const limited =
    isRejected(unified.get("status")) ||
    exhausted.length > 0 ||
    header(headers, "x-should-retry") === "false";
  if (!limited) return { kind: "throttle" };

  const rawClaim = unified.get("representative-claim");
  const claim = rawClaim ? normalizeName(rawClaim) : undefined;

  // When several windows ran out, the plan returns when the last one resets.
  const windowResets = exhausted
    .map((window) => parseTime(window.reset))
    .filter((time): time is number => time !== undefined);
  const retryAfter = Number(header(headers, "retry-after"));
  const candidates = [
    windowResets.length > 0 ? Math.max(...windowResets) : undefined,
    parseTime(unified.get("reset")),
    Number.isFinite(retryAfter) && retryAfter > LONG_RETRY_AFTER_S
      ? now + retryAfter * 1000
      : undefined,
  ];
  const resetsAt = candidates.find((time) => time !== undefined && time > now);

  const families = exhausted.map((window) => familyOf(window.name));
  const family =
    exhausted.length > 0 && families.every((name) => name !== undefined)
      ? families[0]
      : exhausted.length === 0
        ? familyOf(claim)
        : undefined;

  return {
    kind: "plan_limit",
    scope: family ? `family:${family}` : "*",
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(claim === undefined ? {} : { claim }),
  };
}

/** The headers worth keeping when recording a 429. They contain no credentials. */
export function limitHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of Object.keys(headers)) {
    if (name.startsWith(PREFIX) || name === "retry-after" || name === "x-should-retry") {
      const value = header(headers, name);
      if (value !== undefined) kept[name] = value;
    }
  }
  return kept;
}
