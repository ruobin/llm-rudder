import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changeMessage } from "../src/app.js";
import {
  EdgeConfigError,
  generateEdgeKey,
  loadEdgeConfig,
  parseAnthropicUrl,
  parseGatewayUrl,
  writeConfigFile,
} from "../src/config.js";
import { notificationCommand } from "../src/notify.js";
import { edgePaths } from "../src/paths.js";
import {
  classifyPlanResponse,
  limitHeaders,
  modelFamily,
  readPlanUsage,
} from "../src/plan-limit.js";
import { upstreamUrl } from "../src/server.js";
import { launchdPlist, serviceFile, systemdUnit } from "../src/service.js";
import { PlanState } from "../src/state.js";
import { formatStatusLine } from "../src/statusline.js";

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const seconds = (ms: number) => String(Math.floor(ms / 1000));
const unified = (fields: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(fields).map(([name, value]) => [`anthropic-ratelimit-unified-${name}`, value]),
  );

function tempFile(name: string) {
  const dir = mkdtempSync(join(tmpdir(), "llmr-edge-unit-"));
  return { file: join(dir, name), dir, cleanup: () => rmSync(dir, { recursive: true }) };
}

describe("plan limit detection", () => {
  // Header names and values reported from a real successful plan response.
  const observedOk = unified({
    status: "allowed",
    "5h-status": "allowed",
    "5h-reset": "1764554400",
    "5h-utilization": "0.018416969696969696",
    "7d-status": "allowed",
    "7d-reset": "1764615600",
    "7d-utilization": "0.7370692663445869",
    "representative-claim": "five_hour",
    "fallback-percentage": "0.2",
    reset: "1764554400",
    "overage-disabled-reason": "org_level_disabled",
  });

  it("ignores successful responses", () => {
    expect(classifyPlanResponse(200, observedOk, NOW)).toEqual({ kind: "none" });
  });

  it("reads usage from those headers", () => {
    expect(readPlanUsage(observedOk)).toEqual({
      "5h": 0.018416969696969696,
      "7d": 0.7370692663445869,
    });
  });

  it("treats a 429 with no plan headers as a throttle", () => {
    expect(classifyPlanResponse(429, { "retry-after": "30" }, NOW)).toEqual({ kind: "throttle" });
  });

  it("treats a 429 on a healthy plan as a throttle", () => {
    expect(classifyPlanResponse(429, observedOk, NOW)).toEqual({ kind: "throttle" });
  });

  it("does not count extra-usage status as a plan limit", () => {
    const headers = { ...observedOk, ...unified({ "overage-status": "rejected" }) };
    expect(classifyPlanResponse(429, headers, NOW).kind).toBe("throttle");
  });

  it("recognizes a rejected status, in any casing", () => {
    const reset = seconds(NOW + 3_600_000);
    expect(
      classifyPlanResponse(
        429,
        unified({ status: "REJECTED", reset, "representative-claim": "five_hour" }),
        NOW,
      ),
    ).toEqual({
      kind: "plan_limit",
      scope: "*",
      resetsAt: Number(reset) * 1000,
      claim: "five_hour",
    });
  });

  it("treats any status it does not know as a limit", () => {
    expect(classifyPlanResponse(429, unified({ status: "rate_limited" }), NOW).kind).toBe(
      "plan_limit",
    );
  });

  it("recognizes a window that is fully used", () => {
    const headers = unified({ status: "allowed", "5h-utilization": "1", "5h-status": "allowed" });
    expect(classifyPlanResponse(429, headers, NOW).kind).toBe("plan_limit");
  });

  it("recognizes x-should-retry: false alongside plan headers", () => {
    const headers = { ...observedOk, "x-should-retry": "false" };
    expect(classifyPlanResponse(429, headers, NOW).kind).toBe("plan_limit");
    expect(classifyPlanResponse(429, { "x-should-retry": "false" }, NOW).kind).toBe("throttle");
  });

  it("waits for the last exhausted window", () => {
    const soon = NOW + 3_600_000;
    const later = NOW + 86_400_000;
    const signal = classifyPlanResponse(
      429,
      unified({
        status: "rejected",
        reset: seconds(soon),
        "5h-status": "rejected",
        "5h-reset": seconds(soon),
        "7d-status": "rejected",
        "7d-reset": seconds(later),
      }),
      NOW,
    );
    expect(signal).toMatchObject({ resetsAt: Math.floor(later / 1000) * 1000 });
  });

  it("accepts dates and milliseconds, and ignores times in the past", () => {
    const date = new Date(NOW + 60_000).toISOString();
    expect(
      classifyPlanResponse(429, unified({ status: "rejected", reset: date }), NOW),
    ).toMatchObject({
      resetsAt: NOW + 60_000,
    });
    expect(
      classifyPlanResponse(429, unified({ status: "rejected", reset: String(NOW + 5000) }), NOW),
    ).toMatchObject({ resetsAt: NOW + 5000 });
    const past = classifyPlanResponse(
      429,
      unified({ status: "rejected", reset: seconds(NOW - 1000) }),
      NOW,
    );
    expect(past).toEqual({ kind: "plan_limit", scope: "*" });
  });

  it("falls back to a long retry-after", () => {
    const headers = { ...unified({ status: "rejected" }), "retry-after": "600" };
    expect(classifyPlanResponse(429, headers, NOW)).toMatchObject({ resetsAt: NOW + 600_000 });
    const short = { ...unified({ status: "rejected" }), "retry-after": "5" };
    expect(classifyPlanResponse(429, short, NOW)).toEqual({ kind: "plan_limit", scope: "*" });
  });

  it("scopes a limit to one model family when only that family ran out", () => {
    const headers = unified({
      status: "rejected",
      "7d_opus-status": "rejected",
      "5h-status": "allowed",
      "representative-claim": "seven_day_opus",
    });
    expect(classifyPlanResponse(429, headers, NOW)).toMatchObject({
      scope: "family:opus",
      claim: "seven_day_opus",
    });
    expect(
      classifyPlanResponse(
        429,
        unified({ status: "rejected", "representative-claim": "seven_day_sonnet" }),
        NOW,
      ),
    ).toMatchObject({ scope: "family:sonnet" });
  });

  it("uses the whole account when several kinds of window ran out", () => {
    const headers = unified({ "7d_opus-status": "rejected", "5h-status": "rejected" });
    expect(classifyPlanResponse(429, headers, NOW)).toMatchObject({ scope: "*" });
  });

  it("keeps only rate-limit headers in samples", () => {
    expect(
      limitHeaders({
        authorization: "Bearer secret",
        cookie: "secret",
        "retry-after": "5",
        ...unified({ status: "rejected" }),
      }),
    ).toEqual({ "retry-after": "5", "anthropic-ratelimit-unified-status": "rejected" });
  });

  it("finds the model family", () => {
    expect(modelFamily("claude-opus-5-5")).toBe("opus");
    expect(modelFamily("claude-fable-5-2")).toBe("fable");
    expect(modelFamily("custom")).toBeUndefined();
  });
});

describe("plan state", () => {
  const setup = () => {
    const temp = tempFile("state.json");
    const clock = { now: NOW };
    const changes: string[] = [];
    const state = new PlanState(
      temp.file,
      () => clock.now,
      (change) => changes.push(change.kind),
    );
    return { ...temp, clock, changes, state };
  };

  it("blocks until the stated reset", () => {
    const t = setup();
    t.state.recordLimit({ kind: "plan_limit", scope: "*", resetsAt: NOW + 1000 });
    expect(t.state.isBlocked("claude-opus-5-5")).toBe(true);
    t.clock.now += 1000;
    expect(t.state.isBlocked("claude-opus-5-5")).toBe(false);
    expect(t.state.limited).toBe(true);
    t.cleanup();
  });

  it("limits only the affected family", () => {
    const t = setup();
    t.state.recordLimit({ kind: "plan_limit", scope: "family:opus", resetsAt: NOW + 1000 });
    expect(t.state.isBlocked("claude-opus-5-5")).toBe(true);
    expect(t.state.isBlocked("claude-sonnet-5-5")).toBe(false);
    t.state.recordPlanSuccess("claude-sonnet-5-5");
    expect(t.state.isBlocked("claude-opus-5-5")).toBe(true);
    t.state.recordPlanSuccess("claude-opus-5-5");
    expect(t.state.limited).toBe(false);
    t.cleanup();
  });

  it("backs off further each time when no reset time is known", () => {
    const t = setup();
    const limit = { kind: "plan_limit", scope: "*" } as const;
    const waits: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      t.state.recordLimit(limit);
      const until = t.state.snapshot().limits[0]!.until;
      waits.push((until - t.clock.now) / 1000);
      t.clock.now = until;
    }
    expect(waits).toEqual([900, 1800, 3600, 7200, 14400, 14400, 14400]);
    t.cleanup();
  });

  it("announces each change once", () => {
    const t = setup();
    const limit = { kind: "plan_limit", scope: "*", resetsAt: NOW + 1 } as const;
    t.state.recordLimit(limit);
    t.state.recordLimit(limit);
    t.state.recordGatewayServed("frontier");
    t.state.recordGatewayServed("medium");
    t.state.recordPlanSuccess("claude-opus-5-5");
    t.state.recordPlanSuccess("claude-opus-5-5");
    expect(t.changes).toEqual(["limited", "overflow", "recovered"]);
    t.cleanup();
  });

  it("saves privately and restores", () => {
    const t = setup();
    t.state.recordLimit({
      kind: "plan_limit",
      scope: "*",
      resetsAt: NOW + 5000,
      claim: "five_hour",
    });
    expect(statSync(t.file).mode & 0o777).toBe(0o600);
    const restored = new PlanState(t.file, () => NOW);
    restored.load();
    expect(restored.isBlocked("claude-haiku-5-5")).toBe(true);
    expect(restored.reportLimits()).toEqual([
      { scope: "*", resetsAt: NOW + 5000, claim: "five_hour" },
    ]);
    t.cleanup();
  });

  it("does not report a guessed reset time", () => {
    const t = setup();
    t.state.recordLimit({ kind: "plan_limit", scope: "*" });
    expect(t.state.reportLimits()).toEqual([{ scope: "*" }]);
    t.cleanup();
  });
});

describe("configuration", () => {
  it("only allows Anthropic, or loopback for tests, as the login's destination", () => {
    expect(parseAnthropicUrl("https://api.anthropic.com/").origin).toBe(
      "https://api.anthropic.com",
    );
    expect(parseAnthropicUrl("http://127.0.0.1:9999").port).toBe("9999");
    for (const bad of [
      "https://example.com",
      "http://api.anthropic.com",
      "https://api.anthropic.com.evil.example",
      "http://10.0.0.1",
    ]) {
      expect(() => parseAnthropicUrl(bad)).toThrow(EdgeConfigError);
    }
  });

  it("requires https for a remote gateway", () => {
    expect(parseGatewayUrl("https://llm.example.com/").origin).toBe("https://llm.example.com");
    expect(parseGatewayUrl("http://localhost:4141").port).toBe("4141");
    expect(() => parseGatewayUrl("http://llm.example.com")).toThrow(EdgeConfigError);
    expect(() => parseGatewayUrl("https://llm.example.com/v1")).toThrow("must not include a path");
  });

  it("loads a private config file", () => {
    const { dir, cleanup } = tempFile("x");
    const env = { HOME: dir, LLMR_EDGE_CONFIG_DIR: dir, LLMR_EDGE_STATE_DIR: dir };
    const paths = edgePaths(env);
    expect(() => loadEdgeConfig(paths, env)).toThrow("not set up");
    writeConfigFile(paths, {
      edgeKey: generateEdgeKey(),
      gatewayUrl: "https://llm.example.com",
      routerKey: "llmr_key",
    });
    expect(statSync(paths.configFile).mode & 0o777).toBe(0o600);
    expect(loadEdgeConfig(paths, env)).toMatchObject({
      port: 4142,
      routerKey: "llmr_key",
      desktopNotifications: true,
    });
    cleanup();
  });

  it("generates long edge keys", () => {
    expect(generateEdgeKey().length).toBeGreaterThanOrEqual(32);
    expect(generateEdgeKey()).not.toBe(generateEdgeKey());
  });
});

describe("upstream URLs", () => {
  const base = new URL("https://api.anthropic.com");

  it("keeps normal paths and queries", () => {
    expect(upstreamUrl("/v1/messages?beta=true", base)?.href).toBe(
      "https://api.anthropic.com/v1/messages?beta=true",
    );
  });

  it("refuses anything that could change the host", () => {
    for (const target of ["//evil.example/x", "http://evil.example/", "/\\evil.example", "x"]) {
      expect(upstreamUrl(target, base)).toBeNull();
    }
  });
});

describe("status line", () => {
  const base = { limits: [], usage: {}, servedBy: null, gatewayReachable: true, updatedAt: NOW };
  const limit = { scope: "*", since: NOW, until: NOW + 3_600_000, knownReset: true };
  const clock = (time: number) => {
    const date = new Date(time);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  };

  it("says when the edge is not running", () => {
    expect(formatStatusLine(null, NOW)).toContain("not running");
  });

  it("shows plan usage when all is well", () => {
    expect(formatStatusLine(base, NOW)).toBe("plan ok");
    expect(formatStatusLine({ ...base, usage: { "5h": 0.234, "7d": 0.5 } }, NOW)).toBe(
      "plan 5h 23% · 7d 50%",
    );
  });

  it("warns during a limit and names what is serving", () => {
    expect(formatStatusLine({ ...base, limits: [limit] }, NOW)).toBe(
      `⚠ Claude plan limit until ${clock(limit.until)}`,
    );
    expect(
      formatStatusLine(
        { ...base, limits: [limit], servedBy: { kind: "gateway", tier: "frontier", at: NOW } },
        NOW,
      ),
    ).toBe(`⚠ Claude plan limit until ${clock(limit.until)} · using API (frontier)`);
  });

  it("names a family limit and hides guessed reset times", () => {
    expect(
      formatStatusLine(
        { ...base, limits: [{ ...limit, scope: "family:opus", knownReset: false }] },
        NOW,
      ),
    ).toBe("⚠ Claude opus plan limit");
  });

  it("shows the day for a reset more than a day away", () => {
    const line = formatStatusLine(
      { ...base, limits: [{ ...limit, until: NOW + 3 * 86_400_000 }] },
      NOW,
    );
    expect(line).toMatch(/until (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d\d:\d\d/);
  });
});

describe("notifications", () => {
  it("passes text as an argument, so it cannot change the script", () => {
    const text = 'x" & do shell script "rm -rf ~';
    const command = notificationCommand("darwin", text)!;
    expect(command.file).toBe("osascript");
    expect(command.args.at(-1)).toBe(text);
    expect(command.args.slice(0, -1).join(" ")).not.toContain("rm -rf");
  });

  it("uses notify-send on Linux and nothing elsewhere", () => {
    expect(notificationCommand("linux", "hi")).toEqual({
      file: "notify-send",
      args: ["--", "llm-router", "hi"],
    });
    expect(notificationCommand("win32", "hi")).toBeNull();
  });

  it("words each change", () => {
    const limit = { scope: "*", since: 0, until: 1, knownReset: true };
    expect(changeMessage({ kind: "limited", limit }, true)).toContain("continue");
    expect(changeMessage({ kind: "limited", limit }, false)).toContain("No gateway");
    expect(changeMessage({ kind: "recovered", scope: "*" }, true)).toContain("available again");
    expect(changeMessage({ kind: "recovered", scope: "family:opus" }, true)).toBeNull();
    expect(changeMessage({ kind: "overflow", tier: "medium" }, true)).toContain("medium");
  });
});

describe("service files", () => {
  const program = {
    node: "/opt/n&de/bin/node",
    program: "/home/me/llmr edge.mjs",
    logDir: "/tmp/l",
  };

  it("writes a valid launchd plist", () => {
    const plist = launchdPlist(program);
    expect(plist).toContain("/opt/n&amp;de/bin/node");
    expect(plist).toContain("<string>serve</string>");
    if (process.platform === "darwin") {
      const { file, cleanup } = tempFile("edge.plist");
      writeFileSync(file, plist);
      expect(execFileSync("plutil", ["-lint", file]).toString()).toContain("OK");
      cleanup();
    }
  });

  it("writes a systemd unit with quoted paths", () => {
    const unit = systemdUnit({ ...program, program: "/home/me/100%/edge.mjs" });
    expect(unit).toContain('ExecStart="/opt/n&de/bin/node" "/home/me/100%%/edge.mjs" serve');
    expect(unit).toContain("WantedBy=default.target");
  });

  it("picks the right file for each platform", () => {
    const paths = edgePaths({ HOME: "/home/me" });
    expect(serviceFile("darwin", paths, program, 501)?.install).toEqual([
      [
        "launchctl",
        "bootstrap",
        "gui/501",
        "/home/me/Library/LaunchAgents/org.llm-router.edge.plist",
      ],
    ]);
    expect(serviceFile("linux", paths, program, 1000)?.path).toBe(
      "/home/me/.config/systemd/user/llmr-edge.service",
    );
    expect(serviceFile("win32", paths, program, 0)).toBeNull();
  });
});
