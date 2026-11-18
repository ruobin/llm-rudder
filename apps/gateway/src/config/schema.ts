import { z } from "zod";
import { COMPAT_PROFILES } from "./compat.js";

const envName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name");
const id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "must be a lowercase identifier");
const positiveSeconds = z.number().positive();

const clientSchema = z.strictObject({
  id,
  key_env: envName,
  notice: z.enum(["text", "none"]).default("none"),
  rpm: z.number().int().positive().optional(),
  max_concurrent: z.number().int().positive().default(32),
  allow_accounts: z.array(id).optional(),
  allow_fallback: z.boolean().default(true),
});

const budgetSchema = z
  .strictObject({
    daily_usd: z.number().positive().optional(),
    monthly_usd: z.number().positive().optional(),
  })
  .refine((b) => b.daily_usd !== undefined || b.monthly_usd !== undefined, {
    message: "set daily_usd, monthly_usd, or both",
  });

const compatNames = Object.keys(COMPAT_PROFILES) as [
  keyof typeof COMPAT_PROFILES,
  ...(keyof typeof COMPAT_PROFILES)[],
];

const compatOverrides = z
  .strictObject({
    max_tokens_field: z.enum(["keep", "max_tokens", "max_completion_tokens"]).optional(),
    stream_usage: z.boolean().optional(),
    system_role: z.enum(["keep", "system"]).optional(),
    drop_fields: z.array(z.string()).optional(),
    tool_extras: z.boolean().optional(),
    effort_map: z.record(z.string(), z.string()).optional(),
  })
  .optional();

const accountSchema = z
  .strictObject({
    base_url: z.url().optional(),
    base_url_env: envName.optional(),
    api_key_env: envName.optional(),
    compat: z.enum(compatNames).default("generic"),
    compat_overrides: compatOverrides,
    cost_class: z.enum(["prepaid", "free", "metered"]),
    trust: z.enum(["first_party", "self_hosted", "third_party"]).default("third_party"),
    enabled: z.boolean().default(true),
    budget: budgetSchema.optional(),
  })
  .refine((a) => (a.base_url === undefined) !== (a.base_url_env === undefined), {
    message: "set exactly one of base_url or base_url_env",
  });

const targetSchema = z.strictObject({
  account: id,
  model: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
});

const tierSchema = z.strictObject({
  fallback_tiers: z.array(id).default([]),
  prefer: z.enum(["quality", "cost"]).default("quality"),
  context_window: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  targets: z.array(targetSchema).min(1),
});

export const configSchema = z.strictObject({
  version: z.literal(1),
  server: z
    .strictObject({
      host: z.string().default("0.0.0.0"),
      port: z.number().int().min(0).max(65535).default(4141),
      trust_proxy: z.boolean().default(false),
      max_body_mb: z.number().positive().default(32),
    })
    .prefault({}),
  admin: z.strictObject({ key_env: envName }),
  clients: z.array(clientSchema).min(1),
  accounts: z.record(id, accountSchema),
  tiers: z.record(id, tierSchema),
  aliases: z.array(z.strictObject({ match: z.string().min(1), tier: id })).default([]),
  routing: z
    .strictObject({
      max_attempts_per_tier: z.number().int().positive().default(3),
      deadline_s: positiveSeconds.default(900),
    })
    .prefault({}),
  timeouts: z
    .strictObject({
      connect_s: positiveSeconds.default(10),
      first_byte_s: positiveSeconds.default(120),
      commit_s: positiveSeconds.default(300),
      stream_idle_s: positiveSeconds.default(300),
      keepalive_after_s: positiveSeconds.default(20),
      keepalive_interval_s: positiveSeconds.default(15),
    })
    .prefault({}),
  notifications: z
    .strictObject({
      ntfy_url_env: envName.optional(),
      webhook_url_env: envName.optional(),
      repeat_after_s: positiveSeconds.default(3600),
    })
    .prefault({}),
  pricing_file: z.string().default("pricing.yaml"),
});

export type RawConfig = z.infer<typeof configSchema>;

const priceSchema = z.strictObject({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cached_input: z.number().nonnegative().optional(),
});

export const pricingSchema = z.strictObject({
  version: z.string(),
  default: priceSchema,
  models: z.record(z.string(), priceSchema).default({}),
});

export type RawPricing = z.infer<typeof pricingSchema>;
