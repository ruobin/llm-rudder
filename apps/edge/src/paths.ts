import { homedir } from "node:os";
import { join } from "node:path";

export interface EdgePaths {
  home: string;
  configFile: string;
  stateFile: string;
  planFile: string;
  samplesFile: string;
  logDir: string;
  programFile: string;
  binFile: string;
}

export type Env = Record<string, string | undefined>;

/** Where the edge keeps its files. Nothing here ever holds a Claude credential. */
export function edgePaths(env: Env = process.env): EdgePaths {
  const home = env.HOME || homedir();
  const configDir =
    env.LLMR_EDGE_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "llm-router");
  const stateDir =
    env.LLMR_EDGE_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(home, ".local/state"), "llm-router");
  const dataDir = join(env.XDG_DATA_HOME ?? join(home, ".local/share"), "llm-router");
  return {
    home,
    configFile: join(configDir, "edge.json"),
    stateFile: join(stateDir, "edge-state.json"),
    planFile: join(stateDir, "edge-plan.json"),
    samplesFile: join(stateDir, "edge-limit-samples.jsonl"),
    logDir: stateDir,
    programFile: join(dataDir, "llmr-edge.mjs"),
    binFile: join(home, ".local/bin/llmr-edge"),
  };
}
