export type EventKind =
  | "tier_fallback_started"
  | "tier_fallback_continuing"
  | "tier_fallback_ended"
  | "account_exhausted"
  | "account_recovered"
  | "account_disabled"
  | "budget_reached"
  | "metered_first_use";

export interface RouterEvent {
  at: number;
  kind: EventKind;
  subject: string;
  message: string;
}

export interface EventPersistence {
  saveEvent(event: RouterEvent): void;
}

export type EventSink = (event: RouterEvent) => Promise<void>;

const RECENT_LIMIT = 100;
const SINK_TIMEOUT_MS = 5000;
const URGENT_KINDS = new Set<EventKind>([
  "tier_fallback_started",
  "account_disabled",
  "budget_reached",
]);

export function ntfySink(url: string): EventSink {
  return async (event) => {
    await fetch(url, {
      method: "POST",
      headers: {
        Title: "llm-router",
        Tags: event.kind.includes("recovered") || event.kind.endsWith("ended") ? "ok" : "warning",
        Priority: URGENT_KINDS.has(event.kind) ? "4" : "3",
      },
      body: event.message,
      signal: AbortSignal.timeout(SINK_TIMEOUT_MS),
    });
  };
}

export function webhookSink(url: string): EventSink {
  return async (event) => {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...event, at: new Date(event.at).toISOString() }),
      signal: AbortSignal.timeout(SINK_TIMEOUT_MS),
    });
  };
}

/** Records events and pushes them, sending each repeating event at most once per window. */
export class Notifier {
  private readonly lastSent = new Map<string, number>();
  private readonly recentEvents: RouterEvent[] = [];
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly sinks: EventSink[],
    private readonly repeatAfterMs: number,
    private readonly now: () => number = Date.now,
    private readonly persistence?: EventPersistence,
    private readonly onSinkError?: (error: unknown) => void,
  ) {}

  emit(kind: EventKind, subject: string, message: string): boolean {
    const now = this.now();
    const key = `${kind}\u0000${subject}`;
    const last = this.lastSent.get(key);
    if (last !== undefined && now - last < this.repeatAfterMs) return false;
    this.lastSent.set(key, now);

    const event: RouterEvent = { at: now, kind, subject, message };
    this.recentEvents.push(event);
    if (this.recentEvents.length > RECENT_LIMIT) this.recentEvents.shift();
    this.persistence?.saveEvent(event);

    for (const sink of this.sinks) {
      const delivery = sink(event)
        .catch((error: unknown) => this.onSinkError?.(error))
        .finally(() => this.pending.delete(delivery));
      this.pending.add(delivery);
    }
    return true;
  }

  /** Allows the next event of this kind and subject to be sent right away. */
  clear(kind: EventKind, subject: string): void {
    this.lastSent.delete(`${kind}\u0000${subject}`);
  }

  /** Treats this event as just sent, so it waits a full window. */
  suppress(kind: EventKind, subject: string): void {
    this.lastSent.set(`${kind}\u0000${subject}`, this.now());
  }

  recent(): RouterEvent[] {
    return [...this.recentEvents].reverse();
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }
}
