import { resolve } from "node:path";
import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config/load.js";
import { MysqlPersistence } from "./db/mysql.js";
import { MemoryPersistence, type Persistence } from "./ledger/records.js";
import { runLedgerMaintenance } from "./ledger/usage.js";
import { createLogger, createRuntime, restoreState } from "./runtime.js";

const DEFAULT_DRAIN_S = 280;
const PIN_CLEANUP_MS = 10 * 60_000;
const CHATGPT_UPKEEP_MS = 15 * 60_000;
const LEDGER_MAINTENANCE_MS = 60 * 60_000;

async function main(): Promise<void> {
  const log = createLogger();
  const configPath = resolve(process.env.LLMR_CONFIG ?? "config/config.yaml");

  let loaded;
  try {
    loaded = loadConfig(configPath);
  } catch (error) {
    if (error instanceof ConfigError) {
      log.fatal({ problems: error.problems, path: configPath }, "invalid configuration");
      process.exit(1);
    }
    throw error;
  }
  for (const warning of loaded.warnings) log.warn(warning);

  let persistence: Persistence;
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    const mysql = MysqlPersistence.connect(databaseUrl, log);
    await mysql.migrate();
    persistence = mysql;
  } else {
    log.warn("DATABASE_URL is not set, so spend and quota state will not survive a restart");
    persistence = new MemoryPersistence();
  }

  const runtime = createRuntime(loaded.config, { log, persistence });
  await restoreState(runtime);
  const app = buildApp(runtime);
  await app.listen({ host: loaded.config.server.host, port: loaded.config.server.port });

  const pinCleanup = setInterval(() => runtime.pins.prune(), PIN_CLEANUP_MS);
  pinCleanup.unref();

  const maintainChatGpt = () => {
    for (const session of runtime.chatgpt.values()) void session.maintain();
  };
  maintainChatGpt();
  setInterval(maintainChatGpt, CHATGPT_UPKEEP_MS).unref();

  const maintainLedger = () => void runLedgerMaintenance(runtime);
  maintainLedger();
  setInterval(maintainLedger, LEDGER_MAINTENANCE_MS).unref();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    runtime.draining = true;
    log.info({ signal }, "shutting down; waiting for active requests");
    const drainS = Number(process.env.LLMR_DRAIN_S ?? DEFAULT_DRAIN_S);
    const forceExit = setTimeout(() => {
      log.warn("drain timeout reached");
      process.exit(0);
    }, drainS * 1000);
    forceExit.unref();
    try {
      await app.close();
      await runtime.notifier.flush();
      await runtime.upstream.close();
      await persistence.close();
    } catch (error) {
      log.error({ err: error }, "error during shutdown");
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
