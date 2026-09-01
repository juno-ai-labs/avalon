import { IdSchema } from "@rally/contracts";
import { z } from "zod";

/**
 * The workspace's notes, transcript segments, and their two outboxes, as
 * questions rather than SQL.
 *
 * `NoteService` reached these tables through the workspace runtime facade,
 * which routes by table name and sends anything it does not recognise to the
 * regional database — the routing that took automation run work streams down
 * when `automation_directory` was missing from its list. A typed method cannot
 * be routed to the wrong database, because its tables are named inside the
 * object that has them.
 *
 * The field bounds below are the columns' own CHECK constraints, carried over
 * from the row contracts the service used to assert at its edge: a row that
 * fails one is a row that should not exist, and the failure names the column
 * instead of travelling on as an anonymous 500.
 */

const TimestampSchema = z.string().min(1);

/**
 * How much of the note the caller may see or move.
 *
 * `view` is the read guard every fetch applies — unarchived, and either
 * workspace-shared or the caller's own. `edit` is the owner fence every write
 * sits behind. `any` answers only "does this id exist here", which the
 * idempotent create endpoint needs before the read guard decides what the
 * caller is told about it.
 */
export const WorkspaceNoteAccessSchema = z.enum(["any", "view", "edit"]);

export const WorkspaceNoteRecordSchema = z.strictObject({
  id: IdSchema,
  workspaceId: IdSchema,
  ownerUserId: IdSchema,
  resourceId: IdSchema,
  scope: z.enum(["personal", "workspace"]),
  title: z.string(),
  recordingStatus: z.enum(["idle", "recording", "complete"]),
  manualNotesMarkdown: z.string(),
  liveNotesMarkdown: z.string(),
  notesThroughSequence: z.number().int().nonnegative(),
  recordedMs: z.number().int().nonnegative(),
  startedAt: TimestampSchema.nullable(),
  endedAt: TimestampSchema.nullable(),
  generatedAt: TimestampSchema.nullable(),
  lastActivityAt: TimestampSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  archivedAt: TimestampSchema.nullable(),
});

/** Field names match the `NoteTranscriptSegment` contract the routes serve. */
export const WorkspaceNoteSegmentRecordSchema = z.strictObject({
  id: IdSchema,
  noteId: IdSchema,
  sequenceNumber: z.number().int().min(1),
  startOffsetMs: z.number().int().nonnegative(),
  endOffsetMs: z.number().int().nonnegative(),
  capturedAt: TimestampSchema,
  speakerLabel: z.string().nullable(),
  text: z.string(),
  createdAt: TimestampSchema,
});

export const WorkspaceNoteStateRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  noteId: IdSchema,
  userId: IdSchema,
  access: WorkspaceNoteAccessSchema,
});

/**
 * The note and its ordered transcript in one read; both empty on a miss, and
 * the transcript deliberately empty for `any` access — that mode answers
 * existence, and its caller re-reads under the view guard before showing
 * anything.
 */
export const WorkspaceNoteStateSchema = z.strictObject({
  note: WorkspaceNoteRecordSchema.nullable(),
  segments: z.array(WorkspaceNoteSegmentRecordSchema),
});

export const WorkspaceNoteUpdateRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  noteId: IdSchema,
  userId: IdSchema,
  at: TimestampSchema,
  title: z.string().optional(),
  manualNotesMarkdown: z.string().optional(),
  scope: z.enum(["personal", "workspace"]).optional(),
  recordingStatus: z.enum(["idle", "recording", "complete"]).optional(),
  recordedMs: z.number().int().nonnegative().optional(),
  // Present-and-null clears the instant; absent leaves it. The distinction is
  // the route contract's, and it survives the RPC because absence does.
  startedAt: TimestampSchema.nullable().optional(),
  endedAt: TimestampSchema.nullable().optional(),
});

/**
 * `becamePrivate` is decided inside the same transaction as the write, from
 * the row the write actually replaced. The service used to decide it from a
 * read one round trip earlier, and the D1 trigger that turned that transition
 * into a `note_privacy_change_outbox` row did not travel to the object at
 * cutover — the object writes the transition row itself, atomically with the
 * scope change.
 */
export const WorkspaceNoteUpdateResultSchema = z.strictObject({
  outcome: z.enum(["updated", "not_found"]),
  becamePrivate: z.boolean(),
});

export const WorkspaceNoteArchiveRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  noteId: IdSchema,
  userId: IdSchema,
  at: TimestampSchema,
});

/**
 * `recording` and `not_found` owe the caller different answers — ending the
 * recording is actionable, a missing note is not. As a write and a fallback
 * read they were decided one round trip apart, so the classification could
 * describe a row the write never saw.
 */
export const WorkspaceNoteArchiveResultSchema = z.strictObject({
  outcome: z.enum(["archived", "not_found", "recording"]),
});

export const WorkspaceNoteSegmentAppendRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  noteId: IdSchema,
  userId: IdSchema,
  segmentId: IdSchema,
  clientSegmentId: IdSchema,
  startOffsetMs: z.number().int().nonnegative(),
  endOffsetMs: z.number().int().nonnegative(),
  capturedAt: TimestampSchema,
  speakerLabel: z.string().nullable(),
  text: z.string(),
  at: TimestampSchema,
});

/**
 * `duplicate` returns the stored segment for the same `clientSegmentId`, so a
 * replayed save is answered rather than refused. As facade statements the
 * duplicate check, the sequence allocation and the insert were separate round
 * trips: a replay racing itself burned a sequence number and fell into the
 * unique constraint, and the service carried a compensating re-read for it.
 */
export const WorkspaceNoteSegmentAppendResultSchema = z.strictObject({
  outcome: z.enum(["appended", "duplicate", "note_not_found"]),
  segment: WorkspaceNoteSegmentRecordSchema.nullable(),
});

export const WorkspaceNoteGenerationCommitRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  noteId: IdSchema,
  userId: IdSchema,
  liveNotesMarkdown: z.string(),
  throughSequence: z.number().int().nonnegative(),
  generatedAt: TimestampSchema,
  /** The cursor pair the caller read before inference; the commit lands only if both still hold. */
  expectedThroughSequence: z.number().int().nonnegative(),
  expectedGeneratedAt: TimestampSchema.nullable(),
});

export const WorkspaceNoteGenerationCommitResultSchema = z.strictObject({
  outcome: z.enum(["committed", "stale"]),
});

export const WorkspaceNoteSidebarRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  userId: IdSchema,
  limit: z.number().int().min(1),
});

/**
 * Loose mirror of the `NoteSummary` contract: the object already validated
 * each row against `NoteSidebarRowSchema`, and the summary contract's tighter
 * bounds belong to the route that serves it.
 */
export const WorkspaceNoteSidebarListSchema = z.strictObject({
  items: z.array(z.strictObject({
    id: IdSchema,
    workspaceId: IdSchema,
    resourceId: IdSchema,
    ownerUserId: IdSchema,
    scope: z.enum(["personal", "workspace"]),
    title: z.string(),
    recordingStatus: z.enum(["idle", "recording", "complete"]),
    recordedMs: z.number().int().nonnegative(),
    startedAt: TimestampSchema.nullable(),
    endedAt: TimestampSchema.nullable(),
    generatedAt: TimestampSchema.nullable(),
    lastActivityAt: TimestampSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    archivedAt: TimestampSchema.nullable(),
  })),
});

export const WorkspaceNoteVisibilityRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  /** Null for a non-user principal, which sees only workspace-scoped notes. */
  userId: IdSchema.nullable(),
  resourceIds: z.array(IdSchema).min(1),
});

export const WorkspaceNoteVisibilityResultSchema = z.strictObject({
  resourceIds: z.array(IdSchema),
});

export const WorkspaceNotePrivacyPendingRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  noteId: IdSchema.optional(),
});

export const WorkspaceNotePrivacyTransitionSchema = z.strictObject({
  id: z.string().min(1),
  workspaceId: IdSchema,
  noteId: IdSchema,
  resourceId: IdSchema,
  noteTitle: z.string(),
  actorUserId: IdSchema,
  createdAt: TimestampSchema,
});

export const WorkspaceNotePrivacyPendingResultSchema = z.strictObject({
  items: z.array(WorkspaceNotePrivacyTransitionSchema),
});

export const WorkspaceNotePrivacyMarkRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  transitionId: z.string().min(1),
  at: TimestampSchema,
});

export const WorkspaceNotePrivacyMarkResultSchema = z.strictObject({
  outcome: z.enum(["processed", "not_pending"]),
});

export const WorkspaceNoteDeletionOutboxRequestSchema = z.strictObject({
  workspaceId: IdSchema,
});

export const WorkspaceNoteDeletionOutboxSchema = z.strictObject({
  items: z.array(z.strictObject({
    resourceId: IdSchema,
    contentRef: z.string().nullable(),
    modelContentRef: z.string().nullable(),
  })),
});

export const WorkspaceNoteDeletionRetireRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  resourceId: IdSchema,
});

export const WorkspaceNoteDeletionRetireResultSchema = z.strictObject({
  outcome: z.enum(["retired", "not_found"]),
});

export type WorkspaceNoteAccess = z.infer<typeof WorkspaceNoteAccessSchema>;
export type WorkspaceNoteRecord = z.infer<typeof WorkspaceNoteRecordSchema>;
export type WorkspaceNoteSegmentRecord = z.infer<typeof WorkspaceNoteSegmentRecordSchema>;
export type WorkspaceNoteStateRequest = z.infer<typeof WorkspaceNoteStateRequestSchema>;
export type WorkspaceNoteState = z.infer<typeof WorkspaceNoteStateSchema>;
export type WorkspaceNoteUpdateRequest = z.infer<typeof WorkspaceNoteUpdateRequestSchema>;
export type WorkspaceNoteUpdateResult = z.infer<typeof WorkspaceNoteUpdateResultSchema>;
export type WorkspaceNoteArchiveRequest = z.infer<typeof WorkspaceNoteArchiveRequestSchema>;
export type WorkspaceNoteArchiveResult = z.infer<typeof WorkspaceNoteArchiveResultSchema>;
export type WorkspaceNoteSegmentAppendRequest = z.infer<typeof WorkspaceNoteSegmentAppendRequestSchema>;
export type WorkspaceNoteSegmentAppendResult = z.infer<typeof WorkspaceNoteSegmentAppendResultSchema>;
export type WorkspaceNoteGenerationCommitRequest = z.infer<typeof WorkspaceNoteGenerationCommitRequestSchema>;
export type WorkspaceNoteGenerationCommitResult = z.infer<typeof WorkspaceNoteGenerationCommitResultSchema>;
export type WorkspaceNoteSidebarRequest = z.infer<typeof WorkspaceNoteSidebarRequestSchema>;
export type WorkspaceNoteSidebarList = z.infer<typeof WorkspaceNoteSidebarListSchema>;
export type WorkspaceNoteVisibilityRequest = z.infer<typeof WorkspaceNoteVisibilityRequestSchema>;
export type WorkspaceNoteVisibilityResult = z.infer<typeof WorkspaceNoteVisibilityResultSchema>;
export type WorkspaceNotePrivacyPendingRequest = z.infer<typeof WorkspaceNotePrivacyPendingRequestSchema>;
export type WorkspaceNotePrivacyTransition = z.infer<typeof WorkspaceNotePrivacyTransitionSchema>;
export type WorkspaceNotePrivacyPendingResult = z.infer<typeof WorkspaceNotePrivacyPendingResultSchema>;
export type WorkspaceNotePrivacyMarkRequest = z.infer<typeof WorkspaceNotePrivacyMarkRequestSchema>;
export type WorkspaceNotePrivacyMarkResult = z.infer<typeof WorkspaceNotePrivacyMarkResultSchema>;
export type WorkspaceNoteDeletionOutboxRequest = z.infer<typeof WorkspaceNoteDeletionOutboxRequestSchema>;
export type WorkspaceNoteDeletionOutbox = z.infer<typeof WorkspaceNoteDeletionOutboxSchema>;
export type WorkspaceNoteDeletionRetireRequest = z.infer<typeof WorkspaceNoteDeletionRetireRequestSchema>;
export type WorkspaceNoteDeletionRetireResult = z.infer<typeof WorkspaceNoteDeletionRetireResultSchema>;
