import { profileFor } from "../config/models.js";
import type {
  Attempt,
  CompleteReply,
  StreamReader,
  StreamStep,
  UpstreamProtocol,
} from "../execution/protocol.js";
import type { RequestContext } from "../execution/context.js";
import type { Classified, Dialect, JsonObject, Usage } from "../types.js";
import { classifyAnthropicHttpError } from "../upstream/anthropic.js";
import { classifyHttpError, type HeaderBag } from "../upstream/classify.js";
import type { UpstreamResponse } from "../upstream/client.js";
import { buildUpstreamBody } from "../upstream/request.js";
import type { SseEvent } from "../upstream/sse.js";
import { StreamToolExtras } from "../upstream/tool-extras.js";
import {
  ChatStreamDecoder,
  ChatStreamEncoder,
  decodeChatRequest,
  decodeChatResponse,
  encodeChatRequest,
  encodeChatResponse,
} from "./chat.js";
import {
  chooseEffort,
  type ClientStreamEncoder,
  type EncodeTarget,
  type ResponseContext,
} from "./codec.js";
import {
  parseJsonObject,
  type IRRequest,
  type IRResponse,
  type IRStreamEvent,
  type ReasoningFamily,
} from "./ir.js";
import {
  decodeMessagesRequest,
  decodeMessagesResponse,
  encodeMessagesRequest,
  encodeMessagesResponse,
  MessagesStreamDecoder,
  MessagesStreamEncoder,
} from "./messages.js";
import { ToolNames } from "./names.js";
import {
  decodeResponsesRequest,
  decodeResponsesResponse,
  encodeResponsesRequest,
  encodeResponsesResponse,
  ResponsesStreamDecoder,
  ResponsesStreamEncoder,
} from "./responses.js";

interface StreamDecoder {
  push(event: SseEvent): IRStreamEvent[];
}

interface Codec {
  family: ReasoningFamily;
  decodeRequest(body: JsonObject): IRRequest;
  encodeRequest(ir: IRRequest, target: EncodeTarget, stream: boolean): JsonObject;
  decodeResponse(parsed: JsonObject, ctx: ResponseContext): IRResponse | Classified;
  encodeResponse(response: IRResponse, ctx: ResponseContext, notice: string | null): JsonObject;
  newDecoder(ctx: ResponseContext, attempt: Attempt): StreamDecoder;
  newEncoder(ctx: ResponseContext): ClientStreamEncoder;
  classifyHttpError(status: number, headers: HeaderBag, text: string, now: number): Classified;
  dispatch(
    attempt: Attempt,
    body: JsonObject,
    options: { stream: boolean; signal: AbortSignal },
  ): Promise<UpstreamResponse>;
}

const CODECS: Record<Dialect, Codec> = {
  "openai.chat": {
    family: "other",
    decodeRequest: decodeChatRequest,
    encodeRequest: encodeChatRequest,
    decodeResponse: decodeChatResponse,
    encodeResponse: encodeChatResponse,
    newDecoder(ctx, { rt, ctx: request, account }) {
      const extras = account.compat.toolExtras
        ? new StreamToolExtras(rt.toolExtras, request.client.id)
        : null;
      return new ChatStreamDecoder(ctx, (delta) => extras?.capture(delta));
    },
    newEncoder: (ctx) => new ChatStreamEncoder(ctx),
    classifyHttpError,
    dispatch({ rt, ctx, target, account }, body, { stream, signal }) {
      // The same step as for Chat clients: compatibility rules and Gemini signatures.
      const upstream = buildUpstreamBody(
        body,
        target,
        account,
        stream,
        ctx.client.id,
        rt.toolExtras,
      );
      return rt.upstream.sendChat(account, upstream, { stream, signal });
    },
  },
  "anthropic.messages": {
    family: "anthropic",
    decodeRequest: decodeMessagesRequest,
    encodeRequest: encodeMessagesRequest,
    decodeResponse: decodeMessagesResponse,
    encodeResponse: encodeMessagesResponse,
    newDecoder: (ctx) => new MessagesStreamDecoder(ctx),
    newEncoder: (ctx) => new MessagesStreamEncoder(ctx),
    classifyHttpError: classifyAnthropicHttpError,
    dispatch({ rt, account }, body, { stream, signal }) {
      return rt.upstream.sendAnthropic(account, {
        path: "/v1/messages",
        query: "",
        body: Buffer.from(JSON.stringify(body)),
        headers: {},
        stream,
        signal,
      });
    },
  },
  "openai.responses": {
    family: "openai",
    decodeRequest: decodeResponsesRequest,
    encodeRequest: encodeResponsesRequest,
    decodeResponse: decodeResponsesResponse,
    encodeResponse: encodeResponsesResponse,
    newDecoder: (ctx) => new ResponsesStreamDecoder(ctx),
    newEncoder: (ctx) => new ResponsesStreamEncoder(ctx),
    classifyHttpError,
    dispatch({ rt, account }, body, { stream, signal }) {
      return rt.upstream.sendResponses(account, {
        body: Buffer.from(JSON.stringify(body)),
        stream,
        signal,
      });
    },
  },
};

const decoded = new WeakMap<RequestContext, IRRequest>();

/** The request in common form. It is decoded once, however many targets are tried. */
export function requestIR(ctx: RequestContext): IRRequest {
  let ir = decoded.get(ctx);
  if (!ir) {
    ir = CODECS[ctx.dialect].decodeRequest(ctx.body);
    decoded.set(ctx, ir);
  }
  return ir;
}

export const familyOf = (dialect: Dialect): ReasoningFamily => CODECS[dialect].family;

function encodeTarget({ rt, ctx, target, account }: Attempt, ir: IRRequest): EncodeTarget {
  const profile = profileFor(rt.config.models, target.model);
  // A client's level is only sent to models known to accept reasoning settings.
  const requestedEffort = (profile.efforts ? ir.effort : undefined) ?? target.effort;
  const limit = profile.maxOutputTokens;
  const maxOutputTokens =
    ir.maxOutputTokens === undefined
      ? undefined
      : limit === undefined
        ? ir.maxOutputTokens
        : Math.min(ir.maxOutputTokens, limit);
  return {
    model: target.model,
    profile,
    names: new ToolNames(ir.tools),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(requestedEffort ? { effort: chooseEffort(requestedEffort, profile.efforts) } : {}),
    geminiSchemas: account.compat.schemaStyle === "gemini",
    autoCache: account.trust === "first_party",
    sessionKey: ctx.sessionKey,
    replay: (callId) =>
      rt.reasoning.get(ctx.client.id, callId, CODECS[account.api].family, account.id),
  };
}

function responseContext({ rt, ctx, target }: Attempt, ir: IRRequest): ResponseContext {
  return {
    names: new ToolNames(ir.tools),
    customTools: new Set(ir.tools.filter((tool) => tool.kind === "custom").map((t) => t.name)),
    now: rt.now(),
    requestedModel: ctx.requestedModel,
    servedModel: target.model,
    wantsUsage: ctx.wantsUsage,
    showReasoning:
      ctx.dialect === "openai.chat" ||
      (ctx.dialect === "openai.responses" && ir.reasoningSummary === true),
    inputEstimate: Math.ceil(ctx.bodyChars / 4),
  };
}

/** A model that called a tool finished for that reason, however it labels the stop. */
function normalizeResponse(response: IRResponse): IRResponse {
  const called = response.blocks.some((block) => block.type === "tool_call");
  return called && response.finish === "stop" ? { ...response, finish: "tool_calls" } : response;
}

function responseEvents(response: IRResponse): IRStreamEvent[] {
  const events: IRStreamEvent[] = [
    {
      type: "meta",
      ...(response.id ? { id: response.id } : {}),
      ...(response.model ? { model: response.model } : {}),
    },
  ];
  response.blocks.forEach((block, index) => {
    if (block.type === "text") events.push({ type: "text", text: block.text });
    else if (block.type === "tool_call") {
      events.push(
        {
          type: "tool_start",
          index,
          id: block.id,
          name: block.name,
          ...(block.namespace ? { namespace: block.namespace } : {}),
          kind: block.kind,
        },
        { type: "tool_delta", index, text: block.input },
        { type: "tool_end", index },
      );
    } else if (block.raw) {
      events.push({ type: "artifact", family: block.family, item: block.raw });
    }
  });
  if (response.usage) events.push({ type: "usage", usage: response.usage });
  events.push({ type: "finish", reason: response.finish }, { type: "done" });
  return events;
}

class TranslatingReader implements StreamReader {
  usage: Usage | null = null;
  returnedModel: string | null = null;
  outputChars = 0;
  finished = false;
  private queued: IRStreamEvent[] | null = null;
  private sawTool = false;
  private firstCallId: string | null = null;
  private readonly artifacts: JsonObject[] = [];
  private artifactFamily: ReasoningFamily = "other";

  constructor(
    private readonly attempt: Attempt,
    private readonly context: ResponseContext,
    private readonly decoder: StreamDecoder,
    private readonly encoder: ClientStreamEncoder,
    private readonly classify: (parsed: JsonObject) => IRResponse | Classified,
  ) {}

  private isVisible(event: IRStreamEvent): boolean {
    switch (event.type) {
      case "text":
      case "tool_start":
      case "tool_delta":
      case "tool_end":
      case "finish":
        return true;
      case "reasoning":
        return this.context.showReasoning;
      default:
        return false;
    }
  }

  read(event: SseEvent): StreamStep {
    const events = this.queued ?? this.decoder.push(event);
    this.queued = null;
    const visible: IRStreamEvent[] = [];
    let ended = false;
    for (const item of events) {
      switch (item.type) {
        case "error":
          return { kind: "failed", cause: item.cause };
        case "meta":
          if (item.model) this.returnedModel ??= item.model;
          break;
        case "usage":
          this.usage = item.usage;
          this.encoder.push(item);
          break;
        case "artifact":
          this.artifacts.push(item.item);
          this.artifactFamily = item.family;
          break;
        case "done":
          ended = true;
          this.finished = true;
          break;
        case "text":
          this.outputChars += item.text.length;
          visible.push(item);
          break;
        case "tool_delta":
          this.outputChars += item.text.length;
          visible.push(item);
          break;
        case "tool_start":
          this.sawTool = true;
          this.firstCallId ??= item.id;
          visible.push(item);
          break;
        case "finish":
          this.finished = true;
          visible.push(
            this.sawTool && item.reason === "stop" ? { ...item, reason: "tool_calls" } : item,
          );
          break;
        default:
          if (this.isVisible(item)) visible.push(item);
      }
    }
    if (visible.length > 0) {
      return {
        kind: "output",
        ...(ended ? { last: true } : {}),
        // Rendered after the commit, so a note can come before the first output.
        text: () => visible.map((item) => this.encoder.push(item)).join(""),
      };
    }
    return ended ? { kind: "end" } : { kind: "ignore" };
  }

  noticeEvent(text: string): string | null {
    return this.encoder.notice(text) || null;
  }

  closingText(): string {
    storeArtifacts(this.attempt, this.firstCallId, this.artifactFamily, this.artifacts);
    return this.encoder.close();
  }

  fromDocument(text: string): SseEvent[] | Classified {
    const parsed = parseJsonObject(text);
    if (!parsed) {
      return {
        outcome: "upstream_error",
        retryElsewhere: true,
        scope: "model",
        code: "invalid_response",
        message: "The upstream did not return a stream.",
      };
    }
    const response = this.classify(parsed);
    if ("outcome" in response) return response;
    this.queued = responseEvents(response);
    return [{ raw: "", data: "", event: null, isComment: false }];
  }
}

function storeArtifacts(
  { rt, ctx, account }: Attempt,
  callId: string | null,
  family: ReasoningFamily,
  items: JsonObject[],
): void {
  if (!callId || items.length === 0 || family === "other") return;
  rt.reasoning.set(ctx.client.id, callId, { family, accountId: account.id, items });
}

function translated(clientDialect: Dialect, upstreamDialect: Dialect): UpstreamProtocol {
  const client = CODECS[clientDialect];
  const upstream = CODECS[upstreamDialect];
  return {
    send(attempt, options) {
      const ir = requestIR(attempt.ctx);
      const body = upstream.encodeRequest(ir, encodeTarget(attempt, ir), options.stream);
      return upstream.dispatch(attempt, body, options);
    },
    classifyHttpError: upstream.classifyHttpError,
    readComplete(attempt, text): CompleteReply | Classified {
      const ir = requestIR(attempt.ctx);
      const context = responseContext(attempt, ir);
      const parsed = parseJsonObject(text);
      if (!parsed) {
        return {
          outcome: "upstream_error",
          retryElsewhere: true,
          scope: "model",
          code: "invalid_response",
          message: "The upstream response was not JSON.",
        };
      }
      const decodedResponse = upstream.decodeResponse(parsed, context);
      if ("outcome" in decodedResponse) return decodedResponse;
      const response = normalizeResponse(decodedResponse);
      if (attempt.account.compat.toolExtras) {
        const message = (parsed.choices as JsonObject[] | undefined)?.[0]?.message;
        attempt.rt.toolExtras.captureMessage(attempt.ctx.client.id, message);
      }
      const firstCall = response.blocks.find((block) => block.type === "tool_call");
      const artifacts = response.blocks.flatMap((block) =>
        block.type === "reasoning" && block.raw ? [block.raw] : [],
      );
      storeArtifacts(
        attempt,
        firstCall?.type === "tool_call" ? firstCall.id : null,
        upstream.family,
        artifacts,
      );
      return {
        usage: response.usage,
        returnedModel: response.model ?? null,
        outputChars: JSON.stringify(response.blocks).length,
        render: (notice) => JSON.stringify(client.encodeResponse(response, context, notice)),
      };
    },
    newStreamReader(attempt) {
      const ir = requestIR(attempt.ctx);
      const context = responseContext(attempt, ir);
      return new TranslatingReader(
        attempt,
        context,
        upstream.newDecoder(context, attempt),
        client.newEncoder(context),
        (parsed) => {
          const response = upstream.decodeResponse(parsed, context);
          return "outcome" in response ? response : normalizeResponse(response);
        },
      );
    },
    successHeaders: () => ({}),
    // The client speaks another format, so the error is rewritten in that format.
    forwardedError: () => null,
  };
}

const cache = new Map<string, UpstreamProtocol>();

export function translatedProtocol(client: Dialect, upstream: Dialect): UpstreamProtocol {
  const key = `${client}>${upstream}`;
  let protocol = cache.get(key);
  if (!protocol) {
    protocol = translated(client, upstream);
    cache.set(key, protocol);
  }
  return protocol;
}
