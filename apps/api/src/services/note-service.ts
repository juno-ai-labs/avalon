import { newId, nowIso } from "@rally/db";
import { z } from "zod";
import type {
  AppendNoteTranscriptSegmentRequest,
  CreateNoteRequest,
  NoteDetail,
  NoteSummary,
  NoteTranscriptSegment,
  UpdateNoteRequest,
} from "@rally/contracts";
import type { AuthContext, Env } from "../env";
import { ApiError, isConstraintError } from "../lib/api-error";
import { sha256Hex } from "../lib/crypto";
import { logWarn } from "../observability/logger";
import { MeetingNotesService } from "./meeting-notes-service";
import { processPendingNotePrivacyNotifications } from "./note-privacy-notification-service";
import {
  emitProductUsageTelemetry,
  telemetryCountBucket,
  telemetryJourneyDuration,
} from "../telemetry/product-usage";
import { withWorkspaceRuntimeDatabase } from "./workspace-runtime-database";
import {
  NOTE_SIDEBAR_SQL,
  SIDEBAR_LIST_LIMIT,
  toNoteSummary,
} from "./sidebar-reads";

const MAX_NOTES_CONTEXT_CHARACTERS = 50_000;
const MAX_TRANSCRIPT_CONTEXT_CHARACTERS = 400_000;
const MAX_RECENT_TRANSCRIPT_CHARACTERS = 100_000;
const RECENT_TRANSCRIPT_WINDOW_MS = 10 * 60 * 1_000;
const OMITTED_CONTEXT_MARKER = "\n\n[… middle content omitted to fit model context …]\n\n";

type MeetingNotesGenerator = Pick<MeetingNotesService, "generate">;

/**
 * Row contracts for the `notes` reads.
 *
 * These were interfaces handed to `first<NoteRow>()`, which is a cast rather
 * than a check — the shape was asserted, never confirmed. The enums and bounds
 * below are the columns' own CHECK constraints, so a row that fails one is a row
 * that should not exist, and the failure names the column instead of travelling
 * on to be rejected by the response schema as an anonymous 500.
 */
const NoteRowSchema = z.object({
  id: z.string().min(1),
  workspace_id: z.string().min(1),
  owner_user_id: z.string().min(1),
  resource_id: z.string().min(1),
  scope: z.enum(["personal", "workspace"]),
  title: z.string(),
  recording_status: z.enum(["idle", "recording", "complete"]),
  manual_notes_markdown: z.string(),
  live_notes_markdown: z.string(),
  notes_through_sequence: z.number().int().nonnegative(),
  recorded_ms: z.number().int().nonnegative(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  generated_at: z.string().nullable(),
  last_activity_at: z.string().min(1),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  archived_at: z.string().nullable(),
});
type NoteRow = z.infer<typeof NoteRowSchema>;

const SegmentRowSchema = z.object({
  id: z.string().min(1),
  note_id: z.string().min(1),
  sequence_number: z.number().int().min(1),
  start_offset_ms: z.number().int().nonnegative(),
  end_offset_ms: z.number().int().nonnegative(),
  captured_at: z.string().min(1),
  speaker_label: z.string().nullable(),
  text_content: z.string(),
  created_at: z.string().min(1),
});
type SegmentRow = z.infer<typeof SegmentRowSchema>;

/** Exposed so a test can hold the contracts against real rows. */
export const noteRowSchemas = { notes: NoteRowSchema, segments: SegmentRowSchema } as const;

const NOTE_SELECT = `SELECT * FROM notes
  WHERE id = ? AND workspace_id = ? AND archived_at IS NULL
    AND (scope = 'workspace' OR owner_user_id = ?)`;

export class NoteService {
  private readonly meetingNotesGenerator: MeetingNotesGenerator;
  private readonly env: Env;
  private readonly auth: AuthContext;

  constructor(
    env: Env,
    auth: AuthContext,
    meetingNotesGenerator?: MeetingNotesGenerator,
  ) {
    this.env = withWorkspaceRuntimeDatabase(env, auth.workspaceId);
    this.auth = auth;
    this.meetingNotesGenerator = meetingNotesGenerator ?? new MeetingNotesService(this.env, auth);
  }

  /** Shares its statement and row mapping with the sidebar's socket batch. */
  async list(limit: number): Promise<{ items: NoteSummary[] }> {
    const result = await this.env.DB.prepare(NOTE_SIDEBAR_SQL)
      .bind(
        this.auth.workspaceId,
        this.auth.userId,
        Math.min(Math.max(limit, 1), SIDEBAR_LIST_LIMIT),
      ).all<NoteRow>();
    return { items: (result.results ?? []).map(toNoteSummary) };
  }

  async create(input: CreateNoteRequest): Promise<NoteDetail> {
    const existing = await this.env.DB.prepare(
      "SELECT * FROM notes WHERE id = ? AND workspace_id = ?",
    ).bind(input.id, this.auth.workspaceId).first<NoteRow>();
    if (existing) {
      // Opening a note uses the same idempotent endpoint as creating it. The
      // normal read guard keeps private IDs opaque while allowing workspace
      // notes to open for other members.
      return this.get(input.id);
    }
    const resourceId = newId();
    const at = nowIso();
    const plain = plainNoteMarkdown(input.title, "", "", []);
    const model = modelNoteMarkdown(input.title, "", "", []);
    const [contentSha256, modelSha256] = await Promise.all([sha256Hex(plain), sha256Hex(model)]);
    const refs = this.resourceRefs(resourceId, contentSha256, modelSha256);
    try {
      await this.putResourceObjects(refs, plain, model);
      await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO resources
           (id, workspace_id, resource_type, provider, provider_resource_id, title,
            mime_type, content_ref, content_sha256, metadata_json, last_hydrated_at,
            uploaded_by_user_id, attachment_status, model_content_ref, model_mime_type,
            model_content_sha256, model_content_status, model_content_extractor_version,
            model_content_character_count, model_content_extracted_at, created_at, updated_at)
           VALUES (?, ?, 'note', 'avalon_note', ?, ?, 'text/markdown; charset=utf-8', ?, ?, ?, ?, ?,
             'attached', ?, 'text/markdown; charset=utf-8', ?, 'ready', 'avalon-note-v1', ?, ?, ?, ?)`,
        ).bind(
          resourceId,
          this.auth.workspaceId,
          input.id,
          input.title,
          refs.content,
          contentSha256,
          JSON.stringify({ noteId: input.id, ownerUserId: this.auth.userId, scope: input.scope, size: byteLength(plain) }),
          at,
          this.auth.userId,
          refs.model,
          modelSha256,
          model.length,
          at,
          at,
          at,
        ),
        this.env.DB.prepare(
          `INSERT INTO notes
           (id, workspace_id, owner_user_id, resource_id, scope, title,
            last_activity_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(input.id, this.auth.workspaceId, this.auth.userId, resourceId, input.scope, input.title, at, at, at),
      ]);
    } catch (error) {
      await Promise.all([
        this.env.PAYLOADS.delete(refs.content).catch(() => undefined),
        this.env.PAYLOADS.delete(refs.model).catch(() => undefined),
      ]);
      throw error;
    }
    return this.get(input.id);
  }

  async get(id: string): Promise<NoteDetail> {
    const note = await this.requireNote(id, false);
    const segments = await this.loadSegments(id);
    return toNoteDetail(note, segments);
  }

  async update(id: string, input: UpdateNoteRequest): Promise<NoteDetail> {
    const existing = await this.requireNote(id, true);
    const becamePrivate = existing.scope === "workspace" && input.scope === "personal";
    const assignments: string[] = [];
    const bindings: unknown[] = [];
    if (input.title !== undefined) {
      assignments.push("title = ?");
      bindings.push(input.title);
    }
    if (input.manualNotes !== undefined) {
      assignments.push("manual_notes_markdown = ?");
      bindings.push(input.manualNotes);
    }
    if (input.scope !== undefined) {
      assignments.push("scope = ?", "privacy_changed_by_user_id = ?");
      bindings.push(input.scope, this.auth.userId);
    }
    if (input.recordingStatus !== undefined) {
      assignments.push("recording_status = ?");
      bindings.push(input.recordingStatus);
    }
    if (input.recordedMs !== undefined) {
      assignments.push("recorded_ms = ?");
      bindings.push(input.recordedMs);
    }
    if ("startedAt" in input) {
      assignments.push("started_at = ?");
      bindings.push(input.startedAt ?? null);
    }
    if ("endedAt" in input) {
      assignments.push("ended_at = ?");
      bindings.push(input.endedAt ?? null);
    }
    const at = nowIso();
    assignments.push("last_activity_at = ?", "updated_at = ?");
    bindings.push(at, at, id, this.auth.workspaceId, this.auth.userId);
    const result = await this.env.DB.prepare(
      `UPDATE notes SET ${assignments.join(", ")}
       WHERE id = ? AND workspace_id = ? AND owner_user_id = ? AND archived_at IS NULL`,
    ).bind(...bindings).run();
    if (!result.meta.changes) throw new ApiError(404, "note_not_found", "Note not found");
    await this.materialize(id);
    if (becamePrivate) {
      await processPendingNotePrivacyNotifications(this.env, { noteId: id }).catch((error: unknown) => {
        logWarn(this.env, "note_privacy_notification_deferred", {
          note_id: id,
          reason: error instanceof Error ? error.message : "unknown notification error",
        });
      });
    }
    return this.get(id);
  }

  /** Hides a note from the sidebar, its resource from every listing, and the
   * agent context that reads it, without destroying the transcript. Only the
   * owner may archive: a workspace note stays readable to the rest of the
   * members, and the read guard already keeps a private id opaque. */
  async archive(id: string): Promise<void> {
    const at = nowIso();
    const result = await this.env.DB.prepare(
      `UPDATE notes SET archived_at = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND owner_user_id = ? AND archived_at IS NULL
         AND recording_status != 'recording'`,
    ).bind(at, at, id, this.auth.workspaceId, this.auth.userId).run();
    if (result.meta.changes) return;
    // The write is the authorization, so nothing was read before it. A miss is
    // usually a note this user cannot archive, but it is also how an active
    // recording refuses, and those two owe the caller different answers. This
    // read throws the 404 for every other cause; reaching past it means the row
    // is present, owned, and unarchived, so recording is what stopped the write.
    // Archiving underneath a live meeting window would 404 its next segment
    // save while capture kept running, losing the rest of the transcript.
    await this.requireNote(id, true);
    throw new ApiError(
      409,
      "note_recording",
      "This note is still recording. End the recording before archiving it.",
    );
  }

  async appendSegment(id: string, input: AppendNoteTranscriptSegmentRequest): Promise<NoteTranscriptSegment> {
    await this.requireNote(id, true);
    const duplicate = await this.env.DB.prepare(
      `SELECT * FROM note_transcript_segments
       WHERE note_id = ? AND client_segment_id = ?`,
    ).bind(id, input.clientSegmentId).first<SegmentRow>();
    if (duplicate) {
      await this.materialize(id);
      return toSegment(duplicate);
    }

    const allocation = await this.env.DB.prepare(
      `UPDATE notes SET next_segment_sequence = next_segment_sequence + 1
       WHERE id = ? AND workspace_id = ? AND owner_user_id = ? AND archived_at IS NULL
       RETURNING next_segment_sequence - 1 AS sequence_number`,
    ).bind(id, this.auth.workspaceId, this.auth.userId).first<{ sequence_number: number }>();
    if (!allocation) throw new ApiError(404, "note_not_found", "Note not found");

    const segmentId = newId();
    const at = nowIso();
    try {
      await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO note_transcript_segments
           (id, note_id, client_segment_id, sequence_number, start_offset_ms,
            end_offset_ms, captured_at, speaker_label, text_content, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          segmentId,
          id,
          input.clientSegmentId,
          allocation.sequence_number,
          input.startOffsetMs,
          input.endOffsetMs,
          input.capturedAt,
          input.speakerLabel,
          input.text,
          at,
        ),
        this.env.DB.prepare(
          `UPDATE notes
           SET recorded_ms = MAX(recorded_ms, ?), last_activity_at = ?, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND owner_user_id = ?`,
        ).bind(input.endOffsetMs, at, at, id, this.auth.workspaceId, this.auth.userId),
      ]);
    } catch (error) {
      if (!isConstraintError(error)) throw error;
      const raced = await this.env.DB.prepare(
        `SELECT * FROM note_transcript_segments
         WHERE note_id = ? AND client_segment_id = ?`,
      ).bind(id, input.clientSegmentId).first<SegmentRow>();
      if (!raced) throw error;
      await this.materialize(id);
      return toSegment(raced);
    }
    await this.materialize(id);
    const created = await this.env.DB.prepare(
      "SELECT * FROM note_transcript_segments WHERE id = ? AND note_id = ?",
    ).bind(segmentId, id).first<SegmentRow>();
    if (!created) throw new ApiError(500, "note_segment_write_failed", "The transcript segment could not be stored");
    return toSegment(created);
  }

  async generate(
    id: string,
    requestId: string,
    mode: "live" | "final" = "live",
    transcriptStatus: "complete" | "partial" = mode === "final" ? "complete" : "partial",
    /** The cadence the client is keeping, when it knows it. */
    refreshSeconds: number | null = null,
  ): Promise<NoteDetail> {
    return this.generateAttempt(id, requestId, mode, transcriptStatus, refreshSeconds, false);
  }

  private async generateAttempt(
    id: string,
    requestId: string,
    mode: "live" | "final",
    transcriptStatus: "complete" | "partial",
    refreshSeconds: number | null,
    retriedFinalConflict: boolean,
  ): Promise<NoteDetail> {
    const note = await this.requireNote(id, true);
    const startingSequence = Number(note.notes_through_sequence);
    const rows = await this.env.DB.prepare(
      `SELECT * FROM note_transcript_segments
       WHERE note_id = ?
       ORDER BY sequence_number ASC`,
    ).bind(id).all<SegmentRow>();
    const allSegments = rows.results ?? [];
    const pending = allSegments.filter((segment) => Number(segment.sequence_number) > startingSequence);
    if (allSegments.length === 0 || (mode === "live" && pending.length === 0)) {
      await this.materialize(id);
      return this.get(id);
    }
    const completeTranscript = boundedTranscript(allSegments, MAX_TRANSCRIPT_CONTEXT_CHARACTERS);

    const telemetryStartedAt = Date.now();
    const actualTranscriptStatus = completeTranscript.omitted ? "partial" as const : transcriptStatus;
    const refreshCadence = mode === "final" || refreshSeconds === null
      ? "disabled" as const
      : refreshSeconds === 60 ? "one_minute" as const
        : refreshSeconds === 120 ? "two_minutes" as const
          : refreshSeconds === 300 ? "five_minutes" as const : "custom" as const;
    let generated: Awaited<ReturnType<MeetingNotesGenerator["generate"]>>;
    try {
      generated = await this.meetingNotesGenerator.generate({
        mode,
        meetingTitle: note.title,
        previousNotes: mode === "live" ? elideMiddle(note.live_notes_markdown.trim(), MAX_NOTES_CONTEXT_CHARACTERS) : "",
        userNotes: note.manual_notes_markdown,
        transcript: completeTranscript.transcript,
        recentTranscript: mode === "live" ? recentTranscriptContext(allSegments) : "",
        startedAt: note.started_at,
        endedAt: mode === "final" ? note.ended_at ?? nowIso() : note.ended_at,
        transcriptStatus: actualTranscriptStatus,
        refreshSeconds: mode === "live" ? refreshSeconds : null,
      }, requestId, `meeting-notes:${id}:loop`);
      await emitProductUsageTelemetry(this.env, {
        workspaceId: this.auth.workspaceId,
        userId: this.auth.userId,
        name: "note_summary_generation_completed",
        properties: {
          noteId: id,
          mode,
          result: "success",
          duration: telemetryJourneyDuration(Date.now() - telemetryStartedAt),
          transcriptStatus: actualTranscriptStatus,
          segmentCount: telemetryCountBucket(allSegments.length),
          refreshCadence,
        },
        operationId: requestId,
        eventId: newId(),
      }).catch(() => undefined);
    } catch (error) {
      await emitProductUsageTelemetry(this.env, {
        workspaceId: this.auth.workspaceId,
        userId: this.auth.userId,
        name: "note_summary_generation_completed",
        properties: {
          noteId: id,
          mode,
          result: "failed",
          duration: telemetryJourneyDuration(Date.now() - telemetryStartedAt),
          transcriptStatus: actualTranscriptStatus,
          segmentCount: telemetryCountBucket(allSegments.length),
          refreshCadence,
        },
        operationId: requestId,
        eventId: newId(),
      }).catch(() => undefined);
      throw error;
    }
    const throughSequence = Number(allSegments.at(-1)!.sequence_number);
    const update = await this.env.DB.prepare(
      `UPDATE notes
       SET live_notes_markdown = ?, notes_through_sequence = ?, generated_at = ?,
           last_activity_at = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND owner_user_id = ?
         AND notes_through_sequence = ?
         AND ((generated_at IS NULL AND ? IS NULL) OR generated_at = ?)`,
    ).bind(
      generated.notes,
      throughSequence,
      generated.generatedAt,
      generated.generatedAt,
      generated.generatedAt,
      id,
      this.auth.workspaceId,
      this.auth.userId,
      startingSequence,
      note.generated_at,
      note.generated_at,
    ).run();
    // Another window may have summarized a newer segment range while this
    // inference was running. Discard this stale result rather than rewinding
    // the cursor or overwriting the newer notes.
    if (!update.meta.changes) {
      // A final whole-meeting summary must not be silently lost to a live
      // Control Tower refresh. Re-read the complete transcript and retry once;
      // a second conflict means another result is newer and should win.
      if (mode === "final" && !retriedFinalConflict) {
        return this.generateAttempt(id, requestId, mode, transcriptStatus, refreshSeconds, true);
      }
      await this.materialize(id);
      return this.get(id);
    }
    await this.materialize(id);
    return this.get(id);
  }

  private async requireNote(id: string, edit: boolean): Promise<NoteRow> {
    const row = edit
      ? await this.env.DB.prepare(
          `SELECT * FROM notes
           WHERE id = ? AND workspace_id = ? AND owner_user_id = ? AND archived_at IS NULL`,
        ).bind(id, this.auth.workspaceId, this.auth.userId).first<Record<string, unknown>>()
      : await this.env.DB.prepare(NOTE_SELECT)
          .bind(id, this.auth.workspaceId, this.auth.userId).first<Record<string, unknown>>();
    if (!row) throw new ApiError(404, "note_not_found", "Note not found");
    return NoteRowSchema.parse(row);
  }

  private async loadSegments(id: string): Promise<SegmentRow[]> {
    const result = await this.env.DB.prepare(
      `SELECT * FROM note_transcript_segments WHERE note_id = ? ORDER BY sequence_number ASC`,
    ).bind(id).all<Record<string, unknown>>();
    return (result.results ?? []).map((row) => SegmentRowSchema.parse(row));
  }

  private async materialize(id: string): Promise<void> {
    const note = await this.requireNote(id, false);
    const segments = await this.loadSegments(id);
    const plain = plainNoteMarkdown(note.title, note.manual_notes_markdown, note.live_notes_markdown, segments);
    const model = modelNoteMarkdown(note.title, note.manual_notes_markdown, note.live_notes_markdown, segments);
    const [contentSha256, modelSha256] = await Promise.all([sha256Hex(plain), sha256Hex(model)]);
    const refs = this.resourceRefs(note.resource_id, contentSha256, modelSha256);
    await this.putResourceObjects(refs, plain, model);
    const at = nowIso();
    await this.env.DB.prepare(
      `UPDATE resources
       SET title = ?, content_ref = ?, content_sha256 = ?, model_content_ref = ?, model_mime_type = ?,
           model_content_sha256 = ?, model_content_status = 'ready',
           model_content_extractor_version = 'avalon-note-v1',
           model_content_character_count = ?, model_content_extracted_at = ?,
           model_content_claimed_at = NULL, model_content_claim_id = NULL,
           model_content_error_code = NULL,
           metadata_json = ?, last_hydrated_at = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    ).bind(
      note.title,
      refs.content,
      contentSha256,
      refs.model,
      "text/markdown; charset=utf-8",
      modelSha256,
      model.length,
      at,
      JSON.stringify({
        noteId: note.id,
        ownerUserId: note.owner_user_id,
        scope: note.scope,
        segmentCount: segments.length,
        size: byteLength(plain),
      }),
      at,
      at,
      note.resource_id,
      this.auth.workspaceId,
    ).run();
  }

  private resourceRefs(
    resourceId: string,
    contentSha256: string,
    modelSha256: string,
  ): { content: string; model: string } {
    const base = `${this.env.AVALON_REGION}/${this.auth.workspaceId}/resources/${resourceId}`;
    return {
      content: `${base}/versions/${contentSha256}/note.md`,
      model: `${base}/versions/${modelSha256}/note-model.md`,
    };
  }

  private async putResourceObjects(
    refs: { content: string; model: string },
    plain: string,
    model: string,
  ): Promise<void> {
    await Promise.all([
      this.env.PAYLOADS.put(refs.content, plain, {
        httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      }),
      this.env.PAYLOADS.put(refs.model, model, {
        httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      }),
    ]);
  }
}

function toSegment(row: SegmentRow): NoteTranscriptSegment {
  return {
    id: String(row.id),
    noteId: String(row.note_id),
    sequenceNumber: Number(row.sequence_number),
    startOffsetMs: Number(row.start_offset_ms),
    endOffsetMs: Number(row.end_offset_ms),
    capturedAt: String(row.captured_at),
    speakerLabel: row.speaker_label == null ? null : String(row.speaker_label),
    text: String(row.text_content),
    createdAt: String(row.created_at),
  };
}

function toNoteDetail(note: NoteRow, segments: SegmentRow[]): NoteDetail {
  return {
    ...toNoteSummary(note),
    manualNotes: String(note.manual_notes_markdown),
    liveNotes: String(note.live_notes_markdown),
    notesThroughSequence: Number(note.notes_through_sequence),
    segments: segments.map(toSegment),
  };
}

function formatOffset(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function timestampedSegment(segment: SegmentRow): string {
  const speaker = segment.speaker_label ? ` ${segment.speaker_label}:` : "";
  return `[${formatOffset(Number(segment.start_offset_ms))}–${formatOffset(Number(segment.end_offset_ms))}]${speaker} ${segment.text_content}`;
}

function elideMiddle(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  if (maximum <= OMITTED_CONTEXT_MARKER.length) return OMITTED_CONTEXT_MARKER.slice(0, maximum);
  const remaining = maximum - OMITTED_CONTEXT_MARKER.length;
  const headLength = Math.ceil(remaining / 2);
  const tailLength = remaining - headLength;
  return `${value.slice(0, headLength)}${OMITTED_CONTEXT_MARKER}${value.slice(value.length - tailLength)}`;
}

function boundedTranscript(rows: SegmentRow[], maximum: number): { omitted: boolean; transcript: string } {
  const transcript = rows.map(timestampedSegment).join("\n\n");
  return {
    omitted: transcript.length > maximum,
    transcript: elideMiddle(transcript, maximum),
  };
}

function recentTranscriptContext(rows: SegmentRow[]): string {
  const latestOffset = Math.max(...rows.map((segment) => Number(segment.end_offset_ms)));
  const windowStartsAt = Math.max(0, latestOffset - RECENT_TRANSCRIPT_WINDOW_MS);
  const recent = rows.filter((segment) => Number(segment.end_offset_ms) >= windowStartsAt);
  return boundedTranscript(recent, MAX_RECENT_TRANSCRIPT_CHARACTERS).transcript;
}

function plainNoteMarkdown(title: string, manualNotes: string, notes: string, segments: SegmentRow[]): string {
  const transcript = segments.map((segment) => String(segment.text_content)).join("\n\n");
  return [
    `# ${title}`,
    "## Notes",
    manualNotes.trim() || "_No written notes yet._",
    "## AI notes",
    notes.trim() || "_No live notes yet._",
    "## Transcript",
    transcript || "_No transcript yet._",
    "",
  ].join("\n\n");
}

function modelNoteMarkdown(title: string, manualNotes: string, notes: string, segments: SegmentRow[]): string {
  const transcript = segments.map(timestampedSegment).join("\n\n");
  return [
    `# ${title}`,
    "## User-written notes",
    manualNotes.trim() || "_No written notes yet._",
    "## AI-generated meeting brief",
    notes.trim() || "_No live notes yet._",
    "## Timestamped transcript",
    transcript || "_No transcript yet._",
    "",
  ].join("\n\n");
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
