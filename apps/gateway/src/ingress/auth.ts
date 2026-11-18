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

/**
 * The answer to a key that did not match. Valid keys never get here, so one misconfigured
 * app cannot lock out everything else at the same address.
 */
function refuseKey(request: FastifyRequest, runtime: Runtime): RouterError {
  if (runtime.authThrottle.isBlocked(request.ip)) {
    return new RouterError(
      429,
      "too_many_auth_failures",
      "Too many failed authentication attempts.",
      "rate_limit_error",
      { "retry-after": "60" },
    );
  }
  runtime.authThrottle.recordFailure(request.ip);
  return invalidKey();
}

export function authenticateClient(request: FastifyRequest, runtime: Runtime): ClientConfig {
  const key = extractKey(request.headers);
  const match = key === null ? null : runtime.clients.authenticate(hashKey(key));
  if (match) return match;
  throw refuseKey(request, runtime);
}

export function authenticateAdmin(request: FastifyRequest, runtime: Runtime): void {
  const key = extractKey(request.headers);
  if (key !== null && keysMatch(hashKey(key), runtime.config.adminKeyHash)) return;
  throw refuseKey(request, runtime);
}

/** Accepts the admin key, or the key that can only read metrics. */
export function authenticateMetrics(request: FastifyRequest, runtime: Runtime): void {
  const key = extractKey(request.headers);
  if (key !== null) {
    const presented = hashKey(key);
    const { adminKeyHash, metricsKeyHash } = runtime.config;
    const admin = keysMatch(presented, adminKeyHash);
    const metrics = metricsKeyHash ? keysMatch(presented, metricsKeyHash) : false;
    if (admin || metrics) return;
  }
  throw refuseKey(request, runtime);
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
  if (request.headers["x-llmr-hop"] === runtime.hopId) {
    throw new RouterError(508, "loop_detected", "This request looped back to the gateway.");
  }
}
