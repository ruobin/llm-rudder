import type { EdgeConfig } from "./config.js";
import { GatewayLink } from "./gateway-link.js";
import { HttpClient } from "./http-client.js";
import type { EdgePaths } from "./paths.js";
import { LimitSamples } from "./samples.js";
import { EdgeServer, type Log } from "./server.js";
import { PlanState, type PlanChange } from "./state.js";

const NOTIFICATION_WINDOW_MS = 15 * 60_000;

export interface EdgeOptions {
  config: EdgeConfig;
  paths: EdgePaths;
  now?: () => number;
  log?: Log;
  notify?: (text: string) => void;
}

export interface RunningEdge {
  host: string;
  port: number;
  url: string;
  state: PlanState;
  gateway: GatewayLink;
  close(): Promise<void>;
}

/** The wording of desktop notifications. */
export function changeMessage(change: PlanChange, hasGateway: boolean): string | null {
  switch (change.kind) {
    case "limited":
      return hasGateway
        ? "Claude plan limit reached. Claude Code will continue through your gateway."
        : "Claude plan limit reached. No gateway is set up to continue.";
    case "recovered":
      return change.scope === "*" ? "Claude plan is available again." : null;
    case "overflow":
      return `Claude Code is now using your gateway (${change.tier}), which may cost money.`;
  }
}

/** Shows each message at most once per window, even if the plan state flaps. */
function throttled(notify: (text: string) => void, now: () => number) {
  const lastShown = new Map<string, number>();
  return (text: string) => {
    const last = lastShown.get(text);
    if (last !== undefined && now() - last < NOTIFICATION_WINDOW_MS) return;
    lastShown.set(text, now());
    notify(text);
  };
}

export async function startEdge(options: EdgeOptions): Promise<RunningEdge> {
  const { config, paths } = options;
  const now = options.now ?? Date.now;
  const log: Log = options.log ?? (() => {});
  const notify = throttled(options.notify ?? (() => {}), now);
  const http = new HttpClient();

  const hasGateway = config.gatewayUrl !== null && config.routerKey !== null;
  const state = new PlanState(paths.stateFile, now, (change) => {
    const message = changeMessage(change, hasGateway);
    if (message) notify(message);
  });
  state.load();

  const gateway = new GatewayLink(config, http, state, paths.planFile, log);
  gateway.loadCachedPlan();

  const edge = new EdgeServer({
    config,
    state,
    gateway,
    samples: new LimitSamples(paths.samplesFile),
    http,
    now,
    log,
  });
  const port = await edge.listen(config.port);
  gateway.start();

  return {
    host: (edge.server.address() as { address: string }).address,
    port,
    url: `http://127.0.0.1:${port}`,
    state,
    gateway,
    close: async () => {
      gateway.stop();
      await edge.close();
      http.close();
    },
  };
}
