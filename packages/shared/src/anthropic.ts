/** Header rules for traffic in Anthropic's Messages format. */

export type HeaderInput = Record<string, string | string[] | undefined>;

/** The value that marks a request as using a claude.ai login. */
const OAUTH_BETA = /^oauth-/i;
const CREDENTIAL_NAME =
  /(^|-)(authorization|auth|token|cookie|secret|password|credential|credentials|api-key|apikey|session-key)(-|$)/i;

export const isCredentialHeader = (name: string): boolean => CREDENTIAL_NAME.test(name);

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(",") : value;
}

/** Removes login-only values and leaves every other beta exactly as sent. */
export function withoutOauthBetas(value: string): string | null {
  const parts = value.split(",").map((part) => part.trim());
  if (!parts.some((part) => OAUTH_BETA.test(part))) return value;
  const kept = parts.filter((part) => part !== "" && !OAUTH_BETA.test(part));
  return kept.length > 0 ? kept.join(",") : null;
}

/**
 * The `anthropic-*` request headers that may leave the machine. New headers pass
 * through, because Claude Code adds them with each release; anything that looks
 * like a credential does not.
 */
export function anthropicRequestHeaders(incoming: HeaderInput): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(incoming)) {
    const name = rawName.toLowerCase();
    if (!name.startsWith("anthropic-") || isCredentialHeader(name)) continue;
    const value = single(rawValue);
    if (value === undefined) continue;
    if (name === "anthropic-beta") {
      const kept = withoutOauthBetas(value);
      if (kept !== null) headers[name] = kept;
    } else {
      headers[name] = value;
    }
  }
  return headers;
}

const RESPONSE_HEADERS = new Set(["request-id", "retry-after", "x-should-retry"]);

/** The upstream response headers that Claude Code and the SDKs read. */
export function anthropicResponseHeaders(upstream: HeaderInput): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(upstream)) {
    const name = rawName.toLowerCase();
    const wanted =
      RESPONSE_HEADERS.has(name) ||
      (name.startsWith("anthropic-") && name !== "anthropic-organization-id");
    const value = single(rawValue);
    if (wanted && value !== undefined) headers[name] = value;
  }
  return headers;
}
