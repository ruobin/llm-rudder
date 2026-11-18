import { mkdtempSync, rmSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  anthropicErrorStep,
  FakeUpstream,
  type FakeStep,
} from "../../gateway/src/dev/fake-upstream.js";
import {
  CLAUDE_CONFIG,
  CLAUDE_KEY,
  startGateway,
  type TestGateway,
} from "../../gateway/test/helpers.js";
import { startEdge, type RunningEdge } from "../src/app.js";
import type { EdgeConfig } from "../src/config.js";
import { edgePaths, type EdgePaths } from "../src/paths.js";
import { EDGE_KEY_HEADER } from "../src/server.js";

export const LOGIN_TOKEN = "sk-ant-oat01-LOGIN-TOKEN-THAT-MUST-STAY-LOCAL-0123456789";
export const EDGE_KEY = "llmre_test_edge_key_0123456789abcdefghijkl";
export const OPUS = "claude-opus-5-5";
export const SONNET = "claude-sonnet-5-5";
export const HAIKU = "claude-haiku-5-5";

export interface RecordedCall {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** Sits between the edge and the gateway and keeps a copy of everything sent. */
export class RecordingProxy {
  readonly calls: RecordedCall[] = [];
  private server: Server | null = null;
  url = "";

  constructor(private readonly target: string) {}

  async start(port = 0): Promise<this> {
    this.server = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on("data", (part: Buffer) => parts.push(part));
      req.on("end", () => {
        const body = Buffer.concat(parts);
        this.calls.push({
          method: req.method ?? "",
          url: req.url ?? "",
          headers: req.headers,
          body: body.toString(),
        });
        const forward = httpRequest(
          new URL(req.url ?? "/", this.target),
          { method: req.method, headers: req.headers },
          (upstream) => {
            res.writeHead(upstream.statusCode ?? 502, upstream.headers);
            upstream.pipe(res);
          },
        );
        forward.on("error", () => res.destroy());
        forward.end(body);
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  get messageCalls(): RecordedCall[] {
    return this.calls.filter((call) => call.url.startsWith("/v1/messages"));
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise((resolve) => this.server?.close(resolve));
  }
}

export interface Harness {
  /** Stands in for api.anthropic.com. */
  anthropic: FakeUpstream;
  gateway: TestGateway;
  toGateway: RecordingProxy;
  edge: RunningEdge;
  paths: EdgePaths;
  notes: string[];
  clock: { now: number };
  send(body: unknown, options?: RequestOptions): Promise<Response>;
  restartEdge(overrides?: Partial<EdgeConfig>): Promise<void>;
  close(): Promise<void>;
}

export interface RequestOptions {
  path?: string;
  headers?: Record<string, string | undefined>;
}

export const messageRequest = (overrides: Record<string, unknown> = {}) => ({
  model: OPUS,
  max_tokens: 100,
  stream: true,
  system: [{ type: "text", text: "You are helpful.", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: "Hello" }],
  ...overrides,
});

export const claudeHeaders = (): Record<string, string> => ({
  authorization: `Bearer ${LOGIN_TOKEN}`,
  "content-type": "application/json",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
  "x-claude-code-session-id": "session-1",
  [EDGE_KEY_HEADER]: EDGE_KEY,
});

/** A 429 like the ones the plan returns once a window is used up. */
export function planLimitStep(clockMs: number, overrides: Record<string, string> = {}): FakeStep {
  const reset = Math.floor(clockMs / 1000) + 3600;
  return anthropicErrorStep(429, "rate_limit_error", "You have hit your limit.", {
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-reset": String(reset),
    "anthropic-ratelimit-unified-5h-status": "rejected",
    "anthropic-ratelimit-unified-5h-reset": String(reset),
    "anthropic-ratelimit-unified-5h-utilization": "1.0",
    "anthropic-ratelimit-unified-7d-status": "allowed",
    "anthropic-ratelimit-unified-7d-reset": String(reset + 86_400),
    "anthropic-ratelimit-unified-7d-utilization": "0.4",
    "anthropic-ratelimit-unified-representative-claim": "five_hour",
    "anthropic-ratelimit-unified-overage-status": "rejected",
    "x-should-retry": "false",
    ...overrides,
  });
}

export async function startHarness(
  yaml: string = CLAUDE_CONFIG,
  models?: string,
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "llmr-edge-test-"));
  const paths = edgePaths({
    HOME: dir,
    LLMR_EDGE_CONFIG_DIR: join(dir, "config"),
    LLMR_EDGE_STATE_DIR: join(dir, "state"),
  });
  const anthropic = await new FakeUpstream().start();
  const gateway = await startGateway({ yaml, ...(models ? { models } : {}) });
  const toGateway = await new RecordingProxy(gateway.url).start();
  const notes: string[] = [];
  const clock = { now: Date.now() };

  const configFor = (overrides: Partial<EdgeConfig> = {}): EdgeConfig => ({
    port: 0,
    edgeKey: EDGE_KEY,
    anthropicUrl: new URL(new URL(anthropic.url).origin),
    gatewayUrl: new URL(toGateway.url),
    routerKey: CLAUDE_KEY,
    desktopNotifications: false,
    ...overrides,
  });
  const launch = async (overrides?: Partial<EdgeConfig>) => {
    const edge = await startEdge({
      config: configFor(overrides),
      paths,
      now: () => clock.now,
      notify: (text) => notes.push(text),
    });
    await edge.gateway.refreshPlan();
    return edge;
  };

  const harness: Harness = {
    anthropic,
    gateway,
    toGateway,
    edge: await launch(),
    paths,
    notes,
    clock,
    send(body, options = {}) {
      const merged: Record<string, string> = {};
      for (const [name, value] of Object.entries({ ...claudeHeaders(), ...options.headers })) {
        if (value !== undefined) merged[name] = value;
      }
      return fetch(`${harness.edge.url}${options.path ?? "/v1/messages?beta=true"}`, {
        method: "POST",
        headers: merged,
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    },
    async restartEdge(overrides) {
      await harness.edge.close();
      harness.edge = await launch(overrides);
    },
    async close() {
      await harness.edge.close();
      await toGateway.stop();
      await gateway.close();
      await anthropic.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return harness;
}
