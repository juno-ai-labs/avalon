import {
  type Exhaustive,
  objectPortRequestSchema,
  operationGuard,
  type ObjectPortOf,
} from "./object-port-protocol";
import type { WorkstreamTranscriptStorage } from "./workstream-transcript-storage";
import type { z } from "zod";

type LocalOnlyTranscriptOperation =
  | "prepareParticipantMessage"
  | "appendPreparedParticipantMessage"
  | "participantTurn"
  | "participantTurnForTool"
  | "acceptedTurnAlreadyCarries"
  | "range";
export type TranscriptOperation = Exclude<keyof WorkstreamTranscriptStorage, LocalOnlyTranscriptOperation>;
export type TranscriptObjectPort = ObjectPortOf<Pick<WorkstreamTranscriptStorage, TranscriptOperation>>;

const DISPATCHED_OPERATIONS = [
  "commitBindTransition",
  "commitBindCompaction",
  "compactionCheckpoint",
  "recordProviderBoundary",
  "appendParticipantMessage",
  "upsertToolLifecycle",
  "upsertActivity",
  "createOpeningSnapshot",
  "readBindProjection",
  "reserveCompactionStatus",
  "setParticipantTurnAttentionOrdinal",
] as const satisfies readonly TranscriptOperation[];

export const TRANSCRIPT_OPERATIONS:
  Exhaustive<TranscriptOperation, typeof DISPATCHED_OPERATIONS> = DISPATCHED_OPERATIONS;

export const isTranscriptOperation = operationGuard(TRANSCRIPT_OPERATIONS);
export const TranscriptOperationRequestSchema = objectPortRequestSchema(
  isTranscriptOperation,
  "unknown_transcript_operation",
);
export type TranscriptOperationRequest = z.infer<typeof TranscriptOperationRequestSchema>;
