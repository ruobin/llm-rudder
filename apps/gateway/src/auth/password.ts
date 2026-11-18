import { randomBytes, scrypt } from "node:crypto";

const COST = 2 ** 15;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;

/** Hashes the dashboard password. The format contains no "$", which .env files would expand. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      salt,
      32,
      { N: COST, r: BLOCK_SIZE, p: PARALLELISM, maxmem: 256 * COST * BLOCK_SIZE },
      (error, derived) => (error ? reject(error) : resolve(derived)),
    );
  });
  return [
    "scrypt",
    COST,
    BLOCK_SIZE,
    PARALLELISM,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join(":");
}
