/**
 * Shared run-mechanics harness (`run-harness.ts`): the wall-clock deadline, the
 * failure classifier, and the coalesced heartbeat used by BOTH the durable
 * executor and the one-off/onboarding loop. Pure unit tests — no DB, no DOM.
 */

import { describe, expect, test } from "vitest";
import {
  createRunDeadline,
  classifyRunFailure,
  createCoalescedHeartbeat,
  RunTimeoutError,
} from "../harness";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createRunDeadline", () => {
  test("is not timed out before the budget elapses; throwIfTimedOut is a no-op", () => {
    const d = createRunDeadline({ timeoutMs: 10_000, label: "test run" });
    expect(d.timedOut).toBe(false);
    expect(() => d.throwIfTimedOut()).not.toThrow();
    expect(d.signal.aborted).toBe(false);
    d.dispose();
  });

  test("fires after the budget: timedOut flips and throwIfTimedOut throws RunTimeoutError", async () => {
    const d = createRunDeadline({ timeoutMs: 5, label: "test run" });
    await tick(25);
    expect(d.timedOut).toBe(true);
    expect(d.signal.aborted).toBe(true);
    expect(() => d.throwIfTimedOut()).toThrow(RunTimeoutError);
    d.dispose();
  });

  test("dispose() prevents the timer from firing", async () => {
    const d = createRunDeadline({ timeoutMs: 5, label: "test run" });
    d.dispose();
    await tick(25);
    expect(d.timedOut).toBe(false);
  });

  test("withExternal: an external abort aborts the combined signal but NOT the deadline (timedOut stays false)", () => {
    const d = createRunDeadline({ timeoutMs: 10_000, label: "test run" });
    const external = new AbortController();
    const combined = d.withExternal(external.signal);
    expect(combined.aborted).toBe(false);
    external.abort();
    expect(combined.aborted).toBe(true);
    // The deadline itself did not fire — so this is a cancellation, not a timeout.
    expect(d.timedOut).toBe(false);
    expect(() => d.throwIfTimedOut()).not.toThrow();
    d.dispose();
  });

  test("withExternal(undefined) returns the deadline's own signal", () => {
    const d = createRunDeadline({ timeoutMs: 10_000, label: "test run" });
    expect(d.withExternal()).toBe(d.signal);
    expect(d.withExternal(null)).toBe(d.signal);
    d.dispose();
  });
});

describe("classifyRunFailure", () => {
  test("a live (not-timed-out) deadline with a generic error → failed", () => {
    const d = createRunDeadline({ timeoutMs: 10_000, label: "x" });
    expect(classifyRunFailure(d, new Error("boom"))).toBe("failed");
    d.dispose();
  });

  test("a fired deadline → timed_out (regardless of error shape)", async () => {
    const d = createRunDeadline({ timeoutMs: 5, label: "x" });
    await tick(25);
    // An AbortError surfaces from a torn-down stream when the deadline fires.
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(classifyRunFailure(d, abort)).toBe("timed_out");
    d.dispose();
  });

  test("a RunTimeoutError → timed_out even if the deadline object reads not-timed-out", () => {
    const d = createRunDeadline({ timeoutMs: 10_000, label: "x" });
    expect(classifyRunFailure(d, new RunTimeoutError(10_000, "x"))).toBe(
      "timed_out",
    );
    d.dispose();
  });
});

describe("createCoalescedHeartbeat", () => {
  test("coalesces bursts within the window to a single flush; force always flushes", async () => {
    let flushes = 0;
    const hb = createCoalescedHeartbeat({
      coalesceMs: 10_000,
      flush: async () => {
        flushes += 1;
      },
    });
    await hb.beat(); // first beat flushes
    await hb.beat(); // coalesced (within window)
    await hb.beat(); // coalesced
    expect(flushes).toBe(1);
    await hb.beat({ force: true }); // force bypasses coalescing
    expect(flushes).toBe(2);
  });

  test("a flush error is routed to onError and swallowed (never throws)", async () => {
    const errors: unknown[] = [];
    const hb = createCoalescedHeartbeat({
      coalesceMs: 0,
      flush: async () => {
        throw new Error("db down");
      },
      onError: (e) => errors.push(e),
    });
    await hb.beat({ force: true });
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("db down");
  });

  test("serializes flushes — two overlapping beats never run flush() concurrently", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let flushes = 0;
    const hb = createCoalescedHeartbeat({
      coalesceMs: 0, // every beat requests a flush
      flush: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await tick(10); // hold the "write" open so an overlap would be observable
        flushes += 1;
        concurrent -= 1;
      },
    });

    // Fire a coalesced beat and a forced beat without awaiting the first — the
    // pre-serialization code would run both flushes at once (maxConcurrent=2).
    const a = hb.beat();
    const b = hb.beat({ force: true });
    await Promise.all([a, b]);

    expect(maxConcurrent).toBe(1);
    expect(flushes).toBeGreaterThanOrEqual(1);
  });
});
