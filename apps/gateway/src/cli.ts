import { resolve } from "node:path";
import { generateKey } from "./auth/keys.js";
import { ConfigError, loadConfig } from "./config/load.js";

const usage = `Usage:
  cli keygen [NAME ...]    Print new keys, one per name, in .env format
  cli check-config [PATH]  Validate a config file (default: config/config.yaml)
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

const [command, ...args] = process.argv.slice(2);
if (command === "keygen") {
  keygen(args);
} else if (command === "check-config") {
  process.exitCode = checkConfig(args[0] ?? process.env.LLMR_CONFIG ?? "config/config.yaml");
} else {
  console.error(usage);
  process.exitCode = 2;
}
