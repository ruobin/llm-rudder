import { dayPeriod } from "../billing/budgets.js";
import { costMicroUsd, estimateUsage, priceFor } from "../billing/pricing.js";
import { ChatGptError } from "../chatgpt/session.js";
import type { AccountConfig } from "../config/load.js";
import type { AttemptRecord } from "../ledger/records.js";
import type { Plan, PlanStep } from "../routing/plan.js";
import { estimateCost } from "../routing/plan.js";
import type { Runtime } from "../runtime.js";
import type { Classified, Dialect, Outcome, Usage } from "../types.js";
import { classifyTransportError, type HeaderBag } from "../upstream/classify.js";
import { SseDecoder, type SseEvent } from "../upstream/sse.js";
import type { ClientResponse } from "./client-response.js";
import type { RequestContext } from "./context.js";
import { canAddNotice, noticeText, reasonLabel } from "./notice.js";
import { openAiChat } from "./protocols/openai-chat.js";
import { anthropicMessages } from "./protocols/anthropic-messages.js";
import { openAiResponses } from "./protocols/openai-responses.js";
import {
  isClassified,
  type Attempt,
  type ClientProtocol,
  type UpstreamProtocol,
  type WireProtocol,
} from "./protocol.js";
import { translatedProtocol } from "../translate/protocol.js";

const OK: Classified = { outcome: "ok", retryElsewhere: false };
const MAX_ERROR_BODY_BYTES = 64 * 1024;
/** A throttle this short is worth waiting out, rather than moving the conversation. */
const MAX_HOLD_S = 10;
/** Plan entries that say nothing about whether a target has capacity. */
const NOT_CAPACITY_REASONS = new Set([
  "not_allowed",
  "disabled",
  "signed_out",
  "capability",
  "context",
]);
const PASSTHROUGH: Record<Dialect, WireProtocol> = {
  "openai.chat": openAiChat,
  "openai.responses": openAiResponses,
  "anthropic.messages": anthropicMessages,
};

/** The same format passes through. Any other pair goes through the translator. */
function upstreamProtocol(client: Dialect, account: AccountConfig): UpstreamProtocol {
  // The ChatGPT plan has its own request rules, so even Responses clients are rewritten.
  if (account.kind === "chatgpt_plan") return translatedProtocol(client, "chatgpt.plan");
  return client === account.api ? PASSTHROUGH[client] : translatedProtocol(client, account.api);
}

interface UpstreamFailure {
  status: number;
  headers: HeaderBag;
  text: string;
}

interface AttemptResult {
  /** Output reached the client, so no other target may be tried. */
  delivered: boolean;
  classified: Classified;
  /** The failure that should update quota state, when it differs. */
  stateUpdate?: Classified;
  httpStatus: number | null;
  failure?: UpstreamFailure;
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

export async function executeRequest(
  runtime: Runtime,
  ctx: RequestContext,
  plan: Plan,
  out: ClientResponse,
  client: ClientProtocol,
): Promise<void> {
  await new RequestRun(runtime, ctx, plan, out, client).run();
}

class RequestRun {
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
    private readonly client: ClientProtocol,
  ) {
    this.reasons = [
      ...(ctx.priorFailures ?? []),
      ...plan.skipped
        .filter((entry) => !NOT_CAPACITY_REASONS.has(entry.reason))
        .map((entry) => `${entry.target.accountId}:${entry.reason}`),
    ];
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
    let held = false;
    for (let index = 0; index < plan.steps.length; index += 1) {
      const step = plan.steps[index] as PlanStep;
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
      const attempt: Attempt = { rt, ctx, target, account };
      const upstream = upstreamProtocol(ctx.dialect, account);
      const result = ctx.stream
        ? await this.streamAttempt(step, attempt, upstream, startedAt)
        : await this.jsonAttempt(step, attempt, upstream, startedAt);

      const costs = this.costs(step, account, result);
      if (result.delivered) rt.budgets.settle(hold, costs.chargeMicroUsd);
      else rt.budgets.release(hold);

      const usage = costs.usage;
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
        inputTokens: usage?.inputTokens ?? null,
        cachedTokens: usage?.cachedTokens ?? null,
        cacheWriteTokens: usage
          ? (usage.cacheWrite5mTokens ?? 0) + (usage.cacheWrite1hTokens ?? 0)
          : null,
        outputTokens: usage?.outputTokens ?? null,
        usageComplete: result.usage !== null,
        costMicroUsd: costs.recordedCost,
        listMicroUsd: costs.listMicroUsd,
      });

      const outcome = result.classified.outcome;
      const waitS = result.classified.retryAfterS;
      if (
        !held &&
        !result.delivered &&
        outcome === "rate_limited" &&
        target.id === plan.pinnedTargetId &&
        waitS !== undefined &&
        waitS <= MAX_HOLD_S &&
        rt.now() + waitS * 1000 < ctx.deadlineAt
      ) {
        held = true;
        await this.hold(waitS);
        index -= 1;
        continue;
      }
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
        if (outcome === "ok" && plan.requestedTier !== null) {
          rt.pins.set(
            ctx.client.id,
            ctx.sessionKey,
            plan.requestedTier,
            target.id,
            plan.pinAtStart,
          );
        }
        return;
      }

      this.finalOutcome = outcome;
      this.finalStatus = result.httpStatus;
      if (outcome === "client_aborted") return;
      if (!result.classified.retryElsewhere) {
        await this.sendClientError(result, upstream);
        return;
      }
      this.reasons.push(`${target.accountId}:${outcome}`);
    }
    await this.sendAllFailed();
  }

  /** Waits, ending early if the client goes away. */
  private hold(seconds: number): Promise<void> {
    const { signal } = this.ctx;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, seconds * 1000);
      signal.addEventListener("abort", done, { once: true });
    });
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
    const { rt, ctx, plan, out, client } = this;
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
      client.supportsNotice &&
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
    if (error instanceof ChatGptError) return error.classified;
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
    attempt: Attempt,
    protocol: UpstreamProtocol,
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
      const response = await protocol.send(attempt, {
        stream: protocol.streamOnly === true,
        signal: controller.signal,
      });
      result.httpStatus = response.status;
      if (response.status >= 400) {
        const text = await response.body.text();
        result.classified = protocol.classifyHttpError(
          response.status,
          response.headers,
          text,
          rt.now(),
        );
        result.failure = { status: response.status, headers: response.headers, text };
        return result;
      }
      const reply =
        protocol.streamOnly && protocol.readStream
          ? await protocol.readStream(attempt, response.body, rt.now())
          : protocol.readComplete(attempt, await response.body.text(), rt.now());
      if (isClassified(reply)) {
        result.classified = reply;
        return result;
      }

      result.ttftMs = rt.now() - startedAt;
      result.returnedModel = reply.returnedModel;
      result.usage = reply.usage;
      result.outputChars = reply.outputChars;

      out.setHeaders(protocol.successHeaders(response.headers));
      const notice = this.onServed(step);
      await out.sendJson(200, reply.render(notice));
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
    attempt: Attempt,
    protocol: UpstreamProtocol,
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

    const reader = protocol.newStreamReader(attempt);
    const held: string[] = [];
    let committed = false;
    let upstreamHeaders: HeaderBag = {};

    const syncReader = () => {
      result.usage = reader.usage;
      result.returnedModel = reader.returnedModel;
      result.outputChars = reader.outputChars;
    };

    const failMidStream = async (cause: Classified) => {
      syncReader();
      result.delivered = true;
      result.classified = {
        ...cause,
        outcome: "mid_stream_failure",
        retryElsewhere: false,
        code: cause.code ?? "stream_interrupted",
      };
      result.stateUpdate = cause.retryElsewhere ? cause : result.classified;
      await out.sendError(
        cause.outcome === "overloaded" ? 529 : 502,
        "The upstream failed after output had started. Retry the request.",
        "upstream_error",
        "stream_interrupted",
      );
    };

    const commit = async (): Promise<boolean> => {
      committed = true;
      result.ttftMs = rt.now() - startedAt;
      arm(streamIdleMs, "idle_timeout");
      out.cancelDelayedStart();
      out.setHeaders(protocol.successHeaders(upstreamHeaders));
      const notice = this.onServed(step);
      out.startStream();
      for (const raw of held) {
        if (!(await out.write(`${raw}\n\n`))) return false;
      }
      const noticeEvent = notice ? reader.noticeEvent(notice) : null;
      return noticeEvent === null || out.write(noticeEvent);
    };

    /** Handles one event. Returns false when the attempt should stop reading. */
    const handleEvent = async (event: SseEvent): Promise<boolean> => {
      const next = reader.read(event);
      switch (next.kind) {
        case "ignore":
          return true;
        case "end":
          return false;
        case "failed":
          if (committed) await failMidStream(next.cause);
          else result.classified = next.cause;
          return false;
        case "pending":
          if (!committed) {
            if (next.keepUntilCommit) held.push(event.raw);
            return true;
          }
          break;
        case "output":
          if (!committed && !(await commit())) {
            controller.abort(new AbortReason("client"));
            return false;
          }
          break;
      }
      const text = next.kind === "output" && next.text ? next.text() : `${event.raw}\n\n`;
      if (text !== "" && !(await out.write(text))) {
        controller.abort(new AbortReason("client"));
        return false;
      }
      return !(next.kind === "output" && next.last);
    };

    try {
      const response = await protocol.send(attempt, { stream: true, signal: controller.signal });
      result.httpStatus = response.status;
      upstreamHeaders = response.headers;

      if (response.status >= 400) {
        const text = await readLimited(response.body);
        result.classified = protocol.classifyHttpError(
          response.status,
          response.headers,
          text,
          rt.now(),
        );
        result.failure = { status: response.status, headers: response.headers, text };
        return result;
      }

      let keepReading = true;
      if (!headerString(response.headers["content-type"]).includes("text/event-stream")) {
        // Some gateways answer a stream request with one JSON document.
        const events = reader.fromDocument(await response.body.text(), rt.now());
        if (!Array.isArray(events)) {
          result.classified = events;
          return result;
        }
        for (const event of events) keepReading &&= await handleEvent(event);
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
      syncReader();

      if (controller.signal.aborted) {
        result.delivered = committed;
        result.classified = this.failureFromError(undefined, controller.signal);
        return result;
      }
      if (result.delivered) return result; // a stream error was already reported
      if (committed) {
        if (reader.finished) {
          const closing = reader.closingText();
          if (closing !== null) await out.write(closing);
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
      syncReader();
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

  private async sendClientError(attempt: AttemptResult, protocol: UpstreamProtocol): Promise<void> {
    const { classified: result, httpStatus, failure } = attempt;
    const { out, ctx, client } = this;
    const status = result.clientStatus ?? httpStatus ?? 400;
    this.finalStatus = status;
    const requestHeader = { "x-llmr-request-id": ctx.requestId };

    const forwarded =
      failure && !out.started
        ? protocol.forwardedError(failure.status, failure.headers, failure.text)
        : null;
    if (forwarded) {
      out.setHeaders({ ...forwarded.headers, ...requestHeader });
      await out.sendBody(failure!.status, forwarded.body, forwarded.contentType);
      return;
    }

    const type = result.outcome === "refusal" ? "content_policy_error" : "invalid_request_error";
    const rejection = client.describeRejection?.(result);
    await out.sendError(
      status,
      rejection?.message ?? (result.message || "The upstream rejected the request."),
      type,
      result.code ?? null,
      result.outcome === "context_overflow" ? "messages" : null,
      { ...requestHeader, ...rejection?.headers },
    );
  }

  private async sendAllFailed(): Promise<void> {
    const { rt, plan, ctx, out, client } = this;
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
    const outcomes = this.attempts.map((attempt) => attempt.outcome);

    if (hasBlockedTargets && failedForCapacity) {
      const earliest = retryTimes.length > 0 ? Math.min(...retryTimes) : rt.now() + 60_000;
      const retryAfter = Math.max(1, Math.ceil((earliest - rt.now()) / 1000));
      headers["retry-after"] = String(retryAfter);
      this.finalOutcome = this.attempts.length > 0 ? this.finalOutcome : "quota_exhausted";
      const failure = client.allFailed(outcomes, true);
      this.finalStatus = failure.status;
      await out.sendError(
        failure.status,
        `All targets for this request are out of quota or budget.${details}`,
        "rate_limit_error",
        "all_targets_exhausted",
        null,
        { ...headers, ...failure.headers },
      );
      return;
    }
    const failure = client.allFailed(outcomes, false);
    this.finalStatus = failure.status;
    await out.sendError(
      failure.status,
      `No target could serve this request.${details}`,
      "router_error",
      "all_targets_failed",
      null,
      { ...headers, ...failure.headers },
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
