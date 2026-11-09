/**
 * The complete surface of an aborted tool batch.
 *
 * `deadline-cancellation.e2e.test.ts` proves the *deadline* reaches the batch.
 * This suite owns everything that happens once it does, because the abort path
 * touches five seams that a review found were each individually untested and
 * mutually inconsistent: the pool's claim-time check, the serial phase's, the
 * fatal-error classifier, the rejection observer, and the message the model
 * ends up reading.
 *
 * The through-line worth stating once: **a refused call is not a failed call.**
 * Everything below exists so that distinction survives from the pool, through
 * the loop, into the transcript, and out to a host's log — because the envelope
 * a tool failure travels in (`success: false` plus a sentence) is byte-identical
 * to the one a refusal would otherwise use, and a model that cannot tell them
 * apart will retry a write that never happened or tell a user it failed.
 */
import { describe, expect, test } from "vitest";
import type OpenAI from "openai";
import { runToolLoop } from "../loop/tool-loop";
import {
  runToolCallsPooledByTool,
  AbortedToolCallError,
  ABORTED_TOOL_CALL_MESSAGE,
  type ToolBatchOptions,
} from "../run/index";
import { validateAndHealMessages } from "../transcript/validate";
import { assistant, loopHarness, sleep, toolOutcome } from "../testing";

const call = (id: string, name = "work"): OpenAI.ChatCompletionMessageToolCall => ({
  id,
  type: "function",
  function: { name, arguments: "{}" },
});

/** The parsed body of a synthesized tool message, which is what the model reads. */
function toolAnswers(messages: readonly OpenAI.ChatCompletionMessageParam[]) {
  return messages.flatMap((m) =>
    m.role === "tool"
      ? [{ id: m.tool_call_id, body: JSON.parse(String(m.content)) as Record<string, unknown> }]
      : [],
  );
}

describe("the published surface", () => {
  test("everything the contract names is reachable from `@juno-ai/bind/run`", () => {
    // The import at the top of this file IS the assertion — it resolves through
    // the barrel, not the deep module path. Every other test in the repo imported
    // `../run/tool-batch` directly, which is a path no consumer can use, so the
    // changelog could promise `instanceof AbortedToolCallError` while the class
    // was unreachable from the published entry point and nothing noticed.
    expect(typeof AbortedToolCallError).toBe("function");
    expect(typeof ABORTED_TOOL_CALL_MESSAGE).toBe("string");
    const options: ToolBatchOptions = { signal: new AbortController().signal };
    expect(options.signal?.aborted).toBe(false);
  });

  test("the error carries its id as a field, not inside the message", () => {
    // The message is model-facing and must stay constant; the id is for the
    // host's log filter. Interpolating it does both jobs badly.
    const error = new AbortedToolCallError("call_abc");
    expect(error.toolCallId).toBe("call_abc");
    expect(error.message).toBe(ABORTED_TOOL_CALL_MESSAGE);
    expect(error.message).not.toContain("call_abc");
  });

  test("the message says nothing was attempted, and names no harness internals", () => {
    // A model reading `success: false` plus a sentence has only the prose to go
    // on. It must state the consequence first, and must not spend its most-read
    // clause on batches, workers or claims — concepts the model cannot act on and
    // has never seen elsewhere in its context.
    expect(ABORTED_TOOL_CALL_MESSAGE).toMatch(/never started/i);
    expect(ABORTED_TOOL_CALL_MESSAGE).toMatch(/nothing (happened|changed)/i);
    for (const internal of ["batch", "worker", "claim", "pool", "queue"]) {
      expect(ABORTED_TOOL_CALL_MESSAGE.toLowerCase()).not.toContain(internal);
    }
  });
});

describe("the pool refuses at claim time", () => {
  test("no signal means the queue still drains — the port is genuinely opt-in", async () => {
    const executed: string[] = [];
    const settled = await runToolCallsPooledByTool(
      Array.from({ length: 8 }, (_, i) => call(`c${i}`, "same")),
      async (tc) => {
        await sleep(1);
        executed.push(tc.id);
        return tc.id;
      },
    );
    expect(executed).toHaveLength(8);
    expect(settled.every((r) => r.status === "fulfilled")).toBe(true);
  });

  test("a signal aborted before the batch refuses every call", async () => {
    const controller = new AbortController();
    controller.abort();
    const executed: string[] = [];
    const settled = await runToolCallsPooledByTool(
      [call("a"), call("b")],
      async (tc) => {
        executed.push(tc.id);
        return tc.id;
      },
      { signal: controller.signal },
    );
    expect(executed).toEqual([]);
    expect(settled.every((r) => r.status === "rejected")).toBe(true);
  });

  test("every refused index still gets a result, so positional pairing survives", async () => {
    // The loop pairs `settled[j]` with `deferredCalls[j]` positionally. A hole
    // would answer every later tool call with another call's result — and both
    // would parse.
    const controller = new AbortController();
    const calls = Array.from({ length: 9 }, (_, i) => call(`c${i}`, "same"));
    const settled = await runToolCallsPooledByTool(
      calls,
      async (tc) => {
        if (tc.id === "c4") controller.abort();
        return tc.id;
      },
      { signal: controller.signal },
    );
    expect(settled).toHaveLength(9);
    expect(settled.every((r) => r !== undefined)).toBe(true);
  });

  test("the refusal reason is the exported error, carrying the right id", async () => {
    const controller = new AbortController();
    controller.abort();
    const settled = await runToolCallsPooledByTool(
      [call("only")],
      async (tc) => tc.id,
      { signal: controller.signal },
    );
    const [result] = settled;
    expect(result?.status).toBe("rejected");
    if (result?.status !== "rejected") throw new Error("expected a rejection");
    expect(result.reason).toBeInstanceOf(AbortedToolCallError);
    expect((result.reason as AbortedToolCallError).toolCallId).toBe("only");
  });

  test("calls to DIFFERENT tools are refused too, not just the pooled-behind ones", async () => {
    // Each tool name gets its own worker group, so a per-group check that ran
    // once rather than per claim would refuse one group and drain the rest.
    const controller = new AbortController();
    const executed: string[] = [];
    await runToolCallsPooledByTool(
      [call("a", "alpha"), call("b", "beta"), call("c", "gamma"), call("d", "delta")],
      async (tc) => {
        executed.push(tc.id);
        controller.abort();
        await sleep(1);
        return tc.id;
      },
      { signal: controller.signal },
    );
    // Whichever started first aborted the rest; nothing after it ran.
    expect(executed.length).toBeLessThan(4);
  });
});

describe("the serial phase behaves identically to the pool", () => {
  const abortAfterFirst = () => {
    const controller = new AbortController();
    return { controller, abort: () => controller.abort() };
  };

  test("a mixed batch: the abort crosses the serial/pool boundary", async () => {
    // The check lives INSIDE the per-call loop, so it is re-evaluated per claim.
    // Hoisting it above the loop passes every single-phase test and fails this
    // one — s1 runs, aborts, and s2 must then be refused by the same loop that
    // just let s1 through.
    const { controller } = abortAfterFirst();
    const ran: string[] = [];
    const { params, state } = loopHarness([], {
      signal: controller.signal,
      maxIterations: 1,
      callModel: async () => ({
        message: assistant("batch", [
          { id: "s1", name: "load_plugin" },
          { id: "s2", name: "load_plugin" },
          { id: "p1", name: "work" },
        ]),
        inputTokens: 1,
        outputTokens: 1,
        costCents: 0,
      }),
      runsSerially: (tc) => tc.type === "function" && tc.function.name === "load_plugin",
      runToolCall: async (tc) => {
        ran.push(tc.id);
        if (tc.id === "s1") controller.abort();
        return toolOutcome(tc.id);
      },
    });

    await runToolLoop(params);

    expect(ran).toEqual(["s1"]);
    // All three are still answered — the two refused ones synthesized.
    expect(toolAnswers(state.messages).map((a) => a.id)).toEqual(["s1", "s2", "p1"]);
  });

  test("both phases answer with the same words and the same discriminant", async () => {
    // One condition produced two different strings and only one `kind`, so a
    // model saw the same fact described two ways depending on which half of the
    // batch a call happened to land in.
    const controller = new AbortController();
    controller.abort();
    const { params, state } = loopHarness([], {
      signal: controller.signal,
      maxIterations: 1,
      callModel: async () => ({
        message: assistant("batch", [
          { id: "serial", name: "load_plugin" },
          { id: "pooled", name: "work" },
        ]),
        inputTokens: 1,
        outputTokens: 1,
        costCents: 0,
      }),
      runsSerially: (tc) => tc.type === "function" && tc.function.name === "load_plugin",
    });

    await runToolLoop(params);

    const answers = toolAnswers(state.messages);
    expect(answers).toHaveLength(2);
    for (const { body } of answers) {
      expect(body.success).toBe(false);
      expect(body.kind).toBe("not_run");
      expect(body.error).toBe(ABORTED_TOOL_CALL_MESSAGE);
    }
  });

  test("a refusal is not a failure, and the discriminant is what says so", async () => {
    // The whole point. A genuine failure and a refusal share the envelope; only
    // `kind` separates them, which is why `ToolFailureKind` exists ("so a
    // consumer can branch without matching on the error string").
    const controller = new AbortController();
    const { params, state } = loopHarness([], {
      signal: controller.signal,
      maxIterations: 1,
      callModel: async () => ({
        message: assistant("batch", [
          { id: "real", name: "alpha" },
          { id: "refused", name: "beta" },
        ]),
        inputTokens: 1,
        outputTokens: 1,
        costCents: 0,
      }),
      runToolCall: async (tc) => {
        if (tc.id === "real") {
          controller.abort();
          throw new Error("upstream exploded");
        }
        return toolOutcome(tc.id);
      },
    });

    await runToolLoop(params);

    const answers = Object.fromEntries(toolAnswers(state.messages).map((a) => [a.id, a.body]));
    expect(answers.real?.success).toBe(false);
    expect(answers.real?.kind).toBeUndefined(); // a real failure carries no `not_run`
    expect(answers.refused?.kind).toBe("not_run");
  });

  test("both phases report to the rejection observer", async () => {
    // The serial phase used to synthesize inline and tell nobody, so half the
    // refusals in a mixed batch were invisible in the operator log.
    const controller = new AbortController();
    controller.abort();
    const rejected: Array<[string, unknown]> = [];
    const { params } = loopHarness([], {
      signal: controller.signal,
      maxIterations: 1,
      callModel: async () => ({
        message: assistant("batch", [
          { id: "serial", name: "load_plugin" },
          { id: "pooled", name: "work" },
        ]),
        inputTokens: 1,
        outputTokens: 1,
        costCents: 0,
      }),
      runsSerially: (tc) => tc.type === "function" && tc.function.name === "load_plugin",
      onToolCallRejected: (id, error) => rejected.push([id, error]),
    });

    await runToolLoop(params);

    expect(rejected.map(([id]) => id).sort()).toEqual(["pooled", "serial"]);
    expect(rejected.every(([, e]) => e instanceof AbortedToolCallError)).toBe(true);
  });

  test("both phases honour isFatalToolError identically", async () => {
    // A host that classifies an abort as fatal used to get an immediate throw
    // from the pool and a silent synthesized message from the serial phase.
    const controller = new AbortController();
    controller.abort();
    const { params } = loopHarness([], {
      signal: controller.signal,
      maxIterations: 1,
      callModel: async () => ({
        message: assistant("batch", [{ id: "serial", name: "load_plugin" }]),
        inputTokens: 1,
        outputTokens: 1,
        costCents: 0,
      }),
      runsSerially: () => true,
      isFatalToolError: (err) => err instanceof AbortedToolCallError,
    });

    await expect(runToolLoop(params)).rejects.toBeInstanceOf(AbortedToolCallError);
  });
});

describe("what the loop does after an aborted batch", () => {
  test("the run ends — it does not loop and pay for another model call", async () => {
    // With only `signal` wired and no throw port, the loop used to refuse each
    // batch and start a fresh model call every iteration until `maxIterations`.
    const controller = new AbortController();
    controller.abort();
    let modelCalls = 0;
    const { params } = loopHarness([], {
      signal: controller.signal,
      maxIterations: 8,
      callModel: async () => {
        modelCalls += 1;
        return {
          message: assistant("batch", [{ id: `t${modelCalls}`, name: "work" }]),
          inputTokens: 1,
          outputTokens: 1,
          costCents: 0,
        };
      },
    });

    await runToolLoop(params);
    expect(modelCalls).toBe(1);
  });

  test("the transcript is left pairable, so a resume is not corrupted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { params, state } = loopHarness([], {
      signal: controller.signal,
      maxIterations: 4,
      callModel: async () => ({
        message: assistant("working", [
          { id: "a", name: "w" },
          { id: "b", name: "w" },
          { id: "c", name: "w" },
        ]),
        inputTokens: 1,
        outputTokens: 1,
        costCents: 0,
      }),
    });

    await runToolLoop(params);

    const healed = validateAndHealMessages(state.messages);
    expect(
      healed.issues.some((i) => i.kind === "dangling_tool_calls_unanswered"),
    ).toBe(false);
    expect(toolAnswers(state.messages)).toHaveLength(3);
  });

  test("a suspend in the same batch does not carry the refusals into a persist", async () => {
    // The suspend arm `break`s before the cancellation boundary, so without the
    // abort check placed ahead of it a `wake`-suspend that completed alongside
    // refused siblings exits NORMALLY — and the host then persists a session
    // whose transcript says those tools failed. The next run replays that.
    const controller = new AbortController();
    const { params, state } = loopHarness([], {
      signal: controller.signal,
      maxIterations: 2,
      callModel: async () => ({
        message: assistant("batch", [
          { id: "sleeper", name: "sleep_until" },
          { id: "queued", name: "work" },
        ]),
        inputTokens: 1,
        outputTokens: 1,
        costCents: 0,
      }),
      runToolCall: async (tc) => {
        controller.abort();
        return {
          toolMessage: { role: "tool", tool_call_id: tc.id, content: "{}" },
          suspend: { toolCallId: tc.id, reason: "later", resumeKind: "wake" as const },
        };
      },
    });

    await runToolLoop(params);

    // The run ended without being treated as an ordinary tool-driven suspend.
    expect(state.endedTurnViaTool).toBeUndefined();
  });

  test("throwIfTimedOut wins over ensureNotCancelled, so a timeout is not mislabelled", async () => {
    // Both ports are consulted on abort; the order decides which terminal status
    // the host writes. A timed-out run reported as cancelled bills and alerts
    // differently.
    const controller = new AbortController();
    class Timeout extends Error {}
    class Cancelled extends Error {}
    let batchRan = false;
    const { params } = loopHarness([], {
      signal: controller.signal,
      maxIterations: 2,
      callModel: async () => ({
        message: assistant("batch", [{ id: "a", name: "w" }]),
        inputTokens: 1,
        outputTokens: 1,
        costCents: 0,
      }),
      runToolCall: async (tc) => {
        batchRan = true;
        controller.abort();
        return toolOutcome(tc.id);
      },
      // Both ports are ALSO consulted at the top of the iteration, so they must
      // stay silent until the batch has run — otherwise this asserts the
      // top-of-loop order, not the post-batch one, and passes either way.
      throwIfTimedOut: () => {
        if (batchRan) throw new Timeout("timed out");
      },
      ensureNotCancelled: () => {
        if (batchRan) throw new Cancelled("cancelled");
      },
    });

    await expect(runToolLoop(params)).rejects.toBeInstanceOf(Timeout);
  });
});
