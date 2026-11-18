import { profileFor } from "../config/models.js";
import { chooseEffort } from "../translate/codec.js";
import type { Effort } from "../translate/ir.js";
import type { Attempt } from "./protocol.js";

/**
 * The reasoning effort to add to a request that passes through untranslated. A target's
 * effort only applies when the client did not choose one.
 */
export function effortToAdd({ rt, target }: Attempt, clientEffort: unknown): Effort | null {
  if (!target.effort || (clientEffort !== undefined && clientEffort !== null)) return null;
  return chooseEffort(target.effort, profileFor(rt.config.models, target.model).efforts);
}
