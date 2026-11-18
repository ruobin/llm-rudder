import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  CHATGPT_DEFAULT_ACCOUNT,
  chatGptEndpoints,
  revokeChatGptSession,
  withoutChatGptTokens,
} from "@llm-rudder/shared";
import { generateKey } from "./auth/keys.js";
import { hashPassword } from "./auth/password.js";
import { openBackup, sealBackup } from "./backup.js";
import {
  credentialPath,
  ensureHostId,
  importCredential,
  readCredential,
  writePrivateJson,
} from "./chatgpt/session.js";
import { ConfigError, loadConfig } from "./config/load.js";

const usage = `Usage:
  cli keygen [NAME ...]    Print new keys, one per name, in .env format
  cli check-config [PATH]  Validate a config file (default: config/config.yaml)
  cli check-accounts [--live] [ACCOUNT ...]
                           Check keys and models. --live also sends short real requests
  cli dashboard-secrets    Print dashboard settings for .env, and its password to stderr
  cli backup-seal          Encrypt standard input with LLMR_BACKUP_PASSPHRASE
  cli backup-open          Decrypt standard input with LLMR_BACKUP_PASSPHRASE
  cli chatgpt host-id      Create or show this machine's ChatGPT host ID
  cli chatgpt import       Save a sign-in read from standard input
  cli chatgpt status       Show the saved sign-in, without its tokens
  cli chatgpt logout       End the saved sign-in
                           These take --account ID (default: chatgpt-plan)
`;

function keygen(names: string[]): void {
  for (const name of names.length > 0 ? names : ["LLMR_KEY"]) {
    console.log(`${name}=${generateKey()}`);
  }
}

function checkConfig(path: string): number {
  try {
    const { config, warnings } = loadConfig(resolve(path));
    for (const warning of warnings) console.warn(`warning: ${warning}`);
    console.log(
      `OK: ${config.tiers.size} tiers, ${config.accounts.size} accounts, ${config.clients.length} clients`,
    );
    return 0;
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

async function readInput(): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of process.stdin as AsyncIterable<Buffer>) parts.push(part);
  return Buffer.concat(parts).toString("utf8");
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function chatgpt(args: string[]): Promise<number> {
  const stateDir = process.env.LLMR_STATE_DIR ?? "data";
  const account = option(args, "--account") ?? CHATGPT_DEFAULT_ACCOUNT;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(account)) {
    console.error("That is not a valid account ID.");
    return 2;
  }
  const file = credentialPath(stateDir, account);
  switch (args[0]) {
    case "host-id":
      console.log(ensureHostId(stateDir));
      return 0;
    case "import":
      importCredential(stateDir, account, JSON.parse(await readInput()));
      console.log("Saved the sign-in under this machine's host ID.");
      return 0;
    case "status": {
      const credential = readCredential(file);
      if (!credential) console.log(`${account}: not signed in.`);
      else {
        const state = credential.refresh_token ? "signed in" : "needs a new sign-in";
        console.log(
          `${account}: ${credential.email ?? credential.subject}, ${state}, tokens from ${credential.saved_at}.`,
        );
      }
      return 0;
    }
    case "logout": {
      const credential = readCredential(file);
      if (!credential?.refresh_token) {
        console.log(`${account}: not signed in.`);
        return 0;
      }
      const revoked = await revokeChatGptSession(chatGptEndpoints(), credential);
      writePrivateJson(file, withoutChatGptTokens(credential, { keepIdToken: false }));
      console.log(
        revoked
          ? `${account}: signed out.`
          : `${account}: signed out here, but OpenAI did not confirm it. You can disconnect the app in ChatGPT settings.`,
      );
      return 0;
    }
    default:
      console.error(usage);
      return 2;
  }
}

async function checkAccountsCommand(args: string[]): Promise<number> {
  const live = args.includes("--live");
  const accounts = args.filter((arg) => arg !== "--live");
  const unknownFlag = accounts.find((arg) => arg.startsWith("-"));
  if (unknownFlag) {
    console.error(usage);
    return 2;
  }
  const path = resolve(process.env.LLMR_CONFIG ?? "config/config.yaml");
  let config;
  try {
    ({ config } = loadConfig(path));
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
  const missing = accounts.filter((id) => !config.accounts.has(id));
  if (missing.length > 0) {
    console.error(`No such account in the config: ${missing.join(", ")}`);
    return 2;
  }
  // Loaded here so the other commands do not have to start the whole gateway code.
  const { checkAccounts, formatReports, hasFailures } = await import("./check-accounts.js");
  const reports = await checkAccounts(config, { accounts, live });
  console.log(formatReports(reports));
  if (!live) console.log("\nAdd --live to send two short real requests to each model.");
  return hasFailures(reports) ? 1 : 0;
}

const [command, ...args] = process.argv.slice(2);
if (command === "keygen") {
  keygen(args);
} else if (command === "check-config") {
  process.exitCode = checkConfig(args[0] ?? process.env.LLMR_CONFIG ?? "config/config.yaml");
} else if (command === "check-accounts") {
  process.exitCode = await checkAccountsCommand(args);
} else if (command === "backup-seal" || command === "backup-open") {
  const passphrase = process.env.LLMR_BACKUP_PASSPHRASE ?? "";
  const transform = command === "backup-seal" ? sealBackup : openBackup;
  try {
    await pipeline(Readable.from(transform(process.stdin, passphrase)), process.stdout);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
} else if (command === "dashboard-secrets") {
  const password = randomBytes(18).toString("base64url");
  console.log(`LLMR_DASHBOARD_PASSWORD_HASH=${await hashPassword(password)}`);
  console.log(`LLMR_DASHBOARD_SESSION_SECRET=${randomBytes(32).toString("base64url")}`);
  console.error(`Dashboard password (shown only now): ${password}`);
} else if (command === "chatgpt") {
  process.exitCode = await chatgpt(args);
} else {
  console.error(usage);
  process.exitCode = 2;
}
