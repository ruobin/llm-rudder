import type { Notifier } from "./notifier.js";

interface Episode {
  requestedTier: string;
  servedTier: string;
  reason: string;
  since: number;
  noticed: Set<string>;
}

/** An episode, as shared with the other instances. */
export interface EpisodeRecord {
  requestedTier: string;
  servedTier: string;
  reason: string;
  since: number;
}

export interface EpisodeReplication {
  publish(tier: string, record: EpisodeRecord | null): void;
  noticed(tier: string, key: string): void;
}

const MAX_NOTICED_SESSIONS = 5000;
/** A new episode may not have reached the shared state yet. */
const NEW_EPISODE_MS = 30_000;

/**
 * Tracks periods when a tier is being served by another tier, so warnings are
 * sent once per period rather than once per request.
 */
export class FallbackEpisodes {
  private readonly active = new Map<string, Episode>();
  private replication: EpisodeReplication | null = null;

  constructor(
    private readonly notifier: Notifier,
    private readonly now: () => number = Date.now,
  ) {}

  replicateTo(replication: EpisodeReplication): void {
    this.replication = replication;
  }

  applyRecord(tier: string, record: EpisodeRecord | null): void {
    if (!record) {
      this.active.delete(tier);
      return;
    }
    this.active.set(tier, { ...record, noticed: this.active.get(tier)?.noticed ?? new Set() });
  }

  /** Matches the shared list, which also ends episodes whose end was never heard. */
  reconcile(shared: Map<string, EpisodeRecord>): void {
    for (const [tier, record] of shared) this.applyRecord(tier, record);
    const settled = this.now() - NEW_EPISODE_MS;
    for (const [tier, episode] of this.active) {
      if (!shared.has(tier) && episode.since < settled) this.active.delete(tier);
    }
  }

  applyNotice(tier: string, key: string): void {
    this.active.get(tier)?.noticed.add(key);
  }

  private share({ requestedTier, servedTier, reason, since }: Episode): void {
    this.replication?.publish(requestedTier, { requestedTier, servedTier, reason, since });
  }

  onFallback(requestedTier: string, servedTier: string, reason: string): void {
    const existing = this.active.get(requestedTier);
    if (existing) {
      const changed = existing.servedTier !== servedTier || existing.reason !== reason;
      existing.servedTier = servedTier;
      existing.reason = reason;
      if (changed) this.share(existing);
      this.notifier.emit(
        "tier_fallback_continuing",
        requestedTier,
        `${requestedTier} is still being served by ${servedTier} (${reason}).`,
      );
      return;
    }
    const episode: Episode = {
      requestedTier,
      servedTier,
      reason,
      since: this.now(),
      noticed: new Set(),
    };
    this.active.set(requestedTier, episode);
    this.share(episode);
    this.notifier.clear("tier_fallback_ended", requestedTier);
    this.notifier.suppress("tier_fallback_continuing", requestedTier);
    this.notifier.emit(
      "tier_fallback_started",
      requestedTier,
      `${requestedTier} is unavailable (${reason}). Requests now use ${servedTier}.`,
    );
  }

  onPrimary(requestedTier: string): void {
    if (!this.active.delete(requestedTier)) return;
    this.replication?.publish(requestedTier, null);
    this.notifier.clear("tier_fallback_started", requestedTier);
    this.notifier.emit(
      "tier_fallback_ended",
      requestedTier,
      `${requestedTier} is working again. Requests are back on it.`,
    );
  }

  /** True the first time a conversation should see the note in this episode. */
  takeNotice(requestedTier: string, clientId: string, sessionKey: string): boolean {
    const episode = this.active.get(requestedTier);
    if (!episode) return false;
    const key = `${clientId}\u0000${sessionKey}`;
    if (episode.noticed.has(key)) return false;
    if (episode.noticed.size >= MAX_NOTICED_SESSIONS) episode.noticed.clear();
    episode.noticed.add(key);
    this.replication?.noticed(requestedTier, key);
    return true;
  }

  list() {
    return [...this.active.values()].map(({ requestedTier, servedTier, reason, since }) => ({
      requestedTier,
      servedTier,
      reason,
      since,
    }));
  }
}
