import {
  type Exhaustive,
  objectPortRequestSchema,
  operationGuard,
  type ObjectPortOf,
} from "./object-port-protocol";
import type { WorkstreamTranscriptStorage } from "./workstream-transcript-storage";
import type { z } from "zod";
import { deferredZodSchema } from "@rally/contracts/deferred-zod-schema";

type LocalOnlyTranscriptOperation =
  | "prepareParticipantMessage"
  // Authenticated product operations resolve immutable human provenance and
  // join the object transaction locally; no generic RPC may impersonate one.
  | "appendParticipantMessage"
  | "appendPreparedParticipantMessage"
  | "prepareToolLifecycle"
  | "upsertPreparedToolLifecycle"
  | "finalizePreparedAssistantTurn"
  | "commitAssistantReservationError"
  | "settleActiveAssistantReservation"
  | "commitRecoveredToolResult"
  | "commitActivationInputs"
  | "settlePendingSteersAtStep"
  // Read by the object's own settlement, for the run it just finished.
  | "absorbedSlackOrigins"
  | "activatePendingInput"
  // Reads the queue against the live Bind projection to say which input can
  // start the next cycle; only the object holding the loop can act on it.
  | "nextActivationInput"
  // Lands queued messages that start no run; same authority as activation.
  | "hasLeadingInputWithoutRun"
  | "deliverLeadingInputsWithoutRun"
  // Lands refused input inside the caller's transaction; same authority.
  | "deliverRefusedInputInTransaction"
  // Read while the object prepares a projection of its own turns.
  | "externalInputFraming"
  // Says whether the loop still owes Bind tool results, and so whether it may
  // be released to `idle`. Answered against the live projection for the two
  // release paths that hold the loop; nothing off-object may ask it.
  | "unsettledToolBatchBlockingRelease"
  | "appendPreparedParticipantMessageAtSequence"
  | "pendingTranscriptInputs"
  | "pendingTranscriptInput"
  | "participantTurn"
  | "participantTurnForTool"
  | "transcriptActivity"
  | "transcriptThrough"
  | "transcriptProjectedThrough"
  // The in-memory Bind projection uses an immutable suffix chain. It is a
  // same-isolate harness input, never an RPC/JSON response.
  | "readBindProjection"
  | "validateHistoricalAssistantReservation"
  // Read by the owning object while it prepares a compaction; the positions
  // are meaningless to any caller that does not hold the loop.
  | "bindMessagePositionsBySourceKind"
  // A repair the owning object runs before its harness reads the projection.
  | "retireInlineToolMessageContent"
  | "omittedTurnEnvelope"
  // Accepted assistant turns may enqueue regional effects in the same SQLite
  // transaction. Function callbacks cannot cross the object-port boundary.
  | "commitBindTransition"
  // Joins the owning object's mutation transaction (a Sidekick run's row).
  | "reviseParticipantTurnInTransaction"
  | "range";
export type TranscriptOperation = Exclude<keyof WorkstreamTranscriptStorage, LocalOnlyTranscriptOperation>;
export type TranscriptObjectPort = ObjectPortOf<Pick<WorkstreamTranscriptStorage, TranscriptOperation>>;

const DISPATCHED_OPERATIONS = [
  "commitBindCompaction",
  "compactionCheckpoint",
  "recordProviderBoundary",
  "upsertToolLifecycle",
  "upsertActivity",
  "createOpeningSnapshot",
  "reserveCompactionStatus",
  "setParticipantTurnAttentionOrdinal",
  "seedDevelopmentConversationTurn",
] as const satisfies readonly TranscriptOperation[];

export const TRANSCRIPT_OPERATIONS:
  Exhaustive<TranscriptOperation, typeof DISPATCHED_OPERATIONS> = DISPATCHED_OPERATIONS;

export const isTranscriptOperation = operationGuard(TRANSCRIPT_OPERATIONS);
export const TranscriptOperationRequestSchema = deferredZodSchema(() => objectPortRequestSchema(
  isTranscriptOperation,
  "unknown_transcript_operation",
));
export type TranscriptOperationRequest = z.infer<typeof TranscriptOperationRequestSchema>;
