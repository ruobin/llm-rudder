import type { LedgerEntry } from "./ledger/records.js";
import type { Runtime } from "./runtime.js";

type Labels = Record<string, string>;

const SECONDS_BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];

const escapeLabel = (value: string) =>
  value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");

function labelText(labels: Labels): string {
  const parts = Object.entries(labels).map(([name, value]) => `${name}="${escapeLabel(value)}"`);
  return parts.length > 0 ? `{${parts.join(",")}}` : "";
}

class Counter {
  private readonly series = new Map<string, { labels: Labels; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  add(labels: Labels, amount = 1): void {
    const key = labelText(labels);
    const entry = this.series.get(key);
    if (entry) entry.value += amount;
    else this.series.set(key, { labels, value: amount });
  }

  render(): string[] {
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
      ...[...this.series].map(([key, { value }]) => `${this.name}${key} ${value}`),
    ];
  }
}

class Histogram {
  private readonly series = new Map<
    string,
    { labels: Labels; counts: number[]; sum: number; count: number }
  >();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  observe(labels: Labels, value: number): void {
    const key = labelText(labels);
    let entry = this.series.get(key);
    if (!entry) {
      entry = { labels, counts: SECONDS_BUCKETS.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, entry);
    }
    entry.sum += value;
    entry.count += 1;
    const index = SECONDS_BUCKETS.findIndex((limit) => value <= limit);
    if (index !== -1) entry.counts[index]! += 1;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const { labels, counts, sum, count } of this.series.values()) {
      let cumulative = 0;
      SECONDS_BUCKETS.forEach((limit, index) => {
        cumulative += counts[index]!;
        lines.push(
          `${this.name}_bucket${labelText({ ...labels, le: String(limit) })} ${cumulative}`,
        );
      });
      lines.push(`${this.name}_bucket${labelText({ ...labels, le: "+Inf" })} ${count}`);
      lines.push(`${this.name}_sum${labelText(labels)} ${sum}`);
      lines.push(`${this.name}_count${labelText(labels)} ${count}`);
    }
    return lines;
  }
}

function gauge(name: string, help: string, rows: [Labels, number][]): string[] {
  return [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} gauge`,
    ...rows.map(([labels, value]) => `${name}${labelText(labels)} ${value}`),
  ];
}

/** Counts what the gateway does, for Prometheus. Labels never hold request content. */
export class Metrics {
  private readonly requests = new Counter("llmr_requests_total", "Finished client requests.");
  private readonly attempts = new Counter("llmr_attempts_total", "Attempts on upstream targets.");
  private readonly fallbacks = new Counter(
    "llmr_tier_fallbacks_total",
    "Requests answered by a tier other than the one requested.",
  );
  private readonly tokens = new Counter("llmr_tokens_total", "Tokens used, by kind.");
  private readonly spend = new Counter("llmr_cost_usd_total", "Spend on metered accounts.");
  private readonly listValue = new Counter(
    "llmr_list_value_usd_total",
    "What the served tokens would cost at list prices.",
  );
  private readonly duration = new Histogram(
    "llmr_attempt_duration_seconds",
    "How long each upstream attempt took.",
  );
  private readonly firstOutput = new Histogram(
    "llmr_time_to_first_output_seconds",
    "Time from the start of an attempt to its first output.",
  );

  observe({ request, attempts }: LedgerEntry): void {
    this.requests.add({
      client: request.clientId,
      tier: request.requestedTier ?? "",
      outcome: request.outcome,
    });
    const { requestedTier, servedTier } = request;
    if (requestedTier && servedTier && requestedTier !== servedTier) {
      this.fallbacks.add({ requested: requestedTier, served: servedTier });
    }
    for (const attempt of attempts) {
      const target = { account: attempt.accountId, model: attempt.model };
      this.attempts.add({ ...target, outcome: attempt.outcome });
      this.duration.observe(target, attempt.durationMs / 1000);
      if (attempt.ttftMs !== null) this.firstOutput.observe(target, attempt.ttftMs / 1000);
      const kinds = {
        input: attempt.inputTokens,
        cached: attempt.cachedTokens,
        cache_write: attempt.cacheWriteTokens,
        output: attempt.outputTokens,
      };
      for (const [kind, amount] of Object.entries(kinds)) {
        if (amount) this.tokens.add({ ...target, kind }, amount);
      }
      if (attempt.costMicroUsd) {
        this.spend.add({ account: attempt.accountId }, attempt.costMicroUsd / 1_000_000);
      }
      if (attempt.listMicroUsd) {
        this.listValue.add({ account: attempt.accountId }, attempt.listMicroUsd / 1_000_000);
      }
    }
  }

  render(runtime: Runtime): string {
    const { config, quota, budgets, pins, limits, chatgpt, balances, cluster, now, startedAt } =
      runtime;
    const targets = [...config.tiers.values()].flatMap((tier) =>
      tier.targets.map((target): [Labels, number] => [
        { tier: tier.name, account: target.accountId, model: target.model },
        config.accounts.get(target.accountId)?.enabled && quota.check(target).available ? 1 : 0,
      ]),
    );
    const accounts = [...config.accounts.keys()];
    const { heapUsed, external } = process.memoryUsage();
    const lines = [
      ...this.requests.render(),
      ...this.attempts.render(),
      ...this.fallbacks.render(),
      ...this.tokens.render(),
      ...this.spend.render(),
      ...this.listValue.render(),
      ...this.duration.render(),
      ...this.firstOutput.render(),
      ...gauge("llmr_target_available", "1 when a target can be used.", targets),
      ...gauge(
        "llmr_spend_today_usd",
        "Spend on each account today.",
        accounts.map((id) => [{ account: id }, budgets.snapshot(id).dayMicroUsd / 1_000_000]),
      ),
      ...gauge(
        "llmr_balance_usd",
        "Remaining balance reported by an account.",
        [...balances.current()].map(([id, { usd }]) => [{ account: id }, usd]),
      ),
      ...gauge(
        "llmr_chatgpt_signed_in",
        "1 when the ChatGPT plan sign-in is usable.",
        [...chatgpt].map(([id, session]) => [{ account: id }, session.usable ? 1 : 0]),
      ),
      ...gauge("llmr_active_requests", "Requests in progress.", [[{}, limits.activeRequests()]]),
      ...(cluster.enabled
        ? [
            ...gauge("llmr_cluster_connected", "1 when the shared state is reachable.", [
              [{}, cluster.connected ? 1 : 0],
            ]),
            ...gauge("llmr_cluster_instances", "Gateway instances sharing the work.", [
              [{}, cluster.instanceCount],
            ]),
          ]
        : []),
      ...gauge("llmr_pinned_conversations", "Conversations pinned to a target.", [[{}, pins.size]]),
      ...gauge("llmr_uptime_seconds", "Seconds since the gateway started.", [
        [{}, (now() - startedAt) / 1000],
      ]),
      ...gauge("llmr_memory_rss_bytes", "Memory used by the gateway process.", [
        [{}, process.memoryUsage.rss()],
      ]),
      ...gauge("llmr_memory_heap_bytes", "JavaScript and buffer memory in use.", [
        [{}, heapUsed + external],
      ]),
    ];
    return `${lines.join("\n")}\n`;
  }
}
