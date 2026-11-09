/**
 * The fixtures are published API now, so they get held to the same bar as the
 * rest of the package. Most of what is pinned here is the *failure* behaviour:
 * a test fixture that fails quietly is worse than none, because it turns a
 * mis-specified test into a passing one.
 */
import { describe, expect, it } from "vitest";
import { runToolLoop } from "../../loop/tool-loop";
import {
  assistant,
  finalAnswer,
  freshState,
  loopHarness,
  recordingSink,
  scriptedModel,
  steppingClock,
  toolCall,
  toolCallTurn,
  toolOutcome,
} from "../index";

describe("scriptedModel", () => {
  it("serves the script in order", async () => {
    const model = scriptedModel([
      toolCallTurn([toolCall("a")]),
      finalAnswer("done"),
    ]);

    expect((await model([], undefined)).message.tool_calls).toHaveLength(1);
    expect((await model([], undefined)).message.content).toBe("done");
  });

  it("throws when the script runs out instead of stalling the loop", async () => {
    const model = scriptedModel([finalAnswer("done")]);
    await model([], undefined);

    // The alternative — returning an empty turn — lets `maxIterations` absorb
    // the mistake and report a plausible-looking `iteration_limit`, so the
    // test passes while describing something that never happened.
    await expect(model([], undefined)).rejects.toThrow(
      /script has 1 turn\(s\) and was already exhausted on call 2/,
    );
  });

  it("rejects a duplicate tool-call id up front", () => {
    // Two calls sharing an id produce a transcript the provider rejects, ten
    // frames deep in the loop, with an error naming neither the script nor the
    // duplicate. Catch it at construction where the message can say what to do.
    expect(() =>
      scriptedModel([
        toolCallTurn([toolCall("search")]),
        toolCallTurn([toolCall("search")]),
      ]),
    ).toThrow(/duplicate tool-call id "search"/);
  });

  it("allows the same tool twice when the ids are distinct", () => {
    expect(() =>
      scriptedModel([
        toolCallTurn([toolCall("search", { q: "a" }, "s1")]),
        toolCallTurn([toolCall("search", { q: "b" }, "s2")]),
      ]),
    ).not.toThrow();
  });

  it("defaults usage to non-zero so an accounting assertion cannot pass on an empty fixture", async () => {
    const turn = await scriptedModel([finalAnswer("done")])([], undefined);
    expect(turn.inputTokens).toBeGreaterThan(0);
    expect(turn.outputTokens).toBeGreaterThan(0);
    expect(turn.costCents).toBeGreaterThan(0);
  });

  it("honours explicit per-turn usage", async () => {
    const turn = await scriptedModel([
      finalAnswer("done", { inputTokens: 7, outputTokens: 3, costCents: 0 }),
    ])([], undefined);
    expect(turn.inputTokens).toBe(7);
    expect(turn.outputTokens).toBe(3);
    // Zero must survive, which `||` defaulting would have eaten.
    expect(turn.costCents).toBe(0);
  });
});

describe("toolCall", () => {
  it("serializes structured args", () => {
    expect(toolCall("search", { q: "x" }).args).toBe('{"q":"x"}');
  });

  it("defaults the id to the tool name", () => {
    expect(toolCall("search").id).toBe("search");
  });

  it("passes a raw string through so malformed JSON can be scripted", () => {
    // Models emit truncated JSON; a fixture that cannot express that cannot
    // test the loop's handling of it.
    expect(toolCall("search", '{"q":').args).toBe('{"q":');
  });
});

describe("turn builders", () => {
  it("finalAnswer produces a tool-less turn, which is what ends a loop", async () => {
    const h = loopHarness([finalAnswer("all done")]);
    const { stopReason } = await runToolLoop(h.params);
    expect(stopReason).toBe("done");
  });

  it("toolCallTurn can carry text alongside its calls", () => {
    const turn = toolCallTurn([toolCall("a")], { content: "thinking out loud" });
    expect(turn.message.content).toBe("thinking out loud");
    expect(turn.message.tool_calls).toHaveLength(1);
  });

  it("toolCallTurn defaults to no text", () => {
    expect(toolCallTurn([toolCall("a")]).message.content).toBeNull();
  });
});

describe("loopHarness", () => {
  it("records dispatch and side effect separately", async () => {
    const h = loopHarness([
      toolCallTurn([toolCall("a"), toolCall("b")]),
      finalAnswer("done"),
    ]);

    await runToolLoop(h.params);

    expect(h.ran.sort()).toEqual(["a", "b"]);
    expect(h.sideEffects.sort()).toEqual(["a", "b"]);
  });

  it("records dispatch even when the override forgets to", async () => {
    // The override does NOT touch `h.ran` — the harness records it. Making
    // that the override's job meant the first test to forget silently lost
    // the dispatch-vs-side-effect distinction the harness exists for.
    const h = loopHarness(
      [toolCallTurn([toolCall("a")]), finalAnswer("recovered")],
      {
        runToolCall: async () => {
          throw new Error("nope");
        },
      },
    );

    const { stopReason } = await runToolLoop(h.params);

    expect(stopReason).toBe("done");
    expect(h.ran).toEqual(["a"]);
    // The dispatch happened, the side effect did not — the distinction the
    // two arrays exist for, and the answer to every cancellation question.
    expect(h.sideEffects).toEqual([]);
  });

  it("shares the state object it exposes", async () => {
    const h = loopHarness([finalAnswer("done")]);
    await runToolLoop(h.params);
    expect(h.state).toBe(h.params.state);
    expect(h.state.messages.at(-1)?.content).toBe("done");
  });

  it("accepts a caller-supplied state", () => {
    const state = freshState({ costCents: 42 });
    expect(loopHarness([], { state }).state).toBe(state);
  });
});

describe("freshState", () => {
  it("seeds a usable transcript and zeroed accounting", () => {
    const state = freshState();
    expect(state.messages).toHaveLength(2);
    expect(state.inputTokens).toBe(0);
    expect(state.hasFreshTokenCount).toBe(false);
  });

  it("applies overrides over the defaults", () => {
    expect(freshState({ toolCalls: 3 }).toolCalls).toBe(3);
  });
});

describe("assistant / toolOutcome", () => {
  it("builds a message with no tool_calls key when none are given", () => {
    // Present-but-empty and absent are different to a provider; the fixture
    // must be able to express the tool-less turn exactly.
    expect("tool_calls" in assistant("hi")).toBe(false);
  });

  it("defaults tool arguments to an empty object", () => {
    const call = assistant("x", [{ id: "1", name: "t" }]).tool_calls?.[0];
    expect(call?.type).toBe("function");
    expect(call?.type === "function" && call.function.arguments).toBe("{}");
  });

  it("builds a tool message in the same envelope production uses", () => {
    const outcome = toolOutcome("call_9", { rows: 2 });
    expect(outcome.toolMessage.tool_call_id).toBe("call_9");
    // Not `{"rows":2}` — the fixture goes through `toolResultMessage`, so a
    // transcript a test builds has the shape a real run produces.
    expect(outcome.toolMessage.content).toBe('{"success":true,"data":{"rows":2}}');
  });
});

describe("recordingSink", () => {
  it("carries the retractable decision and records what it is handed", () => {
    const sink = recordingSink(true);
    expect(sink.retractable).toBe(true);
    sink.emit({ kind: "text", turnId: "t", epoch: 0, seq: 0, text: "hi" });
    expect(sink.events).toHaveLength(1);
  });
});

describe("steppingClock", () => {
  it("advances a fixed amount per read", () => {
    const now = steppingClock(5, 100);
    expect([now(), now(), now()]).toEqual([100, 105, 110]);
  });

  it("defaults to a 1ms step from zero", () => {
    const now = steppingClock();
    expect([now(), now()]).toEqual([0, 1]);
  });
});
