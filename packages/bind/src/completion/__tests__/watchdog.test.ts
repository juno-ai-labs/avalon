import { describe, expect, test } from "vitest";
import {
  createStreamWatchdog,
  DEFAULT_INTER_CHUNK_MS,
  DEFAULT_MAX_CALL_DURATION_MS,
  DEFAULT_TIME_TO_FIRST_TOKEN_MS,
  type StreamTimers,
} from "../watchdog";

/**
 * A controllable clock. Every budget in this module is a `setTimeout`, so
 * driving it by hand makes each assertion exact — "at 119ms nothing has fired,
 * at 120ms it has" — instead of sleeping a real interval and hoping the machine
 * keeps up. Real-timer tests of a watchdog are flakes waiting for a loaded CI
 * box, and the negative assertions ("nothing fired yet") are the ones that go
 * red first.
 */
function fakeTimers(): StreamTimers & { advance: (ms: number) => void; pending: () => number } {
  let now = 0;
  let nextId = 1;
  const scheduled = new Map<number, { at: number; callback: () => void }>();

  return {
    set(callback, ms) {
      const id = nextId++;
      scheduled.set(id, { at: now + ms, callback });
      return id;
    },
    clear(handle) {
      scheduled.delete(handle as number);
    },
    advance(ms) {
      const target = now + ms;
      // Fire in due order, and let a callback schedule more work — the watchdog
      // re-arms from inside its own handlers.
      for (;;) {
        let nextId: number | null = null;
        let nextAt = Number.POSITIVE_INFINITY;
        for (const [id, entry] of scheduled) {
          if (entry.at <= target && entry.at < nextAt) {
            nextAt = entry.at;
            nextId = id;
          }
        }
        if (nextId === null) break;
        const entry = scheduled.get(nextId);
        if (entry === undefined) break;
        scheduled.delete(nextId);
        now = entry.at;
        entry.callback();
      }
      now = target;
    },
    pending() {
      return scheduled.size;
    },
  };
}

describe("createStreamWatchdog option validation", () => {
  // Every value here would otherwise make the watchdog fire on the next tick
  // and tear down every HEALTHY stream — a total inference outage that reads as
  // a provider incident. `setTimeout` coerces a non-finite delay to ~1ms rather
  // than ignoring it, and clamps an over-32-bit one the same way, so none of
  // these disables the watchdog; they all make it instantaneous.
  const REJECTED = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    0,
    -0,
    -1,
    // Above the 32-bit `setTimeout` ceiling. This is the trap that looks
    // reasonable: `maxCallDurationMs` of 30 days is a plausible config value.
    2_147_483_648,
    2_592_000_000,
  ];

  for (const bad of REJECTED) {
    // Each asserts the FIELD NAME, not just RangeError: the whole point of
    // validating here is a stack trace naming the budget that was wrong, and a
    // copy-pasted field name would pass a bare `.toThrow(RangeError)`.
    test(`timeToFirstTokenMs rejects ${String(bad)}`, () => {
      expect(() => createStreamWatchdog({ timeToFirstTokenMs: bad })).toThrow(
        /timeToFirstTokenMs/,
      );
    });
    test(`interChunkMs rejects ${String(bad)}`, () => {
      expect(() => createStreamWatchdog({ interChunkMs: bad })).toThrow(/interChunkMs/);
    });
    test(`maxCallDurationMs rejects ${String(bad)}`, () => {
      expect(() => createStreamWatchdog({ maxCallDurationMs: bad })).toThrow(
        /maxCallDurationMs/,
      );
    });
  }

  test("the largest representable delay is accepted", () => {
    const watchdog = createStreamWatchdog({ maxCallDurationMs: 2_147_483_647 });
    expect(watchdog.signal.aborted).toBe(false);
    watchdog.dispose();
  });

  test("a fractional budget is accepted (setTimeout rounds it)", () => {
    const watchdog = createStreamWatchdog({ interChunkMs: 0.5 });
    expect(watchdog.signal.aborted).toBe(false);
    watchdog.dispose();
  });

  test("a valid construction does not throw and starts unaborted", () => {
    const watchdog = createStreamWatchdog({ timeToFirstTokenMs: 50 });
    expect(watchdog.signal.aborted).toBe(false);
    expect(watchdog.stall()).toBeNull();
    watchdog.dispose();
  });

  // These three numbers moved out of Monad's `llm.ts` and are the operative
  // production budgets — nothing else pins them, so a transposed digit in a
  // future edit would ship an inference-wide outage that no test catches.
  test("the shipped defaults are the historical budgets", () => {
    expect({
      ttft: DEFAULT_TIME_TO_FIRST_TOKEN_MS,
      interChunk: DEFAULT_INTER_CHUNK_MS,
      maxCall: DEFAULT_MAX_CALL_DURATION_MS,
    }).toEqual({ ttft: 120_000, interChunk: 5_000, maxCall: 600_000 });
  });
});

describe("createStreamWatchdog phase budgets", () => {
  test("the TTFT budget only starts at open(), not at construction", () => {
    const timers = fakeTimers();
    const watchdog = createStreamWatchdog({
      timeToFirstTokenMs: 40,
      interChunkMs: 5_000,
      maxCallDurationMs: 100_000,
      timers,
    });
    // Well past the budget, but the stream has not opened — connection time
    // must not be counted against the first-token budget.
    timers.advance(1_000);
    expect(watchdog.signal.aborted).toBe(false);
    expect(watchdog.stall()).toBeNull();

    watchdog.open();
    timers.advance(39);
    expect(watchdog.signal.aborted).toBe(false);
    timers.advance(1);
    expect(watchdog.stall()).toEqual({
      kind: "time_to_first_token",
      limitMs: 40,
      sawReasoning: false,
    });
    watchdog.dispose();
  });

  test("a metadata-only chunk keeps the generous budget", () => {
    const timers = fakeTimers();
    const watchdog = createStreamWatchdog({
      timeToFirstTokenMs: 120,
      interChunkMs: 15,
      timers,
    });
    watchdog.open();
    watchdog.observedChunk("none");

    // If "none" wrongly armed the tight budget this would have aborted at 15ms.
    timers.advance(119);
    expect(watchdog.signal.aborted).toBe(false);

    timers.advance(1);
    expect(watchdog.stall()).toEqual({
      kind: "time_to_first_token",
      limitMs: 120,
      sawReasoning: false,
    });
    watchdog.dispose();
  });

  test("a reasoning chunk keeps the generous budget but is reported as sawReasoning", () => {
    const timers = fakeTimers();
    const watchdog = createStreamWatchdog({
      timeToFirstTokenMs: 120,
      interChunkMs: 15,
      timers,
    });
    watchdog.open();
    watchdog.observedChunk("reasoning");

    timers.advance(119);
    expect(watchdog.signal.aborted).toBe(false);

    timers.advance(1);
    // `sawReasoning: true` is the only thing distinguishing this from the
    // metadata-only case above — same budget, different upstream fault.
    expect(watchdog.stall()).toEqual({
      kind: "time_to_first_token",
      limitMs: 120,
      sawReasoning: true,
    });
    watchdog.dispose();
  });

  // The regression this module exists for. A frontier reasoning model streams
  // reasoning deltas for far longer than one TTFT budget; if each delta did not
  // RE-ARM the generous budget, a normal long think would be torn down as a
  // stall. Every other test here passes whether or not re-arming works, because
  // they only ever emit one chunk.
  test("each non-answer chunk re-arms the generous budget", () => {
    const timers = fakeTimers();
    const watchdog = createStreamWatchdog({
      timeToFirstTokenMs: 200,
      interChunkMs: 10,
      maxCallDurationMs: 100_000,
      timers,
    });
    watchdog.open();
    // 10 × 150ms = 1.5s of reasoning under a 200ms budget: only survivable if
    // every delta pushes the deadline out.
    for (let i = 0; i < 10; i++) {
      timers.advance(150);
      expect(watchdog.signal.aborted).toBe(false);
      watchdog.observedChunk("reasoning");
    }
    expect(watchdog.stall()).toBeNull();

    // And the budget is still live: silence past it still trips.
    timers.advance(200);
    expect(watchdog.stall()).toEqual({
      kind: "time_to_first_token",
      limitMs: 200,
      sawReasoning: true,
    });
    watchdog.dispose();
  });

  test("an answer chunk arms the tight inter-chunk budget", () => {
    const timers = fakeTimers();
    const watchdog = createStreamWatchdog({
      timeToFirstTokenMs: 10_000,
      interChunkMs: 30,
      timers,
    });
    watchdog.open();
    watchdog.observedChunk("answer");

    // Fires on the tight budget; the generous one would take 10s.
    timers.advance(30);
    expect(watchdog.stall()).toEqual({ kind: "inter_chunk", limitMs: 30 });
    watchdog.dispose();
  });

  test("the tight budget stays armed once answer output has flowed", () => {
    const timers = fakeTimers();
    const watchdog = createStreamWatchdog({
      timeToFirstTokenMs: 10_000,
      interChunkMs: 30,
      timers,
    });
    watchdog.open();
    watchdog.observedChunk("answer");
    // A later reasoning or metadata chunk must not revert to the generous
    // budget — the model is mid-answer and a long silence is abnormal now.
    watchdog.observedChunk("reasoning");
    watchdog.observedChunk("none");

    timers.advance(30);
    expect(watchdog.stall()).toEqual({ kind: "inter_chunk", limitMs: 30 });
    watchdog.dispose();
  });

  test("chunks arriving within budget never trip the watchdog", () => {
    const timers = fakeTimers();
    const watchdog = createStreamWatchdog({
      timeToFirstTokenMs: 1_000,
      interChunkMs: 200,
      timers,
    });
    watchdog.open();
    for (let i = 0; i < 5; i++) {
      timers.advance(20);
      watchdog.observedChunk("answer");
    }
    expect(watchdog.signal.aborted).toBe(false);
    expect(watchdog.stall()).toBeNull();
    watchdog.dispose();
  });

  test("the overall cap fires on a stream that drips under the idle budget", () => {
    const timers = fakeTimers();
    const watchdog = createStreamWatchdog({
      timeToFirstTokenMs: 5_000,
      interChunkMs: 5_000,
      maxCallDurationMs: 60,
      timers,
    });
    watchdog.open();
    // Reasoning every 10ms keeps re-arming the (generous) idle budget forever —
    // exactly the shape the per-gap watchdog cannot catch on its own.
    for (let i = 0; i < 20 && !watchdog.signal.aborted; i++) {
      timers.advance(10);
      watchdog.observedChunk("reasoning");
    }
    expect(watchdog.stall()).toEqual({ kind: "overall_cap", limitMs: 60 });
    watchdog.dispose();
  });

  test("a healthy stream is not cut short by the cap", () => {
    const timers = fakeTimers();
    const watchdog = createStreamWatchdog({
      timeToFirstTokenMs: 1_000,
      interChunkMs: 200,
      maxCallDurationMs: 1_000,
      timers,
    });
    watchdog.open();
    for (let i = 0; i < 5; i++) {
      timers.advance(20);
      watchdog.observedChunk("answer");
    }
    expect(watchdog.signal.aborted).toBe(false);
    expect(watchdog.stall()).toBeNull();
    watchdog.dispose();
  });
});

describe("createStreamWatchdog absolute cap arming", () => {
  // The cap is the guarantee of last resort — the thing that stops one call
  // holding a worker slot forever when the caller passes a never-aborted
  // signal. A host that forgets `open()` must still get it.
  test("the cap runs from construction, without open()", () => {
    const timers = fakeTimers();
    const watchdog = createStreamWatchdog({
      timeToFirstTokenMs: 100_000,
      maxCallDurationMs: 50,
      timers,
    });
    timers.advance(50);
    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.stall()).toEqual({ kind: "overall_cap", limitMs: 50 });
    watchdog.dispose();
  });

  test("a second open() does not push the cap out", () => {
    const timers = fakeTimers();
    const watchdog = createStreamWatchdog({
      timeToFirstTokenMs: 100_000,
      maxCallDurationMs: 100,
      timers,
    });
    watchdog.open();
    timers.advance(60);
    // A caller that re-opens mid-stream must not silently reset the only bound
    // on the call's total wall clock.
    watchdog.open();
    watchdog.open();
    timers.advance(40);
    expect(watchdog.stall()).toEqual({ kind: "overall_cap", limitMs: 100 });
    watchdog.dispose();
  });
});

describe("createStreamWatchdog and the caller's signal", () => {
  test("a caller abort settles the composite signal", () => {
    const controller = new AbortController();
    const watchdog = createStreamWatchdog({
      timeToFirstTokenMs: 10_000,
      external: controller.signal,
      timers: fakeTimers(),
    });
    watchdog.open();
    controller.abort();
    expect(watchdog.signal.aborted).toBe(true);
    watchdog.dispose();
  });

  test("a caller abort is NOT reported as a stall, even after a budget elapses", () => {
    const timers = fakeTimers();
    const controller = new AbortController();
    const watchdog = createStreamWatchdog({
      timeToFirstTokenMs: 20,
      external: controller.signal,
      timers,
    });
    watchdog.open();
    // Budget first, then cancel. The idle flag is set, but the caller
    // cancelled — reporting a retriable upstream stall here would make a
    // deliberate cancellation look like a provider fault worth retrying.
    timers.advance(20);
    expect(watchdog.stall()).not.toBeNull();
    controller.abort();
    expect(watchdog.stall()).toBeNull();
    watchdog.dispose();
  });

  test("the same holds when the caller aborts BEFORE the budget elapses", () => {
    const timers = fakeTimers();
    const controller = new AbortController();
    const watchdog = createStreamWatchdog({
      timeToFirstTokenMs: 20,
      external: controller.signal,
      timers,
    });
    watchdog.open();
    // Nothing disarms the idle timer when the external signal aborts, so it
    // fires anyway and sets the flag. The `null` therefore rests entirely on
    // the external check running first — pin that ordering in both directions.
    controller.abort();
    timers.advance(100);
    expect(watchdog.stall()).toBeNull();
    watchdog.dispose();
  });

  test("the overall cap outranks the idle budget when both elapsed", () => {
    const timers = fakeTimers();
    const watchdog = createStreamWatchdog({
      timeToFirstTokenMs: 20,
      interChunkMs: 20,
      maxCallDurationMs: 20,
      timers,
    });
    watchdog.open();
    timers.advance(120);
    // Both timers have fired by now; the cap is the stronger claim.
    expect(watchdog.stall()).toEqual({ kind: "overall_cap", limitMs: 20 });
    watchdog.dispose();
  });
});

describe("createStreamWatchdog disposal", () => {
  test("dispose() stops a pending budget from ever firing a stall", () => {
    const timers = fakeTimers();
    const watchdog = createStreamWatchdog({ timeToFirstTokenMs: 30, timers });
    watchdog.open();
    watchdog.dispose();
    timers.advance(1_000);
    // The timer was cleared, so no stall was recorded — even though the signal
    // is aborted (dispose settles the composite deliberately).
    expect(watchdog.stall()).toBeNull();
    expect(watchdog.signal.aborted).toBe(true);
  });

  // The race that matters: a budget elapses in the instant before the stream
  // ends, so the abort tears nothing down and the read completes normally. If
  // that flag survived `dispose()`, the NEXT failure on the same call — a
  // defect found while assembling the message, a billing read — would be
  // reported as an upstream stall, losing its own (different) retry treatment.
  test("dispose() forgets a budget that fired but tore nothing down", () => {
    const timers = fakeTimers();
    const watchdog = createStreamWatchdog({ timeToFirstTokenMs: 30, timers });
    watchdog.open();
    timers.advance(30);
    expect(watchdog.stall()).not.toBeNull();

    // The host drained the stream anyway and disposed on the success path.
    watchdog.dispose();
    expect(watchdog.stall()).toBeNull();
  });

  test("dispose() releases every scheduled timer", () => {
    const timers = fakeTimers();
    const watchdog = createStreamWatchdog({ timeToFirstTokenMs: 30, timers });
    watchdog.open();
    expect(timers.pending()).toBeGreaterThan(0);
    watchdog.dispose();
    expect(timers.pending()).toBe(0);
  });

  test("dispose() is idempotent and open()/observedChunk() are inert afterwards", () => {
    const timers = fakeTimers();
    const watchdog = createStreamWatchdog({ timeToFirstTokenMs: 30, timers });
    watchdog.open();
    watchdog.dispose();
    watchdog.dispose();
    watchdog.open();
    watchdog.observedChunk("answer");
    timers.advance(1_000);
    expect(watchdog.stall()).toBeNull();
    expect(timers.pending()).toBe(0);
  });
});
