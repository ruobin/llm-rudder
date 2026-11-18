import { costMicroUsd, estimateUsage, priceFor } from "../billing/pricing.js";
import { dayPeriod } from "../billing/budgets.js";
import type { AccountConfig } from "../config/load.js";
import type { AttemptRecord } from "../ledger/records.js";
import type { Plan, PlanStep } from "../routing/plan.js";
import { estimateCost } from "../routing/plan.js";
import type { Runtime } from "../runtime.js";
import type { Classified, JsonObject, Outcome, Usage } from "../types.js";
import {
  classifyEmbeddedError,
  classifyHttpError,
  classifyTransportError,
} from "../upstream/classify.js";
import { buildUpstreamBody } from "../upstream/request.js";
import { SseDecoder, type SseEvent } from "../upstream/sse.js";
import { StreamToolExtras } from "../upstream/tool-extras.js";
import { parseUsage } from "../upstream/usage.js";
import type { ClientResponse } from "./client-response.js";
import type { RequestContext } from "./context.js";
import {
  addNoticeToMessage,
  canAddNotice,
  noticeChunk,
  noticeText,
  reasonLabel,
} from "./notice.js";

const OK: Classified = { outcome: "ok", retryElsewhere: false };
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text", "refusal"];

interface AttemptResult {
  /** Output reached the client, so no other target may be tried. */
  delivered: boolean;
  classified: Classified;
  /** The failure that should update quota state, when it differs. */
  stateUpdate?: Classified;
  httpStatus: number | null;
  usage: Usage | null;
  returnedModel: string | null;
  ttftMs: number | null;
  outputChars: number;
}

class AbortReason extends Error {
  constructor(readonly kind: "client" | "commit_timeout" | "idle_timeout" | "deadline") {
    super(kind);
  }
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function firstChoice(chunk: JsonObject): JsonObject | null {
  return Array.isArray(chunk.choices) ? asObject(chunk.choices[0]) : null;
}

const isNonEmpty = (value: unknown) =>
  (typeof value === "string" && value.length > 0) || (Array.isArray(value) && value.length > 0);

/** The commit point: the first chunk that carries model output or a finish. */
export function chunkHasOutput(chunk: JsonObject): boolean {
  const choice = firstChoice(chunk);
  if (!choice) return false;
  if (choice.finish_reason) return true;
  const delta = asObject(choice.delta);
  if (!delta) return false;
  return (
    isNonEmpty(delta.content) ||
    isNonEmpty(delta.tool_calls) ||
    delta.function_call !== undefined ||
    REASONING_FIELDS.some((field) => isNonEmpty(delta[field]))
  );
}

function deltaChars(chunk: JsonObject): number {
  const delta = asObject(firstChoice(chunk)?.delta);
  if (!delta) return 0;
  let total = typeof delta.content === "string" ? delta.content.length : 0;
  if (Array.isArray(delta.tool_calls)) total += JSON.stringify(delta.tool_calls).length;
  return total;
}

const isUsageOnly = (chunk: JsonObject) =>
  chunk.usage !== undefined &&
  chunk.usage !== null &&
  Array.isArray(chunk.choices) &&
  chunk.choices.length === 0;

async function readLimited(body: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    parts.push(chunk);
    size += chunk.length;
    if (size >= MAX_ERROR_BODY_BYTES) break;
  }
  return Buffer.concat(parts).toString("utf8").slice(0, MAX_ERROR_BODY_BYTES);
}

function headerString(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/** Turns a complete response into the events of an equivalent stream. */
function responseToEvents(response: JsonObject): SseEvent[] {
  const choice = firstChoice(response) ?? {};
  const message = asObject(choice.message) ?? {};
  const toolCalls = Array.isArray(message.tool_calls)
    ? (message.tool_calls as JsonObject[]).map((call, index) => ({ index, ...call }))
    : undefined;
  const chunk = {
    id: response.id,
    object: "chat.completion.chunk",
    created: response.created,
    model: response.model,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          ...(message.content === undefined || message.content === null
            ? {}
            : { content: message.content }),
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: choice.finish_reason ?? "stop",
      },
    ],
    ...(response.usage ? { usage: response.usage } : {}),
  };
  const data = JSON.stringify(chunk);
  return [{ raw: `data: ${data}`, data, event: null, isComment: false }];
}

export async function executeChat(
  runtime: Runtime,
  ctx: RequestContext,
  plan: Plan,
  out: ClientResponse,
): Promise<void> {
  await new ChatRun(runtime, ctx, plan, out).run();
}

class ChatRun {
  private readonly attempts: AttemptRecord[] = [];
  private readonly reasons: string[];
  private servedStep: PlanStep | null = null;
  private finalOutcome: Outcome = "upstream_error";
  private finalStatus: number | null = null;

  constructor(
    private readonly rt: Runtime,
    private readonly ctx: RequestContext,
    private readonly plan: Plan,
    private readonly out: ClientResponse,
  ) {
    this.reasons = plan.skipped
      .filter((entry) => entry.reason !== "not_allowed" && entry.reason !== "disabled")
      .map((entry) => `${entry.target.accountId}:${entry.reason}`);
  }

  private reasonList(): string {
    return [...new Set(this.reasons)].join(",").slice(0, 500);
  }

  async run(): Promise<void> {
    const { ctx, out, rt } = this;
    if (ctx.stream) {
      out.startKeepalive(
        rt.config.timeouts.keepaliveAfterMs,
        rt.config.timeouts.keepaliveIntervalMs,
      );
    }
    try {
      await this.tryTargets();
    } finally {
      out.stopKeepalive();
      if (out.started) out.endStream();
      this.record();
    }
  }

  private async tryTargets(): Promise<void> {
    const { ctx, rt, plan } = this;
    for (const step of plan.steps) {
      if (ctx.signal.aborted) {
        this.finalOutcome = "client_aborted";
        return;
      }
      if (rt.now() >= ctx.deadlineAt) break;

      const { target } = step;
      if (!rt.quota.tryAdmit(target)) {
        this.reasons.push(`${target.accountId}:probing`);
        continue;
      }
      const account = rt.config.accounts.get(target.accountId) as AccountConfig;
      const hold = rt.budgets.reserve(account.id, estimateCost(ctx, target, rt));
      if (!hold) {
        rt.quota.releaseProbe(target);
        this.reasons.push(`${target.accountId}:budget`);
        continue;
      }

      const startedAt = rt.now();
      const body = buildUpstreamBody(
        ctx.body,
        target,
        account,
        ctx.stream,
        ctx.client.id,
        rt.toolExtras,
      );
      const result = ctx.stream
        ? await this.streamAttempt(step, account, body, startedAt)
        : await this.jsonAttempt(step, account, body, startedAt);

      const costs = this.costs(step, account, result);
      if (result.delivered) rt.budgets.settle(hold, costs.chargeMicroUsd);
      else rt.budgets.release(hold);

      this.attempts.push({
        requestId: ctx.requestId,
        n: this.attempts.length + 1,
        targetId: target.id,
        accountId: target.accountId,
        model: target.model,
        returnedModel: result.returnedModel,
        startedAt,
        ttftMs: result.ttftMs,
        durationMs: rt.now() - startedAt,
        httpStatus: result.httpStatus,
        outcome: result.classified.outcome,
        errorCode: result.classified.code ?? null,
        inputTokens: costs.usage?.inputTokens ?? null,
        cachedTokens: costs.usage?.cachedTokens ?? null,
        outputTokens: costs.usage?.outputTokens ?? null,
        usageComplete: result.usage !== null,
        costMicroUsd: costs.recordedCost,
        listMicroUsd: costs.listMicroUsd,
      });

      const outcome = result.classified.outcome;
      if (outcome === "ok") {
        rt.quota.recordSuccess(target);
      } else if (outcome === "client_aborted") {
        rt.quota.releaseProbe(target);
      } else {
        rt.quota.recordFailure(target, result.stateUpdate ?? result.classified);
      }

      if (result.delivered) {
        this.servedStep = step;
        this.finalOutcome = outcome;
        this.finalStatus = 200;
        this.warnAboutMeteredFailover(step, account);
        return;
      }

      this.finalOutcome = outcome;
      this.finalStatus = result.httpStatus;
      if (outcome === "client_aborted") return;
      if (!result.classified.retryElsewhere) {
        await this.sendClientError(result.classified, result.httpStatus);
        return;
      }
      this.reasons.push(`${target.accountId}:${outcome}`);
    }
    await this.sendAllFailed();
  }

  private costs(step: PlanStep, account: AccountConfig, result: AttemptResult) {
    const price = priceFor(this.rt.config.pricing, step.target.model);
    let usage = result.usage;
    if (!usage && result.delivered) {
      const estimate = estimateUsage(this.ctx.bodyChars, undefined);
      usage = { ...estimate, outputTokens: Math.ceil(result.outputChars / 4) };
    }
    const listMicroUsd = usage ? costMicroUsd(usage, price) : null;
    const metered = account.costClass === "metered";
    return {
      usage,
      listMicroUsd,
      chargeMicroUsd: metered ? (listMicroUsd ?? 0) : 0,
      recordedCost: metered ? listMicroUsd : null,
    };
  }

  private warnAboutMeteredFailover(step: PlanStep, account: AccountConfig): void {
    if (account.costClass !== "metered" || this.reasons.length === 0) return;
    const { rt } = this;
    const key = `${account.id}|${dayPeriod(rt.now())}`;
    if (rt.meteredSeen.has(key)) return;
    rt.meteredSeen.add(key);
    rt.notifier.emit(
      "metered_first_use",
      key,
      `Traffic moved to ${account.id} (${step.target.model}), which costs money.`,
    );
  }

  /** Runs once, when a target is about to deliver output. Returns a note if one is due. */
  private onServed(step: PlanStep): string | null {
    const { rt, ctx, plan, out } = this;
    const { target } = step;
    out.setHeaders({
      "x-llmr-request-id": ctx.requestId,
      "x-llmr-target": target.id,
      "x-llmr-served-tier": target.tier,
      "x-llmr-attempts": String(this.attempts.length + 1),
      ...(plan.requestedTier ? { "x-llmr-requested-tier": plan.requestedTier } : {}),
      ...(this.reasons.length > 0 ? { "x-llmr-fallback": this.reasonList() } : {}),
      ...(step.isFallback
        ? { "x-llmr-tier-fallback": `${plan.requestedTier}->${target.tier}` }
        : {}),
    });

    if (plan.requestedTier === null) return null;
    if (!step.isFallback) {
      rt.episodes.onPrimary(plan.requestedTier);
      return null;
    }
    const reason = reasonLabel(this.reasons);
    rt.episodes.onFallback(plan.requestedTier, target.tier, reason);
    if (
      canAddNotice(ctx) &&
      rt.episodes.takeNotice(plan.requestedTier, ctx.client.id, ctx.sessionKey)
    ) {
      return noticeText(plan.requestedTier, target.tier, target.model, reason);
    }
    return null;
  }

  private newResult(): AttemptResult {
    return {
      delivered: false,
      classified: { outcome: "upstream_error", retryElsewhere: true, scope: "model" },
      httpStatus: null,
      usage: null,
      returnedModel: null,
      ttftMs: null,
      outputChars: 0,
    };
  }

  private failureFromError(error: unknown, signal: AbortSignal): Classified {
    const reason = signal.reason;
    if (reason instanceof AbortReason) {
      if (reason.kind === "client") {
        return { outcome: "client_aborted", retryElsewhere: false, code: "client_closed" };
      }
      return {
        outcome: "timeout",
        retryElsewhere: true,
        scope: "model",
        code: reason.kind,
        message: `The upstream hit the ${reason.kind.replace("_", " ")}.`,
      };
    }
    return classifyTransportError(error);
  }

  private linkAbort(controller: AbortController): () => void {
    const onClientAbort = () => controller.abort(new AbortReason("client"));
    if (this.ctx.signal.aborted) onClientAbort();
    else this.ctx.signal.addEventListener("abort", onClientAbort, { once: true });
    return () => this.ctx.signal.removeEventListener("abort", onClientAbort);
  }

  private async jsonAttempt(
    step: PlanStep,
    account: AccountConfig,
    body: JsonObject,
    startedAt: number,
  ): Promise<AttemptResult> {
    const { rt, ctx, out } = this;
    const result = this.newResult();
    const controller = new AbortController();
    const unlink = this.linkAbort(controller);
    const timer = setTimeout(
      () => controller.abort(new AbortReason("deadline")),
      Math.max(1, ctx.deadlineAt - rt.now()),
    );
    try {
      const response = await rt.upstream.sendChat(account, body, {
        stream: false,
        signal: controller.signal,
      });
      result.httpStatus = response.status;
      const text = await response.body.text();
      if (response.status >= 400) {
        result.classified = classifyHttpError(response.status, response.headers, text, rt.now());
        return result;
      }
      let parsed: JsonObject | null = null;
      try {
        parsed = asObject(JSON.parse(text));
      } catch {
        parsed = null;
      }
      if (parsed?.error && !parsed.choices) {
        result.classified = classifyEmbeddedError(parsed, rt.now());
        return result;
      }
      if (!parsed || !Array.isArray(parsed.choices) || parsed.choices.length === 0) {
        result.classified = {
          outcome: "upstream_error",
          retryElsewhere: true,
          scope: "model",
          code: "invalid_response",
          message: "The upstream response had no choices.",
        };
        return result;
      }

      result.ttftMs = rt.now() - startedAt;
      result.returnedModel = typeof parsed.model === "string" ? parsed.model : null;
      result.usage = parseUsage(parsed.usage);
      const message = firstChoice(parsed)?.message;
      if (account.compat.toolExtras) rt.toolExtras.captureMessage(ctx.client.id, message);
      result.outputChars = JSON.stringify(message ?? "").length;

      const notice = this.onServed(step);
      if (notice) addNoticeToMessage(parsed, notice);
      await out.sendJson(200, notice ? JSON.stringify(parsed) : text);
      result.delivered = true;
      result.classified = OK;
      return result;
    } catch (error) {
      result.classified = this.failureFromError(error, controller.signal);
      return result;
    } finally {
      clearTimeout(timer);
      unlink();
    }
  }

  private async streamAttempt(
    step: PlanStep,
    account: AccountConfig,
    body: JsonObject,
    startedAt: number,
  ): Promise<AttemptResult> {
    const { rt, ctx, out } = this;
    const { commitMs, streamIdleMs } = rt.config.timeouts;
    const result = this.newResult();
    const controller = new AbortController();
    const unlink = this.linkAbort(controller);

    let timer: NodeJS.Timeout | undefined;
    const arm = (ms: number, kind: AbortReason["kind"]) => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new AbortReason(kind)), Math.max(1, ms));
    };
    const untilDeadline = ctx.deadlineAt - rt.now();
    if (untilDeadline < commitMs) arm(untilDeadline, "deadline");
    else arm(commitMs, "commit_timeout");

    const extras = account.compat.toolExtras
      ? new StreamToolExtras(rt.toolExtras, ctx.client.id)
      : null;
    const held: { event: SseEvent; chunk: JsonObject }[] = [];
    let committed = false;
    let sawDone = false;
    let sawFinish = false;

    const failMidStream = async (cause: Classified) => {
      result.delivered = true;
      result.classified = {
        ...cause,
        outcome: "mid_stream_failure",
        retryElsewhere: false,
        code: cause.code ?? "stream_interrupted",
      };
      result.stateUpdate = cause.retryElsewhere ? cause : result.classified;
      await out.sendError(
        502,
        "The upstream failed after output had started. Retry the request.",
        "upstream_error",
        "stream_interrupted",
      );
    };

    const commit = async (chunk: JsonObject): Promise<boolean> => {
      committed = true;
      result.ttftMs = rt.now() - startedAt;
      arm(streamIdleMs, "idle_timeout");
      out.cancelDelayedStart();
      const notice = this.onServed(step);
      out.startStream();
      for (const entry of held) {
        if (isUsageOnly(entry.chunk) && !ctx.wantsUsage) continue;
        if (!(await out.write(`${entry.event.raw}\n\n`))) return false;
      }
      const heldRole = held.some((entry) => asObject(firstChoice(entry.chunk)?.delta)?.role);
      if (notice && !(await out.write(noticeChunk(chunk, notice, !heldRole)))) return false;
      return true;
    };

    /** Handles one event. Returns false when the attempt should stop reading. */
    const handleEvent = async (event: SseEvent): Promise<boolean> => {
      if (event.data === null) return true;
      if (event.data.trim() === "[DONE]") {
        sawDone = true;
        return false;
      }
      let chunk: JsonObject | null;
      try {
        chunk = asObject(JSON.parse(event.data));
      } catch {
        chunk = null;
      }
      if (!chunk) return true;

      if (chunk.error) {
        const cause = classifyEmbeddedError(chunk, rt.now());
        if (committed) await failMidStream(cause);
        else result.classified = cause;
        return false;
      }

      if (typeof chunk.model === "string") result.returnedModel ??= chunk.model;
      result.usage = parseUsage(chunk.usage) ?? result.usage;
      const choice = firstChoice(chunk);
      extras?.capture(choice?.delta);
      if (choice?.finish_reason) sawFinish = true;
      result.outputChars += deltaChars(chunk);

      if (!committed) {
        if (!chunkHasOutput(chunk)) {
          held.push({ event, chunk });
          return true;
        }
        if (!(await commit(chunk))) {
          controller.abort(new AbortReason("client"));
          return false;
        }
      }
      if (isUsageOnly(chunk) && !ctx.wantsUsage) return true;
      if (!(await out.write(`${event.raw}\n\n`))) {
        controller.abort(new AbortReason("client"));
        return false;
      }
      return true;
    };

    try {
      const response = await rt.upstream.sendChat(account, body, {
        stream: true,
        signal: controller.signal,
      });
      result.httpStatus = response.status;

      if (response.status >= 400) {
        const text = await readLimited(response.body);
        result.classified = classifyHttpError(response.status, response.headers, text, rt.now());
        return result;
      }

      let keepReading = true;
      if (!headerString(response.headers["content-type"]).includes("text/event-stream")) {
        // Some gateways answer a stream request with one JSON document.
        const text = await response.body.text();
        let parsed: JsonObject | null = null;
        try {
          parsed = asObject(JSON.parse(text));
        } catch {
          parsed = null;
        }
        if (parsed?.error && !parsed.choices) {
          result.classified = classifyEmbeddedError(parsed, rt.now());
          return result;
        }
        if (!parsed || !Array.isArray(parsed.choices)) {
          result.classified = {
            outcome: "upstream_error",
            retryElsewhere: true,
            scope: "model",
            code: "invalid_response",
            message: "The upstream did not return a stream.",
          };
          return result;
        }
        for (const event of responseToEvents(parsed)) keepReading &&= await handleEvent(event);
      } else {
        const decoder = new SseDecoder();
        for await (const bytes of response.body) {
          if (committed) arm(streamIdleMs, "idle_timeout");
          for (const event of decoder.push(bytes)) {
            keepReading = await handleEvent(event);
            if (!keepReading) break;
          }
          if (!keepReading) break;
        }
        if (keepReading) {
          for (const event of decoder.flush()) {
            keepReading = await handleEvent(event);
            if (!keepReading) break;
          }
        }
        if (!keepReading) response.body.destroy();
      }

      if (controller.signal.aborted) {
        result.delivered = committed;
        result.classified = this.failureFromError(undefined, controller.signal);
        return result;
      }
      if (result.delivered) return result; // a stream error was already reported
      if (committed) {
        if (sawDone || sawFinish) {
          await out.write("data: [DONE]\n\n");
          out.endStream();
          result.delivered = true;
          result.classified = OK;
        } else {
          await failMidStream({
            outcome: "upstream_error",
            retryElsewhere: true,
            scope: "model",
            code: "stream_ended_early",
          });
        }
        return result;
      }
      if (result.classified.outcome === "upstream_error" && !result.classified.code) {
        result.classified = {
          ...result.classified,
          code: "empty_stream",
          message: "The upstream stream ended with no output.",
        };
      }
      return result;
    } catch (error) {
      const cause = this.failureFromError(error, controller.signal);
      if (committed && cause.outcome !== "client_aborted") {
        await failMidStream(cause);
      } else {
        result.delivered = committed;
        result.classified = cause;
      }
      return result;
    } finally {
      clearTimeout(timer);
      unlink();
    }
  }

  private async sendClientError(result: Classified, httpStatus: number | null): Promise<void> {
    const status = result.clientStatus ?? httpStatus ?? 400;
    this.finalStatus = status;
    const type = result.outcome === "refusal" ? "content_policy_error" : "invalid_request_error";
    await this.out.sendError(
      status,
      result.message || "The upstream rejected the request.",
      type,
      result.code ?? null,
      result.outcome === "context_overflow" ? "messages" : null,
      { "x-llmr-request-id": this.ctx.requestId },
    );
  }

  private async sendAllFailed(): Promise<void> {
    const { rt, plan, ctx, out } = this;
    const failedForCapacity = this.attempts.every((attempt) =>
      ["quota_exhausted", "billing", "rate_limited"].includes(attempt.outcome),
    );
    const retryTimes = plan.skipped
      .map((entry) => entry.retryAt)
      .concat(
        [...plan.steps, ...plan.skipped].map(({ target }) => {
          const state = rt.quota.check(target);
          return state.available ? undefined : state.retryAt;
        }),
      )
      .filter((value): value is number => value !== undefined);

    const capacityReasons = ["cooldown", "exhausted", "backoff", "probing", "budget"];
    const hasBlockedTargets =
      this.attempts.length > 0 ||
      plan.skipped.some((entry) => capacityReasons.includes(entry.reason));
    const headers: Record<string, string> = { "x-llmr-request-id": ctx.requestId };
    if (this.reasons.length > 0) headers["x-llmr-fallback"] = this.reasonList();
    const details =
      this.reasons.length > 0 ? ` Details: ${this.reasonList().replaceAll(",", ", ")}.` : "";

    if (hasBlockedTargets && failedForCapacity) {
      const earliest = retryTimes.length > 0 ? Math.min(...retryTimes) : rt.now() + 60_000;
      const retryAfter = Math.max(1, Math.ceil((earliest - rt.now()) / 1000));
      headers["retry-after"] = String(retryAfter);
      this.finalOutcome = this.attempts.length > 0 ? this.finalOutcome : "quota_exhausted";
      this.finalStatus = 429;
      await out.sendError(
        429,
        `All targets for this request are out of quota or budget.${details}`,
        "rate_limit_error",
        "all_targets_exhausted",
        null,
        headers,
      );
      return;
    }
    this.finalStatus = 502;
    await out.sendError(
      502,
      `No target could serve this request.${details}`,
      "router_error",
      "all_targets_failed",
      null,
      headers,
    );
  }

  private record(): void {
    const { rt, ctx, plan } = this;
    const finishedAt = rt.now();
    const step = this.servedStep;
    rt.persistence.saveLedger({
      request: {
        id: ctx.requestId,
        startedAt: ctx.startedAt,
        finishedAt,
        clientId: ctx.client.id,
        sessionHash: ctx.sessionKey,
        requestedModel: ctx.requestedModel.slice(0, 128),
        requestedTier: plan.requestedTier,
        servedTier: step?.target.tier ?? null,
        servedTarget: step?.target.id ?? null,
        stream: ctx.stream,
        outcome: this.finalOutcome,
        httpStatus: this.finalStatus,
        attemptCount: this.attempts.length,
      },
      attempts: this.attempts,
    });
    rt.log.info(
      {
        requestId: ctx.requestId,
        client: ctx.client.id,
        requested: ctx.requestedModel,
        target: step?.target.id ?? null,
        fallback: step?.isFallback ?? false,
        attempts: this.attempts.length,
        outcome: this.finalOutcome,
        status: this.finalStatus,
        durationMs: finishedAt - ctx.startedAt,
      },
      "request finished",
    );
  }
}
