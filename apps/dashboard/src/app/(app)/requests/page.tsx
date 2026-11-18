import type { Metadata } from "next";
import Link from "next/link";
import { Empty, PageHeader } from "@/components/page-header";
import { OutcomeBadge } from "@/components/status";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { Table, TD, TH } from "@/components/ui/table";
import { formatDuration, formatTime } from "@/lib/format";
import { getRequests, type RequestFilters } from "@/lib/gateway";

export const metadata: Metadata = { title: "Requests" };

const OUTCOMES = [
  "ok",
  "quota_exhausted",
  "rate_limited",
  "overloaded",
  "upstream_error",
  "timeout",
  "auth",
  "unsupported",
  "context_overflow",
  "client_error",
  "refusal",
  "mid_stream_failure",
  "client_aborted",
];

export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const text = (name: string) => {
    const value = params[name];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const filters: RequestFilters = {};
  for (const name of ["client", "outcome", "tier", "model", "before"] as const) {
    const value = text(name);
    if (value) filters[name] = value;
  }
  const { items, nextBefore } = await getRequests(filters);
  const older = new URLSearchParams({ ...filters, ...(nextBefore ? { before: nextBefore } : {}) });

  return (
    <>
      <PageHeader
        title="Requests"
        description="Routing details only. Prompts and answers are never stored."
      />
      <Card className="mb-4">
        <CardContent className="pt-4 sm:pt-5">
          <form className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="client">Client</Label>
              <Input id="client" name="client" defaultValue={filters.client} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tier">Tier</Label>
              <Input id="tier" name="tier" defaultValue={filters.tier} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="model">Requested model</Label>
              <Input id="model" name="model" defaultValue={filters.model} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="outcome">Outcome</Label>
              <Select id="outcome" name="outcome" defaultValue={filters.outcome ?? ""}>
                <option value="">Any</option>
                {OUTCOMES.map((outcome) => (
                  <option key={outcome} value={outcome}>
                    {outcome === "ok" ? "served" : outcome.replaceAll("_", " ")}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex gap-2">
              <Button type="submit" variant="outline">
                Filter
              </Button>
              <Link href="/requests" className={buttonVariants({ variant: "ghost" })}>
                Clear
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-2 sm:pt-3">
          {items.length === 0 ? (
            <Empty>No requests match.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <TH>Time</TH>
                  <TH>Client</TH>
                  <TH>Requested</TH>
                  <TH>Served by</TH>
                  <TH>Outcome</TH>
                  <TH className="text-right">Attempts</TH>
                  <TH className="text-right">Duration</TH>
                </tr>
              </thead>
              <tbody>
                {items.map((request) => (
                  <tr key={request.id} className="hover:bg-hover">
                    <TD className="whitespace-nowrap">
                      <Link
                        className="underline-offset-2 hover:underline"
                        href={`/requests/${request.id}`}
                      >
                        {formatTime(request.startedAt)}
                      </Link>
                    </TD>
                    <TD>{request.clientId}</TD>
                    <TD className="break-all">{request.requestedModel}</TD>
                    <TD className="break-all text-secondary">{request.servedTarget ?? "–"}</TD>
                    <TD>
                      <OutcomeBadge outcome={request.outcome} />
                    </TD>
                    <TD className="text-right tabular-nums">{request.attemptCount}</TD>
                    <TD className="text-right whitespace-nowrap tabular-nums">
                      {formatDuration(request.durationMs)}
                    </TD>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {nextBefore ? (
            <div className="mt-3">
              <Link
                href={`/requests?${older}`}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Older requests
              </Link>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}
