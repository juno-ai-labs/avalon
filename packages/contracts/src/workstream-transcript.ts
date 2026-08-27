import { z } from "zod";
import { HttpUrlSchema } from "./url-schemas";

const UtcTimestampSchema = z.string().datetime({ offset: true });

export const TranscriptIntervalSchema = z.object({
  intervalId: z.string().min(1),
  startedAtUtc: UtcTimestampSchema,
  stoppedAtUtc: UtcTimestampSchema.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  elapsedMsAtSnapshot: z.number().int().nonnegative().nullable(),
  revision: z.number().int().positive(),
});

export const TranscriptActivitySchema = z.object({
  activityId: z.string().min(1),
  parentActivityId: z.string().min(1).nullable(),
  scope: z.enum(["response", "assistant_turn", "plugin", "tool_call", "thinking", "compaction"]),
  subjectId: z.string().min(1),
  callIndex: z.number().int().nonnegative().nullable(),
  label: z.string().min(1),
  state: z.enum(["active", "completed", "failed", "cancelled", "abandoned"]),
  intervals: z.array(TranscriptIntervalSchema),
  revision: z.number().int().positive(),
});

export const TranscriptTextBlockSchema = z.object({
  type: z.literal("text"),
  blockId: z.string().min(1),
  blockIndex: z.number().int().nonnegative(),
  text: z.string(),
  streaming: z.boolean(),
  mentions: z.array(z.object({
    type: z.enum(["person", "connector"]),
    userId: z.string().nullable(),
    connectorType: z.string().nullable(),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().positive(),
  })).optional(),
  attachments: z.array(z.object({
    id: z.string().uuid(),
    fileName: z.string().min(1).max(300),
    mimeType: z.string().min(1).max(160),
    sizeBytes: z.number().int().nonnegative(),
    contentAvailable: z.boolean(),
    createdAt: UtcTimestampSchema,
  })).optional(),
  messageType: z.enum(["text", "system", "elicitation", "suggestion"]).optional(),
  structuredContent: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const TranscriptToolBlockSchema = z.object({
  type: z.literal("tool"),
  blockId: z.string().min(1),
  blockIndex: z.number().int().nonnegative(),
  toolCallId: z.string().min(1),
  pluginId: z.string().min(1).nullable(),
  toolName: z.string().min(1),
  callIndex: z.number().int().nonnegative(),
  status: z.enum(["planned", "started", "completed", "failed", "cancelled"]),
  participantSafeInput: z.unknown().nullable(),
  participantSafeResult: z.unknown().nullable(),
  error: z.string().nullable(),
  activityId: z.string().min(1).nullable(),
});

export const TranscriptThinkingBlockSchema = z.object({
  type: z.literal("thinking"),
  blockId: z.string().min(1),
  blockIndex: z.number().int().nonnegative(),
  providerEvidence: z.enum(["reasoning_summary", "reasoning_details", "reasoning_tokens"]),
  // Participant transcripts deliberately expose only evidence that thinking
  // occurred and its activity timing. Provider reasoning content stays in the
  // private Bind-loop projection.
  summary: z.null(),
  activityId: z.string().min(1),
});

export const TranscriptBlockSchema = z.discriminatedUnion("type", [
  TranscriptTextBlockSchema,
  TranscriptToolBlockSchema,
  TranscriptThinkingBlockSchema,
]);

export const TranscriptTurnSchema = z.object({
  transcriptSequence: z.number().int().positive(),
  turnId: z.string().min(1),
  entryKind: z.enum(["conversation", "status"]),
  actor: z.enum(["human", "assistant", "external", "system"]),
  authorUserId: z.string().nullable(),
  clientMessageId: z.string().max(120).nullable().optional(),
  externalActor: z.object({
    provider: z.string().min(1).max(80),
    providerAccountId: z.string().min(1).max(200),
    providerUserId: z.string().min(1).max(200),
    displayName: z.string().min(1).max(180),
    avatarUrl: HttpUrlSchema.nullable(),
  }).nullable().optional(),
  attentionOrdinal: z.number().int().positive().nullable(),
  createdAtUtc: UtcTimestampSchema,
  revision: z.number().int().positive(),
  blocks: z.array(TranscriptBlockSchema),
  activityId: z.string().min(1).nullable(),
  turnManifestRef: z.string().min(1).nullable(),
  manifestByteLength: z.number().int().nonnegative().nullable(),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
});

export const TranscriptRangeSchema = z.object({
  startInclusive: z.number().int().positive(),
  endExclusive: z.number().int().positive(),
}).refine((range) => range.endExclusive >= range.startInclusive, "invalid_transcript_range");

export const TranscriptRangeResultSchema = z.object({
  purpose: z.enum(["unread", "latest", "unread_and_latest", "requested"]),
  requested: TranscriptRangeSchema,
  covered: TranscriptRangeSchema,
  turns: z.array(TranscriptTurnSchema),
  activities: z.array(TranscriptActivitySchema),
});

export const WorkstreamTranscriptSnapshotSchema = z.object({
  snapshotId: z.string().min(1),
  snapshotThrough: z.number().int().nonnegative(),
  eventSequence: z.number().int().nonnegative(),
  snapshotAtUtc: UtcTimestampSchema,
  unreadAnchorSequence: z.number().int().positive().nullable(),
  unreadReason: z.enum(["no_unread", "anchor_unavailable"]).nullable(),
  ranges: z.array(TranscriptRangeResultSchema),
  activities: z.array(TranscriptActivitySchema),
  activeActivities: z.array(TranscriptActivitySchema),
  activeTurns: z.array(TranscriptTurnSchema),
});

export const WorkstreamTranscriptRangeRequestSchema = z.object({
  snapshotId: z.string().min(1),
  range: TranscriptRangeSchema,
  resumeAfterEventSequence: z.number().int().nonnegative(),
});

export const WorkstreamTranscriptEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("turn_upserted"),
    eventSequence: z.number().int().positive(),
    turn: TranscriptTurnSchema,
  }),
  z.object({
    type: z.literal("activity_upserted"),
    eventSequence: z.number().int().positive(),
    activity: TranscriptActivitySchema,
    snapshotAtUtc: UtcTimestampSchema,
  }),
  z.object({
    type: z.literal("resync_required"),
    eventSequence: z.number().int().nonnegative(),
    reason: z.enum(["history_unavailable", "snapshot_expired", "sequence_ahead"]),
  }),
]);

export type TranscriptInterval = z.infer<typeof TranscriptIntervalSchema>;
export type TranscriptActivity = z.infer<typeof TranscriptActivitySchema>;
export type TranscriptBlock = z.infer<typeof TranscriptBlockSchema>;
export type TranscriptTurn = z.infer<typeof TranscriptTurnSchema>;
export type TranscriptRange = z.infer<typeof TranscriptRangeSchema>;
export type TranscriptRangeResult = z.infer<typeof TranscriptRangeResultSchema>;
export type WorkstreamTranscriptSnapshot = z.infer<typeof WorkstreamTranscriptSnapshotSchema>;
export type WorkstreamTranscriptRangeRequest = z.infer<typeof WorkstreamTranscriptRangeRequestSchema>;
export type WorkstreamTranscriptEvent = z.infer<typeof WorkstreamTranscriptEventSchema>;
