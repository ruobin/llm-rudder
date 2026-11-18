import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
  type DecipherGCM,
} from "node:crypto";

const MAGIC = Buffer.from("LLMRBK1\n");
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + SALT_BYTES + IV_BYTES;
const COST = 2 ** 15;
const MIN_PASSPHRASE_LENGTH = 16;

function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(
      `The backup passphrase must have at least ${MIN_PASSPHRASE_LENGTH} characters.`,
    );
  }
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, 32, { N: COST, r: 8, p: 1, maxmem: 256 * COST * 8 }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

type Bytes = AsyncIterable<Buffer | Uint8Array>;

/** Encrypts a stream with AES-256-GCM, using a key derived from the passphrase. */
export async function* sealBackup(input: Bytes, passphrase: string): AsyncGenerator<Buffer> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", await deriveKey(passphrase, salt), iv);
  yield Buffer.concat([MAGIC, salt, iv]);
  for await (const chunk of input) yield cipher.update(chunk);
  yield cipher.final();
  yield cipher.getAuthTag();
}

/**
 * Decrypts a sealed stream. The last step fails if the file was altered or the
 * passphrase is wrong, so treat the output as usable only after it succeeds.
 */
export async function* openBackup(input: Bytes, passphrase: string): AsyncGenerator<Buffer> {
  let pending: Buffer = Buffer.alloc(0);
  let decipher: DecipherGCM | null = null;
  for await (const chunk of input) {
    pending = Buffer.concat([pending, chunk]);
    if (!decipher) {
      if (pending.length < HEADER_BYTES) continue;
      if (!pending.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new Error("This is not an llm-rudder backup.");
      }
      const salt = pending.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
      const iv = pending.subarray(MAGIC.length + SALT_BYTES, HEADER_BYTES);
      decipher = createDecipheriv("aes-256-gcm", await deriveKey(passphrase, salt), iv);
      pending = pending.subarray(HEADER_BYTES);
    }
    // The last bytes may be the authentication tag, so they wait for the next chunk.
    if (pending.length > TAG_BYTES) {
      const ready = pending.length - TAG_BYTES;
      yield decipher.update(pending.subarray(0, ready));
      pending = pending.subarray(ready);
    }
  }
  if (!decipher || pending.length !== TAG_BYTES) throw new Error("The backup is incomplete.");
  decipher.setAuthTag(pending);
  try {
    yield decipher.final();
  } catch {
    throw new Error("The backup was altered, or the passphrase is wrong.");
  }
}
