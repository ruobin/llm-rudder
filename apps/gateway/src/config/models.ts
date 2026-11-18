import { globToRegExp } from "@llm-rudder/shared";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Effort } from "../translate/ir.js";
import type { Dialect } from "../types.js";

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const DIALECTS = ["openai.chat", "openai.responses", "anthropic.messages"] as const;

const profileFields = {
  context_window: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  images: z.boolean().optional(),
  documents: z.boolean().optional(),
  /** The APIs through which this model can call tools. All of them when unset. */
  tools_on: z.array(z.enum(DIALECTS)).optional(),
  sampling: z.boolean().optional(),
  forced_tool_choice: z.boolean().optional(),
  prefill: z.boolean().optional(),
  system_messages: z.boolean().optional(),
  adaptive_thinking: z.boolean().optional(),
  efforts: z.array(z.enum(EFFORTS)).optional(),
};

const modelsSchema = z.strictObject({
  version: z.string(),
  default: z.strictObject(profileFields).prefault({}),
  models: z.array(z.strictObject({ match: z.string().min(1), ...profileFields })).default([]),
});

type RawProfile = z.infer<z.ZodObject<typeof profileFields>>;

/** What a model accepts, used to pick targets and to shape translated requests. */
export interface ModelProfile {
  contextWindow?: number;
  maxOutputTokens?: number;
  images: boolean;
  documents: boolean;
  toolsOn?: Dialect[];
  /** Accepts temperature and top_p. */
  sampling: boolean;
  /** Accepts a tool_choice that forces a tool call. */
  forcedToolChoice: boolean;
  /** Accepts a request that ends with an assistant message. */
  prefill: boolean;
  /** Accepts system messages inside the conversation (Anthropic). */
  systemMessages: boolean;
  /** Uses adaptive thinking (Anthropic). */
  adaptiveThinking: boolean;
  efforts?: Effort[];
}

export interface ModelCatalog {
  version: string;
  fallback: ModelProfile;
  rules: { pattern: RegExp; profile: ModelProfile }[];
}

/** Assumes a model can do everything until the catalog says otherwise. */
const OPEN_PROFILE: ModelProfile = {
  images: true,
  documents: true,
  sampling: true,
  forcedToolChoice: true,
  prefill: true,
  systemMessages: false,
  adaptiveThinking: false,
};

function applyProfile(base: ModelProfile, raw: RawProfile): ModelProfile {
  return {
    ...base,
    ...(raw.context_window === undefined ? {} : { contextWindow: raw.context_window }),
    ...(raw.max_output_tokens === undefined ? {} : { maxOutputTokens: raw.max_output_tokens }),
    ...(raw.images === undefined ? {} : { images: raw.images }),
    ...(raw.documents === undefined ? {} : { documents: raw.documents }),
    ...(raw.tools_on === undefined ? {} : { toolsOn: raw.tools_on }),
    ...(raw.sampling === undefined ? {} : { sampling: raw.sampling }),
    ...(raw.forced_tool_choice === undefined ? {} : { forcedToolChoice: raw.forced_tool_choice }),
    ...(raw.prefill === undefined ? {} : { prefill: raw.prefill }),
    ...(raw.system_messages === undefined ? {} : { systemMessages: raw.system_messages }),
    ...(raw.adaptive_thinking === undefined ? {} : { adaptiveThinking: raw.adaptive_thinking }),
    ...(raw.efforts === undefined ? {} : { efforts: raw.efforts }),
  };
}

export const EMPTY_CATALOG: ModelCatalog = { version: "none", fallback: OPEN_PROFILE, rules: [] };

/** Returns the parsed catalog, or the problems that make it invalid. */
export function parseModelCatalog(text: string): ModelCatalog | string[] {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    return [`models: ${(error as Error).message.split("\n")[0]}`];
  }
  const result = modelsSchema.safeParse(document);
  if (!result.success) {
    return result.error.issues.map(
      (issue) => `models: ${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
  }
  const fallback = applyProfile(OPEN_PROFILE, result.data.default);
  return {
    version: result.data.version,
    fallback,
    rules: result.data.models.map(({ match, ...raw }) => ({
      pattern: globToRegExp(match),
      profile: applyProfile(fallback, raw),
    })),
  };
}

export function profileFor(catalog: ModelCatalog, model: string): ModelProfile {
  return catalog.rules.find((rule) => rule.pattern.test(model))?.profile ?? catalog.fallback;
}
