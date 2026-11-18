import type { ModelProfile } from "../config/models.js";
import type { IRStreamEvent } from "./ir.js";
import type { Effort } from "./ir.js";
import { EFFORT_ORDER } from "./ir.js";
import type { ToolNames } from "./names.js";

/** What an encoder needs to know about the model it is writing for. */
export interface EncodeTarget {
  model: string;
  profile: ModelProfile;
  names: ToolNames;
  maxOutputTokens?: number;
  effort?: Effort;
  /** Gemini accepts only part of JSON Schema. */
  geminiSchemas: boolean;
  /** The account accepts Anthropic's top-level automatic caching. */
  autoCache: boolean;
  sessionKey: string;
  /** Set for the ChatGPT plan, which has its own request rules. */
  planRoute?: { toolNamespace: string };
  /** Reasoning kept by the gateway for this tool call, when this target can read it. */
  replay(callId: string): unknown[] | undefined;
}

export interface ResponseContext {
  names: ToolNames;
  customTools: Set<string>;
  now: number;
  /** The name the client asked for. */
  requestedModel: string;
  /** The model that answered. */
  servedModel: string;
  wantsUsage: boolean;
  /** The client asked to see reasoning summaries. */
  showReasoning: boolean;
  /** A namespace added for the upstream, which the client must not see. */
  toolNamespace?: string;
  /** A rough input size, shown until the real count arrives. */
  inputEstimate: number;
}

export interface ClientStreamEncoder {
  /** Returns the text to send for one event, which may be empty. */
  push(event: IRStreamEvent): string;
  /** Shows a note to the user, if this format can carry one. */
  notice(text: string): string;
  /** Returns the text that ends a successful stream. */
  close(): string;
}

/** Picks the closest level a model accepts, preferring the lower one. */
export function chooseEffort(requested: Effort, allowed: Effort[] | undefined): Effort {
  if (!allowed || allowed.includes(requested)) return requested;
  const rank = EFFORT_ORDER.indexOf(requested);
  const below = allowed.filter((effort) => EFFORT_ORDER.indexOf(effort) <= rank);
  if (below.length > 0) {
    return below.reduce((best, effort) =>
      EFFORT_ORDER.indexOf(effort) > EFFORT_ORDER.indexOf(best) ? effort : best,
    );
  }
  return allowed.reduce((best, effort) =>
    EFFORT_ORDER.indexOf(effort) < EFFORT_ORDER.indexOf(best) ? effort : best,
  );
}
