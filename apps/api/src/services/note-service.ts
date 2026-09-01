import { newId, nowIso } from "@rally/db";
import { asWorkspaceId } from "@rally/contracts";
import type {
  AppendNoteTranscriptSegmentRequest,
  CreateNoteRequest,
  NoteDetail,
  NoteSummary,
  NoteTranscriptSegment,
  UpdateNoteRequest,
  WorkstreamBatchFilter,
} from "@rally/contracts";
import { workspaceDOName } from "../durable-objects/names";
import { WorkspaceBatchNoteArchiveResultSchema } from "../durable-objects/workspace-directory-protocol";
import {
  WorkspaceNoteArchiveResultSchema,
  WorkspaceNoteGenerationCommitResultSchema,
  WorkspaceNoteSegmentAppendResultSchema,
  WorkspaceNoteSidebarListSchema,
  WorkspaceNoteStateSchema,
  WorkspaceNoteUpdateResultSchema,
  type WorkspaceNoteAccess,
  type WorkspaceNoteRecord,
  type WorkspaceNoteSegmentRecord,
} from "../durable-objects/workspace-notes-protocol";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { sha256Hex } from "../lib/crypto";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { logWarn } from "../observability/logger";
import { MeetingNotesService } from "./meeting-notes-service";
import { processPendingNotePrivacyNotifications } from "./note-privacy-notification-service";
import {
  emitProductUsageTelemetry,
  telemetryCountBucket,
  telemetryJourneyDuration,
} from "../telemetry/product-usage";
import { withWorkspaceRuntimeDatabase } from "./workspace-runtime-database";
import { SIDEBAR_LIST_LIMIT } from "./sidebar-reads";

const MAX_NOTES_CONTEXT_CHARACTERS = 50_000;
const MAX_TRANSCRIPT_CONTEXT_CHARACTERS = 400_000;
const MAX_RECENT_TRANSCRIPT_CHARACTERS = 100_000;
const RECENT_TRANSCRIPT_WINDOW_MS = 10 * 60 * 1_000;
const OMITTED_CONTEXT_MARKER = "\n\n[… middle content omitted to fit model context …]\n\n";

type MeetingNotesGenerator = Pick<MeetingNotesService, "generate">;

/**
 * Notes live in WorkspaceDO, and this service reaches them as typed methods on
 * the object rather than SQL through the workspace runtime facade. The row
 * contracts that used to be asserted here — the enums and bounds mirroring the
 * columns' CHECK constraints — are parsed at the object's boundary by the
 * schemas in `workspace-notes-protocol.ts`.
 *
 * The one write still on the facade is `create`: it inserts the `resources`
 * row and the `notes` row as one atomic batch, and `resources` belongs to
 * another domain. Splitting that transaction across a typed method and a
 * facade statement would open a partial-failure window the batch does not
 * have, so it converts together with the resources domain.
 */
export class NoteService {
  private readonly meetingNotesGenerator: MeetingNotesGenerator;
  private readonly env: Env;
  private readonly auth: AuthContext;

  constructor(
    env: Env,
    auth: AuthContext,
    meetingNotesGenerator?: MeetingNotesGenerator,
  ) {
    // The facade wrapper stays even though most note statements left it:
    // `create` and `materialize` still write `resources` through `env.DB`,
    // and an unwrapped environment would send those to a regional database
    // that dropped the table.
    this.env = withWorkspaceRuntimeDatabase(env, auth.workspaceId);
    this.auth = auth;
    this.meetingNotesGenerator = meetingNotesGenerator ?? new MeetingNotesService(this.env, auth);
  }

  /** The WorkspaceDO that owns this workspace's notes. */
  private workspace() {
    return durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      asWorkspaceId(this.auth.workspaceId),
      workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(this.auth.workspaceId)),
    );
  }

  private async noteState(id: string, access: WorkspaceNoteAccess): Promise<{
    note: WorkspaceNoteRecord | null;
    segments: WorkspaceNoteSegmentRecord[];
  }> {
    return WorkspaceNoteStateSchema.parse(await (await this.workspace()).noteWithSegments({
      workspaceId: this.auth.workspaceId,
      noteId: id,
      userId: this.auth.userId,
      access,
    }));
  }

  private async requireNoteState(id: string, access: WorkspaceNoteAccess): Promise<{
    note: WorkspaceNoteRecord;
    segments: WorkspaceNoteSegmentRecord[];
  }> {
    const state = await this.noteState(id, access);
    if (!state.note) throw new ApiError(404, "note_not_found", "Note not found");
    return { note: state.note, segments: state.segments };
  }

  /** Shares its statement and row mapping with the sidebar's socket batch. */
  async list(limit: number): Promise<{ items: NoteSummary[] }> {
    const result = WorkspaceNoteSidebarListSchema.parse(
      await (await this.workspace()).listNoteSidebar({
        workspaceId: this.auth.workspaceId,
        userId: this.auth.userId,
        limit: Math.min(Math.max(limit, 1), SIDEBAR_LIST_LIMIT),
      }),
    );
    return { items: result.items };
  }

  async create(input: CreateNoteRequest): Promise<NoteDetail> {
    const existing = await this.noteState(input.id, "any");
    if (existing.note) {
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
    const { note, segments } = await this.requireNoteState(id, "view");
    return toNoteDetail(note, segments);
  }

  async update(id: string, input: UpdateNoteRequest): Promise<NoteDetail> {
    const result = WorkspaceNoteUpdateResultSchema.parse(
      await (await this.workspace()).updateNote({
        workspaceId: this.auth.workspaceId,
        noteId: id,
        userId: this.auth.userId,
        at: nowIso(),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.manualNotes !== undefined ? { manualNotesMarkdown: input.manualNotes } : {}),
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
        ...(input.recordingStatus !== undefined ? { recordingStatus: input.recordingStatus } : {}),
        ...(input.recordedMs !== undefined ? { recordedMs: input.recordedMs } : {}),
        ...("startedAt" in input ? { startedAt: input.startedAt ?? null } : {}),
        ...("endedAt" in input ? { endedAt: input.endedAt ?? null } : {}),
      }),
    );
    if (result.outcome === "not_found") throw new ApiError(404, "note_not_found", "Note not found");
    await this.materialize(id);
    if (result.becamePrivate) {
      await processPendingNotePrivacyNotifications(this.env, {
        workspaceId: this.auth.workspaceId,
        noteId: id,
      }).catch((error: unknown) => {
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
    const result = WorkspaceNoteArchiveResultSchema.parse(
      await (await this.workspace()).archiveNote({
        workspaceId: this.auth.workspaceId,
        noteId: id,
        userId: this.auth.userId,
        at: nowIso(),
      }),
    );
    if (result.outcome === "archived") return;
    if (result.outcome === "not_found") throw new ApiError(404, "note_not_found", "Note not found");
    // Archiving underneath a live meeting window would 404 its next segment
    // save while capture kept running, losing the rest of the transcript.
    throw new ApiError(
      409,
      "note_recording",
      "This note is still recording. End the recording before archiving it.",
    );
  }

  /**
   * Archive the notes one grouping's **Archive all** selected.
   *
   * No per-note loop and no per-note refusal: the whole selection is one
   * WorkspaceDO transaction, and the notes a single archive would refuse — a
   * colleague's, or one still recording — were never selected, so there is no
   * 404 or 409 for this to translate. The count is what actually went, which is
   * the number the confirmation dialog promised.
   *
   * `operationId` and `requestHash` are the work-stream batch's own fence:
   * this must follow the dispatch that froze them, and a retry of the same
   * operation returns the first call's count rather than archiving again.
   */
  async archiveForBatch(input: {
    operationId: string;
    requestHash: string;
    filter: WorkstreamBatchFilter;
  }): Promise<number> {
    const result = WorkspaceBatchNoteArchiveResultSchema.parse(
      await (await this.workspace()).archiveNotesForBatch({
        workspaceId: this.auth.workspaceId,
        userId: this.auth.userId,
        operationId: input.operationId,
        requestHash: input.requestHash,
        filter: input.filter,
        at: nowIso(),
      }),
    );
    return result.archivedNoteCount;
  }

  async appendSegment(id: string, input: AppendNoteTranscriptSegmentRequest): Promise<NoteTranscriptSegment> {
    const result = WorkspaceNoteSegmentAppendResultSchema.parse(
      await (await this.workspace()).appendNoteSegment({
        workspaceId: this.auth.workspaceId,
        noteId: id,
        userId: this.auth.userId,
        segmentId: newId(),
        clientSegmentId: input.clientSegmentId,
        startOffsetMs: input.startOffsetMs,
        endOffsetMs: input.endOffsetMs,
        capturedAt: input.capturedAt,
        speakerLabel: input.speakerLabel,
        text: input.text,
        at: nowIso(),
      }),
    );
    if (result.outcome === "note_not_found" || !result.segment) {
      throw new ApiError(404, "note_not_found", "Note not found");
    }
    await this.materialize(id);
    return result.segment;
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
    const { note, segments: allSegments } = await this.requireNoteState(id, "edit");
    const startingSequence = note.notesThroughSequence;
    const pending = allSegments.filter((segment) => segment.sequenceNumber > startingSequence);
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
        previousNotes: mode === "live" ? elideMiddle(note.liveNotesMarkdown.trim(), MAX_NOTES_CONTEXT_CHARACTERS) : "",
        userNotes: note.manualNotesMarkdown,
        transcript: completeTranscript.transcript,
        recentTranscript: mode === "live" ? recentTranscriptContext(allSegments) : "",
        startedAt: note.startedAt,
        endedAt: mode === "final" ? note.endedAt ?? nowIso() : note.endedAt,
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
    const throughSequence = allSegments.at(-1)!.sequenceNumber;
    const commit = WorkspaceNoteGenerationCommitResultSchema.parse(
      await (await this.workspace()).commitNoteGeneration({
        workspaceId: this.auth.workspaceId,
        noteId: id,
        userId: this.auth.userId,
        liveNotesMarkdown: generated.notes,
        throughSequence,
        generatedAt: generated.generatedAt,
        expectedThroughSequence: startingSequence,
        expectedGeneratedAt: note.generatedAt,
      }),
    );
    // Another window may have summarized a newer segment range while this
    // inference was running. Discard this stale result rather than rewinding
    // the cursor or overwriting the newer notes.
    if (commit.outcome === "stale") {
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

  private async materialize(id: string): Promise<void> {
    const { note, segments } = await this.requireNoteState(id, "view");
    const plain = plainNoteMarkdown(note.title, note.manualNotesMarkdown, note.liveNotesMarkdown, segments);
    const model = modelNoteMarkdown(note.title, note.manualNotesMarkdown, note.liveNotesMarkdown, segments);
    const [contentSha256, modelSha256] = await Promise.all([sha256Hex(plain), sha256Hex(model)]);
    const refs = this.resourceRefs(note.resourceId, contentSha256, modelSha256);
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
        ownerUserId: note.ownerUserId,
        scope: note.scope,
        segmentCount: segments.length,
        size: byteLength(plain),
      }),
      at,
      at,
      note.resourceId,
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

function toNoteDetail(note: WorkspaceNoteRecord, segments: WorkspaceNoteSegmentRecord[]): NoteDetail {
  return {
    id: note.id,
    workspaceId: note.workspaceId,
    resourceId: note.resourceId,
    ownerUserId: note.ownerUserId,
    scope: note.scope,
    title: note.title,
    recordingStatus: note.recordingStatus,
    recordedMs: note.recordedMs,
    startedAt: note.startedAt,
    endedAt: note.endedAt,
    generatedAt: note.generatedAt,
    lastActivityAt: note.lastActivityAt,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    archivedAt: note.archivedAt,
    manualNotes: note.manualNotesMarkdown,
    liveNotes: note.liveNotesMarkdown,
    notesThroughSequence: note.notesThroughSequence,
    segments,
  };
}

function formatOffset(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function timestampedSegment(segment: WorkspaceNoteSegmentRecord): string {
  const speaker = segment.speakerLabel ? ` ${segment.speakerLabel}:` : "";
  return `[${formatOffset(segment.startOffsetMs)}–${formatOffset(segment.endOffsetMs)}]${speaker} ${segment.text}`;
}

function elideMiddle(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  if (maximum <= OMITTED_CONTEXT_MARKER.length) return OMITTED_CONTEXT_MARKER.slice(0, maximum);
  const remaining = maximum - OMITTED_CONTEXT_MARKER.length;
  const headLength = Math.ceil(remaining / 2);
  const tailLength = remaining - headLength;
  return `${value.slice(0, headLength)}${OMITTED_CONTEXT_MARKER}${value.slice(value.length - tailLength)}`;
}

function boundedTranscript(rows: WorkspaceNoteSegmentRecord[], maximum: number): { omitted: boolean; transcript: string } {
  const transcript = rows.map(timestampedSegment).join("\n\n");
  return {
    omitted: transcript.length > maximum,
    transcript: elideMiddle(transcript, maximum),
  };
}

function recentTranscriptContext(rows: WorkspaceNoteSegmentRecord[]): string {
  const latestOffset = Math.max(...rows.map((segment) => segment.endOffsetMs));
  const windowStartsAt = Math.max(0, latestOffset - RECENT_TRANSCRIPT_WINDOW_MS);
  const recent = rows.filter((segment) => segment.endOffsetMs >= windowStartsAt);
  return boundedTranscript(recent, MAX_RECENT_TRANSCRIPT_CHARACTERS).transcript;
}

function plainNoteMarkdown(title: string, manualNotes: string, notes: string, segments: WorkspaceNoteSegmentRecord[]): string {
  const transcript = segments.map((segment) => segment.text).join("\n\n");
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

function modelNoteMarkdown(title: string, manualNotes: string, notes: string, segments: WorkspaceNoteSegmentRecord[]): string {
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
