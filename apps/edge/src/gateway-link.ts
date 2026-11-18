import {
  findEdgeRoute,
  parseEdgePlan,
  type EdgePlan,
  type EdgeReport,
  type EdgeRoute,
} from "@llm-router/shared";
import type { EdgeConfig } from "./config.js";
import { readJsonFile, writePrivateFile } from "./files.js";
import { readResponse, type HttpClient } from "./http-client.js";
import type { PlanState } from "./state.js";
import { EDGE_VERSION } from "./version.js";

const CONTROL_TIMEOUT_MS = 10_000;
const MAX_PLAN_BYTES = 1024 * 1024;
const PLAN_REFRESH_MS = 10 * 60_000;

/** Used until a plan is known, and for models with no route: the plan only. */
const PLAN_ONLY: EdgeRoute = { match: "*", tier: "", steps: [{ kind: "plan" }] };

/** Talks to the gateway for routing and status. Requests never depend on it. */
export class GatewayLink {
  private plan: EdgePlan | null = null;
  private timers: NodeJS.Timeout[] = [];
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly config: EdgeConfig,
    private readonly client: HttpClient,
    private readonly state: PlanState,
    private readonly planFile: string,
    private readonly log: (message: string, fields?: Record<string, unknown>) => void,
  ) {}

  get configured(): boolean {
    return this.config.gatewayUrl !== null && this.config.routerKey !== null;
  }

  /** Loads the last known plan, so routing works while the gateway is away. */
  loadCachedPlan(): void {
    this.plan = parseEdgePlan(readJsonFile(this.planFile));
  }

  routeFor(model: string | null): EdgeRoute {
    if (!this.plan || model === null) return PLAN_ONLY;
    return findEdgeRoute(this.plan, model) ?? PLAN_ONLY;
  }

  hasRoutes(): boolean {
    return this.plan !== null;
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.config.routerKey}` };
  }

  async refreshPlan(): Promise<void> {
    if (!this.configured) return;
    this.refreshing ??= this.fetchPlan().finally(() => {
      this.refreshing = null;
    });
    await this.refreshing;
  }

  private async fetchPlan(): Promise<void> {
    try {
      const response = await this.client.send(
        new URL("/router/edge/plan", this.config.gatewayUrl!),
        {
          method: "GET",
          headers: this.headers(),
          responseTimeoutMs: CONTROL_TIMEOUT_MS,
        },
      );
      const body = await readResponse(response, MAX_PLAN_BYTES);
      this.state.setGatewayReachable(true);
      if (response.statusCode !== 200) {
        this.log("the gateway refused the plan request", { status: response.statusCode });
        return;
      }
      const plan = parseEdgePlan(JSON.parse(body.toString("utf8")));
      if (!plan) {
        this.log("the gateway sent an invalid plan");
        return;
      }
      this.plan = plan;
      writePrivateFile(this.planFile, `${JSON.stringify(plan)}\n`);
    } catch (error) {
      this.state.setGatewayReachable(false);
      this.log("could not reach the gateway", { error: (error as Error).message });
    }
  }

  /** Sends plan state to the gateway. It holds no credential of any kind. */
  async report(): Promise<void> {
    if (!this.configured) return;
    const report: EdgeReport = {
      edgeVersion: EDGE_VERSION,
      limits: this.state.reportLimits(),
      usage: this.state.usageReport(),
    };
    try {
      const body = Buffer.from(JSON.stringify(report));
      const response = await this.client.send(
        new URL("/router/edge/report", this.config.gatewayUrl!),
        {
          method: "POST",
          headers: {
            ...this.headers(),
            "content-type": "application/json",
            "content-length": body.length,
          },
          body,
          responseTimeoutMs: CONTROL_TIMEOUT_MS,
        },
      );
      await readResponse(response, MAX_PLAN_BYTES);
      this.state.setGatewayReachable(true);
    } catch (error) {
      this.state.setGatewayReachable(false);
      this.log("could not report plan state", { error: (error as Error).message });
    }
  }

  start(): void {
    if (!this.configured) return;
    void this.refreshPlan().then(() => this.report());
    const everyPlan = setInterval(() => void this.refreshPlan(), PLAN_REFRESH_MS);
    const everyReport = setInterval(
      () => void this.report(),
      (this.plan?.reportIntervalS ?? 300) * 1000,
    );
    everyPlan.unref();
    everyReport.unref();
    this.timers = [everyPlan, everyReport];
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }
}
