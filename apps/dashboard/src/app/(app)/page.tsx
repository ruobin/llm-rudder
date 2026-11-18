import type { Metadata } from "next";
import Link from "next/link";
import { AutoRefresh } from "@/components/auto-refresh";
import { Empty, PageHeader, Stat } from "@/components/page-header";
import { StateBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TD, TH } from "@/components/ui/table";
import {
  formatCompact,
  formatCount,
  formatRelative,
  formatTime,
  formatUptime,
  formatUsd,
} from "@/lib/format";
import { getStatus, getUsage } from "@/lib/gateway";
import type { GatewayStatus } from "@/lib/types";

export const metadata: Metadata = { title: "Overview" };

function describeGateway(status: GatewayStatus): string {
  const uptime = `Gateway up for ${formatUptime(status.uptimeS)}`;
  const instances = status.cluster?.instances.length ?? 0;
  return instances > 1 ? `${uptime}, running ${instances} instances` : uptime;
}

export default async function OverviewPage() {
  const [status, usage] = await Promise.all([getStatus(), getUsage(1)]);
  const now = Date.now();
  const { totals } = usage;
  const unavailable = status.tiers.filter((tier) => !tier.targets.some((t) => t.available));

  return (
    <>
      <AutoRefresh />
      <PageHeader title="Overview" description={describeGateway(status)}>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {status.cluster?.mode === "shared" && !status.cluster.connected ? (
            <Badge tone="warning">Instances not sharing state</Badge>
          ) : null}
          {unavailable.length === 0 ? (
            <StateBadge state="ok" />
          ) : (
            <Badge tone="critical">
              {unavailable.length} {unavailable.length === 1 ? "tier" : "tiers"} unavailable
            </Badge>
          )}
        </div>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Requests today" value={formatCount(totals.served)} />
        <Stat label="Failed attempts today" value={formatCount(totals.failed)} />
        <Stat
          label="Tokens today"
          value={formatCompact(totals.inputTokens + totals.cachedTokens + totals.outputTokens)}
        />
        <Stat
          label="Spent today"
          value={formatUsd(totals.costUsd)}
          note={`${formatUsd(totals.listValueUsd)} at list prices`}
        />
      </div>

      {status.fallbacks.length > 0 ? (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Active fallbacks</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1 text-sm">
              {status.fallbacks.map((fallback) => (
                <li key={`${fallback.requestedTier}-${fallback.servedTier}`}>
                  <span className="font-medium">{fallback.requestedTier}</span> is being served by{" "}
                  <span className="font-medium">{fallback.servedTier}</span>
                  {fallback.since ? `, since ${formatTime(fallback.since)}` : ""}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Tiers</CardTitle>
            <CardDescription>Targets are tried in this order.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <thead>
                <tr>
                  <TH>Tier</TH>
                  <TH>Target</TH>
                  <TH>State</TH>
                </tr>
              </thead>
              <tbody>
                {status.tiers.flatMap((tier) =>
                  tier.targets.map((target, index) => (
                    <tr key={target.id}>
                      <TD className="font-medium">{index === 0 ? tier.name : ""}</TD>
                      <TD>
                        {target.model}
                        <span className="block text-xs text-secondary">{target.account}</span>
                      </TD>
                      <TD>
                        <StateBadge
                          state={target.available ? "ok" : (target.reason ?? "disabled")}
                        />
                        {target.retryAt ? (
                          <span className="ml-2 text-xs text-secondary">
                            retry {formatRelative(target.retryAt, now)}
                          </span>
                        ) : null}
                      </TD>
                    </tr>
                  )),
                )}
              </tbody>
            </Table>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          {status.chatgpt.map((plan) => (
            <Card key={plan.account}>
              <CardHeader>
                <CardTitle>{plan.usingPlan ? "Using ChatGPT plan" : "ChatGPT plan"}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col items-start gap-2 text-sm">
                <StateBadge state={plan.state} />
                <a
                  className="underline underline-offset-2"
                  href={plan.manageUsage}
                  rel="noreferrer"
                >
                  Manage usage
                </a>
              </CardContent>
            </Card>
          ))}
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Recent events</CardTitle>
              <Link
                href="/accounts"
                className="text-xs text-secondary underline underline-offset-2"
              >
                Accounts
              </Link>
            </CardHeader>
            <CardContent>
              {status.recentEvents.length === 0 ? (
                <Empty>Nothing has happened yet.</Empty>
              ) : (
                <ul className="flex flex-col gap-2.5 text-sm">
                  {status.recentEvents.slice(0, 6).map((event) => (
                    <li key={`${event.at}-${event.kind}-${event.subject}`}>
                      {event.message}
                      <span className="block text-xs text-secondary">
                        {formatRelative(event.at, now)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
