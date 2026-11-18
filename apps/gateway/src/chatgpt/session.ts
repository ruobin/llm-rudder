import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  accessTokenExpiry,
  CHATGPT_RESOURCE,
  CHATGPT_USAGE_URL,
  newChatGptHostId,
  parseChatGptCredential,
  withoutChatGptTokens,
  type ChatGptCredential,
  type ChatGptEndpoints,
} from "@llm-router/shared";
import type { Classified } from "../types.js";

const REFRESH_BEFORE_EXPIRY_MS = 5 * 60_000;
const EXPIRY_SAFETY_MS = 30_000;
const FILE_CHECK_INTERVAL_MS = 5000;
/** Also keeps an idle session alive, since reading the list needs a current token. */
const MODEL_LIST_MAX_AGE_MS = 6 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

/** These mean the saved tokens can never work again. */
const UNUSABLE_TOKEN_CODES = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

export const SIGN_IN_COMMAND = "llmr-edge chatgpt login --for user@your-vps";

const chatGptDir = (stateDir: string) => join(stateDir, "chatgpt");
export const credentialPath = (stateDir: string, accountId: string) =>
  join(chatGptDir(stateDir), `${accountId}.json`);

export function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

/** This machine's own identifier, kept across every sign-in. */
export function ensureHostId(stateDir: string): string {
  const path = join(chatGptDir(stateDir), "host-id");
  const read = () => {
    try {
      return readFileSync(path, "utf8").trim();
    } catch {
      return "";
    }
  };
  const existing = read();
  if (existing) return existing;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, `${newChatGptHostId()}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return read();
}

/** Saves a transferred sign-in under this machine's host ID. */
export function importCredential(
  stateDir: string,
  accountId: string,
  value: unknown,
): ChatGptCredential {
  const hostId = ensureHostId(stateDir);
  const parsed = parseChatGptCredential(value);
  if (!parsed?.refresh_token) throw new Error("That is not a usable ChatGPT sign-in.");
  const credential = { ...parsed, ext_agent_host_id: hostId };
  writePrivateJson(credentialPath(stateDir, accountId), credential);
  return credential;
}

export function readCredential(path: string): ChatGptCredential | null {
  try {
    return parseChatGptCredential(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/** A failure the router treats like an answer from the upstream. */
export class ChatGptError extends Error {
  constructor(readonly classified: Classified) {
    super(classified.message ?? classified.code ?? "ChatGPT plan error");
  }
}

const signInRequired = (code: string) =>
  new ChatGptError({
    outcome: "auth",
    retryElsewhere: true,
    scope: "account",
    code,
    message: `The ChatGPT sign-in needs renewing. Run: ${SIGN_IN_COMMAND}`,
  });

const refreshUnavailable = (code: string) =>
  new ChatGptError({
    outcome: "upstream_error",
    retryElsewhere: true,
    scope: "model",
    code,
    message: "The ChatGPT sign-in could not be renewed right now.",
  });

export type ChatGptSessionState = "ok" | "signed_out" | "auth_required";

export interface ChatGptSessionOptions {
  file: string;
  endpoints: ChatGptEndpoints;
  now: () => number;
  /** The saved sign-in stopped working, and only you can replace it. */
  onSignInRequired(code: string): void;
  /** A new sign-in was copied here while the gateway was running. */
  onSignedIn(): void;
  onWarning(message: string): void;
}

const NOT_READ = -1;

/** Holds one ChatGPT sign-in on the VPS, which alone renews its tokens. */
export class ChatGptSession {
  private credential: ChatGptCredential | null = null;
  private state: ChatGptSessionState = "signed_out";
  private fileVersion = NOT_READ;
  private checkedAt = -Infinity;
  private refreshing: Promise<string> | null = null;
  /** Every model the plan offers, or null until the list has been read. */
  private models: Set<string> | null = null;
  /** The models OpenAI intends to be shown to people. */
  private listedModels: string[] = [];
  private modelsAt = -Infinity;

  constructor(private readonly options: ChatGptSessionOptions) {}

  private currentFileVersion(): number {
    try {
      return statSync(this.options.file).mtimeMs;
    } catch {
      return 0;
    }
  }

  /** Picks up a sign-in that was copied here, or removed, by another process. */
  private sync(force = false): void {
    const now = this.options.now();
    if (!force && now - this.checkedAt < FILE_CHECK_INTERVAL_MS) return;
    this.checkedAt = now;
    const version = this.currentFileVersion();
    if (version === this.fileVersion) return;
    const firstRead = this.fileVersion === NOT_READ;
    this.fileVersion = version;
    this.credential = version === 0 ? null : readCredential(this.options.file);
    this.models = null;
    this.listedModels = [];
    this.modelsAt = -Infinity;
    const hasTokens = Boolean(this.credential?.refresh_token || this.credential?.access_token);
    this.state = hasTokens ? "ok" : "signed_out";
    if (hasTokens && !firstRead) this.options.onSignedIn();
  }

  private save(credential: ChatGptCredential): void {
    this.credential = credential;
    try {
      writePrivateJson(this.options.file, credential);
      this.fileVersion = this.currentFileVersion();
    } catch {
      // The newest token stays in memory, and the next change tries to save it again.
      this.options.onWarning("the ChatGPT sign-in could not be saved");
    }
  }

  get usable(): boolean {
    this.sync();
    return this.state === "ok";
  }

  /** Until the plan's list has been read, every model is worth trying. */
  hasModel(model: string): boolean {
    return this.models === null || this.models.has(model);
  }

  private isCurrent(credential: ChatGptCredential): boolean {
    return (
      Boolean(credential.access_token) &&
      this.options.now() < accessTokenExpiry(credential) - EXPIRY_SAFETY_MS
    );
  }

  /** Returns a working access token, renewing it first when needed. */
  async accessToken(): Promise<string> {
    this.sync(true);
    const credential = this.credential;
    if (this.state !== "ok" || !credential) throw signInRequired("auth_required");
    const now = this.options.now();
    const current = this.isCurrent(credential);
    const nearExpiry = now >= accessTokenExpiry(credential) - REFRESH_BEFORE_EXPIRY_MS;
    const mayRefresh =
      credential.earliest_refresh_at === undefined || now >= credential.earliest_refresh_at * 1000;
    if (current && !(nearExpiry && mayRefresh && credential.refresh_token)) {
      return credential.access_token as string;
    }
    try {
      return await this.refresh();
    } catch (error) {
      // A token that still works is better than failing over a brief refresh problem.
      const temporary = (error as ChatGptError).classified?.outcome === "upstream_error";
      if (current && temporary) return credential.access_token as string;
      throw error;
    }
  }

  /** Returns a different token after OpenAI rejected this one. */
  async replacementFor(rejected: string): Promise<string> {
    this.sync(true);
    const credential = this.credential;
    if (this.state !== "ok" || !credential) throw signInRequired("auth_required");
    if (credential.access_token !== rejected && this.isCurrent(credential)) {
      return credential.access_token as string;
    }
    return this.refresh();
  }

  /** Refresh tokens rotate, so only one refresh may ever be in flight. */
  private refresh(): Promise<string> {
    this.refreshing ??= this.performRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private requireSignIn(code: string, options: { keepTokens: boolean }): ChatGptError {
    if (this.credential && !options.keepTokens) {
      this.save(withoutChatGptTokens(this.credential, { keepIdToken: true }));
    }
    this.state = "auth_required";
    this.options.onSignInRequired(code);
    return signInRequired(code);
  }

  private async performRefresh(): Promise<string> {
    const credential = this.credential as ChatGptCredential;
    const refreshToken = credential.refresh_token;
    if (!refreshToken) throw this.requireSignIn("no_refresh_token", { keepTokens: true });

    let response: Response;
    let body: Record<string, unknown>;
    try {
      response = await fetch(this.options.endpoints.token, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: credential.client_id,
          refresh_token: refreshToken,
          resource: CHATGPT_RESOURCE,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    } catch {
      throw refreshUnavailable("refresh_unreachable");
    }

    // A new sign-in that arrived meanwhile replaces this whole session.
    this.sync(true);
    const latest = this.credential;
    if (latest && latest.refresh_token !== refreshToken && latest.access_token) {
      return latest.access_token;
    }

    if (response.ok && typeof body.access_token === "string") {
      this.save({
        ...credential,
        access_token: body.access_token,
        refresh_token: typeof body.refresh_token === "string" ? body.refresh_token : refreshToken,
        ...(typeof body.id_token === "string" ? { id_token: body.id_token } : {}),
        expires_in: typeof body.expires_in === "number" ? body.expires_in : 3600,
        ...(typeof body.scope === "string"
          ? { scopes: body.scope.split(" ").filter(Boolean) }
          : {}),
        saved_at: new Date(this.options.now()).toISOString(),
        ...(typeof body.earliest_refresh_at === "number"
          ? { earliest_refresh_at: body.earliest_refresh_at }
          : {}),
      });
      return body.access_token;
    }

    const error = body.error;
    const nested = typeof error === "object" && error ? (error as { code?: unknown }).code : error;
    const code = String(nested ?? body.code ?? `http_${response.status}`);
    if (UNUSABLE_TOKEN_CODES.has(code)) throw this.requireSignIn(code, { keepTokens: false });
    // The tokens may be fine, but this client can no longer use them.
    if (code === "invalid_client") throw this.requireSignIn(code, { keepTokens: true });
    throw refreshUnavailable(code);
  }

  private fetchModels(token: string): Promise<Response> {
    return fetch(`${this.options.endpoints.api}/models`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  private async loadModels(): Promise<void> {
    const token = await this.accessToken();
    let response = await this.fetchModels(token);
    if (response.status === 401)
      response = await this.fetchModels(await this.replacementFor(token));
    if (!response.ok) {
      this.options.onWarning(`the ChatGPT model list returned HTTP ${response.status}`);
      return;
    }
    const body = (await response.json()) as {
      models?: { slug?: unknown; visibility?: unknown }[];
    };
    const models = (Array.isArray(body.models) ? body.models : []).filter(
      (model): model is { slug: string; visibility?: unknown } => typeof model.slug === "string",
    );
    if (models.length === 0) return;
    this.models = new Set(models.map((model) => model.slug));
    this.listedModels = models
      .filter((model) => model.visibility === "list")
      .map((model) => model.slug);
    this.modelsAt = this.options.now();
  }

  /** Keeps the model list current, which also keeps an idle session renewed. */
  async maintain(): Promise<void> {
    this.sync(true);
    if (this.state !== "ok") return;
    if (this.options.now() - this.modelsAt < MODEL_LIST_MAX_AGE_MS) return;
    try {
      await this.loadModels();
    } catch (error) {
      this.options.onWarning(`ChatGPT session upkeep failed: ${(error as Error).message}`);
    }
  }

  /** Details for the status page. It contains no tokens and no account details. */
  status() {
    this.sync(true);
    const credential = this.credential;
    return {
      state: this.state,
      usingPlan: this.state === "ok",
      manageUsage: CHATGPT_USAGE_URL,
      ...(credential?.access_token
        ? { accessTokenExpiresAt: new Date(accessTokenExpiry(credential)).toISOString() }
        : {}),
      ...(credential ? { renewedAt: credential.saved_at } : {}),
      ...(this.listedModels.length > 0 ? { models: this.listedModels } : {}),
    };
  }
}
