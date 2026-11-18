import { Agent, request as request_ } from "undici";
import type { AccountConfig, Config } from "../config/load.js";
import type { JsonObject } from "../types.js";
import type { HeaderBag } from "./classify.js";

export interface UpstreamResponse {
  status: number;
  headers: HeaderBag;
  body: AsyncIterable<Uint8Array> & { text(): Promise<string>; destroy(error?: Error): unknown };
}

export interface AnthropicRequest {
  /** "/v1/messages" or "/v1/messages/count_tokens". */
  path: string;
  /** Query string including the "?", or an empty string. */
  query: string;
  body: Buffer;
  /** `anthropic-*` headers from the client, already filtered. */
  headers: Record<string, string>;
  stream: boolean;
  signal: AbortSignal;
}

export interface ResponsesRequest {
  /** Replaces the account's API key, for accounts that sign in. */
  bearerToken?: string;
  body: Buffer;
  stream: boolean;
  signal: AbortSignal;
}

export interface UpstreamClient {
  sendChat(
    account: AccountConfig,
    body: JsonObject,
    options: { stream: boolean; signal: AbortSignal },
  ): Promise<UpstreamResponse>;
  sendAnthropic(account: AccountConfig, request: AnthropicRequest): Promise<UpstreamResponse>;
  sendResponses(account: AccountConfig, request: ResponsesRequest): Promise<UpstreamResponse>;
  close(): Promise<void>;
}

/** Sends requests to upstreams with one connection pool per origin. */
export class HttpUpstreamClient implements UpstreamClient {
  private readonly agent: Agent;

  constructor(
    private readonly config: Config,
    private readonly instanceId: string,
  ) {
    this.agent = new Agent({
      connect: { timeout: config.timeouts.connectMs },
      keepAliveTimeout: 30_000,
      connections: 128,
    });
  }

  async sendChat(
    account: AccountConfig,
    body: JsonObject,
    options: { stream: boolean; signal: AbortSignal },
  ): Promise<UpstreamResponse> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: options.stream ? "text/event-stream" : "application/json",
      "user-agent": "llm-rudder/0.1",
      "x-llmr-hop": this.instanceId,
    };
    if (account.apiKey) headers.authorization = `Bearer ${account.apiKey}`;

    const response = await request_(`${account.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
      dispatcher: this.agent,
      headersTimeout: this.config.timeouts.firstByteMs,
      // The executor applies its own commit and idle timers.
      bodyTimeout: 0,
    });
    return {
      status: response.statusCode,
      headers: response.headers,
      body: response.body as unknown as UpstreamResponse["body"],
    };
  }

  async sendResponses(
    account: AccountConfig,
    request: ResponsesRequest,
  ): Promise<UpstreamResponse> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: request.stream ? "text/event-stream" : "application/json",
      "user-agent": "llm-rudder/0.1",
    };
    const credential = request.bearerToken ?? account.apiKey;
    if (credential) headers.authorization = `Bearer ${credential}`;
    // A signed-in account always talks to OpenAI itself, so no loop is possible.
    if (!request.bearerToken) headers["x-llmr-hop"] = this.instanceId;
    const response = await request_(`${account.baseUrl}/responses`, {
      method: "POST",
      headers,
      body: request.body,
      signal: request.signal,
      dispatcher: this.agent,
      headersTimeout: this.config.timeouts.firstByteMs,
      bodyTimeout: 0,
    });
    return {
      status: response.statusCode,
      headers: response.headers,
      body: response.body as unknown as UpstreamResponse["body"],
    };
  }

  /** Sends a Messages request. Only this account's own key is ever attached. */
  async sendAnthropic(
    account: AccountConfig,
    request: AnthropicRequest,
  ): Promise<UpstreamResponse> {
    const headers: Record<string, string> = {
      "anthropic-version": "2023-06-01",
      ...request.headers,
      "content-type": "application/json",
      accept: request.stream ? "text/event-stream" : "application/json",
      "user-agent": "llm-rudder/0.1",
      "x-llmr-hop": this.instanceId,
    };
    if (account.apiKey) {
      if (account.authHeader === "bearer") headers.authorization = `Bearer ${account.apiKey}`;
      else headers["x-api-key"] = account.apiKey;
    }
    const response = await request_(`${account.baseUrl}${request.path}${request.query}`, {
      method: "POST",
      headers,
      body: request.body,
      signal: request.signal,
      dispatcher: this.agent,
      headersTimeout: this.config.timeouts.firstByteMs,
      bodyTimeout: 0,
    });
    return {
      status: response.statusCode,
      headers: response.headers,
      body: response.body as unknown as UpstreamResponse["body"],
    };
  }

  async close(): Promise<void> {
    await this.agent.close();
  }
}
