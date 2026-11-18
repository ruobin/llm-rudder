import type { StoredClientKey } from "../auth/clients.js";
import { ConfigError } from "../config/load.js";
import type { RequestContext } from "../execution/context.js";
import type { EpisodeRecord } from "../notify/episodes.js";
import type { RouterEvent } from "../notify/notifier.js";
import type { PinRecord } from "../routing/pins.js";
import { PIN_IDLE_MS } from "../routing/pins.js";
import { reloadConfig, type EdgeStatus, type Runtime } from "../runtime.js";
import type { QuotaRecord } from "../state/quota.js";
import { isNewerRecord } from "../state/quota.js";
import type { ReasoningEntry } from "../translate/artifacts.js";
import { requestIR } from "../translate/protocol.js";
import { parsePinValue } from "./backend.js";

const ARTIFACT_TTL_MS = 6 * 60 * 60_000;
const MAX_ARTIFACTS_PER_REQUEST = 200;

const quotaField = (record: { accountId: string; scope: string }) =>
  `${record.accountId}\u0000${record.scope}`;
const toolExtraKey = (clientId: string, callId: string) => `extra:${clientId}\u0000${callId}`;
const reasoningKey = (clientId: string, callId: string) => `reasoning:${clientId}\u0000${callId}`;

function replicateQuota({ cluster, quota }: Runtime): void {
  const store = (record: QuotaRecord) =>
    cluster.background((backend) =>
      record.state
        ? backend.mapSet("quota", quotaField(record), JSON.stringify(record))
        : backend.mapDelete("quota", quotaField(record)),
    );
  quota.replicateTo({
    instanceId: cluster.instanceId,
    publish(record) {
      cluster.publish("quota", record);
      store(record);
    },
  });
  cluster.on<QuotaRecord>("quota", (record) => quota.applyRecord(record));
  cluster.onSync(async () => {
    const entries = await cluster.attempt((backend) => backend.mapEntries("quota"));
    if (!entries.ok) return;
    const shared = new Map<string, QuotaRecord>();
    for (const [field, text] of entries.value) {
      const record = JSON.parse(text) as QuotaRecord;
      shared.set(field, record);
      quota.applyRecord(record);
    }
    // Whatever changed here while the shared state was away goes back to it.
    for (const record of quota.records()) {
      const known = shared.get(quotaField(record));
      if (known ? isNewerRecord(record, known) : record.state !== null) {
        store(record);
        cluster.publish("quota", record);
      }
    }
  });
}

function replicatePins({ cluster, pins, now }: Runtime): void {
  pins.replicateTo({
    move(field, seenAtStart, targetId, at) {
      cluster.background(async (backend) => {
        const winner = await backend.setPin(field, seenAtStart, targetId, at, PIN_IDLE_MS);
        pins.applyRecord({ field, targetId: winner, at }, true);
        cluster.publish("pin", { field, targetId: winner, at } satisfies PinRecord);
      });
    },
    release(field) {
      cluster.publish("pin", { field, targetId: null, at: now() } satisfies PinRecord);
      cluster.background((backend) => backend.mapDelete("pins", field));
    },
    prune(cutoff) {
      cluster.background(async (backend) => {
        for (const [field, text] of await backend.mapEntries("pins")) {
          const pin = parsePinValue(text);
          if (!pin || pin.at < cutoff) await backend.mapDelete("pins", field);
        }
      });
    },
  });
  cluster.on<PinRecord>("pin", (record) => pins.applyRecord(record));
  cluster.onSync(async () => {
    const entries = await cluster.attempt((backend) => backend.mapEntries("pins"));
    if (!entries.ok) return;
    for (const [field, text] of entries.value) {
      const pin = parsePinValue(text);
      if (pin) pins.applyRecord({ field, targetId: pin.target, at: pin.at });
    }
  });
}

function replicateEpisodes({ cluster, episodes }: Runtime): void {
  episodes.replicateTo({
    publish(tier, record) {
      cluster.publish("episode", { tier, record });
      cluster.background((backend) =>
        record
          ? backend.mapSet("episodes", tier, JSON.stringify(record))
          : backend.mapDelete("episodes", tier),
      );
    },
    noticed(tier, key) {
      cluster.publish("episode.notice", { tier, key });
    },
  });
  cluster.on<{ tier: string; record: EpisodeRecord | null }>("episode", ({ tier, record }) =>
    episodes.applyRecord(tier, record),
  );
  cluster.on<{ tier: string; key: string }>("episode.notice", ({ tier, key }) =>
    episodes.applyNotice(tier, key),
  );
  cluster.onSync(async () => {
    const entries = await cluster.attempt((backend) => backend.mapEntries("episodes"));
    if (!entries.ok) return;
    for (const [tier, text] of entries.value) {
      episodes.applyRecord(tier, JSON.parse(text) as EpisodeRecord);
    }
  });
}

function replicateNotifications({ cluster, notifier }: Runtime): void {
  const claimKey = (key: string) => `notified:${key}`;
  notifier.coordinateWith({
    async claim(key, ttlMs) {
      const claimed = await cluster.attempt((backend) => backend.claim(claimKey(key), ttlMs));
      // Two copies of a warning are better than none.
      return claimed.ok ? claimed.value : true;
    },
    shareEvent: (event) => cluster.publish("notify.event", event),
    shareCleared(key) {
      cluster.publish("notify.clear", { key });
      cluster.background((backend) => backend.unclaim(claimKey(key)));
    },
    shareSuppressed(key, at, ttlMs) {
      cluster.publish("notify.suppress", { key, at });
      cluster.background((backend) => backend.forceClaim(claimKey(key), ttlMs));
    },
  });
  cluster.on<RouterEvent>("notify.event", (event) => notifier.applyEvent(event));
  cluster.on<{ key: string }>("notify.clear", ({ key }) => notifier.applyCleared(key));
  cluster.on<{ key: string; at: number }>("notify.suppress", ({ key, at }) =>
    notifier.applySuppressed(key, at),
  );
}

function replicateSettings(runtime: Runtime): void {
  const { cluster, clients, persistence, edgeReports, log } = runtime;
  cluster.on("clients.changed", () => {
    void persistence
      .loadClientKeys()
      .then((keys: StoredClientKey[]) => clients.load(keys))
      .catch((error: unknown) => log.warn({ err: error }, "client keys could not be reloaded"));
  });
  cluster.on("config.reload", () => {
    try {
      reloadConfig(runtime);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      log.error({ problems: error.problems }, "the new configuration was rejected");
    }
  });
  cluster.on<{ client: string; report: EdgeStatus }>("edge.report", ({ client, report }) =>
    edgeReports.set(client, report),
  );
}

function replicateArtifacts({ cluster, toolExtras, reasoning }: Runtime): void {
  toolExtras.onStored = (clientId, callId, value) =>
    cluster.background((backend) =>
      backend.putValue(toolExtraKey(clientId, callId), JSON.stringify(value), ARTIFACT_TTL_MS),
    );
  reasoning.onStored = (clientId, callId, entry) =>
    cluster.background((backend) =>
      backend.putValue(reasoningKey(clientId, callId), JSON.stringify(entry), ARTIFACT_TTL_MS),
    );
}

/** Makes this instance's state follow, and contribute to, the shared state. */
export function replicateRuntimeState(runtime: Runtime): void {
  if (!runtime.cluster.enabled) return;
  replicateQuota(runtime);
  replicatePins(runtime);
  replicateEpisodes(runtime);
  replicateNotifications(runtime);
  replicateSettings(runtime);
  replicateArtifacts(runtime);
  runtime.budgets.joinCluster();
}

function toolCallIds(ctx: RequestContext): string[] {
  const ids = new Set<string>();
  for (const message of requestIR(ctx).messages) {
    for (const block of message.blocks) {
      if (block.type === "tool_call") ids.add(block.id);
      else if (block.type === "tool_result") ids.add(block.callId);
    }
  }
  return [...ids].slice(-MAX_ARTIFACTS_PER_REQUEST);
}

/**
 * Fetches what earlier turns left on other instances: reasoning and tool-call extras that
 * this request's tool calls need back. Without it, a tool loop would depend on one instance.
 */
export async function loadSharedArtifacts(rt: Runtime, ctx: RequestContext): Promise<void> {
  if (!rt.cluster.connected) return;
  const client = ctx.client.id;
  const ids = toolCallIds(ctx);
  const missing = [
    ...ids
      .filter((id) => !rt.toolExtras.has(client, id))
      .map((id) => ({ id, key: toolExtraKey(client, id), reasoning: false })),
    ...ids
      .filter((id) => !rt.reasoning.has(client, id))
      .map((id) => ({ id, key: reasoningKey(client, id), reasoning: true })),
  ];
  if (missing.length === 0) return;
  const values = await rt.cluster.attempt((backend) =>
    backend.getValues(missing.map(({ key }) => key)),
  );
  if (!values.ok) return;
  missing.forEach(({ id, reasoning }, index) => {
    const text = values.value[index];
    if (typeof text !== "string") return;
    if (reasoning) rt.reasoning.restore(client, id, JSON.parse(text) as ReasoningEntry);
    else rt.toolExtras.restore(client, id, JSON.parse(text));
  });
}
