import "server-only";
import type { SessionSecrets } from "./session";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

export const gatewayUrl = (): string =>
  (process.env.LLMR_GATEWAY_URL ?? "http://127.0.0.1:4141").replace(/\/+$/, "");
export const adminKey = (): string => required("LLMR_ADMIN_KEY");

export const sessionSecrets = (): SessionSecrets => ({
  sessionSecret: required("LLMR_DASHBOARD_SESSION_SECRET"),
  passwordHash: required("LLMR_DASHBOARD_PASSWORD_HASH"),
});

/** Cookies are HTTPS-only in production, unless explicitly turned off for local testing. */
export const secureCookies = (): boolean =>
  process.env.NODE_ENV === "production" && process.env.LLMR_DASHBOARD_INSECURE_COOKIE !== "1";
