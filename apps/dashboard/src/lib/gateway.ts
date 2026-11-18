import "server-only";
import { requireSession } from "./auth";
import { adminKey, gatewayUrl } from "./env";
import type {
  AttemptItem,
  ClientItem,
  GatewaySettings,
  GatewayStatus,
  RequestItem,
  RouterEvent,
  UsageReport,
} from "./types";

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  await requireSession();
  let response: Response;
  try {
    response = await fetch(`${gatewayUrl()}${path}`, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${adminKey()}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
  } catch {
    throw new GatewayError(503, "The gateway could not be reached.");
  }
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  if (!response.ok) {
    throw new GatewayError(
      response.status,
      body?.error?.message ?? `The gateway answered with HTTP ${response.status}.`,
    );
  }
  return body as T;
}

export const getStatus = () => call<GatewayStatus>("/router/status");
export const getSettings = () => call<GatewaySettings>("/router/settings");
export const getUsage = (days: number) => call<UsageReport>(`/router/usage?days=${days}`);

export const getEvents = async (limit: number) =>
  (await call<{ items: RouterEvent[] }>(`/router/events?limit=${limit}`)).items;

export const getClients = async () =>
  (await call<{ items: ClientItem[] }>("/router/clients")).items;

export interface RequestFilters {
  client?: string;
  outcome?: string;
  tier?: string;
  model?: string;
  before?: string;
}

export function getRequests(filters: RequestFilters) {
  const query = new URLSearchParams({ limit: "50" });
  for (const [name, value] of Object.entries(filters)) {
    if (value) query.set(name, value);
  }
  return call<{ items: RequestItem[]; nextBefore: string | null }>(`/router/requests?${query}`);
}

export const getRequest = (id: string) =>
  call<RequestItem & { attempts: AttemptItem[] }>(`/router/requests/${encodeURIComponent(id)}`);

export const resetAccount = (id: string) =>
  call<{ cleared: number }>(`/router/accounts/${encodeURIComponent(id)}/reset`, { method: "POST" });

export interface NewClientInput {
  id: string;
  notice: "text" | "none";
  rpm?: number;
  allowAccounts?: string[];
  allowFallback: boolean;
}

export const createClient = (input: NewClientInput) =>
  call<{ key: string; client: ClientItem }>("/router/clients", {
    method: "POST",
    body: JSON.stringify(input),
  });

export const revokeClient = (id: string) =>
  call<{ revoked: boolean }>(`/router/clients/${encodeURIComponent(id)}`, { method: "DELETE" });
