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
  | "captureSubstreamContext"
  | "installInitialContext"
  | "prepareParticipantMessage"
  | "prepareConversation"
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
  | "activatePendingInput"
  // Reads the queue against the live Bind projection to say which input can
  // start the next cycle; only the object holding the loop can act on it.
  | "nextActivationInput"
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
  // Read by the owning object while it prepares a compaction; the positions
  // are meaningless to any caller that does not hold the loop.
  | "bindMessagePositionsBySourceKind"
  | "omittedTurnEnvelope"
  // Accepted assistant turns may enqueue regional effects in the same SQLite
  // transaction. Function callbacks cannot cross the object-port boundary.
  | "commitBindTransition"
  | "range";
export type TranscriptOperation = Exclude<keyof WorkstreamTranscriptStorage, LocalOnlyTranscriptOperation>;
export type TranscriptObjectPort = ObjectPortOf<Pick<WorkstreamTranscriptStorage, TranscriptOperation>>;

const DISPATCHED_OPERATIONS = [
  "initialContext",
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
