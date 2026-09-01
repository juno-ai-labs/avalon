import type { NoteSummary, WorkstreamBatchFilter } from "@rally/contracts";

import { uuidV7 } from "../lib/uuid-v7";

import { boundParameterChunks } from "./bound-parameters";

import {
  NOTE_SIDEBAR_EXPOSABLE_IDS_SQL,
  NOTE_SIDEBAR_SQL,
  NoteSidebarRowSchema,
  SIDEBAR_LIST_LIMIT,
  toNoteSummary,
} from "../services/sidebar-reads";
import {
  WorkspaceNoteArchiveResultSchema,
  WorkspaceNoteDeletionOutboxSchema,
  WorkspaceNoteDeletionRetireResultSchema,
  WorkspaceNoteGenerationCommitResultSchema,
  WorkspaceNotePrivacyMarkResultSchema,
  WorkspaceNotePrivacyPendingResultSchema,
  WorkspaceNoteSegmentAppendResultSchema,
  WorkspaceNoteStateSchema,
  WorkspaceNoteUpdateResultSchema,
  WorkspaceNoteVisibilityResultSchema,
  type WorkspaceNoteAccess,
  type WorkspaceNoteArchiveRequest,
  type WorkspaceNoteArchiveResult,
  type WorkspaceNoteDeletionOutbox,
  type WorkspaceNoteDeletionRetireRequest,
  type WorkspaceNoteDeletionRetireResult,
  type WorkspaceNoteGenerationCommitRequest,
  type WorkspaceNoteGenerationCommitResult,
  type WorkspaceNotePrivacyMarkRequest,
  type WorkspaceNotePrivacyMarkResult,
  type WorkspaceNotePrivacyPendingRequest,
  type WorkspaceNotePrivacyPendingResult,
  type WorkspaceNoteRecord,
  type WorkspaceNoteSegmentAppendRequest,
  type WorkspaceNoteSegmentAppendResult,
  type WorkspaceNoteSegmentRecord,
  type WorkspaceNoteState,
  type WorkspaceNoteStateRequest,
  type WorkspaceNoteUpdateRequest,
  type WorkspaceNoteUpdateResult,
  type WorkspaceNoteVisibilityRequest,
  type WorkspaceNoteVisibilityResult,
} from "./workspace-notes-protocol";

/**
 * How many outbox rows one maintenance pass takes. Carried over verbatim from
 * the passes this SQL moved out of; the alarm reads the retired count as
 * progress and comes straight back for the rest of a larger backlog.
 */
const NOTE_PRIVACY_PASS_LIMIT = 50;
const NOTE_DELETION_PASS_LIMIT = 100;

const NOTE_COLUMNS = `id, workspace_id, owner_user_id, resource_id, scope, title,
       recording_status, manual_notes_markdown, live_notes_markdown,
       notes_through_sequence, recorded_ms, started_at, ended_at, generated_at,
       last_activity_at, created_at, updated_at, archived_at`;

const SEGMENT_COLUMNS = `id, note_id, sequence_number, start_offset_ms, end_offset_ms,
       captured_at, speaker_label, text_content, created_at`;

interface NoteRow extends Record<string, SqlStorageValue> {
  id: string;
  workspace_id: string;
  owner_user_id: string;
  resource_id: string;
  scope: string;
  title: string;
  recording_status: string;
  manual_notes_markdown: string;
  live_notes_markdown: string;
  notes_through_sequence: number;
  recorded_ms: number;
  started_at: string | null;
  ended_at: string | null;
  generated_at: string | null;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface SegmentRow extends Record<string, SqlStorageValue> {
  id: string;
  note_id: string;
  sequence_number: number;
  start_offset_ms: number;
  end_offset_ms: number;
  captured_at: string;
  speaker_label: string | null;
  text_content: string;
  created_at: string;
}

function noteRecord(row: NoteRow): WorkspaceNoteRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ownerUserId: row.owner_user_id,
    resourceId: row.resource_id,
    scope: row.scope as WorkspaceNoteRecord["scope"],
    title: row.title,
    recordingStatus: row.recording_status as WorkspaceNoteRecord["recordingStatus"],
    manualNotesMarkdown: row.manual_notes_markdown,
    liveNotesMarkdown: row.live_notes_markdown,
    notesThroughSequence: row.notes_through_sequence,
    recordedMs: row.recorded_ms,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    generatedAt: row.generated_at,
    lastActivityAt: row.last_activity_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function segmentRecord(row: SegmentRow): WorkspaceNoteSegmentRecord {
  return {
    id: row.id,
    noteId: row.note_id,
    sequenceNumber: row.sequence_number,
    startOffsetMs: row.start_offset_ms,
    endOffsetMs: row.end_offset_ms,
    capturedAt: row.captured_at,
    speakerLabel: row.speaker_label,
    text: row.text_content,
    createdAt: row.created_at,
  };
}

/**
 * The one read guard, per access mode. `view` and `edit` are the fences every
 * statement in the service used to restate; `any` is bare existence, which the
 * idempotent create endpoint checks before the read guard decides what the
 * caller learns about the id.
 */
function readNoteRow(
  storage: DurableObjectStorage,
  workspaceId: string,
  noteId: string,
  userId: string | null,
  access: WorkspaceNoteAccess,
): NoteRow | undefined {
  const fence = access === "any"
    ? ""
    : access === "view"
      ? ` AND archived_at IS NULL AND (scope = 'workspace' OR owner_user_id = ?)`
      : ` AND archived_at IS NULL AND owner_user_id = ?`;
  return storage.sql.exec<NoteRow>(
    `SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ? AND workspace_id = ?${fence}`,
    ...(access === "any" ? [noteId, workspaceId] : [noteId, workspaceId, userId]),
  ).toArray()[0];
}

function noteSegments(storage: DurableObjectStorage, noteId: string): WorkspaceNoteSegmentRecord[] {
  return storage.sql.exec<SegmentRow>(
    `SELECT ${SEGMENT_COLUMNS} FROM note_transcript_segments
      WHERE note_id = ? ORDER BY sequence_number ASC`,
    noteId,
  ).toArray().map(segmentRecord);
}

/**
 * The pushed sidebar's change counter, advanced in the same transaction as the
 * write that earns it — a counter that can lag its own write makes the next
 * push arrive as a duplicate and be dropped. `executeRuntimeSql` does this for
 * facade writes; a typed method that writes `notes` does it here.
 */
function advanceNoteSidebar(storage: DurableObjectStorage): void {
  storage.sql.exec(
    `UPDATE workspace_sidebar_list_state SET waterline = waterline + 1 WHERE list = 'notes'`,
  );
}

/** The note and its whole transcript in one read. */
export function workspaceNoteState(
  storage: DurableObjectStorage,
  request: WorkspaceNoteStateRequest,
): WorkspaceNoteState {
  const row = readNoteRow(storage, request.workspaceId, request.noteId, request.userId, request.access);
  // `any` answers only existence, for the idempotent create endpoint; the
  // caller re-reads under the view guard before showing anything, so shipping
  // the transcript here doubled the payload of every existing-note open.
  return WorkspaceNoteStateSchema.parse({
    note: row ? noteRecord(row) : null,
    segments: row && request.access !== "any" ? noteSegments(storage, request.noteId) : [],
  });
}

/** The sidebar list, from the same statement the workspace socket serves. */
export function workspaceNoteSidebar(
  storage: DurableObjectStorage,
  workspaceId: string,
  userId: string,
  limit: number,
): NoteSummary[] {
  return storage.sql.exec<Record<string, SqlStorageValue>>(
    NOTE_SIDEBAR_SQL,
    workspaceId,
    userId,
    limit,
  ).toArray().map((row) => toNoteSummary(NoteSidebarRowSchema.parse(row)));
}

/**
 * Apply the fields the caller sent, and decide `becamePrivate` from the row
 * the write actually replaced.
 *
 * When a workspace note goes personal this also writes the
 * `note_privacy_change_outbox` row, in the same transaction as the scope
 * change. In D1 a trigger did that; the trigger did not travel to the object
 * at cutover, so the transition has been recorded nowhere and the "now
 * private" notices silently stopped. An outbox row the write cannot lose is
 * the point of the outbox.
 */
export function updateWorkspaceNote(
  storage: DurableObjectStorage,
  request: WorkspaceNoteUpdateRequest,
): WorkspaceNoteUpdateResult {
  return storage.transactionSync(() => {
    const existing = readNoteRow(storage, request.workspaceId, request.noteId, request.userId, "edit");
    if (!existing) {
      return WorkspaceNoteUpdateResultSchema.parse({ outcome: "not_found", becamePrivate: false });
    }
    const assignments: string[] = [];
    const bindings: (string | number | null)[] = [];
    if (request.title !== undefined) {
      assignments.push("title = ?");
      bindings.push(request.title);
    }
    if (request.manualNotesMarkdown !== undefined) {
      assignments.push("manual_notes_markdown = ?");
      bindings.push(request.manualNotesMarkdown);
    }
    if (request.scope !== undefined) {
      assignments.push("scope = ?", "privacy_changed_by_user_id = ?");
      bindings.push(request.scope, request.userId);
    }
    if (request.recordingStatus !== undefined) {
      assignments.push("recording_status = ?");
      bindings.push(request.recordingStatus);
    }
    if (request.recordedMs !== undefined) {
      assignments.push("recorded_ms = ?");
      bindings.push(request.recordedMs);
    }
    if ("startedAt" in request) {
      assignments.push("started_at = ?");
      bindings.push(request.startedAt ?? null);
    }
    if ("endedAt" in request) {
      assignments.push("ended_at = ?");
      bindings.push(request.endedAt ?? null);
    }
    assignments.push("last_activity_at = ?", "updated_at = ?");
    bindings.push(request.at, request.at);
    storage.sql.exec(
      `UPDATE notes SET ${assignments.join(", ")} WHERE id = ? AND workspace_id = ?`,
      ...bindings,
      request.noteId,
      request.workspaceId,
    );
    const becamePrivate = existing.scope === "workspace" && request.scope === "personal";
    if (becamePrivate) {
      storage.sql.exec(
        `INSERT INTO note_privacy_change_outbox
           (id, workspace_id, note_id, resource_id, note_title, actor_user_id, created_at, processed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        uuidV7(),
        request.workspaceId,
        request.noteId,
        existing.resource_id,
        request.title ?? existing.title,
        request.userId,
        request.at,
      );
    }
    advanceNoteSidebar(storage);
    return WorkspaceNoteUpdateResultSchema.parse({ outcome: "updated", becamePrivate });
  });
}

/**
 * Archive, refuse a live recording, or say the note is not the caller's to
 * touch — one decision. Archiving underneath a live meeting window would 404
 * its next segment save while capture kept running, losing the rest of the
 * transcript, which is why `recording` refuses distinctly.
 */
export function archiveWorkspaceNote(
  storage: DurableObjectStorage,
  request: WorkspaceNoteArchiveRequest,
): WorkspaceNoteArchiveResult {
  return storage.transactionSync(() => {
    const existing = readNoteRow(storage, request.workspaceId, request.noteId, request.userId, "edit");
    if (!existing) return WorkspaceNoteArchiveResultSchema.parse({ outcome: "not_found" });
    if (existing.recording_status === "recording") {
      return WorkspaceNoteArchiveResultSchema.parse({ outcome: "recording" });
    }

    storage.sql.exec(
      `UPDATE notes SET archived_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`,
      request.at,
      request.at,
      request.noteId,
      request.workspaceId,
    );
    advanceNoteSidebar(storage);
    return WorkspaceNoteArchiveResultSchema.parse({ outcome: "archived" });
  });
}

/**
 * The one selection a grouping's **Archive all** makes over notes.
 *
 * Three fences beyond the range, and each of them is a note the single-row
 * archive would refuse rather than one this is being cautious about:
 * `owner_user_id` because only an owner may archive a note, so a colleague's
 * workspace note sits in the reader's sidebar under the same heading and is
 * still not theirs to retire; `recording_status` because archiving under a
 * live meeting window 404s the next segment save while capture keeps running;
 * and `archived_at` because an already-archived note is not in the group.
 *
 * The fourth fence is the sidebar's own window. The list is capped at
 * `SIDEBAR_LIST_LIMIT` and notes have no cursor anywhere in the product, so
 * beyond it they are unreachable rather than merely unloaded — and an archive
 * cannot be undone. `NOTE_SIDEBAR_EXPOSABLE_IDS_SQL` holds the ordering and
 * visibility that decide which notes those are; the work-stream half is
 * deliberately *not* fenced this way, because it pages.
 *
 * The preview counts this same selection, so the number in the confirmation is
 * the number of notes that will actually go.
 */
const NOTE_BATCH_SELECTION_FENCE = `workspace_id = ? AND archived_at IS NULL
      AND owner_user_id = ?
      AND recording_status != 'recording'
      AND (? IS NULL OR last_activity_at >= ?)
      AND (? IS NULL OR last_activity_at < ?)
      AND id IN (${NOTE_SIDEBAR_EXPOSABLE_IDS_SQL})`;

/**
 * `notes.last_activity_at` is an ISO string written by the server's own clock,
 * so the range is compared as text — and text comparison is only correct while
 * both sides are the same canonical UTC spelling. The filter's timestamps come
 * off the wire, where an offset is a legal way to write the same instant, so
 * they are re-spelled here rather than trusted to sort.
 *
 * Deliberately without a fallback for a value that will not parse. The filter
 * is schema-validated as a datetime before it reaches this object, so there is
 * none; and were that ever to change, `toISOString` throwing is the failure to
 * want — treating an unreadable bound as "no bound" would quietly widen an
 * archive rather than refuse it.
 */
function noteRangeBound(value: string | undefined): string | null {
  return value === undefined ? null : new Date(Date.parse(value)).toISOString();
}

function noteBatchBindings(
  workspaceId: string,
  userId: string,
  filter: WorkstreamBatchFilter,
): (string | number | null)[] {
  const atOrAfter = noteRangeBound(filter.lastActivityAt?.atOrAfter);
  const before = noteRangeBound(filter.lastActivityAt?.before);
  return [
    workspaceId,
    userId,
    atOrAfter,
    atOrAfter,
    before,
    before,
    // The window subquery's own three, in its own order.
    workspaceId,
    userId,
    SIDEBAR_LIST_LIMIT,
  ];
}

/**
 * A note is never pinned, so a filter asking only for pinned rows asks for no
 * notes at all — said once here rather than as a SQL clause that could only
 * ever compare a constant against itself.
 */
function noteBatchExcluded(filter: WorkstreamBatchFilter): boolean {
  return filter.pinned === true;
}

/** Which notes one grouping's archive would take, for the confirmation's count. */
export function workspaceNoteBatchTargets(
  storage: DurableObjectStorage,
  workspaceId: string,
  userId: string,
  filter: WorkstreamBatchFilter,
): string[] {
  if (noteBatchExcluded(filter)) return [];
  return storage.sql.exec<{ id: string }>(
    `SELECT id FROM notes WHERE ${NOTE_BATCH_SELECTION_FENCE} ORDER BY id`,
    ...noteBatchBindings(workspaceId, userId, filter),
  ).toArray().map((row) => row.id);
}

/**
 * Archive every note the filter selects, and say which ones went.
 *
 * One statement rather than a read followed by a loop of single-row archives:
 * the rows are all in this database, so the whole group is one transition, and
 * a partially applied "archive all" is a state nobody asked for. The archived
 * ids come back from the statement itself — `rowsWritten` counts physical
 * writes, index maintenance included, and would overstate the group the moment
 * `notes_sidebar_idx` is touched.
 */
export function archiveWorkspaceNotesInRange(
  storage: DurableObjectStorage,
  request: { workspaceId: string; userId: string; filter: WorkstreamBatchFilter; at: string },
): string[] {
  if (noteBatchExcluded(request.filter)) return [];
  const archived = storage.sql.exec<{ id: string }>(
    `UPDATE notes SET archived_at = ?, updated_at = ?
      WHERE ${NOTE_BATCH_SELECTION_FENCE}
      RETURNING id`,
    request.at,
    request.at,
    ...noteBatchBindings(request.workspaceId, request.userId, request.filter),
  ).toArray().map((row) => row.id).sort();
  if (archived.length > 0) advanceNoteSidebar(storage);
  return archived;
}

/**
 * Store one transcript segment: the owner fence, the duplicate check, the
 * sequence allocation, the insert and the recorded-time bump are one critical
 * section. As facade statements they were five round trips, so a replayed
 * save racing itself allocated a number, hit `UNIQUE (note_id,
 * client_segment_id)`, and needed a compensating re-read to answer at all.
 */
export function appendWorkspaceNoteSegment(
  storage: DurableObjectStorage,
  request: WorkspaceNoteSegmentAppendRequest,
): WorkspaceNoteSegmentAppendResult {
  return storage.transactionSync(() => {
    const note = readNoteRow(storage, request.workspaceId, request.noteId, request.userId, "edit");
    if (!note) {
      return WorkspaceNoteSegmentAppendResultSchema.parse({ outcome: "note_not_found", segment: null });
    }
    const duplicate = storage.sql.exec<SegmentRow>(
      `SELECT ${SEGMENT_COLUMNS} FROM note_transcript_segments
        WHERE note_id = ? AND client_segment_id = ?`,
      request.noteId,
      request.clientSegmentId,
    ).toArray()[0];
    if (duplicate) {
      return WorkspaceNoteSegmentAppendResultSchema.parse({
        outcome: "duplicate",
        segment: segmentRecord(duplicate),
      });
    }
    const allocated = storage.sql.exec<{ sequence_number: number }>(
      `UPDATE notes SET next_segment_sequence = next_segment_sequence + 1,
              recorded_ms = MAX(recorded_ms, ?), last_activity_at = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ?
        RETURNING next_segment_sequence - 1 AS sequence_number`,
      request.endOffsetMs,
      request.at,
      request.at,
      request.noteId,
      request.workspaceId,
    ).toArray()[0];
    if (!allocated) throw new Error("note_segment_sequence_allocation_failed");
    const stored = storage.sql.exec<SegmentRow>(
      `INSERT INTO note_transcript_segments
         (id, note_id, client_segment_id, sequence_number, start_offset_ms,
          end_offset_ms, captured_at, speaker_label, text_content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING ${SEGMENT_COLUMNS}`,
      request.segmentId,
      request.noteId,
      request.clientSegmentId,
      allocated.sequence_number,
      request.startOffsetMs,
      request.endOffsetMs,
      request.capturedAt,
      request.speakerLabel,
      request.text,
      request.at,
    ).toArray()[0];
    if (!stored) throw new Error("note_segment_write_failed");
    advanceNoteSidebar(storage);
    return WorkspaceNoteSegmentAppendResultSchema.parse({
      outcome: "appended",
      segment: segmentRecord(stored),
    });
  });
}

/**
 * Land a generated briefing only if the cursor pair the caller read before
 * inference still holds; a stale result is refused rather than rewinding the
 * cursor or overwriting newer notes. The returned row is the witness — the
 * physical write counter cannot say which transition won.
 */
export function commitWorkspaceNoteGeneration(
  storage: DurableObjectStorage,
  request: WorkspaceNoteGenerationCommitRequest,
): WorkspaceNoteGenerationCommitResult {
  return storage.transactionSync(() => {
    const committed = storage.sql.exec<{ id: string }>(
      `UPDATE notes
          SET live_notes_markdown = ?, notes_through_sequence = ?, generated_at = ?,
              last_activity_at = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND owner_user_id = ?
          AND notes_through_sequence = ?
          AND ((generated_at IS NULL AND ? IS NULL) OR generated_at = ?)
        RETURNING id`,
      request.liveNotesMarkdown,
      request.throughSequence,
      request.generatedAt,
      request.generatedAt,
      request.generatedAt,
      request.noteId,
      request.workspaceId,
      request.userId,
      request.expectedThroughSequence,
      request.expectedGeneratedAt,
      request.expectedGeneratedAt,
    ).toArray()[0];
    if (committed?.id !== request.noteId) {
      return WorkspaceNoteGenerationCommitResultSchema.parse({ outcome: "stale" });
    }
    advanceNoteSidebar(storage);
    return WorkspaceNoteGenerationCommitResultSchema.parse({ outcome: "committed" });
  });
}

/**
 * Which of these note resources this principal may currently see.
 *
 * Chunked because the engine refuses a statement with more than 100 bound
 * parameters, and the Terminal revoked-import fence forwards every imported
 * note id in one call — unchunked, a generation with enough notes turned that
 * security check into a thrown SQLITE_ERROR instead of an answer. The chunk
 * size leaves room for the two scalars bound beside each id run.
 */
export function visibleWorkspaceNoteResourceIds(
  storage: DurableObjectStorage,
  request: WorkspaceNoteVisibilityRequest,
): WorkspaceNoteVisibilityResult {
  const resourceIds = boundParameterChunks(request.resourceIds).flatMap((ids) => {
    const placeholders = ids.map(() => "?").join(", ");
    return storage.sql.exec<{ resource_id: string }>(
      `SELECT resource_id FROM notes
        WHERE workspace_id = ? AND resource_id IN (${placeholders})
          AND archived_at IS NULL AND (scope = 'workspace' OR owner_user_id = ?)`,
      request.workspaceId,
      ...ids,
      request.userId,
    ).toArray().map((row) => row.resource_id);
  });
  return WorkspaceNoteVisibilityResultSchema.parse({ resourceIds });
}

/** The oldest unprocessed privacy transitions, one pass's worth. */
export function pendingWorkspaceNotePrivacyTransitions(
  storage: DurableObjectStorage,
  request: WorkspaceNotePrivacyPendingRequest,
): WorkspaceNotePrivacyPendingResult {
  const filter = request.noteId === undefined ? "" : " AND note_id = ?";
  const rows = storage.sql.exec<{
    id: string;
    workspace_id: string;
    note_id: string;
    resource_id: string;
    note_title: string;
    actor_user_id: string;
    created_at: string;
  }>(
    `SELECT id, workspace_id, note_id, resource_id, note_title, actor_user_id, created_at
       FROM note_privacy_change_outbox
      WHERE processed_at IS NULL${filter}
      ORDER BY created_at ASC LIMIT ${NOTE_PRIVACY_PASS_LIMIT}`,
    ...(request.noteId === undefined ? [] : [request.noteId]),
  ).toArray();
  return WorkspaceNotePrivacyPendingResultSchema.parse({
    items: rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      noteId: row.note_id,
      resourceId: row.resource_id,
      noteTitle: row.note_title,
      actorUserId: row.actor_user_id,
      createdAt: row.created_at,
    })),
  });
}

/** Settle one transition; a second attempt learns it was not pending. */
export function markWorkspaceNotePrivacyTransitionProcessed(
  storage: DurableObjectStorage,
  request: WorkspaceNotePrivacyMarkRequest,
): WorkspaceNotePrivacyMarkResult {
  const marked = storage.sql.exec<{ id: string }>(
    `UPDATE note_privacy_change_outbox SET processed_at = ?
      WHERE id = ? AND processed_at IS NULL
      RETURNING id`,
    request.at,
    request.transitionId,
  ).toArray()[0];
  return WorkspaceNotePrivacyMarkResultSchema.parse({
    outcome: marked?.id === request.transitionId ? "processed" : "not_pending",
  });
}

/** The oldest deletion-outbox entries, one cleanup pass's worth. */
export function workspaceNoteResourceDeletionOutbox(
  storage: DurableObjectStorage,
): WorkspaceNoteDeletionOutbox {
  const rows = storage.sql.exec<{
    resource_id: string;
    content_ref: string | null;
    model_content_ref: string | null;
  }>(
    `SELECT resource_id, content_ref, model_content_ref
       FROM note_resource_deletion_outbox
      ORDER BY created_at ASC LIMIT ${NOTE_DELETION_PASS_LIMIT}`,
  ).toArray();
  return WorkspaceNoteDeletionOutboxSchema.parse({
    items: rows.map((row) => ({
      resourceId: row.resource_id,
      contentRef: row.content_ref,
      modelContentRef: row.model_content_ref,
    })),
  });
}

/** Retire one entry after its R2 objects are gone; the returned id is the witness. */
export function retireWorkspaceNoteResourceDeletion(
  storage: DurableObjectStorage,
  request: WorkspaceNoteDeletionRetireRequest,
): WorkspaceNoteDeletionRetireResult {
  const retired = storage.sql.exec<{ resource_id: string }>(
    `DELETE FROM note_resource_deletion_outbox WHERE resource_id = ? RETURNING resource_id`,
    request.resourceId,
  ).toArray()[0];
  return WorkspaceNoteDeletionRetireResultSchema.parse({
    outcome: retired?.resource_id === request.resourceId ? "retired" : "not_found",
  });
}
