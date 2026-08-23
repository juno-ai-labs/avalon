/**
 * Shared lifecycle primitives for Durable Objects that own complete agent runs.
 *
 * Product state stays in the concrete object. This module owns only the parts
 * that must behave identically for every durable agent: one in-memory drain per
 * isolate, reference-counted alarm heartbeats, and deterministic retry timing.
 */
export class DurableAgentKeepAlive {
  private references = 0;

  constructor(private readonly reschedule: () => Promise<void>) {}

  get active(): boolean {
    return this.references > 0;
  }

  async keepAlive(): Promise<() => void> {
    this.references += 1;
    if (this.references === 1) await this.reschedule();
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.references = Math.max(0, this.references - 1);
      if (this.references === 0) void this.reschedule().catch(() => undefined);
    };
  }

  async while<T>(operation: () => Promise<T>): Promise<T> {
    const dispose = await this.keepAlive();
    try {
      return await operation();
    } finally {
      dispose();
    }
  }

  alarmDueAt(durableDueAt: number | null, now = Date.now(), intervalMs = 30_000): number | null {
    if (!this.active) return durableDueAt;
    const heartbeat = now + intervalMs;
    return durableDueAt === null ? heartbeat : Math.min(durableDueAt, heartbeat);
  }
}

/** One drain promise per isolate; durable SQL remains the restart authority. */
export class DurableAgentDrain {
  private activeDrain: Promise<void> | null = null;
  private activeSinceAt: number | null = null;
  private lastProgressAt: number | null = null;

  get active(): boolean {
    return this.activeDrain !== null;
  }

  get activeSince(): number | null {
    return this.activeSinceAt;
  }

  get lastProgress(): number | null {
    return this.lastProgressAt;
  }

  /** Records synchronous progress made by the invocation that owns the drain. */
  touch(now = Date.now()): void {
    if (this.activeDrain) this.lastProgressAt = now;
  }

  /**
   * Forgets an active promise only after the caller's durable lease proves its
   * owner is gone. This does not cancel the old continuation; its identity
   * fence below prevents a late `finally` from clearing a successor drain.
   */
  abandonActive(): boolean {
    if (!this.activeDrain) return false;
    this.activeDrain = null;
    this.activeSinceAt = null;
    this.lastProgressAt = null;
    return true;
  }

  /**
   * Starts one drain and gives it an identity-fenced liveness predicate.
   * `abandonActive()` cannot cancel an already-resolving promise, so every
   * dispatch loop must stop before its next claim once this predicate is false.
   */
  resume(
    operation: (ownsDrain: () => boolean) => Promise<void>,
    settled: () => void | Promise<void>,
  ): Promise<void> {
    if (this.activeDrain) return this.activeDrain;
    const startedAt = Date.now();
    const identity: { drain: Promise<void> | null } = { drain: null };
    const ownsDrain = () => this.activeDrain === identity.drain;
    const drain = Promise.resolve()
      .then(() => operation(ownsDrain))
      .finally(async () => {
        if (this.activeDrain === drain) {
          this.activeDrain = null;
          this.activeSinceAt = null;
          this.lastProgressAt = null;
        }
        await settled();
      });
    identity.drain = drain;
    this.activeDrain = drain;
    this.activeSinceAt = startedAt;
    this.lastProgressAt = startedAt;
    void drain.catch(() => undefined);
    return drain;
  }
}

interface PendingAgentPublication {
  kind: "barrier" | "checkpoint";
  phase: string;
  publish: () => Promise<void>;
}

/**
 * Serializes observer publications without allowing cumulative stream snapshots
 * to queue once per model delta. Checkpoints coalesce within the interval
 * between low-volume control barriers; barriers themselves are never replaced.
 */
export class DurableAgentPublicationQueue {
  private readonly pending: PendingAgentPublication[] = [];
  private activeDrain: Promise<void> | null = null;

  constructor(
    private readonly onError: (phase: string, error: unknown) => void,
    private readonly onDrainStarted: (drain: Promise<void>) => void,
  ) {}

  enqueueBarrier(phase: string, publish: () => Promise<void>): void {
    this.pending.push({ kind: "barrier", phase, publish });
    this.resume();
  }

  enqueueCheckpoint(phase: string, publish: () => Promise<void>): void {
    const tail = this.pending.at(-1);
    if (tail?.kind === "checkpoint") {
      tail.phase = phase;
      tail.publish = publish;
    } else {
      this.pending.push({ kind: "checkpoint", phase, publish });
    }
    this.resume();
  }

  private resume(): void {
    if (this.activeDrain) return;
    // Defer entry so the active guard is installed before a publisher can
    // synchronously enqueue more work of its own.
    const drain = Promise.resolve().then(() => this.drain());
    this.activeDrain = drain;
    this.onDrainStarted(drain);
    void drain.catch(() => undefined);
  }

  private async drain(): Promise<void> {
    try {
      let publication: PendingAgentPublication | undefined;
      while ((publication = this.pending.shift())) {
        try {
          await publication.publish();
        } catch (error) {
          this.onError(publication.phase, error);
        }
      }
    } finally {
      this.activeDrain = null;
      if (this.pending.length > 0) this.resume();
    }
  }
}

export function durableAgentRetryDelay(attempt: number): number {
  return Math.min(5 * 60_000, 5_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 6));
}
