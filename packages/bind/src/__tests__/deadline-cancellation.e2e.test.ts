/**
 * The deadline and the cancellation signal, composed with the loop and the
 * per-tool worker pool.
 *
 * `createRunDeadline` had never been wired into `runToolLoop` by any test in
 * this package: the loop's `throwIfTimedOut` is exercised with a synchronous
 * stub that throws before `callModel`, and the deadline is exercised with no
 * loop at all. That split hides the only question that matters about a
 * deadline, which is not "does it fire" but **"what has already happened by the
 * time anyone checks it"**.
 *
 * The answer is worse than the abstraction suggests, and several tests below
 * pin behaviour that is a **defect rather than a design**. Each says so.
 * `runToolCallsPooledByTool` takes no `AbortSignal` (`run/tool-batch.ts:44-47`)
 * and awaits `Promise.all` over its workers, and `runToolLoop` checks the
 * deadline only at the top of an iteration (`loop/tool-loop.ts:341`). So a
 * deadline that fires while the model is being called still lets the entire
 * tool batch run its side effects, and one hung tool holds the run open past
 * its budget indefinitely. `RunDeadline.signal` is documented as "thread into
 * every model and tool call" — the loop has no port through which to thread it.
 */
import { describe, expect, test } from "vitest";
import { runToolLoop } from "../loop/tool-loop";
import { runToolCallsPooledByTool } from "../run/tool-batch";
import { classifyRunFailure, createRunDeadline, RunTimeoutError } from "../run/harness";
import { AbortedToolCallError } from "../run/tool-batch";
import { assistant, loopHarness, sleep, toolOutcome } from "../testing";
import type OpenAI from "openai";

const call = (id: string, name = "work"): OpenAI.ChatCompletionMessageToolCall => ({
  id,
  type: "function",
  function: { name, arguments: "{}" },
});

describe("a deadline that fires while the model is being called", () => {
  test("a batch dispatched after the budget expired runs no side effects", async () => {
    // The deadline expires during `callModel`. The loop pushes the assistant
    // message and reaches the batch — where every call is now refused, because
    // the run was already over before any of them was claimed. Without the
    // signal these three wrote, emailed and POSTed past the deadline; no polling
    // interval fixes that, because the batch has already started by then.
    const deadline = createRunDeadline({ timeoutMs: 50, label: "test run" });
    const { params, sideEffects, state } = loopHarness(
      [], // the callModel override below supplies the turn
      {
        throwIfTimedOut: () => deadline.throwIfTimedOut(),
        signal: deadline.signal,
        callModel: async () => {
          await sleep(120); // deadline fires in here
          return {
            message: assistant("working", [
              { id: "a", name: "write" },
              { id: "b", name: "email" },
              { id: "c", name: "post" },
            ]),
            inputTokens: 1,
            outputTokens: 1,
            costCents: 0,
          };
        },
      },
    );

    await expect(runToolLoop(params)).rejects.toThrow(RunTimeoutError);
    deadline.dispose();

    expect(deadline.timedOut).toBe(true);
    expect(sideEffects).toEqual([]);
    // Every call still gets an answer — the loop synthesizes one from the
    // rejection — so no `tool_call_id` is left unpaired for the validator.
    expect(state.messages.filter((m) => m.role === "tool")).toHaveLength(3);
  });

  test("a call already in flight is left alone; only the queue is refused", async () => {
    // The boundary of what a signal can do. Eight calls to one tool means five
    // run and three queue; aborting mid-batch must not try to reach inside the
    // five that are already executing, and must refuse all three that are not.
    const controller = new AbortController();
    const started: string[] = [];
    const completed: string[] = [];
    const calls = Array.from({ length: 8 }, (_, i) => call(`c${i}`, "same_tool"));

    const settled = await runToolCallsPooledByTool(
      calls,
      async (tc) => {
        started.push(tc.id);
        // Abort once the pool is saturated, so all five workers are genuinely
        // in flight and the three queued calls are the only ones left to refuse.
        if (started.length === 5) controller.abort();
        await sleep(2);
        completed.push(tc.id);
        return tc.id;
      },
      { signal: controller.signal },
    );

    expect(started).toHaveLength(5);
    expect(completed).toHaveLength(5);
    const refused = settled.filter((r) => r.status === "rejected");
    expect(refused).toHaveLength(3);
    expect(
      refused.every(
        (r) => r.status === "rejected" && r.reason instanceof AbortedToolCallError,
      ),
    ).toBe(true);
  });

  test("REMAINING LIMIT: a tool already running still holds the run past its budget", async () => {
    // The signal stops the pool CLAIMING new work; it cannot cancel a call that
    // is already executing, because that would mean reaching inside a host's
    // tool. So a single hung tool still extends the run by however long it runs,
    // and a host that needs more than this must thread the same signal into its
    // own tools. Asserted on a flag rather than wall-clock time so a loaded
    // runner cannot flake it either way.
    const deadline = createRunDeadline({ timeoutMs: 50, label: "test run" });
    let toolFinished = false;
    const { params } = loopHarness([], {
      throwIfTimedOut: () => deadline.throwIfTimedOut(),
      // Wired deliberately: without it this test asserts only that a tool which
      // awaits a sleep sets a flag afterwards, which is true with or without the
      // feature. With it, the assertion is the real one — even given the signal,
      // an in-flight call still completes and still extends the run.
      signal: deadline.signal,
      callModel: async () => ({
        message: assistant("slow", [{ id: "slow", name: "sleep" }]),
        inputTokens: 1,
        outputTokens: 1,
        costCents: 0,
      }),
      runToolCall: async (tc) => {
        await sleep(120);
        toolFinished = true;
        return toolOutcome(tc.id);
      },
    });

    await expect(runToolLoop(params)).rejects.toThrow(RunTimeoutError);
    deadline.dispose();
    expect(deadline.timedOut).toBe(true);
    // The budget expired while it ran, and the run did not end until it did.
    expect(toolFinished).toBe(true);
  });

  test("the deadline DOES stop the next model turn, which is the boundary it owns", async () => {
    // The half that works, asserted so the defects above are not mistaken for
    // "the deadline does nothing". Turn 1 completes; the deadline fires during
    // the tool batch; turn 2 never happens.
    const deadline = createRunDeadline({ timeoutMs: 50, label: "test run" });
    let modelCalls = 0;
    const { params } = loopHarness([], {
      throwIfTimedOut: () => deadline.throwIfTimedOut(),
      callModel: async () => {
        modelCalls += 1;
        return {
          message: assistant("turn", [{ id: `t${modelCalls}`, name: "work" }]),
          inputTokens: 1,
          outputTokens: 1,
          costCents: 0,
        };
      },
      runToolCall: async (tc) => {
        await sleep(120);
        return toolOutcome(tc.id);
      },
    });

    await expect(runToolLoop(params)).rejects.toThrow(RunTimeoutError);
    deadline.dispose();
    expect(modelCalls).toBe(1);
  });

  test("classifyRunFailure reads a real deadline's outcome, not just its error", async () => {
    const deadline = createRunDeadline({ timeoutMs: 50, label: "test run" });
    const { params } = loopHarness([], {
      throwIfTimedOut: () => deadline.throwIfTimedOut(),
      callModel: async () => {
        await sleep(120);
        return {
          message: assistant("done"),
          inputTokens: 1,
          outputTokens: 1,
          costCents: 0,
        };
      },
    });

    let thrown: unknown;
    try {
      await runToolLoop(params);
    } catch (error) {
      thrown = error;
    }
    expect(classifyRunFailure(deadline, thrown)).toBe("timed_out");
    // And an unrelated failure under an unfired deadline is not a timeout.
    const live = createRunDeadline({ timeoutMs: 10_000, label: "test run" });
    expect(classifyRunFailure(live, new Error("boom"))).toBe("failed");
    deadline.dispose();
    live.dispose();
  });
});

describe("cancellation landing inside a pooled tool batch", () => {
  test("without a signal the pool still drains its queue — the opt-in is real", async () => {
    // The before picture, kept deliberately: an existing host that has not
    // passed a signal gets exactly the old behaviour, so adopting the port is a
    // choice rather than a surprise. Eight calls, five running, three queued,
    // all eight execute.
    const executed: string[] = [];
    const calls = Array.from({ length: 8 }, (_, i) => call(`c${i}`, "same_tool"));

    const settled = await runToolCallsPooledByTool(calls, async (tc) => {
      await sleep(1);
      executed.push(tc.id);
      return tc.id;
    });

    expect(executed).toHaveLength(8);
    expect(settled.every((r) => r.status === "fulfilled")).toBe(true);
  });

  test("the serial phase respects the signal too, not just the pool", async () => {
    // Activation calls run serially BEFORE the pool. Without the same check they
    // would all execute ahead of a pool that refuses everything — the loudest
    // possible inconsistency, since those are the calls that mutate the run's
    // capabilities.
    const controller = new AbortController();
    controller.abort();
    const ran: string[] = [];
    const { params, state } = loopHarness([], {
      signal: controller.signal,
      callModel: async () => ({
        message: assistant("batch", [
          { id: "s1", name: "load_plugin" },
          { id: "s2", name: "load_plugin" },
        ]),
        inputTokens: 1,
        outputTokens: 1,
        costCents: 0,
      }),
      runsSerially: () => true,
      runToolCall: async (tc) => {
        ran.push(tc.id);
        return toolOutcome(tc.id);
      },
      maxIterations: 1,
    });

    await runToolLoop(params);
    expect(ran).toEqual([]);
    // Both still answered, so the transcript stays pairable.
    expect(state.messages.filter((m) => m.role === "tool")).toHaveLength(2);
  });

  test("the loop's post-batch cancellation boundary does stop the NEXT turn", async () => {
    // What actually protects the user: `ensureNotCancelled` after the batch
    // (`loop/tool-loop.ts:570`). The batch that was already running completes,
    // and nothing further is dispatched.
    class Cancelled extends Error {
      override name = "AgentRunCancelledError";
    }
    let cancelledAfter = 0;
    const dispatched: string[] = [];
    const { params } = loopHarness([], {
      callModel: async () => ({
        message: assistant("turn", [{ id: `t${cancelledAfter}`, name: "work" }]),
        inputTokens: 1,
        outputTokens: 1,
        costCents: 0,
      }),
      runToolCall: async (tc) => {
        cancelledAfter += 1;
        dispatched.push(tc.id);
        return toolOutcome(tc.id);
      },
      ensureNotCancelled: () => {
        if (cancelledAfter > 0) throw new Cancelled("cancelled");
      },
    });

    await expect(runToolLoop(params)).rejects.toThrow("cancelled");
    expect(dispatched).toEqual(["t0"]);
  });

  test("the post-batch check runs BEFORE compaction, not just before the next turn", async () => {
    // Isolating the boundary at `loop/tool-loop.ts:570`. Deleting it entirely
    // still leaves the top-of-iteration check, so a run cancelled during a batch
    // still stops — one iteration later, having first compacted the transcript,
    // drained the user's queued interrupts into it, and possibly persisted all
    // of that. A cancelled run must not rewrite the transcript on its way out.
    //
    // Without this test that deletion is invisible: every other cancellation
    // assertion passes on the later check.
    let compactions = 0;
    let interruptsDrained = 0;
    let cancelledDuringBatch = false;
    const { params } = loopHarness([], {
      callModel: async () => ({
        message: assistant("turn", [{ id: "t", name: "work" }]),
        inputTokens: 1,
        outputTokens: 1,
        costCents: 0,
      }),
      runToolCall: async (tc) => ({ ...toolOutcome(tc.id), requestCompaction: true }),
      applyCompaction: async (_reason, messages) => {
        compactions += 1;
        return {
          messages: [...messages],
          inputTokens: 1,
          outputTokens: 1,
          costCents: 0,
          persist: async () => {},
        };
      },
      drainInterrupts: () => {
        interruptsDrained += 1;
        return [{ userId: "u1", content: "wait, actually…" }];
      },
      ensureNotCancelled: () => {
        // Not cancelled at the top of iteration 1; cancelled by the time the
        // batch finishes — the ordinary shape of hitting stop mid-tool.
        if (compactions === 0 && interruptsDrained === 0 && cancelledDuringBatch) {
          throw Object.assign(new Error("cancelled"), {
            name: "AgentRunCancelledError",
          });
        }
      },
    });
    // Flip it once the first tool has been dispatched.
    const originalRunToolCall = params.runToolCall;
    params.runToolCall = async (tc) => {
      cancelledDuringBatch = true;
      return originalRunToolCall(tc);
    };

    await expect(runToolLoop(params)).rejects.toThrow("cancelled");
    expect(compactions).toBe(0);
    expect(interruptsDrained).toBe(0);
  });

  test("a fatal tool error aborts the batch's REMAINING turns but not its siblings", async () => {
    // `isFatalToolError` rethrows after the batch settles, not during it — so
    // every sibling in the same batch still ran. Worth pinning because the
    // loop's comment calls this an "immediate abort", and it is immediate only
    // with respect to the next iteration.
    class Fatal extends Error {
      override name = "AgentRunCancelledError";
    }
    const completed: string[] = [];
    const { params } = loopHarness([], {
      callModel: async () => ({
        message: assistant("batch", [
          { id: "a", name: "one" },
          { id: "b", name: "two" },
          { id: "c", name: "three" },
        ]),
        inputTokens: 1,
        outputTokens: 1,
        costCents: 0,
      }),
      runToolCall: async (tc) => {
        if (tc.id === "b") throw new Fatal("fatal");
        completed.push(tc.id);
        return toolOutcome(tc.id);
      },
      isFatalToolError: (err) => err instanceof Error && err.name === "AgentRunCancelledError",
    });

    await expect(runToolLoop(params)).rejects.toThrow("fatal");
    expect(completed.sort()).toEqual(["a", "c"]);
  });
});

describe("the pool's own ordering and isolation, under a composed batch", () => {
  test("different tools fan out fully; the same tool is capped at five", async () => {
    // The cap is per tool NAME. Asserted through concurrency high-water marks
    // rather than timing, so it cannot flake on a loaded runner.
    let live = 0;
    let peakSame = 0;
    let peakAcross = 0;
    const perTool = new Map<string, number>();

    const calls = [
      ...Array.from({ length: 8 }, (_, i) => call(`s${i}`, "same")),
      ...Array.from({ length: 4 }, (_, i) => call(`d${i}`, `distinct_${i}`)),
    ];

    await runToolCallsPooledByTool(calls, async (tc) => {
      const name = tc.type === "function" ? tc.function.name : "?";
      live += 1;
      const n = (perTool.get(name) ?? 0) + 1;
      perTool.set(name, n);
      if (name === "same") peakSame = Math.max(peakSame, n);
      peakAcross = Math.max(peakAcross, live);
      await sleep(2);
      perTool.set(name, (perTool.get(name) ?? 1) - 1);
      live -= 1;
      return tc.id;
    });

    expect(peakSame).toBe(5);
    // Five from `same` plus the four distinct tools, all at once.
    expect(peakAcross).toBeGreaterThan(5);
  });

  test("results stay in call order however the workers interleave", async () => {
    // The loop pairs `settled[j]` with `deferredCalls[j]` positionally
    // (`loop/tool-loop.ts:485-489`), so a pool that returned completion order
    // would answer every tool call with another call's result — and both would
    // parse.
    const calls = Array.from({ length: 6 }, (_, i) => call(`c${i}`, "same"));
    const settled = await runToolCallsPooledByTool(calls, async (tc) => {
      // Reverse the natural completion order: later indices finish first.
      const index = Number(tc.id.slice(1));
      await sleep((6 - index) * 2);
      return tc.id;
    });

    expect(
      settled.map((r) => (r.status === "fulfilled" ? r.value : `rejected`)),
    ).toEqual(["c0", "c1", "c2", "c3", "c4", "c5"]);
  });

  test("one rejection does not sink its pool-mates", async () => {
    const calls = Array.from({ length: 4 }, (_, i) => call(`c${i}`, "same"));
    const settled = await runToolCallsPooledByTool(calls, async (tc) => {
      if (tc.id === "c1") throw new Error("nope");
      return tc.id;
    });
    expect(settled.map((r) => r.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
      "fulfilled",
    ]);
  });
});
