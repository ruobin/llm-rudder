import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CHATGPT_DEFAULT_ACCOUNT, chatGptEndpoints, CHATGPT_USAGE_URL } from "@llm-rudder/shared";
import { startEdge } from "./app.js";
import {
  configIsExposed,
  DEFAULT_PORT,
  EdgeConfigError,
  generateEdgeKey,
  loadEdgeConfig,
  parseGatewayUrl,
  readConfigFile,
  writeConfigFile,
} from "./config.js";
import {
  activeCredential,
  ChatGptLoginError,
  DEFAULT_VPS_DIR,
  describeCredential,
  loginToChatGpt,
  openInBrowser,
  pushCredential,
  remoteHostId,
  remoteLogout,
  remoteStatus,
  signOut,
  type RemoteGateway,
} from "./chatgpt.js";
import { desktopNotify } from "./notify.js";
import { edgePaths, type EdgePaths } from "./paths.js";
import { EDGE_KEY_HEADER } from "./server.js";
import { installService, serviceFile, uninstallService } from "./service.js";
import { fetchStatus, formatStatusLine, savedStatus } from "./statusline.js";
import { EDGE_VERSION } from "./version.js";

const USAGE = `llmr-edge ${EDGE_VERSION}: keeps Claude Code on your plan and overflows to your gateway

Usage:
  llmr-edge setup --gateway URL   Create the config. Reads the router key from LLMR_ROUTER_KEY.
  llmr-edge install               Copy this program to a stable place and add it to ~/.local/bin
  llmr-edge service install       Start at login (launchd or systemd). Add --dry-run to preview.
  llmr-edge service uninstall     Stop starting at login
  llmr-edge serve                 Run in the foreground
  llmr-edge status                Show plan and gateway state
  llmr-edge statusline            Print one line for Claude Code's status bar
  llmr-edge doctor                Check the setup
  llmr-edge chatgpt login         Continue with ChatGPT in your browser (--new)
  llmr-edge chatgpt push TARGET   Send the sign-in to the VPS over SSH
  llmr-edge chatgpt login --for TARGET   Sign the VPS in again
  llmr-edge chatgpt status [--for TARGET]
  llmr-edge chatgpt logout [--for TARGET]
                                  With a TARGET, these use --dir (default /opt/llm-rudder)
                                  and --account (default chatgpt-plan)
`;

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function log(message: string, fields: Record<string, unknown> = {}): void {
  // Only these fields are ever logged. Requests and headers are not.
  console.log(JSON.stringify({ time: new Date().toISOString(), message, ...fields }));
}

async function serve(paths: EdgePaths): Promise<void> {
  const config = loadEdgeConfig(paths);
  if (configIsExposed(paths)) {
    log("warning: the config file is readable by other users; run chmod 600 on it");
  }
  const edge = await startEdge({
    config,
    paths,
    log,
    ...(config.desktopNotifications ? { notify: desktopNotify } : {}),
  });
  log("listening", {
    url: edge.url,
    gateway: config.gatewayUrl?.origin ?? null,
    version: EDGE_VERSION,
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(0), 30_000).unref();
    void edge.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

function claudeSettings(port: number, edgeKey: string): string {
  return JSON.stringify(
    {
      env: {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_CUSTOM_HEADERS: `${EDGE_KEY_HEADER}: ${edgeKey}`,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-5-5",
      },
      statusLine: { type: "command", command: "llmr-edge statusline", refreshInterval: 5 },
    },
    null,
    2,
  );
}

function setup(paths: EdgePaths, args: string[]): void {
  const existing = readConfigFile(paths);
  const gatewayUrl = flag(args, "--gateway") ?? existing.gatewayUrl;
  if (gatewayUrl) parseGatewayUrl(gatewayUrl);
  const routerKey = process.env.LLMR_ROUTER_KEY ?? existing.routerKey;
  const edgeKey = existing.edgeKey ?? generateEdgeKey();
  const port = Number(flag(args, "--port") ?? existing.port ?? DEFAULT_PORT);
  writeConfigFile(paths, {
    ...existing,
    port,
    edgeKey,
    ...(gatewayUrl ? { gatewayUrl } : {}),
    ...(routerKey ? { routerKey } : {}),
  });
  console.log(`Saved ${paths.configFile}`);
  if (!gatewayUrl || !routerKey) {
    console.log(
      "No gateway yet, so the edge will only pass traffic to your plan.\n" +
        "To add one: LLMR_ROUTER_KEY=... llmr-edge setup --gateway https://your-gateway",
    );
  }
  console.log(
    `\nMerge this into ~/.claude/settings.json. Do not set ANTHROPIC_AUTH_TOKEN,\n` +
      `ANTHROPIC_API_KEY or apiKeyHelper, because each one replaces your plan login.\n\n` +
      `${claudeSettings(port, edgeKey)}\n`,
  );
}

function install(paths: EdgePaths): void {
  const source = fileURLToPath(import.meta.url);
  if (!source.endsWith(".mjs")) {
    throw new EdgeConfigError("Build first: pnpm --filter @llm-rudder/edge build");
  }
  mkdirSync(dirname(paths.programFile), { recursive: true });
  if (source !== paths.programFile) copyFileSync(source, paths.programFile);
  chmodSync(paths.programFile, 0o755);
  mkdirSync(dirname(paths.binFile), { recursive: true });
  writeFileSync(
    paths.binFile,
    `#!/bin/sh\nexec "${process.execPath}" "${paths.programFile}" "$@"\n`,
  );
  chmodSync(paths.binFile, 0o755);
  console.log(`Installed ${paths.binFile}`);
}

function service(paths: EdgePaths, args: string[]): void {
  const action = args[0];
  const program = existsSync(paths.programFile) ? paths.programFile : null;
  const file = serviceFile(
    process.platform,
    paths,
    {
      node: process.execPath,
      program: program ?? paths.programFile,
      logDir: paths.logDir,
    },
    process.getuid?.() ?? 0,
  );
  if (!file) throw new EdgeConfigError(`Services are not supported on ${process.platform}.`);
  if (action === "install") {
    if (args.includes("--dry-run")) {
      console.log(`# ${file.path}\n${file.content}`);
      return;
    }
    if (!program) throw new EdgeConfigError("Run llmr-edge install first.");
    loadEdgeConfig(paths);
    installService(file, paths.logDir);
    console.log(`Installed and started ${file.path}`);
  } else if (action === "uninstall") {
    console.log(uninstallService(file) ? `Removed ${file.path}` : "The service is not installed.");
  } else {
    console.error(USAGE);
    process.exitCode = 2;
  }
}

function portOf(paths: EdgePaths): number {
  return Number(process.env.LLMR_EDGE_PORT ?? readConfigFile(paths).port ?? DEFAULT_PORT);
}

async function statusLine(paths: EdgePaths): Promise<void> {
  // Claude Code sends session details on stdin. The line does not need them.
  process.stdin.resume();
  process.stdin.on("error", () => {});
  const status = await fetchStatus(portOf(paths));
  console.log(formatStatusLine(status, Date.now()));
  process.exit(0);
}

async function status(paths: EdgePaths): Promise<void> {
  const live = await fetchStatus(portOf(paths));
  console.log(live ? "edge: running" : "edge: not running");
  console.log(JSON.stringify(live ?? savedStatus(paths), null, 2));
}

async function doctor(paths: EdgePaths): Promise<void> {
  const report = (ok: boolean, text: string) => console.log(`${ok ? "ok  " : "FAIL"} ${text}`);
  let failed = false;
  const check = (ok: boolean, text: string) => {
    report(ok, text);
    failed ||= !ok;
  };

  let config;
  try {
    config = loadEdgeConfig(paths);
    check(true, `config: ${paths.configFile}`);
  } catch (error) {
    check(false, `config: ${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }
  check(!configIsExposed(paths), "config file is private");
  check((await fetchStatus(config.port)) !== null, `edge is running on port ${config.port}`);

  if (config.gatewayUrl && config.routerKey) {
    try {
      const response = await fetch(new URL("/router/edge/plan", config.gatewayUrl), {
        headers: { authorization: `Bearer ${config.routerKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      check(response.ok, `gateway accepts this key (HTTP ${response.status})`);
    } catch (error) {
      check(false, `gateway: ${(error as Error).message}`);
    }
  } else {
    report(true, "no gateway configured: plan traffic only");
  }
  if (existsSync(paths.samplesFile)) {
    const count = readFileSync(paths.samplesFile, "utf8").trim().split("\n").length;
    report(true, `${count} recorded plan 429s in ${paths.samplesFile}`);
  }
  if (failed) process.exitCode = 1;
}

function remoteGateway(target: string, args: string[]): RemoteGateway {
  return {
    target,
    directory: flag(args, "--dir") ?? DEFAULT_VPS_DIR,
    account: flag(args, "--account") ?? CHATGPT_DEFAULT_ACCOUNT,
  };
}

async function chatgpt(paths: EdgePaths, args: string[]): Promise<void> {
  const endpoints = chatGptEndpoints();
  const forTarget = flag(args, "--for");
  const remote = forTarget ? remoteGateway(forTarget, args) : null;
  switch (args[0]) {
    case "login": {
      // After the first transfer, the VPS signs in under its own host ID.
      const hostId = remote ? await remoteHostId(remote) : undefined;
      const credential = await loginToChatGpt({
        paths,
        endpoints,
        openBrowser: openInBrowser,
        print: (text) => console.log(text),
        fresh: args.includes("--new"),
        ...(hostId ? { hostId } : {}),
      });
      console.log(`Signed in as ${credential.email ?? credential.subject}.`);
      if (remote) {
        await pushCredential(paths, remote);
        console.log("The VPS now holds this sign-in and will renew it.");
      } else {
        console.log("Next: llmr-edge chatgpt push user@your-vps");
      }
      return;
    }
    case "push": {
      const target = args[1];
      if (!target || target.startsWith("--")) {
        throw new EdgeConfigError("Usage: llmr-edge chatgpt push user@your-vps");
      }
      await pushCredential(paths, remoteGateway(target, args));
      console.log("The VPS now holds this sign-in and will renew it.");
      console.log(`Using ChatGPT plan. Manage usage and this app's limit: ${CHATGPT_USAGE_URL}`);
      return;
    }
    case "status":
      console.log(
        remote ? (await remoteStatus(remote)).trim() : describeCredential(activeCredential(paths)),
      );
      return;
    case "logout": {
      if (remote) {
        console.log((await remoteLogout(remote)).trim());
        return;
      }
      const revoked = await signOut(paths, endpoints);
      console.log(
        revoked
          ? "Signed out on this computer."
          : "Signed out here, but OpenAI did not confirm it. You can disconnect the app in ChatGPT settings.",
      );
      return;
    }
    default:
      console.error(USAGE);
      process.exitCode = 2;
  }
}

async function main(): Promise<void> {
  const paths = edgePaths();
  const [command = "serve", ...args] = process.argv.slice(2);
  switch (command) {
    case "serve":
      return serve(paths);
    case "setup":
      return setup(paths, args);
    case "install":
      return install(paths);
    case "service":
      return service(paths, args);
    case "statusline":
      return statusLine(paths);
    case "status":
      return status(paths);
    case "doctor":
      return doctor(paths);
    case "chatgpt":
      return chatgpt(paths, args);
    case "version":
    case "--version":
      console.log(EDGE_VERSION);
      return;
    case "help":
    case "--help":
      console.log(USAGE);
      return;
    default:
      console.error(USAGE);
      process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  const expected = error instanceof EdgeConfigError || error instanceof ChatGptLoginError;
  console.error(expected ? (error as Error).message : error);
  process.exit(1);
});
