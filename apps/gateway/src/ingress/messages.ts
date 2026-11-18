import {
  anthropicRequestHeaders,
  anthropicResponseHeaders,
  replaceTopLevelString,
} from "@llm-rudder/shared";
import type { FastifyError, FastifyInstance, FastifyRequest } from "fastify";
import type { ClientConfig } from "../config/load.js";
import { anthropicErrorBody, RouterError } from "../errors.js";
import { ANTHROPIC_ERRORS, ClientResponse } from "../execution/client-response.js";
import type { RequestContext } from "../execution/context.js";
import { executeRequest } from "../execution/executor.js";
import { anthropicMessages } from "../execution/protocols/anthropic-messages.js";
import { ulid } from "../ids.js";
import { buildPlan } from "../routing/plan.js";
import type { Runtime } from "../runtime.js";
import type { JsonObject } from "../types.js";
import { clientAuthHook } from "./auth.js";
import { deriveSessionKey } from "./session.js";

const COUNT_TOKENS_TIMEOUT_MS = 30_000;
/** Answers that mean this target cannot count tokens for us right now. */
const TRY_NEXT_COUNT_STATUS = new Set([401, 402, 403, 404, 408, 429]);

function invalidRequest(message: string): RouterError {
  return new RouterError(400, "invalid_request", message, "invalid_request_error");
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function parseBody(raw: Buffer): JsonObject {
  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    throw invalidRequest("The request body must be valid JSON.");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw invalidRequest("The request body must be a JSON object.");
  }
  return body as JsonObject;
}

function buildContext(
  request: FastifyRequest,
  client: ClientConfig,
  signal: AbortSignal,
  runtime: Runtime,
): RequestContext {
  const rawBody = request.body as Buffer;
  const body = parseBody(rawBody);
  if (typeof body.model !== "string" || body.model === "") {
    throw invalidRequest("`model` is required.");
  }
  if (!Array.isArray(body.messages)) throw invalidRequest("`messages` must be an array.");

  const { config } = runtime;
  const tierHeader = header(request, "x-llmr-tier");
  // Only an edge may say that it has already tried something else.
  const reportedTier = client.edge ? header(request, "x-llmr-requested-tier") : undefined;
  const originalTier = reportedTier && config.tiers.has(reportedTier) ? reportedTier : undefined;
  const planExhausted =
    client.edge && config.edge && header(request, "x-llmr-plan-exhausted") === "1";
  const search = new URLSearchParams(request.url.split("?")[1] ?? "");
  const startedAt = runtime.now();

  return {
    requestId: ulid(startedAt),
    client,
    dialect: "anthropic.messages",
    body,
    rawBody,
    upstreamHeaders: anthropicRequestHeaders(request.headers),
    upstreamQuery: search.get("beta") === "true" ? "?beta=true" : "",
    requestedModel: body.model,
    stream: body.stream === true,
    wantsUsage: false,
    sessionKey: deriveSessionKey(request.headers, body, client.id),
    allowFallback: client.allowFallback && request.headers["x-llmr-no-fallback"] !== "1",
    startedAt,
    deadlineAt: startedAt + config.routing.deadlineMs,
    signal,
    bodyChars: rawBody.length,
    ...(tierHeader === undefined ? {} : { tierHeader }),
    ...(originalTier === undefined ? {} : { originalTier }),
    ...(planExhausted ? { priorFailures: [`${config.edge!.planAccount}:exhausted`] } : {}),
    ...(typeof body.max_tokens === "number" ? { maxOutputTokens: body.max_tokens } : {}),
  };
}

/** Token counting is free and optional, so it skips budgets, quota and the ledger. */
async function countTokens(request: FastifyRequest, runtime: Runtime) {
  const client = request.llmrClient as ClientConfig;
  const controller = new AbortController();
  const ctx = { ...buildContext(request, client, controller.signal, runtime), bodyChars: 0 };
  delete ctx.maxOutputTokens;
  const signal = AbortSignal.timeout(COUNT_TOKENS_TIMEOUT_MS);

  for (const { target } of buildPlan(ctx, runtime).steps) {
    const account = runtime.config.accounts.get(target.accountId)!;
    // Only Anthropic's format has this endpoint.
    if (account.api !== "anthropic.messages") continue;
    const body = replaceTopLevelString(ctx.rawBody as Buffer, "model", target.model);
    if (!body) break;
    try {
      const response = await runtime.upstream.sendAnthropic(account, {
        path: "/v1/messages/count_tokens",
        query: "",
        body,
        headers: ctx.upstreamHeaders ?? {},
        stream: false,
        signal,
      });
      const text = await response.body.text();
      if (response.status < 500 && !TRY_NEXT_COUNT_STATUS.has(response.status)) {
        const headers = anthropicResponseHeaders(response.headers);
        // The same marker as on /v1/messages: this error belongs to the client.
        if (response.status >= 400) headers["x-llmr-upstream-error"] = "1";
        return { status: response.status, text, headers };
      }
    } catch (error) {
      request.log.debug({ err: error, target: target.id }, "token count failed");
    }
  }
  // Claude Code falls back to its own estimate when counting is unavailable.
  throw new RouterError(404, "not_found", "Token counting is not available.", "not_found_error");
}

export function registerMessagesRoutes(app: FastifyInstance, runtime: Runtime): void {
  const authenticate = clientAuthHook(runtime);

  void app.register(async (scope) => {
    // These routes keep the original bytes, so only `model` ever changes.
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) =>
      done(null, body),
    );

    scope.setErrorHandler((error: FastifyError | RouterError, request, reply) => {
      if (error instanceof RouterError) {
        return reply
          .code(error.status)
          .headers(error.headers)
          .send(anthropicErrorBody(error.status, error.message));
      }
      const status = error.statusCode ?? 500;
      if (status === 413) {
        return reply.code(413).send(anthropicErrorBody(413, "The request body is too large."));
      }
      if (status < 500) return reply.code(status).send(anthropicErrorBody(status, error.message));
      request.log.error({ err: error, requestId: request.id }, "unhandled error");
      return reply.code(500).send(anthropicErrorBody(500, "Internal gateway error."));
    });

    scope.post("/v1/messages", { onRequest: authenticate }, async (request, reply) => {
      const client = request.llmrClient as ClientConfig;
      const release = runtime.limits.acquire(client);
      const controller = new AbortController();
      const onClose = () => {
        if (!reply.raw.writableFinished) controller.abort();
      };
      reply.raw.once("close", onClose);
      try {
        const ctx = buildContext(request, client, controller.signal, runtime);
        const plan = buildPlan(ctx, runtime);
        const out = new ClientResponse(reply, runtime.now, ANTHROPIC_ERRORS);
        await executeRequest(runtime, ctx, plan, out, anthropicMessages);
      } finally {
        reply.raw.off("close", onClose);
        release();
      }
      return reply;
    });

    scope.post("/v1/messages/count_tokens", { onRequest: authenticate }, async (request, reply) => {
      const release = runtime.limits.acquire(request.llmrClient as ClientConfig);
      try {
        const { status, text, headers } = await countTokens(request, runtime);
        return await reply.code(status).headers(headers).type("application/json").send(text);
      } finally {
        release();
      }
    });
  });
}
