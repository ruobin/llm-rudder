import type { Logger } from "pino";
import type { SharedBackend } from "./backend.js";

const HEARTBEAT_MS = 5_000;
const INSTANCE_EXPIRY_MS = 20_000;
const INSTANCES_MAP = "instances";

export type Attempted<T> = { ok: true; value: T } | { ok: false };

interface Envelope {
  from: string;
  topic: string;
  data: unknown;
}

interface InstanceRecord {
  startedAt: number;
  seenAt: number;
}

/**
 * Connects this gateway to the others that share its work. Requests never wait for it to
 * recover: when the shared state is out of reach, every instance carries on by itself.
 */
export class Cluster {
  private readonly handlers = new Map<string, ((data: never) => void)[]>();
  private readonly syncTasks: (() => Promise<void>)[] = [];
  private readonly pending = new Set<Promise<unknown>>();
  private readonly startedAt: number;
  private heartbeat: NodeJS.Timeout | null = null;
  private syncing: Promise<void> | null = null;
  private syncAgain = false;
  private usingOwnState = false;
  private instances = new Map<string, InstanceRecord>();

  constructor(
    private readonly backend: SharedBackend | null,
    readonly instanceId: string,
    private readonly now: () => number,
    private readonly log: Logger,
  ) {
    this.startedAt = now();
  }

  get enabled(): boolean {
    return this.backend !== null;
  }

  get connected(): boolean {
    return this.backend?.ready === true;
  }

  /** How many instances are sharing the work, counting this one. */
  get instanceCount(): number {
    return Math.max(this.liveInstances().length, 1);
  }

  private liveInstances(): [string, InstanceRecord][] {
    const oldest = this.now() - INSTANCE_EXPIRY_MS;
    return [...this.instances].filter(([, record]) => record.seenAt >= oldest);
  }

  on<T>(topic: string, handler: (data: T) => void): void {
    this.handlers.set(topic, [
      ...(this.handlers.get(topic) ?? []),
      handler as (data: never) => void,
    ]);
  }

  /** Runs after every connection, to bring this instance and the shared state together. */
  onSync(task: () => Promise<void>): void {
    this.syncTasks.push(task);
  }

  private noteFailure(error: unknown): void {
    if (this.usingOwnState) return;
    this.usingOwnState = true;
    this.log.warn(
      { err: error },
      "the shared state is unavailable, so this instance is using its own",
    );
  }

  private noteWorking(): void {
    if (!this.usingOwnState) return;
    this.usingOwnState = false;
    this.log.info("the shared state is available again");
  }

  /** Runs one operation on the shared state, reporting failure rather than throwing. */
  async attempt<T>(operation: (backend: SharedBackend) => Promise<T>): Promise<Attempted<T>> {
    if (!this.backend?.ready) return { ok: false };
    try {
      return { ok: true, value: await operation(this.backend) };
    } catch (error) {
      this.noteFailure(error);
      return { ok: false };
    }
  }

  /** Runs an operation that nothing has to wait for. */
  background(operation: (backend: SharedBackend) => Promise<unknown>): void {
    if (!this.enabled) return;
    const task = this.attempt(operation).finally(() => this.pending.delete(task));
    this.pending.add(task);
  }

  publish(topic: string, data: unknown): void {
    const envelope: Envelope = { from: this.instanceId, topic, data };
    this.background((backend) => backend.publish(JSON.stringify(envelope)));
  }

  private receive(text: string): void {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(text) as Envelope;
    } catch {
      return;
    }
    if (envelope.from === this.instanceId) return;
    for (const handler of this.handlers.get(envelope.topic) ?? []) {
      try {
        handler(envelope.data as never);
      } catch (error) {
        this.log.warn({ err: error, topic: envelope.topic }, "a cluster message failed");
      }
    }
  }

  private async beat(): Promise<void> {
    const record: InstanceRecord = { startedAt: this.startedAt, seenAt: this.now() };
    const entries = await this.attempt(async (backend) => {
      await backend.mapSet(INSTANCES_MAP, this.instanceId, JSON.stringify(record));
      return backend.mapEntries(INSTANCES_MAP);
    });
    if (!entries.ok) return;
    this.noteWorking();
    const oldest = this.now() - INSTANCE_EXPIRY_MS;
    const instances = new Map<string, InstanceRecord>();
    for (const [id, text] of entries.value) {
      const seen = JSON.parse(text) as InstanceRecord;
      if (seen.seenAt >= oldest) instances.set(id, seen);
      else this.background((backend) => backend.mapDelete(INSTANCES_MAP, id));
    }
    this.instances = instances;
  }

  private sync(): void {
    if (this.syncing) {
      this.syncAgain = true;
      return;
    }
    this.syncing = (async () => {
      do {
        this.syncAgain = false;
        await this.beat();
        for (const task of this.syncTasks) {
          try {
            await task();
          } catch (error) {
            this.noteFailure(error);
          }
        }
      } while (this.syncAgain && this.connected);
    })().finally(() => {
      this.syncing = null;
    });
  }

  /** Connects if a shared state is configured. A failure here does not stop the gateway. */
  async start(): Promise<void> {
    if (!this.backend) return;
    await this.backend.start({
      onMessage: (text) => this.receive(text),
      onReady: () => this.sync(),
      onLost: (error) => this.noteFailure(error),
    });
    await this.syncing;
    this.on("cluster.changed", () => this.background(() => this.beat()));
    this.publish("cluster.changed", {});
    this.heartbeat = setInterval(() => void this.beat(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  /** Resolves when the work this instance started has finished. */
  async settled(): Promise<void> {
    while (this.pending.size > 0 || this.syncing) {
      await Promise.all([...this.pending, this.syncing]);
    }
  }

  async stop(): Promise<void> {
    if (!this.backend) return;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    await this.settled();
    await this.attempt((backend) => backend.mapDelete(INSTANCES_MAP, this.instanceId));
    this.publish("cluster.changed", {});
    await this.settled();
    await this.backend.stop();
  }

  status() {
    return {
      mode: this.enabled ? ("shared" as const) : ("single" as const),
      connected: this.connected,
      instanceId: this.instanceId,
      instances: this.liveInstances().map(([id, record]) => ({
        id,
        startedAt: new Date(record.startedAt).toISOString(),
        lastSeenAt: new Date(record.seenAt).toISOString(),
      })),
    };
  }
}
