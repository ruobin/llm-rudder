import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { dirname } from "node:path";
import { limitHeaders, type PlanSignal } from "./plan-limit.js";

const MAX_BYTES = 256 * 1024;

/** Keeps a local record of each 429 from the plan: rate-limit headers only. */
export class LimitSamples {
  constructor(private readonly file: string) {}

  record(at: number, headers: IncomingHttpHeaders, signal: PlanSignal): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      try {
        if (statSync(this.file).size > MAX_BYTES) renameSync(this.file, `${this.file}.old`);
      } catch {
        // The file does not exist yet.
      }
      const entry = { at: new Date(at).toISOString(), signal, headers: limitHeaders(headers) };
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch {
      // A recording failure must never affect a request.
    }
  }
}
