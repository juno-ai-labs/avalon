/**
 * What the loop *reports* when it is over: `stopReason` and `RunStats`.
 *
 * Before these existed a host reconstructed the outcome from
 * `state.endedTurnViaTool`, `state.suspended`, and whether the iteration count
 * happened to reach the ceiling — three flags that do not cover every exit and
 * that every host combined slightly differently. These suites pin each exit to
 * exactly one reason, and pin the accounting to numbers a fake clock makes
 * exact rather than approximately-right.
 */
import { describe, expect, it } from "vitest";
import { runToolLoop, type MissingActivationPortError, type ToolCallOutcome } from "../tool-loop";
import { emptyRunStats, type WireToolCall } from "../../contracts/turn";
import {
  finalAnswer,
  freshState,
  loopHarness,
  sleep,
  toolCall,
  toolCallTurn,
  toolOutcome,
} from "../../testing";

/** `ChatCompletionMessageToolCall` is a union; only the function variant has a name. */
function toolName(call: WireToolCall): string {
  return call.type === "function" ? call.function.name : call.type;
}

/**
 * A clock the test drives. Every duration below is a number this test chose,
 * so an assertion failing means the loop measured the wrong interval — not
 * that the machine was busy.
 */
function fakeClock() {
  let ms = 0;
  return {
    now: () => ms,
    advance(by: number) {
      ms += by;
    },
  };
}

describe("stopReason — one reason per exit", () => {
  it("reports done when the model stops calling tools", async () => {
    const h = loopHarness([
      toolCallTurn([toolCall("search", { q: "bind" })]),
      finalAnswer("Found it."),
    ]);

    const result = await runToolLoop(h.params);

    expect(result.stopReason).toBe("done");
    expect(h.ran).toEqual(["search"]);
  });

  it("reports iteration_limit when the ceiling cuts a working agent off", async () => {
    const h = loopHarness(
      [
        toolCallTurn([toolCall("a")]),
        toolCallTurn([toolCall("b")]),
      ],
      { maxIterations: 2 },
    );

    const result = await runToolLoop(h.params);

    // The distinction that matters: the model never said it was finished. A
    // host reporting this as `done` would tell a user the agent answered them.
    expect(result.stopReason).toBe("iteration_limit");
    expect(result.stats.turns).toBe(2);
  });

  it("distinguishes a run waiting on a person from one that resumes itself", async () => {
    const pause = (resumeKind: "answer" | "wake") =>
      loopHarness([toolCallTurn([toolCall("pause")])], {
        runToolCall: async (tc): Promise<ToolCallOutcome> => ({
          ...toolOutcome(tc.id),
          suspend: { toolCallId: tc.id, reason: "waiting", resumeKind },
        }),
      });

    const asked = pause("answer");
    const asleep = pause("wake");
    const askedResult = await runToolLoop(asked.params);
    const asleepResult = await runToolLoop(asleep.params);

    // The two outcomes whose consequences differ most: one needs a person to
    // act or nothing ever happens; the other needs nobody to do anything. A
    // single `suspended` forced every host back to reading `state.suspended`.
    expect(askedResult.stopReason).toBe("waiting_for_reply");
    expect(asleepResult.stopReason).toBe("resuming_later");
    expect(asked.state.endedTurnViaTool).toBe(true);
    expect(asleep.state.endedTurnViaTool).toBe(true);
    expect(asked.state.suspended?.toolCallId).toBe("pause");
    expect(asleep.state.suspended).toBeUndefined();
  });

  it("reports aborted when the host stops the run mid-flight", async () => {
    const h = loopHarness([toolCallTurn([toolCall("a")])], {
      shouldStop: () => true,
    });

    const result = await runToolLoop(h.params);

    // `shouldStop` fires after the model turn but before the batch, so the
    // agent was still working — an abort, not a finish.
    expect(result.stopReason).toBe("aborted");
    expect(h.ran).toEqual([]);
  });

  it("reports aborted when shouldStop coincides with a turn the nudge hook rejected", async () => {
    // The host's own `onTurnWouldEnd` says this tool-less turn was a stall, not
    // an answer. The stop still wins, but calling it `done` would report a run
    // the host itself judged unfinished as a successful answer.
    const h = loopHarness([finalAnswer("...")], {
      shouldStop: () => true,
      onTurnWouldEnd: () => "Please try again.",
    });

    const result = await runToolLoop(h.params);

    expect(result.stopReason).toBe("aborted");
    // And the nudge was NOT injected — the run is over.
    expect(h.state.messages.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("still reports done when shouldStop coincides with the final answer", async () => {
    const h = loopHarness([finalAnswer("here is your answer")], {
      shouldStop: () => true,
    });

    const result = await runToolLoop(h.params);

    // The answer is already in the transcript and has already gone out
    // through `onAssistantMessage`. Calling that "aborted" would have a host
    // badge a delivered answer as cancelled — or suppress it.
    expect(result.stopReason).toBe("done");
    expect(h.state.messages.at(-1)?.content).toBe("here is your answer");
  });

  it("reports aborted when the batch signal fires", async () => {
    const controller = new AbortController();
    const h = loopHarness(
      [toolCallTurn([toolCall("a"), toolCall("b")]), finalAnswer("unreached")],
      { signal: controller.signal },
    );
    const scripted = h.params.callModel;
    h.params.callModel = async (...args) => {
      const turn = await scripted(...args);
      controller.abort();
      return turn;
    };

    const result = await runToolLoop(h.params);

    expect(result.stopReason).toBe("aborted");
  });

  it("keeps reporting done when onTurnWouldEnd pushes a stalled turn forward", async () => {
    let nudged = false;
    const h = loopHarness([finalAnswer("..."), finalAnswer("Actually, here.")], {
      onTurnWouldEnd: () => {
        if (nudged) return null;
        nudged = true;
        return "Please try again.";
      },
    });

    const result = await runToolLoop(h.params);

    // The nudge is not an exit — it is a continuation, and the run still ends
    // by the model choosing to stop.
    expect(result.stopReason).toBe("done");
    expect(result.stats.turns).toBe(2);
  });

  it("never returns deadline — an expired budget throws instead", async () => {
    const h = loopHarness([toolCallTurn([toolCall("a")])], {
      throwIfTimedOut: () => {
        throw new Error("budget exhausted");
      },
    });

    // Documented in `StopReason`: the wall-clock port is throw-based, so a
    // timeout leaves the loop as an error a host classifies, never as a value.
    // If this ever starts returning, the contract comment is the thing to fix.
    await expect(runToolLoop(h.params)).rejects.toThrow("budget exhausted");
  });
});

describe("RunStats — what the run cost", () => {
  it("separates model time from tool time, per tool", async () => {
    const clock = fakeClock();
    const h = loopHarness(
      [
        toolCallTurn([toolCall("search"), toolCall("read_file")]),
        finalAnswer("done"),
      ],
      {
        now: clock.now,
        // Serial, so each call's interval is measured in isolation and the
        // numbers below are exact. The concurrent case is its own test — see
        // "sums overlapping tool time" — because two calls sharing a clock
        // genuinely overlap and summing them is the intended behaviour, not a
        // measurement error.
        runsSerially: () => true,
        runToolCall: async (tc) => {
          clock.advance(toolName(tc) === "search" ? 30 : 70);
          return toolOutcome(tc.id);
        },
      },
    );
    const scripted = h.params.callModel;
    h.params.callModel = async (...args) => {
      clock.advance(200);
      return await scripted(...args);
    };

    const { stats } = await runToolLoop(h.params);

    expect(stats.turns).toBe(2);
    expect(stats.modelTimeMs).toBe(400);
    expect(stats.toolTimeMs).toBe(100);
    expect(stats.toolTimeBreakdownMs).toEqual({ search: 30, read_file: 70 });
  });

  it("charges each concurrent tool its own duration, not its neighbour's", async () => {
    // Deliberately the REAL clock, with real sleeps. A shared, cooperatively
    // advanced fake clock cannot express concurrency honestly: both workers
    // sample the same `startedAt`, and whichever call's `finally` runs last
    // reads a cursor the *other* call already moved — so a fake-clock version
    // of this test pins cross-talk (`search: 100`) and calls it overlap.
    // Ordering, not exact figures, so there is no timing tolerance to tune.
    const h = loopHarness(
      [toolCallTurn([toolCall("quick"), toolCall("slow")]), finalAnswer("done")],
      {
        runToolCall: async (tc) => {
          await sleep(toolName(tc) === "quick" ? 5 : 60);
          return toolOutcome(tc.id);
        },
      },
    );

    const { stats } = await runToolLoop(h.params);

    expect(stats.toolCalls).toBe(2);
    expect(Object.keys(stats.toolTimeBreakdownMs).sort()).toEqual(["quick", "slow"]);
    // If a call were charged for its neighbour's time these would converge.
    expect(stats.toolTimeBreakdownMs.slow).toBeGreaterThan(
      stats.toolTimeBreakdownMs.quick!,
    );
    expect(stats.toolTimeBreakdownMs.quick).toBeGreaterThan(0);
    // Ran concurrently, so the batch's wall-clock is about the slow call alone
    // while the sum counts both — the cost-vs-latency distinction `RunStats`
    // exists to keep.
    expect(stats.toolTimeMs).toBe(
      stats.toolTimeBreakdownMs.quick! + stats.toolTimeBreakdownMs.slow!,
    );
  });

  it("agrees with the mutated state on tokens and cost", async () => {
    const h = loopHarness([
      toolCallTurn([toolCall("a")], { inputTokens: 100, outputTokens: 20, costCents: 3 }),
      finalAnswer("done", { inputTokens: 150, outputTokens: 30, costCents: 4 }),
    ]);

    const { stats } = await runToolLoop(h.params);

    // Two shapes of the same money. If these ever disagree, one of them is
    // billing a customer wrong.
    expect(stats.inputTokens).toBe(h.state.inputTokens);
    expect(stats.outputTokens).toBe(h.state.outputTokens);
    expect(stats.costCents).toBe(h.state.costCents);
    expect(stats.inputTokens).toBe(250);
    expect(stats.costCents).toBe(7);
  });

  it("counts dispatched tool calls, not requested ones", async () => {
    const controller = new AbortController();
    const h = loopHarness([toolCallTurn([toolCall("a"), toolCall("b")])], {
      signal: controller.signal,
    });
    const scripted = h.params.callModel;
    h.params.callModel = async (...args) => {
      const turn = await scripted(...args);
      controller.abort();
      return turn;
    };

    const { stats } = await runToolLoop(h.params);

    // The model asked for two; the aborted batch refused both at claim time.
    // The gap between these numbers IS the work the abort prevented, which is
    // why they are two fields and not one.
    expect(h.state.toolCalls).toBe(2);
    expect(stats.toolCalls).toBe(0);
    expect(h.ran).toEqual([]);
  });

  it("records a failing tool's time — it still consumed it", async () => {
    const clock = fakeClock();
    const h = loopHarness(
      [toolCallTurn([toolCall("flaky")]), finalAnswer("recovered")],
      {
        now: clock.now,
        runToolCall: async () => {
          clock.advance(45);
          throw new Error("upstream down");
        },
      },
    );

    const { stats } = await runToolLoop(h.params);

    expect(stats.toolCalls).toBe(1);
    expect(stats.toolTimeBreakdownMs).toEqual({ flaky: 45 });
    // The run survives — the failure became a tool message the model read.
    expect(stats.turns).toBe(2);
  });

  it("charges a compaction's spend without counting it as a turn", async () => {
    const clock = fakeClock();
    const h = loopHarness(
      [toolCallTurn([toolCall("a")]), finalAnswer("done")],
      {
        now: clock.now,
        needsCompaction: () => true,
        applyCompaction: async (_trigger, messages) => {
          clock.advance(500);
          return {
            messages: [...messages],
            inputTokens: 4_000,
            outputTokens: 600,
            costCents: 9,
            persist: async () => {
              // Host I/O, deliberately after the clock read below — it must
              // not land in `modelTimeMs`.
              clock.advance(1_000);
            },
          };
        },
      },
    );

    const { stats } = await runToolLoop(h.params);

    // Two model turns; the compaction is a third model call but not a third
    // turn, so `stats.turns` stays comparable with `maxIterations`.
    expect(stats.turns).toBe(2);
    expect(stats.inputTokens).toBe(4_020);
    expect(stats.costCents).toBe(11);
    // 500ms of compaction, and none of the 1,000ms of persistence.
    expect(stats.modelTimeMs).toBe(500);
  });

  it("sums cached input tokens the transport reports, and skips those it does not", async () => {
    // Scripted straight through the published fixture — no `callModel`
    // monkey-patching, which is the point of `@juno-ai/bind/testing`.
    const h = loopHarness([
      toolCallTurn([toolCall("a")], { cachedInputTokens: 100 }),
      toolCallTurn([toolCall("b")]), // a transport that cannot report one
      finalAnswer("done", { cachedInputTokens: 300 }),
    ]);

    const { stats } = await runToolLoop(h.params);

    // 100 + (skipped) + 300. An unreported turn contributes nothing rather
    // than counting a zero, which is why the total reads as a floor.
    expect(stats.cachedInputTokens).toBe(400);
    expect(stats.turns).toBe(3);
  });

  it("counts a compaction's cached tokens too", async () => {
    const h = loopHarness([toolCallTurn([toolCall("a")]), finalAnswer("done")], {
      needsCompaction: () => true,
      applyCompaction: async (_t, messages) => ({
        messages: [...messages],
        inputTokens: 4_000,
        outputTokens: 600,
        costCents: 9,
        cachedInputTokens: 3_200,
        persist: async () => {},
      }),
    });

    const { stats } = await runToolLoop(h.params);

    expect(stats.cachedInputTokens).toBe(3_200);
    expect(stats.turns).toBe(2);
  });

  it("does not claim state and stats agree once the caller seeds state", async () => {
    // A host resuming a run seeds `state` from the stored totals — Monad's
    // executor does exactly that. `stats` is this invocation's contribution
    // alone, so the two are different numbers answering different questions,
    // and substituting one for the other under-bills.
    const state = freshState({ inputTokens: 5_000, outputTokens: 900, costCents: 42 });
    const h = loopHarness(
      [finalAnswer("done", { inputTokens: 100, outputTokens: 20, costCents: 3 })],
      { state },
    );

    const { stats } = await runToolLoop(h.params);

    expect(stats.costCents).toBe(3);
    expect(h.state.costCents).toBe(45);
    expect(stats.inputTokens).toBe(100);
    expect(h.state.inputTokens).toBe(5_100);
  });

  it("returns an empty-but-shaped stats object for a run that did nothing", async () => {
    const h = loopHarness([], { maxIterations: 0 });

    const { stopReason, stats } = await runToolLoop(h.params);

    expect(stopReason).toBe("iteration_limit");
    // The whole shape, so a field added to `RunStats` without a zero default
    // fails here rather than shipping as `undefined`.
    expect(stats).toEqual(emptyRunStats());
  });
});

describe("the ports a host no longer has to supply", () => {
  it("runs with neither activatePlugins nor activateSkills wired", async () => {
    // A host with a fixed tool surface has nothing to activate. Requiring an
    // empty function from it bought nothing.
    //
    // The rejection observer is the whole test. The lines this guards sit
    // inside the serial phase's `try`, whose `catch` synthesizes a tool error
    // and continues — so asserting only on `stopReason` and `stats` passes
    // even when the optional call is mutated back to a required one, because
    // the resulting TypeError is swallowed. Silence is the assertion.
    const rejected: unknown[] = [];
    const h = loopHarness(
      [toolCallTurn([toolCall("do_work")]), finalAnswer("done")],
      {
        runsSerially: () => true,
        onToolCallRejected: (_id, error) => rejected.push(error),
        runToolCall: async (tc) => toolOutcome(tc.id),
      },
    );

    const result = await runToolLoop(h.params);

    expect(rejected).toEqual([]);
    expect(result.stopReason).toBe("done");
    expect(result.stats.toolCalls).toBe(1);
  });

  it("reports a tool that asked to activate when no activator is wired", async () => {
    // The port is optional; dropping an activation request silently is not.
    // Unreported, the model gets a success for `load_plugin`, never sees the
    // tools, and re-calls it every iteration until the budget is gone.
    const rejected: unknown[] = [];
    const h = loopHarness(
      [toolCallTurn([toolCall("load_plugin")]), finalAnswer("done")],
      {
        runsSerially: () => true,
        onToolCallRejected: (_id, error) => rejected.push(error),
        runToolCall: async (tc) => ({
          ...toolOutcome(tc.id),
          loadedPluginName: "some-plugin",
          loadedSkillRef: "some-skill",
        }),
      },
    );

    const result = await runToolLoop(h.params);

    // One for each unwired port; the run still completes, because the call
    // itself succeeded and failing it would be worse than the lost activation.
    expect(rejected).toHaveLength(2);
    expect(rejected.map((e) => (e as MissingActivationPortError).port).sort()).toEqual([
      "activatePlugins",
      "activateSkills",
    ]);
    expect(result.stopReason).toBe("done");
  });

  it("stays silent when the activators ARE wired", async () => {
    const rejected: unknown[] = [];
    const activated: string[] = [];
    const h = loopHarness(
      [toolCallTurn([toolCall("load_plugin")]), finalAnswer("done")],
      {
        runsSerially: () => true,
        onToolCallRejected: (_id, error) => rejected.push(error),
        activatePlugins: (names) => activated.push(...names),
        activateSkills: () => {},
        runToolCall: async (tc) => ({
          ...toolOutcome(tc.id),
          loadedPluginName: "some-plugin",
        }),
      },
    );

    await runToolLoop(h.params);

    expect(rejected).toEqual([]);
    expect(activated).toEqual(["some-plugin"]);
  });
});

describe("measuring a tool call can never change its outcome", () => {
  it("survives a tool call the wire type says cannot exist", async () => {
    // `ChatCompletionMessageToolCall` types `function` as required; this repo
    // knows better (`completion/tool-calls.ts` types it optional). Reading it
    // unguarded inside the accounting `finally` turned a tool that RAN — side
    // effect and all — into a synthesized "it failed" the model then acted on,
    // because a throw in a `finally` replaces the value the `try` produced.
    const rejected: unknown[] = [];
    const h = loopHarness([finalAnswer("unused")], {
      runsSerially: () => true,
      onToolCallRejected: (_id, error) => rejected.push(error),
      runToolCall: async (tc) => toolOutcome(tc.id, { ran: true }),
      maxIterations: 1,
    });
    // @ts-expect-error The provider omitted the required function field.
    const bare: WireToolCall = { id: "c1", type: "function" };
    h.params.callModel = async () => ({
      message: {
        role: "assistant",
        content: null,
        refusal: null,
        tool_calls: [bare],
      },
      inputTokens: 1,
      outputTokens: 1,
      costCents: 0,
    });

    const result = await runToolLoop(h.params);

    expect(rejected).toEqual([]);
    // The call ran and its real result reached the transcript.
    expect(h.state.messages.at(-1)?.content).toBe('{"success":true,"data":{"ran":true}}');
    // And it was still counted, under a fenced synthetic key.
    expect(result.stats.toolCalls).toBe(1);
    expect(Object.keys(result.stats.toolTimeBreakdownMs)).toEqual(["__unnamed__"]);
  });
});
