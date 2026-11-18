import { createHash, randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Creates a ULID: 26 characters, sortable by creation time. */
export function ulid(now: number = Date.now()): string {
  let time = "";
  let remaining = now;
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }
  let random = "";
  for (const byte of randomBytes(16)) {
    random += CROCKFORD[byte % 32];
  }
  return time + random;
}

export function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
