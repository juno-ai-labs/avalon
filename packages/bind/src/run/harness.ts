/**
 * Cross-cutting run mechanics for an agent loop:
 *
 *   1. a **wall-clock deadline** that aborts a hung run (thread its signal into
 *      every model and tool call, and re-check at the top of each iteration);
 *   2. a **coalesced progress heartbeat** for hosts that record liveness;
 *   3. a **failure classifier** mapping a thrown run to a terminal status
 *      (`timed_out` vs `failed`).
 *
 * Any driver of the loop needs all three, and reimplementing them per driver
 * is how one ends up unbounded: a loop whose abort signal never fires holds its
 * worker slot until an external reaper notices, which is a stall the user sees
 * as an agent that never answers.
 *
 * This module owns no persistence and makes no model calls — it is pure
 * mechanics, so a small consumer can use it without pulling in a loop's
 * transitive graph.
 */

/** Thrown by {@link RunDeadline.throwIfTimedOut} once the wall-clock budget is
 *  exhausted. Distinct from a caller-driven cancellation so callers can map it
 *  to a `timed_out` terminal status (or simply read {@link RunDeadline.timedOut}). */
export class RunTimeoutError extends Error {
  constructor(
    public readonly timeoutMs: number,
    label: string,
  ) {
    super(`${label} exceeded ${formatDuration(timeoutMs)} timeout`);
    this.name = "RunTimeoutError";
  }
}

function formatDuration(ms: number): string {
  if (ms % 60_000 === 0) {
    const m = ms / 60_000;
    return `${m} ${m === 1 ? "minute" : "minutes"}`;
  }
  // Floor at 1 so a sub-second budget (e.g. a 50ms test deadline) never reads
  // "0 seconds".
  const s = Math.max(1, Math.round(ms / 1000));
  return `${s} ${s === 1 ? "second" : "seconds"}`;
}

/**
 * Call `unref()` on a timer when the runtime exposes it (Node/Bun) so a
 * forgotten clear can't hold the event loop open; a no-op under the DOM `number`
 * timer type. Feature-detected rather than `as`-cast to keep type safety.
 */
export function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (
    typeof timer === "object" &&
    timer !== null &&
    typeof timer.unref === "function"
  ) {
    timer.unref();
  }
}

/**
 * A wall-clock budget for a single run. Backed by an `AbortController` that
 * fires after `timeoutMs`; `signal` is threaded into LLM/tool calls so an
 * in-flight upstream request is actually torn down on timeout (not merely
 * abandoned). `timedOut` reflects *this* deadline firing only — it stays false
 * when a combined external (cancellation) signal aborts — so it is a reliable
 * basis for classifying a `timed_out` outcome regardless of which error shape
 * surfaced (a `RunTimeoutError` from {@link throwIfTimedOut} or an `AbortError`
 * from a torn-down `callLLM` stream).
 */
export interface RunDeadline {
  /** The deadline's own abort signal. Combine with a cancellation signal via
   *  {@link withExternal} before handing to `callLLM`. */
  readonly signal: AbortSignal;
  /** True once this deadline's timer has fired. Unaffected by external signals. */
  readonly timedOut: boolean;
  /** Throw {@link RunTimeoutError} if the budget is exhausted; no-op otherwise.
   *  Call at the top of each loop iteration. */
  throwIfTimedOut(): void;
  /** Combine this deadline with an optional external signal (e.g. a DB-backed
   *  cancellation controller). Returns the deadline's own signal when no
   *  external signal is given. */
  withExternal(external?: AbortSignal | null): AbortSignal;
  /** Clear the underlying timer. Idempotent; call in a `finally`. */
  dispose(): void;
}

export function createRunDeadline(opts: {
  timeoutMs: number;
  label?: string;
}): RunDeadline {
  const label = opts.label ?? "agent run";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  // Unref so a forgotten dispose() (e.g. in a test) can't hold the event loop
  // open; the timer is always cleared on the real run path.
  unrefTimer(timer);
  return {
    signal: controller.signal,
    get timedOut() {
      return controller.signal.aborted;
    },
    throwIfTimedOut() {
      if (controller.signal.aborted) {
        throw new RunTimeoutError(opts.timeoutMs, label);
      }
    },
    withExternal(external) {
      if (!external) return controller.signal;
      return AbortSignal.any([external, controller.signal]);
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}

/**
 * Classify a run that ended by throwing into its terminal status. A run whose
 * deadline fired — or whose error is a {@link RunTimeoutError} — is `timed_out`;
 * anything else is `failed`. Checking the error too makes the result robust to
 * the surfaced shape (an `AbortError` from a torn-down stream leaves
 * `deadline.timedOut` true; a `RunTimeoutError` thrown between iterations is
 * caught directly even if a combined-signal edge left `timedOut` unread).
 *
 * Caller-driven cancellation is a distinct outcome and must be handled *before*
 * calling this (the executor special-cases `AgentRunCancelledError`); the
 * one-off/onboarding path has no cancellation, so this split is complete there.
 */
export function classifyRunFailure(
  deadline: RunDeadline,
  error?: unknown,
): "timed_out" | "failed" {
  if (deadline.timedOut || error instanceof RunTimeoutError) return "timed_out";
  return "failed";
}

/** A progress heartbeat that collapses bursts of calls into at most one flush
 *  per `coalesceMs` window (a `force` beat always flushes). */
export interface CoalescedHeartbeat {
  beat(opts?: { force?: boolean }): Promise<void>;
}

/**
 * Build a coalesced heartbeat. A run with N concurrent tool calls would
 * otherwise fire N near-simultaneous run-row UPDATEs; coalescing collapses
 * them to one per window while a `force: true` beat (used at the end of each
 * iteration) guarantees a bump within the reaper's stale threshold. `flush`
 * owns the actual write; a flush failure is reported to `onError` and
 * swallowed so a transient DB hiccup never aborts the run.
 */
export function createCoalescedHeartbeat(opts: {
  coalesceMs: number;
  flush: () => Promise<void>;
  onError?: (err: unknown) => void;
}): CoalescedHeartbeat {
  let lastAt = 0;
  let inFlight: Promise<void> | null = null;
  let queued = false;

  // Drain queued flushes ONE AT A TIME, so a coalesced background beat and a
  // forced end-of-iteration beat can never run `flush()` concurrently — two
  // overlapping DB writes could otherwise resolve out of order and let an older
  // token/cost snapshot overwrite a newer one. `flush` reads live state at call
  // time, so each drained flush still writes the latest values, and a request
  // enqueued during the prior await is picked up on the next loop turn.
  const drain = async (): Promise<void> => {
    while (queued) {
      queued = false;
      try {
        await opts.flush();
      } catch (err) {
        opts.onError?.(err);
      }
    }
    inFlight = null;
  };

  return {
    async beat(o) {
      const now = Date.now();
      if (!o?.force && now - lastAt < opts.coalesceMs) return;
      lastAt = now;
      queued = true;
      if (!inFlight) inFlight = drain();
      // Await the drain so a forced beat returns only after the latest write has
      // landed — the reaper-liveness / token-flush guarantee callers rely on.
      await inFlight;
    },
  };
}
