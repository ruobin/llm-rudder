import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "llmr_session";
export const SESSION_MS = 7 * 24 * 60 * 60_000;

export interface SessionSecrets {
  sessionSecret: string;
  passwordHash: string;
}

/** Changing the password changes this key, which ends every existing session. */
const signingKey = ({ sessionSecret, passwordHash }: SessionSecrets) =>
  createHmac("sha256", sessionSecret).update(passwordHash).digest();

const sign = (secrets: SessionSecrets, body: string) =>
  createHmac("sha256", signingKey(secrets)).update(body).digest("base64url");

export function createSessionToken(secrets: SessionSecrets, now: number): string {
  const body = `${now + SESSION_MS}.${randomBytes(16).toString("base64url")}`;
  return `${body}.${sign(secrets, body)}`;
}

export function isValidSessionToken(
  token: string | undefined,
  secrets: SessionSecrets,
  now: number,
): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [expires, nonce, signature] = parts as [string, string, string];
  const expected = Buffer.from(sign(secrets, `${expires}.${nonce}`));
  const presented = Buffer.from(signature);
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return false;
  const expiresAt = Number(expires);
  return Number.isSafeInteger(expiresAt) && expiresAt > now;
}
