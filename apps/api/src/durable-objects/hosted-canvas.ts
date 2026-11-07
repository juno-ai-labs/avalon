import { z } from "zod";

import { IdSchema, UserIdSchema, WorkspaceIdSchema } from "@rally/contracts";
import {
  CanvasAudienceUpdateSchema,
  CanvasDetailSchema,
  CanvasSummarySchema,
  type CanvasArtifact,
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

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { parseRpcInput } from "../lib/rpc-input";
import { listedResourceVisibilitySql } from "../services/resource-listing";
import { canvasAdmits, canvasManages } from "../services/authorization-policy";
import { sidekickReaderAllows } from "./hosted-sidekick";
import { ScopeInvitationService } from "./scope-invitation-service";

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
});
export type CanvasCreateRequest = z.infer<typeof CanvasCreateRequestSchema>;

export const CanvasActorRequestSchema = z.strictObject({ ...Addressed, actor: CanvasActorSchema });
export type CanvasActorRequest = z.infer<typeof CanvasActorRequestSchema>;

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
  visibility: "creator" | "participants" | "workspace";
  authority_generation: number;
}

/** What a hosted Canvas needs from the Organization object that holds it. */
export interface HostedCanvasHost {
  env: Env;
  storage: DurableObjectStorage;
  readRelationship(workspaceId: string, userId: string): Promise<WorkspaceRelationship | null>;
  noteRelationship(relationship: WorkspaceRelationship): void;
  /** Inside the transaction that changed a Canvas's row or its participants: the sidebar list's waterline. */
  noteCanvasDirectoryChanged(canvasId: string): void;
}

function forbidden(): ApiError {
  return new ApiError(403, "canvas_forbidden", "You cannot change who can open this Canvas");
}

function notFound(): ApiError {
  return new ApiError(404, "canvas_not_found", "This Canvas does not exist");
}

/** The row's public shape. */
export function canvasSummary(row: CanvasRow): CanvasSummary {
  return CanvasSummarySchema.parse({
    id: row.canvas_id,
    title: row.title,
    createdByUserId: row.created_by_user_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    lastEditor: row.last_editor_kind ? { kind: row.last_editor_kind, id: row.last_editor_id } : null,
    writerSidekickId: row.writer_sidekick_id,
    visibility: row.visibility,
  });
}

/** Whether this person is on a Canvas's participant list. */
export function canvasParticipant(sql: SqlStorage, canvasId: string, userId: string): boolean {
  return sql.exec(`SELECT 1 FROM canvas_participants WHERE canvas_id = ? AND user_id = ? LIMIT 1`, canvasId, userId)
    .toArray().length > 0;
}

/**
 * The read rule over a directory row: `canvasAdmits` over its visibility, its
 * creator, its participant list and its writer Sidekick's audience. A guest
 * has no `actorRole`, so Organization visibility never admits one.
 */
export function canvasReaderAllows(row: CanvasRow, actor: CanvasActor, sql: SqlStorage): boolean {
  return canvasAdmits({
    visibility: row.visibility,
    creator: row.created_by_user_id === actor.userId,
    participant: canvasParticipant(sql, row.canvas_id, actor.userId),
    writerAudience: row.writer_sidekick_id !== null && writerSidekickAdmits(sql, row.writer_sidekick_id, actor),
  }, actor.actorRole !== null);
}

function writerSidekick(sql: SqlStorage, sidekickId: string) {
  return sql.exec<{
    automation_id: string; scope: string; author_user_id: string; run_as_user_id: string | null; lifecycle: string;
  }>(
    `SELECT automation_id, scope, author_user_id, run_as_user_id, lifecycle FROM automation_directory WHERE automation_id = ?`,
    sidekickId,
  ).toArray()[0] ?? null;
}

function writerSidekickAdmits(sql: SqlStorage, sidekickId: string, actor: CanvasActor): boolean {
  const sidekick = writerSidekick(sql, sidekickId);
  return sidekick !== null && sidekickReaderAllows(sidekick, actor, sql);
}

/**
 * One Canvas's parent state, scoped to a `canvas_id` inside `WorkspaceDO`'s
 * SQLite: its directory row, who may open it, and the share invitations that
 * add guests to it. Constructed per call, like `HostedSidekick`.
 */
export class HostedCanvas {
  constructor(private readonly host: HostedCanvasHost, readonly canvasId: string) {}

  private get sql(): SqlStorage {
    return this.host.storage.sql;
  }

  row(): CanvasRow | null {
    return this.sql.exec<CanvasRow>(
      `SELECT canvas_id, workspace_id, title, created_by_user_id, created_at, updated_at, last_editor_kind,
              last_editor_id, writer_sidekick_id, writer_run_id, visibility, authority_generation
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
   * Bring a Canvas into existence with no artifacts: its creator alone can
   * open it, or, for one a Sidekick run makes, whoever the Sidekick is shared
   * with (an Organization Sidekick's Canvas is open to the Organization; any
   * other's starts with the Sidekick's people list). A replay answers
   * `created: false`.
   */
  create(input: z.input<typeof CanvasCreateRequestSchema>): { created: boolean } {
    const request = parseRpcInput(CanvasCreateRequestSchema, input, "canvas_create");
    if (request.canvasId !== this.canvasId) throw new Error("canvas_identity_mismatch");
    const now = Date.now();
    return this.host.storage.transactionSync(() => {
      const existing = this.row();
      if (existing) {
        if (existing.workspace_id !== request.workspaceId) throw notFound();
        return { created: false };
      }
      const sidekick = request.writer ? writerSidekick(this.sql, request.writer.sidekickId) : null;
      if (request.writer && !sidekick) throw new ApiError(404, "sidekick_not_found", "This Sidekick does not exist");
      const people = sidekick && sidekick.scope !== "workspace"
        ? [...new Set([sidekick.author_user_id, sidekick.run_as_user_id, ...this.sql.exec<{ user_id: string }>(
          `SELECT user_id FROM sidekick_audience WHERE sidekick_id = ?`, sidekick.automation_id,
        ).toArray().map((row) => row.user_id)].filter((userId): userId is string => !!userId && userId !== request.createdByUserId))]
        : [];
      const visibility = sidekick?.scope === "workspace" ? "workspace" : people.length > 0 ? "participants" : "creator";
      this.sql.exec(
        `INSERT INTO canvas_directory (canvas_id, workspace_id, title, created_by_user_id, created_at, updated_at,
           last_editor_kind, last_editor_id, writer_sidekick_id, writer_run_id, visibility, authority_generation)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
        this.canvasId, request.workspaceId, request.title, request.createdByUserId, now, now,
        request.writer?.sidekickId ?? null, request.writer?.runId ?? null, visibility, request.authorityGeneration,
      );
      for (const userId of people) {
        this.sql.exec(
          `INSERT INTO canvas_participants (canvas_id, user_id, source, added_by_user_id, added_at) VALUES (?, ?, 'sidekick', NULL, ?)`,
          this.canvasId, userId, now,
        );
      }
      this.host.noteCanvasDirectoryChanged(this.canvasId);
      return { created: true };
    });
  }

  /** Whether this person may open the Canvas. */
  admits(actor: CanvasActor): boolean {
    const row = this.row();
    return row !== null && canvasReaderAllows(row, actor, this.sql);
  }

  /** Whether this person changes who can open it (`canvasManages`). */
  manages(row: CanvasRow, actor: CanvasActor): boolean {
    const sidekick = row.writer_sidekick_id ? writerSidekick(this.sql, row.writer_sidekick_id) : null;
    return canvasManages({
      creator: row.created_by_user_id === actor.userId,
      writerManager: sidekick !== null && (sidekick.author_user_id === actor.userId || sidekick.run_as_user_id === actor.userId),
    }, actor.actorRole);
  }

  participantUserIds(): string[] {
    return this.sql.exec<{ user_id: string }>(
      `SELECT user_id FROM canvas_participants WHERE canvas_id = ? ORDER BY added_at, user_id`, this.canvasId,
    ).toArray().map((row) => row.user_id);
  }

  /** The Canvas's artifacts at their current versions, the most recently changed first. */
  artifacts(): CanvasArtifact[] {
    return this.sql.exec<{
      id: string; title: string; mime_type: string | null; resource_type: string; current_version: number; updated_at: number;
    }>(
      `SELECT resource.id, resource.title, resource.mime_type, resource.resource_type, resource.current_version,
              artifact.updated_at
         FROM canvas_artifacts artifact JOIN resources resource ON resource.id = artifact.resource_id
        WHERE artifact.canvas_id = ? AND ${listedResourceVisibilitySql("resource")}
        ORDER BY artifact.updated_at DESC, resource.id`,
      this.canvasId,
    ).toArray().map((row) => ({
      resourceId: row.id,
      title: row.title.slice(0, 300),
      mimeType: row.mime_type === null ? null : row.mime_type.slice(0, 160),
      kind: row.resource_type === "generated_site" ? "site" as const
        : row.mime_type === "application/zip" ? "archive" as const : "file" as const,
      version: Math.max(1, Number(row.current_version)),
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
  }

  /** The Canvas as this reader sees it; not found to anyone it does not admit. */
  detail(input: CanvasActorRequest): CanvasDetail {
    const request = parseRpcInput(CanvasActorRequestSchema, input, "canvas_detail");
    const row = this.assertCanvas(request.workspaceId, request.canvasId);
    if (!canvasReaderAllows(row, request.actor, this.sql)) throw notFound();
    return CanvasDetailSchema.parse({
      ...canvasSummary(row),
      participantUserIds: this.participantUserIds(),
      artifacts: this.artifacts(),
      canManage: this.manages(row, request.actor),
    });
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
    if (!canvasReaderAllows(row, request.actor, this.sql)) throw notFound();
    if (!this.manages(row, request.actor)) throw forbidden();
    const userIds = [...new Set(request.update.userIds)].filter((userId) => userId !== row.created_by_user_id);
    if (request.update.visibility === "participants" && userIds.length === 0) {
      throw new ApiError(422, "canvas_audience_participants_empty", "Name someone other than the creator to share a Canvas with");
    }
    const relationships = await Promise.all(userIds.map((userId) => this.host.readRelationship(row.workspace_id, userId)));
    if (relationships.some((relationship) => relationship?.status !== "active")) {
      throw new ApiError(422, "canvas_audience_not_member", "Everyone a Canvas is shared with must be in the Organization");
    }
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
        if (!canvasReaderAllows(current, actor, this.sql) || !this.manages(current, actor)) {
          return { allowed: false, reason: "grant_required" };
        }
        return { allowed: true, writable: true, grantIds: [this.canvasId], workspaceMemberAccess: actor.actorRole !== null };
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
