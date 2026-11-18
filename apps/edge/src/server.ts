import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { pipeline } from "node:stream/promises";
import {
  anthropicRequestHeaders,
  findTopLevelString,
  replaceTopLevelString,
  type EdgeRoute,
  type EdgeStep,
} from "@llm-rudder/shared";
import type { EdgeConfig } from "./config.js";
import type { GatewayLink } from "./gateway-link.js";
import { readResponse, type HttpClient } from "./http-client.js";
import { classifyPlanResponse, readPlanUsage } from "./plan-limit.js";
import type { LimitSamples } from "./samples.js";
import type { PlanState } from "./state.js";
import { EDGE_VERSION } from "./version.js";

export const EDGE_KEY_HEADER = "x-llmr-edge-key";

const MAX_BODY_BYTES = 128 * 1024 * 1024;
const MAX_STORED_ERROR_BYTES = 1024 * 1024;
/** Matches Claude Code's own wait for response headers. */
const RESPONSE_TIMEOUT_MS = 10 * 60_000;
const GATEWAY_SESSION_HEADERS = [
  "x-claude-code-session-id",
  "x-claude-code-agent-id",
  "x-claude-code-parent-agent-id",
];
/** Headers that belong to one connection, or that only the edge may read. */
const NOT_FORWARDED = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  EDGE_KEY_HEADER,
]);

export type Log = (message: string, fields?: Record<string, unknown>) => void;

export interface EdgeServices {
  config: EdgeConfig;
  state: PlanState;
  gateway: GatewayLink;
  samples: LimitSamples;
  http: HttpClient;
  now: () => number;
  log: Log;
}

interface StoredResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface MessageRequest {
  req: IncomingMessage;
  res: ServerResponse;
  /** Path and query, as Claude Code sent them. */
  target: string;
  body: Buffer;
  model: string | null;
  route: EdgeRoute;
  isCount: boolean;
  signal: AbortSignal;
}

type PlanOutcome = { done: true } | { done: false; response: StoredResponse };

class TooLargeError extends Error {}

function forwardableHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const kept: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !NOT_FORWARDED.has(name)) kept[name] = value;
  }
  return kept;
}

/**
 * Builds the upstream URL. A path such as "//other.example/x" would otherwise
 * replace the host, and the request's credentials would go with it.
 */
export function upstreamUrl(target: string, base: URL): URL | null {
  if (!target.startsWith("/") || target.startsWith("//") || target.includes("\\")) return null;
  const url = new URL(target, base);
  return url.origin === base.origin ? url : null;
}

function sendError(res: ServerResponse, status: number, type: string, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ type: "error", error: { type, message: `llmr-edge: ${message}` } });
  res.writeHead(status, { "content-type": "application/json" }).end(body);
}

function sendJson(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of req as AsyncIterable<Buffer>) {
    size += part.length;
    if (size > MAX_BODY_BYTES) throw new TooLargeError();
    parts.push(part);
  }
  return Buffer.concat(parts);
}

function keysMatch(presented: unknown, expected: string): boolean {
  if (typeof presented !== "string") return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

/** The credential values on this request, used to keep them out of gateway traffic. */
function credentialValues(headers: IncomingHttpHeaders): Buffer[] {
  const values: string[] = [];
  if (typeof headers.authorization === "string") {
    values.push(headers.authorization.replace(/^Bearer\s+/i, "").trim());
  }
  if (typeof headers["x-api-key"] === "string") values.push(headers["x-api-key"].trim());
  return values.filter((value) => value.length >= 16).map((value) => Buffer.from(value));
}

/** Handles Claude Code's traffic. Only this class sees a Claude credential. */
export class EdgeServer {
  readonly server: Server;

  constructor(private readonly services: EdgeServices) {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        this.services.log("request failed", { error: (error as Error).message });
        sendError(res, 502, "api_error", "The request could not be completed.");
      });
    });
    // Longer than a pause between Claude Code's requests.
    this.server.keepAliveTimeout = 75_000;
  }

  listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      // Loopback only: this port must never be reachable from a network.
      this.server.listen(port, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve((this.server.address() as { port: number }).port);
      });
    });
  }

  async close(): Promise<void> {
    await new Promise((resolve) => {
      this.server.close(resolve);
      this.server.closeIdleConnections();
    });
  }

  private hostAllowed(host: string | undefined): boolean {
    const { port } = this.server.address() as { port: number };
    return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Stops web pages from reaching this port through a browser.
    if (!this.hostAllowed(req.headers.host) || req.headers.origin !== undefined) {
      sendError(res, 403, "permission_error", "Only local programs may use the edge.");
      return;
    }
    const target = req.url ?? "/";
    const path = target.split("?")[0];
    if (path === "/_edge/health") return sendJson(res, { status: "ok", version: EDGE_VERSION });
    if (path === "/_edge/status") {
      return sendJson(res, {
        ...this.services.state.snapshot(),
        version: EDGE_VERSION,
        gatewayConfigured: this.services.gateway.configured,
      });
    }
    if (
      req.method === "POST" &&
      (path === "/v1/messages" || path === "/v1/messages/count_tokens")
    ) {
      return this.handleMessages(req, res, target, path.endsWith("count_tokens"));
    }
    return this.passThrough(req, res, target);
  }

  /** Everything else goes to Anthropic exactly as it would without the edge. */
  private async passThrough(
    req: IncomingMessage,
    res: ServerResponse,
    target: string,
  ): Promise<void> {
    const { http, config } = this.services;
    const url = upstreamUrl(target, config.anthropicUrl);
    if (!url) {
      sendError(res, 400, "invalid_request_error", "That path is not allowed.");
      return;
    }
    const controller = this.abortOnClose(res);
    const headers = forwardableHeaders(req.headers);
    if (req.headers["content-length"] !== undefined) {
      headers["content-length"] = req.headers["content-length"];
    } else if (req.headers["transfer-encoding"] !== undefined) {
      headers["transfer-encoding"] = "chunked";
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    let upstream: IncomingMessage;
    try {
      upstream = await http.send(url, {
        method: req.method ?? "GET",
        headers,
        ...(hasBody ? { body: req } : {}),
        signal: controller.signal,
        responseTimeoutMs: RESPONSE_TIMEOUT_MS,
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        this.services.log("could not reach Anthropic", { error: (error as Error).message });
        sendError(res, 502, "api_error", "Could not reach Anthropic.");
      }
      return;
    }
    await this.relay(upstream, res);
  }

  private abortOnClose(res: ServerResponse): AbortController {
    const controller = new AbortController();
    res.once("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    return controller;
  }

  private async relay(upstream: IncomingMessage, res: ServerResponse): Promise<void> {
    const headers = forwardableHeaders(upstream.headers);
    const length = upstream.headers["content-length"];
    if (length !== undefined) headers["content-length"] = length;
    res.writeHead(upstream.statusCode ?? 502, headers);
    res.flushHeaders();
    try {
      await pipeline(upstream, res);
    } catch {
      // Ending abruptly tells Claude Code the response was cut off, so it retries.
      res.destroy();
      upstream.destroy();
    }
  }

  private sendStored(res: ServerResponse, stored: StoredResponse): void {
    const headers = forwardableHeaders(stored.headers);
    headers["content-length"] = stored.body.length;
    res.writeHead(stored.status, headers).end(stored.body);
  }

  private async handleMessages(
    req: IncomingMessage,
    res: ServerResponse,
    target: string,
    isCount: boolean,
  ): Promise<void> {
    const { config, gateway, log, state } = this.services;
    if (!keysMatch(req.headers[EDGE_KEY_HEADER], config.edgeKey)) {
      sendError(
        res,
        401,
        "authentication_error",
        `The ${EDGE_KEY_HEADER} header is missing or wrong. Check ANTHROPIC_CUSTOM_HEADERS.`,
      );
      return;
    }

    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (error) {
      if (error instanceof TooLargeError) {
        sendError(res, 413, "request_too_large", "The request is too large.");
        return;
      }
      throw error;
    }

    const controller = this.abortOnClose(res);
    const model = findTopLevelString(body, "model")?.value ?? null;
    const request: MessageRequest = {
      req,
      res,
      target,
      body,
      model,
      route: gateway.routeFor(model),
      isCount,
      signal: controller.signal,
    };

    // A conversation can contain the login token, for example if a tool read a
    // credentials file. Such a request must never leave for the VPS.
    const leaksCredential = credentialValues(req.headers).some((value) => body.includes(value));
    if (leaksCredential) log("this request contains its own credential, so it stays on the plan");
    const mayUseGateway = gateway.configured && !leaksCredential;

    let limitResponse: StoredResponse | null = null;
    let triedPlan = false;
    let steps = this.stepsFor(request);
    for (let index = 0; index < steps.length; index += 1) {
      if (controller.signal.aborted) return;
      const step = steps[index] as EdgeStep;

      if (step.kind === "plan") {
        const stepModel = step.model ?? model;
        if (stepModel !== null && state.isBlocked(stepModel)) continue;
        triedPlan = true;
        const outcome = await this.tryPlan(request, step.model);
        if (outcome.done) return;
        limitResponse ??= outcome.response;
        // A limit can arrive before the edge has ever reached the gateway.
        if (mayUseGateway && !gateway.hasRoutes()) {
          await gateway.refreshPlan();
          request.route = gateway.routeFor(model);
          steps = this.stepsFor(request);
          index = 0;
        }
        continue;
      }

      if (mayUseGateway && (await this.tryGateway(request, step.tier, limitResponse !== null))) {
        return;
      }
    }
    if (controller.signal.aborted) return;

    if (limitResponse) {
      // Nothing else could help, so Claude Code shows its normal limit message.
      this.sendStored(res, limitResponse);
      return;
    }
    // Every step was skipped. Let Anthropic give the real answer.
    const last = triedPlan ? null : await this.tryPlan(request, undefined);
    if (last === null) sendError(res, 502, "api_error", "No route could serve this request.");
    else if (!last.done) this.sendStored(res, last.response);
  }

  private stepsFor({ route, isCount }: MessageRequest): EdgeStep[] {
    if (!isCount) return route.steps;
    // Token counts are optional, so they get one try on each side.
    const plan = route.steps.find((step) => step.kind === "plan");
    const gateway = route.steps.find((step) => step.kind === "gateway");
    return [...(plan ? [{ kind: "plan" } as const] : []), ...(gateway ? [gateway] : [])];
  }

  /** Sends the request to Anthropic with Claude Code's own credentials. */
  private async tryPlan(request: MessageRequest, modelOverride?: string): Promise<PlanOutcome> {
    const { req, res, target, signal, isCount } = request;
    const { http, config, state, samples, now, log } = this.services;
    const body =
      modelOverride === undefined
        ? request.body
        : (replaceTopLevelString(request.body, "model", modelOverride) ?? request.body);
    const headers = forwardableHeaders(req.headers);
    headers["content-length"] = body.length;

    let upstream: IncomingMessage;
    try {
      upstream = await http.send(upstreamUrl(target, config.anthropicUrl) as URL, {
        method: "POST",
        headers,
        body,
        signal,
        responseTimeoutMs: RESPONSE_TIMEOUT_MS,
      });
    } catch (error) {
      if (!signal.aborted) {
        log("could not reach Anthropic", { error: (error as Error).message });
        sendError(res, 502, "api_error", "Could not reach Anthropic.");
      }
      return { done: true };
    }

    const status = upstream.statusCode ?? 502;
    state.observeUsage(readPlanUsage(upstream.headers));
    if (status === 429) {
      const signalKind = classifyPlanResponse(status, upstream.headers, now());
      samples.record(now(), upstream.headers, signalKind);
      if (signalKind.kind === "plan_limit") {
        log("the Claude plan reached a limit", { scope: signalKind.scope });
        const stored = await readResponse(upstream, MAX_STORED_ERROR_BYTES);
        state.recordLimit(signalKind);
        void this.services.gateway.report();
        return {
          done: false,
          response: { status, headers: upstream.headers, body: stored },
        };
      }
    }
    if (status < 400 && !isCount) {
      const wasLimited = state.limited;
      state.recordPlanSuccess(modelOverride ?? request.model ?? "");
      if (wasLimited && !state.limited) void this.services.gateway.report();
    }
    await this.relay(upstream, res);
    return { done: true };
  }

  /** Sends the request to the gateway with the router key and no Claude credential. */
  private async tryGateway(
    request: MessageRequest,
    tier: string,
    planExhausted: boolean,
  ): Promise<boolean> {
    const { req, res, target, body, route, signal, isCount } = request;
    const { http, config, state, log } = this.services;
    const blockedByLimit = request.model !== null && state.isBlocked(request.model);

    // An allowlist: a header that is not named here cannot reach the VPS.
    const headers: OutgoingHttpHeaders = {
      ...anthropicRequestHeaders(req.headers),
      "content-type": "application/json",
      accept: req.headers.accept ?? "application/json",
      authorization: `Bearer ${config.routerKey}`,
      "content-length": body.length,
      "x-llmr-tier": tier,
      "x-llmr-no-fallback": "1",
    };
    if (route.tier) headers["x-llmr-requested-tier"] = route.tier;
    if (planExhausted || blockedByLimit) headers["x-llmr-plan-exhausted"] = "1";
    for (const name of GATEWAY_SESSION_HEADERS) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }

    let upstream: IncomingMessage;
    try {
      upstream = await http.send(upstreamUrl(target, config.gatewayUrl!) as URL, {
        method: "POST",
        headers,
        body,
        signal,
        responseTimeoutMs: RESPONSE_TIMEOUT_MS,
      });
    } catch (error) {
      if (!signal.aborted) {
        state.setGatewayReachable(false);
        log("could not reach the gateway", { error: (error as Error).message });
      }
      return false;
    }

    const status = upstream.statusCode ?? 502;
    const fromUpstream = upstream.headers["x-llmr-upstream-error"] === "1";
    if ((status >= 200 && status < 300) || fromUpstream) {
      if (status < 300 && !isCount) state.recordGatewayServed(tier);
      await this.relay(upstream, res);
      return true;
    }
    // The gateway's own errors must not reach Claude Code: a 401 here would look
    // like a failed Claude login.
    upstream.resume();
    state.setGatewayReachable(true);
    log("the gateway could not serve this tier", { tier, status });
    return false;
  }
}
