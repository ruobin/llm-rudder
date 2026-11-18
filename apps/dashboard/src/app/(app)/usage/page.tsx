import type { Metadata } from "next";
import Link from "next/link";
import { Empty, PageHeader, Stat } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TD, TH } from "@/components/ui/table";
import { UsageChart } from "@/components/usage-chart";
import { cn } from "@/lib/cn";
import { formatCompact, formatCount, formatUsd } from "@/lib/format";
import { getUsage } from "@/lib/gateway";
import type { UsageTotals } from "@/lib/types";

export const metadata: Metadata = { title: "Usage" };

const RANGES = [7, 30, 90];
const METRICS = {
  value: { label: "List-price value", axis: "usd" },
  cost: { label: "Spend", axis: "usd" },
  tokens: { label: "Tokens", axis: "count" },
  requests: { label: "Requests", axis: "count" },
} as const;
type Metric = keyof typeof METRICS;

const tokensOf = (row: UsageTotals) =>
  row.inputTokens + row.cachedTokens + row.cacheWriteTokens + row.outputTokens;

function metricValue(row: UsageTotals, metric: Metric): number {
  if (metric === "value") return row.listValueUsd;
  if (metric === "cost") return row.costUsd;
  if (metric === "tokens") return tokensOf(row);
  return row.served;
}

const display = (value: number, metric: Metric) =>
  METRICS[metric].axis === "usd" ? formatUsd(value) : formatCount(value);

function Tab({ href, active, children }: { href: string; active: boolean; children: string }) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={cn(
        "rounded-md px-2.5 py-1 text-sm text-secondary hover:bg-hover",
        active && "bg-hover font-medium text-foreground",
      )}
    >
      {children}
    </Link>
  );
}

function Breakdown({
  title,
  rows,
  metric,
}: {
  title: string;
  rows: (UsageTotals & { name: string })[];
  metric: Metric;
}) {
  const top = Math.max(...rows.map((row) => metricValue(row, metric)), 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <Empty>No usage in this period.</Empty>
        ) : (
          <ul className="flex flex-col gap-3">
            {rows.slice(0, 8).map((row) => {
              const value = metricValue(row, metric);
              return (
                <li key={row.name} className="text-sm">
                  <div className="flex justify-between gap-3">
                    <span className="min-w-0 truncate" title={row.name}>
                      {row.name}
                    </span>
                    <span className="shrink-0 tabular-nums">{display(value, metric)}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-hover">
                    <div
                      className="h-full rounded-full bg-chart"
                      style={{ width: top > 0 ? `${(value / top) * 100}%` : 0 }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const days = RANGES.includes(Number(params.days)) ? Number(params.days) : 30;
  const metric: Metric =
    typeof params.metric === "string" && params.metric in METRICS
      ? (params.metric as Metric)
      : "value";
  const usage = await getUsage(days);
  const { totals } = usage;
  const link = (next: { days?: number; metric?: Metric }) =>
    `/usage?days=${next.days ?? days}&metric=${next.metric ?? metric}`;
  const label = METRICS[metric].label;
  const hasData = usage.byDay.some((day) => metricValue(day, metric) > 0);

  return (
    <>
      <PageHeader title="Usage" description={`${usage.from} to ${usage.to}, in UTC`}>
        <nav aria-label="Period" className="flex gap-1">
          {RANGES.map((range) => (
            <Tab key={range} href={link({ days: range })} active={range === days}>
              {`${range} days`}
            </Tab>
          ))}
        </nav>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Requests"
          value={formatCount(totals.served)}
          note={`${formatCount(totals.failed)} failed attempts`}
        />
        <Stat
          label="Tokens"
          value={formatCompact(tokensOf(totals))}
          note={`${formatCompact(totals.cachedTokens)} from cache`}
        />
        <Stat label="Spend" value={formatUsd(totals.costUsd)} note="Metered accounts" />
        <Stat
          label="List-price value"
          value={formatUsd(totals.listValueUsd)}
          note="What this would cost on API keys"
        />
      </div>

      <Card className="mt-4">
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>{label} by day</CardTitle>
            <CardDescription className="mt-1">
              Hover a day, or focus the chart and use the arrow keys.
            </CardDescription>
          </div>
          <nav aria-label="Measure" className="flex flex-wrap gap-1">
            {(Object.keys(METRICS) as Metric[]).map((name) => (
              <Tab key={name} href={link({ metric: name })} active={name === metric}>
                {METRICS[name].label}
              </Tab>
            ))}
          </nav>
        </CardHeader>
        <CardContent>
          {hasData ? (
            <UsageChart
              label={label}
              formatAxis={METRICS[metric].axis}
              points={usage.byDay.map((day) => ({
                day: day.day,
                value: metricValue(day, metric),
                display: display(metricValue(day, metric), metric),
              }))}
            />
          ) : (
            <Empty>No usage in this period.</Empty>
          )}
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-secondary">Show as a table</summary>
            <Table className="mt-2">
              <thead>
                <tr>
                  <TH>Day</TH>
                  <TH className="text-right">Requests</TH>
                  <TH className="text-right">Failed</TH>
                  <TH className="text-right">Tokens</TH>
                  <TH className="text-right">Spend</TH>
                  <TH className="text-right">List value</TH>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {[...usage.byDay].reverse().map((day) => (
                  <tr key={day.day}>
                    <TD>{day.day}</TD>
                    <TD className="text-right">{formatCount(day.served)}</TD>
                    <TD className="text-right">{formatCount(day.failed)}</TD>
                    <TD className="text-right">{formatCount(tokensOf(day))}</TD>
                    <TD className="text-right">{formatUsd(day.costUsd)}</TD>
                    <TD className="text-right">{formatUsd(day.listValueUsd)}</TD>
                  </tr>
                ))}
              </tbody>
            </Table>
          </details>
        </CardContent>
      </Card>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Breakdown
          title="By client"
          metric={metric}
          rows={usage.byClient.map((row) => ({ ...row, name: row.clientId }))}
        />
        <Breakdown
          title="By account"
          metric={metric}
          rows={usage.byAccount.map((row) => ({ ...row, name: row.accountId }))}
        />
        <Breakdown
          title="By model"
          metric={metric}
          rows={usage.byModel.map((row) => ({ ...row, name: row.model }))}
        />
      </div>
    </>
  );
}
