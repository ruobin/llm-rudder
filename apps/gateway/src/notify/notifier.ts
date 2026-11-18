export type EventKind =
  | "tier_fallback_started"
  | "tier_fallback_continuing"
  | "tier_fallback_ended"
  | "account_exhausted"
  | "account_recovered"
  | "account_disabled"
  | "budget_reached"
  | "balance_low"
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

/** Keeps several instances from sending the same notification. */
export interface NotifierCoordinator {
  claim(key: string, ttlMs: number): Promise<boolean>;
  shareEvent(event: RouterEvent): void;
  shareCleared(key: string): void;
  shareSuppressed(key: string, at: number, ttlMs: number): void;
}

const RECENT_LIMIT = 100;
const SINK_TIMEOUT_MS = 5000;
const MIN_CLAIM_MS = 1000;
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
        Title: "llm-rudder",
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

const TELEGRAM_API = "https://api.telegram.org";

export function telegramSink(botToken: string, chatId: string, apiUrl = TELEGRAM_API): EventSink {
  return async (event) => {
    let ok = false;
    try {
      const response = await fetch(`${apiUrl}/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `llm-rudder: ${event.message}`,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(SINK_TIMEOUT_MS),
      });
      ok = response.ok;
    } catch {
      ok = false;
    }
    // The address holds the bot token, so errors must not carry it into the logs.
    if (!ok) throw new Error("Telegram did not accept the notification.");
  };
}

const eventKey = (kind: EventKind, subject: string) => `${kind}\u0000${subject}`;

/** Records events and pushes them, sending each repeating event at most once per window. */
export class Notifier {
  private readonly lastSent = new Map<string, number>();
  private readonly recentEvents: RouterEvent[] = [];
  private readonly pending = new Set<Promise<void>>();
  private coordinator: NotifierCoordinator | null = null;

  constructor(
    private readonly sinks: EventSink[],
    private readonly repeatAfterMs: number,
    private readonly now: () => number = Date.now,
    private readonly persistence?: EventPersistence,
    private readonly onSinkError?: (error: unknown) => void,
  ) {}

  coordinateWith(coordinator: NotifierCoordinator): void {
    this.coordinator = coordinator;
  }

  private get claimMs(): number {
    return Math.max(this.repeatAfterMs, MIN_CLAIM_MS);
  }

  private remember(event: RouterEvent): void {
    this.recentEvents.push(event);
    if (this.recentEvents.length > RECENT_LIMIT) this.recentEvents.shift();
  }

  private deliver(event: RouterEvent): void {
    this.remember(event);
    this.persistence?.saveEvent(event);
    for (const sink of this.sinks) {
      const delivery = sink(event)
        .catch((error: unknown) => this.onSinkError?.(error))
        .finally(() => this.pending.delete(delivery));
      this.pending.add(delivery);
    }
  }

  emit(kind: EventKind, subject: string, message: string): boolean {
    const now = this.now();
    const key = eventKey(kind, subject);
    const last = this.lastSent.get(key);
    if (last !== undefined && now - last < this.repeatAfterMs) return false;
    this.lastSent.set(key, now);

    const event: RouterEvent = { at: now, kind, subject, message };
    const { coordinator } = this;
    if (!coordinator) {
      this.deliver(event);
      return true;
    }
    // Whichever instance claims the event first is the one that sends it.
    const claim = coordinator
      .claim(key, this.claimMs)
      .then((claimed) => {
        if (!claimed) return;
        coordinator.shareEvent(event);
        this.deliver(event);
      })
      .catch((error: unknown) => this.onSinkError?.(error))
      .finally(() => this.pending.delete(claim));
    this.pending.add(claim);
    return true;
  }

  /** Allows the next event of this kind and subject to be sent right away. */
  clear(kind: EventKind, subject: string): void {
    const key = eventKey(kind, subject);
    this.lastSent.delete(key);
    this.coordinator?.shareCleared(key);
  }

  /** Treats this event as just sent, so it waits a full window. */
  suppress(kind: EventKind, subject: string): void {
    const key = eventKey(kind, subject);
    const now = this.now();
    this.lastSent.set(key, now);
    this.coordinator?.shareSuppressed(key, now, this.claimMs);
  }

  /** Records an event that another instance sent. */
  applyEvent(event: RouterEvent): void {
    this.lastSent.set(eventKey(event.kind, event.subject), event.at);
    this.remember(event);
  }

  applyCleared(key: string): void {
    this.lastSent.delete(key);
  }

  applySuppressed(key: string, at: number): void {
    this.lastSent.set(key, at);
  }

  recent(): RouterEvent[] {
    return [...this.recentEvents].reverse();
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }
}
