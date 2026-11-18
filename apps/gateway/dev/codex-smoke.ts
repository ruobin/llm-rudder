/**
 * Runs the real Codex CLI through the gateway, following the checks in Codex's
 * gateway guide: connection, tool loop, follow-up, useful errors and the catalog.
 *
 * Nothing here touches your account. Codex runs with a made-up key, an empty home
 * directory and a dead proxy for everything that is not local, and fake servers
 * stand in for every provider.
 *
 * Run it after each Codex update: pnpm smoke:codex
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  anthropicTextStream,
  anthropicToolStream,
  chatToolStream,
  responsesTextStream,
  responsesToolStream,
  textStream,
} from "../src/dev/fake-upstream.js";
import { MODELS, SCRIPT_KEY, startGateway, TRANSLATION_CONFIG } from "../test/helpers.js";

const CODEX = process.env.CODEX_BIN ?? "codex";
const TIMEOUT_MS = 90_000;
const GPT = "gpt-6.2-astra";
const OPUS = "claude-opus-5-5";
const MARKER = "codex-smoke-output-1729";

const version = spawnSync(CODEX, ["--version"], { encoding: "utf8" });
if (version.status !== 0) {
  console.log("Codex is not installed, so the smoke test was skipped.");
  process.exit(0);
}
console.log(`Testing ${version.stdout.trim()}`);

const dir = mkdtempSync(join(tmpdir(), "llmr-codex-smoke-"));
const home = join(dir, "home");
const codexHome = join(dir, "codex");
const workspace = join(dir, "workspace");
for (const path of [home, codexHome, workspace]) mkdirSync(path, { recursive: true });

const gateway = await startGateway({ yaml: TRANSLATION_CONFIG, models: MODELS });
writeFileSync(
  join(codexHome, "config.toml"),
  `model = "gpt"
model_provider = "llmr"
web_search = "disabled"

[model_providers.llmr]
name = "llm-router"
base_url = "${gateway.url}/v1"
model_catalog_url = "${gateway.url}/router/codex/models"
wire_api = "responses"
env_key = "LLMR_KEY_CODEX"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0

[analytics]
enabled = false

[feedback]
enabled = false
`,
);

let failures = 0;
function check(ok: boolean, label: string): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures += 1;
}

interface CodexResult {
  code: number | null;
  out: string;
  err: string;
}

function runCodex(args: string[], key: string = SCRIPT_KEY): Promise<CodexResult> {
  return new Promise((resolve) => {
    const child = spawn(CODEX, args, {
      cwd: workspace,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CODEX_HOME: codexHome,
        LLMR_KEY_CODEX: key,
        NO_COLOR: "1",
        // Anything that tries to leave this computer fails immediately.
        HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9",
        ALL_PROXY: "http://127.0.0.1:9",
        NO_PROXY: "127.0.0.1,localhost",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (part: Buffer) => (out += part.toString()));
    child.stderr.on("data", (part: Buffer) => (err += part.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

const exec = (model: string, prompt: string, key?: string) =>
  runCodex(
    ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--json", "-m", model, prompt],
    key,
  );
const command = { cmd: `echo ${MARKER}` };

/** Runs a task where the model executes one command and then answers. */
async function toolLoop(model: string, upstreamModel: string, answer: string) {
  const result = await exec(model, "Run the command.");
  check(result.code === 0, "Codex exits successfully");
  check(result.out.includes(answer), "the final answer reached Codex");
  const calls = gateway.upstream.requestsFor(upstreamModel);
  check(calls.length >= 2, "the model was called again after the tool ran");
  const last = JSON.stringify(calls.at(-1)?.body ?? {});
  check(last.includes(MARKER), "the command's output went back to the model");
  if (result.code !== 0) console.log(`    ${result.err.slice(-400)}`);
}

try {
  console.log("\nModel catalog");
  const catalog = await runCodex(["debug", "models"]);
  check(catalog.code === 0, "Codex accepts the catalog");
  for (const tier of ["frontier", "gpt", "claude", "gemini"]) {
    check(
      catalog.out.includes(`"slug": "${tier}"`) || catalog.out.includes(`"slug":"${tier}"`),
      `it lists ${tier}`,
    );
  }

  gateway.upstream.script(OPUS, anthropicTextStream(OPUS, "catalog-ok"));
  const known = await exec("claude", "Hello");
  check(!known.out.includes("Model metadata"), "Codex recognizes the tier as a model");
  check(
    JSON.stringify(gateway.upstream.requestsFor(OPUS).at(-1)?.body ?? {}).includes(
      "coding agent working in the user's terminal",
    ),
    "the catalog's instructions reach the model",
  );

  console.log("\nConnection, on a Responses account");
  gateway.upstream.script(GPT, responsesTextStream(GPT, "gateway-ok"));
  const connected = await exec("gpt", "Reply with exactly: gateway-ok");
  check(connected.code === 0, "Codex exits successfully");
  check(connected.out.includes("gateway-ok"), "the reply reached Codex");
  check(
    gateway.upstream.requestsFor(GPT).at(-1)?.path === "/v1/responses",
    "it used the Responses API",
  );

  console.log("\nA tool loop on a Responses account");
  gateway.upstream.script(
    GPT,
    responsesToolStream(GPT, "call_gpt", "exec_command", command),
    responsesTextStream(GPT, "gpt-finished"),
  );
  await toolLoop("gpt", GPT, "gpt-finished");

  console.log("\nA tool loop on Claude, through translation");
  gateway.upstream.script(
    OPUS,
    anthropicToolStream(OPUS, "toolu_codex", "exec_command", command),
    anthropicTextStream(OPUS, "claude-finished"),
  );
  await toolLoop("claude", OPUS, "claude-finished");

  console.log("\nA tool loop on a Chat Completions gateway, through translation");
  gateway.upstream.script(
    "gw-model",
    chatToolStream("gw-model", "call_chat", "exec_command", command),
    textStream("gw-model", "chat-finished"),
  );
  await toolLoop("chatgw", "gw-model", "chat-finished");

  console.log("\nA follow-up turn");
  gateway.upstream.script(OPUS, anthropicTextStream(OPUS, "first-answer-314"));
  await exec("claude", "Remember this.");
  gateway.upstream.script(OPUS, anthropicTextStream(OPUS, "second-answer"));
  const followUp = await runCodex([
    "exec",
    "resume",
    "--last",
    "--skip-git-repo-check",
    "--json",
    "-m",
    "claude",
    "What did you say?",
  ]);
  check(followUp.code === 0, "Codex exits successfully");
  check(followUp.out.includes("second-answer"), "the follow-up was answered");
  check(
    JSON.stringify(gateway.upstream.requestsFor(OPUS).at(-1)?.body ?? {}).includes(
      "first-answer-314",
    ),
    "the earlier answer was part of the request",
  );

  console.log("\nUseful errors");
  const unknown = await exec("no-such-tier", "Hello");
  check(unknown.code !== 0, "an unknown model fails");
  check(`${unknown.out}${unknown.err}`.includes("no-such-tier"), "the error names the model");
  const denied = await exec("gpt", "Hello", "llmr_wrong_key_0123456789abcdefghijklmn");
  check(denied.code !== 0, "a wrong key fails");
  check(
    /401|Invalid API key|Unauthorized/i.test(`${denied.out}${denied.err}`),
    "the error says why",
  );
} finally {
  await gateway.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} checks failed.`);
process.exit(failures === 0 ? 0 : 1);
