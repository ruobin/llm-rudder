import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ClientConfig } from "../config/load.js";
import { RouterError } from "../errors.js";
import { ClientResponse, OPENAI_ERRORS } from "../execution/client-response.js";
import type { RequestContext } from "../execution/context.js";
import { executeRequest } from "../execution/executor.js";
import { openAiChat } from "../execution/protocols/openai-chat.js";
import { ulid } from "../ids.js";
import { buildPlan } from "../routing/plan.js";
import type { Runtime } from "../runtime.js";
import type { JsonObject } from "../types.js";
import { clientAuthHook } from "./auth.js";
import { deriveSessionKey } from "./session.js";

function invalidRequest(message: string, param: string): RouterError {
  return new RouterError(400, "invalid_request", message, "invalid_request_error", {}, param);
}

function headerText(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function buildContext(
  request: FastifyRequest,
  client: ClientConfig,
  signal: AbortSignal,
  runtime: Runtime,
): RequestContext {
  const body = request.body as JsonObject | null;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw invalidRequest("The request body must be a JSON object.", "body");
  }
  if (typeof body.model !== "string" || body.model === "") {
    throw invalidRequest("`model` is required.", "model");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw invalidRequest("`messages` must be a non-empty array.", "messages");
  }

  const stream = body.stream === true;
  const streamOptions = body.stream_options as JsonObject | undefined;
  const contentLength = Number(request.headers["content-length"]);
  const maxOutput = body.max_completion_tokens ?? body.max_tokens;
  const tierHeader = headerText(request, "x-llmr-tier");
  const startedAt = runtime.now();

  return {
    requestId: ulid(startedAt),
    client,
    dialect: "openai.chat",
    body,
    requestedModel: body.model,
    stream,
    wantsUsage: stream && streamOptions?.include_usage === true,
    sessionKey: deriveSessionKey(request.headers, body, client.id),
    allowFallback: client.allowFallback && request.headers["x-llmr-no-fallback"] !== "1",
    startedAt,
    deadlineAt: startedAt + runtime.config.routing.deadlineMs,
    signal,
    bodyChars: contentLength > 0 ? contentLength : JSON.stringify(body).length,
    ...(tierHeader === undefined ? {} : { tierHeader }),
    ...(typeof maxOutput === "number" ? { maxOutputTokens: maxOutput } : {}),
  };
}

export function registerChatRoutes(app: FastifyInstance, runtime: Runtime): void {
  const authenticate = clientAuthHook(runtime);

  app.post("/v1/chat/completions", { onRequest: authenticate }, async (request, reply) => {
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
      const out = new ClientResponse(reply, runtime.now, OPENAI_ERRORS);
      await executeRequest(runtime, ctx, plan, out, openAiChat);
    } finally {
      reply.raw.off("close", onClose);
      release();
    }
    return reply;
  });

  app.get("/v1/models", { onRequest: authenticate }, async () => {
    const created = Math.floor(runtime.startedAt / 1000);
    return {
      object: "list",
      data: [...runtime.config.tiers.values()].map((tier) => ({
        id: tier.name,
        object: "model",
        created,
        owned_by: "llm-router",
        ...(tier.contextWindow === undefined ? {} : { context_window: tier.contextWindow }),
        ...(tier.maxOutputTokens === undefined ? {} : { max_output_tokens: tier.maxOutputTokens }),
      })),
    };
  });
}
