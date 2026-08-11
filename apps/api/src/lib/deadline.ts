/**
 * A cancellable deadline for a bounded piece of work.
 *
 * `AbortSignal.timeout()` is the obvious way to bound a call, but its timer
 * cannot be cancelled: it stays armed for the full duration even after the work
 * it guarded has returned. Inside a request that is fine, because the timer dies
 * with the response. Inside a Workflow step, a queue consumer, or a Durable
 * Object alarm it is not — those invocations end when their handler returns, and
 * a still-armed timer keeps the invocation open with nothing left to do. The
 * Workers runtime eventually cancels it as a hang and bills it as an uncaught
 * exception, even though the work itself succeeded.
 *
 * `createDeadline` gives back the same abort semantics with a `dispose()` that
 * clears the timer, so the invocation ends when the work does. Always dispose in
 * a `finally`.
 */
export interface Deadline {
  readonly signal: AbortSignal;
  /** Clears the pending timer. Safe to call more than once. */
  dispose: () => void;
}

export function createDeadline(timeoutMs: number): Deadline {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`Operation timed out after ${timeoutMs}ms`, "TimeoutError"));
  }, timeoutMs);
  let disposed = false;
  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
    },
  };
}

/** Runs `work` under a cancellable deadline, clearing the timer either way. */
export async function withDeadline<T>(
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = createDeadline(timeoutMs);
  try {
    return await work(deadline.signal);
  } finally {
    deadline.dispose();
  }
}
