export interface RouterEvent {
  at: string;
  kind: string;
  subject: string;
  message: string;
}

export interface TargetStatus {
  id: string;
  account: string;
  model: string;
  available: boolean;
  reason?: string;
  retryAt?: string;
}

export interface TierStatus {
  name: string;
  fallbackTiers: string[];
  prefer: string;
  targets: TargetStatus[];
}

export interface AccountLimit {
  scope: string;
  status: string;
  retryAt?: string;
  detail?: string;
}

export interface AccountStatus {
  id: string;
  costClass: string;
  trust: string;
  kind: string;
  api: string;
  compat: string;
  enabled: boolean;
  state: string;
  limits: AccountLimit[];
  spend: { dayUsd?: number; monthUsd?: number; dayLimitUsd?: number; monthLimitUsd?: number };
  balance?: { usd: number; checkedAt?: string; warnBelowUsd?: number };
}

export interface ChatGptStatus {
  account: string;
  state: string;
  usingPlan: boolean;
  manageUsage: string;
  accessTokenExpiresAt?: string;
  renewedAt?: string;
  models?: string[];
}

export interface Fallback {
  requestedTier: string;
  servedTier: string;
  since?: string;
  reason?: string;
}

export interface EdgeReport {
  client: string;
  at?: string;
  edgeVersion: string;
  usage: Record<string, number>;
}

export interface GatewayStatus {
  uptimeS: number;
  draining: boolean;
  pricingVersion: string;
  pinnedConversations: number;
  chatgpt: ChatGptStatus[];
  fallbacks: Fallback[];
  tiers: TierStatus[];
  accounts: AccountStatus[];
  edges: EdgeReport[];
  recentEvents: RouterEvent[];
}

export interface UsageTotals {
  served: number;
  failed: number;
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsd: number;
  listValueUsd: number;
}

export interface UsageReport {
  from: string;
  to: string;
  totals: UsageTotals;
  byDay: (UsageTotals & { day: string })[];
  byClient: (UsageTotals & { clientId: string })[];
  byAccount: (UsageTotals & { accountId: string })[];
  byModel: (UsageTotals & { model: string })[];
}

export interface RequestItem {
  id: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  clientId: string;
  requestedModel: string;
  requestedTier: string | null;
  servedTier: string | null;
  servedTarget: string | null;
  stream: boolean;
  outcome: string;
  httpStatus: number | null;
  attemptCount: number;
}

export interface AttemptItem {
  n: number;
  targetId: string;
  accountId: string;
  model: string;
  returnedModel: string | null;
  startedAt: string;
  ttftMs: number | null;
  durationMs: number;
  httpStatus: number | null;
  outcome: string;
  errorCode: string | null;
  inputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  listValueUsd: number | null;
}

export interface ClientItem {
  id: string;
  source: "config" | "dashboard";
  notice: string;
  rpm?: number;
  maxConcurrent: number;
  allowAccounts?: string[];
  allowFallback: boolean;
  edge: boolean;
  keyPrefix?: string;
  createdAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface GatewaySettings {
  pricingVersion: string;
  canReload: boolean;
  routing: {
    maxAttemptsPerTier: number;
    deadlineMs: number;
    preferSameFormat: boolean;
    healthOrder: boolean;
  };
  timeouts: Record<string, number>;
  retention: { ledgerDays: number; eventsDays: number };
  notifications: { ntfy: boolean; webhook: boolean; telegram: boolean; repeatAfterMs: number };
  aliases: { match: string; tier: string }[];
  tiers: {
    name: string;
    fallbackTiers: string[];
    prefer: string;
    targets: { id: string; account: string; model: string }[];
  }[];
}
