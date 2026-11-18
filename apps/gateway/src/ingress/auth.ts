import type { FastifyRequest } from "fastify";
import { extractKey, hashKey, keysMatch } from "../auth/keys.js";
import type { ClientConfig } from "../config/load.js";
import { RouterError } from "../errors.js";
import type { Runtime } from "../runtime.js";

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
    const presented = hashKey(key);
    let match: ClientConfig | null = null;
    // Every key is compared, so timing does not reveal which one was close.
    for (const client of runtime.config.clients) {
      if (keysMatch(presented, client.keyHash)) match = client;
    }
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

/** Refuses a request that this gateway itself sent, which would otherwise loop. */
export function rejectLoop(request: FastifyRequest, runtime: Runtime): void {
  if (request.headers["x-llmr-hop"] === runtime.instanceId) {
    throw new RouterError(508, "loop_detected", "This request looped back to the gateway.");
  }
}
