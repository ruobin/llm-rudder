import { Agent, request } from "undici";
import type { AccountConfig, Config } from "../config/load.js";
import type { JsonObject } from "../types.js";
import type { HeaderBag } from "./classify.js";

export interface UpstreamResponse {
  status: number;
  headers: HeaderBag;
  body: AsyncIterable<Uint8Array> & { text(): Promise<string>; destroy(error?: Error): unknown };
}

export interface UpstreamClient {
  sendChat(
    account: AccountConfig,
    body: JsonObject,
    options: { stream: boolean; signal: AbortSignal },
  ): Promise<UpstreamResponse>;
  close(): Promise<void>;
}

/** Sends requests to OpenAI-compatible upstreams with one pool per origin. */
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
      "user-agent": "llm-router/0.1",
      "x-llmr-hop": this.instanceId,
    };
    if (account.apiKey) headers.authorization = `Bearer ${account.apiKey}`;

    const response = await request(`${account.baseUrl}/chat/completions`, {
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

  async close(): Promise<void> {
    await this.agent.close();
  }
}
