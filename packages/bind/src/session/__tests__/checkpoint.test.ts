import { describe, expect, test } from "vitest";
import { runToolLoop, UnsettledLoopBoundaryError } from "../../loop/index";
import {
  applyCheckpointInput, createLoopCheckpoint, forkLoopCheckpoint,
  parseLoopCheckpoint, runFromCheckpoint, serializeLoopCheckpoint,
  type CheckpointBindings, type CheckpointRuntime, type LoopCheckpoint,
} from "../index";
import {
  assistant, finalAnswer, loopHarness, steppingClock, toolCall, toolCallTurn, toolOutcome,
  type ModelResponse,
} from "../../testing/index";

const bindings: CheckpointBindings = { configuration: { model: "fixture-v1", tools: "v1" }, environment: { files: {} } };
function initial(maxIterations = 4) {
  return createLoopCheckpoint({ executionId: "original", maxIterations, bindings,
    messages: [{ role: "user", content: "Solve the scenario" }] });
}
function runtime(responses: ModelResponse[], overrides: Partial<CheckpointRuntime["params"]> = {}) {
  const harness = loopHarness(responses, { now: steppingClock(), ...overrides });
  return { harness, value: { params: harness.params, captureBindings: async () => bindings } };
}
const keepGoing = async () => "continue" as const;

describe("checkpointed Bind execution", () => {
  test("rejects contradictory stored spend while fractional resume stays coherent", async () => {
    for (const field of ["inputTokens", "outputTokens", "costCents"] as const) {
      const corrupted = initial();
      corrupted.state[field] = 1;
      expect(() => parseLoopCheckpoint(corrupted)).toThrow("checkpoint_accounting_mismatch");
    }
    const first = runtime([toolCallTurn([toolCall("first")], { costCents: 0.1 })]);
    const paused = await runFromCheckpoint({ checkpoint: initial(), restore: async () => first.value,
      commit: async c => c.iterationsUsed === 1 ? "checkpoint" : "continue" });
    const next = runtime([toolCallTurn([toolCall("second")], { costCents: 0.2 }), finalAnswer("done", { costCents: 0.3 })], {
      runToolCall: async call => ({ ...toolOutcome(call.id), requestCompaction: true }),
      applyCompaction: async () => ({ messages: [{ role: "user", content: "summary" }],
        inputTokens: 1, outputTokens: 1, costCents: 0.05, persist: async () => {} }),
    });
    const done = await runFromCheckpoint({ checkpoint: paused.checkpoint, restore: async () => next.value, commit: keepGoing });
    expect(done.checkpoint.state.costCents).toBe(done.checkpoint.stats.costCents);
    expect(done.checkpoint.stats.costCents).toBeCloseTo(0.65);
    expect(parseLoopCheckpoint(JSON.parse(serializeLoopCheckpoint(done.checkpoint)))).toEqual(done.checkpoint);
  });

  test("saving a terminal boundary preserves its natural stop reason", async () => {
    const r = runtime([finalAnswer("done")]);
    const done = await runFromCheckpoint({ checkpoint: initial(), restore: async () => r.value,
      commit: async c => c.position.kind === "ready" ? "continue" : "checkpoint" });
    expect(done.stopReason).toBe("done");
    expect(done.checkpoint.position).toEqual({ kind: "finished", reason: "done" });
    const waiting = runtime([toolCallTurn([toolCall("ask")])], {
      runToolCall: async () => ({ ...toolOutcome("ask"),
        suspend: { toolCallId: "ask", reason: "question", resumeKind: "answer" } }),
    });
    const saved = await runFromCheckpoint({ checkpoint: initial(), restore: async () => waiting.value,
      commit: async c => c.position.kind === "ready" ? "continue" : "checkpoint" });
    expect(saved.stopReason).toBe("waiting_for_reply");
  });

  test("raw controls reject unpaired initial history before publishing ready", async () => {
    const raw = runtime([]);
    raw.harness.state.messages.push(assistant(null, [{ id: "open", name: "write" }]));
    let boundaries = 0;
    await expect(runToolLoop(raw.harness.params, { iterationsUsed: 0,
      onBoundary: async () => { boundaries++; return "checkpoint"; },
    })).rejects.toThrow("checkpoint_unsettled_tool_batch");
    expect(boundaries).toBe(0);
  });

  test("raw controls reject malformed compaction before the next ready boundary", async () => {
    const raw = runtime([toolCallTurn([toolCall("compress")])], {
      runToolCall: async call => ({ ...toolOutcome(call.id), requestCompaction: true }),
      applyCompaction: async () => ({ messages: [assistant(null, [{ id: "open", name: "write" }])],
        inputTokens: 1, outputTokens: 1, costCents: 1, persist: async () => {} }),
    });
    let boundaries = 0;
    await expect(runToolLoop(raw.harness.params, { iterationsUsed: 0,
      onBoundary: async () => { boundaries++; return "continue"; },
    })).rejects.toThrow("checkpoint_unsettled_tool_batch");
    expect(boundaries).toBe(1);
  });

  test("an aborted unexecuted batch never emits a settled final boundary", async () => {
    const script = [toolCallTurn([toolCall("write")])];
    const raw = runtime(script, { shouldStop: async () => true });
    let boundaries = 0;
    await expect(runToolLoop(raw.harness.params, { iterationsUsed: 0,
      onBoundary: async () => { boundaries++; return "continue"; },
    })).rejects.toBeInstanceOf(UnsettledLoopBoundaryError);
    expect(boundaries).toBe(1);
    expect(raw.harness.ran).toEqual([]);
    const session = runtime(script, { shouldStop: async () => true });
    let commits = 0;
    await expect(runFromCheckpoint({ checkpoint: initial(), restore: async () => session.value,
      commit: async () => { commits++; return "continue"; },
    })).rejects.toBeInstanceOf(UnsettledLoopBoundaryError);
    expect(commits).toBe(1);
    const legacy = runtime(script, { shouldStop: async () => true });
    expect((await runToolLoop(legacy.harness.params)).stopReason).toBe("aborted");
  });

  test("signal-aborted batches and stopped suspensions cannot be checkpointed", async () => {
    const controller = new AbortController();
    controller.abort();
    for (const overrides of [
      { signal: controller.signal },
      { runToolCall: async () => ({ ...toolOutcome("ask"),
        suspend: { toolCallId: "ask", reason: "question", resumeKind: "answer" as const } }),
        onStepSettled: async () => ({ messages: [], stop: true }) },
    ]) {
      const r = runtime([toolCallTurn([toolCall("ask")])], overrides);
      let commits = 0;
      await expect(runFromCheckpoint({ checkpoint: initial(), restore: async () => r.value,
        commit: async () => { commits++; return "continue"; },
      })).rejects.toBeInstanceOf(UnsettledLoopBoundaryError);
      expect(commits).toBe(1);
    }
  });

  test("captures SDK messages with explicitly undefined optional fields", async () => {
    const response = finalAnswer("answer");
    Object.defineProperty(response.message, "tool_calls", { value: undefined, enumerable: true });
    const r = runtime([response]);
    const result = await runFromCheckpoint({ checkpoint: initial(), restore: async () => r.value, commit: keepGoing });
    expect(result.stopReason).toBe("done");
    expect(result.checkpoint.state.messages.at(-1)).toEqual({ role: "assistant", content: "answer", refusal: null });
    expect(parseLoopCheckpoint(JSON.parse(serializeLoopCheckpoint(result.checkpoint)))).toEqual(result.checkpoint);
    const corrupted = structuredClone(result.checkpoint);
    Object.assign(corrupted.state.messages[0]!, { metadata: undefined });
    expect(() => parseLoopCheckpoint(corrupted)).toThrow();
  });

  test("prepared history preserves both roles and performs no work until run", async () => {
    const checkpoint = createLoopCheckpoint({ executionId: "history", maxIterations: 2, bindings,
      messages: [{ role: "user", content: "old" }, assistant("old answer"), { role: "user", content: "new" }] });
    const r = runtime([finalAnswer("new answer")], {
      callModel: async (messages) => {
        expect(messages.map((m) => m.content)).toEqual(["old", "old answer", "new"]);
        return { message: assistant("new answer"), inputTokens: 4, outputTokens: 2, costCents: 1 };
      },
    });
    const result = await runFromCheckpoint({ checkpoint, restore: async () => r.value, commit: keepGoing });
    expect(result.stopReason).toBe("done");
    expect(result.checkpoint.stats.turns).toBe(1);
    expect(checkpoint.state.messages).toHaveLength(3);
  });

  test("JSON restore after a tool batch matches uninterrupted execution without replaying tools", async () => {
    const responses = [toolCallTurn([toolCall("lookup", { q: "x" })]), finalAnswer("answer")];
    const whole = runtime(responses);
    const expected = await runFromCheckpoint({ checkpoint: initial(), restore: async () => whole.value, commit: keepGoing });
    const first = runtime(responses);
    const paused = await runFromCheckpoint({ checkpoint: initial(), restore: async () => first.value,
      commit: async (c) => c.iterationsUsed === 1 ? "checkpoint" : "continue" });
    expect(paused.stopReason).toBe("checkpointed");
    expect(paused.checkpoint.position.kind).toBe("ready");
    const saved = parseLoopCheckpoint(JSON.parse(serializeLoopCheckpoint(paused.checkpoint)));
    const second = runtime([finalAnswer("answer")]);
    const actual = await runFromCheckpoint({ checkpoint: saved, restore: async () => second.value, commit: keepGoing });
    expect(actual.checkpoint.state).toEqual(expected.checkpoint.state);
    expect(actual.checkpoint.stats).toEqual(expected.checkpoint.stats);
    expect([...first.harness.ran, ...second.harness.ran]).toEqual(whole.harness.ran);
    expect(second.harness.ran).toEqual([]);
    expect(actual.stats.turns).toBe(1);
  });

  test("checkpoint runs after requested compaction and interrupt delivery", async () => {
    let compactions = 0;
    let compactPersisted = false;
    const r = runtime([toolCallTurn([toolCall("compress")])], {
      runToolCall: async (call) => ({ ...toolOutcome(call.id), requestCompaction: true }),
      applyCompaction: async () => {
        compactions++;
        return { messages: [{ role: "user", content: "summary" }], inputTokens: 3, outputTokens: 2,
          costCents: 1, persist: async () => { compactPersisted = true; } };
      },
      drainInterrupts: () => [{ userId: "person", content: "new constraint" }],
    });
    const paused = await runFromCheckpoint({ checkpoint: initial(), restore: async () => r.value,
      commit: async (c) => {
        if (c.iterationsUsed === 0) return "continue";
        expect(compactPersisted).toBe(true);
        expect(c.state.messages.map((m) => m.content)).toEqual(["summary", "[Interrupt from user person]\nnew constraint"]);
        return "checkpoint";
      } });
    const second = runtime([finalAnswer("done")], { applyCompaction: async () => { throw new Error("must not repeat compaction"); } });
    const resumed = await runFromCheckpoint({ checkpoint: paused.checkpoint, restore: async () => second.value, commit: keepGoing });
    expect(resumed.stopReason).toBe("done");
    expect(compactions).toBe(1);
    expect(resumed.checkpoint.stats.costCents).toBeGreaterThan(paused.stats.costCents);
  });

  test("a final-response nudge is captured once, before the next model call", async () => {
    let nudges = 0;
    const r = runtime([finalAnswer("not finished")], { onTurnWouldEnd: () => { nudges++; return "Keep going"; } });
    const paused = await runFromCheckpoint({ checkpoint: initial(), restore: async () => r.value,
      commit: async (c) => c.iterationsUsed > 0 ? "checkpoint" : "continue" });
    expect(paused.checkpoint.state.messages.at(-1)?.content).toBe("Keep going");
    expect(nudges).toBe(1);
    const second = runtime([finalAnswer("finished")]);
    await runFromCheckpoint({ checkpoint: paused.checkpoint, restore: async () => second.value, commit: keepGoing });
    expect(nudges).toBe(1);
  });

  test("waiting and finished checkpoints never restore capabilities or call the model", async () => {
    const r = runtime([toolCallTurn([toolCall("ask", {}, "question")])], {
      runToolCall: async (call) => ({ ...toolOutcome(call.id),
        suspend: { toolCallId: call.id, resumeKind: "answer", reason: "Which one?", request: { choices: ["A", "B"] } } }),
    });
    const waiting = await runFromCheckpoint({ checkpoint: initial(), restore: async () => r.value, commit: keepGoing });
    expect(waiting.stopReason).toBe("waiting_for_reply");
    const blocked = await runFromCheckpoint({ checkpoint: waiting.checkpoint,
      restore: async () => { throw new Error("must not restore"); }, commit: keepGoing });
    expect(blocked.stopReason).toBe("waiting_for_reply");
    expect(() => applyCheckpointInput(waiting.checkpoint, { kind: "message", message: { role: "user", content: "wrong" } })).toThrow("checkpoint_input_blocked");
    expect(() => applyCheckpointInput(waiting.checkpoint, { kind: "reply", message: { role: "tool", tool_call_id: "wrong", content: "A" } })).toThrow("checkpoint_reply_mismatch");
    const ready = applyCheckpointInput(waiting.checkpoint, { kind: "reply", message: { role: "tool", tool_call_id: "question", content: "A" } });
    const second = runtime([finalAnswer("A selected")]);
    const done = await runFromCheckpoint({ checkpoint: ready, restore: async () => second.value, commit: keepGoing });
    expect(done.checkpoint.state.suspended).toBeUndefined();
    expect(done.stopReason).toBe("done");
    expect((await runFromCheckpoint({ checkpoint: done.checkpoint,
      restore: async () => { throw new Error("must not restore"); }, commit: keepGoing })).stopReason).toBe("done");
    expect(waiting.checkpoint.state.suspended?.toolCallId).toBe("question");
  });

  test("wake suspension requires an explicit wake before continuing", async () => {
    const r = runtime([toolCallTurn([toolCall("sleep")])], {
      runToolCall: async (call) => ({ ...toolOutcome(call.id), suspend: { toolCallId: call.id, reason: "later", resumeKind: "wake" } }),
    });
    const waiting = await runFromCheckpoint({ checkpoint: initial(), restore: async () => r.value, commit: keepGoing });
    expect(waiting.stopReason).toBe("resuming_later");
    const ready = applyCheckpointInput(waiting.checkpoint, { kind: "wake", messages: [{ role: "user", content: "timer fired" }] });
    expect(ready.position.kind).toBe("ready");
    expect(ready.state.endedTurnViaTool).toBeUndefined();
  });

  test("resume keeps the iteration budget; fork resets spend and isolates future state", async () => {
    const r = runtime([toolCallTurn([toolCall("lookup")])]);
    const paused = await runFromCheckpoint({ checkpoint: initial(2), restore: async () => r.value,
      commit: async (c) => c.iterationsUsed === 1 ? "checkpoint" : "continue" });
    const sourceBytes = serializeLoopCheckpoint(paused.checkpoint);
    const branch = forkLoopCheckpoint(paused.checkpoint, { executionId: "candidate-B", maxIterations: 3,
      bindings: { ...bindings, configuration: { model: "fixture-B" } } });
    expect(branch.parent).toEqual({ executionId: "original", revision: paused.checkpoint.revision });
    expect(branch.stats.turns).toBe(0);
    expect(branch.state.costCents).toBe(0);
    const second = runtime([toolCallTurn([toolCall("second")])]);
    const exhausted = await runFromCheckpoint({ checkpoint: paused.checkpoint, restore: async () => second.value, commit: keepGoing });
    expect(exhausted.stopReason).toBe("iteration_limit");
    expect(exhausted.checkpoint.iterationsUsed).toBe(2);
    const candidate = runtime([finalAnswer("different")]);
    const result = await runFromCheckpoint({ checkpoint: branch, restore: async (pins, id) => {
      expect(id).toBe("candidate-B"); expect(pins.configuration.model).toBe("fixture-B"); return candidate.value;
    }, commit: keepGoing });
    expect(result.stopReason).toBe("done");
    expect(serializeLoopCheckpoint(paused.checkpoint)).toBe(sourceBytes);
    expect(() => forkLoopCheckpoint(branch, { executionId: branch.executionId, maxIterations: 2, bindings })).toThrow("checkpoint_fork_identity_reused");
  });

  test("checkpoint persistence and restore rejection stop further I/O", async () => {
    const r = runtime([toolCallTurn([toolCall("lookup")]), finalAnswer("must not run")]);
    await expect(runFromCheckpoint({ checkpoint: initial(), restore: async () => r.value,
      commit: async (c) => { if (c.iterationsUsed > 0) throw new Error("store unavailable"); return "continue"; } })).rejects.toThrow("store unavailable");
    expect(r.harness.ran).toEqual(["lookup"]);
    await expect(runFromCheckpoint({ checkpoint: initial(), restore: async () => { throw new Error("tool version unavailable"); }, commit: keepGoing })).rejects.toThrow("tool version unavailable");
  });

  test("captures active host state and restores it before the next tool surface is built", async () => {
    let active: string[] = [];
    const r = runtime([toolCallTurn([toolCall("load")])], {
      runsSerially: () => true,
      runToolCall: async (call) => ({ ...toolOutcome(call.id), loadedPluginName: "search" }),
      activatePlugins: (ids) => { active.push(...ids); },
    });
    const paused = await runFromCheckpoint({ checkpoint: initial(), restore: async () => ({
      ...r.value, captureBindings: async () => ({ ...bindings, environment: { active } }),
    }), commit: async (c) => c.iterationsUsed > 0 ? "checkpoint" : "continue" });
    active = [];
    const second = runtime([finalAnswer("ready")], { buildTools: () => { expect(active).toEqual(["search"]); return []; } });
    await runFromCheckpoint({ checkpoint: paused.checkpoint, restore: async (saved) => {
      const environment = saved.environment;
      if (environment === null || Array.isArray(environment) || typeof environment !== "object"
        || !Array.isArray(environment.active)) throw new Error("invalid fixture environment");
      active = environment.active.map(String); return second.value;
    }, commit: keepGoing });
  });

  test("rejects corrupt versions, budgets, protocol state and non-JSON metadata", () => {
    expect(() => parseLoopCheckpoint({ ...initial(), version: 2 })).toThrow();
    expect(() => parseLoopCheckpoint({ ...initial(), maxIterations: -1 })).toThrow();
    expect(() => parseLoopCheckpoint({ ...initial(), iterationsUsed: 1 })).toThrow("checkpoint_iteration_mismatch");
    expect(() => createLoopCheckpoint({ executionId: "bad", maxIterations: 2, bindings,
      messages: [assistant(null, [{ id: "a", name: "tool" }])] })).toThrow("checkpoint_unsettled_tool_batch");
    expect(() => createLoopCheckpoint({ executionId: "bad", maxIterations: 2, bindings,
      messages: [assistant(null, [{ id: "a", name: "tool" }]), { role: "user", content: "interruption" }, { role: "tool", tool_call_id: "a", content: "result" }] })).toThrow("checkpoint_interrupted_tool_batch");
    expect(() => parseLoopCheckpoint({ ...initial(), bindings: { configuration: {}, environment: new Date() } })).toThrow();
    expect(() => parseLoopCheckpoint({ ...initial(), state: { ...initial().state, inputTokens: Infinity } })).toThrow();
  });

  test("an initial checkpoint can be committed and paused before inference", async () => {
    const r = runtime([]);
    const result = await runFromCheckpoint({ checkpoint: initial(), restore: async () => r.value, commit: async () => "checkpoint" });
    expect(result.stopReason).toBe("checkpointed");
    expect(result.checkpoint.iterationsUsed).toBe(0);
    expect(result.stats.turns).toBe(0);
  });

  test("a commit callback cannot mutate the checkpoint or running state", async () => {
    let saved: LoopCheckpoint | null = null;
    const r = runtime([finalAnswer("answer")]);
    const result = await runFromCheckpoint({ checkpoint: initial(), restore: async () => r.value,
      commit: async (c) => { saved = c; c.state.messages.length = 0; return "continue"; } });
    expect(saved).not.toBeNull();
    expect(result.checkpoint.state.messages).toHaveLength(2);
  });

  test("automatic compaction and queued input settle before the saved boundary", async () => {
    let persisted = false;
    const r = runtime([toolCallTurn([toolCall("lookup")])], {
      onStepSettled: async () => ({ messages: [{ role: "user", content: "queued" }], stop: false }),
      needsCompaction: () => true,
      applyCompaction: async (trigger, messages) => {
        expect(trigger).toBe("auto");
        expect(messages.at(-1)?.content).toBe("queued");
        return { messages: [{ role: "user", content: "compacted context" }], inputTokens: 2,
          outputTokens: 1, costCents: 1, persist: async () => { persisted = true; } };
      },
    });
    const result = await runFromCheckpoint({ checkpoint: initial(), restore: async () => r.value,
      commit: async (c) => c.iterationsUsed > 0 ? "checkpoint" : "continue" });
    expect(persisted).toBe(true);
    expect(result.checkpoint.state.messages).toEqual([{ role: "user", content: "compacted context" }]);
    expect(result.checkpoint.state.lastPromptTokens).toBe(0);
    expect(result.checkpoint.state.lastOutputTokens).toBe(0);
  });

  test("parallel tool completion settles in transcript order before checkpoint", async () => {
    let releaseFirst!: () => void;
    const released = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const completed: string[] = [];
    const r = runtime([toolCallTurn([toolCall("first", {}, "a"), toolCall("second", {}, "b")])], {
      runToolCall: async (call) => {
        if (call.id === "a") await released;
        else releaseFirst();
        completed.push(call.id);
        return toolOutcome(call.id);
      },
    });
    const result = await runFromCheckpoint({ checkpoint: initial(), restore: async () => r.value,
      commit: async (c) => c.iterationsUsed > 0 ? "checkpoint" : "continue" });
    expect(completed).toEqual(["b", "a"]);
    expect(result.checkpoint.state.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id)).toEqual(["a", "b"]);
    expect(result.checkpoint.stats.toolCalls).toBe(2);
  });

  test("a completed scenario forks without running until new input is supplied", async () => {
    const r = runtime([finalAnswer("old answer")]);
    const done = await runFromCheckpoint({ checkpoint: initial(), restore: async () => r.value, commit: keepGoing });
    const fork = forkLoopCheckpoint(done.checkpoint, { executionId: "next-trial", maxIterations: 2, bindings });
    const idle = await runFromCheckpoint({ checkpoint: fork, restore: async () => { throw new Error("unexpected restore"); }, commit: keepGoing });
    expect(idle.stopReason).toBe("done");
    const next = runtime([finalAnswer("new answer")]);
    const result = await runFromCheckpoint({
      checkpoint: applyCheckpointInput(fork, { kind: "message", message: { role: "user", content: "continue" } }),
      restore: async () => next.value, commit: keepGoing,
    });
    expect(result.checkpoint.state.messages.map((m) => m.content)).toEqual(["Solve the scenario", "old answer", "continue", "new answer"]);
    expect(result.checkpoint.stats.turns).toBe(1);
  });
});
