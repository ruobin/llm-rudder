/**
 * Measures the gateway against a fake provider: the time it adds, how much memory an
 * open stream costs, and how many requests it handles. It uses no accounts or database.
 *
 * Run it with: pnpm load-test
 * Larger run: LOAD_STREAMS=2000 LOAD_REQUESTS=20000 pnpm load-test
 * With shared state: LOAD_REDIS_URL=redis://127.0.0.1:6379/0 pnpm load-test
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, request } from "undici";
import { FakeUpstream, textStream, type FakeStep } from "../src/dev/fake-upstream.js";

const STREAM_STEPS = (process.env.LOAD_STREAMS ?? "100,500,1000").split(",").map(Number);
const REQUESTS = Number(process.env.LOAD_REQUESTS ?? 5000);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 50);
const LATENCY_SAMPLES = Number(process.env.LOAD_SAMPLES ?? 500);
const MODEL = "load-model";
const CLIENT_KEY = `llmr_load_${"k".repeat(32)}`;
const ADMIN_KEY = `llmr_admin_${"a".repeat(32)}`;
const root = fileURLToPath(new URL("../../..", import.meta.url));
const gatewayDir = fileURLToPath(new URL("..", import.meta.url));

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values: number[], share: number) =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.floor(values.length * share))
  ] ?? 0;
const ms = (value: number) => `${value.toFixed(2)} ms`;

const upstream = await new FakeUpstream().start();
const directory = mkdtempSync(join(tmpdir(), "llmr-load-"));
const port = await freePort();
writeFileSync(
  join(directory, "config.yaml"),
  `version: 1
server: { host: 127.0.0.1, port: ${port}, max_body_mb: 1 }
admin: { key_env: LOAD_ADMIN_KEY }
clients:
  - { id: load, key_env: LOAD_CLIENT_KEY, max_concurrent: 100000 }
accounts:
  fake: { base_url_env: LOAD_UPSTREAM_URL, api_key_env: LOAD_UPSTREAM_KEY, cost_class: prepaid }
tiers:
  flash: { targets: [{ account: fake, model: ${MODEL} }] }
`,
);
writeFileSync(join(directory, "pricing.yaml"), readFileSync(join(root, "config/pricing.yaml")));
writeFileSync(join(directory, "models.yaml"), readFileSync(join(root, "config/models.yaml")));

function startGateway() {
  return spawn(
    process.execPath,
    ["--import", "tsx", "--conditions=@llm-rudder/source", "src/main.ts"],
    {
      cwd: gatewayDir,
      stdio: ["ignore", "ignore", "inherit"],
      env: {
        PATH: process.env.PATH,
        LOG_LEVEL: "error",
        LLMR_CONFIG: join(directory, "config.yaml"),
        LLMR_DRAIN_S: "1",
        // Set LOAD_REDIS_URL to measure with state shared through Redis.
        ...(process.env.LOAD_REDIS_URL ? { REDIS_URL: process.env.LOAD_REDIS_URL } : {}),
        LOAD_ADMIN_KEY: ADMIN_KEY,
        LOAD_CLIENT_KEY: CLIENT_KEY,
        LOAD_UPSTREAM_URL: upstream.url,
        LOAD_UPSTREAM_KEY: "fake-upstream-key",
      },
    },
  );
}

let gateway = startGateway();

async function waitForGateway(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = await fetch(`${base}/healthz`).catch(() => null);
    if (ready?.ok) return;
    await sleep(100);
  }
  throw new Error("The gateway did not start.");
}

/** Each memory test gets a fresh process, so earlier garbage does not hide the result. */
async function restartGateway(): Promise<void> {
  const stopped = new Promise((resolve) => gateway.once("exit", resolve));
  gateway.kill("SIGTERM");
  await stopped;
  gateway = startGateway();
  await waitForGateway();
}

const base = `http://127.0.0.1:${port}`;
const dispatcher = new Agent({ connections: 20_000, keepAliveTimeout: 10_000 });
const headers = { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" };

async function post(url: string, stream: boolean, id: number) {
  return request(url, {
    method: "POST",
    dispatcher,
    headers,
    body: JSON.stringify({
      model: url.startsWith(base) ? "flash" : MODEL,
      stream,
      messages: [{ role: "user", content: `Load test ${id}` }],
    }),
  });
}

async function memoryMb(): Promise<number> {
  const { body } = await request(`${base}/metrics`, {
    dispatcher,
    headers: { authorization: `Bearer ${ADMIN_KEY}` },
  });
  const line = (await body.text())
    .split("\n")
    .find((item) => item.startsWith("llmr_memory_heap_bytes"));
  return Number(line?.split(" ")[1]) / 1_048_576;
}

async function latency(url: string, stream: boolean): Promise<number[]> {
  const samples: number[] = [];
  for (let index = 0; index < LATENCY_SAMPLES; index += 1) {
    const started = performance.now();
    const { body, statusCode } = await post(url, stream, index);
    if (statusCode !== 200) throw new Error(`HTTP ${statusCode}`);
    if (stream) {
      const iterator = body[Symbol.asyncIterator]();
      await iterator.next();
      samples.push(performance.now() - started);
      await iterator.return?.();
      body.destroy();
    } else {
      await body.dump();
      samples.push(performance.now() - started);
    }
  }
  return samples;
}

function compare(label: string, direct: number[], viaGateway: number[]): void {
  const row = (name: string, share: number) =>
    `${name} ${ms(percentile(viaGateway, share))} (adds ${ms(percentile(viaGateway, share) - percentile(direct, share))})`;
  console.log(`${label}: ${row("median", 0.5)}, ${row("95th percentile", 0.95)}`);
}

async function openStreams(count: number): Promise<void> {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const step = textStream(MODEL, "one two three four five") as Extract<
    FakeStep,
    { type: "stream" }
  >;
  await restartGateway();
  for (let index = 0; index < 50; index += 1) {
    const { body } = await post(`${base}/v1/chat/completions`, false, index);
    await body.dump();
  }
  upstream.setAlways(MODEL, { ...step, pause: { afterEvents: 2, until: held } });
  await sleep(1000);
  const before = await memoryMb();
  const requestsBefore = upstream.requests.length;
  const failures: string[] = [];
  const open = await Promise.all(
    Array.from({ length: count }, async (_, index) => {
      try {
        const { body, statusCode } = await post(`${base}/v1/chat/completions`, true, index);
        if (statusCode !== 200) throw new Error(`HTTP ${statusCode}`);
        const iterator = body[Symbol.asyncIterator]();
        // Keep-alive comments can arrive first, and only model output counts.
        let text = "";
        while (!text.includes("data:")) {
          const { value, done } = await iterator.next();
          if (done) throw new Error("The stream ended early.");
          text += Buffer.from(value as Uint8Array).toString();
        }
        return { body, iterator };
      } catch (error) {
        failures.push((error as Error).message);
        return null;
      }
    }),
  );
  await sleep(500);
  const during = await memoryMb();
  const reached = upstream.requests.length - requestsBefore;
  release();
  await Promise.all(
    open.map(async (item) => {
      if (!item) return;
      for await (const _ of { [Symbol.asyncIterator]: () => item.iterator }) void _;
    }),
  );
  upstream.clear(MODEL);
  console.log(
    `${count} open streams: ${count - failures.length} succeeded, ${reached} reached the provider, memory ${before.toFixed(0)} to ${during.toFixed(0)} MB, about ${(((during - before) * 1024) / count).toFixed(0)} KB per stream`,
  );
  if (failures.length > 0) console.log(`  first failure: ${failures[0]}`);
}

async function throughput(): Promise<void> {
  let next = 0;
  let failed = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < REQUESTS) {
        next += 1;
        const { body, statusCode } = await post(`${base}/v1/chat/completions`, false, next);
        await body.dump();
        if (statusCode !== 200) failed += 1;
      }
    }),
  );
  const seconds = (performance.now() - started) / 1000;
  console.log(
    `${REQUESTS} requests, ${CONCURRENCY} at a time: ${(REQUESTS / seconds).toFixed(0)} per second, ${failed} failed`,
  );
}

let exitCode = 0;
try {
  await waitForGateway();
  const direct = `${upstream.url}/chat/completions`;
  const routed = `${base}/v1/chat/completions`;
  compare("Complete response", await latency(direct, false), await latency(routed, false));
  compare("First stream bytes", await latency(direct, true), await latency(routed, true));
  await throughput();
  for (const count of STREAM_STEPS) await openStreams(count);
  console.log(`Memory after the test: ${(await memoryMb()).toFixed(0)} MB`);
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  gateway.kill("SIGTERM");
  await upstream.stop();
  await dispatcher.close();
  rmSync(directory, { recursive: true, force: true });
}
process.exit(exitCode);
