import { z } from "zod";
import { HttpUrlSchema } from "./url-schemas";

const UtcTimestampSchema = z.string().datetime({ offset: true });

/**
 * Stable identity for one canonical transcript turn.
 *
 * Participant messages use UUIDs, while assistant turns are derived from the
 * durable loop identity and turn ordinal. Consumers must therefore treat this
 * as an opaque transcript key instead of validating every turn as an entity ID.
 */
export const TranscriptTurnIdSchema = z.string().min(1);

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

/**
 * One plugin's work inside one assistant turn, resolved by the server.
 *
 * The transcript already carries plugin work as an activity tree, but a reader
 * of that tree has to rebuild the relationship: find the plugin-scope activity,
 * walk to its `assistant_turn` parent, match that parent's subject to a turn,
 * and match the activity's subject to a tool block's `pluginId`. Every one of
 * those joins is derived separately, two of the keys they join on are nullable,
 * and a snapshot only carries the activities one upward walk happens to reach.
 * When any link missed, the client had no way to tell "took no time" from "I
 * cannot see the timing", and rendered the second as `0ms`.
 *
 * This is that answer computed once, by the authority that owns the data. The
 * server states which plugin ran, in which turn, for how long, and which calls
 * it made; a client joins on `toolCallIds` and renders what it is told.
 *
 * `durationMs` is nullable on purpose. Null means the timing is genuinely
 * unknown — no interval, or one closed without a duration by code that ran
 * before this field existed — and a client must render that as an absent
 * duration rather than as zero. Zero means the work really took no measurable
 * time.
 */
export const TranscriptPluginRunSchema = z.object({
  /** The plugin activity's id; stable across snapshots of the same run. */
  pluginRunId: z.string().min(1),
  /** The assistant turn this work belongs to, already resolved. */
  turnId: TranscriptTurnIdSchema,
  /** The plugin's canonical id, as the tool blocks carry it. */
  pluginId: z.string().min(1),
  /** The plugin's display name, or its canonical id when it carries none. */
  displayName: z.string().min(1),
  connectorType: z.string().min(1).optional(),
  state: z.enum(["active", "completed", "failed", "cancelled", "abandoned", "ambiguous"]),
  /** Total measured work. Null when the timing cannot be established. */
  durationMs: z.number().int().nonnegative().nullable(),
  /** Set while the plugin is still running, for a live-ticking client. */
  elapsedMsAtSnapshot: z.number().int().nonnegative().nullable(),
  timingAccuracy: z.enum(["observed", "upper_bound"]),
  /** The calls this run made, in the order they were placed. */
  toolCallIds: z.array(z.string().min(1)),
});

export const TranscriptActivitySchema = z.object({
  activityId: z.string().min(1),
  parentActivityId: z.string().min(1).nullable(),
  scope: z.enum(["response", "assistant_turn", "plugin", "tool_call", "thinking", "compaction"]),
  subjectId: z.string().min(1),
  callIndex: z.number().int().nonnegative().nullable(),
  label: z.string().min(1),
  connectorType: z.string().min(1).optional(),
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
  messageType: z.enum(["text", "system", "elicitation", "suggestion", "automation_activation"]).optional(),
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
  turnId: TranscriptTurnIdSchema,
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
  /**
   * Plugin work for the turns in this range, on the same terms as the opening
   * snapshot's. A range loaded later covers turns the opening snapshot never
   * did, and those turns need their runs resolved by the authority for the same
   * reason the opening ones do — the activity tree they ship with is subject to
   * exactly the nullable joins `pluginRuns` exists to stop depending on.
   */
  pluginRuns: z.array(TranscriptPluginRunSchema).default([]),
});

/** Set by the team on 2026-10-21, matching the desktop's hydration page size. */
export const DEFAULT_TRANSCRIPT_READ_TURNS = 20;

/** Worker-side text access to the same range reader used by socket hydration. */
export const ReadTranscriptRequestSchema = z.strictObject({
  afterSequence: z.number().int().nonnegative().default(0),
  throughSequence: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
});
export type ReadTranscriptRequest = z.infer<typeof ReadTranscriptRequestSchema>;
export const ReadTranscriptResultSchema = z.strictObject({
  title: z.string(),
  text: z.string(),
  throughSequence: z.number().int().nonnegative(),
  nextAfterSequence: z.number().int().nonnegative().nullable(),
});

/** Internal inspection does not seat a viewer or acknowledge the conversation. */
/**
 * What a Sidekick run spent, read from the run's own object for its first
 * page: model calls (one assistant turn per provider response) and every
 * tool's calls and time, with a program's own requests counted apart.
 */
export const SidekickRunUsageSchema = z.strictObject({
  modelCalls: z.number().int().nonnegative(),
  tools: z.array(z.strictObject({
    toolName: z.string(),
    fromProgram: z.boolean(),
    calls: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    ms: z.number().nullable(),
    maxMs: z.number().nullable(),
  })),
});

export const SidekickRunTranscriptResultSchema = z.strictObject({
  transcriptAvailability: z.enum(["available", "not_provisioned"]),
  turns: z.array(TranscriptTurnSchema),
  throughSequence: z.number().int().nonnegative(),
  nextAfterSequence: z.number().int().nonnegative().nullable(),
  /** On the first page only. */
  usage: SidekickRunUsageSchema.optional(),
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
  /**
   * Plugin work for the turns this snapshot carries, resolved server-side.
   *
   * Defaulted rather than required because a desktop build updates on its own
   * schedule: a new client must still parse a snapshot from an API that
   * predates this field. An empty array therefore means "this server does not
   * report plugin runs", not "no plugin ran", and a client falls back to the
   * activity tree for that case.
   */
  pluginRuns: z.array(TranscriptPluginRunSchema).default([]),
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
export type TranscriptPluginRun = z.infer<typeof TranscriptPluginRunSchema>;
export type WorkstreamTranscriptSnapshot = z.infer<typeof WorkstreamTranscriptSnapshotSchema>;
export type WorkstreamTranscriptRangeRequest = z.infer<typeof WorkstreamTranscriptRangeRequestSchema>;
export type WorkstreamTranscriptEvent = z.infer<typeof WorkstreamTranscriptEventSchema>;
