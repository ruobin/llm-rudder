import { readJsonFile } from "./files.js";
import type { EdgePaths } from "./paths.js";
import type { EdgeSnapshot } from "./state.js";

const STATUS_TIMEOUT_MS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

type Status = EdgeSnapshot & { gatewayConfigured?: boolean };

function formatReset(until: number, now: number): string {
  const date = new Date(until);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (until - now < DAY_MS) return time;
  return `${date.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
}

const percent = (value: number) => `${Math.round(value * 100)}%`;

/** One short line for Claude Code's status bar. */
export function formatStatusLine(status: Status | null, now: number): string {
  if (!status) return "⚠ llmr-edge is not running";
  const limits = status.limits ?? [];
  if (limits.length > 0) {
    const account = limits.find((limit) => limit.scope === "*") ?? limits[0]!;
    const name = account.scope === "*" ? "plan" : `${account.scope.replace("family:", "")} plan`;
    const reset = account.knownReset ? ` until ${formatReset(account.until, now)}` : "";
    const served = status.servedBy;
    if (served?.kind === "gateway") {
      return `⚠ Claude ${name} limit${reset} · using API (${served.tier})`;
    }
    return `⚠ Claude ${name} limit${reset}`;
  }
  const usage = Object.entries(status.usage ?? {})
    .slice(0, 2)
    .map(([window, value]) => `${window} ${percent(value)}`);
  return usage.length > 0 ? `plan ${usage.join(" · ")}` : "plan ok";
}

export async function fetchStatus(port: number): Promise<Status | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/_edge/status`, {
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    return response.ok ? ((await response.json()) as Status) : null;
  } catch {
    return null;
  }
}

/** Reads the saved state when the running edge does not answer in time. */
export function savedStatus(paths: EdgePaths): Status | null {
  return readJsonFile(paths.stateFile) as Status | null;
}
