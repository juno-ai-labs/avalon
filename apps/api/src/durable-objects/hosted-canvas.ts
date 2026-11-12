import { z } from "zod";

import { IdSchema, UserIdSchema, WorkspaceIdSchema, WorkstreamAppearancePatchSchema, WorkstreamAppearanceSchema, type AutomationSummary, type WorkstreamAppearance } from "@rally/contracts";
import { logWarn } from "../observability/logger";
import { AUTOMATION_TRIGGER_KINDS_SQL, parsedAppearance, sidekickTriggerSummary } from "./sidekick-directory-sql";
import {
  CanvasAccessDecisionRequestSchema,
  CanvasAccessDecisionSchema,
  CanvasAccessRequestResultSchema,
  CanvasAccessRequestSchema,
  CanvasAccessSchema,
  CanvasAudienceUpdateSchema,
  CanvasDetailSchema,
  CanvasEditorSchema,
  CanvasSidebarRowSchema,
  CanvasSidekickSchema,
  CanvasSummarySchema,
  canvasArtifactVisibilityFloor,
  type CanvasSidekick,
  type CanvasSidebarRow,
  type CanvasAccess,
  type CanvasAccessDecision,
  type CanvasAccessRequestResult,
  type CanvasArtifact,
  type CanvasArtifactKind,
  type CanvasDetail,
  type CanvasSummary,
} from "@rally/contracts/canvases";
import {
  ClaimScopeInvitationsSchema,
  CreateScopeInvitationsSchema,
  RevokeScopeInvitationSchema,
  ScopeInvitationResultSchema,
  type ScopeGrant,
  type ScopeInvitationResult,
  type ScopeInvitationSummary,
  type WorkspaceRelationship,
} from "@rally/contracts/scope-grants";

import { ApiError } from "../lib/api-error";
import { parseRpcInput } from "../lib/rpc-input";
import { canvasAdmits, canvasManages } from "../services/authorization-policy";
import { listedResourceVisibilitySql } from "../services/resource-listing";
import type { ConversationParentAuthorizeViewerRequest } from "@rally/contracts/conversation-parent";
import { ConversationAuthorizationRequestSchema, type ConversationAuthorizationRequest } from "../services/authorization-policy";
import type { DirectoryCommonEffect } from "./conversation-parent-object";
import { assertAudienceInOrganization, HostedConversation, type HostedConversationHost, type HostedConversationIdentity, type PriorChildProjection } from "./hosted-conversation";
import { canvasParticipant, canvasReaderAllows, sidekickManagerAllows, sidekickReaderAllows, writerSidekick, writerSidekickAdmits } from "./canvas-sidekick-admission";
import { ScopeInvitationService } from "./scope-invitation-service";
import { artifactNewsCauseSql, artifactNewsSql } from "./workspace-pin-storage";
import { tellCanvasPinners } from "./canvas-artifact-notices";
import {
  accessRefusals,
  latestAccessRequest,
  pendingAccessRequests,
  requestCanvasAccess,
  settleAdmittedAccessRequests,
  settleCanvasAccessRequest,
  type CanvasAccessSubject,
} from "./canvas-access-requests";
import { attachSidekickConversation } from "./workspace-sidekick-conversation-storage";
import { CANVAS_ARCHIVE_ARTIFACT_ALARM, CANVAS_ARCHIVE_CONVERSATION_ALARM, CANVAS_NAMING_ALARM_KIND, UNTITLED_CANVAS } from "./canvas-schema";
import type { ScheduledAlarmStore } from "./scheduled-alarms";
import { createMessageObjectPort } from "../runtime/message-port";
import { canvasTitleFromOpening } from "../services/canvas-naming";
import { canvasRunningActivity, projectionIsRunning } from "./canvas-agent-activity";

/** Who is asking: their id and, for a member, their Organization role; a guest has none. */
export const CanvasActorSchema = z.strictObject({
  userId: UserIdSchema,
  actorRole: z.enum(["owner", "admin", "member"]).nullable(),
});
export type CanvasActor = z.infer<typeof CanvasActorSchema>;

const Addressed = { workspaceId: WorkspaceIdSchema, canvasId: IdSchema };

export const CanvasCreateRequestSchema = z.strictObject({
  ...Addressed,
  title: z.string().trim().max(300),
  createdByUserId: UserIdSchema,
  authorityGeneration: z.number().int().positive(),
  /**
   * A Canvas a Sidekick run makes: the Sidekick that writes it and the run
   * that made it. It starts out open to whoever the Sidekick is shared with.
   */
  writer: z.strictObject({ sidekickId: IdSchema, runId: IdSchema }).optional(),
  /** `naming` for a Canvas made with no title, which its opening message titles. */
  titleStatus: z.enum(["naming", "settled"]).optional(),
  /**
   * The id already has a D1 anchor: a caller-minted id another conversation
   * may hold. Only a replay of this creator's own Canvas is answered then.
   */
  anchored: z.boolean().optional(),
});
export type CanvasCreateRequest = z.infer<typeof CanvasCreateRequestSchema>;

export const CanvasActorRequestSchema = z.strictObject({ ...Addressed, actor: CanvasActorSchema });

export const CanvasRequestAccessRequestSchema = CanvasActorRequestSchema.extend({ request: CanvasAccessRequestSchema });
export type CanvasRequestAccessRequest = z.input<typeof CanvasRequestAccessRequestSchema>;
export const CanvasDecideAccessRequestSchema = CanvasActorRequestSchema.extend({
  requesterUserId: UserIdSchema,
  decision: CanvasAccessDecisionRequestSchema.shape.decision,
});
export type CanvasDecideAccessRequest = z.input<typeof CanvasDecideAccessRequestSchema>;

export const CanvasNoteArtifactRequestSchema = z.strictObject({
  ...Addressed,
  resourceId: IdSchema,
  editor: CanvasEditorSchema,
  /** The Sidekick run that published, for a `sidekick` editor: the row's `lastWrittenBy`. */
  runId: IdSchema.nullable().optional(),
}).refine((request) => !request.runId || request.editor.kind === "sidekick", {
  path: ["runId"], message: "only a Sidekick's publish names a run",
});

/** What an artifact is, from its resource row: a site Rally serves, an archive, or any other file. */
export function canvasArtifactKind(resourceType: string, mimeType: string | null): CanvasArtifactKind {
  return resourceType === "generated_site" ? "site" : mimeType === "application/zip" ? "archive" : "file";
}
export type CanvasActorRequest = z.infer<typeof CanvasActorRequestSchema>;

/** A retitle, an appearance choice, or both; the route refuses a body with neither. */
export const CanvasUpdateRequestSchema = CanvasActorRequestSchema.extend({
  title: z.string().trim().min(1).max(300).optional(),
  appearance: WorkstreamAppearancePatchSchema.optional(),
});
export type CanvasUpdateRequest = z.input<typeof CanvasUpdateRequestSchema>;

export const CanvasSetAudienceRequestSchema = CanvasActorRequestSchema.extend({ update: CanvasAudienceUpdateSchema });
export type CanvasSetAudienceRequest = z.input<typeof CanvasSetAudienceRequestSchema>;

export interface CanvasRow extends Record<string, SqlStorageValue> {
  canvas_id: string;
  workspace_id: string;
  title: string;
  created_by_user_id: string;
  created_at: number;
  updated_at: number;
  last_editor_kind: "person" | "rally" | "sidekick" | null;
  last_editor_id: string | null;
  writer_sidekick_id: string | null;
  writer_run_id: string | null;
  /** The run whose publish made the newest version, a `sidekick` editor's (migration 137). */
  last_writer_run_id: string | null;
  visibility: "creator" | "participants" | "workspace";
  authority_generation: number;
  /** `naming` while a Canvas made with no title waits for its opening message's (migration 137). */
  title_status: "naming" | "settled";
  /** The chosen icon and colour, `WorkstreamAppearanceSchema` JSON; null until someone chooses (migration 137). */
  appearance_json: string | null;
  archived_at: number | null;
  artifact_visibility: "editors" | "participants" | "workspace" | "public";
  sharing_revision: number;
}

/** What a hosted Canvas needs from the Organization object that holds it. */
export interface HostedCanvasHost extends HostedConversationHost {
  /** The Organization object's alarm entries; the naming pass is one. */
  alarms: ScheduledAlarmStore;
  /** Inside the transaction that changed one person's read of a Canvas's Chat: their Canvas list, sent only to them. */
  noteCanvasReadChanged(userId: string): void;
  noteRelationship(relationship: WorkspaceRelationship): void;
  /** Inside the transaction that changed a Canvas's row or its participants: the sidebar list's waterline. */
  noteCanvasDirectoryChanged(canvasId: string): void;
  /**
   * Inside the transaction that changed a Canvas's title, mark or who it admits: a
   * Sidekick attached to it names it on its card, to the people who can open
   * it, so the Sidekick list moved too.
   */
  noteAttachedCanvasChanged(canvasId: string): void;
  /** Inside the archive's transaction: archive every Sidekick this Canvas's Chat made. */
  archiveMadeSidekicks(canvasId: string, now: number): void;
}

function forbidden(): ApiError {
  return new ApiError(403, "canvas_forbidden", "You cannot change who can open this Canvas");
}

function idUnavailable(): ApiError {
  return new ApiError(409, "canvas_id_unavailable", "This Canvas id is already in use");
}

function notFound(): ApiError {
  return new ApiError(404, "canvas_not_found", "This Canvas does not exist");
}

/** Told of a Canvas whose stored appearance no longer parses, with the field and reason it failed on. */
export type InvalidCanvasAppearanceReport = (canvasId: string, code: string) => void;

/**
 * What somebody chose for the Canvas to look like; both fields null until
 * someone does, which the client draws as the default. A stored choice that no
 * longer parses (a key a later catalog retired past what is storable) reads as
 * unchosen and is reported by field (`canvas_appearance_invalid:icon:…`), so
 * one bad row never fails a whole list, and the next choice repairs it.
 */
export function canvasAppearance(row: CanvasRow, report: InvalidCanvasAppearanceReport): WorkstreamAppearance {
  return parsedAppearance(row.appearance_json ?? null, "canvas_appearance", (code) => report(row.canvas_id, code))
    ?? { icon: null, color: null };
}

/** The structured warning a reader of a Canvas row reports a stored appearance that no longer parses with. */
export function canvasAppearanceReporter(env: Parameters<typeof logWarn>[0]): InvalidCanvasAppearanceReport {
  return (canvasId, code) => logWarn(env, "canvas_directory_appearance_invalid", { canvas_id: canvasId, code });
}

/** The row's public shape. */
export function canvasSummary(row: CanvasRow, report: InvalidCanvasAppearanceReport): CanvasSummary {
  return CanvasSummarySchema.parse({
    id: row.canvas_id,
    title: row.title,
    createdByUserId: row.created_by_user_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    lastEditor: row.last_editor_kind ? { kind: row.last_editor_kind, id: row.last_editor_id } : null,
    writerSidekickId: row.writer_sidekick_id,
    visibility: row.visibility,
    titleStatus: row.title_status,
    appearance: canvasAppearance(row, report),
  });
}


/**
 * One Canvas's parent state, scoped to a `canvas_id` inside `WorkspaceDO`'s
 * SQLite: its directory row, who may open it, and the share invitations that
 * add guests to it. Constructed per call, like `HostedSidekick`.
 */
export class HostedCanvas extends HostedConversation<HostedCanvasHost> {
  constructor(host: HostedCanvasHost, canvasId: string) {
    super(host, canvasId, "canvas");
  }

  protected readonly codeNoun = "canvas";

  get canvasId(): string {
    return this.parentId;
  }

  protected identity(): HostedConversationIdentity | null {
    const row = this.row();
    return row ? { workspaceId: row.workspace_id, authorityGeneration: row.authority_generation, archived: row.archived_at !== null } : null;
  }

  protected assertParent(workspaceId: string, parentId: string): HostedConversationIdentity {
    const row = this.assertCanvas(workspaceId, parentId, true);
    return { workspaceId: row.workspace_id, authorityGeneration: row.authority_generation, archived: row.archived_at !== null };
  }

  /**
   * `canvasReaderAllows`, with the person's role from their Organization
   * relationship: an owner or administrator opens every Canvas, and a guest
   * (who asks with `requireGrantAuthority`) is never admitted by Organization
   * visibility.
   */
  protected async admitsViewer(request: ConversationParentAuthorizeViewerRequest, relationship: WorkspaceRelationship): Promise<boolean> {
    const row = this.row()!;
    // Only a member has a role: a guest, or a caller asking on the grant path,
    // is admitted from the lists alone.
    const actorRole = !request.requireGrantAuthority && relationship.accessClass === "member"
      ? relationship.role ?? "member" : null;
    return canvasReaderAllows(this.row() ?? row, { userId: request.userId, actorRole }, this.sql);
  }

  protected onViewerReadChanged(userId: string): void {
    this.host.noteCanvasReadChanged(userId);
  }

  /**
   * Saved Chat messages advance recency independently of the unread cursor.
   */
  protected onChildProjection(substreamId: string, effect: DirectoryCommonEffect,
    prior: PriorChildProjection | null, now: number): void {
    if ((effect.backgroundAgent || prior?.backgroundAgent)
      && projectionIsRunning(prior) !== projectionIsRunning(effect)) {
      this.host.noteCanvasDirectoryChanged(this.canvasId);
    }
    if (substreamId !== "0") return;
    // No ordinal and ordinal 0 are both an empty Chat: the provisioning
    // projection of a Canvas nobody has written in is not activity, so it
    // does not move the Canvas up the recency list.
    const before = prior?.latestAttentionOrdinal ?? 0;
    const latest = effect.latestAttentionOrdinal ?? 0;
    // Older senders carried only the attention cursor and conversation activity time.
    const legacyMessageAt = latest > before ? effect.lastActivityAt : null;
    const messageAt = effect.lastMessageAt === undefined ? legacyMessageAt : effect.lastMessageAt;
    // The Chat's first message, in a Canvas a person made with no title that
    // nobody has retitled since: it starts naming now, in this write, so an
    // empty Canvas reads as its title rather than as a naming skeleton that
    // waits for a message that may never come.
    const changed = this.sql.exec<{ title_status: string }>(
      `UPDATE canvas_directory
          SET updated_at = MAX(updated_at, ?1),
              title_status = CASE WHEN ?3 = 0 AND ?4 >= 1 AND title_status = 'settled' AND title = ?5
                                       AND writer_sidekick_id IS NULL THEN 'naming' ELSE title_status END
        WHERE canvas_id = ?2 AND archived_at IS NULL AND (?1 > updated_at OR ?3 <> ?4) RETURNING title_status`,
      messageAt === null ? 0 : Date.parse(messageAt), this.canvasId, before, latest, UNTITLED_CANVAS,
    ).toArray()[0];
    if (!changed) return;
    this.host.noteCanvasDirectoryChanged(this.canvasId);
    // A Canvas waiting for a title: the naming pass reads its first message.
    // Armed again by a later message before it runs, which is the same entry.
    if (latest >= 1 && changed.title_status === "naming") {
      this.host.alarms.schedule({ kind: CANVAS_NAMING_ALARM_KIND, key: this.canvasId, dueAt: now }, now);
    }
  }

  /**
   * Title a Canvas made with no title from the message that opened its Chat
   * (`canvasTitleFromOpening`), and give it the icon chosen beside the title
   * when nobody has chosen one, without changing the date already recorded
   * for the message. The write requires `naming`, so a person's manual title
   * stands. An empty model response settles the existing title.
   */
  async nameFromOpening(): Promise<void> {
    const row = this.row();
    if (!row || row.title_status !== "naming") return;
    const [opening] = await createMessageObjectPort(this.env, row.workspace_id, this.canvasId)
      .saidMessages({ messageTypes: { include: ["text"] }, order: "oldest", limit: 1, peopleOnly: true });
    // A first message of attachments alone says nothing to title from; the
    // Canvas waits, and a person's next text message arms the entry again.
    if (!opening) return;
    const named = await canvasTitleFromOpening(this.env, {
      workspaceId: row.workspace_id, canvasId: this.canvasId, userId: opening.author_user_id, opening: opening.text_content,
    });
    this.host.storage.transactionSync(() => {
      const settled = this.sql.exec(
        `UPDATE canvas_directory SET title = COALESCE(?, title), title_status = 'settled'
          WHERE canvas_id = ? AND title_status = 'naming' RETURNING canvas_id`,
        named?.title ?? null, this.canvasId,
      ).toArray().length === 1;
      // The icon fills only an unchosen one, read again after the model's
      // await: a person who picked an icon meanwhile keeps theirs.
      const current = settled && named?.icon ? this.row() : null;
      const appearance = current ? canvasAppearance(current, canvasAppearanceReporter(this.host.env)) : null;
      if (appearance?.icon === null && named?.icon) {
        this.sql.exec(`UPDATE canvas_directory SET appearance_json = ? WHERE canvas_id = ?`,
          JSON.stringify({ ...appearance, icon: named.icon }), this.canvasId);
      }
      if (settled) {
        this.host.noteCanvasDirectoryChanged(this.canvasId);
        this.host.noteAttachedCanvasChanged(this.canvasId);
      }
    });
  }

  /** What resource and search authorization decide a Canvas reader from (`canvasAdmits`). */
  async readAuthorizationFacts(input: ConversationAuthorizationRequest) {
    const request = parseRpcInput(ConversationAuthorizationRequestSchema, input, "canvas_read_authorization_facts");
    const initial = this.row();
    if (!initial || initial.archived_at !== null) return { exists: false as const, validatedAt: Date.now() };
    this.assertCanvas(request.workspaceId, request.parentId);
    const relationship = request.relationship ?? await this.host.readRelationship(initial.workspace_id, request.userId);
    // Read again after the await: the row is what the facts describe.
    const row = this.row() ?? initial;
    if (row.archived_at !== null) return { exists: false as const, validatedAt: Date.now() };
    // A Sidekick's Organization scope admits a member and no guest, so the
    // writer's audience is decided for the relationship in hand.
    const member = relationship?.status === "active" && relationship.accessClass === "member";
    const facts = {
      visibility: row.visibility,
      creator: row.created_by_user_id === request.userId,
      participant: canvasParticipant(this.sql, this.canvasId, request.userId),
      writerAudience: row.writer_sidekick_id !== null && writerSidekickAdmits(this.sql, row.writer_sidekick_id,
        { userId: request.userId, actorRole: member ? "member" : null }),
      administrator: member && (relationship.role === "owner" || relationship.role === "admin"),
      children: this.childRegistry().map((child) => child.substreamId),
    };
    return {
      exists: true as const,
      ...facts,
      revision: JSON.stringify([row.authority_generation, facts]),
      validatedAt: Date.now(),
    };
  }

  row(): CanvasRow | null {
    return this.sql.exec<CanvasRow>(
      `SELECT canvas_id, workspace_id, title, created_by_user_id, created_at, updated_at, last_editor_kind,
              last_editor_id, writer_sidekick_id, writer_run_id, last_writer_run_id, visibility, authority_generation,
              title_status, appearance_json, archived_at, artifact_visibility, sharing_revision
         FROM canvas_directory WHERE canvas_id = ?`,
      this.canvasId,
    ).toArray()[0] ?? null;
  }

  /** The row, refused as not found for another Organization's id. */
  assertCanvas(workspaceId: string, canvasId: string, includeArchived = false): CanvasRow {
    const row = this.row();
    if (!row || row.workspace_id !== workspaceId || canvasId !== this.canvasId || (!includeArchived && row.archived_at !== null)) throw notFound();
    return row;
  }

  /** A manager archives for everyone; content stays stored and a retry converges. */
  archive(input: CanvasActorRequest): void {
    const request = parseRpcInput(CanvasActorRequestSchema, input, "canvas_archive");
    this.storage.transactionSync(() => {
      const row = this.assertCanvas(request.workspaceId, request.canvasId, true);
      if (!this.manages(row, request.actor)) {
        if (!canvasReaderAllows(row, request.actor, this.sql)) throw notFound();
        throw new ApiError(403, "canvas_archive_forbidden", "Only a Canvas manager can archive it");
      }
      if (row.archived_at !== null) return;
      const now = Date.now();
      this.sql.exec(`UPDATE canvas_directory SET archived_at = ?, title_status = 'settled' WHERE canvas_id = ?`,
        now, this.canvasId);
      this.sql.exec(`INSERT INTO resource_search_versions(resource_id, revision, pending, not_before)
        SELECT id, 1, 1, 0 FROM resources WHERE provider = 'avalon_generated'
          AND (publication_parent_id = ? OR id IN (SELECT resource_id FROM canvas_artifacts WHERE canvas_id = ?))
        ON CONFLICT(resource_id) DO UPDATE SET revision = revision + 1, pending = 1, not_before = 0`, this.canvasId, this.canvasId);
      this.host.alarms.cancel(CANVAS_NAMING_ALARM_KIND, this.canvasId);
      // A Sidekick made in this Canvas exists to work on it, so it goes with
      // it: left running, each trigger would start a run with nowhere to write.
      this.host.archiveMadeSidekicks(this.canvasId, now);
      // Save the audience before any delivery. Retrying an archive cannot
      // reconstruct it from admission: the tombstone now admits nobody.
      const users = this.sql.exec<{ user_id: string }>(
        `SELECT user_id FROM workspace_member_status WHERE active = 1`,
      ).toArray().map((member) => member.user_id);
      for (const child of this.childRegistry()) this.host.alarms.schedule({
        kind: CANVAS_ARCHIVE_CONVERSATION_ALARM, key: `${this.canvasId}:${child.substreamId}`, dueAt: now,
        payload: JSON.stringify({ canvasId: this.canvasId, substreamId: child.substreamId, users }),
      });
      for (const artifact of this.sql.exec<{ artifact_id: string }>(
        `SELECT artifact_id FROM artifact_registry WHERE workstream_id = ?`, this.canvasId,
      ).toArray()) this.host.alarms.schedule({
        kind: CANVAS_ARCHIVE_ARTIFACT_ALARM, key: artifact.artifact_id, dueAt: now,
        payload: JSON.stringify({ canvasId: this.canvasId }),
      });
      this.host.noteCanvasDirectoryChanged(this.canvasId);
      for (const recipient of this.sql.exec<{ recipient_user_id: string }>(
        `SELECT DISTINCT recipient_user_id FROM workspace_activity_items WHERE parent_kind = 'canvas' AND parent_id = ?`,
        this.canvasId,
      ).toArray()) this.host.noteActivityChanged(recipient.recipient_user_id);
    });
  }

  /**
   * Bring a Canvas into existence with no artifacts, open to its creator
   * alone; one a Sidekick run makes also admits whoever the Sidekick is
   * shared with, read live from the Sidekick, so nothing is copied. A replay
   * answers `created: false`.
   */
  create(input: z.input<typeof CanvasCreateRequestSchema>): { created: boolean; canvasId: string } {
    const request = parseRpcInput(CanvasCreateRequestSchema, input, "canvas_create");
    if (request.canvasId !== this.canvasId) throw new Error("canvas_identity_mismatch");
    const now = Date.now();
    return this.host.storage.transactionSync(() => {
      const existing = this.row();
      if (existing) {
        if (existing.workspace_id !== request.workspaceId) throw notFound();
        // A replay is its creator's: anybody else naming the id is refused.
        if (existing.created_by_user_id !== request.createdByUserId) throw idUnavailable();
        if (existing.archived_at !== null) throw new ApiError(409, "canvas_archived", "This Canvas was archived");
        return { created: false, canvasId: this.canvasId };
      }
      if (request.anchored) throw idUnavailable();
      // A run makes one Canvas: a second create for the same run, under any
      // id, answers with the Canvas its first made.
      const made = request.writer ? this.sql.exec<{ canvas_id: string; archived_at: number | null }>(
        `SELECT canvas_id, archived_at FROM canvas_directory WHERE writer_sidekick_id = ? AND writer_run_id = ?`,
        request.writer.sidekickId, request.writer.runId,
      ).toArray()[0] : undefined;
      if (made?.archived_at != null) throw new ApiError(409, "canvas_archived", "This Canvas was archived");
      if (made) return { created: false, canvasId: made.canvas_id };
      if (request.writer && !writerSidekick(this.sql, request.writer.sidekickId)) {
        throw new ApiError(404, "sidekick_not_found", "This Sidekick does not exist");
      }
      this.insertRow({
        workspaceId: request.workspaceId, title: request.title, createdByUserId: request.createdByUserId,
        createdAt: now, updatedAt: now, writer: request.writer ?? null, visibility: "creator",
        authorityGeneration: request.authorityGeneration, titleStatus: request.titleStatus ?? "settled",
      });
      // A run's Canvas is attached to its Sidekick as it is made: the
      // attachment is what lets later runs publish into it.
      if (request.writer) attachSidekickConversation(this.sql, { automationId: request.writer.sidekickId,
        address: { parentKind: "canvas", parentId: this.canvasId, substreamId: "0" }, userId: request.createdByUserId, now });
      return { created: true, canvasId: this.canvasId };
    });
  }

  /** The directory row `create` writes, inside its transaction. */
  private insertRow(row: {
    workspaceId: string; title: string; createdByUserId: string; createdAt: number; updatedAt: number;
    writer: { sidekickId: string; runId: string } | null; visibility: CanvasRow["visibility"]; authorityGeneration: number;
    titleStatus: CanvasRow["title_status"];
  }): void {
    this.sql.exec(
      `INSERT INTO canvas_directory (canvas_id, workspace_id, title, created_by_user_id, created_at, updated_at,
         last_editor_kind, last_editor_id, writer_sidekick_id, writer_run_id, visibility, authority_generation, title_status,
         artifact_visibility)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
      this.canvasId, row.workspaceId, row.title, row.createdByUserId, row.createdAt, row.updatedAt,
      row.writer?.sidekickId ?? null, row.writer?.runId ?? null, row.visibility, row.authorityGeneration, row.titleStatus,
      canvasArtifactVisibilityFloor(row.visibility, "editors"),
    );
    this.host.noteCanvasDirectoryChanged(this.canvasId);
  }

  /** Whether this person may open the Canvas. */
  admits(actor: CanvasActor): boolean {
    const row = this.row();
    return row !== null && canvasReaderAllows(row, actor, this.sql);
  }

  /** Whether this person changes who can open it (`canvasManages`; a writer Sidekick's managers by `sidekickManagerAllows`). */
  manages(row: CanvasRow, actor: CanvasActor): boolean {
    const sidekick = row.writer_sidekick_id ? writerSidekick(this.sql, row.writer_sidekick_id) : null;
    return canvasManages({
      creator: row.created_by_user_id === actor.userId,
      writerManager: sidekick !== null && sidekickManagerAllows(sidekick, actor),
    }, actor.actorRole);
  }

  participantUserIds(): string[] {
    return this.sql.exec<{ user_id: string }>(
      `SELECT user_id FROM canvas_participants WHERE canvas_id = ? ORDER BY added_at, user_id`, this.canvasId,
    ).toArray().map((row) => row.user_id);
  }

  /** The Canvas's artifacts at their current versions, the most recently changed first; none until its Chat publishes one. */
  artifacts(): CanvasArtifact[] {
    return this.sql.exec<{
      id: string; title: string; mime_type: string | null; resource_type: string; current_version: number; updated_at: string;
    }>(
      `SELECT resource.id, resource.title, resource.mime_type, resource.resource_type, resource.current_version,
              resource.updated_at
         FROM canvas_artifacts artifact JOIN resources resource ON resource.id = artifact.resource_id
        WHERE artifact.canvas_id = ? AND ${listedResourceVisibilitySql("resource")}
        ORDER BY resource.updated_at DESC, resource.id`,
      this.canvasId,
    ).toArray().map((row) => ({
      resourceId: row.id,
      title: row.title,
      mimeType: row.mime_type,
      kind: canvasArtifactKind(row.resource_type, row.mime_type),
      version: Math.max(1, Number(row.current_version)),
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
  }

  /**
   * The artifacts as an agent working on the Canvas is told of them: each
   * with the `filePath` a publish names to make a new version of it, and
   * whether it keeps its own database. The path is read back out of the
   * publish identity (`terminal:<canvasId>:<path>`); an artifact a person
   * published, or one whose path was long enough to be stored as a digest,
   * has none an agent can republish.
   */
  agentArtifacts(): (CanvasArtifact & { filePath: string | null; storesData: boolean })[] {
    const prefix = `terminal:${this.canvasId}:`;
    const identities = new Map(this.sql.exec<{ id: string; provider_resource_id: string | null; stateful: number }>(
      `SELECT resource.id, resource.provider_resource_id,
              EXISTS (SELECT 1 FROM artifact_registry registry
                       WHERE registry.resource_id = resource.id AND registry.stateful = 1) AS stateful
         FROM canvas_artifacts artifact JOIN resources resource ON resource.id = artifact.resource_id
        WHERE artifact.canvas_id = ?`,
      this.canvasId,
    ).toArray().map((row) => [row.id, row]));
    return this.artifacts().map((artifact) => {
      const identity = identities.get(artifact.resourceId);
      const path = identity?.provider_resource_id?.startsWith(prefix) ? identity.provider_resource_id.slice(prefix.length) : null;
      return { ...artifact, filePath: path !== null && !path.startsWith("sha256:") ? path : null, storesData: identity?.stateful === 1 };
    });
  }

  /**
   * The Sidekicks attached to this Canvas, by name. Read without a viewer:
   * attaching one is the consent to show its name and state to the Canvas.
   */
  sidekicks(viewer?: CanvasActor): CanvasSidekick[] {
    return this.sql.exec<{
      automation_id: string; title: string; lifecycle: "draft" | "active" | "paused"; appearance_json: string | null; made_here: number;
      scope: string; author_user_id: string; run_as_user_id: string | null; trigger_kinds: string;
    }>(
      `SELECT directory.automation_id, directory.title, directory.lifecycle, directory.appearance_json, attachment.made_here,
              directory.scope, directory.author_user_id, directory.run_as_user_id, ${AUTOMATION_TRIGGER_KINDS_SQL}
         FROM sidekick_conversation_attachments attachment
         JOIN automation_directory directory ON directory.automation_id = attachment.automation_id
        WHERE attachment.parent_kind = 'canvas' AND attachment.parent_id = ? AND attachment.substream_id = '0'
          AND directory.lifecycle <> 'deleted'
        ORDER BY attachment.attached_at, attachment.automation_id`,
      this.canvasId,
    ).toArray().map((row) => {
      const appearance = parsedAppearance(row.appearance_json, "automation_appearance", (code) =>
        logWarn(this.host.env, "automation_directory_appearance_invalid", { automation_id: row.automation_id, code }));
      return CanvasSidekickSchema.parse({
        id: row.automation_id, name: row.title || "New Sidekick", status: row.lifecycle, ...sidekickTriggerSummary(row.trigger_kinds),
        ...(appearance ? { appearance } : {}), madeHere: row.made_here === 1,
        ...(viewer ? { canOpen: sidekickReaderAllows(row, viewer, this.sql) } : {}),
      });
    });
  }

  /**
   * A publish from the Canvas's Chat, or from a run of a Sidekick attached to it,
   * attached this resource to the Canvas's conversation: record it among the
   * Canvas's artifacts and move the row's recency, its last editor and the
   * run that wrote it (`lastWrittenBy`, cleared by any publish not a run's). The first
   * publish of a path is the artifact's version 1, a later one a new version
   * of it, and a publish of another path another artifact; the resource
   * versioning layer records each version, this records only which resources
   * the Canvas holds. A new version tells everyone who pinned the Canvas
   * (`tellCanvasPinners`). Answers `false` for an id that is no Canvas.
   */
  async noteArtifact(input: z.input<typeof CanvasNoteArtifactRequestSchema>): Promise<{ noted: boolean }> {
    const request = parseRpcInput(CanvasNoteArtifactRequestSchema, input, "canvas_note_artifact");
    const row = this.row();
    if (!row || row.workspace_id !== request.workspaceId || row.archived_at !== null) return { noted: false };
    const now = Date.now();
    this.host.storage.transactionSync(() => {
      const publication = this.sql.exec<{ published_at: string | null }>(
        `SELECT COALESCE((SELECT version.captured_at FROM resource_versions version
                           WHERE version.resource_id = resource.id AND (version.version = 1 OR ${artifactNewsCauseSql("version")})
                           ORDER BY version.version DESC LIMIT 1),
                         CASE WHEN resource.current_version <= 1 THEN resource.updated_at END) AS published_at
           FROM resources resource
          WHERE resource.id = ? AND ${listedResourceVisibilitySql("resource")}`, request.resourceId,
      ).toArray()[0];
      this.sql.exec(
        `INSERT INTO canvas_artifacts (canvas_id, resource_id, added_at) VALUES (?, ?, ?)
         ON CONFLICT(canvas_id, resource_id) DO NOTHING`, this.canvasId, request.resourceId, now,
      );
      this.sql.exec(
        `UPDATE canvas_directory SET updated_at = MAX(updated_at, ?), last_editor_kind = ?, last_editor_id = ?,
                last_writer_run_id = ? WHERE canvas_id = ?`,
        publication?.published_at ? Date.parse(publication.published_at) : 0,
        request.editor.kind, request.editor.id, request.runId ?? null, this.canvasId,
      );
      this.host.noteCanvasDirectoryChanged(this.canvasId);
      this.host.noteAttachedCanvasChanged(this.canvasId);
    });
    await tellCanvasPinners({ env: this.env, storage: this.storage, noteActivityChanged: (userId) => this.host.noteActivityChanged(userId) }, {
      workspaceId: row.workspace_id, canvasId: this.canvasId, canvasTitle: row.title, generation: row.authority_generation,
      resourceId: request.resourceId, editor: request.editor,
    });
    return { noted: true };
  }

  /** The Canvas as this reader sees it; not found to anyone it does not admit. */
  detail(input: CanvasActorRequest): CanvasDetail {
    const request = parseRpcInput(CanvasActorRequestSchema, input, "canvas_detail");
    const row = this.assertCanvas(request.workspaceId, request.canvasId);
    if (!canvasReaderAllows(row, request.actor, this.sql)) throw notFound();
    const canManage = this.manages(row, request.actor);
    return CanvasDetailSchema.parse({
      ...canvasSummary(row, canvasAppearanceReporter(this.host.env)),
      runningActivity: canvasRunningActivity(this.sql, [this.canvasId]).get(this.canvasId),
      participantUserIds: this.participantUserIds(),
      artifactVisibility: row.artifact_visibility ?? 'editors',
      artifactUserIds: this.sql.exec<{ user_id: string }>('SELECT user_id FROM canvas_artifact_users WHERE canvas_id=? ORDER BY user_id', this.canvasId).toArray().map(person=>person.user_id),
      sharingRevision: row.sharing_revision,
      artifacts: this.artifacts(),
      sidekicks: this.sidekicks(request.actor),
      canManage,
      // Whoever decides on the people sees the requests waiting on them.
      ...(canManage ? { pendingAccessRequests: pendingAccessRequests(this.sql, this.canvasId) } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Access requests: a member who cannot open the Canvas asks, its deciders
  // approve or deny. `docs/canvas-access-requests.md`.
  // ---------------------------------------------------------------------------

  private accessSubject(row: CanvasRow): CanvasAccessSubject {
    const sidekick = row.writer_sidekick_id ? writerSidekick(this.sql, row.writer_sidekick_id) : null;
    return { canvasId: this.canvasId, workspaceId: row.workspace_id, title: row.title, creatorUserId: row.created_by_user_id,
      writerManagerUserIds: sidekick ? [sidekick.author_user_id, ...(sidekick.run_as_user_id ? [sidekick.run_as_user_id] : [])] : [],
      generation: row.authority_generation };
  }

  /**
   * Whether a member who cannot open the Canvas may ask to: it exists in
   * their Organization, so the answer is `requestable` with their latest
   * request, and never its title. A guest is refused as a non-member before
   * the id is looked at, so a guest learns nothing about which ids exist.
   */
  access(input: CanvasActorRequest): CanvasAccess {
    const request = parseRpcInput(CanvasActorRequestSchema, input, "canvas_access");
    if (request.actor.actorRole === null) throw accessRefusals.notMember();
    const row = this.assertCanvas(request.workspaceId, request.canvasId);
    if (canvasReaderAllows(row, request.actor, this.sql)) throw accessRefusals.open();
    return CanvasAccessSchema.parse({ access: "requestable", title: null, request: latestAccessRequest(this.sql, this.canvasId, request.actor.userId) });
  }

  /** Ask to open the Canvas; a request already waiting is the answer, and one who may open it is told so. */
  async requestAccess(input: CanvasRequestAccessRequest): Promise<CanvasAccessRequestResult> {
    const request = parseRpcInput(CanvasRequestAccessRequestSchema, input, "canvas_request_access");
    if (request.actor.actorRole === null) throw accessRefusals.notMember();
    const row = this.assertCanvas(request.workspaceId, request.canvasId);
    if (canvasReaderAllows(row, request.actor, this.sql)) return CanvasAccessRequestResultSchema.parse({ status: "already_participant" });
    await requestCanvasAccess(this.host, this.accessSubject(row), request.actor.userId, request.request.message);
    return CanvasAccessRequestResultSchema.parse({ status: "pending" });
  }

  /**
   * Approve or deny a waiting request, by someone who manages the Canvas's
   * people (`canvasManages`). Approving seats the requester (source
   * `request`) and tells them; denying tells them who declined, never the
   * title.
   */
  async decideAccess(input: CanvasDecideAccessRequest): Promise<CanvasAccessDecision> {
    const request = parseRpcInput(CanvasDecideAccessRequestSchema, input, "canvas_decide_access");
    const row = this.assertCanvas(request.workspaceId, request.canvasId);
    if (!this.manages(row, request.actor)) throw canvasReaderAllows(row, request.actor, this.sql) ? accessRefusals.notManager() : notFound();
    const state = await settleCanvasAccessRequest(this.host, this.accessSubject(row), {
      requesterUserId: request.requesterUserId, deciderUserId: request.actor.userId,
      state: request.decision === "approve" ? "approved" : "denied", seat: request.decision === "approve",
    });
    if (state === null) throw accessRefusals.settled();
    return CanvasAccessDecisionSchema.parse({ state });
  }

  /**
   * Retitle the Canvas, choose its icon and colour, or both. Anyone it admits
   * may, as anyone it admits may change its artifacts from its Chat; anyone
   * else is told it does not exist. An appearance is merged field by field
   * into what is stored, as a Sidekick's is, so two people picking at once
   * each keep their field. Titles and appearance leave the Canvas's recency alone.
   */
  update(input: CanvasUpdateRequest): CanvasDetail {
    const request = parseRpcInput(CanvasUpdateRequestSchema, input, "canvas_update");
    const appearanceFields = request.appearance === undefined ? 0 : Object.keys(request.appearance).length;
    if (request.title === undefined && appearanceFields === 0) {
      throw new ApiError(400, "canvas_update_empty", "Name a title, an icon or a colour to change");
    }
    const row = this.assertCanvas(request.workspaceId, request.canvasId);
    if (!canvasReaderAllows(row, request.actor, this.sql)) throw notFound();
    const appearance = appearanceFields === 0
      ? null : WorkstreamAppearanceSchema.parse({ ...canvasAppearance(row, canvasAppearanceReporter(this.host.env)), ...request.appearance });
    this.host.storage.transactionSync(() => {
      // A person's title settles it, so a naming pass still in flight leaves it alone.
      if (request.title !== undefined) {
        this.sql.exec(`UPDATE canvas_directory SET title = ?, title_status = 'settled' WHERE canvas_id = ?`,
          request.title, this.canvasId);
      }
      if (appearance !== null) {
        this.sql.exec(`UPDATE canvas_directory SET appearance_json = ? WHERE canvas_id = ?`, JSON.stringify(appearance), this.canvasId);
      }
      this.host.noteAttachedCanvasChanged(this.canvasId);
      this.host.noteCanvasDirectoryChanged(this.canvasId);
    });
    return this.detail({ workspaceId: request.workspaceId, canvasId: request.canvasId, actor: request.actor });
  }

  /**
   * Change who can open the Canvas: its creator, an owner or administrator,
   * or its Sidekick's manager. The list replaces every participant, an
   * invited guest's row among them; a person named must be in the
   * Organization, as a member or a guest.
   */
  async setAudience(input: CanvasSetAudienceRequest): Promise<CanvasDetail> {
    const request = parseRpcInput(CanvasSetAudienceRequestSchema, input, "canvas_set_audience");
    const row = this.assertCanvas(request.workspaceId, request.canvasId);
    // A manager may always open it; anyone else it does not admit is told it does not exist.
    if (!this.manages(row, request.actor)) throw canvasReaderAllows(row, request.actor, this.sql) ? forbidden() : notFound();
    const userIds = [...new Set(request.update.userIds)].filter((userId) => userId !== row.created_by_user_id);
    if (request.update.visibility === "participants" && userIds.length === 0) {
      throw new ApiError(422, "canvas_audience_participants_empty", "Name someone other than the creator to share a Canvas with");
    }
    await assertAudienceInOrganization((workspaceId, userId) => this.host.readRelationship(workspaceId, userId), row.workspace_id,
      userIds, () => new ApiError(422, "canvas_audience_not_member", "Everyone a Canvas is shared with must be in the Organization"));
    const artifactUserIds = [...new Set(request.update.artifactUserIds ?? [])];
    if (request.update.artifactUserIds !== undefined) await assertAudienceInOrganization(
      (workspaceId, userId) => this.host.readRelationship(workspaceId,userId), row.workspace_id, artifactUserIds,
      () => new ApiError(422,'canvas_artifact_audience_not_member','Artifact users must be in the Organization'));
    const now = Date.now();
    this.host.storage.transactionSync(() => {
      const currentRow = this.assertCanvas(request.workspaceId,request.canvasId);
      if (!this.manages(currentRow,request.actor)) throw forbidden();
      if (request.update.expectedRevision !== undefined && request.update.expectedRevision !== (currentRow.sharing_revision)) {
        throw new ApiError(409,'canvas_sharing_changed','Sharing changed. Reload it before saving.');
      }
      const kept = new Set<string>(userIds);
      const current = this.participantUserIds();
      for (const userId of current) {
        if (!kept.has(userId)) this.sql.exec(`DELETE FROM canvas_participants WHERE canvas_id = ? AND user_id = ?`, this.canvasId, userId);
      }
      for (const userId of userIds) {
        this.sql.exec(
          `INSERT INTO canvas_participants (canvas_id, user_id, source, added_by_user_id, added_at)
           VALUES (?, ?, 'added', ?, ?) ON CONFLICT(canvas_id, user_id) DO NOTHING`,
          this.canvasId, userId, request.actor.userId, now,
        );
      }
      // An omitted artifact audience keeps the stored one, still subject to
      // the floor Organization editors set (canvasArtifactVisibilityFloor).
      const requestedArtifacts = request.update.artifactVisibility ?? currentRow.artifact_visibility ?? 'editors';
      const storedArtifacts = canvasArtifactVisibilityFloor(request.update.visibility, requestedArtifacts);
      // Recipient rows kept under "editors" grant nothing; "workspace" honours
      // them. A raise from "editors" must not revive them, so it drops them
      // unless the caller names its recipients.
      const dropRecipients = requestedArtifacts === 'editors' && storedArtifacts !== 'editors';
      if (request.update.artifactUserIds !== undefined || dropRecipients) {
        this.sql.exec('DELETE FROM canvas_artifact_users WHERE canvas_id=?',this.canvasId);
        for (const userId of artifactUserIds) this.sql.exec('INSERT INTO canvas_artifact_users(canvas_id,user_id) VALUES(?,?)',this.canvasId,userId);
      }
      this.sql.exec(`UPDATE canvas_directory SET visibility = ?, artifact_visibility = ? WHERE canvas_id = ?`,
        request.update.visibility, storedArtifacts, this.canvasId);
      this.host.noteCanvasDirectoryChanged(this.canvasId);
      this.host.noteAttachedCanvasChanged(this.canvasId);
    });
    // A request from someone this audience now admits is settled: whoever
    // changed the audience let them in. Only a member asks, and an
    // Organization-wide Canvas admits every member.
    const named = new Set<string>(userIds);
    await settleAdmittedAccessRequests(this.host, this.accessSubject({ ...row, visibility: request.update.visibility }), request.actor.userId,
      (userId) => request.update.visibility === "workspace" || named.has(userId));
    return this.detail({ workspaceId: request.workspaceId, canvasId: request.canvasId, actor: request.actor });
  }

  // ---------------------------------------------------------------------------
  // Guests. A Canvas share is the Channel's share primitive keyed by the
  // Canvas id: an invitation row per address, and on claim a grant row whose
  // directory step adds the guest to the participant list.
  // ---------------------------------------------------------------------------

  private invitations(): ScopeInvitationService {
    const row = this.row();
    return new ScopeInvitationService(this.host.env, this.host.storage, this.canvasId,
      (request, relationship) => {
        const current = this.row();
        const actor = relationship?.status === "active" && relationship.userId === request.userId
          ? { userId: relationship.userId, actorRole: relationship.accessClass === "guest" ? null : relationship.role } : null;
        if (!current || !actor || request.target.kind !== "workstream") return { allowed: false, reason: "grant_required" };
        if (!this.manages(current, actor)) return { allowed: false, reason: "grant_required" };
        // Whether this person reads it as a member of an Organization-wide Canvas, as a Channel answers.
        return { allowed: true, writable: true, grantIds: [this.canvasId],
          workspaceMemberAccess: current.visibility === "workspace" && actor.actorRole !== null };
      },
      () => true,
      (grant, now) => this.applyGrant(grant, now),
      (workspaceId, userId) => this.host.readRelationship(workspaceId, userId),
      (relationship) => this.host.noteRelationship(relationship),
      { targetsReady: () => this.row() !== null, title: () => row?.title || null });
  }

  /** A claimed share's grant: the guest joins the participant list, and a revoked one leaves it. */
  private applyGrant(grant: ScopeGrant, now: number): void {
    if (grant.target.parentId !== this.canvasId || grant.target.kind !== "workstream") return;
    if (grant.active) {
      this.sql.exec(
        `INSERT INTO canvas_participants (canvas_id, user_id, source, added_by_user_id, added_at)
         VALUES (?, ?, 'invitation', ?, ?) ON CONFLICT(canvas_id, user_id) DO NOTHING`,
        this.canvasId, grant.userId, null, now,
      );
      // A guest can open only a list it is on, so a Canvas open to its
      // creator alone becomes one open to its participants.
      this.sql.exec(`UPDATE canvas_directory SET visibility = 'participants' WHERE canvas_id = ? AND visibility = 'creator'`, this.canvasId);
    } else {
      this.sql.exec(`DELETE FROM canvas_participants WHERE canvas_id = ? AND user_id = ? AND source = 'invitation'`,
        this.canvasId, grant.userId);
    }
    this.host.noteCanvasDirectoryChanged(this.canvasId);
    this.host.noteAttachedCanvasChanged(this.canvasId);
  }

  async createInvitations(input: z.input<typeof CreateScopeInvitationsSchema>): Promise<ScopeInvitationResult> {
    const request = parseRpcInput(CreateScopeInvitationsSchema, input, "canvas_create_invitations");
    this.assertCanvas(request.workspaceId, request.parentId);
    return ScopeInvitationResultSchema.parse(await this.invitations().create(request));
  }

  async claimInvitations(input: z.input<typeof ClaimScopeInvitationsSchema>): Promise<ScopeInvitationSummary[]> {
    const request = parseRpcInput(ClaimScopeInvitationsSchema, input, "canvas_claim_invitations");
    this.assertCanvas(request.workspaceId, request.parentId);
    return this.invitations().claim(request);
  }

  async revokeInvitation(input: z.input<typeof RevokeScopeInvitationSchema>): Promise<ScopeInvitationResult> {
    const request = parseRpcInput(RevokeScopeInvitationSchema, input, "canvas_revoke_invitation");
    this.assertCanvas(request.workspaceId, request.parentId);
    return ScopeInvitationResultSchema.parse(await this.invitations().revoke(request));
  }

  async deliverInvitation(invitationId: string): Promise<void> {
    return this.invitations().deliver(invitationId);
  }

  async indexPendingInvitations(): Promise<void> {
    const row = this.row();
    if (row) await this.invitations().indexPending(row.workspace_id);
  }
}

/**
 * One viewer's Canvas list, most recently active first: every Canvas they
 * may open as its creator, a participant, a member of an Organization-wide
 * one, or someone its writer Sidekick is shared with. An owner or
 * administrator may open any Canvas, but their list holds only those they are
 * in, so a private Canvas they never joined does not crowd their sidebar.
 *
 * Unread is the Chat's own read state, as `sidekick_viewer_reads` projects it
 * against the Chat's latest attention ordinal: a manual unread mark or a
 * message past what they saw; a Canvas they have never opened is unread
 * unless they made it. Presence is passed in, from the sockets in the Canvas
 * now.
 */
export function canvasSidebarRows(
  sql: SqlStorage,
  viewer: { userId: string; member: boolean },
  present: ReadonlyMap<string, readonly string[]>,
  limit: number,
  report: InvalidCanvasAppearanceReport,
  /** Only Canvases whose title contains this, ignoring case, across every Canvas rather than the first page. */
  titleQuery: string | null = null,
  /** Reused only within one synchronous publish, across viewers of the same Canvas. */
  activityCache = new Map<string, { backgroundAgents: number; sidekicks: number }>(),
): CanvasSidebarRow[] {
  const rows = sql.exec<CanvasRow & {
    participant: number; unread: number; pinned_position: number | null; artifact_type: string | null; artifact_mime: string | null;
    has_stored_data: number;
    written_run_id: string | null; written_run_number: number | null; written_sidekick_name: string | null;
  }>(
    `SELECT canvas.*, (participant.user_id IS NOT NULL) AS participant,
            CASE
              WHEN reads.user_id IS NULL THEN CASE WHEN canvas.created_by_user_id = ?1 THEN 0 ELSE 1 END
              WHEN reads.manual_unread_from_ordinal IS NOT NULL THEN 1
              WHEN COALESCE(json_extract(chat.effect_json, '$.latestAttentionOrdinal'), 0) > reads.seen_attention_ordinal THEN 1
              -- A version of one of its artifacts somebody else made since this
              -- viewer last read the Chat, as a pinned artifact's news is told.
              WHEN EXISTS (SELECT 1 FROM canvas_artifacts artifact
                  JOIN resource_versions version ON version.resource_id = artifact.resource_id
                 WHERE artifact.canvas_id = canvas.canvas_id
                   AND ${artifactNewsSql("version", "?1", "reads.updated_at")}) THEN 1
              ELSE 0 END AS unread,
            pin.position AS pinned_position,
            newest.resource_type AS artifact_type, newest.mime_type AS artifact_mime,
            EXISTS (SELECT 1 FROM canvas_artifacts artifact
                JOIN artifact_registry registry ON registry.resource_id = artifact.resource_id
                JOIN resources resource ON resource.id = artifact.resource_id
               WHERE artifact.canvas_id = canvas.canvas_id AND registry.stateful = 1
                 AND ${listedResourceVisibilitySql("resource")}) AS has_stored_data,
            -- The run that wrote the newest version, by its primary key; its
            -- number counted as the run's own row counts it (projectRunRow).
            written.run_id AS written_run_id, written_by.title AS written_sidekick_name,
            CASE WHEN written.run_id IS NULL THEN NULL ELSE (SELECT COUNT(*) FROM sidekick_runs earlier
              WHERE earlier.sidekick_id = written.sidekick_id
                AND (earlier.created_at < written.created_at
                  OR (earlier.created_at = written.created_at AND earlier.run_id <= written.run_id))) END AS written_run_number
       FROM canvas_directory canvas
       LEFT JOIN canvas_participants participant ON participant.canvas_id = canvas.canvas_id AND participant.user_id = ?1
       LEFT JOIN sidekick_viewer_reads reads ON reads.sidekick_id = canvas.canvas_id AND reads.user_id = ?1
       LEFT JOIN sidekick_child_projections chat ON chat.sidekick_id = canvas.canvas_id AND chat.substream_id = '0'
       LEFT JOIN workspace_pins pin ON pin.user_id = ?1 AND pin.item_kind = 'canvas' AND pin.item_id = canvas.canvas_id
       LEFT JOIN resources newest ON newest.id = (SELECT resource.id FROM canvas_artifacts artifact
           JOIN resources resource ON resource.id = artifact.resource_id
          WHERE artifact.canvas_id = canvas.canvas_id ORDER BY resource.updated_at DESC, resource.id LIMIT 1)
       LEFT JOIN sidekick_runs written ON canvas.last_editor_kind = 'sidekick'
             AND written.sidekick_id = canvas.last_editor_id AND written.run_id = canvas.last_writer_run_id
       LEFT JOIN automation_directory written_by ON written_by.automation_id = written.sidekick_id
             AND written_by.lifecycle <> 'deleted'
      WHERE canvas.archived_at IS NULL AND (canvas.created_by_user_id = ?1 OR participant.user_id IS NOT NULL
         OR (?2 = 1 AND canvas.visibility = 'workspace') OR canvas.writer_sidekick_id IS NOT NULL)
        AND (?3 IS NULL OR instr(lower(canvas.title), lower(?3)) > 0)
      ORDER BY canvas.updated_at DESC, canvas.canvas_id`,
    viewer.userId, viewer.member ? 1 : 0, titleQuery,
  ).toArray();
  // A writer Sidekick's audience is the one rule not expressed above; the
  // row is admitted by the whole rule, without the administrator's reach.
  const admittedRows: typeof rows = [];
  for (const row of rows) {
    if (admittedRows.length >= limit) break;
    if (canvasAdmits({
      visibility: row.visibility,
      creator: row.created_by_user_id === viewer.userId,
      participant: row.participant === 1,
      writerAudience: row.writer_sidekick_id !== null
        && writerSidekickAdmits(sql, row.writer_sidekick_id, { userId: viewer.userId, actorRole: viewer.member ? "member" : null }),
    }, viewer.member)) admittedRows.push(row);
  }
  // The listed Canvases' attached Sidekicks in one read, as each Canvas's
  // detail lists them (`HostedCanvas.sidekicks`): only the listed ids, by
  // the Canvas index (migration 144), so a run-made Canvas past the list's
  // limit or archived costs nothing here.
  const attached = new Map<string, CanvasSidekick[]>();
  const reader = { userId: viewer.userId, actorRole: viewer.member ? "member" as const : null };
  for (const sidekick of sql.exec<{
    canvas_id: string; automation_id: string; title: string; lifecycle: string; appearance_json: string | null; made_here: number;
    scope: string; author_user_id: string; run_as_user_id: string | null; trigger_kinds: string;
  }>(
    `SELECT attachment.parent_id AS canvas_id, directory.automation_id, directory.title, directory.lifecycle,
            directory.appearance_json, attachment.made_here, directory.scope, directory.author_user_id, directory.run_as_user_id, ${AUTOMATION_TRIGGER_KINDS_SQL}
       FROM sidekick_conversation_attachments attachment
       JOIN automation_directory directory ON directory.automation_id = attachment.automation_id
      WHERE attachment.parent_kind = 'canvas' AND attachment.parent_id IN (SELECT value FROM json_each(?))
        AND attachment.substream_id = '0' AND directory.lifecycle <> 'deleted'
      ORDER BY attachment.attached_at, attachment.automation_id`,
    JSON.stringify(admittedRows.map((row) => row.canvas_id)),
  ).toArray()) {
    const appearance = parsedAppearance(sidekick.appearance_json, "automation_appearance", () => undefined);
    const held = attached.get(sidekick.canvas_id) ?? [];
    held.push(CanvasSidekickSchema.parse({ id: sidekick.automation_id, name: sidekick.title || "New Sidekick", status: sidekick.lifecycle, ...sidekickTriggerSummary(sidekick.trigger_kinds),
      ...(appearance ? { appearance } : {}), madeHere: sidekick.made_here === 1,
      canOpen: sidekickReaderAllows(sidekick, reader, sql) }));
    attached.set(sidekick.canvas_id, held);
  }
  const listed: CanvasSidebarRow[] = [];
  const activity = canvasRunningActivity(sql, admittedRows.map((row) => row.canvas_id), activityCache);
  for (const row of admittedRows) {
    listed.push(CanvasSidebarRowSchema.parse({
      ...canvasSummary(row, report),
      runningActivity: activity.get(row.canvas_id),
      artifactKind: row.artifact_type === null ? null : canvasArtifactKind(row.artifact_type, row.artifact_mime),
      hasStoredData: row.has_stored_data === 1,
      // A deleted Sidekick's run is no run to open.
      lastWrittenBy: row.written_run_id !== null && row.written_sidekick_name !== null && row.last_editor_id !== null
        ? { sidekickId: row.last_editor_id, runId: row.written_run_id, runNumber: row.written_run_number,
          sidekickName: row.written_sidekick_name || "New Sidekick" }
        : null,
      sidekicks: attached.get(row.canvas_id) ?? [],
      unread: row.unread === 1,
      presentUserIds: [...(present.get(row.canvas_id) ?? [])].filter((userId) => userId !== viewer.userId),
      pinnedPosition: row.pinned_position,
      sharedWithMe: row.created_by_user_id !== viewer.userId && row.participant === 1,
    }));
  }
  return listed;
}

/**
 * The Canvases a Sidekick is attached to that this viewer may open, most
 * recently active first: "the Canvases it writes to". Each run's own Canvas
 * is attached as it is made, so this is those and every Canvas it was
 * attached to since.
 */
export function canvasesWrittenBy(
  sql: SqlStorage,
  sidekickId: string,
  actor: { userId: string; actorRole: CanvasActor["actorRole"] },
  report: InvalidCanvasAppearanceReport,
): CanvasSummary[] {
  return sql.exec<CanvasRow>(
    `SELECT canvas.* FROM sidekick_conversation_attachments attachment
       JOIN canvas_directory canvas ON canvas.canvas_id = attachment.parent_id
      WHERE attachment.automation_id = ? AND attachment.parent_kind = 'canvas' AND attachment.substream_id = '0'
      ORDER BY canvas.updated_at DESC, canvas.canvas_id`, sidekickId,
  ).toArray().filter((row) => canvasReaderAllows(row, actor, sql)).map((row) => canvasSummary(row, report));
}

/**
 * For each Sidekick, the Canvases somebody attached it to that this viewer
 * may open, in the order they were attached: the dashboard card's links. A
 * Canvas one of the Sidekick's own runs made is its output, listed on its
 * detail, and is left out here, where it would add one link per run.
 */
export function canvasesAttachedTo(
  sql: SqlStorage,
  actor: { userId: string; actorRole: CanvasActor["actorRole"] },
  sidekickIds: readonly string[],
  report: InvalidCanvasAppearanceReport,
): Map<string, NonNullable<AutomationSummary["attachedCanvases"]>> {
  const attached = new Map<string, NonNullable<AutomationSummary["attachedCanvases"]>>();
  for (const row of sql.exec<CanvasRow & { automation_id: string; artifact_type: string | null; artifact_mime: string | null }>(
    `SELECT canvas.*, attachment.automation_id, newest.resource_type AS artifact_type, newest.mime_type AS artifact_mime
       FROM sidekick_conversation_attachments attachment
       JOIN canvas_directory canvas ON canvas.canvas_id = attachment.parent_id
       LEFT JOIN resources newest ON newest.id = (SELECT resource.id FROM canvas_artifacts artifact
           JOIN resources resource ON resource.id = artifact.resource_id
          WHERE artifact.canvas_id = canvas.canvas_id ORDER BY resource.updated_at DESC, resource.id LIMIT 1)
      WHERE attachment.automation_id IN (SELECT value FROM json_each(?))
        AND attachment.parent_kind = 'canvas' AND attachment.substream_id = '0' AND canvas.archived_at IS NULL
        AND (canvas.writer_sidekick_id IS NULL OR canvas.writer_sidekick_id <> attachment.automation_id)
      ORDER BY attachment.attached_at, attachment.parent_id`,
    JSON.stringify(sidekickIds),
  ).toArray()) {
    if (!canvasReaderAllows(row, actor, sql)) continue;
    const held = attached.get(row.automation_id) ?? [];
    held.push({ id: row.canvas_id, title: row.title, appearance: canvasAppearance(row, report),
      artifactKind: row.artifact_type === null ? null : canvasArtifactKind(row.artifact_type, row.artifact_mime) });
    attached.set(row.automation_id, held);
  }
  return attached;
}
