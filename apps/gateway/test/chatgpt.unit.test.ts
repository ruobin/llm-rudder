import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chatGptEndpoints } from "@llm-rudder/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ChatGptError,
  ChatGptSession,
  credentialPath,
  ensureHostId,
  importCredential,
  readCredential,
} from "../src/chatgpt/session.js";
import { FileLockBusyError, withFileLock } from "../src/chatgpt/file-lock.js";
import { FakeChatGptAuth } from "../src/dev/fake-chatgpt.js";
import { QuotaManager } from "../src/state/quota.js";
import type { Classified, Target } from "../src/types.js";
import {
  classifyChatGptHttpError,
  classifyEmbeddedError,
  upstreamRequestId,
} from "../src/upstream/classify.js";

const HOUR = 3_600_000;
const ACCOUNT = "chatgpt-plan";

let auth: FakeChatGptAuth;
let dir: string;
let time: number;
let signInRequests: string[];
let signedIn: number;
let warnings: string[];

const file = () => credentialPath(dir, ACCOUNT);

function newSession(api = "http://127.0.0.1:9/v1") {
  return new ChatGptSession({
    file: file(),
    endpoints: chatGptEndpoints({ LLMR_CHATGPT_AUTH_URL: auth.url, LLMR_CHATGPT_API_URL: api }),
    now: () => time,
    onSignInRequired: (code) => signInRequests.push(code),
    onSignedIn: () => (signedIn += 1),
    onWarning: (message) => warnings.push(message),
  });
}

beforeEach(async () => {
  time = Date.parse("2026-11-18T00:00:00Z");
  dir = mkdtempSync(join(tmpdir(), "llmr-session-"));
  auth = await new FakeChatGptAuth().start();
  signInRequests = [];
  signedIn = 0;
  warnings = [];
  importCredential(dir, ACCOUNT, auth.credential(time));
});

afterEach(async () => {
  await auth.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("the VPS's copy of the sign-in", () => {
  it("is private and keeps the VPS's own host ID", () => {
    const hostId = ensureHostId(dir);
    expect(hostId).toMatch(/^urn:uuid:/);
    const credential = importCredential(dir, ACCOUNT, {
      ...auth.credential(time),
      ext_agent_host_id: "urn:uuid:laptop",
    });
    expect(credential.ext_agent_host_id).toBe(hostId);
    expect(readCredential(file())!.ext_agent_host_id).toBe(hostId);
    expect(ensureHostId(dir)).toBe(hostId);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "chatgpt")).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "chatgpt", "host-id")).mode & 0o777).toBe(0o600);
  });

  it("creates the host ID even for a sign-in it then refuses", () => {
    rmSync(join(dir, "chatgpt"), { recursive: true });
    expect(() => importCredential(dir, ACCOUNT, { issuer: "x" })).toThrow(/usable/);
    expect(readFileSync(join(dir, "chatgpt", "host-id"), "utf8")).toMatch(/^urn:uuid:/);
  });
});

describe("several instances sharing one sign-in", () => {
  it("renews it only once when they all need a new token", async () => {
    const instances = [newSession(), newSession(), newSession()];
    time += HOUR;
    auth.delayMs = 40;
    const tokens = await Promise.all(instances.map((session) => session.accessToken()));
    expect(auth.refreshes).toHaveLength(1);
    expect(new Set(tokens)).toEqual(new Set(["access-1"]));
    expect(signedIn).toBe(0);
    expect(existsSync(`${file()}.lock`)).toBe(false);
  });

  it("uses another instance's renewal without treating it as a new sign-in", async () => {
    const first = newSession();
    const second = newSession();
    expect(await second.accessToken()).toBe("access-0");
    time += HOUR;
    expect(await first.accessToken()).toBe("access-1");

    expect(await second.accessToken()).toBe("access-1");
    expect(auth.refreshes).toHaveLength(1);
    expect(signedIn).toBe(0);
  });

  it("still notices a new sign-in copied over a renewed one", async () => {
    const first = newSession();
    const second = newSession();
    await second.accessToken();
    time += HOUR;
    await first.accessToken();
    await second.accessToken();

    importCredential(dir, ACCOUNT, auth.credential(time));
    await second.accessToken();
    expect(signedIn).toBe(1);
  });

  it("takes over a lock left behind by a process that died", async () => {
    const lock = `${file()}.lock`;
    writeFileSync(lock, "");
    const longAgo = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, longAgo, longAgo);
    const session = newSession();
    time += HOUR;
    expect(await session.accessToken()).toBe("access-1");
    expect(existsSync(lock)).toBe(false);
  });
});

describe("the file lock", () => {
  const options = { staleMs: 60_000, waitMs: 2_000 };

  it("lets one task run at a time", async () => {
    const lock = join(dir, "test.lock");
    let running = 0;
    let most = 0;
    const task = async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 15));
      running -= 1;
    };
    await Promise.all(Array.from({ length: 4 }, () => withFileLock(lock, options, task)));
    expect(most).toBe(1);
    expect(existsSync(lock)).toBe(false);
  });

  it("gives up when another process holds it for too long", async () => {
    const lock = join(dir, "test.lock");
    writeFileSync(lock, "");
    await expect(
      withFileLock(lock, { staleMs: 60_000, waitMs: 20 }, async () => "ran"),
    ).rejects.toBeInstanceOf(FileLockBusyError);
  });

  it("is released when the task fails", async () => {
    const lock = join(dir, "test.lock");
    await expect(
      withFileLock(lock, options, async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    expect(await withFileLock(lock, options, async () => "ran")).toBe("ran");
  });
});

describe("token renewal", () => {
  it("runs unattended for over a week with rotating tokens", async () => {
    const session = newSession(`${auth.url}/v1`);
    const start = time;
    let requests = 0;
    while (time - start < 8 * 24 * HOUR) {
      await session.maintain();
      // Traffic comes in bursts, with long idle stretches between them.
      if ((time - start) % (24 * HOUR) < 2 * HOUR) {
        expect(await session.accessToken()).toBe(auth.accessToken);
        requests += 1;
      }
      time += 15 * 60_000;
    }
    expect(requests).toBeGreaterThan(50);
    expect(auth.refreshes.length).toBeGreaterThan(30);
    expect(signInRequests).toEqual([]);
    expect(session.usable).toBe(true);
    expect(readCredential(file())).toMatchObject({
      access_token: auth.accessToken,
      refresh_token: auth.refreshToken,
    });
  });

  it("saves the rotated tokens together, privately", async () => {
    time += HOUR;
    expect(await newSession().accessToken()).toBe("access-1");
    expect(readCredential(file())).toMatchObject({
      access_token: "access-1",
      refresh_token: "refresh-1",
      saved_at: new Date(time).toISOString(),
    });
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it("renews a little before expiry, but not before OpenAI allows it", async () => {
    importCredential(dir, ACCOUNT, {
      ...auth.credential(time),
      earliest_refresh_at: Math.floor((time + 2 * HOUR) / 1000),
    });
    const session = newSession();
    time += HOUR - 4 * 60_000;
    expect(await session.accessToken()).toBe("access-0");
    expect(auth.refreshes).toHaveLength(0);

    importCredential(dir, ACCOUNT, auth.credential(time - HOUR + 4 * 60_000));
    expect(await session.accessToken()).toBe("access-1");
  });

  it("keeps using a valid token when an early renewal fails", async () => {
    const session = newSession();
    time += HOUR - 4 * 60_000;
    auth.answers.push({ status: 503, body: {} });
    expect(await session.accessToken()).toBe("access-0");
    expect(signInRequests).toEqual([]);
  });

  it("does not spend a refresh when another request already got a new token", async () => {
    const session = newSession();
    time += HOUR;
    const fresh = await session.accessToken();
    expect(await session.replacementFor("access-0")).toBe(fresh);
    expect(auth.refreshes).toHaveLength(1);
  });

  it("lets a new sign-in win over a refresh that was in flight", async () => {
    const session = newSession();
    time += HOUR;
    auth.delayMs = 60;
    const pending = session.accessToken();
    await new Promise((resolve) => setTimeout(resolve, 15));
    importCredential(
      dir,
      ACCOUNT,
      auth.credential(time, { access_token: "newer", refresh_token: "newer-r" }),
    );
    expect(await pending).toBe("newer");
    expect(readCredential(file())).toMatchObject({ refresh_token: "newer-r" });
  });

  it.each([
    "invalid_grant",
    "invalid_refresh_token",
    "token_expired",
    "refresh_token_expired",
    "refresh_token_invalidated",
    "refresh_token_reused",
  ])("clears the tokens after %s", async (code) => {
    const session = newSession();
    time += HOUR;
    auth.answers.push({ status: 400, body: { error: code } });
    await expect(session.accessToken()).rejects.toBeInstanceOf(ChatGptError);
    expect(signInRequests).toEqual([code]);
    const saved = readCredential(file())!;
    expect(saved.access_token).toBeUndefined();
    expect(saved.refresh_token).toBeUndefined();
    expect(saved.id_token).toBe("id-token");
    expect(session.status().state).toBe("auth_required");
    expect(session.usable).toBe(false);
  });

  it("reads an error code nested in an error object", async () => {
    const session = newSession();
    time += HOUR;
    auth.answers.push({ status: 401, body: { error: { code: "refresh_token_reused" } } });
    await expect(session.accessToken()).rejects.toBeInstanceOf(ChatGptError);
    expect(signInRequests).toEqual(["refresh_token_reused"]);
  });

  it("keeps the tokens when the client itself is the problem", async () => {
    const session = newSession();
    time += HOUR;
    auth.answers.push({ status: 401, body: { error: "invalid_client" } });
    await expect(session.accessToken()).rejects.toBeInstanceOf(ChatGptError);
    expect(signInRequests).toEqual(["invalid_client"]);
    expect(readCredential(file())!.refresh_token).toBe("refresh-0");
    expect(session.usable).toBe(false);
  });

  it("keeps the tokens when the token service cannot be reached", async () => {
    const session = newSession();
    time += HOUR;
    await auth.stop();
    await expect(session.accessToken()).rejects.toMatchObject({
      classified: { outcome: "upstream_error", code: "refresh_unreachable" },
    });
    await auth.start();
    expect(signInRequests).toEqual([]);
    expect(readCredential(file())!.refresh_token).toBe("refresh-0");
  });

  it("reports a new sign-in once, but not the one it started with", async () => {
    const session = newSession();
    expect(session.usable).toBe(true);
    expect(signedIn).toBe(0);
    importCredential(dir, ACCOUNT, auth.credential(time, { access_token: "other" }));
    time += 6000;
    expect(session.usable).toBe(true);
    expect(signedIn).toBe(1);
    expect(session.usable).toBe(true);
    expect(signedIn).toBe(1);
  });

  it("treats an unreadable file as signed out", () => {
    writeFileSync(file(), "not json");
    expect(newSession().usable).toBe(false);
  });
});

describe("ChatGPT plan errors", () => {
  const http = (status: number, body: unknown) =>
    classifyChatGptHttpError(status, {}, JSON.stringify(body), 0);
  const coded = (code: string, param?: string) => ({
    error: { code, message: "Details", ...(param ? { param } : {}) },
  });

  it.each([
    ["subscription_sharing_usage_limit_exceeded", 429, "quota_exhausted", "account"],
    ["subscription_sharing_usage_unavailable", 503, "rate_limited", "account"],
    ["subscription_sharing_user_unavailable", 503, "rate_limited", "account"],
    ["subscription_sharing_user_not_eligible", 403, "auth", "account"],
    ["subscription_sharing_invalid_user", 401, "auth", "account"],
    ["chatpass_v2_scope_not_authorized", 403, "auth", "account"],
    ["chatpass_v2_invalid_authorization_context", 403, "auth", "account"],
    ["subscription_sharing_route_not_supported", 403, "unsupported", "model"],
    ["subscription_sharing_unsupported_capability", 400, "unsupported", "request"],
  ])("reads %s the same over HTTP and in a stream", (code, status, outcome, scope) => {
    const expected = { outcome, scope, code, retryElsewhere: true };
    expect(http(status, coded(code))).toMatchObject(expected);
    expect(classifyEmbeddedError(coded(code), 0)).toMatchObject(expected);
  });

  it("finds the request ID under either header name", () => {
    expect(upstreamRequestId({ "x-oai-request-id": "a", "x-request-id": "b" })).toBe("a");
    expect(upstreamRequestId({ "x-request-id": "b" })).toBe("b");
    expect(upstreamRequestId({})).toBeUndefined();
  });

  it("never invents a reset time for a usage limit", () => {
    expect(http(429, coded("subscription_sharing_usage_limit_exceeded")).resetsAt).toBeUndefined();
  });

  it("names the field an unsupported capability is about", () => {
    expect(
      http(400, coded("subscription_sharing_unsupported_capability", "tools[1]")).message,
    ).toBe("Details (tools[1])");
  });

  it("handles rejections that carry only a detail message", () => {
    expect(http(401, { detail: "No" })).toMatchObject({ outcome: "auth" });
    expect(http(403, { detail: "Region" })).toMatchObject({
      outcome: "auth",
      code: "chatgpt_admission_denied",
      message: "Region",
    });
    expect(http(503, { detail: "Off" })).toMatchObject({
      outcome: "rate_limited",
      scope: "account",
      code: "chatgpt_unavailable",
    });
  });
});

describe("account pauses", () => {
  const target = { accountId: "a", model: "m" } as Target;
  const pause: Classified = {
    outcome: "rate_limited",
    retryElsewhere: true,
    scope: "account",
    code: "unavailable",
  };
  const limit: Classified = {
    outcome: "quota_exhausted",
    retryElsewhere: true,
    scope: "account",
    code: "limit",
  };
  let now: number;
  let quota: QuotaManager;
  const state = () => quota.snapshot().find((entry) => entry.scope === "*")?.state;

  beforeEach(() => {
    now = 1_000_000;
    quota = new QuotaManager(() => now);
  });

  it("grows up to a limit and clears on success", () => {
    const waits: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      quota.recordFailure(target, pause);
      waits.push((state()!.retryAt! - now) / 1000);
      now = state()!.retryAt! + 1;
    }
    expect(waits).toEqual([15, 30, 60, 120, 240, 300, 300]);
    quota.recordSuccess(target);
    expect(state()).toBeUndefined();
  });

  it("blocks every model on the account", () => {
    quota.recordFailure(target, pause);
    expect(quota.check({ ...target, model: "other" }).available).toBe(false);
  });

  it("does not lose a usage-limit backoff during a recheck", () => {
    quota.recordFailure(target, limit);
    now = state()!.retryAt! + 1;
    expect(quota.tryAdmit(target)).toBe(true);
    quota.recordFailure(target, pause);
    expect(state()).toMatchObject({ status: "backoff", backoffS: 900, retryAt: now + 15_000 });
    expect(state()).not.toHaveProperty("probeStartedAt");
  });

  it("leaves a disabled account disabled", () => {
    quota.disable("a", "auth");
    quota.recordFailure(target, pause);
    expect(state()).toMatchObject({ status: "disabled" });
  });

  it("frees a recheck when the failure was about the request", () => {
    quota.recordFailure(target, limit);
    now = state()!.retryAt! + 1;
    expect(quota.tryAdmit(target)).toBe(true);
    quota.recordFailure(target, { ...pause, outcome: "unsupported", scope: "request" });
    expect(state()!.status).toBe("backoff");
    expect(quota.check(target).available).toBe(true);
  });

  it("clears only a disabled state on request", () => {
    quota.recordFailure(target, limit);
    quota.clearDisabled("a");
    expect(state()!.status).toBe("backoff");
    quota.disable("a", "auth");
    quota.clearDisabled("a");
    expect(state()).toBeUndefined();
  });
});

describe("the gateway's chatgpt command", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const run = (args: string[], input = "", env: Record<string, string> = {}) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", "--conditions=@llm-rudder/source", cli, "chatgpt", ...args],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        input,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          LLMR_STATE_DIR: join(dir, "cli"),
          LLMR_CHATGPT_AUTH_URL: auth.url,
          ...env,
        },
      },
    );

  it(
    "imports, reports and ends a sign-in without printing tokens",
    { timeout: 30_000 },
    async () => {
      const hostId = run(["host-id"]).stdout.trim();
      expect(hostId).toMatch(/^urn:uuid:/);

      const credential = { ...auth.credential(time), ext_agent_host_id: "urn:uuid:laptop" };
      const imported = run(["import"], JSON.stringify(credential));
      expect(imported.status).toBe(0);
      const stored = readCredential(credentialPath(join(dir, "cli"), ACCOUNT))!;
      expect(stored.ext_agent_host_id).toBe(hostId);

      const status = run(["status"]);
      expect(status.stdout).toContain("signed in");
      const printed = imported.stdout + status.stdout + status.stderr;
      expect(printed).not.toContain(credential.access_token);
      expect(printed).not.toContain(credential.refresh_token);

      expect(run(["status", "--account", "../evil"]).status).toBe(2);
      // spawnSync blocks this process, so the fake service answers from a child instead.
      const child = run(["logout"], "", { LLMR_CHATGPT_AUTH_URL: "http://127.0.0.1:9" });
      expect(child.stdout).toContain("did not confirm");
      const after = readCredential(credentialPath(join(dir, "cli"), ACCOUNT))!;
      expect(after.refresh_token).toBeUndefined();
      expect(after.id_token).toBeUndefined();
      expect(after.client_id).toBe("oaiapp_fake");
    },
  );
});
