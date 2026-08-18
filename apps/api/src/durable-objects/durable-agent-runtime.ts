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

  get active(): boolean {
    return this.activeDrain !== null;
  }

  resume(operation: () => Promise<void>, settled: () => void | Promise<void>): Promise<void> {
    if (this.activeDrain) return this.activeDrain;
    const drain = Promise.resolve()
      .then(operation)
      .finally(async () => {
        if (this.activeDrain === drain) this.activeDrain = null;
        await settled();
      });
    this.activeDrain = drain;
    void drain.catch(() => undefined);
    return drain;
  }
}

export function durableAgentRetryDelay(attempt: number): number {
  return Math.min(5 * 60_000, 5_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 6));
}
