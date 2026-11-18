import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader, Stat } from "@/components/page-header";
import { OutcomeBadge } from "@/components/status";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TD, TH } from "@/components/ui/table";
import { formatCount, formatDuration, formatTime, formatUsd } from "@/lib/format";
import { GatewayError, getRequest } from "@/lib/gateway";

export const metadata: Metadata = { title: "Request" };

const count = (value: number | null) => (value === null ? "–" : formatCount(value));

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const request = await getRequest(id).catch((error: unknown) => {
    if (error instanceof GatewayError && error.status === 404) notFound();
    throw error;
  });
  return (
    <>
      <Link href="/requests" className="text-sm text-secondary underline underline-offset-2">
        All requests
      </Link>
      <div className="mt-3">
        <PageHeader title={request.requestedModel} description={formatTime(request.startedAt)}>
          <OutcomeBadge outcome={request.outcome} />
        </PageHeader>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Client" value={request.clientId} />
        <Stat label="Served tier" value={request.servedTier ?? "–"} />
        <Stat label="Duration" value={formatDuration(request.durationMs)} />
        <Stat
          label="Status"
          value={request.httpStatus === null ? "–" : String(request.httpStatus)}
          note={request.stream ? "Streaming" : "Not streaming"}
        />
      </div>
      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Attempts</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <thead>
              <tr>
                <TH>#</TH>
                <TH>Target</TH>
                <TH>Outcome</TH>
                <TH className="text-right">First output</TH>
                <TH className="text-right">Duration</TH>
                <TH className="text-right">Input</TH>
                <TH className="text-right">Cached</TH>
                <TH className="text-right">Output</TH>
                <TH className="text-right">Cost</TH>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {request.attempts.map((attempt) => (
                <tr key={attempt.n}>
                  <TD>{attempt.n}</TD>
                  <TD>
                    {attempt.model}
                    <span className="block text-xs text-secondary">{attempt.accountId}</span>
                    {attempt.returnedModel && attempt.returnedModel !== attempt.model ? (
                      <span className="block text-xs text-warning">
                        Provider reported {attempt.returnedModel}
                      </span>
                    ) : null}
                  </TD>
                  <TD>
                    <OutcomeBadge outcome={attempt.outcome} />
                    {attempt.errorCode ? (
                      <span className="mt-1 block text-xs break-all text-secondary">
                        {attempt.httpStatus ? `HTTP ${attempt.httpStatus}, ` : ""}
                        {attempt.errorCode}
                      </span>
                    ) : null}
                  </TD>
                  <TD className="text-right whitespace-nowrap">{formatDuration(attempt.ttftMs)}</TD>
                  <TD className="text-right whitespace-nowrap">
                    {formatDuration(attempt.durationMs)}
                  </TD>
                  <TD className="text-right">{count(attempt.inputTokens)}</TD>
                  <TD className="text-right">{count(attempt.cachedTokens)}</TD>
                  <TD className="text-right">{count(attempt.outputTokens)}</TD>
                  <TD className="text-right">
                    {attempt.costUsd === null ? "–" : formatUsd(attempt.costUsd)}
                  </TD>
                </tr>
              ))}
            </tbody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
