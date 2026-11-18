import type { AccountConfig } from "../config/load.js";
import { profileFor } from "../config/models.js";
import type { RequestContext } from "../execution/context.js";
import type { Runtime } from "../runtime.js";
import { asString } from "../translate/ir.js";
import { familyOf, requestIR } from "../translate/protocol.js";
import type { Target } from "../types.js";

interface Requirements {
  images: boolean;
  documents: boolean;
  tools: boolean;
  /** Only this provider family can run the hosted tools the request depends on. */
  hostedFamily?: "anthropic" | "openai";
  /** The request refers to state stored by the upstream. */
  upstreamState: boolean;
}

const cache = new WeakMap<RequestContext, Requirements>();

function requirementsOf(ctx: RequestContext): Requirements {
  const cached = cache.get(ctx);
  if (cached) return cached;
  const ir = requestIR(ctx);
  const needs: Requirements = {
    images: false,
    documents: false,
    tools: ir.tools.length > 0,
    upstreamState: asString(ctx.body.previous_response_id) !== undefined,
    ...(ir.hostedToolsRequired ? { hostedFamily: ir.hostedTools[0]!.family } : {}),
  };
  const scan = (blocks: { type: string }[]) => {
    for (const block of blocks) {
      if (block.type === "image") needs.images = true;
      else if (block.type === "document") needs.documents = true;
      else if (block.type === "tool_call") needs.tools = true;
      else if (block.type === "tool_result") {
        needs.tools = true;
        scan((block as unknown as { content: { type: string }[] }).content);
      }
    }
  };
  for (const message of ir.messages) scan(message.blocks);
  cache.set(ctx, needs);
  return needs;
}

/** Says why this target cannot serve this request, or null when it can. */
export function whyUnsuitable(
  target: Target,
  account: AccountConfig,
  ctx: RequestContext,
  rt: Runtime,
): "capability" | "context" | null {
  const needs = requirementsOf(ctx);
  const profile = profileFor(rt.config.models, target.model);
  const sameFormat = account.api === ctx.dialect;

  if (!sameFormat) {
    if (needs.upstreamState) return "capability";
    if (needs.hostedFamily && needs.hostedFamily !== familyOf(account.api)) return "capability";
  }
  if (needs.images && !profile.images) return "capability";
  if (needs.documents && !profile.documents) return "capability";
  if (needs.tools && profile.toolsOn && !profile.toolsOn.includes(account.api)) return "capability";
  if (profile.contextWindow !== undefined && ctx.bodyChars / 4 > profile.contextWindow) {
    return "context";
  }
  return null;
}
