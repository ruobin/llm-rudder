import { afterEach, describe, expect, it } from "vitest";
import { completionBody, errorStep, textStream, type FakeStep } from "../src/dev/fake-upstream.js";
import { MemoryPersistence } from "../src/ledger/records.js";
import {
  BASE_CONFIG,
  CHAT_KEY,
  MODELS,
  readEvents,
  readJson,
  SCRIPT_KEY,
  startGateway,
  userMessage,
  type TestGateway,
} from "./helpers.js";

const FAST = BASE_CONFIG.replace(
  "keepalive_after_s: 30, keepalive_interval_s: 15",
  "keepalive_after_s: 30, keepalive_interval_s: 15, commit_s: 0.15, first_byte_s: 0.15, stream_idle_s: 0.15",
);

let gateway: TestGateway | undefined;
afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

const stream = (body: Record<string, unknown>, key = CHAT_KEY) =>
  gateway!.post({ ...body, stream: true }, { key });

class Random {
  constructor(private seed: number) {}
  next(limit: number): number {
    this.seed = (this.seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return Math.floor((this.seed / 2_147_483_648) * limit);
  }
}

function faulty(model: string, kind: number): FakeStep | null {
  const healthy = textStream(model, `Complete answer from ${model}`) as Extract<
    FakeStep,
    { type: "stream" }
  >;
  switch (kind) {
    case 0:
      return errorStep(500, "server_error", "Failed");
    case 1:
      return errorStep(429, "rate_limit_exceeded", "Slow down");
    case 2:
      return errorStep(429, "insufficient_quota", "No quota");
    case 3:
      return { type: "text", status: 502, text: "<html>Bad gateway</html>" };
    case 4:
      return { type: "hang" };
    case 5:
      return { type: "stream", events: [], end: "drop" };
    case 6:
      return { ...healthy, events: healthy.events.slice(0, 2), end: "drop" };
    case 7:
      return { type: "stream", events: ["data: {not json", "data: [DONE]"] };
    case 8:
      return { type: "json", status: 200, body: { unexpected: true } };
    case 9:
      return { ...healthy, delayMs: 400 };
    default:
      return null;
  }
}

describe("injected failures", () => {
  it("keeps every promise through a storm of random upstream faults", async () => {
    let time = Date.parse("2026-11-18T00:00:00Z");
    gateway = await startGateway({ yaml: FAST, models: MODELS, now: () => time });
    const random = new Random(20261118);
    const total = 120;
    const results: { status: number; models: Set<string>; stream: boolean }[] = [];

    for (let index = 0; index < total; index += 1) {
      // Pauses from earlier faults have passed by the next request.
      time += 3_600_000;
      for (const model of ["f-one", "f-two", "m-one", "l-one"]) {
        gateway.upstream.clear(model);
        const step = faulty(model, random.next(16));
        if (step) gateway.upstream.script(model, step);
      }
      const streaming = random.next(2) === 0;
      const body = { model: "frontier", messages: userMessage(`Conversation ${index}`) };
      const response = streaming
        ? await stream(body)
        : await gateway.post(body, { key: SCRIPT_KEY });
      const text = await response.text();
      const models = new Set(text.match(/(?:from|answer from) ([fml]-[a-z]+)/g) ?? []);
      results.push({ status: response.status, models, stream: streaming });
    }

    // A client never receives text from two different models in one answer.
    expect(results.filter((result) => result.models.size > 1)).toEqual([]);
    expect(results.every((result) => result.status < 600 && result.status >= 200)).toBe(true);
    expect(results.some((result) => result.status === 200)).toBe(true);
    expect(results.some((result) => result.status !== 200)).toBe(true);

    await gateway.persistence.flush();
    const memory = gateway.persistence as MemoryPersistence;
    expect(memory.ledger).toHaveLength(total);
    expect(gateway.runtime.limits.activeRequests()).toBe(0);
    expect((await fetch(`${gateway.url}/healthz`)).status).toBe(200);
    time += 3_600_000;
    gateway.upstream.clear("f-one");
    expect((await gateway.post({ model: "frontier", messages: userMessage("after") })).status).toBe(
      200,
    );
  }, 60_000);

  it("releases everything when clients disconnect in the middle of streams", async () => {
    gateway = await startGateway({ yaml: BASE_CONFIG, models: MODELS });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const step = textStream("f-one", "one two three four") as Extract<FakeStep, { type: "stream" }>;
    gateway.upstream.setAlways("f-one", { ...step, pause: { afterEvents: 2, until: held } });
    const controllers = Array.from({ length: 10 }, () => new AbortController());
    await Promise.all(
      controllers.map(async (controller, index) => {
        const response = await fetch(`${gateway!.url}/v1/chat/completions`, {
          method: "POST",
          signal: controller.signal,
          headers: { authorization: `Bearer ${CHAT_KEY}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: "frontier",
            stream: true,
            messages: userMessage(`C${index}`),
          }),
        });
        await response.body!.getReader().read();
      }),
    );
    expect(gateway.runtime.limits.activeRequests()).toBe(10);
    for (const controller of controllers) controller.abort();
    await expect.poll(() => gateway!.runtime.limits.activeRequests(), { timeout: 3000 }).toBe(0);
    release();
    await gateway.persistence.flush();
    const outcomes = (gateway.persistence as MemoryPersistence).ledger.map(
      (e) => e.request.outcome,
    );
    expect(outcomes).toEqual(Array(10).fill("client_aborted"));
  });

  it("keeps serving while the database is down, and says so", async () => {
    class BrokenDatabase extends MemoryPersistence {
      override async ping(): Promise<void> {
        throw new Error("connection refused");
      }
      override async usageRows(): Promise<never> {
        throw new Error("connection refused");
      }
    }
    gateway = await startGateway({
      yaml: BASE_CONFIG,
      models: MODELS,
      persistence: new BrokenDatabase(),
    });
    const answer = await gateway.post({ model: "frontier", messages: userMessage() });
    expect(answer.status).toBe(200);
    expect((await readJson(answer)).choices[0].message.content).toBe("Hello from f-one");
    expect((await fetch(`${gateway.url}/readyz`)).status).toBe(503);
    expect((await fetch(`${gateway.url}/healthz`)).status).toBe(200);
  });

  it("does not let a broken notification channel affect requests", async () => {
    gateway = await startGateway({ yaml: BASE_CONFIG, models: MODELS });
    gateway.upstream.script("f-one", errorStep(429, "insufficient_quota", "Out"));
    const notifier = gateway.runtime.notifier as unknown as { sinks: unknown[] };
    notifier.sinks.push(async () => {
      throw new Error("channel down");
    });
    const answer = await gateway.post({ model: "frontier", messages: userMessage() });
    expect(answer.status).toBe(200);
    await answer.text();
    await gateway.runtime.notifier.flush();
  });

  it("answers normally when an upstream sends a valid reply after a failover", async () => {
    gateway = await startGateway({ yaml: BASE_CONFIG, models: MODELS });
    gateway.upstream.script("f-one", { type: "text", status: 503, text: "<html>down</html>" });
    gateway.upstream.script("f-two", { type: "json", body: completionBody("f-two", "Recovered") });
    const answer = await gateway.post({ model: "frontier", messages: userMessage() });
    expect((await readJson(answer)).choices[0].message.content).toBe("Recovered");
    const events = await readEvents(
      await stream({ model: "frontier", messages: userMessage("x") }),
    );
    expect(events.done).toBe(true);
  });
});
