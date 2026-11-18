import type { Metadata } from "next";
import { resetAccountAction } from "@/app/actions";
import { AutoRefresh } from "@/components/auto-refresh";
import { PageHeader } from "@/components/page-header";
import { StateBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { formatRelative, formatTime, formatUsd } from "@/lib/format";
import { getStatus } from "@/lib/gateway";

export const metadata: Metadata = { title: "Accounts" };

function Budget({ label, spent, limit }: { label: string; spent?: number; limit?: number }) {
  if (limit === undefined) return null;
  const used = spent ?? 0;
  const share = Math.min(1, used / limit);
  return (
    <div>
      <div className="flex justify-between gap-3 text-xs text-secondary">
        <span>{label}</span>
        <span className="tabular-nums">
          {formatUsd(used)} of {formatUsd(limit)}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-hover">
        <div
          className={cn("h-full rounded-full", share >= 0.8 ? "bg-serious" : "bg-chart")}
          style={{ width: `${share * 100}%` }}
        />
      </div>
    </div>
  );
}

const low = ({ usd, warnBelowUsd }: { usd: number; warnBelowUsd?: number }) =>
  warnBelowUsd !== undefined && usd < warnBelowUsd;

export default async function AccountsPage() {
  const status = await getStatus();
  const now = Date.now();
  return (
    <>
      <AutoRefresh />
      <PageHeader title="Accounts" description="Each provider key, plan and gateway." />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {status.accounts.map((account) => {
          const plan = status.chatgpt.find((item) => item.account === account.id);
          const state = plan && plan.state !== "ok" ? plan.state : account.state;
          return (
            <Card key={account.id}>
              <CardHeader className="flex-row items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle className="break-all">{account.id}</CardTitle>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    <Badge>{account.costClass}</Badge>
                    <Badge>
                      {account.kind === "http" ? account.api : account.kind.replaceAll("_", " ")}
                    </Badge>
                  </div>
                </div>
                <StateBadge state={account.enabled ? state : "disabled"} />
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                <Budget
                  label="Today"
                  {...(account.spend.dayUsd === undefined ? {} : { spent: account.spend.dayUsd })}
                  {...(account.spend.dayLimitUsd === undefined
                    ? {}
                    : { limit: account.spend.dayLimitUsd })}
                />
                <Budget
                  label="This month"
                  {...(account.spend.monthUsd === undefined
                    ? {}
                    : { spent: account.spend.monthUsd })}
                  {...(account.spend.monthLimitUsd === undefined
                    ? {}
                    : { limit: account.spend.monthLimitUsd })}
                />
                {account.balance ? (
                  <p
                    className={cn("text-xs text-secondary", low(account.balance) && "text-serious")}
                  >
                    Balance {formatUsd(account.balance.usd)}
                    {account.balance.warnBelowUsd === undefined
                      ? ""
                      : `, warning below ${formatUsd(account.balance.warnBelowUsd)}`}
                  </p>
                ) : null}
                {account.limits.length > 0 ? (
                  <ul className="flex flex-col gap-1.5">
                    {account.limits.map((limit) => (
                      <li key={limit.scope} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <StateBadge state={limit.status} />
                        <span className="text-xs text-secondary">
                          {limit.scope === "*"
                            ? "whole account"
                            : limit.scope.replace("model:", "")}
                          {limit.retryAt ? `, retry ${formatRelative(limit.retryAt, now)}` : ""}
                          {limit.detail ? ` (${limit.detail})` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {plan ? (
                  <div className="flex flex-col gap-1 text-xs text-secondary">
                    <p>Sign-in renewed {formatTime(plan.renewedAt)}</p>
                    {plan.models ? <p>Plan models: {plan.models.join(", ")}</p> : null}
                    <a
                      className="underline underline-offset-2"
                      href={plan.manageUsage}
                      rel="noreferrer"
                    >
                      Manage usage
                    </a>
                  </div>
                ) : null}
                {account.limits.length > 0 ? (
                  <form action={resetAccountAction}>
                    <input type="hidden" name="id" value={account.id} />
                    <Button type="submit" variant="outline" size="sm">
                      Try again now
                    </Button>
                  </form>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}
