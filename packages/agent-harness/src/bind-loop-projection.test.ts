import { describe, expect, it } from "vitest";

import {
  applyBindLoopTransition,
  canonicalizeBindLoop,
  hashBindLoop,
  pendingBindToolBatch,
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
    nonSystemMessageOrigins: [{
      originKind: "derived",
      sourceKind: "participant_turn",
      sourceId: "message-1",
      sourceRevision: 1,
    }],
  });
}

describe("Bind loop projection", () => {
  it("canonicalizes object keys by deterministic UTF-16 code-unit order", () => {
    // Default locale collation places `a` before `Z` on supported Node/ICU
    // builds, while canonical JSON must not depend on that runtime data.
    expect(canonicalizeBindLoop({ a: 2, Z: 1 })).toBe('{"Z":1,"a":2}');
  });

  it("shares the immutable message prefix across ordinary transitions and replaces it only for compaction", () => {
    const state = initialized();
    const systemChanged = applyBindLoopTransition(state, {
      kind: "system_projection_changed",
      loopId: "run-1",
      generation: 1,
      stateRevision: 2,
      systemProjection: { ...system, revision: 2, inputHash: "system-input-2" },
    });
    expect(systemChanged.nonSystemMessageTail).toBe(state.nonSystemMessageTail);

    const reserved = applyBindLoopTransition(state, {
      kind: "assistant_reserved",
      loopId: "run-1",
      generation: 1,
      stateRevision: 2,
      turnId: "run-1:turn:1",
      modelTurnIndex: 1,
      transcriptSequence: 2,
    });
    expect(reserved.nonSystemMessageTail).toBe(state.nonSystemMessageTail);
    const accepted = applyBindLoopTransition(reserved, {
      kind: "assistant_accepted",
      loopId: "run-1",
      generation: 1,
      stateRevision: 3,
      turnId: "run-1:turn:1",
      modelTurnIndex: 1,
      transcriptSequence: 2,
      message: { role: "assistant", content: "Done" },
    });
    expect(accepted.nonSystemMessageTail?.previous).toBe(state.nonSystemMessageTail);
    expect(accepted.nonSystemMessageTail?.length).toBe(2);

    const compacted = applyBindLoopTransition(state, {
      kind: "state_replaced",
      loopId: "run-1",
      generation: 1,
      nextGeneration: 2,
      stateRevision: 2,
      compactionEventId: "compaction-structural-sharing",
      systemProjection: system,
      nonSystemMessages: [{ role: "user", content: "Summary" }],
    });
    expect(compacted.nonSystemMessageTail).not.toBe(state.nonSystemMessageTail);
    expect(projectBindLoopMessages(compacted)).toEqual([
      system.message,
      { role: "user", content: "Summary" },
    ]);
  });

  it("recreates the exact provider array through assistant and parallel tool-result acceptance", async () => {
    let state = initialized();
    state = applyBindLoopTransition(state, {
      kind: "assistant_reserved",
      loopId: "run-1",
      generation: 1,
      stateRevision: 2,
      turnId: "run-1:turn:1",
      modelTurnIndex: 1,
      transcriptSequence: 2,
    });
    state = applyBindLoopTransition(state, {
      kind: "assistant_accepted",
      loopId: "run-1",
      generation: 1,
      stateRevision: 3,
      turnId: "run-1:turn:1",
      modelTurnIndex: 1,
      transcriptSequence: 2,
      message: {
        role: "assistant",
        content: "I will check both.",
        tool_calls: [
          { id: "call-a", type: "function", function: { name: "search", arguments: "{\"q\":\"a\"}" } },
          { id: "call-b", type: "function", function: { name: "search", arguments: "{\"q\":\"b\"}" } },
        ],
      },
    });
    // A withheld result may arrive after a later call already settled. Keep the
    // original call position for identity while accepting results in their own
    // dense durable order.
    state = applyBindLoopTransition(state, {
      kind: "tool_result_accepted",
      loopId: "run-1",
      generation: 1,
      stateRevision: 4,
      turnId: "run-1:turn:1",
      toolCallId: "call-b",
      callIndex: 1,
      resultOrdinal: 0,
      message: { role: "tool", tool_call_id: "call-b", content: "B" },
    });
    expect(pendingBindToolBatch(state)).toMatchObject({
      loopId: "run-1",
      turnId: "run-1:turn:1",
      stateRevision: 4,
      calls: [{
        providerToolCallId: "call-a",
        receiptToolCallId: "run-1:turn:1:tool:0",
        callIndex: 0,
        toolName: "search",
      }],
    });
    expect(pendingBindToolBatch({ ...state, loopId: "relocated-loop" })).toMatchObject({
      loopId: "relocated-loop",
      turnId: "run-1:turn:1",
      calls: [{ providerToolCallId: "call-a", receiptToolCallId: "run-1:turn:1:tool:0" }],
    });
    state = applyBindLoopTransition(state, {
      kind: "tool_result_accepted",
      loopId: "run-1",
      generation: 1,
      stateRevision: 5,
      turnId: "run-1:turn:1",
      toolCallId: "call-a",
      callIndex: 0,
      resultOrdinal: 1,
      message: { role: "tool", tool_call_id: "call-a", content: "A" },
    });
    expect(pendingBindToolBatch(state)).toBeNull();

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
      stateRevision: 2,
      turnId: "run-1:turn:1",
      modelTurnIndex: 1,
      transcriptSequence: 2,
      message: { role: "assistant", content: "unreserved" },
    })).toThrow("bind_loop_assistant_reservation_mismatch");
    expect(() => applyBindLoopTransition(state, {
      kind: "assistant_reserved",
      loopId: "run-1",
      generation: 1,
      stateRevision: 3,
      turnId: "run-1:turn:1",
      modelTurnIndex: 1,
      transcriptSequence: 2,
    })).toThrow("bind_loop_revision_out_of_order");
    expect(() => applyBindLoopTransition(state, {
      kind: "assistant_reserved",
      loopId: "run-1",
      generation: 2,
      stateRevision: 2,
      turnId: "run-1:turn:1",
      modelTurnIndex: 1,
      transcriptSequence: 2,
    })).toThrow("bind_loop_generation_mismatch");
    expect(() => applyBindLoopTransition(state, {
      kind: "assistant_reserved",
      loopId: "run-1",
      generation: 1,
      stateRevision: 2,
      turnId: "run-1:turn:2",
      modelTurnIndex: 2,
      transcriptSequence: 2,
    })).toThrow("bind_loop_model_turn_out_of_order");
    expect(() => applyBindLoopTransition(state, {
      kind: "assistant_reserved",
      loopId: "run-1",
      generation: 1,
      stateRevision: 2,
      turnId: "run-1:turn:1",
      modelTurnIndex: 1,
      transcriptSequence: 0,
    })).toThrow("bind_loop_transcript_sequence_invalid");

    const reserved = applyBindLoopTransition(state, {
      kind: "assistant_reserved",
      loopId: "run-1",
      generation: 1,
      stateRevision: 2,
      turnId: "run-1:turn:1",
      modelTurnIndex: 1,
      transcriptSequence: 2,
    });
    expect(() => applyBindLoopTransition(reserved, {
      kind: "assistant_reserved",
      loopId: "run-1",
      generation: 1,
      stateRevision: 3,
      turnId: "run-1:turn:2",
      modelTurnIndex: 2,
      transcriptSequence: 3,
    })).toThrow("bind_loop_assistant_reservation_pending");
    const settled = applyBindLoopTransition(reserved, {
      kind: "assistant_reservation_settled",
      loopId: "run-1",
      generation: 1,
      stateRevision: 3,
      turnId: "run-1:turn:1",
      modelTurnIndex: 1,
      transcriptSequence: 2,
      outcome: "failed",
    });
    expect(settled.lastAssistantReservation?.status).toBe("failed");
    expect(() => applyBindLoopTransition(settled, {
      kind: "assistant_accepted",
      loopId: "run-1",
      generation: 1,
      stateRevision: 4,
      turnId: "run-1:turn:1",
      modelTurnIndex: 1,
      transcriptSequence: 2,
      message: { role: "assistant", content: "late" },
    })).toThrow("bind_loop_assistant_reservation_mismatch");

    const toolReserved = applyBindLoopTransition(state, {
      kind: "assistant_reserved",
      loopId: "run-1",
      generation: 1,
      stateRevision: 2,
      turnId: "run-1:turn:1",
      modelTurnIndex: 1,
      transcriptSequence: 2,
    });
    const toolAccepted = applyBindLoopTransition(toolReserved, {
      kind: "assistant_accepted",
      loopId: "run-1",
      generation: 1,
      stateRevision: 3,
      turnId: "run-1:turn:1",
      modelTurnIndex: 1,
      transcriptSequence: 2,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call-a", type: "function", function: { name: "read", arguments: "{}" } },
          { id: "call-b", type: "function", function: { name: "read", arguments: "{}" } },
        ],
      },
    });
    expect(() => applyBindLoopTransition(toolAccepted, {
      kind: "tool_result_accepted",
      loopId: "run-1",
      generation: 1,
      stateRevision: 4,
      turnId: "run-1:turn:1",
      toolCallId: "call-b",
      callIndex: 0,
      resultOrdinal: 0,
      message: { role: "tool", tool_call_id: "call-b", content: "B" },
    })).toThrow("bind_loop_tool_result_out_of_order");
    expect(() => applyBindLoopTransition(toolAccepted, {
      kind: "protocol_user_appended",
      loopId: "run-1",
      generation: 1,
      stateRevision: 4,
      message: { role: "user", content: "too early" },
      provenance: {
        originKind: "derived",
        sourceKind: "pending_input",
        sourceId: "participant-turn-2",
        sourceRevision: 1,
      },
      activationInputId: null,
    })).toThrow("bind_loop_protocol_user_invalid");
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
      kind: "assistant_reserved",
      loopId: "run-1",
      generation: 2,
      stateRevision: 3,
      turnId: "run-1:turn:1",
      modelTurnIndex: 1,
      transcriptSequence: 5,
    });
    state = applyBindLoopTransition(state, {
      kind: "assistant_accepted",
      loopId: "run-1",
      generation: 2,
      stateRevision: 4,
      turnId: "run-1:turn:1",
      modelTurnIndex: 1,
      transcriptSequence: 5,
      message: { role: "assistant", content: "After one" },
    });
    state = applyBindLoopTransition(state, {
      kind: "state_replaced",
      loopId: "run-1",
      generation: 2,
      nextGeneration: 3,
      stateRevision: 5,
      compactionEventId: "compaction-2",
      systemProjection: system,
      nonSystemMessages: [{ role: "user", content: "Checkpoint two" }],
    });

    expect(state.generation).toBe(3);
    expect(state.lastModelTurnIndex).toBe(1);
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
