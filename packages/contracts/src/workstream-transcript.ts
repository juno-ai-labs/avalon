import { z } from "zod";
import { HttpUrlSchema } from "./url-schemas";

const UtcTimestampSchema = z.string().datetime({ offset: true });

export const TranscriptIntervalSchema = z.object({
  intervalId: z.string().min(1),
  startedAtUtc: UtcTimestampSchema,
  stoppedAtUtc: UtcTimestampSchema.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  elapsedMsAtSnapshot: z.number().int().nonnegative().nullable(),
  boundarySource: z.enum(["rally", "provider", "normalized", "recovered"]),
  timingAccuracy: z.enum(["observed", "upper_bound"]),
  revision: z.number().int().positive(),
});

export const TranscriptActivitySchema = z.object({
  activityId: z.string().min(1),
  parentActivityId: z.string().min(1).nullable(),
  scope: z.enum(["response", "assistant_turn", "plugin", "tool_call", "thinking", "compaction"]),
  subjectId: z.string().min(1),
  callIndex: z.number().int().nonnegative().nullable(),
  label: z.string().min(1),
  state: z.enum(["active", "completed", "failed", "cancelled", "abandoned", "ambiguous"]),
  intervals: z.array(TranscriptIntervalSchema),
  revision: z.number().int().positive(),
});

export const TranscriptMentionSchema = z.object({
  type: z.enum(["person", "connector"]),
  userId: z.string().nullable(),
  connectorType: z.string().nullable(),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive(),
});

export const TranscriptAttachmentSchema = z.object({
  id: z.string().uuid(),
  fileName: z.string().min(1).max(300),
  mimeType: z.string().min(1).max(160),
  sizeBytes: z.number().int().nonnegative(),
  contentAvailable: z.boolean(),
  createdAt: UtcTimestampSchema,
});

export const TranscriptTextBlockSchema = z.object({
  type: z.literal("text"),
  blockId: z.string().min(1),
  blockIndex: z.number().int().nonnegative(),
  text: z.string(),
  streaming: z.boolean(),
  mentions: z.array(TranscriptMentionSchema).optional(),
  attachments: z.array(TranscriptAttachmentSchema).optional(),
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
  status: z.enum(["planned", "started", "completed", "failed", "ambiguous", "cancelled"]),
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
  authorSnapshot: z.object({
    userId: z.string().min(1),
    displayName: z.string().min(1).max(180),
    avatarUrl: HttpUrlSchema.nullable(),
  }).nullable(),
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
  blockCount: z.number().int().nonnegative().optional(),
  activityId: z.string().min(1).nullable(),
  /**
   * True when a turn's serialized blocks alone exceed the realtime frame
   * budget: the envelope still owns its exact transcript sequence, but its
   * payloads are deliberately not delivered and the client renders a
   * placeholder. Nothing in the product can produce such a turn today; this
   * flag is the whole contract for the day something does.
   */
  blocksOmitted: z.boolean().optional(),
}).superRefine((turn, context) => {
  if (turn.blocksOmitted === true && turn.blockCount === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "transcript_turn_block_count_required",
      path: ["blockCount"],
    });
  }
  if (turn.blockCount !== undefined
    && ((turn.blocksOmitted !== true && turn.blocks.length !== turn.blockCount)
      || (turn.blocksOmitted === true && turn.blocks.length !== 0))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "transcript_turn_block_count_mismatch",
      path: ["blocks"],
    });
  }
  if (turn.actor === "human") {
    if (!turn.authorUserId || !turn.authorSnapshot) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "human_turn_author_provenance_required",
        path: ["authorSnapshot"],
      });
    } else if (turn.authorSnapshot.userId !== turn.authorUserId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "human_turn_author_provenance_mismatch",
        path: ["authorSnapshot", "userId"],
      });
    }
  } else if (turn.authorUserId !== null || turn.authorSnapshot !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "nonhuman_turn_author_provenance_invalid",
      path: [turn.authorSnapshot !== null ? "authorSnapshot" : "authorUserId"],
    });
  }
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

/**
 * A participant input accepted by the substream-owned loop but not yet
 * delivered at a safe execution boundary. It deliberately has no transcript
 * sequence or attention ordinal: assigning either would make presentation
 * state canonical before Bind has accepted the user message.
 */
export const PendingTranscriptInputSchema = z.object({
  inputId: z.string().min(1),
  futureTurnId: z.string().min(1),
  inputSequence: z.number().int().positive(),
  deliveryMode: z.enum(["steer", "queue"]),
  afterTranscriptSequence: z.number().int().nonnegative(),
  actor: z.enum(["human", "external", "system"]),
  authorUserId: z.string().nullable(),
  authorSnapshot: z.object({
    userId: z.string().min(1),
    displayName: z.string().min(1).max(180),
    avatarUrl: HttpUrlSchema.nullable(),
  }).nullable(),
  clientMessageId: z.string().min(1).max(120).nullable(),
  externalActor: z.object({
    provider: z.string().min(1).max(80),
    providerAccountId: z.string().min(1).max(200),
    providerUserId: z.string().min(1).max(200),
    displayName: z.string().min(1).max(180),
    avatarUrl: HttpUrlSchema.nullable(),
  }).nullable(),
  block: TranscriptTextBlockSchema.omit({ streaming: true }).extend({
    streaming: z.literal(false),
  }),
  admittedAtUtc: UtcTimestampSchema,
}).superRefine((input, context) => {
  if (input.futureTurnId !== input.inputId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "pending_input_future_turn_identity_mismatch",
      path: ["futureTurnId"],
    });
  }
  if (input.actor === "human") {
    if (!input.authorUserId || !input.authorSnapshot) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "pending_human_author_provenance_required",
        path: ["authorSnapshot"],
      });
    } else if (input.authorSnapshot.userId !== input.authorUserId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "pending_human_author_provenance_mismatch",
        path: ["authorSnapshot", "userId"],
      });
    }
  } else if (input.authorUserId !== null || input.authorSnapshot !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "pending_nonhuman_author_provenance_invalid",
      path: [input.authorSnapshot !== null ? "authorSnapshot" : "authorUserId"],
    });
  }
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
  /** Server-authoritative presentation overlays, never canonical turns. */
  pendingInputs: z.array(PendingTranscriptInputSchema),
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
export type PendingTranscriptInput = z.infer<typeof PendingTranscriptInputSchema>;
export type WorkstreamTranscriptSnapshot = z.infer<typeof WorkstreamTranscriptSnapshotSchema>;
export type WorkstreamTranscriptRangeRequest = z.infer<typeof WorkstreamTranscriptRangeRequestSchema>;
export type WorkstreamTranscriptEvent = z.infer<typeof WorkstreamTranscriptEventSchema>;
