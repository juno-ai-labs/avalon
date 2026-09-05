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
  | "omittedTurnEnvelope"
  | "range";
export type TranscriptOperation = Exclude<keyof WorkstreamTranscriptStorage, LocalOnlyTranscriptOperation>;
export type TranscriptObjectPort = ObjectPortOf<Pick<WorkstreamTranscriptStorage, TranscriptOperation>>;

const DISPATCHED_OPERATIONS = [
  "initialContext",
  "commitBindTransition",
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
