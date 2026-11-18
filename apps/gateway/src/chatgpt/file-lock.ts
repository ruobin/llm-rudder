import { open, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export class FileLockBusyError extends Error {}

export interface FileLockOptions {
  /** A lock this old was left by a process that died. */
  staleMs: number;
  /** How long to wait for another process to finish. */
  waitMs: number;
}

const POLL_MS = 100;

async function acquire(path: string, { staleMs, waitMs }: FileLockOptions): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const file = await open(path, "wx", 0o600);
      await file.close();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const held = await stat(path).catch(() => null);
    if (held && Date.now() - held.mtimeMs > staleMs) {
      // Only one waiter can move the file, so only one takes over a dead holder's lock.
      const abandoned = `${path}.${randomUUID()}`;
      const moved = await rename(path, abandoned).then(
        () => true,
        () => false,
      );
      if (moved) await rm(abandoned, { force: true });
      continue;
    }
    if (Date.now() >= deadline) throw new FileLockBusyError(`${path} is in use.`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Runs a task while no other process that shares this file can run one. */
export async function withFileLock<T>(
  path: string,
  options: FileLockOptions,
  task: () => Promise<T>,
): Promise<T> {
  await acquire(path, options);
  try {
    return await task();
  } finally {
    await rm(path, { force: true });
  }
}
