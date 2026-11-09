import { z } from "zod";

import { IdSchema, UserIdSchema, WorkspaceIdSchema, WorkstreamAppearancePatchSchema, WorkstreamAppearanceSchema, type WorkstreamAppearance } from "@rally/contracts";
import { logWarn } from "../observability/logger";
import { parsedAppearance } from "./sidekick-directory-sql";
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
  CanvasSummarySchema,
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
import { sidekickManagerAllows, sidekickReaderAllows } from "./hosted-sidekick";
import { ScopeInvitationService } from "./scope-invitation-service";
import { artifactNewsSql } from "./workspace-pin-storage";
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
import { CANVAS_NAMING_ALARM_KIND, UNTITLED_CANVAS } from "./canvas-schema";
import type { ScheduledAlarmStore } from "./scheduled-alarms";
import { createMessageObjectPort } from "../runtime/message-port";
import { canvasTitleFromOpening } from "../services/canvas-naming";

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

/**
 * A Canvas made in place from a Thread that has artifacts, keeping the
 * Thread's id (`services/thread-conversion-service.ts`): the directory row
 * the Thread's own rows decide, who was in it, and the artifacts it made or
 * linked. `WorkspaceDO.convertThreadToCanvas` reads them; this writes them.
 */
export const CanvasFromThreadRequestSchema = z.strictObject({
  ...Addressed,
  title: z.string().max(300),
  createdByUserId: UserIdSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  visibility: z.enum(["participants", "workspace"]),
  authorityGeneration: z.number().int().positive(),
  participants: z.array(z.strictObject({ userId: UserIdSchema, addedAt: z.number().int().nonnegative() })),
  artifacts: z.array(z.strictObject({ resourceId: IdSchema, addedAt: z.number().int().nonnegative() })),
});

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
  /** The run whose publish made the newest version, a `sidekick` editor's (migration 155). */
  last_writer_run_id: string | null;
  visibility: "creator" | "participants" | "workspace";
  authority_generation: number;
  /** `naming` while a Canvas made with no title waits for its opening message's (migration 149). */
  title_status: "naming" | "settled";
  /** The chosen icon and colour, `WorkstreamAppearanceSchema` JSON; null until someone chooses (migration 153). */
  appearance_json: string | null;
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

/** Whether this person is on a Canvas's participant list. */
export function canvasParticipant(sql: SqlStorage, canvasId: string, userId: string): boolean {
  return sql.exec(`SELECT 1 FROM canvas_participants WHERE canvas_id = ? AND user_id = ? LIMIT 1`, canvasId, userId)
    .toArray().length > 0;
}

/**
 * The read rule over a directory row: `canvasAdmits` over its visibility, its
 * creator, its participant list, its writer Sidekick's audience as it stands
 * now, and the actor's role (an owner or administrator manages, so opens,
 * every Canvas). A guest has no `actorRole`, so Organization visibility never
 * admits one.
 */
export function canvasReaderAllows(row: CanvasRow, actor: { userId: string; actorRole: CanvasActor["actorRole"] }, sql: SqlStorage): boolean {
  return canvasAdmits({
    visibility: row.visibility,
    creator: row.created_by_user_id === actor.userId,
    participant: canvasParticipant(sql, row.canvas_id, actor.userId),
    writerAudience: row.writer_sidekick_id !== null && writerSidekickAdmits(sql, row.writer_sidekick_id, actor),
  }, actor.actorRole !== null, actor.actorRole === "owner" || actor.actorRole === "admin");
}

function writerSidekick(sql: SqlStorage, sidekickId: string) {
  return sql.exec<{
    automation_id: string; scope: string; author_user_id: string; run_as_user_id: string | null; lifecycle: string;
  }>(
    `SELECT automation_id, scope, author_user_id, run_as_user_id, lifecycle FROM automation_directory WHERE automation_id = ?`,
    sidekickId,
  ).toArray()[0] ?? null;
}

export function writerSidekickAdmits(sql: SqlStorage, sidekickId: string, actor: { userId: string; actorRole: CanvasActor["actorRole"] }): boolean {
  const sidekick = writerSidekick(sql, sidekickId);
  return sidekick !== null && sidekickReaderAllows(sidekick, actor, sql);
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
    return row ? { workspaceId: row.workspace_id, authorityGeneration: row.authority_generation, archived: false } : null;
  }

  protected assertParent(workspaceId: string, parentId: string): HostedConversationIdentity {
    const row = this.assertCanvas(workspaceId, parentId);
    return { workspaceId: row.workspace_id, authorityGeneration: row.authority_generation, archived: false };
  }

  /**
   * `canvasReaderAllows`, with the person's role from their Organization
   * relationship: an owner or administrator opens every Canvas, and a guest
   * (who asks with `requireGrantAuthority`) is never admitted by Organization
   * visibility.
   */
  protected async admitsViewer(request: ConversationParentAuthorizeViewerRequest): Promise<boolean> {
    const row = this.row()!;
    const relationship = request.requireGrantAuthority ? null : await this.host.readRelationship(row.workspace_id, request.userId);
    // Only an active member has a role: a guest asks on the grant path, and
    // a missing or inactive relationship is no membership at all.
    const actorRole = relationship?.status === "active" && relationship.accessClass === "member"
      ? relationship.role ?? "member" : null;
    return canvasReaderAllows(this.row() ?? row, { userId: request.userId, actorRole }, this.sql);
  }

  protected onViewerReadChanged(userId: string): void {
    this.host.noteCanvasReadChanged(userId);
  }

  /**
   * A new message in the Chat is activity: the Canvas moves up the recency
   * list, and its row's unread state moves for anyone who has read it.
   */
  protected onChildProjection(substreamId: string, effect: DirectoryCommonEffect,
    prior: PriorChildProjection | null, now: number): void {
    if (substreamId !== "0") return;
    // No ordinal and ordinal 0 are both an empty Chat: the provisioning
    // projection of a Canvas nobody has written in is not activity, so it
    // does not move the Canvas up the recency list.
    const before = prior?.latestAttentionOrdinal ?? 0;
    const latest = effect.latestAttentionOrdinal ?? 0;
    if (before === latest) return;
    // The Chat's first message, in a Canvas a person made with no title that
    // nobody has retitled since: it starts naming now, in this write, so an
    // empty Canvas reads as its title rather than as a naming skeleton that
    // waits for a message that may never come.
    this.sql.exec(
      `UPDATE canvas_directory
          SET updated_at = MAX(updated_at, ?1),
              title_status = CASE WHEN ?3 = 0 AND ?4 >= 1 AND title_status = 'settled' AND title = ?5
                                       AND writer_sidekick_id IS NULL THEN 'naming' ELSE title_status END
        WHERE canvas_id = ?2`,
      now, this.canvasId, before, latest, UNTITLED_CANVAS,
    );
    this.host.noteCanvasDirectoryChanged(this.canvasId);
    // A Canvas waiting for a title: the naming pass reads its first message.
    // Armed again by a later message before it runs, which is the same entry.
    if (latest >= 1 && this.row()?.title_status === "naming") {
      this.host.alarms.schedule({ kind: CANVAS_NAMING_ALARM_KIND, key: this.canvasId, dueAt: now }, now);
    }
  }

  /**
   * Title a Canvas made with no title from the message that opened its Chat
   * (`canvasTitleFromOpening`), through the write a retitle makes, so the
   * list and the detail move together. Only while it is still `naming`: a
   * person who retitled it first settled it, and their title stands. A model
   * that answers nothing settles it as it is, rather than leaving it waiting.
   */
  async nameFromOpening(): Promise<void> {
    const row = this.row();
    if (!row || row.title_status !== "naming") return;
    const [opening] = await createMessageObjectPort(this.env, row.workspace_id, this.canvasId)
      .saidMessages({ messageTypes: { include: ["text"] }, order: "oldest", limit: 1, peopleOnly: true });
    // A first message of attachments alone says nothing to title from; the
    // Canvas waits, and a person's next text message arms the entry again.
    if (!opening) return;
    const title = await canvasTitleFromOpening(this.env, {
      workspaceId: row.workspace_id, canvasId: this.canvasId, userId: opening.author_user_id, opening: opening.text_content,
    });
    this.host.storage.transactionSync(() => {
      const settled = this.sql.exec(
        `UPDATE canvas_directory SET title = COALESCE(?, title), title_status = 'settled', updated_at = ?
          WHERE canvas_id = ? AND title_status = 'naming' RETURNING canvas_id`,
        title, Date.now(), this.canvasId,
      ).toArray().length === 1;
      if (settled) this.host.noteCanvasDirectoryChanged(this.canvasId);
    });
  }

  /** What resource and search authorization decide a Canvas reader from (`canvasAdmits`). */
  async readAuthorizationFacts(input: ConversationAuthorizationRequest) {
    const request = parseRpcInput(ConversationAuthorizationRequestSchema, input, "canvas_read_authorization_facts");
    const initial = this.row();
    if (!initial) return { exists: false as const, validatedAt: Date.now() };
    this.assertCanvas(request.workspaceId, request.parentId);
    const relationship = request.relationship ?? await this.host.readRelationship(initial.workspace_id, request.userId);
    // Read again after the await: the row is what the facts describe.
    const row = this.row() ?? initial;
    // A Sidekick's Organization scope admits a member and no guest, so the
    // writer's audience is decided for the relationship in hand.
    const member = relationship?.status === "active" && relationship.accessClass === "member";
    return {
      exists: true as const,
      visibility: row.visibility,
      creator: row.created_by_user_id === request.userId,
      participant: canvasParticipant(this.sql, this.canvasId, request.userId),
      writerAudience: row.writer_sidekick_id !== null && writerSidekickAdmits(this.sql, row.writer_sidekick_id,
        { userId: request.userId, actorRole: member ? "member" : null }),
      administrator: member && (relationship.role === "owner" || relationship.role === "admin"),
      children: this.childRegistry().map((child) => child.substreamId),
      revision: JSON.stringify([row.authority_generation, row.updated_at]),
      validatedAt: Date.now(),
    };
  }

  row(): CanvasRow | null {
    return this.sql.exec<CanvasRow>(
      `SELECT canvas_id, workspace_id, title, created_by_user_id, created_at, updated_at, last_editor_kind,
              last_editor_id, writer_sidekick_id, writer_run_id, last_writer_run_id, visibility, authority_generation,
              title_status, appearance_json
         FROM canvas_directory WHERE canvas_id = ?`,
      this.canvasId,
    ).toArray()[0] ?? null;
  }

  /** The row, refused as not found for another Organization's id. */
  assertCanvas(workspaceId: string, canvasId: string): CanvasRow {
    const row = this.row();
    if (!row || row.workspace_id !== workspaceId || canvasId !== this.canvasId) throw notFound();
    return row;
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
        return { created: false, canvasId: this.canvasId };
      }
      if (request.anchored) throw idUnavailable();
      // A run makes one Canvas: a second create for the same run, under any
      // id, answers with the Canvas its first made.
      const made = request.writer ? this.sql.exec<{ canvas_id: string }>(
        `SELECT canvas_id FROM canvas_directory WHERE writer_sidekick_id = ? AND writer_run_id = ?`,
        request.writer.sidekickId, request.writer.runId,
      ).toArray()[0] : undefined;
      if (made) return { created: false, canvasId: made.canvas_id };
      if (request.writer && !writerSidekick(this.sql, request.writer.sidekickId)) {
        throw new ApiError(404, "sidekick_not_found", "This Sidekick does not exist");
      }
      this.insertRow({
        workspaceId: request.workspaceId, title: request.title, createdByUserId: request.createdByUserId,
        createdAt: now, updatedAt: now, writer: request.writer ?? null, visibility: "creator",
        authorityGeneration: request.authorityGeneration, titleStatus: request.titleStatus ?? "settled",
      });
      return { created: true, canvasId: this.canvasId };
    });
  }

  /**
   * Make this Canvas from the Thread of the same id, with the rows the
   * Thread's directory decided, in one transaction. An existing row is the
   * resume marker of an earlier pass and answers `created: false` with
   * nothing written; one in another Organization is not found.
   */
  createFromThread(input: z.input<typeof CanvasFromThreadRequestSchema>): { created: boolean } {
    const request = parseRpcInput(CanvasFromThreadRequestSchema, input, "canvas_create_from_thread");
    if (request.canvasId !== this.canvasId) throw new Error("canvas_identity_mismatch");
    return this.host.storage.transactionSync(() => {
      const existing = this.row();
      if (existing) {
        if (existing.workspace_id !== request.workspaceId) throw notFound();
        return { created: false };
      }
      this.insertRow({ ...request, writer: null, titleStatus: "settled" });
      for (const participant of request.participants) {
        if (participant.userId === request.createdByUserId) continue;
        this.sql.exec(
          `INSERT INTO canvas_participants (canvas_id, user_id, source, added_by_user_id, added_at)
           VALUES (?, ?, 'added', NULL, ?) ON CONFLICT(canvas_id, user_id) DO NOTHING`,
          this.canvasId, participant.userId, participant.addedAt,
        );
      }
      for (const artifact of request.artifacts) {
        this.sql.exec(
          `INSERT INTO canvas_artifacts (canvas_id, resource_id, added_at) VALUES (?, ?, ?)
           ON CONFLICT(canvas_id, resource_id) DO NOTHING`, this.canvasId, artifact.resourceId, artifact.addedAt,
        );
      }
      return { created: true };
    });
  }

  /** The directory row both creates write, inside their transaction. */
  private insertRow(row: {
    workspaceId: string; title: string; createdByUserId: string; createdAt: number; updatedAt: number;
    writer: { sidekickId: string; runId: string } | null; visibility: CanvasRow["visibility"]; authorityGeneration: number;
    titleStatus: CanvasRow["title_status"];
  }): void {
    this.sql.exec(
      `INSERT INTO canvas_directory (canvas_id, workspace_id, title, created_by_user_id, created_at, updated_at,
         last_editor_kind, last_editor_id, writer_sidekick_id, writer_run_id, visibility, authority_generation, title_status)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
      this.canvasId, row.workspaceId, row.title, row.createdByUserId, row.createdAt, row.updatedAt,
      row.writer?.sidekickId ?? null, row.writer?.runId ?? null, row.visibility, row.authorityGeneration, row.titleStatus,
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
   * A publish from the Canvas's Chat, or from a run of its writer Sidekick,
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
    if (!row || row.workspace_id !== request.workspaceId) return { noted: false };
    const now = Date.now();
    this.host.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO canvas_artifacts (canvas_id, resource_id, added_at) VALUES (?, ?, ?)
         ON CONFLICT(canvas_id, resource_id) DO NOTHING`, this.canvasId, request.resourceId, now,
      );
      this.sql.exec(
        `UPDATE canvas_directory SET updated_at = MAX(updated_at, ?), last_editor_kind = ?, last_editor_id = ?,
                last_writer_run_id = ? WHERE canvas_id = ?`,
        now, request.editor.kind, request.editor.id, request.runId ?? null, this.canvasId,
      );
      this.host.noteCanvasDirectoryChanged(this.canvasId);
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
      participantUserIds: this.participantUserIds(),
      artifacts: this.artifacts(),
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
   * each keep their field. Choosing an appearance is not activity, so it does
   * not move `updated_at` and the Canvas keeps its place in the recency list.
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
        this.sql.exec(`UPDATE canvas_directory SET title = ?, title_status = 'settled', updated_at = ? WHERE canvas_id = ?`,
          request.title, Date.now(), this.canvasId);
      }
      if (appearance !== null) {
        this.sql.exec(`UPDATE canvas_directory SET appearance_json = ? WHERE canvas_id = ?`, JSON.stringify(appearance), this.canvasId);
      }
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
    const now = Date.now();
    this.host.storage.transactionSync(() => {
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
      this.sql.exec(`UPDATE canvas_directory SET visibility = ?, updated_at = ? WHERE canvas_id = ?`,
        request.update.visibility, now, this.canvasId);
      this.host.noteCanvasDirectoryChanged(this.canvasId);
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
): CanvasSidebarRow[] {
  const rows = sql.exec<CanvasRow & {
    participant: number; unread: number; pinned_position: number | null; artifact_type: string | null; artifact_mime: string | null;
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
      WHERE canvas.created_by_user_id = ?1 OR participant.user_id IS NOT NULL
         OR (?2 = 1 AND canvas.visibility = 'workspace') OR canvas.writer_sidekick_id IS NOT NULL
      ORDER BY canvas.updated_at DESC, canvas.canvas_id`,
    viewer.userId, viewer.member ? 1 : 0,
  ).toArray();
  const listed: CanvasSidebarRow[] = [];
  for (const row of rows) {
    if (listed.length >= limit) break;
    // A writer Sidekick's audience is the one rule not expressed above; the
    // row is admitted by the whole rule, without the administrator's reach.
    if (!canvasAdmits({
      visibility: row.visibility,
      creator: row.created_by_user_id === viewer.userId,
      participant: row.participant === 1,
      writerAudience: row.writer_sidekick_id !== null
        && writerSidekickAdmits(sql, row.writer_sidekick_id, { userId: viewer.userId, actorRole: viewer.member ? "member" : null }),
    }, viewer.member)) continue;
    listed.push(CanvasSidebarRowSchema.parse({
      ...canvasSummary(row, report),
      artifactKind: row.artifact_type === null ? null : canvasArtifactKind(row.artifact_type, row.artifact_mime),
      // A deleted Sidekick's run is no run to open.
      lastWrittenBy: row.written_run_id !== null && row.written_sidekick_name !== null && row.last_editor_id !== null
        ? { sidekickId: row.last_editor_id, runId: row.written_run_id, runNumber: row.written_run_number,
          sidekickName: row.written_sidekick_name || "New Sidekick" }
        : null,
      unread: row.unread === 1,
      presentUserIds: [...(present.get(row.canvas_id) ?? [])].filter((userId) => userId !== viewer.userId),
      pinnedPosition: row.pinned_position,
      sharedWithMe: row.created_by_user_id !== viewer.userId && row.participant === 1,
    }));
  }
  return listed;
}

/** The Canvases a Sidekick writes that this viewer may open, most recently active first: "the Canvases it writes to". */
export function canvasesWrittenBy(
  sql: SqlStorage,
  sidekickId: string,
  actor: { userId: string; actorRole: CanvasActor["actorRole"] },
  report: InvalidCanvasAppearanceReport,
): CanvasSummary[] {
  return sql.exec<CanvasRow>(
    `SELECT * FROM canvas_directory WHERE writer_sidekick_id = ? ORDER BY updated_at DESC, canvas_id`, sidekickId,
  ).toArray().filter((row) => canvasReaderAllows(row, actor, sql)).map((row) => canvasSummary(row, report));
}
