import { scrypt, timingSafeEqual } from "node:crypto";

const MAX_COST = 2 ** 20;

/** Checks a password against "scrypt:N:r:p:salt:hash", with base64url salt and hash. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (![N, r, p].every(Number.isSafeInteger) || N < 2 || N > MAX_COST) return false;
  const salt = Buffer.from(parts[4] as string, "base64url");
  const expected = Buffer.from(parts[5] as string, "base64url");
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = await new Promise<Buffer | null>((resolve) => {
    scrypt(password, salt, expected.length, { N, r, p, maxmem: 256 * N * r }, (error, key) =>
      resolve(error ? null : key),
    );
  });
  return actual !== null && timingSafeEqual(actual, expected);
}
