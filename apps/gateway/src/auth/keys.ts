import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function hashKey(key: string): Buffer {
  return createHash("sha256").update(key).digest();
}

/** Creates a client key: "llmr_" followed by 43 random base62 characters. */
export function generateKey(): string {
  let output = "";
  while (output.length < 43) {
    for (const byte of randomBytes(64)) {
      // Rejecting values of 248 and above keeps the distribution uniform.
      if (byte < 248 && output.length < 43) output += BASE62[byte % 62];
    }
  }
  return `llmr_${output}`;
}

export function keysMatch(presented: Buffer, expected: Buffer): boolean {
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/** Reads the key from Authorization: Bearer, or from x-api-key. */
export function extractKey(headers: Record<string, unknown>): string | null {
  const authorization = headers["authorization"];
  if (typeof authorization === "string") {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
    if (match?.[1]) return match[1];
  }
  const apiKey = headers["x-api-key"];
  return typeof apiKey === "string" && apiKey.length > 0 ? apiKey : null;
}
