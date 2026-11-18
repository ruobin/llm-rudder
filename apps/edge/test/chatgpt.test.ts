import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { chatGptEndpoints, CHATGPT_PLAN_SCOPE, type ChatGptEndpoints } from "@llm-rudder/shared";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activeCredential,
  ChatGptLoginError,
  describeCredential,
  localHostId,
  loginToChatGpt,
  pushCredential,
  remoteHostId,
  remoteLogout,
  signOut,
  type RemoteGateway,
} from "../src/chatgpt.js";
import { edgePaths, type EdgePaths } from "../src/paths.js";

const CLIENT = "oaiapp_issued";
const ALL_SCOPES = `openid profile email offline_access resource.invoke ${CHATGPT_PLAN_SCOPE}`;

/** OpenAI's sign-in service, with the parts each test may change. */
class FakeOpenAi {
  readonly authorizations: URL[] = [];
  readonly tokenForms: URLSearchParams[] = [];
  readonly revocations: URLSearchParams[] = [];
  callback: Record<string, string> = {};
  tokenAnswers: { status: number; body: unknown }[] = [];
  scope = ALL_SCOPES;
  subject = "user-1";
  claims: Record<string, unknown> = {};
  audience: string | null = null;
  expiresAt: number | null = null;
  signingKey: CryptoKey | null = null;
  revokeStatus = 200;
  url = "";
  private server: Server | null = null;
  private key!: CryptoKey;
  private jwk: unknown;

  async start(): Promise<this> {
    const pair = await generateKeyPair("RS256", { extractable: true });
    this.key = pair.privateKey;
    this.jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    this.server = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on("data", (part: Buffer) => parts.push(part));
      req.on("end", () => void this.handle(req.url ?? "/", Buffer.concat(parts).toString(), res));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this;
  }

  private async handle(path: string, body: string, res: ServerResponse): Promise<void> {
    const url = new URL(path, this.url);
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    };
    if (url.pathname === "/.well-known/jwks.json") return json(200, { keys: [this.jwk] });
    if (url.pathname.endsWith("/oauth/revoke")) {
      this.revocations.push(new URLSearchParams(body));
      res.writeHead(this.revokeStatus).end();
      return;
    }
    if (url.pathname.endsWith("/authorize")) {
      this.authorizations.push(url);
      const target = new URL(url.searchParams.get("redirect_uri")!);
      const isNew = url.searchParams.get("client_id") === "dynamic_agent_client";
      const values = {
        code: `code-${this.authorizations.length}`,
        state: url.searchParams.get("state")!,
        ...(isNew ? { client_id: CLIENT } : {}),
        ...this.callback,
      };
      for (const [name, value] of Object.entries(values)) target.searchParams.set(name, value);
      res.writeHead(302, { location: target.toString() }).end();
      return;
    }
    const form = new URLSearchParams(body);
    this.tokenForms.push(form);
    const scripted = this.tokenAnswers.shift();
    if (scripted) return json(scripted.status, scripted.body);
    const authorization = this.authorizations.at(-1)!;
    const idToken = await new SignJWT({
      nonce: authorization.searchParams.get("nonce"),
      email: "person@example.com",
      ...this.claims,
    })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(this.url)
      .setAudience(this.audience ?? form.get("client_id")!)
      .setSubject(this.subject)
      .setIssuedAt()
      .setExpirationTime(this.expiresAt ?? "1h")
      .sign(this.signingKey ?? this.key);
    json(200, {
      id_token: idToken,
      access_token: "ACCESS-SECRET",
      refresh_token: "REFRESH-SECRET",
      token_type: "Bearer",
      expires_in: 3600,
      scope: this.scope,
      earliest_refresh_at: 1_790_000_000,
    });
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise((resolve) => this.server?.close(resolve));
  }
}

let openai: FakeOpenAi;
let dir: string;
let paths: EdgePaths;
let endpoints: ChatGptEndpoints;
let printed: string[];
let browserError: unknown;

/** Follows the redirect back to the callback, as a browser would. */
const browser = (url: string) => {
  fetch(url)
    .then((response) => response.text())
    .catch((error: unknown) => (browserError = error));
};

const login = (options: { fresh?: boolean; hostId?: string; timeoutMs?: number } = {}) =>
  loginToChatGpt({
    paths,
    endpoints,
    openBrowser: browser,
    print: (text) => printed.push(text),
    port: 0,
    ...options,
  });

const authorization = (index = -1) => openai.authorizations.at(index)!.searchParams;

beforeEach(async () => {
  openai = await new FakeOpenAi().start();
  dir = mkdtempSync(join(tmpdir(), "llmr-edge-chatgpt-"));
  paths = edgePaths({ HOME: dir });
  endpoints = chatGptEndpoints({ LLMR_CHATGPT_AUTH_URL: openai.url });
  printed = [];
  browserError = undefined;
});

afterEach(async () => {
  await openai.stop();
  rmSync(dir, { recursive: true, force: true });
  expect(browserError).toBeUndefined();
});

describe("first sign-in", () => {
  it("registers this app and saves a private credential", async () => {
    const hostId = localHostId(paths);
    const credential = await login();
    const query = authorization();
    expect(Object.fromEntries(query)).toMatchObject({
      client_id: "dynamic_agent_client",
      agent_name_hint: "llm-rudder",
      ext_agent_host_id: hostId,
      response_type: "code",
      scope: ALL_SCOPES,
      resource: "https://api.openai.com/v1",
      code_challenge_method: "S256",
    });
    expect(query.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expect(query.has("id_token_hint")).toBe(false);

    const form = openai.tokenForms[0]!;
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("client_id")).toBe(CLIENT);
    expect(form.get("redirect_uri")).toBe(query.get("redirect_uri"));
    expect(form.get("resource")).toBe("https://api.openai.com/v1");
    expect(form.has("client_secret")).toBe(false);
    const challenge = createHash("sha256").update(form.get("code_verifier")!).digest("base64url");
    expect(challenge).toBe(query.get("code_challenge"));

    expect(credential).toMatchObject({
      email: "person@example.com",
      issuer: openai.url,
      subject: "user-1",
      client_id: CLIENT,
      ext_agent_host_id: hostId,
      access_token: "ACCESS-SECRET",
      refresh_token: "REFRESH-SECRET",
      expires_in: 3600,
      earliest_refresh_at: 1_790_000_000,
    });
    expect(activeCredential(paths)).toEqual(credential);

    const folder = join(dirname(paths.configFile), "chatgpt");
    expect(statSync(join(folder, `${CLIENT}.json`)).mode & 0o777).toBe(0o600);
    expect(statSync(join(folder, "host-id")).mode & 0o777).toBe(0o600);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
  });

  it("explains plan use once and never prints a token", async () => {
    await login();
    const output = printed.join("\n");
    expect(output).toContain("Continue with ChatGPT");
    expect(output).toContain("You're using your ChatGPT plan");
    expect(output).toContain("https://chatgpt.com/settings/usage");
    expect(output).not.toContain("SECRET");
    printed = [];
    await login();
    expect(printed.join("\n")).not.toContain("You're using your ChatGPT plan");
    expect(printed.join("\n")).not.toContain("id_token_hint");
    expect(describeCredential(activeCredential(paths))).not.toContain("SECRET");
  });

  it("keeps the same host ID for every sign-in", async () => {
    await login();
    const first = authorization().get("ext_agent_host_id");
    await login();
    expect(authorization().get("ext_agent_host_id")).toBe(first);
  });

  it("ignores requests to the callback that lack the right state", async () => {
    let answers: number[] = [];
    await loginToChatGpt({
      paths,
      endpoints,
      print: () => {},
      port: 0,
      openBrowser: (url) => {
        const callback = new URL(new URL(url).searchParams.get("redirect_uri")!);
        const forged = new URL(callback);
        forged.search = "error=access_denied&state=forged";
        const other = new URL("/favicon.ico", callback);
        void Promise.all([fetch(forged), fetch(other)])
          .then((responses) => (answers = responses.map((response) => response.status)))
          .then(() => browser(url));
      },
    });
    expect(answers).toEqual([404, 404]);
    expect(activeCredential(paths)!.refresh_token).toBe("REFRESH-SECRET");
  });
});

describe("signing in again", () => {
  beforeEach(async () => {
    await login();
  });

  it("reuses the registration and identifies the account", async () => {
    const before = activeCredential(paths)!;
    await login();
    const query = authorization();
    expect(query.get("client_id")).toBe(CLIENT);
    expect(query.has("agent_name_hint")).toBe(false);
    expect(query.get("id_token_hint")).toBe(before.id_token);
    expect(query.get("login_hint")).toBe("person@example.com");
    expect(query.has("prompt")).toBe(false);
    expect(openai.tokenForms.at(-1)!.get("client_id")).toBe(CLIENT);
  });

  it("uses fresh random values each time", async () => {
    await login();
    for (const name of ["state", "nonce", "code_challenge"]) {
      expect(authorization(0).get(name)).not.toBe(authorization(1).get(name));
    }
  });

  it("refuses a different client", async () => {
    const before = activeCredential(paths);
    openai.callback = { client_id: "oaiapp_other" };
    await expect(login()).rejects.toThrow(/different client/);
    expect(openai.tokenForms).toHaveLength(1);
    expect(activeCredential(paths)).toEqual(before);
  });

  it("refuses a different ChatGPT account", async () => {
    const before = activeCredential(paths);
    openai.subject = "user-2";
    await expect(login()).rejects.toThrow(/different ChatGPT account/);
    expect(activeCredential(paths)).toEqual(before);
  });

  it("adds a different account only when asked", async () => {
    openai.subject = "user-2";
    const second = await login({ fresh: true });
    expect(authorization().get("client_id")).toBe("dynamic_agent_client");
    expect(second.subject).toBe("user-2");
  });

  it("can sign in under the VPS's host ID", async () => {
    await login({ hostId: "urn:uuid:11111111-1111-4111-8111-111111111111" });
    expect(authorization().get("ext_agent_host_id")).toBe(
      "urn:uuid:11111111-1111-4111-8111-111111111111",
    );
  });
});

describe("sign-ins that must not succeed", () => {
  let lastError: unknown;
  const attempt = async () => {
    lastError = await login().then(
      () => new Error("signed in"),
      (error: unknown) => error,
    );
    expect(lastError).toBeInstanceOf(ChatGptLoginError);
    expect(activeCredential(paths)).toBeNull();
    return (lastError as Error).message;
  };

  it("stops when you decline", async () => {
    openai.callback = { error: "access_denied" };
    expect(await attempt()).toMatch(/declined/);
    expect(openai.tokenForms).toHaveLength(0);
  });

  it("stops when registration returns no client", async () => {
    openai.callback = { client_id: "" };
    expect(await attempt()).toMatch(/client ID/);
  });

  it("does not accept the placeholder client as a registration", async () => {
    openai.callback = { client_id: "dynamic_agent_client" };
    expect(await attempt()).toMatch(/client ID/);
  });

  it("rejects an ID token signed by someone else", async () => {
    openai.signingKey = (await generateKeyPair("RS256")).privateKey;
    expect(await attempt()).toMatch(/could not be verified/);
  });

  it("rejects an ID token from another issuer", async () => {
    endpoints = { ...endpoints, issuer: "https://auth.example.com" };
    expect(await attempt()).toMatch(/could not be verified/);
  });

  it("rejects an ID token issued to another client", async () => {
    openai.audience = "oaiapp_someone_else";
    expect(await attempt()).toMatch(/could not be verified/);
  });

  it("rejects an expired ID token", async () => {
    openai.expiresAt = Math.floor(Date.now() / 1000) - 3600;
    expect(await attempt()).toMatch(/could not be verified/);
  });

  it("rejects an ID token from another sign-in", async () => {
    openai.claims = { nonce: "someone-elses" };
    expect(await attempt()).toMatch(/different sign-in/);
  });

  it("rejects an incomplete token response", async () => {
    openai.tokenAnswers = [{ status: 200, body: { access_token: "x" } }];
    expect(await attempt()).toMatch(/incomplete/);
  });

  it("reports a failed exchange without details from the server", async () => {
    openai.tokenAnswers = [{ status: 500, body: { error: "server_error" } }];
    expect(await attempt()).toMatch(/server_error/);
  });

  it("gives up when the browser never returns", async () => {
    const message = await loginToChatGpt({
      paths,
      endpoints,
      openBrowser: () => {},
      print: () => {},
      port: 0,
      timeoutMs: 20,
    }).catch((error: Error) => error.message);
    expect(message).toMatch(/Timed out/);
  });
});

describe("recovering a sign-in", () => {
  it("restarts with the issued client after a rejected code", async () => {
    openai.tokenAnswers = [{ status: 400, body: { error: "invalid_grant" } }];
    const credential = await login();
    expect(openai.authorizations).toHaveLength(2);
    expect(authorization(0).get("client_id")).toBe("dynamic_agent_client");
    expect(authorization(1).get("client_id")).toBe(CLIENT);
    expect(authorization(1).has("agent_name_hint")).toBe(false);
    expect(credential.refresh_token).toBe("REFRESH-SECRET");
  });

  it("stops after a second rejected code", async () => {
    const rejected = { status: 400, body: { error: "invalid_grant" } };
    openai.tokenAnswers = [rejected, rejected];
    await expect(login()).rejects.toThrow(/did not accept/);
    expect(openai.authorizations).toHaveLength(2);
  });

  it("keeps the registration when plan use is not granted, then asks again", async () => {
    openai.scope = "openid profile email";
    await expect(login()).rejects.toThrow(/not allowed/);
    const kept = activeCredential(paths)!;
    expect(kept.client_id).toBe(CLIENT);
    expect(kept.access_token).toBeUndefined();
    expect(kept.refresh_token).toBeUndefined();

    openai.scope = ALL_SCOPES;
    const credential = await login();
    expect(authorization().get("prompt")).toBe("consent");
    expect(authorization().get("client_id")).toBe(CLIENT);
    expect(authorization().get("scope")).toBe(ALL_SCOPES);
    expect(credential.scopes).toContain(CHATGPT_PLAN_SCOPE);
  });
});

describe("the VPS", () => {
  const HOST = "urn:uuid:22222222-2222-4222-8222-222222222222";
  let calls: { target: string; command: string; input: string | undefined }[];
  let remote: RemoteGateway;

  beforeEach(() => {
    calls = [];
    remote = {
      target: "root@vps.example.com",
      directory: "/srv/it's here",
      account: "chatgpt-plan",
      run: async (target, command, input) => {
        calls.push({ target, command, input });
        return command.includes("host-id") ? `${HOST}\n` : "done\n";
      },
    };
  });

  it("sends the sign-in over SSH without this computer's host ID", async () => {
    await login();
    const local = localHostId(paths);
    await pushCredential(paths, remote);

    const [call] = calls;
    expect(call!.target).toBe("root@vps.example.com");
    expect(call!.command).toBe(
      `cd '/srv/it'\\''s here' && docker compose exec -T gateway node dist/cli.js chatgpt import --account 'chatgpt-plan'`,
    );
    expect(call!.command).not.toContain("SECRET");
    const sent = JSON.parse(call!.input!) as Record<string, unknown>;
    expect(sent).toMatchObject({ client_id: CLIENT, refresh_token: "REFRESH-SECRET" });
    expect(sent).not.toHaveProperty("ext_agent_host_id");
    expect(call!.input).not.toContain(local);
  });

  it("gives up its own tokens, keeping what a later sign-in needs", async () => {
    await login();
    await pushCredential(paths, remote);
    const kept = activeCredential(paths)!;
    expect(kept.access_token).toBeUndefined();
    expect(kept.refresh_token).toBeUndefined();
    expect(kept.client_id).toBe(CLIENT);
    expect(kept.id_token).toBeTruthy();
    const stored = readFileSync(
      join(dirname(paths.configFile), "chatgpt", `${CLIENT}.json`),
      "utf8",
    );
    expect(stored).not.toContain("SECRET");
    await expect(pushCredential(paths, remote)).rejects.toThrow(/no sign-in to send/);
  });

  it("keeps its tokens if the transfer fails", async () => {
    await login();
    remote.run = async () => {
      throw new ChatGptLoginError("ssh failed");
    };
    await expect(pushCredential(paths, remote)).rejects.toThrow("ssh failed");
    expect(activeCredential(paths)!.refresh_token).toBe("REFRESH-SECRET");
  });

  it("reads the VPS's host ID and rejects anything else", async () => {
    expect(await remoteHostId(remote)).toBe(HOST);
    remote.run = async () => "Welcome to the server";
    await expect(remoteHostId(remote)).rejects.toThrow(/host ID/);
  });

  it("refuses an SSH target that could be read as an option", async () => {
    expect(() => remoteLogout({ ...remote, target: "-oProxyCommand=evil" })).toThrow(/not valid/);
    expect(() => remoteLogout({ ...remote, target: "a b" })).toThrow(/not valid/);
    expect(calls).toHaveLength(0);
  });
});

describe("signing out", () => {
  it("revokes the session and clears every token", async () => {
    await login();
    expect(await signOut(paths, endpoints)).toBe(true);
    const form = openai.revocations[0]!;
    expect(form.get("token")).toBe("REFRESH-SECRET");
    expect(form.get("token_type_hint")).toBe("refresh_token");
    expect(form.get("client_id")).toBe(CLIENT);
    const kept = activeCredential(paths)!;
    expect(kept.access_token).toBeUndefined();
    expect(kept.refresh_token).toBeUndefined();
    expect(kept.id_token).toBeUndefined();
    expect(kept.client_id).toBe(CLIENT);

    await login();
    expect(authorization().has("id_token_hint")).toBe(false);
    expect(authorization().get("client_id")).toBe(CLIENT);
  });

  it("still clears the tokens when OpenAI refuses, and says so", async () => {
    await login();
    openai.revokeStatus = 400;
    expect(await signOut(paths, endpoints)).toBe(false);
    expect(openai.revocations).toHaveLength(1);
    expect(activeCredential(paths)!.refresh_token).toBeUndefined();
  });

  it("does nothing when nobody is signed in", async () => {
    expect(await signOut(paths, endpoints)).toBe(true);
    expect(openai.revocations).toHaveLength(0);
  });
});
