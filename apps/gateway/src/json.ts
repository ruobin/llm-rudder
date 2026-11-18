import type { JsonObject } from "./types.js";

export function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

/** Parses text that should hold a JSON object. Returns null for anything else. */
export function parseObject(text: string): JsonObject | null {
  try {
    return asObject(JSON.parse(text));
  } catch {
    return null;
  }
}
