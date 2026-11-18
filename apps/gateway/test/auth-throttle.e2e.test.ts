import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_KEY, CHAT_KEY, readJson, startGateway, userMessage } from "./helpers.js";
import type { TestGateway } from "./helpers.js";

const WRONG_KEY = "llmr_this_key_is_not_configured_anywhere_at_all";
const MAX_FAILURES = 10;

let gateway: TestGateway;
let clock = 1_000_000;

const ask = (key: string) => gateway.post({ model: "medium", messages: userMessage() }, { key });
const status = (key: string) =>
  fetch(`${gateway.url}/router/status`, { headers: { authorization: `Bearer ${key}` } });

async function useUpFailures(): Promise<void> {
  for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) {
    expect((await ask(WRONG_KEY)).status).toBe(401);
  }
}

beforeEach(async () => {
  clock = 1_000_000;
  gateway = await startGateway({ now: () => clock });
});

afterEach(() => gateway.close());

describe("repeated failed authentication", () => {
  it("slows down an address that keeps sending wrong keys", async () => {
    await useUpFailures();

    const blocked = await ask(WRONG_KEY);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect((await readJson(blocked)).error.code).toBe("too_many_auth_failures");
    expect((await status(WRONG_KEY)).status).toBe(429);
  });

  it("does not lock out working keys at the same address", async () => {
    await useUpFailures();

    expect((await ask(CHAT_KEY)).status).toBe(200);
    expect((await status(ADMIN_KEY)).status).toBe(200);
  });

  it("forgets the failures after a minute", async () => {
    await useUpFailures();
    clock += 60_000;

    expect((await ask(WRONG_KEY)).status).toBe(401);
  });
});
