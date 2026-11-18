import { zstdDecompressSync } from "node:zlib";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ClientConfig, TierConfig } from "../config/load.js";
import { profileFor } from "../config/models.js";
import { RouterError } from "../errors.js";
import { ClientResponse, RESPONSES_ERRORS } from "../execution/client-response.js";
import type { RequestContext } from "../execution/context.js";
import { executeRequest } from "../execution/executor.js";
import { openAiResponses } from "../execution/protocols/openai-responses.js";
import { ulid } from "../ids.js";
import { buildPlan } from "../routing/plan.js";
import type { Runtime } from "../runtime.js";
import type { JsonObject } from "../types.js";
import { clientAuthHook } from "./auth.js";
import { deriveSessionKey } from "./session.js";
import { headerText, invalidRequest } from "./request.js";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const REASONING_LEVELS = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balances speed and reasoning depth" },
  { effort: "high", description: "Deeper reasoning for complex work" },
  { effort: "xhigh", description: "The deepest reasoning available" },
];

/**
 * Codex requires instructions for each model in a catalog. These stay general,
 * because a tier can be served by models from any provider.
 */
const CODEX_INSTRUCTIONS = `You are a coding agent working in the user's terminal through Codex. You can read and change files and run commands in their workspace.

How to work:
- Understand the request and the relevant code before changing anything. Search with rg when it is available.
- Make the smallest change that fully solves the problem, and follow the conventions already in the codebase.
- Use the available tools rather than guessing. Commands run in a sandbox, so if one is blocked, explain what you need instead of trying to get around it.
- Check your work with the project's tests or build when you can, and report honestly anything you could not check.
- Do not revert changes you did not make, and do not run destructive commands unless the user asked for them.
- Keep working until the task is done, unless you need a decision only the user can make.

When you finish, say briefly what changed and anything the user still needs to do. Refer to files by path.`;

/** Codex can compress request bodies with zstd. */
function readBody(request: FastifyRequest, maxBytes: number): Buffer {
  const raw = request.body as Buffer;
  const encoding = headerText(request, "content-encoding");
  if (encoding === undefined || encoding === "identity") return raw;
  if (encoding !== "zstd") {
    throw new RouterError(415, "unsupported_encoding", `Unsupported encoding "${encoding}".`);
  }
  try {
    return zstdDecompressSync(raw, { maxOutputLength: maxBytes });
  } catch {
    throw invalidRequest("The compressed request body could not be read.", "body");
  }
}

function buildContext(
  request: FastifyRequest,
  client: ClientConfig,
  signal: AbortSignal,
  runtime: Runtime,
): RequestContext {
  const rawBody = readBody(request, runtime.config.server.maxBodyBytes);
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw invalidRequest("The request body must be valid JSON.", "body");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw invalidRequest("The request body must be a JSON object.", "body");
  }
  const parsed = body as JsonObject;
  if (typeof parsed.model !== "string" || parsed.model === "") {
    throw invalidRequest("`model` is required.", "model");
  }
  if (parsed.input === undefined) throw invalidRequest("`input` is required.", "input");

  const tierHeader = headerText(request, "x-llmr-tier");
  const startedAt = runtime.now();
  return {
    requestId: ulid(startedAt),
    client,
    dialect: "openai.responses",
    body: parsed,
    rawBody,
    requestedModel: parsed.model,
    stream: parsed.stream === true,
    wantsUsage: false,
    sessionKey: deriveSessionKey(request.headers, parsed, client.id),
    allowFallback: client.allowFallback && request.headers["x-llmr-no-fallback"] !== "1",
    startedAt,
    deadlineAt: startedAt + runtime.config.routing.deadlineMs,
    signal,
    bodyChars: rawBody.length,
    ...(tierHeader === undefined ? {} : { tierHeader }),
    ...(typeof parsed.max_output_tokens === "number"
      ? { maxOutputTokens: parsed.max_output_tokens }
      : {}),
  };
}

/** Describes a tier in the format Codex reads for its model picker. */
function codexModel(tier: TierConfig, index: number, runtime: Runtime): JsonObject {
  const profiles = tier.targets.map((target) => profileFor(runtime.config.models, target.model));
  const windows = profiles
    .map((profile) => profile.contextWindow)
    .filter((value): value is number => value !== undefined);
  const contextWindow =
    tier.contextWindow ?? (windows.length > 0 ? Math.min(...windows) : DEFAULT_CONTEXT_WINDOW);
  return {
    slug: tier.name,
    display_name: `${tier.name} (llm-rudder)`,
    description: `Routed by llm-rudder to the best available ${tier.name} model.`,
    base_instructions: CODEX_INSTRUCTIONS,
    default_reasoning_level: "medium",
    supported_reasoning_levels: REASONING_LEVELS,
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: index,
    availability_nux: null,
    upgrade: null,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    truncation_policy: { mode: "tokens", limit: 10_000 },
    supports_parallel_tool_calls: true,
    context_window: contextWindow,
    experimental_supported_tools: [],
    input_modalities: profiles.every((profile) => profile.images) ? ["text", "image"] : ["text"],
  };
}

export function registerResponsesRoutes(app: FastifyInstance, runtime: Runtime): void {
  const authenticate = clientAuthHook(runtime);

  void app.register(async (scope) => {
    // These routes keep the original bytes, so only `model` changes on passthrough.
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) =>
      done(null, body),
    );

    scope.post("/v1/responses", { onRequest: authenticate }, async (request, reply) => {
      const client = request.llmrClient as ClientConfig;
      const release = await runtime.limits.acquire(client);
      const controller = new AbortController();
      const onClose = () => {
        if (!reply.raw.writableFinished) controller.abort();
      };
      reply.raw.once("close", onClose);
      try {
        const ctx = buildContext(request, client, controller.signal, runtime);
        const plan = buildPlan(ctx, runtime);
        const out = new ClientResponse(reply, runtime.now, RESPONSES_ERRORS);
        await executeRequest(runtime, ctx, plan, out, openAiResponses);
      } finally {
        reply.raw.off("close", onClose);
        release();
      }
      return reply;
    });
  });

  app.get("/router/codex/models", { onRequest: authenticate }, async () => ({
    models: [...runtime.config.tiers.values()].map((tier, index) =>
      codexModel(tier, index, runtime),
    ),
  }));
}
