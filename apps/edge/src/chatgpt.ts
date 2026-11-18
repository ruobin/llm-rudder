import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import {
  accessTokenExpiry,
  CHATGPT_AGENT_NAME,
  CHATGPT_PLAN_SCOPE,
  CHATGPT_RESOURCE,
  CHATGPT_SCOPES,
  CHATGPT_USAGE_URL,
  newChatGptHostId,
  parseChatGptCredential,
  revokeChatGptSession,
  withoutChatGptTokens,
  type ChatGptCredential,
  type ChatGptEndpoints,
} from "@llm-router/shared";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { readJsonFile, writePrivateFile } from "./files.js";
import type { EdgePaths } from "./paths.js";

const PREFERRED_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const CLOCK_TOLERANCE_S = 60;
const MAX_AUTHORIZATIONS = 2;
const SSH_TARGET = /^[A-Za-z0-9][A-Za-z0-9._@:-]*$/;
const HOST_ID = /^urn:uuid:[0-9a-f-]{36}$/i;

export const DEFAULT_VPS_DIR = "/opt/llm-router";

export class ChatGptLoginError extends Error {}

/** OpenAI refused the code, so the sign-in has to start again. */
class CodeRejectedError extends ChatGptLoginError {}

const randomValue = () => randomBytes(32).toString("base64url");
const challengeFor = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

const storeDir = (paths: EdgePaths) => join(dirname(paths.configFile), "chatgpt");
const credentialFile = (paths: EdgePaths, clientId: string) =>
  join(storeDir(paths), `${clientId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
const activeFile = (paths: EdgePaths) => join(storeDir(paths), "active");
const hostIdFile = (paths: EdgePaths) => join(storeDir(paths), "host-id");

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** This computer's identifier, created before its first sign-in and then kept. */
export function localHostId(paths: EdgePaths): string {
  const existing = readText(hostIdFile(paths));
  if (existing) return existing;
  const created = newChatGptHostId();
  writePrivateFile(hostIdFile(paths), `${created}\n`);
  return created;
}

export function activeCredential(paths: EdgePaths): ChatGptCredential | null {
  const clientId = readText(activeFile(paths));
  return clientId ? parseChatGptCredential(readJsonFile(credentialFile(paths, clientId))) : null;
}

function saveCredential(paths: EdgePaths, credential: ChatGptCredential): void {
  writePrivateFile(
    credentialFile(paths, credential.client_id),
    `${JSON.stringify(credential, null, 2)}\n`,
  );
  writePrivateFile(activeFile(paths), `${credential.client_id}\n`);
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/** Waits for the browser to return to this computer. */
async function startCallback(port: number, expectedState: string) {
  let finish: (params: URLSearchParams) => void = () => {};
  const received = new Promise<URLSearchParams>((resolve) => (finish = resolve));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // Anything else on this port, such as a favicon request, is not the callback.
    if (url.pathname !== CALLBACK_PATH || url.searchParams.get("state") !== expectedState) {
      res.writeHead(404).end();
      return;
    }
    res
      .writeHead(200, { "content-type": "text/plain; charset=utf-8", connection: "close" })
      .end("You can close this tab and return to your terminal.");
    finish(url.searchParams);
  });
  let bound: number;
  try {
    bound = await listen(server, port);
  } catch {
    // Only the port of the callback address may vary.
    bound = await listen(server, 0);
  }
  return {
    redirectUri: `http://127.0.0.1:${bound}${CALLBACK_PATH}`,
    received,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ChatGptLoginError("Timed out waiting for the browser.")),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface LoginOptions {
  paths: EdgePaths;
  endpoints: ChatGptEndpoints;
  openBrowser(url: string): void;
  print(text: string): void;
  /** Register a new ChatGPT account instead of reusing the saved one. */
  fresh?: boolean;
  /** The VPS's own host ID, when signing in again on its behalf. */
  hostId?: string;
  port?: number;
  timeoutMs?: number;
  now?: () => number;
}

interface Authorization {
  previous: ChatGptCredential | null;
  hostId: string;
  /** Null until OpenAI has issued one for this registration. */
  clientId: string | null;
  onClientIssued(clientId: string): void;
}

async function exchangeCode(
  endpoints: ChatGptEndpoints,
  fields: { clientId: string; code: string; verifier: string; redirectUri: string },
): Promise<Record<string, unknown>> {
  const response = await fetch(endpoints.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: fields.clientId,
      code: fields.code,
      code_verifier: fields.verifier,
      redirect_uri: fields.redirectUri,
      resource: CHATGPT_RESOURCE,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const tokens = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.ok) return tokens;
  if (tokens.error === "invalid_grant") {
    throw new CodeRejectedError("OpenAI did not accept the sign-in code.");
  }
  const reason = typeof tokens.error === "string" ? tokens.error : `HTTP ${response.status}`;
  throw new ChatGptLoginError(`The token exchange failed: ${reason}.`);
}

async function verifyIdToken(
  idToken: string,
  endpoints: ChatGptEndpoints,
  clientId: string,
  nonce: string,
  now: number,
): Promise<JWTPayload & { sub: string }> {
  let claims: JWTPayload;
  try {
    const verified = await jwtVerify(idToken, createRemoteJWKSet(new URL(endpoints.jwks)), {
      issuer: endpoints.issuer,
      audience: clientId,
      algorithms: ["RS256"],
      clockTolerance: CLOCK_TOLERANCE_S,
      currentDate: new Date(now),
    });
    claims = verified.payload;
  } catch {
    throw new ChatGptLoginError("OpenAI's identity token could not be verified.");
  }
  if (claims.nonce !== nonce) {
    throw new ChatGptLoginError("The identity token belongs to a different sign-in.");
  }
  if (!claims.sub) throw new ChatGptLoginError("The identity token names no account.");
  return claims as JWTPayload & { sub: string };
}

async function authorize(
  options: LoginOptions,
  { previous, hostId, clientId: knownClient, onClientIssued }: Authorization,
): Promise<ChatGptCredential> {
  const { paths, endpoints, print } = options;
  const now = options.now ?? Date.now;
  const state = randomValue();
  const nonce = randomValue();
  const verifier = randomValue();
  const callback = await startCallback(options.port ?? PREFERRED_PORT, state);

  try {
    const query = new URLSearchParams({
      client_id: knownClient ?? "dynamic_agent_client",
      ext_agent_host_id: hostId,
      response_type: "code",
      redirect_uri: callback.redirectUri,
      scope: CHATGPT_SCOPES.join(" "),
      resource: CHATGPT_RESOURCE,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: challengeFor(verifier),
    });
    if (!knownClient) query.set("agent_name_hint", CHATGPT_AGENT_NAME);
    if (previous?.email) query.set("login_hint", previous.email);
    // Plan use was declined earlier, so OpenAI has to ask again.
    if (previous && !previous.scopes.includes(CHATGPT_PLAN_SCOPE)) query.set("prompt", "consent");
    // The ID token hint must not appear on screen or in a log.
    const printable = `${endpoints.authorize}?${query}`;
    if (previous?.id_token) query.set("id_token_hint", previous.id_token);

    print(`Continue with ChatGPT in your browser. If it did not open, visit:\n${printable}\n`);
    options.openBrowser(`${endpoints.authorize}?${query}`);

    const params = await withTimeout(callback.received, options.timeoutMs ?? LOGIN_TIMEOUT_MS);
    const error = params.get("error");
    if (error === "access_denied") {
      throw new ChatGptLoginError("ChatGPT plan access was declined, so nothing was changed.");
    }
    if (error) throw new ChatGptLoginError(`Sign-in failed: ${error}.`);

    const returnedClient = params.get("client_id");
    if (knownClient && returnedClient && returnedClient !== knownClient) {
      throw new ChatGptLoginError("OpenAI returned a different client, so nothing was changed.");
    }
    const clientId = knownClient ?? returnedClient;
    if (!clientId || clientId === "dynamic_agent_client") {
      throw new ChatGptLoginError("Registration did not return a client ID.");
    }
    onClientIssued(clientId);
    const code = params.get("code");
    if (!code) throw new ChatGptLoginError("The sign-in response had no code.");

    const tokens = await exchangeCode(endpoints, {
      clientId,
      code,
      verifier,
      redirectUri: callback.redirectUri,
    });
    const { id_token: idToken, access_token: accessToken, refresh_token: refreshToken } = tokens;
    if (
      typeof idToken !== "string" ||
      typeof accessToken !== "string" ||
      typeof refreshToken !== "string"
    ) {
      throw new ChatGptLoginError("The token response was incomplete.");
    }

    const claims = await verifyIdToken(idToken, endpoints, clientId, nonce, now());
    if (previous && previous.subject !== claims.sub) {
      throw new ChatGptLoginError(
        "You signed in to a different ChatGPT account. Use --new to add it.",
      );
    }

    const scopes = String(tokens.scope ?? "")
      .split(" ")
      .filter(Boolean);
    const credential: ChatGptCredential = {
      ...(typeof claims.email === "string" ? { email: claims.email } : {}),
      issuer: endpoints.issuer,
      subject: claims.sub,
      client_id: clientId,
      ext_agent_host_id: hostId,
      id_token: idToken,
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: typeof tokens.token_type === "string" ? tokens.token_type : "Bearer",
      expires_in: typeof tokens.expires_in === "number" ? tokens.expires_in : 3600,
      scopes,
      saved_at: new Date(now()).toISOString(),
      ...(typeof tokens.earliest_refresh_at === "number"
        ? { earliest_refresh_at: tokens.earliest_refresh_at }
        : {}),
    };

    if (!scopes.includes(CHATGPT_PLAN_SCOPE)) {
      // The registration is kept, so allowing plan use later reuses this client.
      saveCredential(paths, withoutChatGptTokens(credential, { keepIdToken: true }));
      throw new ChatGptLoginError(
        "ChatGPT plan use was not allowed. Run this again and allow it to use your plan.",
      );
    }
    saveCredential(paths, credential);
    if (!previous) {
      print(
        "You're using your ChatGPT plan. Requests served by this account count against it.\n" +
          `Manage usage and this app's limit: ${CHATGPT_USAGE_URL}`,
      );
    }
    return credential;
  } finally {
    callback.close();
  }
}

/** Signs in through the browser, following OpenAI's flow for open-source apps. */
export async function loginToChatGpt(options: LoginOptions): Promise<ChatGptCredential> {
  const previous = options.fresh ? null : activeCredential(options.paths);
  const hostId = options.hostId ?? localHostId(options.paths);
  let clientId = previous?.client_id ?? null;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await authorize(options, {
        previous,
        hostId,
        clientId,
        onClientIssued: (issued) => (clientId = issued),
      });
    } catch (error) {
      if (!(error instanceof CodeRejectedError) || attempt >= MAX_AUTHORIZATIONS) throw error;
      options.print("OpenAI did not accept that sign-in, so it is starting again.");
    }
  }
}

/** Runs a command on the VPS and returns what it printed. */
export type RemoteRunner = (target: string, command: string, input?: string) => Promise<string>;

/** Uses SSH, so the input only ever travels over its encrypted connection. */
export const sshRunner: RemoteRunner = (target, command, input = "") =>
  new Promise((resolve, reject) => {
    const child = spawn("ssh", [target, command], { stdio: ["pipe", "pipe", "inherit"] });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (part: string) => (output += part));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(output)
        : reject(new ChatGptLoginError(`The command on the VPS failed (exit code ${code}).`)),
    );
    child.stdin.end(input);
  });

export interface RemoteGateway {
  target: string;
  directory: string;
  account: string;
  run?: RemoteRunner;
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

function runOnGateway(remote: RemoteGateway, args: string, input?: string): Promise<string> {
  if (!SSH_TARGET.test(remote.target)) throw new ChatGptLoginError("That SSH target is not valid.");
  const command =
    `cd ${shellQuote(remote.directory)} && docker compose exec -T gateway ` +
    `node dist/cli.js chatgpt ${args} --account ${shellQuote(remote.account)}`;
  return (remote.run ?? sshRunner)(remote.target, command, input);
}

/** Reads the VPS's host ID, creating it there if this is its first use. */
export async function remoteHostId(remote: RemoteGateway): Promise<string> {
  const hostId = (await runOnGateway(remote, "host-id")).trim();
  if (!HOST_ID.test(hostId)) throw new ChatGptLoginError("The VPS did not return a host ID.");
  return hostId;
}

export const remoteStatus = (remote: RemoteGateway) => runOnGateway(remote, "status");
export const remoteLogout = (remote: RemoteGateway) => runOnGateway(remote, "logout");

/**
 * Moves the sign-in to the VPS, which owns refreshes from then on. Refresh tokens
 * rotate, so this computer gives up its tokens and keeps what a later sign-in needs.
 */
export async function pushCredential(paths: EdgePaths, remote: RemoteGateway): Promise<void> {
  const credential = activeCredential(paths);
  if (!credential?.refresh_token) {
    throw new ChatGptLoginError("There is no sign-in to send. Run: llmr-edge chatgpt login");
  }
  // The VPS keeps its own host ID, so this computer's is not sent.
  const portable: Partial<ChatGptCredential> = { ...credential };
  delete portable.ext_agent_host_id;
  await runOnGateway(remote, "import", JSON.stringify(portable));
  saveCredential(paths, withoutChatGptTokens(credential, { keepIdToken: true }));
}

/** Ends the session held on this computer. */
export async function signOut(paths: EdgePaths, endpoints: ChatGptEndpoints): Promise<boolean> {
  const credential = activeCredential(paths);
  if (!credential) return true;
  const revoked = await revokeChatGptSession(endpoints, credential);
  saveCredential(paths, withoutChatGptTokens(credential, { keepIdToken: false }));
  return revoked;
}

export function describeCredential(credential: ChatGptCredential | null): string {
  if (!credential) return "Not signed in to ChatGPT on this computer.";
  const where = credential.refresh_token
    ? `held on this computer, access token valid until ${new Date(accessTokenExpiry(credential)).toISOString()}`
    : "no tokens on this computer (sent to the VPS, signed out, or plan use not allowed)";
  return `ChatGPT account ${credential.email ?? credential.subject}: ${where}.`;
}

export function openInBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  execFile(command, [url], () => {
    // The address is also printed, in case no browser can be opened.
  });
}
