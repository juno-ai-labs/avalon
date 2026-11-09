/**
 * What the loop leaves behind, run through the validator that has to repair it.
 *
 * `validateAndHealMessages` has 17 unit tests and every one of them hand-writes
 * the `messages` array it heals. That is the wrong direction: the validator's
 * job is to survive what the *loop* produces, and the shapes the loop actually
 * produces on its exit paths are not the shapes a test author invents. Three of
 * those paths leave an assistant message whose `tool_calls` are unanswered, and
 * healing that shape is lossy in a way that reads as fine.
 *
 * These suites drive `runToolLoop` to each exit and then heal what it left, so
 * the two modules meet. Several assertions pin **lossy-but-current** behaviour
 * rather than desirable behaviour; each says which it is.
 */
import { describe, expect, test } from "vitest";
import type OpenAI from "openai";
import { runToolLoop } from "../loop/tool-loop";
import { validateAndHealMessages } from "../transcript/validate";
import { assistant, loopHarness, toolOutcome } from "../testing";

const toolCallIdsOf = (messages: readonly OpenAI.ChatCompletionMessageParam[]) =>
  messages.flatMap((m) =>
    m.role === "assistant" && m.tool_calls ? m.tool_calls.map((tc) => tc.id) : [],
  );

const answeredIdsOf = (messages: readonly OpenAI.ChatCompletionMessageParam[]) =>
  messages.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : []));

describe("a fatal tool error leaves a transcript that cannot be resumed intact", () => {
  test("LOSSY: healing strips the whole batch, including the calls that succeeded", async () => {
    // The loop rethrows a fatal error after the batch settles and before ANY
    // tool message is appended (`loop/tool-loop.ts:496`), so the assistant turn
    // sits there with three unanswered calls. A host that persists
    // `state.messages` and resumes hands that to the validator, which strips
    // every `tool_calls` entry — erasing the model's request for the two calls
    // that *did* run, and whose side effects already happened.
    //
    // The user-visible shape: work was done, the transcript denies it was ever
    // asked for, and the model re-asks on resume.
    class Fatal extends Error {
      override name = "AgentRunCancelledError";
    }
    const completed: string[] = [];
    const { params, state } = loopHarness([], {
      callModel: async () => ({
        message: assistant("on it", [
          { id: "ok1", name: "write" },
          { id: "boom", name: "explode" },
          { id: "ok2", name: "write" },
        ]),
        inputTokens: 1,
        outputTokens: 1,
        costCents: 0,
      }),
      runToolCall: async (tc) => {
        if (tc.id === "boom") throw new Fatal("fatal");
        completed.push(tc.id);
        return toolOutcome(tc.id);
      },
      isFatalToolError: (err) => err instanceof Error && err.name === "AgentRunCancelledError",
    });

    await expect(runToolLoop(params)).rejects.toThrow("fatal");

    // Two side effects happened; nothing was recorded about any of the three.
    expect(completed.sort()).toEqual(["ok1", "ok2"]);
    expect(toolCallIdsOf(state.messages)).toEqual(["ok1", "boom", "ok2"]);
    expect(answeredIdsOf(state.messages)).toEqual([]);

    const healed = validateAndHealMessages(state.messages);
    expect(healed.issues.map((i) => i.kind)).toContain("dangling_tool_calls_unanswered");
    // The request itself is gone from the healed transcript.
    expect(toolCallIdsOf(healed.messages)).toEqual([]);
  });

  test("declaring the open calls allowed makes the validator THROW instead", async () => {
    // The other arm: pass the ids as legitimately open and the validator refuses
    // rather than healing, because an allowed id arriving unpaired means resume
    // failed to thread its answer. A host must pick one; both are load-bearing
    // and they behave oppositely on the same input.
    const { params, state } = loopHarness([], {
      callModel: async () => ({
        message: assistant("on it", [{ id: "open", name: "ask" }]),
        inputTokens: 1,
        outputTokens: 1,
        costCents: 0,
      }),
      runToolCall: async () => {
        throw Object.assign(new Error("fatal"), { name: "AgentRunCancelledError" });
      },
      isFatalToolError: () => true,
    });
    await expect(runToolLoop(params)).rejects.toThrow("fatal");

    expect(() =>
      validateAndHealMessages(state.messages, new Set(["open"])),
    ).toThrow();
  });
});

describe("shouldStop lands between the assistant turn and its tools", () => {
  test("LOSSY: the same dangling shape, from a path nobody calls an error", async () => {
    // `shouldStop` breaks AFTER the assistant message is pushed and BEFORE any
    // tool runs (`loop/tool-loop.ts:404-407`). This is the ordinary "the agent
    // was disabled mid-run" path — no exception, no failure status — and it
    // produces a transcript the validator has to mutilate to make sendable.
    const { params, state, ran } = loopHarness([], {
      callModel: async () => ({
        message: assistant("about to work", [
          { id: "a", name: "write" },
          { id: "b", name: "write" },
        ]),
        inputTokens: 1,
        outputTokens: 1,
        costCents: 0,
      }),
      shouldStop: () => true,
    });

    await runToolLoop(params); // resolves normally
    expect(ran).toEqual([]);
    expect(toolCallIdsOf(state.messages)).toEqual(["a", "b"]);

    const healed = validateAndHealMessages(state.messages);
    expect(healed.issues.some((i) => i.kind === "dangling_tool_calls_unanswered")).toBe(
      true,
    );
    expect(toolCallIdsOf(healed.messages)).toEqual([]);
  });

  test("a clean turn heals to itself, so the above is the loop's doing", async () => {
    // The control. Without it, "healing strips tool calls" could be read as the
    // validator being over-eager rather than the loop leaving damage.
    const { params, state } = loopHarness([
      { message: assistant("working", [{ id: "a", name: "write" }]) },
      { message: assistant("done") },
    ]);
    await runToolLoop(params);

    const healed = validateAndHealMessages(state.messages);
    expect(toolCallIdsOf(healed.messages)).toEqual(["a"]);
    expect(answeredIdsOf(healed.messages)).toEqual(["a"]);
    expect(healed.issues.map((i) => i.kind)).toEqual(["trailing_assistant_with_content"]);
  });
});

describe("compaction rewrites the transcript and the loop does not re-check it", () => {
  test("a compactor that drops a tool result orphans nothing — it dangles the CALL", async () => {
    // The loop hands the whole array to the host's compactor and swaps in
    // whatever comes back, unvalidated (`loop/tool-loop.ts:335-336`). A
    // summarizer that keeps the assistant turn but drops its results leaves the
    // exact shape the provider 400s on, and the loop happily makes the next
    // model call with it.
    let compacted = 0;
    const { params, state } = loopHarness(
      [
        { message: assistant("step one", [{ id: "a", name: "work" }]) },
        { message: assistant("done") },
      ],
      {
        runToolCall: async (tc) => ({
          ...toolOutcome(tc.id),
          requestCompaction: true,
        }),
        applyCompaction: async (_reason, messages) => {
          compacted += 1;
          return {
            // Drop every tool result, keep everything else — a plausible
            // "summarize the noisy parts" compactor.
            messages: messages.filter((m) => m.role !== "tool"),
            inputTokens: 5,
            outputTokens: 5,
            costCents: 1,
            persist: async () => {},
          };
        },
      },
    );

    await runToolLoop(params);
    expect(compacted).toBe(1);

    // The call survived compaction; its answer did not.
    expect(toolCallIdsOf(state.messages)).toEqual(["a"]);
    expect(answeredIdsOf(state.messages)).toEqual([]);

    const healed = validateAndHealMessages(state.messages);
    expect(healed.issues.some((i) => i.kind === "dangling_tool_calls_unanswered")).toBe(
      true,
    );
  });

  test("a compactor that drops the CALL leaves an orphan result instead", async () => {
    // The mirror image, and the one a naive "keep the last N messages" window
    // produces every time.
    const { params, state } = loopHarness(
      [
        { message: assistant("step one", [{ id: "a", name: "work" }]) },
        { message: assistant("done") },
      ],
      {
        runToolCall: async (tc) => ({
          ...toolOutcome(tc.id),
          requestCompaction: true,
        }),
        applyCompaction: async (_reason, messages) => ({
          messages: messages.filter(
            (m) => !(m.role === "assistant" && m.tool_calls !== undefined),
          ),
          inputTokens: 5,
          outputTokens: 5,
          costCents: 1,
          persist: async () => {},
        }),
      },
    );

    await runToolLoop(params);
    expect(answeredIdsOf(state.messages)).toEqual(["a"]);
    expect(toolCallIdsOf(state.messages)).toEqual([]);

    const healed = validateAndHealMessages(state.messages);
    expect(healed.issues.some((i) => i.kind === "orphan_tool_result")).toBe(true);
    expect(answeredIdsOf(healed.messages)).toEqual([]);
  });

  test("compaction accounting survives the swap, and the token counter resets", async () => {
    // The bookkeeping half: usage from the compaction call itself is added
    // before the swap, and `lastPromptTokens`/`lastOutputTokens` are zeroed so
    // auto-compaction does not immediately re-trigger on a stale count.
    const { params, state } = loopHarness(
      [
        { message: assistant("one", [{ id: "a", name: "work" }]), outputTokens: 100 },
        { message: assistant("done"), outputTokens: 7 },
      ],
      {
        runToolCall: async (tc) => ({
          ...toolOutcome(tc.id),
          requestCompaction: true,
        }),
        applyCompaction: async (_reason, messages) => ({
          messages: [...messages],
          inputTokens: 33,
          outputTokens: 44,
          costCents: 2,
          persist: async () => {},
        }),
      },
    );

    await runToolLoop(params);
    // 100 (turn 1) + 44 (compaction) + 7 (turn 2).
    expect(state.outputTokens).toBe(151);
    // The final turn re-established a real count after the reset.
    expect(state.lastOutputTokens).toBe(7);
  });
});

describe("suspend: the loop trusts an id it never checks", () => {
  test("DEFECT: a mismatched suspend id orphans one call and dangles another", async () => {
    // `state.suspended` is taken verbatim from `outcome.suspend.toolCallId`
    // (`loop/tool-loop.ts:529`) and never reconciled against the `tc.id` whose
    // outcome it is. A host that returns the wrong id — an off-by-one over its
    // own batch, a copied constant — records a call that does not exist and
    // leaves the real one unanswered. Both halves then get healed away, and the
    // resume threads its answer to nothing.
    const { params, state } = loopHarness([], {
      callModel: async () => ({
        message: assistant("asking", [{ id: "real", name: "ask" }]),
        inputTokens: 1,
        outputTokens: 1,
        costCents: 0,
      }),
      runToolCall: async () => ({
        toolMessage: { role: "tool", tool_call_id: "real", content: "{}" },
        suspend: { toolCallId: "TYPO", reason: "waiting", resumeKind: "answer" },
      }),
    });

    await runToolLoop(params);

    expect(state.suspended?.toolCallId).toBe("TYPO");
    // The real call was never answered — its tool message was withheld as if it
    // were the suspended one.
    expect(answeredIdsOf(state.messages)).toEqual([]);
    expect(toolCallIdsOf(state.messages)).toEqual(["real"]);

    // The recorded id saves nothing on resume either: the validator is asked to
    // assert on "TYPO", which is not pending because it does not exist, so the
    // assertion passes vacuously while the call that IS pending gets stripped.
    const healed = validateAndHealMessages(state.messages, new Set(["TYPO"]));
    expect(healed.issues.some((i) => i.kind === "dangling_tool_calls_unanswered")).toBe(
      true,
    );
  });

  test("a correct answer-suspend withholds exactly its own tool message", async () => {
    // The contract when the id is right, so the defect above is legible as a
    // deviation rather than the design.
    const { params, state } = loopHarness([], {
      callModel: async () => ({
        message: assistant("asking", [
          { id: "ask1", name: "ask" },
          { id: "work1", name: "work" },
        ]),
        inputTokens: 1,
        outputTokens: 1,
        costCents: 0,
      }),
      runToolCall: async (tc) =>
        tc.id === "ask1"
          ? {
              toolMessage: { role: "tool", tool_call_id: "ask1", content: "{}" },
              suspend: { toolCallId: "ask1", reason: "waiting", resumeKind: "answer" },
            }
          : toolOutcome(tc.id),
    });

    await runToolLoop(params);
    expect(state.suspended?.toolCallId).toBe("ask1");
    expect(state.endedTurnViaTool).toBe(true);
    // The sibling was answered; the suspended one was withheld for the human.
    expect(answeredIdsOf(state.messages)).toEqual(["work1"]);

    // `allowedOpenToolCallIds` is a fail-loud assertion for the RESUME path, not
    // a keep-list: an allowed id arriving unpaired means resume never threaded
    // its answer, and the validator refuses rather than masking it. So passing
    // the suspended id here — before the human has answered — is exactly the
    // state it exists to catch.
    expect(() => validateAndHealMessages(state.messages, new Set(["ask1"]))).toThrow(
      /UNPAIRED/,
    );

    // Thread the answer, as resume does, and the same call validates clean.
    const resumed = [
      ...state.messages,
      { role: "tool" as const, tool_call_id: "ask1", content: "the human said yes" },
    ];
    const healed = validateAndHealMessages(resumed, new Set(["ask1"]));
    expect(toolCallIdsOf(healed.messages)).toEqual(["ask1", "work1"]);
    expect(answeredIdsOf(healed.messages).sort()).toEqual(["ask1", "work1"]);
  });

  test("a second answer-suspend in one batch is answered, not left unpaired", async () => {
    // Two open questions cannot both be threaded on resume, so the loop answers
    // the second with an error rather than leaving a second unpaired slot.
    const { params, state } = loopHarness([], {
      callModel: async () => ({
        message: assistant("asking twice", [
          { id: "q1", name: "ask" },
          { id: "q2", name: "ask" },
        ]),
        inputTokens: 1,
        outputTokens: 1,
        costCents: 0,
      }),
      runToolCall: async (tc) => ({
        toolMessage: { role: "tool", tool_call_id: tc.id, content: "{}" },
        suspend: { toolCallId: tc.id, reason: "waiting", resumeKind: "answer" },
      }),
    });

    await runToolLoop(params);
    expect(state.suspended?.toolCallId).toBe("q1");
    // q2 was answered with the "one question at a time" error rather than being
    // left as a second unpaired slot that nothing could ever thread.
    expect(answeredIdsOf(state.messages)).toEqual(["q2"]);
    const q2Answer = state.messages.find(
      (m) => m.role === "tool" && m.tool_call_id === "q2",
    );
    // Through the shared encoder like every other synthesized failure, so a
    // host building a taxonomy off `kind` sees a category here rather than an
    // uncategorized error it cannot tell from an unclassified throw.
    expect(JSON.parse(String(q2Answer?.content))).toEqual({
      success: false,
      kind: "conflict",
      error: expect.stringContaining("only one can be open at a time"),
    });

    // Only q1 is open, and it stays open until the human answers.
    expect(() => validateAndHealMessages(state.messages, new Set(["q1"]))).toThrow(
      /UNPAIRED/,
    );
  });

  test("a wake-suspend keeps its tool message and still ends the run", async () => {
    const { params, state } = loopHarness([], {
      callModel: async () => ({
        message: assistant("sleeping", [{ id: "s", name: "sleep_until" }]),
        inputTokens: 1,
        outputTokens: 1,
        costCents: 0,
      }),
      runToolCall: async (tc) => ({
        toolMessage: { role: "tool", tool_call_id: tc.id, content: "{}" },
        suspend: { toolCallId: tc.id, reason: "later", resumeKind: "wake" },
      }),
    });

    await runToolLoop(params);
    expect(state.suspended).toBeUndefined();
    expect(state.endedTurnViaTool).toBe(true);
    expect(answeredIdsOf(state.messages)).toEqual(["s"]);
    // Nothing is open, so it heals to itself apart from the trailing-shape rule.
    expect(
      validateAndHealMessages(state.messages).issues.some(
        (i) => i.kind === "dangling_tool_calls_unanswered",
      ),
    ).toBe(false);
  });
});

describe("the turn-would-end nudge, bounded by the real iteration ceiling", () => {
  test("a nudge injects a synthetic user turn and keeps looping", async () => {
    const nudges: number[] = [];
    const { params, state } = loopHarness(
      [
        { message: assistant("first answer") },
        { message: assistant("second answer") },
        { message: assistant("final answer") },
      ],
      {
        onTurnWouldEnd: (_message, toolCalls) => {
          nudges.push(toolCalls);
          return nudges.length < 3 ? "keep going" : null;
        },
      },
    );

    await runToolLoop(params);
    expect(nudges).toHaveLength(3);
    expect(
      state.messages.filter((m) => m.role === "user" && m.content === "keep going"),
    ).toHaveLength(2);
  });

  test("maxIterations is the hard ceiling a runaway nudge cannot pass", async () => {
    // The hook is self-bounding by contract; this asserts the loop does not rely
    // on that. An always-nudging host must still stop.
    let calls = 0;
    const { params } = loopHarness([], {
      maxIterations: 4,
      callModel: async () => {
        calls += 1;
        return {
          message: assistant("done"),
          inputTokens: 1,
          outputTokens: 1,
          costCents: 0,
        };
      },
      onTurnWouldEnd: () => "again",
    });

    await runToolLoop(params);
    expect(calls).toBe(4);
  });

  test("the injected nudge is a real user message the next request will carry", async () => {
    // It is not a marker the loop strips later — a host persisting
    // `state.messages` persists it, and a compactor sees it. Worth pinning
    // because a host that filters it on persist and not on compaction gets two
    // divergent transcripts.
    const seenByCompactor: number[] = [];
    const { params } = loopHarness(
      [{ message: assistant("one") }, { message: assistant("two", [{ id: "a", name: "w" }]) }, { message: assistant("three") }],
      {
        onTurnWouldEnd: () => (seenByCompactor.length === 0 ? "continue please" : null),
        runToolCall: async (tc) => ({ ...toolOutcome(tc.id), requestCompaction: true }),
        applyCompaction: async (_reason, messages) => {
          seenByCompactor.push(messages.length);
          expect(
            messages.some((m) => m.role === "user" && m.content === "continue please"),
          ).toBe(true);
          return {
            messages: [...messages],
            inputTokens: 1,
            outputTokens: 1,
            costCents: 0,
            persist: async () => {},
          };
        },
      },
    );

    await runToolLoop(params);
    expect(seenByCompactor).toHaveLength(1);
  });
});
