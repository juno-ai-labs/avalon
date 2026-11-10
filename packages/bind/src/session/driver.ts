import { emptyRunStats, type RunStats, type StopReason } from "../contracts/turn";
import { runToolLoop, type ToolLoopParams } from "../loop/tool-loop";
import {
  advanceLoopCheckpoint, parseLoopCheckpoint,
  type CheckpointBindings, type LoopCheckpoint,
} from "./checkpoint";

export interface CheckpointRuntime {
  /** Bind keeps state and iteration budget; the host supplies all executable capabilities. */
  params: Omit<ToolLoopParams, "state" | "maxIterations">;
  /** Called at a settled boundary; return pins and the matching restorable host state. */
  captureBindings(): Promise<CheckpointBindings>;
}

export interface CheckpointRunResult {
  checkpoint: LoopCheckpoint;
  stopReason: StopReason | "checkpointed";
  /** Only this invocation's spend. checkpoint.stats covers the whole execution. */
  stats: RunStats;
}

/**
 * Run the existing kernel from a validated boundary, never from an inferred
 * transcript position. No model/tool I/O occurs for waiting or finished input.
 * The host must restore/verify its configuration and environment before returning
 * capabilities. Checkpoint commit failures propagate before further execution.
 */
export async function runFromCheckpoint(input: {
  checkpoint: LoopCheckpoint;
  restore(bindings: CheckpointBindings, executionId: string): Promise<CheckpointRuntime>;
  commit(checkpoint: LoopCheckpoint): Promise<"continue" | "checkpoint">;
}): Promise<CheckpointRunResult> {
  const start = parseLoopCheckpoint(input.checkpoint);
  if (start.position.kind !== "ready") {
    return { checkpoint: start, stopReason: start.position.reason, stats: emptyRunStats() };
  }
  // Pass a separate copy to the host, so restore cannot mutate the saved input.
  const runtime = await input.restore(parseLoopCheckpoint(start).bindings, start.executionId);
  const state = parseLoopCheckpoint(start).state;
  let checkpoint = start;
  const result = await runToolLoop({ ...runtime.params, state, maxIterations: start.maxIterations }, {
    iterationsUsed: start.iterationsUsed,
    onBoundary: async (boundary) => {
      const next = advanceLoopCheckpoint(checkpoint, boundary, start, await runtime.captureBindings());
      const decision = await input.commit(parseLoopCheckpoint(next));
      if (decision !== "continue" && decision !== "checkpoint") throw new Error("checkpoint_commit_decision_invalid");
      checkpoint = next;
      return decision;
    },
  });
  return { ...result, checkpoint };
}
