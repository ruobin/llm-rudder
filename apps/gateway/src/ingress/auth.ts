import type { FastifyRequest } from "fastify";
import { extractKey, hashKey, keysMatch } from "../auth/keys.js";
import type { ClientConfig } from "../config/load.js";
import { RouterError } from "../errors.js";
import type { Runtime } from "../runtime.js";

declare module "fastify" {
  interface FastifyRequest {
    llmrClient: ClientConfig | null;
  }
}

function invalidKey(): RouterError {
  return new RouterError(401, "invalid_api_key", "Invalid API key.", "authentication_error");
}

function checkThrottle(request: FastifyRequest, runtime: Runtime): void {
  if (runtime.authThrottle.isBlocked(request.ip)) {
    throw new RouterError(
      429,
      "too_many_auth_failures",
      "Too many failed authentication attempts.",
      "rate_limit_error",
      { "retry-after": "60" },
    );
  }
}

export function authenticateClient(request: FastifyRequest, runtime: Runtime): ClientConfig {
  checkThrottle(request, runtime);
  const key = extractKey(request.headers);
  if (key !== null) {
    const match = runtime.clients.authenticate(hashKey(key));
    if (match) return match;
  }
  runtime.authThrottle.recordFailure(request.ip);
  throw invalidKey();
}

export function authenticateAdmin(request: FastifyRequest, runtime: Runtime): void {
  checkThrottle(request, runtime);
  const key = extractKey(request.headers);
  if (key !== null && keysMatch(hashKey(key), runtime.config.adminKeyHash)) return;
  runtime.authThrottle.recordFailure(request.ip);
  throw invalidKey();
}

/** Authenticates before the body is read, so unauthenticated uploads are refused early. */
export function clientAuthHook(runtime: Runtime) {
  return async (request: FastifyRequest): Promise<void> => {
    rejectLoop(request, runtime);
    request.llmrClient = authenticateClient(request, runtime);
  };
}

/** Refuses a request that this gateway itself sent, which would otherwise loop. */
export function rejectLoop(request: FastifyRequest, runtime: Runtime): void {
  if (request.headers["x-llmr-hop"] === runtime.instanceId) {
    throw new RouterError(508, "loop_detected", "This request looped back to the gateway.");
  }
}
