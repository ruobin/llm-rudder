import { randomUUID } from "node:crypto";

/** Shared facts about using a ChatGPT plan through Sign in with ChatGPT. */

export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const CHATGPT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "resource.invoke",
  CHATGPT_PLAN_SCOPE,
];
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
/** Sent to OpenAI as this app's name during first-time registration. */
export const CHATGPT_AGENT_NAME = "llm-rudder";
/** The gateway account a sign-in is sent to, unless you name another. */
export const CHATGPT_DEFAULT_ACCOUNT = "chatgpt-plan";

export interface ChatGptEndpoints {
  issuer: string;
  authorize: string;
  token: string;
  revoke: string;
  jwks: string;
  api: string;
}

type Env = Record<string, string | undefined>;

/** Tests may use a local server. Tokens can otherwise go only to OpenAI. */
function override(value: string | undefined, name: string): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error(`${name} may only point at 127.0.0.1.`);
  }
  return value.replace(/\/+$/, "");
}

export function chatGptEndpoints(env: Env = process.env): ChatGptEndpoints {
  const auth =
    override(env.LLMR_CHATGPT_AUTH_URL, "LLMR_CHATGPT_AUTH_URL") ?? "https://auth.openai.com";
  return {
    issuer: auth,
    authorize: `${auth}/api/accounts/authorize`,
    token: `${auth}/api/accounts/oauth/token`,
    revoke: `${auth}/api/accounts/oauth/revoke`,
    jwks: `${auth}/.well-known/jwks.json`,
    api: override(env.LLMR_CHATGPT_API_URL, "LLMR_CHATGPT_API_URL") ?? CHATGPT_RESOURCE,
  };
}

/** The saved result of a sign-in. It is a secret, except for `ext_agent_host_id`. */
export interface ChatGptCredential {
  email?: string;
  issuer: string;
  subject: string;
  client_id: string;
  ext_agent_host_id: string;
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scopes: string[];
  /** When this token set was received. */
  saved_at: string;
  /** Unix seconds, when the token endpoint gives one. */
  earliest_refresh_at?: number;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function parseChatGptCredential(value: unknown): ChatGptCredential | null {
  if (value === null || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const issuer = text(source.issuer);
  const subject = text(source.subject);
  const clientId = text(source.client_id);
  if (!issuer || !subject || !clientId) return null;
  const optional = (name: keyof ChatGptCredential) => {
    const item = text(source[name]);
    return item === undefined ? {} : { [name]: item };
  };
  return {
    issuer,
    subject,
    client_id: clientId,
    ext_agent_host_id: text(source.ext_agent_host_id) ?? "",
    scopes: Array.isArray(source.scopes)
      ? source.scopes.filter((scope): scope is string => typeof scope === "string")
      : [],
    saved_at: text(source.saved_at) ?? new Date(0).toISOString(),
    ...optional("email"),
    ...optional("id_token"),
    ...optional("access_token"),
    ...optional("refresh_token"),
    ...optional("token_type"),
    ...(typeof source.expires_in === "number" ? { expires_in: source.expires_in } : {}),
    ...(typeof source.earliest_refresh_at === "number"
      ? { earliest_refresh_at: source.earliest_refresh_at }
      : {}),
  };
}

/** Each computer gets its own opaque, stable identifier. */
export const newChatGptHostId = (): string => `urn:uuid:${randomUUID()}`;

/** When the access token stops working, in epoch milliseconds. */
export function accessTokenExpiry(credential: ChatGptCredential): number {
  return Date.parse(credential.saved_at) + (credential.expires_in ?? 0) * 1000;
}

/** What is kept once tokens are given up, so the same registration can sign in again. */
export function withoutChatGptTokens(
  credential: ChatGptCredential,
  options: { keepIdToken: boolean },
): ChatGptCredential {
  const kept = { ...credential };
  delete kept.access_token;
  delete kept.refresh_token;
  if (!options.keepIdToken) delete kept.id_token;
  return kept;
}

/** Ends the renewable session at OpenAI. Returns whether OpenAI confirmed it. */
export async function revokeChatGptSession(
  endpoints: ChatGptEndpoints,
  credential: ChatGptCredential,
  { attempts = 3, retryDelayMs = 1000 }: { attempts?: number; retryDelayMs?: number } = {},
): Promise<boolean> {
  if (!credential.refresh_token) return true;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(endpoints.revoke, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: credential.refresh_token,
          token_type_hint: "refresh_token",
          client_id: credential.client_id,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) return true;
      if (response.status < 500) return false;
    } catch {
      // A network failure is worth another try while the token is still here.
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }
  }
  return false;
}
