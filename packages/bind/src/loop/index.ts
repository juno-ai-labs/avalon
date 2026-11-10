// Re-exported from `../contracts` so a consumer of `@juno-ai/bind/loop` can
// `switch` exhaustively on `result.stopReason`, or annotate `result.stats`,
// without adding a second subpath import for the types its own return value
// is made of.
export type { StopReason, RunStats } from "../contracts/turn";
export {
  runToolLoop,
  MissingActivationPortError,
  DiscardedTurnWithToolCallsError,
  InputBlockedBySuspendError,
  type ToolLoopParams,
  type ToolLoopResult,
  type ToolLoopState,
  type ToolLoopTurn,
  type ToolCallOutcome,
  type StepSettlement,
  type CompactionApplied,
  type RunStatus,
} from "./tool-loop";

export type { LoopBoundary, LoopControl, LoopPosition } from "./boundary";
export { UnsettledLoopBoundaryError } from "./boundary";
