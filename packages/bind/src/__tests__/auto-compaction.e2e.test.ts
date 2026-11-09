/**
 * Auto-compaction: the arm driven by the provider's token count rather than by
 * a tool asking for it.
 *
 * The two triggers look interchangeable and are not. A manual compaction runs
 * at the batch boundary, before interrupts are drained, and is skipped outright
 * when a suspend is pending. An auto compaction runs at the *end* of the
 * iteration, after interrupts, on a count the loop maintains itself — and that
 * count is the whole mechanism: it is reset to zero by every compaction and
 * re-established by the next model turn, so the guard against re-triggering on
 * a stale number is `state.lastPromptTokens > 0` and nothing else.
 *
 * That makes auto-compaction a token-accounting problem wearing a transcript
 * problem's clothes, which is why it needs its own suite: the interesting
 * failures are all arithmetic (compacting every iteration forever, never
 * compacting again after the first, double-counting a compaction's own usage)
 * and none of them are visible from either module alone.
 */
import { describe, expect, test } from "vitest";
import type OpenAI from "openai";
import { runToolLoop, type CompactionApplied } from "../loop/tool-loop";
import { validateAndHealMessages } from "../transcript/validate";
import { assistant, loopHarness, toolOutcome } from "../testing";

interface CompactionCall {
  trigger: "manual" | "auto";
  messageCount: number;
  toolCallIds: string[];
}

/**
 * A compactor that records every invocation and, by default, returns the
 * transcript unchanged. Its own usage is deliberately non-zero so the
 * accounting is observable.
 */
function recordingCompactor(
  rewrite: (
    messages: OpenAI.ChatCompletionMessageParam[],
  ) => OpenAI.ChatCompletionMessageParam[] = (m) => [...m],
) {
  const calls: CompactionCall[] = [];
  const persists: number[] = [];
  const apply = async (
    trigger: "manual" | "auto",
    messages: OpenAI.ChatCompletionMessageParam[],
  ): Promise<CompactionApplied> => {
    calls.push({
      trigger,
      messageCount: messages.length,
      toolCallIds: messages.flatMap((m) =>
        m.role === "assistant" && m.tool_calls ? m.tool_calls.map((tc) => tc.id) : [],
      ),
    });
    return {
      messages: rewrite(messages),
      inputTokens: 20,
      outputTokens: 10,
      costCents: 3,
      persist: async () => {
        persists.push(calls.length);
      },
    };
  };
  return { calls, persists, apply };
}

describe("the token threshold that fires it", () => {
  test("fires once the provider's real count crosses the line", async () => {
    const compactor = recordingCompactor();
    const observed: number[] = [];
    const { params } = loopHarness(
      [
        // (prompt 100 + output 10) = 110, under the line.
        { message: assistant("one", [{ id: "a", name: "w" }]), inputTokens: 100, outputTokens: 10 },
        // (900 + 50) = 950, over it.
        { message: assistant("two", [{ id: "b", name: "w" }]), inputTokens: 900, outputTokens: 50 },
        { message: assistant("done"), inputTokens: 10, outputTokens: 1 },
      ],
      {
        needsCompaction: (tokens) => {
          observed.push(tokens);
          return tokens > 500;
        },
        applyCompaction: compactor.apply,
      },
    );

    await runToolLoop(params);

    expect(observed).toEqual([110, 950]);
    expect(compactor.calls.map((c) => c.trigger)).toEqual(["auto"]);
  });

  test("the count is the LIVE one, not the run's cumulative total", async () => {
    // `lastPromptTokens + lastOutputTokens`, replaced each turn — not
    // `state.inputTokens + state.outputTokens`, which only grows. Summing the
    // cumulative would make every sufficiently long run compact on every
    // iteration regardless of how small its context actually is.
    const compactor = recordingCompactor();
    const observed: number[] = [];
    const { params, state } = loopHarness(
      [
        { message: assistant("1", [{ id: "a", name: "w" }]), inputTokens: 100, outputTokens: 100 },
        { message: assistant("2", [{ id: "b", name: "w" }]), inputTokens: 100, outputTokens: 100 },
        { message: assistant("3", [{ id: "c", name: "w" }]), inputTokens: 100, outputTokens: 100 },
        { message: assistant("done"), inputTokens: 100, outputTokens: 100 },
      ],
      {
        needsCompaction: (tokens) => {
          observed.push(tokens);
          return false;
        },
        applyCompaction: compactor.apply,
      },
    );

    await runToolLoop(params);

    // Flat at 200 every turn, while the cumulative climbed past 700.
    expect(observed).toEqual([200, 200, 200]);
    expect(state.inputTokens + state.outputTokens).toBe(800);
  });

  test("it does not fire before any model turn has produced a real count", async () => {
    // `lastPromptTokens > 0` is the guard. A predicate that would say yes to
    // zero must not compact an empty transcript on iteration one.
    // The turn must REQUEST A TOOL, or the loop breaks out before the check and
    // the test passes for the wrong reason — which it did, making it a duplicate
    // of the tool-less-final-turn test below rather than a guard test.
    const compactor = recordingCompactor();
    const { params } = loopHarness(
      [
        { message: assistant("1", [{ id: "a", name: "w" }]), inputTokens: 0, outputTokens: 0 },
        { message: assistant("done"), inputTokens: 0, outputTokens: 0 },
      ],
      { needsCompaction: () => true, applyCompaction: compactor.apply },
    );

    await runToolLoop(params);
    expect(compactor.calls).toEqual([]);
  });

  test("it does not re-fire on the stale count a compaction just zeroed", async () => {
    // A bound on total compactions. Note the guard is NOT what bounds this one —
    // each iteration re-establishes a fresh count, so the `> 0` check has nothing
    // to decline. Its observable protection is the same-iteration
    // de-duplication after a manual pass, isolated by its own test below.
    const compactor = recordingCompactor();
    const { params } = loopHarness(
      [
        { message: assistant("1", [{ id: "a", name: "w" }]), inputTokens: 900, outputTokens: 90 },
        { message: assistant("2", [{ id: "b", name: "w" }]), inputTokens: 900, outputTokens: 90 },
        { message: assistant("done"), inputTokens: 900, outputTokens: 90 },
      ],
      {
        needsCompaction: () => true, // pathological on purpose
        applyCompaction: compactor.apply,
      },
    );

    await runToolLoop(params);

    // Two, not an unbounded run — and notably not three either: the final turn
    // requested no tools, so the loop broke out before reaching the check. **A
    // run's last transcript is never auto-compacted**, which is easy to miss and
    // matters to a host that persists what the loop leaves behind expecting it
    // to be under the threshold.
    expect(compactor.calls).toHaveLength(2);
    expect(compactor.calls.every((c) => c.trigger === "auto")).toBe(true);
  });

  test("the tool-less final turn is never auto-compacted, however far over it is", async () => {
    // Isolating the above. The only model turn is enormous and the predicate
    // always says yes; the loop still breaks before the check.
    const compactor = recordingCompactor();
    const { params } = loopHarness(
      [{ message: assistant("done"), inputTokens: 100_000, outputTokens: 9_000 }],
      { needsCompaction: () => true, applyCompaction: compactor.apply },
    );
    await runToolLoop(params);
    expect(compactor.calls).toEqual([]);
  });

  test("no compactor means the predicate is never consulted", async () => {
    // Both ports must be wired; a host with a threshold and no compactor should
    // not pay for the check, and must certainly not throw.
    let asked = 0;
    const { params } = loopHarness(
      [{ message: assistant("done"), inputTokens: 900, outputTokens: 90 }],
      {
        needsCompaction: () => {
          asked += 1;
          return true;
        },
      },
    );
    await runToolLoop(params);
    expect(asked).toBe(0);
  });
});

describe("accounting across the swap", () => {
  test("the compaction's own usage lands in the run totals", async () => {
    const compactor = recordingCompactor();
    const { params, state } = loopHarness(
      [
        { message: assistant("1", [{ id: "a", name: "w" }]), inputTokens: 900, outputTokens: 90, costCents: 5 },
        { message: assistant("done"), inputTokens: 10, outputTokens: 5, costCents: 1 },
      ],
      {
        needsCompaction: (tokens) => tokens > 500,
        applyCompaction: compactor.apply,
      },
    );

    await runToolLoop(params);

    // turn 1 (900/90/5) + compaction (20/10/3) + turn 2 (10/5/1).
    expect(state.inputTokens).toBe(930);
    expect(state.outputTokens).toBe(105);
    expect(state.costCents).toBe(9);
  });

  test("usage is accounted BEFORE persist, so a failing persist cannot drop it", async () => {
    // The ordering the loop's own comment claims. A compaction that ran and then
    // failed to save still consumed tokens someone paid for, and losing them
    // makes a run's cost silently understate what it spent.
    let accountedAtPersist = 0;
    const { params, state } = loopHarness(
      [
        { message: assistant("1", [{ id: "a", name: "w" }]), inputTokens: 900, outputTokens: 90 },
        { message: assistant("done"), inputTokens: 10, outputTokens: 5 },
      ],
      {
        needsCompaction: (tokens) => tokens > 500,
        applyCompaction: async (_trigger, messages) => ({
          messages: [...messages],
          inputTokens: 20,
          outputTokens: 10,
          costCents: 3,
          persist: async () => {
            accountedAtPersist = state.outputTokens;
            throw new Error("session write failed");
          },
        }),
      },
    );

    await expect(runToolLoop(params)).rejects.toThrow("session write failed");
    // The compaction's 10 output tokens were already folded in when persist ran.
    expect(accountedAtPersist).toBe(100);
  });

  test("the live count is zeroed by the swap and re-established by the next turn", async () => {
    const seen: Array<[number, number]> = [];
    const { params, state } = loopHarness(
      [
        { message: assistant("1", [{ id: "a", name: "w" }]), inputTokens: 900, outputTokens: 90 },
        { message: assistant("2", [{ id: "b", name: "w" }]), inputTokens: 40, outputTokens: 4 },
        { message: assistant("done"), inputTokens: 7, outputTokens: 1 },
      ],
      {
        needsCompaction: (tokens) => {
          seen.push([state.lastPromptTokens, state.lastOutputTokens]);
          return tokens > 500;
        },
        applyCompaction: async (_t, messages) => ({
          messages: [...messages],
          inputTokens: 1,
          outputTokens: 1,
          costCents: 0,
          persist: async () => {},
        }),
      },
    );

    await runToolLoop(params);
    // Turn 2's numbers are the provider's fresh ones, not a carry-over of 900/90.
    expect(seen).toEqual([
      [900, 90],
      [40, 4],
    ]);
    expect(state.hasFreshTokenCount).toBe(true);
  });
});

describe("what the compactor is handed, and what the loop does with the answer", () => {
  test("it sees the full batch of tool responses, not a mid-batch transcript", async () => {
    // Auto-compaction runs at the end of the iteration, so every call in the
    // batch has been answered by the time the summarizer looks. A compactor that
    // saw a half-answered batch would summarize a transcript no provider would
    // have accepted.
    const compactor = recordingCompactor();
    const { params } = loopHarness(
      [
        {
          message: assistant("batch", [
            { id: "a", name: "w" },
            { id: "b", name: "w" },
            { id: "c", name: "w" },
          ]),
          inputTokens: 900,
          outputTokens: 90,
        },
        { message: assistant("done"), inputTokens: 5, outputTokens: 1 },
      ],
      {
        needsCompaction: (tokens) => tokens > 500,
        applyCompaction: compactor.apply,
      },
    );

    await runToolLoop(params);
    expect(compactor.calls[0]?.toolCallIds).toEqual(["a", "b", "c"]);
    // system + user + assistant + three tool results.
    expect(compactor.calls[0]?.messageCount).toBe(6);
  });

  test("it sees drained interrupts, because they land first", async () => {
    // Ordering that matters: an interrupt queued while the agent worked is part
    // of the context being summarized. A compactor running before the drain
    // would summarize away the turn the user is about to be answered on.
    const compactor = recordingCompactor();
    let drained = false;
    const { params } = loopHarness(
      [
        { message: assistant("1", [{ id: "a", name: "w" }]), inputTokens: 900, outputTokens: 90 },
        { message: assistant("done"), inputTokens: 5, outputTokens: 1 },
      ],
      {
        drainInterrupts: () => {
          if (drained) return [];
          drained = true;
          return [{ userId: "u1", content: "actually, do the other thing" }];
        },
        needsCompaction: (tokens) => tokens > 500,
        applyCompaction: async (trigger, messages) => {
          expect(
            messages.some(
              (m) => m.role === "user" && String(m.content).includes("do the other thing"),
            ),
          ).toBe(true);
          return compactor.apply(trigger, messages);
        },
      },
    );

    await runToolLoop(params);
    expect(compactor.calls).toHaveLength(1);
  });

  test("the swapped transcript is what the NEXT turn is built from", async () => {
    // The loop replaces `state.messages` in place, so a compactor's output is
    // not advisory — it is the conversation from that point on.
    const seenByModel: number[] = [];
    const { params, state } = loopHarness([], {
      callModel: async (messages) => {
        seenByModel.push(messages.length);
        return seenByModel.length === 1
          ? {
              message: assistant("1", [{ id: "a", name: "w" }]),
              inputTokens: 900,
              outputTokens: 90,
              costCents: 0,
            }
          : { message: assistant("done"), inputTokens: 5, outputTokens: 1, costCents: 0 };
      },
      needsCompaction: (tokens) => tokens > 500,
      applyCompaction: async () => ({
        messages: [{ role: "user", content: "[summary of everything so far]" }],
        inputTokens: 1,
        outputTokens: 1,
        costCents: 0,
        persist: async () => {},
      }),
    });

    await runToolLoop(params);
    // Turn 1 saw system + user; turn 2 saw only the summary.
    expect(seenByModel).toEqual([2, 1]);
    expect(state.messages[0]).toEqual({
      role: "user",
      content: "[summary of everything so far]",
    });
  });

  test("a summarizer that drops a tool result leaves the next turn un-sendable", async () => {
    // The same lossy shape the manual arm can produce, reached through the auto
    // trigger — and worse here, because nothing asked for it: the run compacted
    // on a token threshold and the damage lands in the transcript the very next
    // request is built from. The loop does not re-validate the swap.
    const { params, state } = loopHarness(
      [
        { message: assistant("1", [{ id: "a", name: "w" }]), inputTokens: 900, outputTokens: 90 },
        { message: assistant("done"), inputTokens: 5, outputTokens: 1 },
      ],
      {
        needsCompaction: (tokens) => tokens > 500,
        applyCompaction: async (_t, messages) => ({
          messages: messages.filter((m) => m.role !== "tool"),
          inputTokens: 1,
          outputTokens: 1,
          costCents: 0,
          persist: async () => {},
        }),
      },
    );

    await runToolLoop(params);

    const healed = validateAndHealMessages(state.messages);
    expect(healed.issues.some((i) => i.kind === "dangling_tool_calls_unanswered")).toBe(
      true,
    );
  });
});

describe("auto vs manual, where the two arms differ", () => {
  test("a pending suspend blocks the manual arm — and the auto arm never runs", async () => {
    // The manual arm is skipped when a suspend is pending, because compacting
    // would rewrite the open call that must survive verbatim to be resumable.
    // The auto arm needs no such guard only because the suspend `break` happens
    // first; asserted here so a future reordering cannot quietly remove the
    // protection by moving the auto check above the break.
    const compactor = recordingCompactor();
    const { params, state } = loopHarness(
      [
        {
          message: assistant("asking", [{ id: "q", name: "ask" }]),
          inputTokens: 5_000,
          outputTokens: 900,
        },
      ],
      {
        runToolCall: async (tc) => ({
          toolMessage: { role: "tool", tool_call_id: tc.id, content: "{}" },
          requestCompaction: true,
          suspend: { toolCallId: tc.id, reason: "waiting", resumeKind: "answer" },
        }),
        needsCompaction: () => true,
        applyCompaction: compactor.apply,
      },
    );

    await runToolLoop(params);

    expect(state.suspended?.toolCallId).toBe("q");
    expect(compactor.calls).toEqual([]);
    // The open call survived verbatim, which is the whole point.
    expect(
      state.messages.some(
        (m) => m.role === "assistant" && m.tool_calls?.some((tc) => tc.id === "q"),
      ),
    ).toBe(true);
  });

  test("a wake-suspend also leaves the transcript uncompacted", async () => {
    // `wake` sets no `state.suspended`, so the manual arm's guard
    // (`!state.suspended`) does NOT block it — the compaction runs, and only
    // then does the run end. Pinned because the two suspend kinds diverge here
    // and the difference is one `&&` clause deep.
    const compactor = recordingCompactor();
    const { params, state } = loopHarness(
      [
        {
          message: assistant("sleeping", [{ id: "s", name: "sleep_until" }]),
          inputTokens: 5_000,
          outputTokens: 900,
        },
      ],
      {
        runToolCall: async (tc) => ({
          toolMessage: { role: "tool", tool_call_id: tc.id, content: "{}" },
          requestCompaction: true,
          suspend: { toolCallId: tc.id, reason: "later", resumeKind: "wake" },
        }),
        needsCompaction: () => true,
        applyCompaction: compactor.apply,
      },
    );

    await runToolLoop(params);

    expect(state.suspended).toBeUndefined();
    expect(state.endedTurnViaTool).toBe(true);
    // Manual ran (no `state.suspended` to block it); auto never did, because the
    // suspend `break` comes first.
    expect(compactor.calls.map((c) => c.trigger)).toEqual(["manual"]);
  });

  test("the stale-count guard is what suppresses it, and only it", async () => {
    // Isolating the mechanism. With an always-true predicate, a manual
    // compaction in the same iteration must still leave the auto arm silent —
    // and the ONLY thing standing in its way is `lastPromptTokens > 0`, which
    // the manual pass just zeroed. Delete that clause and this run compacts
    // twice in one iteration, the second pass summarizing what the first wrote.
    const compactor = recordingCompactor();
    const { params } = loopHarness(
      [
        { message: assistant("1", [{ id: "a", name: "w" }]), inputTokens: 900, outputTokens: 90 },
        { message: assistant("done"), inputTokens: 5, outputTokens: 1 },
      ],
      {
        runToolCall: async (tc) => ({ ...toolOutcome(tc.id), requestCompaction: true }),
        needsCompaction: () => true,
        applyCompaction: compactor.apply,
      },
    );

    await runToolLoop(params);
    expect(compactor.calls.map((c) => c.trigger)).toEqual(["manual"]);
  });

  test("a SIBLING's compaction request is recorded, and the suspend guard blocks it", async () => {
    // The path that actually reaches the `!state.suspended` guard: a second call
    // in the batch asks to compact, so `compactionRequested` is set, and the
    // guard is the only thing keeping the summarizer away from an open call that
    // has to survive verbatim to be resumable.
    const compactor = recordingCompactor();
    const { params, state } = loopHarness(
      [
        {
          message: assistant("asking and working", [
            { id: "q", name: "ask" },
            { id: "w", name: "work" },
          ]),
          inputTokens: 5_000,
          outputTokens: 900,
        },
      ],
      {
        runToolCall: async (tc) =>
          tc.id === "q"
            ? {
                toolMessage: { role: "tool", tool_call_id: tc.id, content: "{}" },
                suspend: { toolCallId: tc.id, reason: "waiting", resumeKind: "answer" },
              }
            : { ...toolOutcome(tc.id), requestCompaction: true },
        needsCompaction: () => true,
        applyCompaction: compactor.apply,
      },
    );

    await runToolLoop(params);
    expect(state.suspended?.toolCallId).toBe("q");
    expect(compactor.calls).toEqual([]);
    // The open call is intact, unsummarized.
    expect(
      state.messages.some(
        (m) => m.role === "assistant" && m.tool_calls?.some((tc) => tc.id === "q"),
      ),
    ).toBe(true);
  });

  test("compaction persists exactly once per pass", async () => {
    const compactor = recordingCompactor();
    const { params } = loopHarness(
      [
        { message: assistant("1", [{ id: "a", name: "w" }]), inputTokens: 900, outputTokens: 90 },
        { message: assistant("2", [{ id: "b", name: "w" }]), inputTokens: 900, outputTokens: 90 },
        { message: assistant("done"), inputTokens: 5, outputTokens: 1 },
      ],
      {
        needsCompaction: (tokens) => tokens > 500,
        applyCompaction: compactor.apply,
      },
    );

    await runToolLoop(params);
    expect(compactor.calls).toHaveLength(2);
    expect(compactor.persists).toEqual([1, 2]);
  });
});
