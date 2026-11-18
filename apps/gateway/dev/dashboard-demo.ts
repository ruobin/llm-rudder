/**
 * Starts the dashboard with a fake gateway and a month of made-up traffic. It needs
 * no accounts, keys or database. Run it with: pnpm demo:dashboard
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../src/auth/password.js";
import {
  anthropicErrorStep,
  anthropicMessageBody,
  completionBody,
  errorStep,
  responsesBody,
  type FakeStep,
} from "../src/dev/fake-upstream.js";
import {
  ADMIN_KEY,
  CHAT_KEY,
  LIMITED_KEY,
  MODELS,
  SCRIPT_KEY,
  startGateway,
} from "../test/helpers.js";

const PASSWORD = "demo-password";
const PORT = process.env.PORT ?? "4150";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const DAYS = 30;

const CONFIG = `
version: 1
server: { host: 127.0.0.1, port: 0, max_body_mb: 8 }
admin: { key_env: ADMIN_KEY }
clients:
  - { id: opencode, key_env: CHAT_KEY, notice: text }
  - { id: open-webui, key_env: SCRIPT_KEY, notice: text }
  - { id: scripts, key_env: LIMITED_KEY, notice: none, rpm: 240 }
accounts:
  anthropic-key:
    api: anthropic.messages
    base_url_env: UPSTREAM_URL
    api_key_env: ANTHROPIC_KEY
    cost_class: metered
    trust: first_party
    budget: { daily_usd: 40, monthly_usd: 500 }
  openai-key:
    api: openai.responses
    base_url_env: UPSTREAM_URL
    api_key_env: OPENAI_KEY
    compat: openai
    cost_class: metered
    trust: first_party
    budget: { daily_usd: 25, monthly_usd: 300 }
  gemini-key:
    base_url_env: UPSTREAM_URL
    api_key_env: GEMINI_KEY
    compat: gemini
    cost_class: metered
    trust: first_party
    budget: { daily_usd: 15, monthly_usd: 150 }
  my-gateway:
    base_url_env: UPSTREAM_URL
    api_key_env: GATEWAY_KEY
    compat: new_api
    cost_class: prepaid
    balance: { warn_below_usd: 20 }
tiers:
  frontier:
    fallback_tiers: [medium, flash]
    context_window: 200000
    targets:
      - { account: anthropic-key, model: claude-opus-5-5 }
      - { account: openai-key, model: gpt-6.2-astra, effort: high }
  medium:
    fallback_tiers: [flash]
    context_window: 200000
    targets:
      - { account: my-gateway, model: gpt-6.1-sol }
      - { account: anthropic-key, model: claude-sonnet-5-5 }
      - { account: gemini-key, model: gemini-4-hydrogen }
  flash:
    fallback_tiers: [medium]
    context_window: 200000
    targets:
      - { account: gemini-key, model: gemini-3.5-flash-lite }
      - { account: my-gateway, model: gpt-6.1-terra }
      - { account: openai-key, model: gpt-6-luna }
aliases:
  - { match: "claude-opus-*", tier: frontier }
  - { match: "claude-sonnet-*", tier: medium }
  - { match: "claude-haiku-*", tier: flash }
timeouts: { keepalive_after_s: 30, keepalive_interval_s: 15 }
`;

const startedAt = Date.now();
let simulated: number | null = startedAt - DAYS * DAY_MS;
let seed = 7;
const random = (limit: number) => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return Math.floor((seed / 2_147_483_648) * limit);
};

const gateway = await startGateway({
  yaml: CONFIG,
  models: MODELS,
  pricing: readFileSync(new URL("../../../config/pricing.yaml", import.meta.url), "utf8"),
  now: () => simulated ?? Date.now(),
});
const { upstream, runtime } = gateway;

/** Answers with varied token counts, and lets a little simulated time pass. */
upstream.respond = ({ path, body }): FakeStep | undefined => {
  if (simulated !== null) simulated += 400 + random(3_600);
  const model = String(body.model);
  const text = `Hello from ${model}`;
  const input = 900 + random(24_000);
  const output = 80 + random(2_600);
  const cached = random(3) === 0 ? 0 : Math.floor(input * 0.7);
  if (path.startsWith("/v1/messages")) {
    const usage = {
      input_tokens: input - cached,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
      output_tokens: output,
    };
    return { type: "json", body: { ...anthropicMessageBody(model, text), usage } };
  }
  if (path.startsWith("/v1/responses")) {
    const usage = {
      input_tokens: input,
      input_tokens_details: { cached_tokens: cached },
      output_tokens: output,
      total_tokens: input + output,
    };
    return { type: "json", body: { ...responsesBody(model, text), usage } };
  }
  if (path.startsWith("/v1/chat/completions")) {
    const usage = {
      prompt_tokens: input,
      prompt_tokens_details: { cached_tokens: cached },
      completion_tokens: output,
      total_tokens: input + output,
    };
    return { type: "json", body: { ...completionBody(model, text), usage } };
  }
  return undefined;
};

upstream
  .setPath("/v1/dashboard/billing/subscription", { type: "json", body: { hard_limit_usd: 200 } })
  .setPath("/v1/dashboard/billing/usage", { type: "json", body: { total_usage: 14_260 } });

async function addClient(id: string, rpm: number): Promise<string> {
  const response = await fetch(`${gateway.url}/router/clients`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ id, rpm, notice: "text" }),
  });
  return ((await response.json()) as { key: string }).key;
}

const clients = [
  ...Array<string>(8).fill(CHAT_KEY),
  ...Array<string>(5).fill(SCRIPT_KEY),
  ...Array<string>(3).fill(LIMITED_KEY),
  ...Array<string>(3).fill(await addClient("codex", 120)),
  ...Array<string>(2).fill(await addClient("pi", 120)),
];
const tiers = ["frontier", "frontier", "medium", "medium", "medium", "flash", "flash"];

async function ask(key: string, model: string, conversation: number): Promise<void> {
  const prompt = `Conversation ${conversation}`;
  const response = await gateway.post(
    { model, messages: [{ role: "user", content: prompt }] },
    { key },
  );
  await response.text();
}

/** Something goes wrong now and then, as it does with real providers. */
function maybeFail(): void {
  const roll = random(100);
  if (roll < 4) upstream.script("gpt-6.1-sol", errorStep(503, "", "No available accounts"));
  else if (roll < 7) upstream.script("gemini-3.5-flash-lite", errorStep(500, "", "Internal error"));
  else if (roll < 9) {
    upstream.script("gemini-3.5-flash-lite", errorStep(429, "", "Too many requests"));
  } else if (roll < 11) {
    upstream.script(
      "claude-opus-5-5",
      anthropicErrorStep(529, "overloaded_error", "The service is overloaded."),
    );
  }
}

let conversation = 0;
for (let day = DAYS - 1; day >= 0; day -= 1) {
  const dayStart = Math.floor((startedAt - day * DAY_MS) / DAY_MS) * DAY_MS;
  const weekday = new Date(dayStart).getUTCDay();
  const weekend = weekday === 0 || weekday === 6;
  const count = (weekend ? 10 : 26) + Math.floor((DAYS - day) / 2) + random(10);
  const latest = day === 0 ? Math.max(dayStart, startedAt - HOUR_MS) : dayStart + 23 * HOUR_MS;
  const times = Array.from({ length: count }, () =>
    Math.min(latest, dayStart + (7 + random(15)) * HOUR_MS + random(HOUR_MS)),
  ).sort((a, b) => a - b);
  for (const time of times) {
    simulated = Math.max(simulated ?? time, time);
    maybeFail();
    conversation += 1;
    await ask(clients[random(clients.length)]!, tiers[random(tiers.length)]!, conversation);
  }
}

// A few minutes ago, with a clean slate for the incident the pages will show.
simulated = Date.now() - 4 * 60_000;
for (const id of runtime.config.accounts.keys()) runtime.quota.reset(id);
upstream.clear("gpt-6.1-sol").clear("gemini-3.5-flash-lite").clear("claude-opus-5-5");

// Both frontier accounts run out, so frontier requests drop to medium with a warning.
upstream.script(
  "claude-opus-5-5",
  anthropicErrorStep(402, "billing_error", "Your credit balance is too low."),
);
upstream.script("gpt-6.2-astra", errorStep(429, "insufficient_quota", "You exceeded your quota."));
for (let index = 0; index < 6; index += 1) {
  simulated += 20_000;
  conversation += 1;
  await ask(clients[index * 3]!, index % 2 === 0 ? "frontier" : "medium", conversation);
}
simulated = null;
await runtime.balances.check();
await runtime.notifier.flush();

const dashboard = spawn(
  "pnpm",
  ["exec", "next", "dev", "--hostname", "127.0.0.1", "--port", PORT],
  {
    cwd: fileURLToPath(new URL("../../dashboard", import.meta.url)),
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      LLMR_GATEWAY_URL: gateway.url,
      LLMR_ADMIN_KEY: ADMIN_KEY,
      LLMR_DASHBOARD_PASSWORD_HASH: await hashPassword(PASSWORD),
      LLMR_DASHBOARD_SESSION_SECRET: randomBytes(32).toString("base64url"),
    },
  },
);

console.log(`\nDashboard: http://127.0.0.1:${PORT}\nPassword: ${PASSWORD}\n`);

const stop = () => {
  dashboard.kill();
  void gateway.close().finally(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
dashboard.on("exit", stop);
