import type { Notifier } from "./notifier.js";

interface Episode {
  requestedTier: string;
  servedTier: string;
  reason: string;
  since: number;
  noticed: Set<string>;
}

const MAX_NOTICED_SESSIONS = 5000;

/**
 * Tracks periods when a tier is being served by another tier, so warnings are
 * sent once per period rather than once per request.
 */
export class FallbackEpisodes {
  private readonly active = new Map<string, Episode>();

  constructor(
    private readonly notifier: Notifier,
    private readonly now: () => number = Date.now,
  ) {}

  onFallback(requestedTier: string, servedTier: string, reason: string): void {
    const existing = this.active.get(requestedTier);
    if (existing) {
      existing.servedTier = servedTier;
      existing.reason = reason;
      this.notifier.emit(
        "tier_fallback_continuing",
        requestedTier,
        `${requestedTier} is still being served by ${servedTier} (${reason}).`,
      );
      return;
    }
    this.active.set(requestedTier, {
      requestedTier,
      servedTier,
      reason,
      since: this.now(),
      noticed: new Set(),
    });
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
