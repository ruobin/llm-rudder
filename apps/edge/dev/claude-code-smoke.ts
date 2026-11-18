/**
 * Runs the real Claude Code CLI through the edge and a real gateway.
 *
 * Nothing here touches your account. Claude Code runs with a made-up login, an
 * empty home directory and a dead proxy for everything that is not local. Fake
 * servers stand in for api.anthropic.com and for the paid provider.
 *
 * Run it after each Claude Code update: pnpm smoke:claude-code
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anthropicTextStream } from "../../gateway/src/dev/fake-upstream.js";
import { ANTHROPIC_UPSTREAM_KEY, CLAUDE_KEY } from "../../gateway/test/helpers.js";
import { EDGE_KEY_HEADER } from "../src/server.js";
import {
  EDGE_KEY,
  HAIKU,
  LOGIN_TOKEN,
  OPUS,
  planLimitStep,
  SONNET,
  startHarness,
} from "../test/harness.js";

const CLAUDE = process.env.CLAUDE_BIN ?? "claude";
const TIMEOUT_MS = 90_000;
const MODELS = [OPUS, SONNET, HAIKU];

const version = spawnSync(CLAUDE, ["--version"], { encoding: "utf8" });
if (version.status !== 0) {
  console.log("Claude Code is not installed, so the smoke test was skipped.");
  process.exit(0);
}
console.log(`Testing ${version.stdout.trim()}`);

const dir = mkdtempSync(join(tmpdir(), "llmr-claude-smoke-"));
const home = join(dir, "home");
const workspace = join(dir, "workspace");
for (const path of [home, workspace]) mkdirSync(path, { recursive: true });

const h = await startHarness();
let failures = 0;

function check(ok: boolean, label: string): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures += 1;
}

interface ClaudeResult {
  code: number | null;
  result: string;
  stderr: string;
}

/** Claude Code through the edge, with a made-up value in place of a claude.ai login. */
const throughEdge = () => ({
  ANTHROPIC_BASE_URL: h.edge.url,
  ANTHROPIC_CUSTOM_HEADERS: `${EDGE_KEY_HEADER}: ${EDGE_KEY}`,
  CLAUDE_CODE_OAUTH_TOKEN: LOGIN_TOKEN,
});

/** Claude Code pointed straight at the gateway, the setup that needs no edge. */
const directToGateway = () => ({
  ANTHROPIC_BASE_URL: h.gateway.url,
  ANTHROPIC_AUTH_TOKEN: CLAUDE_KEY,
});

function runClaude(prompt: string, route: Record<string, string>): Promise<ClaudeResult> {
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    CLAUDE_CONFIG_DIR: join(dir, "claude"),
    ...route,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_MAX_RETRIES: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_TELEMETRY: "1",
    // Anything that tries to leave this computer fails immediately.
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
  };
  const args = [
    "-p",
    prompt,
    "--model",
    OPUS,
    "--output-format",
    "json",
    "--tools",
    "",
    "--no-session-persistence",
    "--strict-mcp-config",
  ];
  return new Promise((resolve) => {
    const child = spawn(CLAUDE, args, {
      cwd: workspace,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (part: Buffer) => (stdout += part.toString()));
    child.stderr.on("data", (part: Buffer) => (stderr += part.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      let result = stdout;
      try {
        result = String((JSON.parse(stdout) as { result?: unknown }).result ?? "");
      } catch {
        // Shown as a failed check below.
      }
      resolve({ code, result, stderr });
    });
  });
}

const messageCalls = () =>
  h.anthropic.requests.filter((request) => request.path.startsWith("/v1/messages"));
const sentToVps = () => JSON.stringify(h.toGateway.calls);

try {
  console.log("\nOn the plan");
  const onPlan = await runClaude("Say hello.", throughEdge());
  check(onPlan.code === 0, "Claude Code exits successfully");
  check(onPlan.result.includes(`Hello from ${OPUS}`), "the reply comes from the plan");
  const first = messageCalls().find((request) => request.body.model === OPUS);
  check(first !== undefined, "the request reached Anthropic's stand-in");
  check(first?.path.split("?")[0] === "/v1/messages", "it used the Messages path");
  check(first?.headers.authorization === `Bearer ${LOGIN_TOKEN}`, "the login went to Anthropic");
  check(
    String(first?.headers["anthropic-beta"]).includes("oauth-"),
    "the login beta went to Anthropic",
  );
  check(first?.headers[EDGE_KEY_HEADER] === undefined, "the edge key stayed local");
  check(h.toGateway.messageCalls.length === 0, "no model traffic went to the VPS");

  console.log("\nAfter a simulated plan limit");
  for (const model of MODELS) {
    h.anthropic.setAlways(model, planLimitStep(h.clock.now));
    h.gateway.upstream.setAlways(model, anthropicTextStream(model, "Served by the API key"));
  }
  const overflow = await runClaude("Say hello again.", throughEdge());
  check(overflow.code === 0, "Claude Code exits successfully");
  check(overflow.result.includes("Served by the API key"), "the gateway answered");
  check(h.toGateway.messageCalls.length > 0, "the request went to the VPS");
  check(!sentToVps().includes(LOGIN_TOKEN), "the login token did not go to the VPS");
  check(!sentToVps().includes("oauth-"), "the login beta did not go to the VPS");
  check(!sentToVps().includes(EDGE_KEY), "the edge key did not go to the VPS");
  check(
    h.gateway.upstream.requests.some(
      (request) => request.headers["x-api-key"] === ANTHROPIC_UPSTREAM_KEY,
    ),
    "the provider received the gateway's own key",
  );

  console.log("\nWhile the limit lasts");
  const planCalls = messageCalls().length;
  const during = await runClaude("One more time.", throughEdge());
  check(during.result.includes("Served by the API key"), "the gateway keeps answering");
  check(messageCalls().length === planCalls, "the plan is not tried again");

  console.log("\nDirectly through the gateway, with no edge");
  const providerCalls = h.gateway.upstream.requests.length;
  const direct = await runClaude("Hello gateway.", directToGateway());
  check(direct.code === 0, "Claude Code exits successfully");
  check(direct.result.includes("Served by the API key"), "the gateway answered");
  check(h.gateway.upstream.requests.length > providerCalls, "the provider was called");

  console.log("\nWith the VPS stopped");
  for (const model of MODELS) h.anthropic.clear(model);
  rmSync(h.paths.stateFile, { force: true });
  await h.restartEdge({ gatewayUrl: new URL("http://127.0.0.1:9") });
  const withoutVps = await runClaude("Are you there?", throughEdge());
  check(withoutVps.code === 0, "Claude Code exits successfully");
  check(withoutVps.result.includes(`Hello from ${OPUS}`), "the plan still answers");

  if (failures > 0 && (onPlan.stderr || overflow.stderr)) {
    console.log(`\nClaude Code said:\n${(onPlan.stderr || overflow.stderr).slice(0, 1000)}`);
  }
} finally {
  await h.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} checks failed.`);
process.exit(failures === 0 ? 0 : 1);
