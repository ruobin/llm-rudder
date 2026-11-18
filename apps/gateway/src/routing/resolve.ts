import type { Config } from "../config/load.js";
import { RouterError } from "../errors.js";
import type { Target } from "../types.js";

export type Resolution = { kind: "tier"; tier: string } | { kind: "model"; targets: Target[] };

/** Maps the requested model to a tier, or to the targets serving that exact model. */
export function resolveModel(model: string, tierHeader: string | undefined, config: Config) {
  if (tierHeader !== undefined) {
    if (config.tiers.has(tierHeader)) return { kind: "tier", tier: tierHeader } as Resolution;
    throw unknownModel(tierHeader, config);
  }
  if (config.tiers.has(model)) return { kind: "tier", tier: model } as Resolution;

  for (const alias of config.aliases) {
    if (alias.pattern.test(model)) return { kind: "tier", tier: alias.tier } as Resolution;
  }

  const seen = new Set<string>();
  const targets: Target[] = [];
  for (const tier of config.tiers.values()) {
    for (const target of tier.targets) {
      const key = `${target.accountId}\u0000${target.model}`;
      if (target.model === model && !seen.has(key)) {
        seen.add(key);
        targets.push(target);
      }
    }
  }
  if (targets.length > 0) return { kind: "model", targets } as Resolution;
  throw unknownModel(model, config);
}

function unknownModel(model: string, config: Config): RouterError {
  const tiers = [...config.tiers.keys()].join(", ");
  return new RouterError(
    404,
    "model_not_found",
    `Unknown model "${model}". Available tiers: ${tiers}.`,
    "invalid_request_error",
    {},
    "model",
  );
}
