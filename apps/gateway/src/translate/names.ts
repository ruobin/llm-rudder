import { shortHash } from "../ids.js";
import type { JsonObject } from "../types.js";
import type { IRTool } from "./ir.js";
import { asArray, isObject } from "./ir.js";

const SAFE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const NAMESPACE_SEPARATOR = "__";

const qualified = (name: string, namespace?: string) =>
  namespace ? `${namespace}${NAMESPACE_SEPARATOR}${name}` : name;

/**
 * Maps tool names to ones every provider accepts, and back again. The mapping
 * depends only on the name, so it is the same on every turn of a conversation.
 */
export class ToolNames {
  private readonly originals = new Map<string, { name: string; namespace?: string }>();

  constructor(tools: IRTool[]) {
    for (const tool of tools) this.wire(tool.name, tool.namespace);
  }

  wire(name: string, namespace?: string): string {
    const full = qualified(name, namespace);
    let wire = full;
    if (!SAFE_NAME.test(full)) {
      const cleaned = full.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 47);
      wire = `${cleaned}_${shortHash(full)}`;
    }
    this.originals.set(wire, { name, ...(namespace ? { namespace } : {}) });
    return wire;
  }

  original(wire: string): { name: string; namespace?: string } {
    return this.originals.get(wire) ?? { name: wire };
  }
}

/** Anthropic allows only these characters in tool call IDs. */
export function cleanCallId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_") || "call_unknown";
}

/** Custom tools take free text, so other providers see one string parameter. */
export const CUSTOM_TOOL_PARAMETERS: JsonObject = {
  type: "object",
  properties: { input: { type: "string", description: "The complete input for this tool." } },
  required: ["input"],
};

export function wrapCustomInput(input: string): string {
  return JSON.stringify({ input });
}

export function unwrapCustomInput(argumentsText: string): string {
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    if (isObject(parsed) && typeof parsed.input === "string") return parsed.input;
  } catch {
    // Returned as received below.
  }
  return argumentsText;
}

const GEMINI_SCHEMA_KEYS = new Set([
  "type",
  "description",
  "nullable",
  "enum",
  "items",
  "properties",
  "required",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "anyOf",
  "title",
  "default",
]);
const MAX_SCHEMA_DEPTH = 32;

function resolveRef(ref: unknown, root: JsonObject): JsonObject | null {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return null;
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    if (!isObject(node)) return null;
    node = node[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return isObject(node) ? node : null;
}

/**
 * Keeps the part of JSON Schema that Gemini documents, so a tool written for
 * another provider is not rejected for an unsupported keyword.
 */
export function geminiSchema(schema: JsonObject, root: JsonObject = schema, depth = 0): JsonObject {
  if (depth > MAX_SCHEMA_DEPTH) return { type: "object" };
  const source = resolveRef(schema.$ref, root) ?? schema;
  const output: JsonObject = {};
  for (const [key, value] of Object.entries(source)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue;
    if (key === "properties" && isObject(value)) {
      output.properties = Object.fromEntries(
        Object.entries(value).map(([name, property]) => [
          name,
          isObject(property) ? geminiSchema(property, root, depth + 1) : property,
        ]),
      );
    } else if (key === "items" && isObject(value)) {
      output.items = geminiSchema(value, root, depth + 1);
    } else if (key === "anyOf") {
      output.anyOf = asArray(value).map((entry) =>
        isObject(entry) ? geminiSchema(entry, root, depth + 1) : entry,
      );
    } else {
      output[key] = value;
    }
  }
  if (source.const !== undefined) output.enum = [source.const];
  if (Array.isArray(source.oneOf) && output.anyOf === undefined) {
    output.anyOf = source.oneOf.map((entry) =>
      isObject(entry) ? geminiSchema(entry as JsonObject, root, depth + 1) : entry,
    );
  }
  if (Array.isArray(output.type)) {
    const types = output.type as unknown[];
    const real = types.filter((type) => type !== "null");
    if (real.length < types.length) output.nullable = true;
    if (real.length === 1) output.type = real[0];
    else {
      delete output.type;
      output.anyOf = real.map((type) => ({ type }));
    }
  }
  return output;
}
