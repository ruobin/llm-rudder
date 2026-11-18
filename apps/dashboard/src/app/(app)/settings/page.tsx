import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TD, TH } from "@/components/ui/table";
import { formatDuration } from "@/lib/format";
import { getSettings } from "@/lib/gateway";

export const metadata: Metadata = { title: "Settings" };

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border py-2 text-sm last:border-0">
      <dt className="text-secondary">{label}</dt>
      <dd className="text-right tabular-nums">{children}</dd>
    </div>
  );
}

const onOff = (value: boolean) => (
  <Badge tone={value ? "good" : "neutral"}>{value ? "On" : "Off"}</Badge>
);

export default async function SettingsPage() {
  const settings = await getSettings();
  const { routing, retention, notifications, timeouts } = settings;
  return (
    <>
      <PageHeader
        title="Settings"
        description="Read from config/config.yaml on the server. Edit that file to change them."
      />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Routing</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <Row label="Attempts per tier">{routing.maxAttemptsPerTier}</Row>
              <Row label="Time to reach first output">{formatDuration(routing.deadlineMs)}</Row>
              <Row label="Prefer the client's API format">{onOff(routing.preferSameFormat)}</Row>
              <Row label="First byte timeout">{formatDuration(timeouts.firstByteMs)}</Row>
              <Row label="Stream idle timeout">{formatDuration(timeouts.streamIdleMs)}</Row>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Records and notifications</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <Row label="Keep request details">{retention.ledgerDays} days</Row>
              <Row label="Keep events">{retention.eventsDays} days</Row>
              <Row label="Pricing version">{settings.pricingVersion}</Row>
              <Row label="ntfy">{onOff(notifications.ntfy)}</Row>
              <Row label="Webhook">{onOff(notifications.webhook)}</Row>
            </dl>
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Tiers</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <thead>
                <tr>
                  <TH>Tier</TH>
                  <TH>Targets, in order</TH>
                  <TH>Falls back to</TH>
                  <TH>Preference</TH>
                </tr>
              </thead>
              <tbody>
                {settings.tiers.map((tier) => (
                  <tr key={tier.name}>
                    <TD className="font-medium">{tier.name}</TD>
                    <TD>
                      {tier.targets.map((target) => (
                        <span key={target.id} className="block">
                          {target.model}{" "}
                          <span className="text-xs text-secondary">on {target.account}</span>
                        </span>
                      ))}
                    </TD>
                    <TD>{tier.fallbackTiers.join(", ") || "–"}</TD>
                    <TD>{tier.prefer}</TD>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardContent>
        </Card>
        {settings.aliases.length > 0 ? (
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Model names clients may use</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {settings.aliases.map((alias) => (
                <Badge key={alias.match}>
                  {alias.match} → {alias.tier}
                </Badge>
              ))}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}
