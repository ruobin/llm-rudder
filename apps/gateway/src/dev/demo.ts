/**
 * Shows tier failover, tier fallback and warnings end to end, using fake
 * upstreams. It needs no API keys and no database: run `pnpm demo`.
 */
import type { AddressInfo } from "node:net";
import { pino } from "pino";
import { buildApp } from "../app.js";
import { generateKey } from "../auth/keys.js";
import { parseConfig } from "../config/load.js";
import type { EventSink } from "../notify/notifier.js";
import { createRuntime } from "../runtime.js";
import { errorStep, FakeUpstream } from "./fake-upstream.js";

const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const yellow = (text: string) => `\x1b[33m${text}\x1b[0m`;

const upstream = await new FakeUpstream().start();
const clientKey = generateKey();

const yaml = `
version: 1
server: { host: 127.0.0.1, port: 0 }
admin: { key_env: ADMIN_KEY }
clients:
  - { id: demo, key_env: CLIENT_KEY, notice: text }
accounts:
  my-gateway: { base_url_env: UPSTREAM_URL, api_key_env: UPSTREAM_KEY, compat: new_api, cost_class: prepaid, trust: self_hosted }
  openai-key: { base_url_env: UPSTREAM_URL, api_key_env: UPSTREAM_KEY, compat: openai, cost_class: metered, budget: { daily_usd: 5 } }
  gemini-key: { base_url_env: UPSTREAM_URL, api_key_env: UPSTREAM_KEY, compat: gemini, cost_class: metered, budget: { monthly_usd: 10 } }
tiers:
  frontier:
    fallback_tiers: [medium, flash]
    targets:
      - { account: my-gateway, model: claude-opus-5-5 }
      - { account: openai-key, model: gpt-6-astra }
  medium:
    fallback_tiers: [flash]
    targets:
      - { account: gemini-key, model: gemini-4-hydrogen }
      - { account: openai-key, model: gpt-6.1-sol }
  flash:
    targets:
      - { account: gemini-key, model: gemini-3.5-flash-lite }
`;
const pricing = `
version: demo
default: { input: 10, output: 50 }
`;
const { config } = parseConfig(yaml, pricing, {
  ADMIN_KEY: generateKey(),
  CLIENT_KEY: clientKey,
  UPSTREAM_URL: upstream.url,
  UPSTREAM_KEY: "demo-upstream-key",
});

const printNotification: EventSink = async (event) => {
  console.log(yellow(`  [push notification] ${event.message}`));
};
const runtime = createRuntime(config, {
  log: pino({ level: "silent" }),
  sinks: [printNotification],
});
const app = buildApp(runtime);
await app.listen({ host: "127.0.0.1", port: 0 });
const { port } = app.server.address() as AddressInfo;

async function ask(model: string, question: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${clientKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: "user", content: question }],
    }),
  });
  let text = "";
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(part, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) {
      const data = event.replace(/^data: /, "");
      if (data === "[DONE]" || event.startsWith(":")) continue;
      const content = JSON.parse(data).choices?.[0]?.delta?.content;
      if (content) text += content;
    }
  }
  const header = (name: string) => response.headers.get(`x-llmr-${name}`);
  console.log(`  status   ${response.status}`);
  console.log(`  served   ${header("target")}`);
  if (header("fallback")) console.log(`  skipped  ${header("fallback")}`);
  if (header("tier-fallback")) console.log(`  tier     ${header("tier-fallback")}`);
  console.log(`  reply    ${text.trim().replaceAll("\n", dim(" / "))}`);
  await runtime.notifier.flush();
}

console.log(bold("\n1. Normal request: frontier uses its first target"));
await ask("frontier", "What is the capital of France?");

console.log(bold("\n2. The first target runs out of quota: the same request moves on"));
upstream.setAlways(
  "claude-opus-5-5",
  errorStep(403, "insufficient_user_quota", "Insufficient quota", "new_api_error"),
);
runtime.quota.reset("my-gateway");
await ask("frontier", "And of Japan?");

console.log(bold("\n3. All of frontier is used up: the tier falls back to medium, with a warning"));
upstream.setAlways(
  "gpt-6-astra",
  errorStep(429, "insufficient_quota", "You exceeded your current quota", "insufficient_quota"),
);
runtime.quota.reset("openai-key");
await ask("frontier", "And of Italy?");

console.log(bold("\n4. The same conversation again: no repeated note or notification"));
await ask("frontier", "And of Italy?");

console.log(bold("\n5. Frontier recovers: traffic returns, and you are told"));
upstream.clear("claude-opus-5-5").clear("gpt-6-astra");
runtime.quota.reset("my-gateway");
runtime.quota.reset("openai-key");
await ask("frontier", "And of Spain?");

console.log();
await app.close();
await runtime.upstream.close();
await upstream.stop();
