/** How one OpenAI-compatible upstream differs from the standard behavior. */
export interface CompatProfile {
  maxTokensField: "keep" | "max_tokens" | "max_completion_tokens";
  /** Whether the upstream accepts stream_options.include_usage. */
  streamUsage: boolean;
  /** "system" rewrites developer messages for upstreams without that role. */
  systemRole: "keep" | "system";
  /** Request fields this upstream rejects. */
  dropFields: string[];
  /** Keep tool_calls[].extra_content, which carries Gemini thought signatures. */
  toolExtras: boolean;
  /** Replacements for reasoning_effort values. */
  effortMap: Record<string, string>;
}

const standard: CompatProfile = {
  maxTokensField: "keep",
  streamUsage: true,
  systemRole: "keep",
  dropFields: [],
  toolExtras: false,
  effortMap: {},
};

export const COMPAT_PROFILES = {
  generic: standard,
  new_api: standard,
  openrouter: standard,
  openai: { ...standard, maxTokensField: "max_completion_tokens" },
  gemini: {
    ...standard,
    maxTokensField: "max_tokens",
    systemRole: "system",
    dropFields: ["store", "metadata", "prompt_cache_key", "prompt_cache_retention", "user"],
    toolExtras: true,
    effortMap: { none: "low", minimal: "low", xhigh: "high" },
  },
} satisfies Record<string, CompatProfile>;

export type CompatName = keyof typeof COMPAT_PROFILES;
