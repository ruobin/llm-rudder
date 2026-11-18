/**
 * Runs the real OpenCode and Pi CLIs through the gateway, each one reaching Claude
 * and GPT through translation and a Chat Completions account directly.
 *
 * Nothing here touches your account. Each client runs with a made-up key, empty
 * home and config directories, and a dead proxy for everything that is not local.
 *
 * Run it after updating either client: pnpm smoke:clients
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  anthropicTextStream,
  anthropicToolStream,
  chatToolStream,
  responsesTextStream,
  responsesToolStream,
  textStream,
  type FakeStep,
} from "../src/dev/fake-upstream.js";
import type { JsonObject } from "../src/types.js";
import {
  MODELS,
  PLAN_MODEL,
  SCRIPT_KEY,
  startFakeSignIn,
  startGateway,
  TRANSLATION_CONFIG,
  withChatGptPlan,
} from "../test/helpers.js";

const TIMEOUT_MS = 120_000;
const OPUS = "claude-opus-5-5";
const GPT = "gpt-6.2-astra";
const CHAT_MODEL = "gw-model";
const NOTE = "client-smoke-note-2718";

const dir = mkdtempSync(join(tmpdir(), "llmr-clients-smoke-"));
const workspace = join(dir, "workspace");
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, "note.txt"), `${NOTE}\n`);

const signIn = await startFakeSignIn();
const gateway = await startGateway({
  yaml: withChatGptPlan(TRANSLATION_CONFIG),
  models: MODELS,
  chatgpt: signIn.gatewayOptions,
});
let failures = 0;

function check(ok: boolean, label: string): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures += 1;
}

const installed = (command: string) => spawnSync(command, ["--version"]).status === 0;

interface Result {
  code: number | null;
  out: string;
  err: string;
}

function run(command: string, args: string[], env: Record<string, string>): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: workspace,
      env: {
        PATH: process.env.PATH ?? "",
        NO_COLOR: "1",
        // Anything that tries to leave this computer fails immediately.
        HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9",
        ALL_PROXY: "http://127.0.0.1:9",
        NO_PROXY: "127.0.0.1,localhost",
        ...env,
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

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

interface WireTool {
  name: string;
  properties: Record<string, unknown>;
}

/** Reads the tool list a client sent, whichever API format it arrived in. */
function toolsSeen(body: JsonObject): WireTool[] {
  const listed = (body.tools ?? []) as JsonObject[];
  const flat = listed.flatMap((tool) =>
    tool.type === "namespace" ? (tool.tools as JsonObject[]) : [tool],
  );
  return flat.map((tool) => {
    const fn = (tool.function ?? tool) as JsonObject;
    const schema = (tool.input_schema ?? fn.parameters ?? {}) as JsonObject;
    return {
      name: String(fn.name),
      properties: (schema.properties ?? {}) as Record<string, unknown>,
    };
  });
}

type Ask = (tier: string, prompt: string) => Promise<Result>;

const tiers: {
  tier: string;
  model: string;
  label: string;
  text(answer: string): FakeStep;
  tool(name: string, input: JsonObject): FakeStep;
}[] = [
  {
    tier: "claude",
    model: OPUS,
    label: "Claude, translated to Anthropic Messages",
    text: (answer) => anthropicTextStream(OPUS, answer),
    tool: (name, input) => anthropicToolStream(OPUS, "toolu_smoke", name, input),
  },
  {
    tier: "gpt",
    model: GPT,
    label: "GPT, translated to the Responses API",
    text: (answer) => responsesTextStream(GPT, answer),
    tool: (name, input) => responsesToolStream(GPT, "call_smoke", name, input),
  },
  {
    tier: "plan",
    model: PLAN_MODEL,
    label: "the ChatGPT plan",
    text: (answer) => responsesTextStream(PLAN_MODEL, answer),
    tool: (name, input) =>
      responsesToolStream(PLAN_MODEL, "call_smoke", name, input, undefined, "tools"),
  },
  {
    tier: "chatgw",
    model: CHAT_MODEL,
    label: "a Chat Completions account, with no translation",
    text: (answer) => textStream(CHAT_MODEL, answer),
    tool: (name, input) => chatToolStream(CHAT_MODEL, "call_smoke", name, input),
  },
];

async function exercise(client: string, ask: Ask): Promise<void> {
  for (const { tier, model, label, text, tool } of tiers) {
    console.log(`\n${client} on ${label}`);
    gateway.upstream.script(model, text(`${client}-hello-${tier}`));
    const hello = await ask(tier, "Say hello.");
    check(hello.code === 0, "it exits successfully");
    check(hello.out.includes(`${client}-hello-${tier}`), "the reply reached the client");
    if (hello.code !== 0) console.log(`    ${(hello.err || hello.out).slice(-500)}`);

    const first = gateway.upstream.requestsFor(model).at(-1)?.body ?? {};
    if (tier === "claude") {
      check(first.cache_control !== undefined, "prompt caching is on");
    }
    if (tier === "plan") {
      check(first.store === false && first.stream === true, "the plan's request rules are met");
      check(!("max_output_tokens" in first), "fields the plan rejects are removed");
    }
    const read = toolsSeen(first).find((entry) => entry.name.toLowerCase() === "read");
    check(read !== undefined, "the client's tools reached the model");
    if (!read) continue;

    const pathField = "filePath" in read.properties ? "filePath" : "path";
    gateway.upstream.script(
      model,
      tool(read.name, { [pathField]: join(workspace, "note.txt") }),
      text(`${client}-done-${tier}`),
    );
    const before = gateway.upstream.requestsFor(model).length;
    const loop = await ask(tier, "Read note.txt.");
    check(loop.code === 0, "it exits successfully after using a tool");
    check(loop.out.includes(`${client}-done-${tier}`), "the final answer reached the client");
    const calls = gateway.upstream.requestsFor(model).slice(before);
    check(calls.length >= 2, "the model was called again after the tool ran");
    check(JSON.stringify(calls.at(-1)?.body ?? {}).includes(NOTE), "the file's contents went back");
    if (loop.code !== 0) console.log(`    ${(loop.err || loop.out).slice(-500)}`);
  }
}

try {
  if (installed("opencode")) {
    const home = join(dir, "opencode");
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      LLMR_KEY_OPENCODE: SCRIPT_KEY,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    };
    const limit = { limit: { context: 200_000, output: 32_000 } };
    writeJson(join(home, ".config/opencode/opencode.json"), {
      $schema: "https://opencode.ai/config.json",
      model: "llmr/claude",
      providers: {
        llmr: {
          name: "llm-router",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `${gateway.url}/v1`, apiKey: "{env:LLMR_KEY_OPENCODE}" },
          models: { claude: limit, gpt: limit, plan: limit, chatgw: limit },
        },
      },
    });
    await exercise("opencode", (tier, prompt) =>
      run(
        "opencode",
        // A fixed title stops OpenCode from asking the model to write one.
        [
          "run",
          "--standalone",
          "--auto",
          "--archived",
          "--title",
          "smoke test",
          "--model",
          `llmr/${tier}`,
          prompt,
        ],
        env,
      ),
    );
  } else {
    console.log("OpenCode is not installed, so it was skipped.");
  }

  if (installed("pi")) {
    const home = join(dir, "pi");
    const env = { HOME: home, LLMR_KEY_PI: SCRIPT_KEY, PI_OFFLINE: "1" };
    const model = (id: string) => ({
      id,
      name: id,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 32_000,
    });
    writeJson(join(home, ".pi/agent/models.json"), {
      providers: {
        llmr: {
          name: "llm-router",
          baseUrl: `${gateway.url}/v1`,
          api: "openai-completions",
          apiKey: "$LLMR_KEY_PI",
          authHeader: true,
          compat: { sendSessionAffinityHeaders: true },
          models: [model("claude"), model("gpt"), model("plan"), model("chatgw")],
        },
      },
    });
    await exercise("pi", (tier, prompt) =>
      run(
        "pi",
        [
          "-p",
          "--no-session",
          "--offline",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--no-context-files",
          "--no-mcp",
          "--tools",
          "read",
          "--model",
          `llmr/${tier}`,
          prompt,
        ],
        env,
      ),
    );
  } else {
    console.log("Pi is not installed, so it was skipped.");
  }
} finally {
  await gateway.close();
  await signIn.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} checks failed.`);
process.exit(failures === 0 ? 0 : 1);
