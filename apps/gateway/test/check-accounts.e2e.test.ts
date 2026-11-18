import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkAccounts,
  formatReports,
  hasFailures,
  type AccountReport,
} from "../src/check-accounts.js";
import { parseConfig } from "../src/config/load.js";
import { chatToolStream, errorStep, FakeUpstream, textStream } from "../src/dev/fake-upstream.js";
import { ADMIN_KEY, CHAT_KEY, MODELS, PRICING } from "./helpers.js";

const CONFIG = `
version: 1
admin: { key_env: ADMIN_KEY }
clients:
  - { id: chat, key_env: CHAT_KEY }
accounts:
  my-gateway:
    base_url_env: UPSTREAM_URL
    api_key_env: GATEWAY_KEY
    compat: new_api
    cost_class: prepaid
    budget: { daily_usd: 0.000001 }
  spare: { base_url_env: UPSTREAM_URL, api_key_env: SPARE_KEY, cost_class: metered }
  unused: { base_url_env: UPSTREAM_URL, api_key_env: SPARE_KEY, cost_class: metered }
  claude-plan: { kind: edge_only, cost_class: prepaid, trust: first_party }
  chatgpt-plan: { kind: chatgpt_plan, cost_class: prepaid, trust: first_party }
  switched-off:
    base_url_env: UPSTREAM_URL
    api_key_env: SPARE_KEY
    cost_class: metered
    enabled: false
tiers:
  frontier:
    fallback_tiers: [medium]
    targets:
      - { account: my-gateway, model: big-model, effort: high }
      - { account: spare, model: spare-model }
  medium:
    targets:
      - { account: my-gateway, model: big-model }
      - { account: my-gateway, model: small-model }
      - { account: chatgpt-plan, model: plan-model }
`;

const toolStep = (model: string) => chatToolStream(model, "call_1", "get_time", { city: "Paris" });
const modelList = (...ids: string[]) => ({
  type: "json" as const,
  body: { object: "list", data: ids.map((id) => ({ id })) },
});
const noLimit = { type: "json" as const, body: { hard_limit_usd: 100_000_000 } };
const noUsage = { type: "json" as const, body: { total_usage: 0 } };

let upstream: FakeUpstream;

const loadTestConfig = () =>
  parseConfig(
    CONFIG,
    PRICING,
    {
      ADMIN_KEY,
      CHAT_KEY,
      UPSTREAM_URL: upstream.url,
      GATEWAY_KEY: "upstream-gateway-key",
      SPARE_KEY: "upstream-spare-key",
    },
    MODELS,
  ).config;

const textsOf = (reports: AccountReport[], id: string) =>
  reports.find((report) => report.accountId === id)!.lines.map((line) => line.text);
const statusesOf = (reports: AccountReport[], id: string) =>
  reports.find((report) => report.accountId === id)!.lines.map((line) => line.status);
const chatRequests = () => upstream.requests.filter(({ path }) => path === "/v1/chat/completions");

beforeEach(async () => {
  upstream = await new FakeUpstream().start();
  upstream
    .setPath("/v1/models", modelList("big-model", "small-model", "spare-model"))
    .setPath("/v1/dashboard/billing/subscription", noLimit)
    .setPath("/v1/dashboard/billing/usage", noUsage);
});

afterEach(() => upstream.stop());

describe("checking accounts without sending requests", () => {
  it("confirms the key, the balance and each model", async () => {
    const reports = await checkAccounts(loadTestConfig(), { accounts: ["my-gateway"] });

    expect(reports).toHaveLength(1);
    expect(reports[0]!.heading).toMatch(/^my-gateway \(openai\.chat, 127\.0\.0\.1:\d+\)$/);
    expect(textsOf(reports, "my-gateway")).toEqual([
      "the service answered and lists 3 models",
      "no spending limit is reported for this key",
      "frontier/big-model: listed",
      "medium/small-model: listed",
    ]);
    expect(hasFailures(reports)).toBe(false);
    expect(chatRequests()).toHaveLength(0);
    expect(upstream.requests[0]!.headers.authorization).toBe("Bearer upstream-gateway-key");
  });

  it("reports a refused key and stops there", async () => {
    upstream.setPath("/v1/models", errorStep(401, "", "Invalid token"));
    const reports = await checkAccounts(loadTestConfig(), { accounts: ["my-gateway"], live: true });

    expect(textsOf(reports, "my-gateway")).toEqual(["the service refused this key (HTTP 401)"]);
    expect(hasFailures(reports)).toBe(true);
    expect(chatRequests()).toHaveLength(0);
  });

  it("reports a model the service does not offer", async () => {
    upstream.setPath("/v1/models", modelList("big-model"));
    const reports = await checkAccounts(loadTestConfig(), { accounts: ["my-gateway"] });

    expect(textsOf(reports, "my-gateway")).toContain(
      "medium/small-model: the service does not list this model",
    );
    expect(hasFailures(reports)).toBe(true);
  });

  it("reads model names in Gemini's format", async () => {
    upstream.setPath("/v1/models", {
      type: "json",
      body: { models: [{ name: "models/big-model" }, { name: "models/small-model" }] },
    });
    const reports = await checkAccounts(loadTestConfig(), { accounts: ["my-gateway"] });
    expect(hasFailures(reports)).toBe(false);
  });

  it("carries on when a service has no model list", async () => {
    upstream.setPath("/v1/models", { type: "text", status: 404, text: "not found" });
    const reports = await checkAccounts(loadTestConfig(), { accounts: ["my-gateway"] });

    expect(statusesOf(reports, "my-gateway")).toEqual(["warning", "ok", "skipped", "skipped"]);
    expect(hasFailures(reports)).toBe(false);
  });

  it("reports a balance that has run out", async () => {
    upstream
      .setPath("/v1/dashboard/billing/subscription", { type: "json", body: { hard_limit_usd: 5 } })
      .setPath("/v1/dashboard/billing/usage", { type: "json", body: { total_usage: 500 } });
    const reports = await checkAccounts(loadTestConfig(), { accounts: ["my-gateway"] });

    expect(textsOf(reports, "my-gateway")).toContain("this key has no balance left");
    expect(hasFailures(reports)).toBe(true);
  });

  it("reports a service it cannot reach", async () => {
    const config = loadTestConfig();
    await upstream.stop();
    const reports = await checkAccounts(config, { accounts: ["spare"] });

    expect(textsOf(reports, "spare")[0]).toMatch(/^the service is unreachable \(/);
    expect(hasFailures(reports)).toBe(true);
    upstream = await new FakeUpstream().start();
  });

  it("explains the accounts it cannot check from here", async () => {
    const reports = await checkAccounts(loadTestConfig());

    expect(textsOf(reports, "claude-plan")[0]).toContain("llmr-edge doctor");
    expect(textsOf(reports, "chatgpt-plan")[0]).toContain("chatgpt status");
    expect(textsOf(reports, "switched-off")).toEqual(["turned off in the config"]);
    expect(textsOf(reports, "unused")).toContain("no tier uses this account");
  });
});

describe("checking accounts with real requests", () => {
  it("sends a short reply and a tool call to each model", async () => {
    upstream
      .script("big-model", textStream("big-model", "ok"), toolStep("big-model"))
      .script("small-model", textStream("small-model", "ok"), toolStep("small-model"));
    const reports = await checkAccounts(loadTestConfig(), { accounts: ["my-gateway"], live: true });

    expect(hasFailures(reports)).toBe(false);
    expect(textsOf(reports, "my-gateway")[2]).toMatch(
      /^frontier\/big-model: listed, reply in \d+\.\ds, tool call in \d+\.\ds$/,
    );
    const requests = upstream.requestsFor("big-model");
    expect(requests).toHaveLength(2);
    expect(requests[0]!.headers.authorization).toBe("Bearer upstream-gateway-key");
    expect(requests[0]!.body.reasoning_effort).toBe("high");
    expect(requests[1]!.body.tool_choice).toBe("required");
  });

  it("says why a model failed and still checks the others", async () => {
    upstream
      .setAlways("big-model", errorStep(404, "model_not_found", "No such model"))
      .script("small-model", textStream("small-model", "ok"), toolStep("small-model"));
    const reports = await checkAccounts(loadTestConfig(), { accounts: ["my-gateway"], live: true });

    const lines = textsOf(reports, "my-gateway");
    expect(lines[2]).toBe(
      "frontier/big-model: listed, no reply (unsupported, HTTP 404, model_not_found)",
    );
    expect(lines[3]).toMatch(/^medium\/small-model: listed, reply in .*tool call in/);
    expect(hasFailures(reports)).toBe(true);
  });

  it("notices a model that answers but ignores tools", async () => {
    upstream.setAlways("big-model", textStream("big-model", "It is noon."));
    upstream.script("small-model", textStream("small-model", "ok"), toolStep("small-model"));
    const reports = await checkAccounts(loadTestConfig(), { accounts: ["my-gateway"], live: true });

    expect(textsOf(reports, "my-gateway")[2]).toContain("answered without calling the tool");
    expect(hasFailures(reports)).toBe(true);
  });

  it("does not try the plan accounts", async () => {
    upstream.script("spare-model", textStream("spare-model", "ok"), toolStep("spare-model"));
    upstream
      .script("big-model", textStream("big-model", "ok"), toolStep("big-model"))
      .script("small-model", textStream("small-model", "ok"), toolStep("small-model"));
    const reports = await checkAccounts(loadTestConfig(), { live: true });

    expect(hasFailures(reports)).toBe(false);
    expect(upstream.requestsFor("plan-model")).toHaveLength(0);
  });
});

describe("the printed report", () => {
  it("shows one account per block with a status on each line", () => {
    expect(
      formatReports([
        {
          accountId: "a",
          heading: "a (openai.chat, example.com)",
          lines: [
            { status: "ok", text: "fine" },
            { status: "failed", text: "broken" },
          ],
        },
        { accountId: "b", heading: "b (edge only)", lines: [{ status: "skipped", text: "later" }] },
      ]),
    ).toBe(
      "a (openai.chat, example.com)\n  ok   fine\n  FAIL broken\n\nb (edge only)\n  skip later",
    );
  });
});
