import type { Classified, JsonObject, Usage } from "../types.js";

/**
 * The common form that every API format is translated through. With one codec
 * per format, three codecs cover every client and upstream combination.
 */

export type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORT_ORDER: Effort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "refusal";

/** Who can read a reasoning artifact. It is never sent to anyone else. */
export type ReasoningFamily = "anthropic" | "openai" | "other";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  url?: string;
  data?: string;
  mediaType?: string;
  detail?: string;
  fileId?: string;
}

export interface DocumentBlock {
  type: "document";
  url?: string;
  data?: string;
  mediaType?: string;
  filename?: string;
  fileId?: string;
}

export type ContentBlock = TextBlock | ImageBlock | DocumentBlock;

export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  name: string;
  namespace?: string;
  /** JSON text for a function, plain text for a custom tool. */
  input: string;
  kind: "function" | "custom";
}

export interface ToolResultBlock {
  type: "tool_result";
  callId: string;
  content: ContentBlock[];
  isError?: boolean;
  kind?: "function" | "custom";
}

export interface ReasoningBlock {
  type: "reasoning";
  family: ReasoningFamily;
  text?: string;
  /** The original block or item, replayed unchanged to the family that made it. */
  raw?: JsonObject;
}

export type Block = ContentBlock | ToolCallBlock | ToolResultBlock | ReasoningBlock;

export interface IRMessage {
  role: "system" | "user" | "assistant";
  blocks: Block[];
}

export interface IRTool {
  name: string;
  namespace?: string;
  description?: string;
  parameters: JsonObject;
  kind: "function" | "custom";
}

/** A tool run by one provider, such as web search. It cannot move elsewhere. */
export interface IRHostedTool {
  family: "anthropic" | "openai";
  type: string;
  raw: JsonObject;
}

export type IRToolChoice = "auto" | "none" | "required" | { name: string; namespace?: string };

export type IRResponseFormat =
  | { type: "json_object" }
  | {
      type: "json_schema";
      name: string;
      schema: JsonObject;
      strict?: boolean;
      description?: string;
    };

export interface IRRequest {
  /** System text that comes before the conversation. */
  system: string[];
  messages: IRMessage[];
  tools: IRTool[];
  hostedTools: IRHostedTool[];
  /** True when the request cannot work without its hosted tools. */
  hostedToolsRequired: boolean;
  toolChoice?: IRToolChoice;
  parallelToolCalls?: boolean;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  effort?: Effort;
  /** The client wants to see reasoning summaries. */
  reasoningSummary?: boolean;
  responseFormat?: IRResponseFormat;
}

export interface IRResponse {
  id?: string;
  model?: string;
  blocks: (TextBlock | ToolCallBlock | ReasoningBlock)[];
  finish: FinishReason;
  usage: Usage | null;
}

export type IRStreamEvent =
  | { type: "meta"; id?: string; model?: string }
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "artifact"; family: ReasoningFamily; item: JsonObject }
  | {
      type: "tool_start";
      index: number;
      id: string;
      name: string;
      namespace?: string;
      kind: "function" | "custom";
    }
  | { type: "tool_delta"; index: number; text: string }
  | { type: "tool_end"; index: number }
  | { type: "usage"; usage: Usage }
  | { type: "finish"; reason: FinishReason }
  /** The upstream closed the stream normally. */
  | { type: "done" }
  | { type: "error"; cause: Classified };

export const textOf = (blocks: Block[]): string =>
  blocks
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
export const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export function parseEffort(value: unknown): Effort | undefined {
  return EFFORT_ORDER.includes(value as Effort) ? (value as Effort) : undefined;
}

/** Splits a `data:` URL into its media type and base64 payload. */
export function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const match = /^data:([^;,]+)?(?:;[^;,]+)*;base64,(.*)$/s.exec(url);
  return match ? { mediaType: match[1] ?? "application/octet-stream", data: match[2]! } : null;
}

export const dataUrl = (mediaType: string | undefined, data: string): string =>
  `data:${mediaType ?? "application/octet-stream"};base64,${data}`;

export function parseJsonObject(text: string): JsonObject | null {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

export function totalInputTokens(usage: Usage): number {
  return (
    usage.inputTokens +
    usage.cachedTokens +
    (usage.cacheWrite5mTokens ?? 0) +
    (usage.cacheWrite1hTokens ?? 0)
  );
}
