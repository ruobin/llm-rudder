import type { Metadata } from "next";
import { CreateClientForm, RevokeButton } from "@/components/forms";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TD, TH } from "@/components/ui/table";
import { formatTime } from "@/lib/format";
import { getClients, getStatus } from "@/lib/gateway";

export const metadata: Metadata = { title: "Clients" };

export default async function ClientsPage() {
  const [clients, status] = await Promise.all([getClients(), getStatus()]);
  const accounts = status.accounts
    .filter((account) => account.kind !== "edge_only")
    .map((account) => account.id);
  return (
    <>
      <PageHeader
        title="Clients"
        description="Each app has its own key, so one can be revoked alone."
      />
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardContent className="pt-2 sm:pt-3">
            <Table>
              <thead>
                <tr>
                  <TH>Client</TH>
                  <TH>Key</TH>
                  <TH>Limits</TH>
                  <TH>Last used</TH>
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                </tr>
              </thead>
              <tbody>
                {clients.map((client) => (
                  <tr key={client.id}>
                    <TD className="font-medium">
                      {client.id}
                      {client.revokedAt ? (
                        <Badge tone="critical" className="ml-2">
                          Revoked
                        </Badge>
                      ) : null}
                    </TD>
                    <TD className="font-mono text-xs whitespace-nowrap text-secondary">
                      {client.source === "config" ? "from .env" : `${client.keyPrefix}…`}
                    </TD>
                    <TD className="text-xs text-secondary">
                      {client.rpm ? `${client.rpm} per minute` : "No rate limit"}
                      {client.allowAccounts ? (
                        <span className="block">Only {client.allowAccounts.join(", ")}</span>
                      ) : null}
                    </TD>
                    <TD className="text-xs whitespace-nowrap text-secondary">
                      {client.source === "config"
                        ? "Not tracked"
                        : client.lastUsedAt
                          ? formatTime(client.lastUsedAt)
                          : "Never"}
                    </TD>
                    <TD className="text-right">
                      {client.source === "dashboard" && !client.revokedAt ? (
                        <RevokeButton id={client.id} />
                      ) : null}
                    </TD>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>New client key</CardTitle>
            <CardDescription>The key works as soon as it is created.</CardDescription>
          </CardHeader>
          <CardContent>
            <CreateClientForm accounts={accounts} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
