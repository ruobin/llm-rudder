import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  anthropicErrorStep,
  anthropicStreamEnd,
  anthropicStreamStart,
  anthropicTextEvents,
  anthropicTextStream,
  type FakeStep,
} from "../../gateway/src/dev/fake-upstream.js";
import { ADMIN_KEY, ANTHROPIC_UPSTREAM_KEY, CLAUDE_KEY } from "../../gateway/test/helpers.js";
import { EDGE_KEY_HEADER } from "../src/server.js";
import {
  EDGE_KEY,
  HAIKU,
  LOGIN_TOKEN,
  messageRequest,
  OPUS,
  planLimitStep,
  SONNET,
  startHarness,
  type Harness,
} from "./harness.js";

let h: Harness;

const limitOpus = (overrides: Record<string, string> = {}) =>
  h.anthropic.script(OPUS, planLimitStep(h.clock.now, overrides));

/** Everything that was sent toward the VPS, as one searchable string. */
const sentToVps = () => JSON.stringify(h.toGateway.calls);
const sentToProvider = () =>
  JSON.stringify(
    h.gateway.upstream.requests.map(({ path, headers, rawBody }) => ({
      path,
      headers,
      body: rawBody.toString(),
    })),
  );

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

describe("on the plan", () => {
  it("forwards the request to Anthropic unchanged", async () => {
    const text = JSON.stringify(messageRequest());
    const response = await h.send(text);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("message_stop");

    const seen = h.anthropic.requests[0]!;
    expect(seen.path).toBe("/v1/messages?beta=true");
    expect(seen.rawBody.toString()).toBe(text);
    expect(seen.headers.authorization).toBe(`Bearer ${LOGIN_TOKEN}`);
    expect(seen.headers["anthropic-beta"]).toBe("oauth-2025-04-20,claude-code-20250219");
    expect(seen.headers["x-claude-code-session-id"]).toBe("session-1");
  });

  it("never sends the edge key or router key to Anthropic", async () => {
    await h.send(messageRequest());
    const seen = JSON.stringify(h.anthropic.requests[0]!.headers);
    expect(seen).not.toContain(EDGE_KEY);
    expect(seen).not.toContain(CLAUDE_KEY);
    expect(h.anthropic.requests[0]!.headers[EDGE_KEY_HEADER]).toBeUndefined();
  });

  it("sends no inference traffic to the VPS", async () => {
    await h.send(messageRequest());
    expect(h.toGateway.messageCalls).toHaveLength(0);
    expect(h.gateway.upstream.requests).toHaveLength(0);
  });

  it("returns plan headers and rate-limit data to Claude Code", async () => {
    h.anthropic.script(OPUS, {
      ...anthropicTextStream(OPUS, "ok"),
      headers: {
        "anthropic-ratelimit-unified-status": "allowed",
        "anthropic-ratelimit-unified-5h-utilization": "0.25",
        "anthropic-ratelimit-unified-7d-utilization": "0.5",
      },
    } as FakeStep);
    const response = await h.send(messageRequest());
    await response.text();
    expect(response.headers.get("anthropic-ratelimit-unified-status")).toBe("allowed");
    expect(h.edge.state.snapshot().usage).toEqual({ "5h": 0.25, "7d": 0.5 });
  });

  it("delivers stream events as they arrive", async () => {
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const start = anthropicStreamStart(OPUS);
    h.anthropic.script(OPUS, {
      type: "stream",
      events: [...start, ...anthropicTextEvents("rest"), ...anthropicStreamEnd()],
      pause: { afterEvents: start.length, until: released },
    });
    const response = await h.send(messageRequest());
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    // The first events must arrive while the upstream is still holding the rest.
    while (!text.includes("event: ping")) {
      text += decoder.decode((await reader.read()).value);
    }
    expect(text).not.toContain("content_block_start");

    release();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect(text).toContain("message_stop");
  });

  it("passes every ordinary error through for Claude Code to handle", async () => {
    for (const [status, type] of [
      [401, "authentication_error"],
      [529, "overloaded_error"],
      [500, "api_error"],
    ] as const) {
      h.anthropic.script(OPUS, anthropicErrorStep(status, type, "from Anthropic"));
      const response = await h.send(messageRequest());
      expect(response.status).toBe(status);
      expect(await response.text()).toContain("from Anthropic");
    }
    expect(h.toGateway.messageCalls).toHaveLength(0);
    expect(h.edge.state.limited).toBe(false);
  });

  it("does not treat a brief throttle as a plan limit", async () => {
    h.anthropic.script(
      OPUS,
      anthropicErrorStep(429, "rate_limit_error", "Slow down", {
        "retry-after": "5",
        "anthropic-ratelimit-unified-status": "allowed",
        "anthropic-ratelimit-unified-5h-utilization": "0.2",
      }),
    );
    const response = await h.send(messageRequest());
    expect(response.status).toBe(429);
    expect(h.edge.state.limited).toBe(false);
    expect(h.toGateway.messageCalls).toHaveLength(0);
  });

  it("closes the Anthropic request when Claude Code disconnects", async () => {
    h.anthropic.script(OPUS, { type: "hang" });
    const controller = new AbortController();
    const pending = fetch(`${h.edge.url}/v1/messages`, {
      method: "POST",
      headers: { [EDGE_KEY_HEADER]: EDGE_KEY, "content-type": "application/json" },
      body: JSON.stringify(messageRequest()),
      signal: controller.signal,
    }).catch(() => null);
    await expect.poll(() => h.anthropic.requests.length).toBe(1);
    controller.abort();
    await pending;
    await expect.poll(() => h.anthropic.abandoned).toBe(1);
  });

  it("passes other paths to Anthropic and never to the VPS", async () => {
    const response = await fetch(`${h.edge.url}/api/hello?x=1`, {
      method: "POST",
      headers: { authorization: `Bearer ${LOGIN_TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(h.anthropic.requests[0]).toMatchObject({ path: "/api/hello?x=1" });
    expect(h.anthropic.requests[0]!.headers.authorization).toBe(`Bearer ${LOGIN_TOKEN}`);
    expect(sentToVps()).not.toContain("/api/hello");
  });
});

describe("when the plan runs out", () => {
  it("continues on the gateway with no action from the user", async () => {
    limitOpus();
    const response = await h.send(messageRequest());
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("message_stop");
    expect(text).toContain(`"model":"${OPUS}"`);
    expect(response.headers.get("x-llmr-target")).toBe(`frontier/anthropic-key/${OPUS}`);
    expect(h.gateway.upstream.requests[0]!.headers["x-api-key"]).toBe(ANTHROPIC_UPSTREAM_KEY);
  });

  it("sends the same body bytes to the provider, keeping cache markers", async () => {
    limitOpus();
    const text = JSON.stringify(messageRequest());
    await (await h.send(text)).text();
    expect(h.gateway.upstream.requests[0]!.rawBody.toString()).toBe(text);
    expect(h.gateway.upstream.requests[0]!.path).toBe("/v1/messages?beta=true");
  });

  it("never sends the Claude token toward the VPS", async () => {
    limitOpus();
    await (await h.send(messageRequest())).text();
    await (await h.send(messageRequest())).text();

    expect(h.toGateway.messageCalls.length).toBe(2);
    for (const text of [sentToVps(), sentToProvider()]) {
      expect(text).not.toContain(LOGIN_TOKEN);
      expect(text).not.toContain("oauth-2025-04-20");
      expect(text).not.toContain(EDGE_KEY);
    }
    const call = h.toGateway.messageCalls[0]!;
    expect(call.headers.authorization).toBe(`Bearer ${CLAUDE_KEY}`);
    expect(call.headers["x-api-key"]).toBeUndefined();
    expect(call.headers.cookie).toBeUndefined();
    expect(call.headers["anthropic-beta"]).toBe("claude-code-20250219");
    expect(call.headers["x-claude-code-session-id"]).toBe("session-1");
  });

  it("also strips a Claude API key sent in x-api-key", async () => {
    limitOpus();
    const apiKey = "sk-ant-api03-CLIENT-KEY-MUST-STAY-LOCAL-0123456789";
    await (
      await h.send(messageRequest(), { headers: { authorization: undefined, "x-api-key": apiKey } })
    ).text();
    expect(h.anthropic.requests[0]!.headers["x-api-key"]).toBe(apiKey);
    expect(h.toGateway.messageCalls).toHaveLength(1);
    expect(sentToVps()).not.toContain(apiKey);
    expect(sentToProvider()).not.toContain(apiKey);
  });

  it("keeps a request on the plan when its body contains the token", async () => {
    limitOpus();
    const response = await h.send(
      messageRequest({ messages: [{ role: "user", content: `my token is ${LOGIN_TOKEN}` }] }),
    );
    // Claude Code sees Anthropic's own limit response instead.
    expect(response.status).toBe(429);
    expect(await response.text()).toContain("You have hit your limit.");
    expect(h.toGateway.messageCalls).toHaveLength(0);
    expect(sentToVps()).not.toContain(LOGIN_TOKEN);
  });

  it("goes straight to the gateway until the reset time, then tries the plan again", async () => {
    limitOpus();
    await (await h.send(messageRequest())).text();
    expect(h.anthropic.requests).toHaveLength(1);

    await (await h.send(messageRequest())).text();
    expect(h.anthropic.requests).toHaveLength(1);
    expect(h.toGateway.messageCalls).toHaveLength(2);

    h.clock.now += 3601_000;
    await (await h.send(messageRequest())).text();
    expect(h.anthropic.requests).toHaveLength(2);
    expect(h.toGateway.messageCalls).toHaveLength(2);
    expect(h.edge.state.limited).toBe(false);
  });

  it("warns once on the desktop and once more on recovery", async () => {
    limitOpus();
    await (await h.send(messageRequest())).text();
    await (await h.send(messageRequest())).text();
    expect(h.notes).toEqual([
      "Claude plan limit reached. Claude Code will continue through your gateway.",
      "Claude Code is now using your gateway (frontier), which may cost money.",
    ]);
    h.clock.now += 3601_000;
    await (await h.send(messageRequest())).text();
    expect(h.notes.at(-1)).toBe("Claude plan is available again.");
  });

  it("tells the gateway why it is serving this request", async () => {
    limitOpus();
    const response = await h.send(messageRequest());
    await response.text();
    const call = h.toGateway.messageCalls[0]!;
    expect(call.headers).toMatchObject({
      "x-llmr-tier": "frontier",
      "x-llmr-no-fallback": "1",
      "x-llmr-requested-tier": "frontier",
      "x-llmr-plan-exhausted": "1",
    });
    expect(response.headers.get("x-llmr-fallback")).toBe("claude-plan:exhausted");
    expect(h.gateway.events.map((event) => event.kind)).toContain("metered_first_use");
  });

  it("reports plan state to the gateway without any credential", async () => {
    limitOpus();
    await (await h.send(messageRequest())).text();
    await expect
      .poll(() => h.toGateway.calls.filter((call) => call.url === "/router/edge/report").length)
      .toBeGreaterThan(0);

    await expect
      .poll(async () => {
        const response = await fetch(`${h.gateway.url}/router/status`, {
          headers: { authorization: `Bearer ${ADMIN_KEY}` },
        });
        const data = (await response.json()) as {
          accounts: { id: string; state: string }[];
        };
        return data.accounts.find((account) => account.id === "claude-plan")?.state;
      })
      .toBe("exhausted");

    const report = h.toGateway.calls.filter((call) => call.url === "/router/edge/report").at(-1)!;
    expect(Object.keys(JSON.parse(report.body)).sort()).toEqual(["edgeVersion", "limits", "usage"]);
    expect(JSON.stringify(report)).not.toContain(LOGIN_TOKEN);
  });

  it("returns upstream client errors from the gateway unchanged", async () => {
    limitOpus();
    h.gateway.upstream.script(
      OPUS,
      anthropicErrorStep(400, "invalid_request_error", "thinking: bad signature"),
    );
    const response = await h.send(messageRequest());
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("thinking: bad signature");
  });

  it("lets Claude Code recover from a rejected thinking signature", async () => {
    limitOpus();
    const message =
      "messages.1.content.0: Invalid `signature` in `thinking` block. " +
      "The block is bound to a different conversation.";
    h.gateway.upstream.script(OPUS, anthropicErrorStep(400, "invalid_request_error", message));
    const response = await h.send(messageRequest());
    expect(response.status).toBe(400);
    // Claude Code matches this wording, so it must arrive exactly as sent.
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe(message);
  });

  it("drops to the next plan model when only one model family is limited", async () => {
    limitOpus({
      "anthropic-ratelimit-unified-5h-status": "allowed",
      "anthropic-ratelimit-unified-5h-utilization": "0.2",
      "anthropic-ratelimit-unified-7d_opus-status": "rejected",
      "anthropic-ratelimit-unified-7d_opus-reset": String(Math.floor(h.clock.now / 1000) + 7200),
      "anthropic-ratelimit-unified-representative-claim": "seven_day_opus",
    });
    // The paid frontier target is unavailable, so the free plan step is next.
    h.gateway.upstream.setAlways(OPUS, anthropicErrorStep(529, "overloaded_error", "Overloaded"));
    h.gateway.upstream.setAlways(
      "backup-opus",
      anthropicErrorStep(529, "overloaded_error", "Busy"),
    );

    const response = await h.send(messageRequest());
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain(`"model":"${SONNET}"`);

    const planCall = h.anthropic.requests[1]!;
    expect(planCall.body.model).toBe(SONNET);
    expect(planCall.headers.authorization).toBe(`Bearer ${LOGIN_TOKEN}`);
    expect(h.edge.state.snapshot().limits.map((limit) => limit.scope)).toEqual(["family:opus"]);
  });

  it("changes only the model when it moves to another plan model", async () => {
    // An account-wide limit would skip the other plan steps, so use a family one.
    limitOpus({
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-5h-status": "allowed",
      "anthropic-ratelimit-unified-5h-utilization": "0.1",
      "anthropic-ratelimit-unified-7d_opus-status": "rejected",
    });
    h.gateway.upstream.setAlways(OPUS, anthropicErrorStep(529, "overloaded_error", "Busy"));
    h.gateway.upstream.setAlways(
      "backup-opus",
      anthropicErrorStep(529, "overloaded_error", "Busy"),
    );
    const before = '{"n":1.0,"tools":{"2":1,"1":2},';
    const after = ',"max_tokens":5,"messages":[],"stream":true}';
    await (await h.send(`${before}"model":"${OPUS}"${after}`)).text();
    expect(h.anthropic.requests[1]!.rawBody.toString()).toBe(
      `${before}"model":"${SONNET}"${after}`,
    );
  });

  it("returns Anthropic's limit response when nothing else can serve", async () => {
    const overloaded = anthropicErrorStep(529, "overloaded_error", "Busy");
    for (const model of [OPUS, "backup-opus", SONNET, HAIKU]) {
      h.gateway.upstream.setAlways(model, overloaded);
    }
    limitOpus();
    const response = await h.send(messageRequest());
    expect(response.status).toBe(429);
    expect(await response.text()).toContain("You have hit your limit.");
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(response.headers.get("anthropic-ratelimit-unified-status")).toBe("rejected");
  });

  it("never shows the gateway's own errors to Claude Code", async () => {
    await h.restartEdge({ routerKey: "llmr_wrong_key_0123456789abcdefghijklmn" });
    // The plan is fetched with the wrong key, so reuse the cached one.
    limitOpus();
    const response = await h.send(messageRequest());
    expect(response.status).toBe(429);
    expect(await response.text()).toContain("You have hit your limit.");
  });

  it("asks Anthropic again when every step was skipped", async () => {
    limitOpus();
    await (await h.send(messageRequest())).text();
    const overloaded = anthropicErrorStep(529, "overloaded_error", "Busy");
    for (const model of [OPUS, "backup-opus", SONNET, HAIKU]) {
      h.gateway.upstream.setAlways(model, overloaded);
    }
    h.anthropic.script(OPUS, planLimitStep(h.clock.now));
    const response = await h.send(messageRequest());
    expect(response.status).toBe(429);
    expect(h.anthropic.requests).toHaveLength(2);
  });
});

describe("token counting", () => {
  const path = "/v1/messages/count_tokens?beta=true";

  it("uses the plan, and a success does not end a limit", async () => {
    limitOpus();
    await (await h.send(messageRequest())).text();
    h.clock.now += 3601_000;
    const response = await h.send(messageRequest(), { path });
    expect(await response.json()).toEqual({ input_tokens: 123 });
    expect(h.anthropic.requests.at(-1)!.path).toBe(path);
    expect(h.edge.state.limited).toBe(true);
  });

  it("uses the gateway while the plan is limited", async () => {
    limitOpus();
    await (await h.send(messageRequest())).text();
    const response = await h.send(messageRequest(), { path });
    expect(await response.json()).toEqual({ input_tokens: 123 });
    expect(h.toGateway.calls.at(-1)!.url).toBe(path);
    expect(sentToVps()).not.toContain(LOGIN_TOKEN);
  });
});

describe("without the VPS", () => {
  it("keeps working on the plan", async () => {
    await h.restartEdge({ gatewayUrl: new URL("http://127.0.0.1:9") });
    const response = await h.send(messageRequest());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("message_stop");
  });

  it("uses the saved plan and returns Anthropic's 429 when the VPS is away", async () => {
    expect(existsSync(h.paths.planFile)).toBe(true);
    await h.restartEdge({ gatewayUrl: new URL("http://127.0.0.1:9") });
    expect(h.edge.gateway.routeFor(OPUS).tier).toBe("frontier");
    limitOpus();
    const response = await h.send(messageRequest());
    expect(response.status).toBe(429);
    expect(await response.text()).toContain("You have hit your limit.");
  });

  it("remembers a limit across restarts", async () => {
    limitOpus();
    await (await h.send(messageRequest())).text();
    await h.restartEdge();
    expect(h.edge.state.isBlocked(OPUS)).toBe(true);
    await (await h.send(messageRequest())).text();
    expect(h.anthropic.requests).toHaveLength(1);
  });

  it("works with no gateway configured", async () => {
    await h.restartEdge({ gatewayUrl: null, routerKey: null });
    limitOpus();
    const response = await h.send(messageRequest());
    expect(response.status).toBe(429);
    expect(h.toGateway.messageCalls).toHaveLength(0);
  });
});

describe("local protection", () => {
  it("requires the edge key for model requests", async () => {
    for (const value of [undefined, "wrong"]) {
      const response = await h.send(messageRequest(), { headers: { [EDGE_KEY_HEADER]: value } });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        type: "error",
        error: { type: "authentication_error" },
      });
    }
    expect(h.anthropic.requests).toHaveLength(0);
  });

  it("refuses requests from web pages", async () => {
    const response = await h.send(messageRequest(), {
      headers: { origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
    expect(h.anthropic.requests).toHaveLength(0);
  });

  /** Sends a request with a chosen Host header or request path. */
  const rawRequest = (path: string, headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const { port } = new URL(h.edge.url);
      httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      })
        .on("error", reject)
        .end();
    });

  it("refuses other Host names, which blocks DNS rebinding", async () => {
    expect(await rawRequest("/_edge/status", { host: "evil.example" })).toBe(403);
    expect(await rawRequest("/_edge/health", {})).toBe(200);
  });

  it("cannot be pointed at another host by a crafted path", async () => {
    for (const path of ["//evil.example/x", "http://evil.example/x", "/\\evil.example/x"]) {
      const status = await rawRequest(path, { authorization: `Bearer ${LOGIN_TOKEN}` });
      expect(status).toBe(400);
    }
    expect(h.anthropic.requests).toHaveLength(0);
  });

  it("listens on loopback only", () => {
    expect(h.edge.host).toBe("127.0.0.1");
  });
});

describe("files on disk", () => {
  it("never contain a credential", async () => {
    limitOpus();
    await (await h.send(messageRequest())).text();
    const dir = dirname(h.paths.stateFile);
    const files = readdirSync(dir);
    expect(files).toContain("edge-state.json");
    expect(files).toContain("edge-limit-samples.jsonl");
    for (const file of files) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text).not.toContain(LOGIN_TOKEN);
      expect(text).not.toContain(CLAUDE_KEY);
      expect(text).not.toContain(EDGE_KEY);
    }
  });

  it("record the headers of each plan 429", async () => {
    limitOpus();
    await (await h.send(messageRequest())).text();
    const sample = JSON.parse(readFileSync(h.paths.samplesFile, "utf8").trim());
    expect(sample.signal).toMatchObject({ kind: "plan_limit", scope: "*", claim: "five_hour" });
    expect(sample.headers["anthropic-ratelimit-unified-status"]).toBe("rejected");
    expect(sample.headers["x-should-retry"]).toBe("false");
    expect(Object.keys(sample.headers).every((name) => !name.includes("auth"))).toBe(true);
  });
});
