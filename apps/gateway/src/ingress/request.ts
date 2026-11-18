import type { FastifyRequest } from "fastify";
import { RouterError } from "../errors.js";

export function invalidRequest(message: string, param: string | null = null): RouterError {
  return new RouterError(400, "invalid_request", message, "invalid_request_error", {}, param);
}

/** Reads a header sent once, treating an empty value as missing. */
export function headerText(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}
