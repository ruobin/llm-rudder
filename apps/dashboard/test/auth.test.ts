import { describe, expect, it } from "vitest";
import { hashPassword } from "../../gateway/src/auth/password";
import { niceMax, formatDuration, formatRelative, formatTime, formatUsd } from "@/lib/format";
import { LoginThrottle } from "@/lib/login-throttle";
import { verifyPassword } from "@/lib/password";
import { createSessionToken, isValidSessionToken, SESSION_MS } from "@/lib/session";

const secrets = { sessionSecret: "s".repeat(40), passwordHash: "scrypt:hash" };
const NOW = Date.parse("2026-11-18T12:00:00Z");

describe("passwords", () => {
  it("accepts the right password from the gateway's hash format", async () => {
    const encoded = await hashPassword("correct horse");
    expect(encoded).toMatch(/^scrypt:\d+:\d+:\d+:[\w-]+:[\w-]+$/);
    expect(encoded).not.toContain("$");
    expect(await verifyPassword("correct horse", encoded)).toBe(true);
    expect(await verifyPassword("wrong horse", encoded)).toBe(false);
  });

  it("rejects malformed or unreasonable hashes", async () => {
    for (const bad of [
      "",
      "plain",
      "scrypt:1:2:3",
      "md5:1:1:1:aa:bb",
      "scrypt:9999999999:8:1:aa:bb",
      "scrypt:1024:8:1::",
    ]) {
      expect(await verifyPassword("x", bad)).toBe(false);
    }
  });
});

describe("sessions", () => {
  it("accepts its own token until it expires", () => {
    const token = createSessionToken(secrets, NOW);
    expect(isValidSessionToken(token, secrets, NOW + 1000)).toBe(true);
    expect(isValidSessionToken(token, secrets, NOW + SESSION_MS)).toBe(false);
  });

  it("rejects missing, altered and foreign tokens", () => {
    const token = createSessionToken(secrets, NOW);
    const [expires, nonce, signature] = token.split(".") as [string, string, string];
    expect(isValidSessionToken(undefined, secrets, NOW)).toBe(false);
    expect(isValidSessionToken("a.b", secrets, NOW)).toBe(false);
    expect(isValidSessionToken(`${Number(expires) + 1}.${nonce}.${signature}`, secrets, NOW)).toBe(
      false,
    );
    expect(isValidSessionToken(`${expires}.${nonce}x.${signature}`, secrets, NOW)).toBe(false);
    expect(isValidSessionToken(token, { ...secrets, sessionSecret: "t".repeat(40) }, NOW)).toBe(
      false,
    );
  });

  it("ends every session when the password changes", () => {
    const token = createSessionToken(secrets, NOW);
    expect(isValidSessionToken(token, { ...secrets, passwordHash: "scrypt:other" }, NOW)).toBe(
      false,
    );
  });
});

describe("login throttle", () => {
  it("blocks an address after repeated failures and forgets them later", () => {
    let time = NOW;
    const throttle = new LoginThrottle(() => time);
    for (let i = 0; i < 5; i += 1) throttle.recordFailure("a");
    expect(throttle.isBlocked("a")).toBe(true);
    expect(throttle.isBlocked("b")).toBe(false);
    time += 15 * 60_000;
    expect(throttle.isBlocked("a")).toBe(false);
  });

  it("blocks everyone during a wide attack, and clears on success", () => {
    const throttle = new LoginThrottle(() => NOW);
    throttle.recordFailure("a");
    throttle.clear("a");
    expect(throttle.isBlocked("a")).toBe(false);
    for (let i = 0; i < 100; i += 1) throttle.recordFailure(`ip-${i}`);
    expect(throttle.isBlocked("fresh")).toBe(true);
  });
});

describe("formatting", () => {
  it("formats amounts, times and durations", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatDuration(null)).toBe("–");
    expect(formatDuration(250)).toBe("250 ms");
    expect(formatDuration(2500)).toBe("2.5 s");
    expect(formatDuration(125_000)).toBe("2 min 5 s");
    expect(formatTime("2026-11-18T12:34:56.000Z")).toBe("2026-11-18 12:34 UTC");
    expect(formatTime("nope")).toBe("–");
    expect(formatRelative("2026-11-18T12:30:00Z", NOW)).toBe("in 30 min");
    expect(formatRelative("2026-11-18T11:00:00Z", NOW)).toBe("1 h ago");
  });

  it("rounds chart maximums up", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(3)).toBe(5);
    expect(niceMax(1200)).toBe(2000);
    expect(niceMax(0.07)).toBeCloseTo(0.1);
  });
});
