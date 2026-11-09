import type { RunStats, StopReason, TranscriptMessage } from "../contracts/turn";
import type { ToolLoopState } from "./tool-loop";

/** A stopped invocation cannot be represented as a settled checkpoint. */
export class UnsettledLoopBoundaryError extends Error {
  constructor() {
    super("Cannot checkpoint unsettled execution state; the previous committed checkpoint may precede external effects and requires reconciliation before replay.");
    this.name = "UnsettledLoopBoundaryError";
  }
}

/** A continuation point after the loop has finished all step bookkeeping. */
export type LoopPosition =
  | { kind: "ready" }
  | { kind: "waiting"; reason: "waiting_for_reply" | "resuming_later" }
  | { kind: "finished"; reason: "done" | "iteration_limit" | "aborted" };

export interface LoopBoundary {
  position: LoopPosition;
  iterationsUsed: number;
  state: ToolLoopState;
  /** Cumulative since invocation start, not a delta since the previous boundary. */
  stats: RunStats;
}

/**
 * Persistence is awaited before more model/tool I/O. The state is borrowed:
 * capture a detached value before storing it. Throwing stops the driver.
 * Unsettled failures do not emit a boundary; reconcile effects before retrying.
 */
export interface LoopControl {
  iterationsUsed: number;
  onBoundary(boundary: LoopBoundary): Promise<"continue" | "checkpoint">;
}

export function positionForStop(reason: StopReason): LoopPosition {
  switch (reason) {
    case "done":
    case "iteration_limit":
    case "aborted":
      return { kind: "finished", reason };
    case "waiting_for_reply":
    case "resuming_later":
      return { kind: "waiting", reason };
    case "deadline":
      throw new Error("A thrown deadline has no settled checkpoint");
    default: {
      const exhaustive: never = reason;
      throw new Error(`Unknown stop reason: ${exhaustive}`);
    }
  }
}

/**
 * An ordered protocol check, shared by initial history and checkpoint restore.
 * A waiting checkpoint may leave precisely its suspended call unanswered.
 * History is not provider input: a trailing assistant needs no synthetic turn.
 */
export function assertCheckpointTranscript(messages: readonly TranscriptMessage[], openCall: string | null): void {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") {
      if (!pending.delete(message.tool_call_id)) throw new Error("checkpoint_orphan_tool_result");
      continue;
    }
    if (pending.size > 0) throw new Error("checkpoint_interrupted_tool_batch");
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        if (pending.has(call.id)) throw new Error("checkpoint_duplicate_tool_call");
        pending.add(call.id);
      }
    }
  }
  if (openCall === null ? pending.size !== 0 : pending.size !== 1 || !pending.has(openCall)) {
    throw new Error("checkpoint_unsettled_tool_batch");
  }
}
