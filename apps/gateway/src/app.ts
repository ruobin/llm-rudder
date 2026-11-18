import Fastify, { LogController, type FastifyError, type FastifyInstance } from "fastify";
import { errorBody, RouterError } from "./errors.js";
import { ulid } from "./ids.js";
import { registerAdminRoutes } from "./ingress/admin.js";
import { registerChatRoutes } from "./ingress/chat.js";
import { registerEdgeRoutes } from "./ingress/edge.js";
import { registerMessagesRoutes } from "./ingress/messages.js";
import { registerResponsesRoutes } from "./ingress/responses.js";
import type { Runtime } from "./runtime.js";

export function buildApp(runtime: Runtime): FastifyInstance {
  const { server } = runtime.config;
  const app = Fastify({
    loggerInstance: runtime.log,
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => ulid(),
    bodyLimit: server.maxBodyBytes,
    trustProxy: server.trustProxy,
    // Limits how long a client may take to send its request, not the response.
    requestTimeout: 120_000,
    keepAliveTimeout: 75_000,
    forceCloseConnections: "idle",
  }) as unknown as FastifyInstance;

  app.setErrorHandler((error: FastifyError | RouterError, request, reply) => {
    if (error instanceof RouterError) {
      return reply
        .code(error.status)
        .headers(error.headers)
        .send(errorBody(error.message, error.type, error.code, error.param));
    }
    const status = error.statusCode ?? 500;
    if (status === 413) {
      return reply
        .code(413)
        .send(errorBody("The request body is too large.", "invalid_request_error", "too_large"));
    }
    if (status < 500) {
      return reply
        .code(status)
        .send(errorBody(error.message, "invalid_request_error", "invalid_request"));
    }
    request.log.error({ err: error, requestId: request.id }, "unhandled error");
    return reply
      .code(500)
      .send(errorBody("Internal gateway error.", "router_error", "internal_error"));
  });

  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send(
        errorBody(
          `No route for ${request.method} ${request.url.split("?")[0]}.`,
          "invalid_request_error",
          "not_found",
        ),
      ),
  );

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_request, reply) => {
    if (runtime.draining) return reply.code(503).send({ status: "draining" });
    try {
      await runtime.persistence.ping();
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "database_unavailable" });
    }
  });

  app.decorateRequest("llmrClient", null);
  registerChatRoutes(app, runtime);
  registerMessagesRoutes(app, runtime);
  registerResponsesRoutes(app, runtime);
  registerEdgeRoutes(app, runtime);
  registerAdminRoutes(app, runtime);
  return app;
}
