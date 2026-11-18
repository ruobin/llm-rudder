import type { JsonObject } from "../types.js";

const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 20_000;

/**
 * Remembers each tool call's extra_content between turns. Gemini requires its
 * thought signature back on the next request, and many clients drop unknown
 * fields, so the gateway restores them.
 */
export class ToolExtrasStore {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  set(clientId: string, toolCallId: string, value: unknown): void {
    const key = `${clientId}\u0000${toolCallId}`;
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + TTL_MS });
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  get(clientId: string, toolCallId: string): unknown {
    const key = `${clientId}\u0000${toolCallId}`;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Stores extras from a complete assistant message. */
  captureMessage(clientId: string, message: unknown): void {
    const toolCalls = (message as JsonObject | null)?.tool_calls;
    if (!Array.isArray(toolCalls)) return;
    for (const call of toolCalls as JsonObject[]) {
      if (typeof call?.id === "string" && call.extra_content !== undefined) {
        this.set(clientId, call.id, call.extra_content);
      }
    }
  }
}

/** Follows tool-call deltas in one stream, where only the first delta has an id. */
export class StreamToolExtras {
  private readonly idsByIndex = new Map<number, string>();

  constructor(
    private readonly store: ToolExtrasStore,
    private readonly clientId: string,
  ) {}

  capture(delta: unknown): void {
    const toolCalls = (delta as JsonObject | null)?.tool_calls;
    if (!Array.isArray(toolCalls)) return;
    for (const call of toolCalls as JsonObject[]) {
      const index = typeof call?.index === "number" ? call.index : 0;
      if (typeof call?.id === "string" && call.id !== "") this.idsByIndex.set(index, call.id);
      const id = this.idsByIndex.get(index);
      if (id !== undefined && call?.extra_content !== undefined) {
        this.store.set(this.clientId, id, call.extra_content);
      }
    }
  }
}
