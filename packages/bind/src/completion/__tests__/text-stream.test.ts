import { describe, expect, test } from "vitest";
import {
  createTurnTextStream,
  type TurnStreamEvent,
  type TurnStreamSink,
} from "../text-stream";

function recordingSink(retractable: boolean): TurnStreamSink & {
  readonly events: TurnStreamEvent[];
} {
  const events: TurnStreamEvent[] = [];
  return {
    retractable,
    events,
    emit(event) {
      events.push(event);
    },
  };
}

const TURN = "turn_1";

const texts = (events: readonly TurnStreamEvent[]) =>
  events.flatMap((e) => (e.kind === "text" ? [e.text] : []));

describe("streaming one attempt", () => {
  test("forwards deltas in order with a monotonic seq", () => {
    const sink = recordingSink(true);
    const stream = createTurnTextStream({ sink, turnId: TURN });
    stream.beginAttempt();
    stream.observe("Hel");
    stream.observe("lo");

    expect(sink.events).toEqual([
      { kind: "text", turnId: TURN, epoch: 0, seq: 0, text: "Hel" },
      { kind: "text", turnId: TURN, epoch: 0, seq: 1, text: "lo" },
    ]);
  });

  test("empty and absent deltas are no-ops and do not count as output", () => {
    // A provider sending an empty content field has shown the user nothing, so
    // treating it as output would forfeit a fallback for free.
    const sink = recordingSink(false);
    const stream = createTurnTextStream({ sink, turnId: TURN });
    stream.beginAttempt();
    stream.observe("");
    stream.observe(null);
    stream.observe(undefined);

    expect(sink.events).toEqual([]);
    expect(stream.producedOutput).toBe(false);
  });

  test("observing before an attempt is opened throws rather than guessing", () => {
    // Silently assuming epoch 0 would make a retry indistinguishable from the
    // turn it replaces — the one thing the client cannot recover from.
    const stream = createTurnTextStream({ sink: recordingSink(true), turnId: TURN });
    expect(() => stream.observe("x")).toThrow(/beginAttempt/);
  });
});

describe("producedOutput — the clamp the executor reads", () => {
  test("a NON-retractable surface latches on the first byte", () => {
    const stream = createTurnTextStream({ sink: recordingSink(false), turnId: TURN });
    stream.beginAttempt();
    expect(stream.producedOutput).toBe(false);
    stream.observe("posted");
    expect(stream.producedOutput).toBe(true);
  });

  test("a retractable surface stays replayable — this is the whole point", () => {
    // Without this, a 500 on the first provider becomes an error the user sees,
    // purely because the first token had left.
    const stream = createTurnTextStream({ sink: recordingSink(true), turnId: TURN });
    stream.beginAttempt();
    stream.observe("partial answer");
    expect(stream.producedOutput).toBe(false);
  });

  test("nothing emitted means nothing produced, retractable or not", () => {
    for (const retractable of [true, false]) {
      const stream = createTurnTextStream({ sink: recordingSink(retractable), turnId: TURN });
      stream.beginAttempt();
      expect(stream.producedOutput).toBe(false);
    }
  });
});

describe("the reset that lets a retry re-render", () => {
  test("a retry wipes the surface and streams into a new epoch", () => {
    const sink = recordingSink(true);
    const stream = createTurnTextStream({ sink, turnId: TURN });
    stream.beginAttempt();
    stream.observe("The answer is 4");
    // ...attempt fails, executor traverses to the next provider.
    stream.beginAttempt();
    stream.observe("The answer is 42");

    expect(sink.events).toEqual([
      { kind: "text", turnId: TURN, epoch: 0, seq: 0, text: "The answer is 4" },
      { kind: "reset", turnId: TURN, epoch: 1, seq: 1, reason: "attempt_failed" },
      { kind: "text", turnId: TURN, epoch: 1, seq: 2, text: "The answer is 42" },
    ]);
  });

  test("the reset is LAZY — a retry that dies silently leaves the text up", () => {
    // Wiping at failure time would blank the screen to show nothing when the
    // retry has no viable endpoint. Partial text plus an error beats a blank
    // space plus an error.
    const sink = recordingSink(true);
    const stream = createTurnTextStream({ sink, turnId: TURN });
    stream.beginAttempt();
    stream.observe("partial");
    stream.beginAttempt(); // retry opens...
    // ...and fails before producing a byte.

    expect(sink.events).toEqual([
      { kind: "text", turnId: TURN, epoch: 0, seq: 0, text: "partial" },
    ]);
    expect(stream.resetCount).toBe(0);
  });

  test("two silent retries still wipe only once, into the newest epoch", () => {
    const sink = recordingSink(true);
    const stream = createTurnTextStream({ sink, turnId: TURN });
    stream.beginAttempt();
    stream.observe("first");
    stream.beginAttempt();
    stream.beginAttempt();
    stream.observe("second");

    expect(sink.events).toEqual([
      { kind: "text", turnId: TURN, epoch: 0, seq: 0, text: "first" },
      { kind: "reset", turnId: TURN, epoch: 2, seq: 1, reason: "attempt_failed" },
      { kind: "text", turnId: TURN, epoch: 2, seq: 2, text: "second" },
    ]);
    expect(stream.resetCount).toBe(1);
  });

  test("the first attempt never emits a reset", () => {
    // There is nothing on screen to retract, and a client that clears on an
    // unexpected reset would flash.
    const sink = recordingSink(true);
    const stream = createTurnTextStream({ sink, turnId: TURN });
    stream.beginAttempt();
    stream.observe("hello");
    expect(sink.events.some((e) => e.kind === "reset")).toBe(false);
  });

  test("attempts that never emit do not advance the epoch past what was shown", () => {
    // Epoch must still increase per attempt — it is how the client drops a
    // stale in-flight delta — but no reset is owed for a blank attempt.
    const sink = recordingSink(true);
    const stream = createTurnTextStream({ sink, turnId: TURN });
    stream.beginAttempt();
    stream.beginAttempt();
    stream.observe("first output");
    expect(stream.epoch).toBe(1);
    expect(sink.events).toEqual([
      { kind: "text", turnId: TURN, epoch: 1, seq: 0, text: "first output" },
    ]);
  });

  test("the reason distinguishes a failed attempt from a re-ask", () => {
    const sink = recordingSink(true);
    const stream = createTurnTextStream({ sink, turnId: TURN });
    stream.beginAttempt();
    stream.observe("{\"partial\":");
    stream.beginAttempt("structured_output_retry");
    stream.observe("{\"ok\":true}");

    expect(sink.events[1]).toEqual({
      kind: "reset",
      turnId: TURN,
      epoch: 1,
      seq: 1,
      reason: "structured_output_retry",
    });
  });

  test("seq never restarts across epochs, so it orders the whole turn", () => {
    // The client's de-duplication key. Restarting it per epoch would make two
    // different events share a key and let a replayed frame overwrite a newer one.
    const sink = recordingSink(true);
    const stream = createTurnTextStream({ sink, turnId: TURN });
    for (let attempt = 0; attempt < 3; attempt++) {
      stream.beginAttempt();
      stream.observe(`attempt ${attempt}`);
    }
    expect(sink.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(sink.events.map((e) => e.epoch)).toEqual([0, 1, 1, 2, 2]);
  });
});

describe("maxResets — bounding the flicker", () => {
  test("a spent budget strands the surface rather than appending to it", async () => {
    // Two states mean "the surface shows an epoch we can never clear": a reset
    // the sink refused, and a budget with no wipe left. They must behave the
    // same, and once did not — the budget path armed no reset and then appended
    // the next attempt's text on top of the abandoned one, which is the splice
    // this module exists to prevent. The executor has already been told to stop
    // by then (`producedOutput` is true), so anything still driving attempts is
    // a caller-owned retry loop.
    const sink = recordingSink(true);
    const stream = createTurnTextStream({ sink, turnId: TURN, maxResets: 1 });
    stream.beginAttempt();
    stream.observe("one");
    stream.beginAttempt();
    stream.observe("two"); // reset #1 — the only wipe
    stream.beginAttempt();
    stream.observe("three"); // budget spent: withheld, not appended

    expect(texts(sink.events)).toEqual(["one", "two"]);
    expect(stream.resetCount).toBe(1);
    expect(stream.producedOutput).toBe(true);
  });

  test("the budget is spent BEFORE the failure that would traverse past it", () => {
    // The clamp has to be visible on the failure of the attempt that used the
    // last wipe, not on the one after. Latching a step late lets the executor
    // start one more attempt, and that attempt is the one whose output gets
    // stranded.
    const stream = createTurnTextStream({
      sink: recordingSink(true),
      turnId: TURN,
      maxResets: 1,
    });
    stream.beginAttempt();
    stream.observe("one");
    expect(stream.producedOutput).toBe(false);
    stream.beginAttempt();
    stream.observe("two"); // spends the only wipe
    expect(stream.producedOutput).toBe(true);
  });

  test("a budget of zero clamps as soon as anything is shown", () => {
    const sink = recordingSink(true);
    const stream = createTurnTextStream({ sink, turnId: TURN, maxResets: 0 });
    stream.beginAttempt();
    stream.observe("only");
    expect(stream.producedOutput).toBe(true);
    // A second attempt should never happen — routing was told to stop — but if
    // a host ignores the clamp, no wipe is emitted to a budget of zero.
    stream.beginAttempt();
    stream.observe("appended");
    expect(sink.events.some((e) => e.kind === "reset")).toBe(false);
  });

  test("no budget means the executor's own limits are the only bound", () => {
    const sink = recordingSink(true);
    const stream = createTurnTextStream({ sink, turnId: TURN });
    for (let attempt = 0; attempt < 20; attempt++) {
      stream.beginAttempt();
      stream.observe("x");
    }
    expect(stream.resetCount).toBe(19);
    expect(stream.producedOutput).toBe(false);
  });

  test("a budget is not consumed by attempts that emitted nothing", () => {
    // Otherwise a run of dead endpoints spends the flicker budget without ever
    // flickering, and the one retry that would have worked is refused.
    const sink = recordingSink(true);
    const stream = createTurnTextStream({ sink, turnId: TURN, maxResets: 1 });
    stream.beginAttempt();
    stream.observe("shown");
    stream.beginAttempt();
    stream.beginAttempt();
    stream.observe("retry worked");

    expect(texts(sink.events)).toEqual(["shown", "retry worked"]);
  });

  test("a non-finite budget is refused rather than silently unbounded", () => {
    // `NaN >= n` is false forever, so an unvalidated cap parsed from config
    // becomes no cap at all — the opposite of the safe failure.
    for (const bad of [Number.NaN, 1.5, -1, Infinity]) {
      expect(() =>
        createTurnTextStream({ sink: recordingSink(true), turnId: TURN, maxResets: bad }),
      ).toThrow(TypeError);
    }
  });
});

describe("markProducedOutput — effects this module cannot see", () => {
  test("latches the clamp even with a retractable surface and no text", () => {
    const stream = createTurnTextStream({ sink: recordingSink(true), turnId: TURN });
    stream.beginAttempt();
    expect(stream.producedOutput).toBe(false);
    stream.markProducedOutput();
    expect(stream.producedOutput).toBe(true);
  });

  test("does NOT stop emission — the attempt reporting it may still succeed", () => {
    // Suppressing output here strands the answer of an attempt that goes on to
    // succeed. On a failure the clamp has already stopped routing, so there is
    // no later attempt to suppress anyway.
    const sink = recordingSink(true);
    const stream = createTurnTextStream({ sink, turnId: TURN });
    stream.beginAttempt();
    stream.markProducedOutput();
    stream.observe("the answer");

    expect(texts(sink.events)).toEqual(["the answer"]);
  });

  test("a permanent surface is never told to retract", () => {
    // A reset reaching an append-only row or a posted message is at best
    // meaningless and at worst an instruction to delete something real.
    const sink = recordingSink(false);
    const stream = createTurnTextStream({ sink, turnId: TURN });
    stream.beginAttempt();
    stream.observe("posted");
    stream.beginAttempt();
    stream.observe("posted again");

    expect(sink.events.some((e) => e.kind === "reset")).toBe(false);
  });

  test("is irreversible", () => {
    const stream = createTurnTextStream({ sink: recordingSink(true), turnId: TURN });
    stream.beginAttempt();
    stream.markProducedOutput();
    stream.beginAttempt();
    expect(stream.producedOutput).toBe(true);
  });
});

describe("a sink that throws", () => {
  const throwingSink = (retractable: boolean): TurnStreamSink => ({
    retractable,
    emit() {
      throw new Error("socket closed");
    },
  });

  test("the throw is counted, not propagated — a dead viewer is not a dead turn", () => {
    const stream = createTurnTextStream({ sink: throwingSink(true), turnId: TURN });
    stream.beginAttempt();
    expect(() => stream.observe("a")).not.toThrow();
    stream.observe("b");
    expect(stream.sinkErrors).toBe(2);
  });

  test("a throw still counts as output on a non-retractable surface", () => {
    // Whether the bytes left before the failure is not knowable from here, so
    // the conservative reading is that they did.
    const stream = createTurnTextStream({ sink: throwingSink(false), turnId: TURN });
    stream.beginAttempt();
    stream.observe("maybe delivered");
    expect(stream.producedOutput).toBe(true);
  });

  test("emission continues after a throw rather than tearing down", () => {
    let calls = 0;
    const flaky: TurnStreamSink = {
      retractable: true,
      emit() {
        calls += 1;
        if (calls === 1) throw new Error("transient");
      },
    };
    const stream = createTurnTextStream({ sink: flaky, turnId: TURN });
    stream.beginAttempt();
    stream.observe("a");
    stream.observe("b");
    expect(calls).toBe(2);
    expect(stream.sinkErrors).toBe(1);
  });
});

describe("the executor contract", () => {
  test("a retractable surface keeps the fallback chain a hand-rolled flag loses", () => {
    // The end-to-end claim, asserted rather than left to the prose: three
    // failing attempts, output on each, and routing is never clamped — while
    // the same sequence on a permanent surface clamps at the first byte.
    const live = createTurnTextStream({ sink: recordingSink(true), turnId: TURN });
    const posted = createTurnTextStream({ sink: recordingSink(false), turnId: TURN });
    const clamped: boolean[] = [];
    for (const stream of [live, posted]) {
      const seen: boolean[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        stream.beginAttempt();
        stream.observe("tokens");
        seen.push(stream.producedOutput);
      }
      clamped.push(seen.some(Boolean));
    }
    expect(clamped).toEqual([false, true]);
  });

  test("epoch is -1 before any attempt, so a caller can tell a turn never started", () => {
    expect(createTurnTextStream({ sink: recordingSink(true), turnId: TURN }).epoch).toBe(-1);
  });
});

describe("finish() — the reset that would otherwise never be delivered", () => {
  test("a retry that succeeds with NO text still wipes the failed attempt's text", () => {
    // The common shape of an agent turn, not an edge: attempt 1 narrates then
    // dies, attempt 2 comes back `content: null` plus tool calls. Nothing
    // triggers the lazy reset, so without finish() the narration stays on screen
    // attributed to a turn that never said it, and only a reload clears it.
    const sink = recordingSink(true);
    const stream = createTurnTextStream({ sink, turnId: TURN });
    stream.beginAttempt();
    stream.observe("Let me check the calendar…");
    stream.beginAttempt(); // retry opens...
    stream.finish("succeeded"); // ...and succeeds having emitted nothing

    expect(sink.events).toEqual([
      { kind: "text", turnId: TURN, epoch: 0, seq: 0, text: "Let me check the calendar…" },
      { kind: "reset", turnId: TURN, epoch: 1, seq: 1, reason: "attempt_failed" },
    ]);
  });

  test("finishing with nothing armed emits nothing", () => {
    const sink = recordingSink(true);
    const stream = createTurnTextStream({ sink, turnId: TURN });
    stream.beginAttempt();
    stream.observe("clean");
    stream.finish("succeeded");
    expect(sink.events.some((e) => e.kind === "reset")).toBe(false);
  });

  test("is idempotent and closes the stream", () => {
    const sink = recordingSink(true);
    const stream = createTurnTextStream({ sink, turnId: TURN });
    stream.beginAttempt();
    stream.observe("a");
    stream.beginAttempt();
    stream.finish("succeeded");
    stream.finish("succeeded");
    stream.beginAttempt();
    stream.observe("late");

    expect(sink.events.filter((e) => e.kind === "reset")).toHaveLength(1);
    expect(texts(sink.events)).toEqual(["a"]);
  });

  test("a turn where no attempt ever emits produces no events at all", () => {
    // The lazy-reset premise, pinned at the turn level rather than per attempt.
    const sink = recordingSink(true);
    const stream = createTurnTextStream({ sink, turnId: TURN });
    for (let i = 0; i < 4; i++) stream.beginAttempt();
    stream.finish("failed");
    expect(sink.events).toEqual([]);
  });
});

describe("a reset that does not reach the sink", () => {
  const rejectsResets = (events: TurnStreamEvent[]): TurnStreamSink => ({
    retractable: true,
    emit(event) {
      if (event.kind === "reset") throw new Error("socket closed");
      events.push(event);
    },
  });

  test("latches the clamp — a surface that never cleared cannot take another epoch", () => {
    // The wipe is the one event whose loss cannot be repaired by sending more.
    // Without this the client renders attempt 1's tail glued to attempt 2's
    // answer, and routing keeps traversing and keeps stacking epochs onto it.
    const events: TurnStreamEvent[] = [];
    const stream = createTurnTextStream({ sink: rejectsResets(events), turnId: TURN });
    stream.beginAttempt();
    stream.observe("one");
    expect(stream.producedOutput).toBe(false);
    stream.beginAttempt();
    stream.observe("two");

    expect(stream.producedOutput).toBe(true);
    expect(stream.sinkErrors).toBe(1);
  });

  test("still consumes the flicker budget, as resetCount documents", () => {
    const events: TurnStreamEvent[] = [];
    const stream = createTurnTextStream({
      sink: rejectsResets(events),
      turnId: TURN,
      maxResets: 1,
    });
    stream.beginAttempt();
    stream.observe("one");
    stream.beginAttempt();
    stream.observe("two");
    expect(stream.resetCount).toBe(1);
  });
});

describe("the sink contract is read once and its events are immutable", () => {
  test("a sink whose retractable answer flips cannot un-clamp routing", () => {
    // `readonly` is no barrier to a getter, and the module's own guidance
    // ("if one sink fans out to a mix, declare it false") invites a computed
    // one. Re-reading it would make producedOutput non-monotonic: a flip
    // between the first byte and the failure un-clamps a turn the executor was
    // already told was replayable, and the permanent surface gets it twice.
    let retractable = false;
    const stream = createTurnTextStream({
      turnId: TURN,
      sink: {
        get retractable() {
          return retractable;
        },
        emit() {},
      },
    });
    stream.beginAttempt();
    stream.observe("posted");
    expect(stream.producedOutput).toBe(true);
    retractable = true;
    expect(stream.producedOutput).toBe(true);
  });

  test("events handed to a sink are frozen", () => {
    // The type says Readonly; a sink fanning out to two consumers would
    // otherwise let the first rewrite what the second sees.
    const sink = recordingSink(true);
    const stream = createTurnTextStream({ sink, turnId: TURN });
    stream.beginAttempt();
    stream.observe("x");
    expect(Object.isFrozen(sink.events[0])).toBe(true);
  });
});

describe("details a single-delta test cannot see", () => {
  test("the armed reset fires once, not before every delta of the retry", () => {
    // Every multi-attempt test above observes exactly once per attempt, so a
    // reset that failed to clear would look identical. It is not: the surface
    // would strobe and render only the final delta.
    const sink = recordingSink(true);
    const stream = createTurnTextStream({ sink, turnId: TURN });
    stream.beginAttempt();
    stream.observe("one");
    stream.beginAttempt();
    stream.observe("two-a");
    stream.observe("two-b");

    expect(sink.events).toEqual([
      { kind: "text", turnId: TURN, epoch: 0, seq: 0, text: "one" },
      { kind: "reset", turnId: TURN, epoch: 1, seq: 1, reason: "attempt_failed" },
      { kind: "text", turnId: TURN, epoch: 1, seq: 2, text: "two-a" },
      { kind: "text", turnId: TURN, epoch: 1, seq: 3, text: "two-b" },
    ]);
    expect(stream.resetCount).toBe(1);
  });

  test("an explicit reason survives a later default — the re-ask arm stays reachable", () => {
    // The prescribed composition calls beginAttempt("structured_output_retry")
    // in the caller's loop, which then re-enters the executor, whose AttemptFn
    // opens the same pending reset again with no reason. Last-wins would make
    // that arm of the union dead in practice.
    const sink = recordingSink(true);
    const stream = createTurnTextStream({ sink, turnId: TURN });
    stream.beginAttempt();
    stream.observe("{\"partial\":");
    stream.beginAttempt("structured_output_retry");
    stream.beginAttempt();
    stream.observe("{\"ok\":true}");

    const reset = sink.events.find((e) => e.kind === "reset");
    expect(reset?.kind === "reset" && reset.reason).toBe("structured_output_retry");
  });

  test("the missing-beginAttempt guard is not suppressed by an empty delta", () => {
    // The guard catches the one contract violation a client cannot recover
    // from. A host whose first chunk happens to be empty must not ship green.
    const stream = createTurnTextStream({ sink: recordingSink(true), turnId: TURN });
    expect(() => stream.observe("")).toThrow(/beginAttempt/);
  });

  test("epoch advances per attempt even when an attempt stays silent", () => {
    // It identifies the attempt; a host correlating logs on it should not see
    // it stall because an earlier attempt produced nothing.
    const stream = createTurnTextStream({ sink: recordingSink(true), turnId: TURN });
    stream.beginAttempt();
    stream.beginAttempt();
    stream.beginAttempt();
    expect(stream.epoch).toBe(2);
  });
});

describe("invariants over an arbitrary attempt script", () => {
  test("seq, epoch and producedOutput hold under any interleaving", () => {
    // A seeded model-based sweep rather than fast-check: the package's test
    // fence keeps it to the test runner, and the module is pure enough that a few
    // thousand scripted steps cost nothing.
    let seed = 12345;
    // `Math.imul` because the plain product overflows the 53-bit mantissa and
    // collapses the period to ~10k — long enough today, and silently degenerate
    // the moment anyone raises the run or step count.
    const rand = () =>
      (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 0x100000000;

    for (let run = 0; run < 300; run++) {
      const retractable = rand() < 0.7;
      const sink = recordingSink(retractable);
      const stream = createTurnTextStream({
        sink,
        turnId: TURN,
        ...(rand() < 0.3 ? { maxResets: Math.floor(rand() * 3) } : {}),
      });
      let attempts = 0;
      let sawProduced = false;
      for (let step = 0; step < 30; step++) {
        const roll = rand();
        if (roll < 0.3) {
          stream.beginAttempt();
          attempts += 1;
        } else if (roll < 0.9) {
          if (stream.epoch >= 0) stream.observe(roll < 0.85 ? "tok" : "");
        } else if (roll < 0.95) {
          stream.markProducedOutput();
        }
        if (stream.producedOutput) sawProduced = true;
        // Monotonic: never true then false.
        expect(stream.producedOutput || !sawProduced).toBe(true);
      }
      stream.finish("succeeded");

      expect(sink.events.map((e) => e.seq)).toEqual(
        sink.events.map((_, index) => index),
      );
      // The invariant the module exists for, and the one the other four miss:
      // a stream that never emitted a reset at all satisfies them all. On a
      // RETRACTABLE surface, two text events at different epochs must have a
      // reset between them — otherwise the reader is looking at two answers
      // spliced together. (A permanent surface never gets a reset by design, so
      // the rule does not apply there; its clamp latches on the first byte and
      // routing stops instead.)
      if (retractable) {
        let lastTextEpoch = -1;
        for (const event of sink.events) {
          if (event.kind === "reset") lastTextEpoch = -1;
          else {
            if (lastTextEpoch !== -1) expect(event.epoch).toBe(lastTextEpoch);
            lastTextEpoch = event.epoch;
          }
        }
      }
      expect(sink.events.filter((e) => e.kind === "reset").length).toBe(
        stream.resetCount,
      );
      const epochs = sink.events.map((e) => e.epoch);
      expect([...epochs].sort((a, b) => a - b)).toEqual(epochs);
      expect(stream.resetCount).toBeLessThanOrEqual(Math.max(0, attempts - 1));
      expect(sink.events.every((e) => e.turnId === TURN)).toBe(true);
    }
  });
});

describe("finish() must know how the turn ended", () => {
  test('"failed" KEEPS the partial text a doomed retry would have wiped', () => {
    // The lazy reset exists so a retry that dies before producing anything
    // leaves the reader with partial text plus an error rather than a blank
    // space plus an error. Flushing unconditionally at the finish line undoes
    // that exact trade at the exact moment it matters most — every attempt
    // failed, so what is on screen is the best thing the reader is going to get.
    const sink = recordingSink(true);
    const stream = createTurnTextStream({ sink, turnId: TURN });
    stream.beginAttempt();
    stream.observe("The answer is 4");
    stream.beginAttempt(); // final retry opens...
    stream.finish("failed"); // ...and dies before a byte

    expect(sink.events).toEqual([
      { kind: "text", turnId: TURN, epoch: 0, seq: 0, text: "The answer is 4" },
    ]);
  });

  test('"succeeded" still flushes, because the text was superseded', () => {
    const sink = recordingSink(true);
    const stream = createTurnTextStream({ sink, turnId: TURN });
    stream.beginAttempt();
    stream.observe("Let me check…");
    stream.beginAttempt();
    stream.finish("succeeded"); // retry returned tool calls, no text

    expect(sink.events.map((e) => e.kind)).toEqual(["text", "reset"]);
  });

  test("markProducedOutput is a no-op once the turn is closed", () => {
    // A closed stream is closed for every method: the flag exists for the
    // executor to read on a failure outcome, and after finish there is none.
    const stream = createTurnTextStream({ sink: recordingSink(true), turnId: TURN });
    stream.beginAttempt();
    stream.observe("x");
    stream.finish("succeeded");
    stream.markProducedOutput();
    expect(stream.producedOutput).toBe(false);
  });

  test("an empty turnId is refused rather than collapsing every turn into one", () => {
    expect(() =>
      createTurnTextStream({ sink: recordingSink(true), turnId: "" }),
    ).toThrow(TypeError);
  });
});

describe("a reset the sink refused stops the epoch it could not clear", () => {
  test("the retry's text is withheld rather than glued to the stale answer", () => {
    // `producedOutput` latching only helps if the attempt FAILS. When it
    // succeeds the executor never reads the flag, so suppressing emission is the
    // only thing standing between the reader and two answers spliced together.
    const events: TurnStreamEvent[] = [];
    const stream = createTurnTextStream({
      turnId: TURN,
      sink: {
        retractable: true,
        emit(event) {
          if (event.kind === "reset") throw new Error("socket closed");
          events.push(event);
        },
      },
    });
    stream.beginAttempt();
    stream.observe("The answer is 4");
    stream.beginAttempt();
    stream.observe(" and also 42");

    expect(events.map((e) => (e.kind === "text" ? e.text : e.kind))).toEqual([
      "The answer is 4",
    ]);
    expect(stream.sinkErrors).toBe(1);
    expect(stream.producedOutput).toBe(true);
  });
});

describe("a stranded surface is never written to again", () => {
  test("a later reset that WOULD land is withheld, so the reader is not left blank", () => {
    // `resetLost` used to latch permanently while `flushReset` still ran, so a
    // socket blip followed by a recovered connection delivered a reset that
    // cleared the screen — and then nothing, because emission stayed suppressed.
    // The turn succeeded and the reader stared at an empty message. Once the
    // surface is stranded, it gets nothing further at all.
    const events: TurnStreamEvent[] = [];
    let failNext = true;
    const stream = createTurnTextStream({
      turnId: TURN,
      sink: {
        retractable: true,
        emit(event) {
          if (event.kind === "reset" && failNext) {
            failNext = false;
            throw new Error("socket closed");
          }
          events.push(event);
        },
      },
    });
    stream.beginAttempt();
    stream.observe("The answer is 4");
    stream.beginAttempt();
    stream.observe("and 42"); // reset throws; text withheld
    stream.beginAttempt();
    stream.observe("and 43"); // socket is back, but the surface stays stranded

    expect(events.map((e) => (e.kind === "text" ? e.text : "reset"))).toEqual([
      "The answer is 4",
    ]);
    expect(stream.producedOutput).toBe(true);
  });

  test("producedOutput does not un-latch when a later reset succeeds", () => {
    // `staleSurface` clears when a wipe lands; `producedOutput` must not follow
    // it, or a turn the executor was told was unreplayable becomes replayable.
    let failNext = true;
    const stream = createTurnTextStream({
      turnId: TURN,
      sink: {
        retractable: true,
        emit(event) {
          if (event.kind === "reset" && failNext) {
            failNext = false;
            throw new Error("socket closed");
          }
        },
      },
    });
    stream.beginAttempt();
    stream.observe("a");
    stream.beginAttempt();
    stream.observe("b");
    expect(stream.producedOutput).toBe(true);
    stream.beginAttempt();
    stream.finish("succeeded");
    expect(stream.producedOutput).toBe(true);
  });
});
