import { describe, expect, it } from "vitest";

import {
  applyBindLoopTransition,
  hashBindLoop,
  projectBindLoopMessages,
  verifyBindProviderBoundary,
  type BindLoopProjectionState,
} from "./bind-loop-projection";

const system = {
  revision: 1,
  rendererVersion: "workstream-system-v1",
  inputHash: "system-input-1",
  message: { role: "system", content: "Use the active plugins." },
};

function initialized(): BindLoopProjectionState {
  return applyBindLoopTransition(null, {
    kind: "state_initialized",
    loopId: "run-1",
    generation: 1,
    stateRevision: 1,
    systemProjection: system,
    nonSystemMessages: [{ role: "user", content: "Start" }],
  });
}

describe("Bind loop projection", () => {
  it("recreates the exact provider array through assistant and parallel tool-result acceptance", async () => {
    let state = initialized();
    state = applyBindLoopTransition(state, {
      kind: "assistant_accepted",
      loopId: "run-1",
      generation: 1,
      stateRevision: 2,
      turnId: "run-1:turn:1",
      modelTurnIndex: 1,
      message: {
        role: "assistant",
        content: "I will check both.",
        tool_calls: [
          { id: "call-a", type: "function", function: { name: "search", arguments: "{\"q\":\"a\"}" } },
          { id: "call-b", type: "function", function: { name: "search", arguments: "{\"q\":\"b\"}" } },
        ],
      },
    });
    // Execution may settle in either order, but Bind accepts result messages in
    // the provider's declared call order. The ledger records that accepted order.
    state = applyBindLoopTransition(state, {
      kind: "tool_result_accepted",
      loopId: "run-1",
      generation: 1,
      stateRevision: 3,
      turnId: "run-1:turn:1",
      toolCallId: "call-a",
      callIndex: 0,
      message: { role: "tool", tool_call_id: "call-a", content: "A" },
    });
    state = applyBindLoopTransition(state, {
      kind: "tool_result_accepted",
      loopId: "run-1",
      generation: 1,
      stateRevision: 4,
      turnId: "run-1:turn:1",
      toolCallId: "call-b",
      callIndex: 1,
      message: { role: "tool", tool_call_id: "call-b", content: "B" },
    });

    const projected = projectBindLoopMessages(state);
    expect(projected.map((message) => message.role)).toEqual([
      "system", "user", "assistant", "tool", "tool",
    ]);
    await expect(verifyBindProviderBoundary({
      loopId: state.loopId,
      generation: state.generation,
      stateRevision: state.stateRevision,
      systemProjectionRevision: state.systemProjection.revision,
      projectedMessages: projected,
      bindMessages: structuredClone(projected),
    })).resolves.toMatchObject({ projectedHash: await hashBindLoop(projected) });
  });

  it("rejects missing, duplicated, and stale transitions", () => {
    const state = initialized();
    expect(() => applyBindLoopTransition(state, {
      kind: "assistant_accepted",
      loopId: "run-1",
      generation: 1,
      stateRevision: 1,
      turnId: "turn",
      modelTurnIndex: 1,
      message: { role: "assistant", content: "duplicate" },
    })).toThrow("bind_loop_revision_out_of_order");
    expect(() => applyBindLoopTransition(state, {
      kind: "assistant_accepted",
      loopId: "run-1",
      generation: 1,
      stateRevision: 3,
      turnId: "turn",
      modelTurnIndex: 1,
      message: { role: "assistant", content: "gap" },
    })).toThrow("bind_loop_revision_out_of_order");
    expect(() => applyBindLoopTransition(state, {
      kind: "assistant_accepted",
      loopId: "run-1",
      generation: 2,
      stateRevision: 2,
      turnId: "turn",
      modelTurnIndex: 1,
      message: { role: "assistant", content: "wrong generation" },
    })).toThrow("bind_loop_generation_mismatch");
  });

  it("survives two independent compaction replacements without losing exactness", async () => {
    let state = initialized();
    state = applyBindLoopTransition(state, {
      kind: "state_replaced",
      loopId: "run-1",
      generation: 1,
      nextGeneration: 2,
      stateRevision: 2,
      compactionEventId: "compaction-1",
      systemProjection: system,
      nonSystemMessages: [{ role: "user", content: "Checkpoint one" }],
    });
    state = applyBindLoopTransition(state, {
      kind: "assistant_accepted",
      loopId: "run-1",
      generation: 2,
      stateRevision: 3,
      turnId: "run-1:turn:2",
      modelTurnIndex: 2,
      message: { role: "assistant", content: "After one" },
    });
    state = applyBindLoopTransition(state, {
      kind: "state_replaced",
      loopId: "run-1",
      generation: 2,
      nextGeneration: 3,
      stateRevision: 4,
      compactionEventId: "compaction-2",
      systemProjection: system,
      nonSystemMessages: [{ role: "user", content: "Checkpoint two" }],
    });

    expect(state.generation).toBe(3);
    expect(projectBindLoopMessages(state)).toEqual([
      system.message,
      { role: "user", content: "Checkpoint two" },
    ]);
    await expect(verifyBindProviderBoundary({
      loopId: state.loopId,
      generation: state.generation,
      stateRevision: state.stateRevision,
      systemProjectionRevision: state.systemProjection.revision,
      projectedMessages: projectBindLoopMessages(state),
      bindMessages: [system.message, { role: "user", content: "different" }],
    })).rejects.toThrow("bind_loop_projection_mismatch");
  });
});
