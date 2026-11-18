import type { AddressInfo } from "node:net";
import { pino } from "pino";
import { buildApp } from "../src/app.js";
import { parseConfig } from "../src/config/load.js";
import { FakeUpstream } from "../src/dev/fake-upstream.js";
import { MemoryPersistence, type Persistence } from "../src/ledger/records.js";
import type { RouterEvent } from "../src/notify/notifier.js";
import { createRuntime, restoreState, type Runtime } from "../src/runtime.js";

export const CHAT_KEY = "llmr_chat_key_0123456789abcdefghijklmnop";
export const SCRIPT_KEY = "llmr_script_key_0123456789abcdefghijklmn";
export const LIMITED_KEY = "llmr_limited_key_0123456789abcdefghijklm";
export const ADMIN_KEY = "llmr_admin_key_0123456789abcdefghijklmno";

export const BASE_CONFIG = `
version: 1
server: { host: 127.0.0.1, port: 0, max_body_mb: 1 }
admin: { key_env: ADMIN_KEY }
clients:
  - { id: chat, key_env: CHAT_KEY, notice: text }
  - { id: script, key_env: SCRIPT_KEY, notice: none }
  - { id: limited, key_env: LIMITED_KEY, rpm: 2, allow_accounts: [gateway-a] }
accounts:
  gateway-a: { base_url_env: UPSTREAM_URL, api_key_env: GATEWAY_KEY, compat: new_api, cost_class: prepaid, trust: self_hosted }
  openai-key: { base_url_env: UPSTREAM_URL, api_key_env: OPENAI_KEY, compat: openai, cost_class: metered, budget: { daily_usd: 1 } }
  gemini-key: { base_url_env: UPSTREAM_URL, api_key_env: GEMINI_KEY, compat: gemini, cost_class: metered }
tiers:
  frontier:
    fallback_tiers: [medium, flash]
    context_window: 200000
    targets:
      - { account: gateway-a, model: f-one }
      - { account: openai-key, model: f-two }
  medium:
    fallback_tiers: [flash]
    targets:
      - { account: gemini-key, model: m-one }
  flash:
    targets:
      - { account: gemini-key, model: l-one }
aliases:
  - { match: "claude-opus-*", tier: frontier }
  - { match: fast, tier: flash }
timeouts: { keepalive_after_s: 30, keepalive_interval_s: 15 }
`;

export const PRICING = `
version: test
default: { input: 10, output: 50 }
models:
  f-two: { input: 20, output: 100 }
`;

export interface TestGateway {
  url: string;
  runtime: Runtime;
  upstream: FakeUpstream;
  events: RouterEvent[];
  persistence: Persistence;
  close(): Promise<void>;
  post(
    body: unknown,
    options?: { key?: string; headers?: Record<string, string> },
  ): Promise<Response>;
}

export interface GatewayOptions {
  yaml?: string;
  upstream?: FakeUpstream;
  persistence?: Persistence;
  now?: () => number;
}

export async function startGateway(options: GatewayOptions = {}): Promise<TestGateway> {
  const upstream = options.upstream ?? (await new FakeUpstream().start());
  const { config } = parseConfig(options.yaml ?? BASE_CONFIG, PRICING, {
    ADMIN_KEY,
    CHAT_KEY,
    SCRIPT_KEY,
    LIMITED_KEY,
    UPSTREAM_URL: upstream.url,
    GATEWAY_KEY: "upstream-gateway-key",
    OPENAI_KEY: "upstream-openai-key",
    GEMINI_KEY: "upstream-gemini-key",
  });
  const events: RouterEvent[] = [];
  const persistence = options.persistence ?? new MemoryPersistence();
  const runtime = createRuntime(config, {
    log: pino({ level: "silent" }),
    persistence,
    sinks: [async (event) => void events.push(event)],
    ...(options.now ? { now: options.now } : {}),
  });
  await restoreState(runtime);
  const app = buildApp(runtime);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    runtime,
    upstream,
    events,
    persistence,
    post: (body, requestOptions = {}) =>
      fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${requestOptions.key ?? CHAT_KEY}`,
          "content-type": "application/json",
          ...requestOptions.headers,
        },
        body: JSON.stringify(body),
      }),
    close: async () => {
      await app.close();
      await runtime.upstream.close();
      if (!options.upstream) await upstream.stop();
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const readJson = (response: Response): Promise<any> => response.json();

export const userMessage = (content = "Hello") => [{ role: "user", content }];

/** Reads an SSE response into its data payloads and comment lines. */
export async function readEvents(response: Response) {
  const text = await response.text();
  const blocks = text.split("\n\n").filter(Boolean);
  const comments = blocks.filter((block) => block.startsWith(":"));
  const data = blocks
    .filter((block) => block.startsWith("data: "))
    .map((block) => block.slice("data: ".length));
  const done = data.includes("[DONE]");
  const chunks = data
    .filter((item) => item !== "[DONE]")
    .map((item) => JSON.parse(item) as Record<string, any>); // eslint-disable-line @typescript-eslint/no-explicit-any
  const content = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content ?? "").join("");
  return { chunks, comments, content, done };
}
