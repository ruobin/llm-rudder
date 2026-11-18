import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChatGptCredential } from "@llm-rudder/shared";

interface ScriptedAnswer {
  status: number;
  body: unknown;
}

/** OpenAI's token endpoint as the gateway sees it, with rotating refresh tokens. */
export class FakeChatGptAuth {
  readonly refreshes: URLSearchParams[] = [];
  readonly revocations: URLSearchParams[] = [];
  /** Answers used before normal behavior resumes. */
  readonly answers: ScriptedAnswer[] = [];
  delayMs = 0;
  generation = 0;
  private server: Server | null = null;
  url = "";

  get refreshToken(): string {
    return `refresh-${this.generation}`;
  }

  get accessToken(): string {
    return `access-${this.generation}`;
  }

  /** The sign-in a laptop would send to the VPS. */
  credential(now: number, overrides: Partial<ChatGptCredential> = {}): ChatGptCredential {
    return {
      email: "person@example.com",
      issuer: this.url,
      subject: "user-1",
      client_id: "oaiapp_fake",
      ext_agent_host_id: "urn:uuid:00000000-0000-4000-8000-000000000000",
      id_token: "id-token",
      access_token: this.accessToken,
      refresh_token: this.refreshToken,
      token_type: "Bearer",
      expires_in: 3600,
      scopes: ["chatgpt.tokens.use.direct"],
      saved_at: new Date(now).toISOString(),
      ...overrides,
    };
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on("data", (part: Buffer) => parts.push(part));
      req.on("end", () => {
        const form = new URLSearchParams(Buffer.concat(parts).toString());
        const answer = this.answer(req.url ?? "", form);
        setTimeout(() => {
          res.writeHead(answer.status, { "content-type": "application/json" });
          res.end(JSON.stringify(answer.body));
        }, this.delayMs);
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  private answer(path: string, form: URLSearchParams): ScriptedAnswer {
    if (path.endsWith("/oauth/revoke")) {
      this.revocations.push(form);
      return { status: 200, body: {} };
    }
    this.refreshes.push(form);
    const scripted = this.answers.shift();
    if (scripted) return scripted;
    if (form.get("refresh_token") !== this.refreshToken) {
      return { status: 400, body: { error: "refresh_token_reused" } };
    }
    this.generation += 1;
    return {
      status: 200,
      body: {
        access_token: this.accessToken,
        refresh_token: this.refreshToken,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke",
      },
    };
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise((resolve) => this.server?.close(resolve));
  }
}
