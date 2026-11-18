import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { openBackup, sealBackup } from "../src/backup.js";

const PASSPHRASE = "a long enough passphrase";

async function collect(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(part);
  return Buffer.concat(parts);
}

const pieces = (data: Buffer, size: number) => {
  const chunks: Buffer[] = [];
  for (let at = 0; at < data.length; at += size) chunks.push(data.subarray(at, at + size));
  return Readable.from(chunks);
};

describe("backup encryption", () => {
  const plain = randomBytes(100_000);

  it.each([1000, 7, 65_536])(
    "restores the data when read %i bytes at a time",
    async (size) => {
      const sealed = await collect(sealBackup(pieces(plain, 4096), PASSPHRASE));
      expect(sealed.includes(plain.subarray(0, 64))).toBe(false);
      expect(await collect(openBackup(pieces(sealed, size), PASSPHRASE))).toEqual(plain);
    },
    30_000,
  );

  it("handles an empty file", async () => {
    const sealed = await collect(sealBackup(Readable.from([]), PASSPHRASE));
    expect(await collect(openBackup(pieces(sealed, 9), PASSPHRASE))).toHaveLength(0);
  });

  it("refuses the wrong passphrase, altered data, truncation and other files", async () => {
    const sealed = await collect(sealBackup(pieces(plain, 4096), PASSPHRASE));
    await expect(
      collect(openBackup(pieces(sealed, 4096), "a different passphrase")),
    ).rejects.toThrow(/altered|passphrase/);
    const altered = Buffer.from(sealed);
    altered[altered.length - 100]! ^= 1;
    await expect(collect(openBackup(pieces(altered, 4096), PASSPHRASE))).rejects.toThrow(/altered/);
    await expect(
      collect(openBackup(pieces(sealed.subarray(0, 40), 8), PASSPHRASE)),
    ).rejects.toThrow(/incomplete/);
    await expect(collect(openBackup(pieces(Buffer.alloc(100), 10), PASSPHRASE))).rejects.toThrow(
      /not an llm-rudder/,
    );
  });

  it("refuses a short passphrase", async () => {
    await expect(collect(sealBackup(pieces(plain, 4096), "short"))).rejects.toThrow(/at least 16/);
  });
});
