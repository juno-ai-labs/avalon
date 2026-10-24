import { promoteWorkspaceGuest } from "./workspace-relationship-service";
import type { Region } from "@rally/contracts/regions";
import { MemberPreferencesSchema, PersonalPresentationSchema, type MemberPreferencesUpdate, type UserTimezone } from '@rally/contracts';
import {
  AssignableMemberRoleSchema,
  asUserId,
  asWorkspaceId,
  type AssignableMemberRole,
  type UserId,
  type PendingWorkspaceInvitation,
  type WorkspaceInvitation,
  type WorkspaceInvitationPreview,
  type WorkspaceInvitationRole,
  type MemoryForgetResponse,
  type MemoryReview,
} from "@rally/contracts";
import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import type { OrganizationUsage, PlanId } from "@rally/contracts/usage";
import { readOrganizationUsage, setWorkspacePlan } from "./usage-metering";
import { newId, nowIso } from "@rally/db";
import { downloadGrantUrl, issueDownloadGrant, revokeDownloadGrant, revokeDownloadGrantsForInvitation } from "@rally/db/private-access";
import type { AuthContext, Env, IdentityAuthContext } from "../env";
import { ApiError } from "../lib/api-error";
import { workspaceSlug } from "../lib/workspace-slug";
import { randomToken, sha256 } from "../lib/crypto";
import { diagnosticErrorCode, logWarn } from "../observability/logger";
import {
  sendWorkspaceInvitationEmail,
  sendWorkspaceInvitationResolutionEmail,
  type InvitationEmailDelivery,
} from "./invitation-email-service";
import { dispatchWorkspaceRelationshipChanges } from "./workspace-relationship-delivery";
import { publishWorkspaceSync, seatSpaceInvitee } from "./workspace-realtime-service";
import { SlackAgentService } from "./slack-agent-service";
import { rebuildDigestSchedulesForTimezone } from "./digest-service";
import { workspaceDOName } from "../durable-objects/names";
import { PersonalSystemPromptRecordSchema } from "../durable-objects/personal-system-prompt";
import { forgetReviewedMemory, readMemoryReview } from "./memory-review-service";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import {
  emitProductUsageTelemetry,
  resourceTelemetryEventId,
  telemetryJourneyDuration,
} from "../telemetry/product-usage";
import { apiTelemetryEnvelope, emitAuthenticatedApiTelemetry } from "../telemetry/api-emitter";

interface InvitationRow {
  id: string;
  workspace_id: string;
  workspace_name: string;
  workspace_region: Region;
  email: string;
  role: WorkspaceInvitationRole;
  invited_by_name: string;
  invited_by_email: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_by_user_id: string | null;
  revoked_at: string | null;
  abandoned_at: string | null;
  created_at: string;
}

async function emitInvitationTerminal(
  env: Env,
  invitation: InvitationRow,
  input: {
    userId: UserId;
    action: "created" | "revoked" | "accepted" | "declined";
    deliveryResult: "success" | "failed" | "not_applicable";
    workspaceBound: boolean;
  },
): Promise<void> {
  const properties = {
    invitationId: invitation.id,
    action: input.action,
    role: invitation.role,
    deliveryResult: input.deliveryResult,
    timeToTerminal: telemetryJourneyDuration(Math.max(0, Date.now() - Date.parse(invitation.created_at))),
  } as const;
  const namespace = { created: 11, revoked: 12, accepted: 13, declined: 14 }[input.action];
  if (input.workspaceBound) {
    emitProductUsageTelemetry(env, {
      workspaceId: asWorkspaceId(invitation.workspace_id),
      userId: input.userId,
      name: "workspace_invitation_terminal",
      properties,
      operationId: invitation.id,
      eventId: resourceTelemetryEventId(invitation.id, namespace),
    });
    return;
  }
  const auth: IdentityAuthContext = {
    sessionId: `telemetry:${invitation.id}`,
    userId: input.userId,
    workspaceId: null,
    region: env.AVALON_REGION,
    role: null,
  };
  await emitAuthenticatedApiTelemetry(env, auth, apiTelemetryEnvelope(
    env,
    "workspace_invitation_terminal",
    properties,
    invitation.id,
    "platform-user",
    env.AVALON_REGION,
    resourceTelemetryEventId(invitation.id, namespace),
  ));
}

export interface ResolvedInvitation {
  id: string;
  workspaceId: string;
  workspaceName: string;
  region: Region;
  email: string;
  role: WorkspaceInvitationRole;
  expiresAt: string;
}

const invitationSelect = `SELECT i.id, i.workspace_id, w.name AS workspace_name,
  w.region AS workspace_region, i.email, i.role, inviter.name AS invited_by_name,
  inviter.email AS invited_by_email,
  i.expires_at, i.accepted_at, i.accepted_by_user_id, i.revoked_at, i.created_at,
  w.abandoned_at
  FROM workspace_invitations i
  JOIN workspaces w ON w.id = i.workspace_id
  JOIN users inviter ON inviter.id = i.invited_by_user_id`;

/**
 * Addresses with a pending invitation to this Organization and no membership
 * in it yet, lower case: the people a picker may name before they join.
 */
export async function pendingInvitees(db: D1Database, workspaceId: string): Promise<Array<{ email: string; invitedAt: string }>> {
  const result = await db.prepare(
    `SELECT i.email, i.created_at
     FROM workspace_invitations i
     JOIN workspaces w ON w.id = i.workspace_id
     WHERE i.workspace_id = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL
       AND w.abandoned_at IS NULL AND i.expires_at > ?
       AND NOT EXISTS (
         SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id
         WHERE m.workspace_id = i.workspace_id AND u.email = i.email COLLATE NOCASE
       )
     ORDER BY i.email COLLATE NOCASE`,
  )
    .bind(workspaceId, nowIso())
    .all<{ email: string; created_at: string }>();
  return (result.results ?? []).map((row) => ({ email: row.email.toLowerCase(), invitedAt: String(row.created_at) }));
}

function invitationStatus(row: InvitationRow): WorkspaceInvitation["status"] {
  if (row.abandoned_at) return "revoked";
  if (row.accepted_at) return "accepted";
  if (row.revoked_at) return "revoked";
  if (Date.parse(row.expires_at) <= Date.now()) return "expired";
  return "pending";
}

function mapInvitation(row: InvitationRow): WorkspaceInvitation {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: invitationStatus(row),
    invitedByName: row.invited_by_name,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    createdAt: row.created_at,
  };
}

async function loadInvitationById(env: Env, invitationId: string): Promise<InvitationRow | null> {
  return env.DB.prepare(`${invitationSelect} WHERE i.id = ?`)
    .bind(invitationId)
    .first<InvitationRow>();
}

function mapPendingInvitation(row: InvitationRow): PendingWorkspaceInvitation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    region: row.workspace_region,
    email: row.email,
    role: row.role,
    invitedByName: row.invited_by_name,
    expiresAt: row.expires_at,
  };
}

export async function resolveInvitationToken(env: Env, token: string): Promise<ResolvedInvitation> {
  const row = await env.DB.prepare(`${invitationSelect} WHERE i.token_hash = ?`)
    .bind(await sha256(token))
    .first<InvitationRow>();
  if (!row || invitationStatus(row) !== "pending") {
    throw new ApiError(404, "invitation_invalid", "This invitation is invalid, expired, or no longer available");
  }
  if (row.workspace_region !== env.AVALON_REGION) {
    throw new ApiError(409, "region_mismatch", "This invitation belongs to another data region");
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    region: row.workspace_region,
    email: row.email,
    role: row.role,
    expiresAt: row.expires_at,
  };
}

export async function acceptInvitationForUser(
  env: Env,
  invitationId: string,
  user: { id: string; email: string; name?: string },
): Promise<string> {
  const invitation = await loadInvitationById(env, invitationId);
  if (
    !invitation
    || invitation.abandoned_at
    || invitation.revoked_at
    || Date.parse(invitation.expires_at) <= Date.now()
  ) {
    throw new ApiError(404, "invitation_invalid", "This invitation is invalid, expired, or no longer available");
  }
  if (invitation.workspace_region !== env.AVALON_REGION) {
    throw new ApiError(409, "region_mismatch", "This invitation belongs to another data region");
  }
  if (user.email.trim().toLowerCase() !== invitation.email.trim().toLowerCase()) {
    throw new ApiError(403, "invitation_email_mismatch", `Sign in with ${invitation.email} to accept this invitation`);
  }
  if (invitation.accepted_at) {
    if (invitation.accepted_by_user_id !== user.id) {
      throw new ApiError(404, "invitation_invalid", "This invitation is invalid, expired, or no longer available");
    }
    await dispatchWorkspaceRelationshipChanges(env, { workspaceId: invitation.workspace_id, userId: user.id })
      .catch((error: unknown) => logWarn(env, "workspace_relationship_dispatch_failed", {
        workspace_id: invitation.workspace_id, user_id: user.id,
        error: diagnosticErrorCode(error, "workspace_relationship_dispatch_failed"),
      }));
    await adoptSlackWorkstreamsForMember(env, invitation.workspace_id, user);
    return invitation.workspace_id;
  }

  const acceptedAt = nowIso();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE workspace_invitations SET accepted_at = ?, accepted_by_user_id = ?
       WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
         AND EXISTS (
           SELECT 1 FROM workspaces w
           WHERE w.id = workspace_invitations.workspace_id AND w.abandoned_at IS NULL
         )`,
    ).bind(acceptedAt, user.id, invitation.id, acceptedAt),
    env.DB.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
       SELECT i.workspace_id, ?, i.role, 'active', ?
       FROM workspace_invitations i
       JOIN workspaces w ON w.id = i.workspace_id AND w.abandoned_at IS NULL
       WHERE i.id = ? AND i.accepted_at = ? AND i.accepted_by_user_id = ?
         AND i.revoked_at IS NULL
       ON CONFLICT(workspace_id, user_id) DO UPDATE SET
         access_class = 'member',
         role = CASE
           WHEN workspace_members.role = 'owner' THEN 'owner'
           WHEN workspace_members.role = 'admin' THEN 'admin'
           ELSE excluded.role
         END,
         status = 'active',
         joined_at = COALESCE(workspace_members.joined_at, excluded.joined_at)`,
    ).bind(user.id, acceptedAt, invitation.id, acceptedAt, user.id),
  ]);
  const transitioned = Number(results[0]?.meta?.changes ?? 0) === 1;
  if (!transitioned) {
    const raced = await loadInvitationById(env, invitation.id);
    if (raced?.accepted_by_user_id !== user.id) {
      throw new ApiError(409, "invitation_already_used", "This invitation has already been accepted");
    }
  }
  // The membership trigger recorded the delivery with the write. Dispatch now
  // so General and the Personal Channel do not wait for scheduled recovery.
  await dispatchWorkspaceRelationshipChanges(env, { workspaceId: invitation.workspace_id, userId: user.id })
    .catch((error: unknown) => logWarn(env, "workspace_relationship_dispatch_failed", {
      workspace_id: invitation.workspace_id, user_id: user.id,
      error: diagnosticErrorCode(error, "workspace_relationship_dispatch_failed"),
    }));
  if (transitioned) {
    // The membership is committed; project the new member's search decisions
    // so their first search is complete. A failed publish leaves that member
    // to the after-response fill, which the warning is there to notice.
    try { await publishWorkspaceSync(env, invitation.workspace_id, ["member_directory"], { memberUserIds: [user.id] }); }
    catch (error) {
      logWarn(env, "search_authorization_member_push_failed", { workspace_id: invitation.workspace_id, user_id: user.id,
        error_code: error instanceof Error ? error.message : "unknown" });
    }
    // Spaces that listed this address before they joined now seat them. A
    // failure leaves them out of those Spaces, and the warning is the notice.
    try { await seatSpaceInvitee(env, invitation.workspace_id, user.id, invitation.email); }
    catch (error) {
      logWarn(env, "space_invitee_seat_failed", { workspace_id: invitation.workspace_id, user_id: user.id,
        error_code: error instanceof Error ? error.message : "unknown" });
    }
    await notifyInvitationResolution(env, invitation, user, "accepted");
    await emitInvitationTerminal(env, invitation, {
      userId: asUserId(user.id),
      action: "accepted",
      deliveryResult: "not_applicable",
      workspaceBound: true,
    }).catch(() => undefined);
  }
  await adoptSlackWorkstreamsForMember(env, invitation.workspace_id, user);
  return invitation.workspace_id;
}

async function adoptSlackWorkstreamsForMember(
  env: Env,
  workspaceId: string,
  user: { id: string; email: string },
): Promise<void> {
  try {
    await new SlackAgentService(env).assignWorkspaceWorkstreamsForMember(
      workspaceId,
      user.id,
      user.email,
    );
  } catch (error) {
    // Membership acceptance is authoritative. Slack adoption is a recoverable
    // convenience and can also run when the member explicitly links Slack.
    logWarn(env, "slack_workspace_workstream_adoption_failed", {
      workspace_id: workspaceId,
      user_id: user.id,
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
}

export async function declineInvitationForUser(
  env: Env,
  invitationId: string,
  user: { id: string; email: string; name?: string },
): Promise<void> {
  const invitation = await loadInvitationById(env, invitationId);
  if (!invitation || invitationStatus(invitation) !== "pending") {
    throw new ApiError(404, "invitation_invalid", "This invitation is invalid, expired, or no longer available");
  }
  if (invitation.workspace_region !== env.AVALON_REGION) {
    throw new ApiError(409, "region_mismatch", "This invitation belongs to another data region");
  }
  if (user.email.trim().toLowerCase() !== invitation.email.trim().toLowerCase()) {
    throw new ApiError(403, "invitation_email_mismatch", `Sign in with ${invitation.email} to decline this invitation`);
  }

  const at = nowIso();
  const result = await env.DB.prepare(
    `UPDATE workspace_invitations SET revoked_at = ?
     WHERE id = ? AND email = ? COLLATE NOCASE
       AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
  )
    .bind(at, invitationId, user.email, at)
    .run();
  if (Number(result.meta.changes ?? 0) !== 1) {
    throw new ApiError(404, "invitation_invalid", "This invitation is invalid, expired, or no longer available");
  }
  await revokeDownloadGrantsForInvitation(env.DB, invitationId);
  await notifyInvitationResolution(env, invitation, user, "declined");
  await emitInvitationTerminal(env, invitation, {
    userId: asUserId(user.id),
    action: "declined",
    deliveryResult: "not_applicable",
    workspaceBound: false,
  }).catch(() => undefined);
}

async function notifyInvitationResolution(
  env: Env,
  invitation: InvitationRow,
  user: { email: string; name?: string },
  outcome: "accepted" | "declined",
): Promise<void> {
  try {
    await sendWorkspaceInvitationResolutionEmail(env, {
      id: invitation.id,
      outcome,
      recipientEmail: invitation.invited_by_email,
      workspaceName: invitation.workspace_name,
      workspaceId: invitation.workspace_id,
      inviteeEmail: user.email,
      ...(user.name ? { inviteeName: user.name } : {}),
      role: invitation.role,
      region: invitation.workspace_region,
    });
  } catch (error) {
    // `workspace_region`, not `region`: the Global control plane resolves
    // invitations for regional workspaces, so the two can disagree and the logger
    // already records the region the Worker ran in.
    logWarn(env, "invitation_resolution_email_delivery_failed", {
      invitation_id: invitation.id,
      outcome,
      workspace_region: invitation.workspace_region,
      reason: error instanceof ApiError ? error.code : "unknown_error",
    });
  }
}

export class WorkspaceService {
  constructor(private readonly env: Env, private readonly auth: AuthContext) {}

  /**
   * The Organization's profile as this person sees it. Guests read it too: the
   * shell every browser user mounts loads it first, and a guest's answer is the
   * same row with no role, which `WorkspaceSchema` already requires of them.
   */
  async getWorkspace() {
    const row = await this.env.DB.prepare(
      `SELECT w.id, w.name, w.slug, w.region, w.timezone, w.created_at, m.role, m.access_class
       FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
       WHERE w.id = ? AND m.user_id = ? AND m.status = 'active'
         AND w.abandoned_at IS NULL`,
    )
      .bind(this.auth.workspaceId, this.auth.userId)
      .first<Record<string, unknown>>();
    if (!row) throw new ApiError(404, "workspace_not_found", "Workspace not found");
    return {
      id: String(row.id),
      name: String(row.name),
      slug: String(row.slug),
      region: String(row.region),
      timezone: String(row.timezone),
      role: row.role == null ? null : String(row.role),
      ...(row.access_class === "guest" ? { accessClass: "guest" as const } : {}),
      createdAt: String(row.created_at),
    };
  }

  private workspaceObject() {
    return durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      this.auth.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, this.auth.workspaceId),
    );
  }

  async getMyPreferences() {
    return MemberPreferencesSchema.parse(await (await this.workspaceObject()).memberPreferences({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: this.auth.userId,
    }));
  }

  async updateMyPreferences(preferences: MemberPreferencesUpdate) {
    return MemberPreferencesSchema.parse(await (await this.workspaceObject()).saveMemberPreferences({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: this.auth.userId,
      preferences,
    }));
  }

  async getMyPersonalSystemPrompt() {
    const { personalSystemPrompt } = PersonalSystemPromptRecordSchema.parse(
      await (await this.workspaceObject()).personalSystemPrompt({
        workspaceId: asWorkspaceId(this.auth.workspaceId),
        userId: this.auth.userId,
      }));
    return { personalSystemPrompt };
  }

  async updateMyPersonalSystemPrompt(text: string) {
    const { personalSystemPrompt } = PersonalSystemPromptRecordSchema.parse(
      await (await this.workspaceObject()).savePersonalSystemPrompt({
        workspaceId: asWorkspaceId(this.auth.workspaceId),
        userId: this.auth.userId,
        personalSystemPrompt: text,
      }));
    return { personalSystemPrompt };
  }

  /** What Rally remembers about this person; see `readMemoryReview`. */
  getMyMemory(): Promise<MemoryReview> {
    return readMemoryReview(this.env, this.auth, { kind: "own" });
  }

  /** What Rally remembers about the Organization, as this person may see it. */
  getOrganizationMemory(): Promise<MemoryReview> {
    return readMemoryReview(this.env, this.auth, { kind: "organization" });
  }

  forgetMyMemory(factId: string): Promise<MemoryForgetResponse> {
    return forgetReviewedMemory(this.env, this.auth, { kind: "own" }, factId);
  }

  /** An administrator's removal; anybody else is answered `memory_fact_not_removable`. */
  forgetOrganizationMemory(factId: string): Promise<MemoryForgetResponse> {
    return forgetReviewedMemory(this.env, this.auth, { kind: "organization" }, factId);
  }

  async updateMyTimezone(timezone: string, followDevice = false) {
    // `timezone_source` says whether a device report may move this zone:
    // 'client' follows the device, 'user' is fixed by hand. See
    // `reportDeviceTimezone`.
    await this.env.DB.prepare(
      "UPDATE users SET timezone = ?, timezone_source = ?, updated_at = ? WHERE id = ?",
    )
      .bind(timezone, followDevice ? "client" : "user", nowIso(), this.auth.userId)
      .run();
    await rederiveDigestsForTimezone(this.env, this.auth.userId, timezone);
    const row = await this.env.DB.prepare(
      "SELECT id, email, name, avatar_url, timezone, created_at FROM users WHERE id = ?",
    ).bind(this.auth.userId).first<Record<string, unknown>>();
    if (!row) throw new ApiError(404, "user_not_found", "User not found");
    return {
      id: String(row.id),
      email: String(row.email),
      name: String(row.name),
      avatarUrl: row.avatar_url == null ? null : String(row.avatar_url),
      timezone: String(row.timezone),
      createdAt: String(row.created_at),
    };
  }

  async updateWorkspace(input: { name?: string | undefined; timezone?: string | undefined }) {
    this.requireAdmin();
    // One statement for either field: a field left out keeps its stored value.
    await this.env.DB.prepare(
      `UPDATE workspaces
       SET name = COALESCE(?, name), timezone = COALESCE(?, timezone), updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        input.name ?? null,
        input.timezone ?? null,
        nowIso(),
        this.auth.workspaceId,
      )
      .run();
    return this.getWorkspace();
  }

  /**
   * Take somebody out of this workspace.
   *
   * Two steps, in this order and no other: the membership row goes, which is
   * what every authorization query in the product joins against, and then the
   * revocation is published so the sockets they are already holding are closed.
   * Deleting first means a failure to publish leaves them denied everywhere
   * except an open connection; publishing first would announce a removal that
   * might not commit.
   *
   * Their sessions are left alone deliberately. A session is bound to a
   * workspace and every authorization query joins membership, so it stops
   * resolving the moment the row is gone — revoking it as well would add a
   * write whose only effect is on rows nobody can use.
   */
  async removeMember(userId: string): Promise<void> {
    if (userId === this.auth.userId) {
      throw new ApiError(400, "cannot_remove_self", "You cannot remove yourself from the workspace");
    }
    if (this.auth.role !== "owner" && this.auth.role !== "admin") {
      throw new ApiError(403, "forbidden", "Only an owner or admin can remove a member");
    }
    const member = await this.env.DB.prepare(
      `SELECT role, incarnation, revision FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    ).bind(this.auth.workspaceId, userId).first<{ role: string | null; incarnation: string; revision: number }>();
    if (!member) throw new ApiError(404, "member_not_found", "That person is not in this workspace");
    if (member.role === "owner" && this.auth.role !== "owner") {
      throw new ApiError(403, "forbidden", "Only an owner can remove an owner");
    }
    // The delete re-asserts both roles the checks above read, because it reads
    // them in an earlier round trip and D1 auto-commits in between.
    //
    // The caller's: two owners removing each other at the same time both pass
    // those checks, and without this clause both deletes land, leaving a
    // workspace with no owner at all. SQLite serializes the two statements, so
    // whichever runs second finds its actor already gone and removes nothing.
    // There is still no last-owner count — this is what makes "the remover is
    // an active owner who remains one" true under concurrency.
    //
    // The target's: an admin may remove a member but not an owner. Reading the
    // target as a member and deleting unconditionally lets a promotion land in
    // between, and the admin removes an owner they were never allowed to touch.
    // Either lost race removes nothing and answers 409.
    const removal = await this.env.DB.prepare(
      `DELETE FROM workspace_members
        WHERE workspace_id = ? AND user_id = ? AND role IS ? AND incarnation = ? AND revision = ?
          AND EXISTS (
            SELECT 1 FROM workspace_members actor
             WHERE actor.workspace_id = ? AND actor.user_id = ?
               AND actor.status = 'active' AND actor.role = ?
          )
        RETURNING user_id`,
    ).bind(
      this.auth.workspaceId,
      userId,
      member.role,
      member.incarnation,
      member.revision,
      this.auth.workspaceId,
      this.auth.userId,
      this.auth.role,
    ).first<{ user_id: string }>();
    if (!removal) {
      // Either the caller's own standing went away underneath them, or somebody
      // else removed this person first. Both mean this request did not do what
      // it reports, and neither should announce a revocation it did not cause.
      throw new ApiError(
        409,
        "membership_changed",
        "The workspace membership changed while this removal was in flight. Check it and try again.",
      );
    }
    await dispatchWorkspaceRelationshipChanges(this.env, { workspaceId: this.auth.workspaceId, userId });
  }

  /**
   * Move this Organization to a plan. Administrators only, as with every other
   * Organization-wide setting; there is no billing behind it yet, so the change
   * is the quota alone (docs/usage-metering.md).
   */
  async setPlan(plan: PlanId): Promise<OrganizationUsage> {
    this.requireAdmin();
    const now = Date.now();
    if (!await setWorkspacePlan(this.env, this.auth.workspaceId, plan, now)) {
      throw new ApiError(404, "workspace_not_found", "Workspace not found");
    }
    const usage = await readOrganizationUsage(this.env, this.auth.workspaceId, now);
    if (!usage) throw new ApiError(404, "workspace_not_found", "Workspace not found");
    return usage;
  }

  /**
   * Set the role on a membership that already exists — the one way a workspace
   * grows a second administrator.
   *
   * `workspace_members.role` has been a per-membership column since the first
   * migration, so N administrators were always representable; what did not
   * exist was any way to *assign* one after the fact. An invitation carried a
   * role and nothing else did, so a workspace whose administrator was away had
   * no in-product way to grant anybody else the powers every admin-gated action
   * already accepted. That is what this method is.
   *
   * Three refusals, and each is deliberate:
   *
   * - **`owner` is not assignable, and an owner is not a target.** The founding
   *   membership is what `leaveWorkspace` and `removeMember` count when they
   *   refuse to leave a workspace unowned. Letting it be handed around here
   *   would put a second module in charge of an invariant those two enforce,
   *   and transferring ownership is a separate operation nobody has asked for.
   * - **Only an active membership.** Somebody who has not accepted their
   *   invitation is not yet a member to promote; the invitation carries their
   *   role, and changing it there is what revoking and reissuing one is for.
   * - **Never the last administrator.** A workspace with nobody who can
   *   administer it cannot be recovered from inside the product — no admin
   *   means no invitation, no promotion, and no way back. The guard counts
   *   owner and admin together, because that pair is exactly the set every
   *   admin-gated check in this tree accepts.
   *
   * The write re-asserts all three in its own `WHERE`, for the reason
   * `removeMember` spells out at length: each was read in an earlier round trip
   * and D1 auto-commits in between, so two administrators demoting each other
   * at once both pass the reads. SQLite serializes the statements, whichever
   * runs second finds the invariant it needed already gone, and changes
   * nothing.
   */
  async setMemberRole(userId: string, role: AssignableMemberRole): Promise<void> {
    this.requireAdmin();
    // Parsed rather than trusted. The route validates the body, but this is
    // also reachable from a test, a script, and whatever calls it next, and a
    // `ZodError` escaping here would reach the error handler as a 500 whose
    // message is a JSON blob. `zodDiagnosticCode` names the field instead.
    const parsed = AssignableMemberRoleSchema.safeParse(role);
    if (!parsed.success) {
      throw new ApiError(
        400,
        zodDiagnosticCode(parsed.error, "member_role") ?? "member_role_invalid",
        "A member's role can only be set to administrator or member",
      );
    }
    const assigned = parsed.data;
    const member = await this.env.DB.prepare(
      `SELECT role, status, access_class FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    ).bind(this.auth.workspaceId, userId).first<{
      role: string | null;
      status: string;
      access_class: string;
    }>();
    if (!member) throw new ApiError(404, "member_not_found", "That person is not in this workspace");
    // A guest has no administrative role at all: `workspace_members` enforces
    // `access_class = 'guest' AND role IS NULL` with a CHECK, and promoting one
    // is `promoteGuest`, which moves the access class rather than the role.
    //
    // Named here rather than left to the write below, which does refuse it but
    // for the wrong reason and in the wrong words: the conditional `UPDATE`
    // re-asserts `role = ?` against the role that was read, and a guest's is
    // `NULL`, which no comparison matches. So the statement changes nothing and
    // the caller is told the membership changed underneath them — a lost race,
    // inviting a retry that can never succeed — when what is true is that this
    // person cannot hold a role until somebody promotes them. A wrong code on a
    // path that had the reason in hand is the defect this avoids.
    if (member.access_class === "guest") {
      throw new ApiError(
        409,
        "member_is_guest",
        "That person is a guest of this workspace. Promote them to a member before giving them a role.",
      );
    }
    if (member.role === "owner") {
      throw new ApiError(
        403,
        "cannot_change_owner_role",
        "The workspace owner's role cannot be changed here",
      );
    }
    if (member.status !== "active") {
      throw new ApiError(
        409,
        "member_not_active",
        "That person has not joined this workspace yet. Their invitation carries their role.",
      );
    }
    // Already there. The write is skipped, but the announcement is not: a
    // publish that failed after an earlier identical call left the row correct
    // and every other window stale, and this is the only request that can
    // repair it — a retry is exactly what a caller does after a failure, and it
    // would otherwise land here and do nothing at all.
    if (member.role === assigned) {
      await this.publishMemberRoleChange(userId, assigned);
      return;
    }

    const updated = await this.env.DB.prepare(
      `UPDATE workspace_members
          SET role = ?
        WHERE workspace_id = ? AND user_id = ? AND role = ? AND status = 'active'
          AND EXISTS (
            SELECT 1 FROM workspace_members actor
             WHERE actor.workspace_id = workspace_members.workspace_id
               AND actor.user_id = ? AND actor.status = 'active'
               AND actor.role IN ('owner', 'admin')
          )
          AND (
            ? != 'member'
            OR EXISTS (
              SELECT 1 FROM workspace_members remaining
               WHERE remaining.workspace_id = workspace_members.workspace_id
                 AND remaining.user_id != workspace_members.user_id
                 AND remaining.status = 'active'
                 AND remaining.role IN ('owner', 'admin')
            )
          )
        RETURNING user_id`,
    ).bind(
      assigned,
      this.auth.workspaceId,
      userId,
      member.role,
      this.auth.userId,
      assigned,
    ).first<{ user_id: string }>();
    if (!updated) {
      // Which invariant refused it is worth a second read: "something changed"
      // is the right answer to a lost race and the wrong one to the person who
      // is about to leave their workspace with nobody able to administer it,
      // and only they can act on the difference.
      const remaining = await this.env.DB.prepare(
        `SELECT COUNT(*) AS administrators FROM workspace_members
          WHERE workspace_id = ? AND user_id != ? AND status = 'active'
            AND role IN ('owner', 'admin')`,
      ).bind(this.auth.workspaceId, userId).first<{ administrators: number }>();
      if (assigned === "member" && Number(remaining?.administrators ?? 0) === 0) {
        throw new ApiError(
          409,
          "last_workspace_administrator",
          "This is the only administrator of this workspace. Make somebody else an administrator first.",
        );
      }
      throw new ApiError(
        409,
        "membership_changed",
        "The workspace membership changed while this role change was in flight. Check it and try again.",
      );
    }
    // The membership triggers turned this write into a revision bump and a
    // durable `workspace_relationship_deliveries` row; this is what sends it,
    // exactly as `removeMember` and `promoteGuest` do for theirs. An admission
    // change that is recorded but never dispatched reaches no socket holder.
    await dispatchWorkspaceRelationshipChanges(this.env, {
      workspaceId: this.auth.workspaceId,
      userId,
    });
    await this.publishMemberRoleChange(userId, assigned);
  }

  /**
   * Announce a role that is now what the caller asked for.
   *
   * **Post-commit, and best effort.** The role has already changed, so a failure
   * to announce it cannot be reported as a failure to change it. Letting this
   * throw was a real defect: the caller saw an error for a write that had
   * committed, and on a self-demotion their next request no longer carried the
   * standing to retry. `workspaceRealtimeInvalidation` treats publication the
   * same way for every other mutation; this route is not in
   * `workspaceSyncPublicationsForMutation`, so it does it here.
   *
   * Two topics, and no `memberUserIds`: the roster every administrator reads and
   * the workspace profile that carries a person's own role both go stale, but
   * nobody joined or left, so there are no search decisions to project.
   *
   * What it costs when it fails: other open windows keep a stale roster until
   * this call is retried or something else invalidates it. Nothing is
   * mis-authorized by that — `auth.role` is read from `workspace_members` on
   * every request — so the stale copy decides what is drawn and never what is
   * allowed.
   */
  private async publishMemberRoleChange(userId: string, role: AssignableMemberRole): Promise<void> {
    try {
      await publishWorkspaceSync(
        this.env,
        this.auth.workspaceId,
        ["member_directory", "workspace_profile"],
      );
    } catch (error) {
      logWarn(this.env, "workspace_member_role_sync_publish_failed", {
        workspace_id: this.auth.workspaceId,
        user_id: userId,
        role,
        error_code: diagnosticErrorCode(error, "workspace_sync_publish_failed"),
      });
    }
  }

  /**
   * End the caller's own membership, or close the workspace when they are its
   * final active member.
   *
   * The abandonment batch is attempted first and re-asserts sole membership in
   * the write that marks the workspace. Invitation acceptance uses its own D1
   * batch, so SQLite serialization makes exactly one of those transitions see
   * a live invitation/member state. If another member exists, the conditional
   * delete below permits an ordinary leave while refusing the last owner.
   */
  async leaveWorkspace(expectedOutcome: "left" | "abandoned"): Promise<{ outcome: "left" | "abandoned" }> {
    if (expectedOutcome === "abandoned") {
      const at = nowIso();
      const abandonment = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE workspaces SET abandoned_at = ?, updated_at = ?
         WHERE id = ? AND abandoned_at IS NULL
           AND EXISTS (
             SELECT 1 FROM workspace_members actor
             WHERE actor.workspace_id = workspaces.id AND actor.user_id = ?
               AND actor.status = 'active'
           )
           AND 1 = (
             SELECT COUNT(*) FROM workspace_members active_member
             WHERE active_member.workspace_id = workspaces.id
               AND active_member.status = 'active'
           )`,
      ).bind(at, at, this.auth.workspaceId, this.auth.userId),
      this.env.DB.prepare(
        `UPDATE workspace_members SET status = 'suspended'
         WHERE workspace_id = ? AND user_id = ? AND status = 'active'
           AND EXISTS (
             SELECT 1 FROM workspaces
             WHERE id = ? AND abandoned_at = ?
           )`,
      ).bind(this.auth.workspaceId, this.auth.userId, this.auth.workspaceId, at),
      this.env.DB.prepare(
        `UPDATE workspace_invitations SET revoked_at = ?
         WHERE workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL
           AND EXISTS (
             SELECT 1 FROM workspaces
             WHERE id = ? AND abandoned_at = ?
           )`,
      ).bind(at, this.auth.workspaceId, this.auth.workspaceId, at),
      // A closed workspace's invitations no longer authorize a download either.
      this.env.DB.prepare(
        `UPDATE download_grants SET revoked_at = COALESCE(revoked_at, ?)
         WHERE source = 'workspace_invitation' AND revoked_at IS NULL
           AND source_id IN (SELECT id FROM workspace_invitations WHERE workspace_id = ?)
           AND EXISTS (
             SELECT 1 FROM workspaces
             WHERE id = ? AND abandoned_at = ?
           )`,
      ).bind(at, this.auth.workspaceId, this.auth.workspaceId, at),
      ]);
      const abandoned = Number(abandonment[0]?.meta?.changes ?? 0) === 1;
      if (abandoned) {
        await dispatchWorkspaceRelationshipChanges(this.env, { workspaceId: this.auth.workspaceId, userId: this.auth.userId });
        return { outcome: "abandoned" };
      }
      throw new ApiError(
        409,
        "membership_changed",
        "The workspace membership changed while closing it. Check it and try again.",
      );
    }

    const departure = await this.env.DB.prepare(
      `DELETE FROM workspace_members
       WHERE workspace_id = ? AND user_id = ? AND status = 'active'
         AND 1 < (
           SELECT COUNT(*) FROM workspace_members active_member
           WHERE active_member.workspace_id = workspace_members.workspace_id
             AND active_member.status = 'active'
         )
         AND (
           role != 'owner'
           OR 1 < (
             SELECT COUNT(*) FROM workspace_members active_owner
             WHERE active_owner.workspace_id = workspace_members.workspace_id
               AND active_owner.status = 'active' AND active_owner.role = 'owner'
           )
         )
       RETURNING user_id, incarnation`,
    ).bind(this.auth.workspaceId, this.auth.userId).first<{ user_id: string; incarnation: string }>();
    if (departure) {
      await dispatchWorkspaceRelationshipChanges(this.env, { workspaceId: this.auth.workspaceId, userId: this.auth.userId });
      return { outcome: "left" };
    }

    const standing = await this.env.DB.prepare(
      `SELECT actor.role,
              (SELECT COUNT(*) FROM workspace_members active_member
               WHERE active_member.workspace_id = actor.workspace_id
                 AND active_member.status = 'active') AS active_members,
              (SELECT COUNT(*) FROM workspace_members active_owner
               WHERE active_owner.workspace_id = actor.workspace_id
                 AND active_owner.status = 'active' AND active_owner.role = 'owner') AS active_owners
       FROM workspace_members actor
       JOIN workspaces w ON w.id = actor.workspace_id
       WHERE actor.workspace_id = ? AND actor.user_id = ? AND actor.status = 'active'
         AND w.abandoned_at IS NULL`,
    ).bind(this.auth.workspaceId, this.auth.userId).first<{
      role: "owner" | "admin" | "member";
      active_members: number;
      active_owners: number;
    }>();
    if (standing?.role === "owner" && standing.active_members > 1 && standing.active_owners === 1) {
      throw new ApiError(
        409,
        "sole_workspace_owner",
        "You are the only owner of this workspace. Another owner has to exist before you can leave.",
      );
    }
    throw new ApiError(
      409,
      "membership_changed",
      "The workspace membership changed while leaving. Check it and try again.",
    );
  }



  async promoteGuest(userId: string, input: { incarnation: string; expectedRevision: number }) {
    if (this.auth.role !== "owner" && this.auth.role !== "admin") {
      throw new ApiError(403, "forbidden", "Only an owner or admin can promote a guest");
    }
    const result = await promoteWorkspaceGuest(this.env.DB, {
      ...input, userId, workspaceId: this.auth.workspaceId, actorUserId: this.auth.userId,
    });
    if (result.status !== "promoted") {
      throw new ApiError(409, "workspace_relationship_changed", "This person's workspace access changed. Refresh and try again.");
    }
    // The membership trigger records a durable relationship delivery. Promotion
    // preserves the incarnation, so its delivery refreshes views without logout.
    await dispatchWorkspaceRelationshipChanges(this.env, { workspaceId: this.auth.workspaceId, userId });
    return result.relationship;
  }

  async listMembers() {
    const result = await this.env.DB.prepare(
      `SELECT u.id, u.email, u.name, u.avatar_url, u.presentation_json, u.timezone, u.created_at, m.role, m.access_class, m.incarnation, m.revision, m.status, m.joined_at
       FROM workspace_members m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = ? AND m.status != 'suspended'
       ORDER BY u.name COLLATE NOCASE`,
    )
      .bind(this.auth.workspaceId)
      .all<Record<string, unknown>>();
    return (result.results ?? []).map((row) => ({
      user: {
        id: String(row.id),
        email: String(row.email),
        name: String(row.name),
        avatarUrl: row.avatar_url == null ? null : String(row.avatar_url),
        presentation: row.presentation_json ? PersonalPresentationSchema.parse(JSON.parse(String(row.presentation_json))) : null,
        timezone: String(row.timezone),
        createdAt: String(row.created_at),
      },
      role: row.role == null ? null : String(row.role),
      incarnation: String(row.incarnation),
      revision: Number(row.revision),
      ...(row.access_class === "guest" ? { accessClass: "guest" as const } : {}),
      status: String(row.status),
      joinedAt: row.joined_at == null ? null : String(row.joined_at),
    }));
  }

  /**
   * Addresses with a pending invitation, for every member to pick from. A
   * guest never reaches this: `requireAuth` refuses a session with no role. An address that already has
   * a membership here, a guest who was shared a Channel before accepting, is
   * left out so it appears once, as that membership.
   */
  async listInvitees(): Promise<Array<{ email: string; invitedAt: string }>> {
    return pendingInvitees(this.env.DB, this.auth.workspaceId);
  }

  async listInvitations(): Promise<WorkspaceInvitation[]> {
    this.requireAdmin();
    const result = await this.env.DB.prepare(
      `${invitationSelect} WHERE i.workspace_id = ? ORDER BY i.created_at DESC LIMIT 100`,
    )
      .bind(this.auth.workspaceId)
      .all<InvitationRow>();
    return (result.results ?? []).map(mapInvitation);
  }

  async createInvitation(
    email: string,
    role: WorkspaceInvitationRole,
  ): Promise<{ invitation: WorkspaceInvitation; inviteUrl: string; emailDelivery: InvitationEmailDelivery }> {
    this.requireAdmin();
    const normalizedEmail = email.trim().toLowerCase();
    const existingMember = await this.env.DB.prepare(
      `SELECT 1 AS present FROM workspace_members m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = ? AND u.email = ? COLLATE NOCASE AND m.status = 'active' LIMIT 1`,
    )
      .bind(this.auth.workspaceId, normalizedEmail)
      .first<{ present: number }>();
    if (existingMember) {
      throw new ApiError(409, "already_workspace_member", "That person is already a member of this workspace");
    }

    const token = randomToken(32);
    const id = newId();
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
    const [supersedeResult] = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE workspace_invitations SET revoked_at = ?
         WHERE workspace_id = ? AND email = ? COLLATE NOCASE
           AND accepted_at IS NULL AND revoked_at IS NULL
         RETURNING id`,
      ).bind(createdAt, this.auth.workspaceId, normalizedEmail),
      this.env.DB.prepare(
        `INSERT INTO workspace_invitations
         (id, workspace_id, email, invited_by_user_id, token_hash, role, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        this.auth.workspaceId,
        normalizedEmail,
        this.auth.userId,
        await sha256(token),
        role,
        expiresAt,
        createdAt,
      ),
    ]);
    // A superseded invitation's own download grant must not outlive it: the
    // partial unique index on (workspace_id, email) means this is 0 or 1 row,
    // but a loop makes no assumption about that.
    for (const superseded of (supersedeResult?.results ?? []) as Array<{ id: string }>) {
      await revokeDownloadGrantsForInvitation(this.env.DB, superseded.id).catch((error: unknown) => {
        logWarn(this.env, "superseded_invitation_grant_revoke_failed", {
          workspace_id: this.auth.workspaceId,
          invitation_id: superseded.id,
          reason: error instanceof Error ? error.message : "unknown",
        });
      });
    }
    const row = await loadInvitationById(this.env, id);
    if (!row) throw new ApiError(500, "invitation_persistence_failed", "Could not create the invitation");
    const inviteUrl = new URL("/invite/", this.env.PUBLIC_WEB_BASE_URL);
    inviteUrl.hash = new URLSearchParams({ region: this.env.AVALON_REGION, token }).toString();
    let downloadGrant: { id: string; token: string; expiresAt: string | null } | null = null;
    let emailDelivery: InvitationEmailDelivery;
    try {
      // Download redemption only exists on the Global Worker today (see
      // docs/private-access.md#regional-impact); a regional workspace invitation gets
      // no download link until regional redemption is wired. Issuance stays
      // inside this try so a grant failure rolls back the invitation exactly
      // like an email failure does, rather than orphaning it.
      downloadGrant = row.workspace_region === "global"
        ? await issueDownloadGrant(this.env.DB, {
            source: "workspace_invitation",
            sourceId: row.id,
            createdBy: this.auth.userId,
            expiresAt,
          })
        : null;
      const downloadUrl = downloadGrant ? downloadGrantUrl(downloadGrant.token, this.env.PUBLIC_WEB_BASE_URL) : undefined;
      emailDelivery = await sendWorkspaceInvitationEmail(this.env, {
        id: row.id,
        recipientEmail: row.email,
        workspaceName: row.workspace_name,
        inviterName: row.invited_by_name,
        role: row.role,
        region: row.workspace_region,
        expiresAt: row.expires_at,
        inviteUrl: inviteUrl.toString(),
        ...(downloadUrl ? { downloadUrl } : {}),
      });
    } catch (error) {
      if (downloadGrant) await revokeDownloadGrant(this.env.DB, downloadGrant.id).catch(() => undefined);
      await this.env.DB.prepare(
        `UPDATE workspace_invitations SET revoked_at = ?
         WHERE id = ? AND workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
      ).bind(nowIso(), row.id, this.auth.workspaceId).run();
      await emitInvitationTerminal(this.env, row, {
        userId: this.auth.userId,
        action: "created",
        deliveryResult: "failed",
        workspaceBound: true,
      }).catch(() => undefined);
      throw error;
    }
    await emitInvitationTerminal(this.env, row, {
      userId: this.auth.userId,
      action: "created",
      deliveryResult: emailDelivery === "sent" ? "success" : "not_applicable",
      workspaceBound: true,
    }).catch(() => undefined);
    return { invitation: mapInvitation(row), inviteUrl: inviteUrl.toString(), emailDelivery };
  }

  async revokeInvitation(id: string): Promise<void> {
    this.requireAdmin();
    const invitation = await loadInvitationById(this.env, id);
    const result = await this.env.DB.prepare(
      `UPDATE workspace_invitations SET revoked_at = ?
       WHERE id = ? AND workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
    )
      .bind(nowIso(), id, this.auth.workspaceId)
      .run();
    if (Number(result.meta.changes ?? 0) === 0) {
      throw new ApiError(404, "invitation_not_found", "No pending invitation was found");
    }
    await revokeDownloadGrantsForInvitation(this.env.DB, id);
    if (invitation) {
      await emitInvitationTerminal(this.env, invitation, {
        userId: this.auth.userId,
        action: "revoked",
        deliveryResult: "not_applicable",
        workspaceBound: true,
      }).catch(() => undefined);
    }
  }

  async acceptInvitation(token: string): Promise<void> {
    const invitation = await resolveInvitationToken(this.env, token);
    const user = await this.env.DB.prepare("SELECT id, email, name FROM users WHERE id = ?")
      .bind(this.auth.userId)
      .first<{ id: string; email: string; name: string }>();
    if (!user) throw new ApiError(401, "identity_not_found", "The signed-in user no longer exists");
    await acceptInvitationForUser(this.env, invitation.id, user);
  }

  private requireAdmin(): void {
    if (this.auth.role !== "owner" && this.auth.role !== "admin") {
      throw new ApiError(403, "workspace_admin_required", "This action requires a workspace administrator");
    }
  }
}

/** Identity-level setup actions available before a session is workspace-bound. */
export class WorkspaceOnboardingService {
  constructor(private readonly env: Env, private readonly auth: IdentityAuthContext) {}

  async state(): Promise<{ invitations: PendingWorkspaceInvitation[] }> {
    if (this.auth.workspaceId) return { invitations: [] };
    const result = await this.env.DB.prepare(
      `${invitationSelect}
       JOIN users invitee ON invitee.id = ?
       WHERE i.email = invitee.email COLLATE NOCASE
         AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?
         AND w.region = ? AND w.abandoned_at IS NULL
       ORDER BY i.created_at DESC LIMIT 100`,
    )
      .bind(this.auth.userId, nowIso(), this.env.AVALON_REGION)
      .all<InvitationRow>();
    return { invitations: (result.results ?? []).map(mapPendingInvitation) };
  }

  async createWorkspace(name: string): Promise<void> {
    this.requireUnboundSession();
    const existing = await this.env.DB.prepare(
      `SELECT m.workspace_id FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.user_id = ? AND m.status = 'active' AND w.region = ?
         AND w.abandoned_at IS NULL LIMIT 1`,
    )
      .bind(this.auth.userId, this.env.AVALON_REGION)
      .first<{ workspace_id: string }>();
    if (existing) {
      await this.bindSessions(existing.workspace_id);
      return;
    }

    const workspaceId = newId();
    const normalized = name.trim();
    const slug = workspaceSlug(normalized, workspaceId);
    const at = nowIso();
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO workspaces (id, name, slug, region, timezone, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        workspaceId,
        normalized,
        slug,
        this.env.AVALON_REGION,
        "America/Los_Angeles",
        this.auth.userId,
        at,
        at,
      ),
      this.env.DB.prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
         VALUES (?, ?, 'owner', 'active', ?)`,
      ).bind(workspaceId, this.auth.userId, at),
      this.env.DB.prepare(
        `UPDATE sessions SET workspace_id = ?
         WHERE user_id = ? AND region = ? AND workspace_id IS NULL
           AND revoked_at IS NULL AND expires_at > ?`,
      ).bind(workspaceId, this.auth.userId, this.env.AVALON_REGION, at),
    ]);
  }

  async acceptInvitation(invitationId: string): Promise<void> {
    this.requireUnboundSession();
    const user = await this.loadUser();
    const invitation = await loadInvitationById(this.env, invitationId);
    if (!invitation || invitationStatus(invitation) !== "pending") {
      throw new ApiError(404, "invitation_invalid", "This invitation is invalid, expired, or no longer available");
    }
    const workspaceId = await acceptInvitationForUser(this.env, invitationId, user);
    await this.bindSessions(workspaceId);
  }

  async declineInvitation(invitationId: string): Promise<void> {
    this.requireUnboundSession();
    const user = await this.loadUser();
    await declineInvitationForUser(this.env, invitationId, user);
  }

  private requireUnboundSession(): void {
    if (this.auth.workspaceId) {
      throw new ApiError(409, "workspace_already_selected", "This account already belongs to this workspace");
    }
  }

  private async loadUser(): Promise<{ id: string; email: string; name: string }> {
    const user = await this.env.DB.prepare("SELECT id, email, name FROM users WHERE id = ?")
      .bind(this.auth.userId)
      .first<{ id: string; email: string; name: string }>();
    if (!user) throw new ApiError(401, "identity_not_found", "The signed-in user no longer exists");
    return user;
  }

  private async bindSessions(workspaceId: string): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE sessions SET workspace_id = ?
       WHERE user_id = ? AND region = ? AND workspace_id IS NULL
         AND revoked_at IS NULL AND expires_at > ?`,
    )
      .bind(workspaceId, this.auth.userId, this.env.AVALON_REGION, nowIso())
      .run();
  }
}

export async function previewInvitation(env: Env, token: string): Promise<WorkspaceInvitationPreview> {
  const invitation = await resolveInvitationToken(env, token);
  return {
    workspaceId: invitation.workspaceId,
    workspaceName: invitation.workspaceName,
    region: invitation.region,
    email: invitation.email,
    role: invitation.role,
    expiresAt: invitation.expiresAt,
  };
}

/**
 * A digest's times are wall-clock times in its owner's day, so moving timezone
 * moves every occurrence — in every workspace they belong to, since this is one
 * column for the whole account. The configuration is unchanged; the instants it
 * resolves to are not, and those live in derived `schedules` rows the workspace
 * alarm reads.
 */
async function rederiveDigestsForTimezone(env: Env, userId: string, timezone: string): Promise<void> {
  await rebuildDigestSchedulesForTimezone(env, { userId, timezone }).catch((error: unknown) => {
    // The timezone itself is saved, and the cron reconciler rebuilds any
    // derived row whose timezone disagrees with the account. Failing the
    // request here would lose the timezone to fix a thing that self-heals.
    logWarn(env, "digest_schedule_rederive_failed", {
      user_id: userId,
      reason: error instanceof Error ? error.message : "unknown",
    });
  });
}

/** The account's timezone, and whether it follows the device. */
export async function readUserTimezone(env: Env, userId: string): Promise<UserTimezone> {
  const row = await env.DB.prepare("SELECT timezone, timezone_source FROM users WHERE id = ?")
    .bind(userId).first<{ timezone: string; timezone_source: string }>();
  if (!row) throw new ApiError(404, "user_not_found", "User not found");
  return { timezone: row.timezone, followsDevice: row.timezone_source === "client" };
}

/**
 * A client saying which zone its device is in. Applied only while the account
 * follows the device and only when the zone actually moved, so a fixed choice
 * is never overwritten and a report that changes nothing writes nothing.
 */
export async function reportDeviceTimezone(env: Env, userId: string, timezone: string): Promise<UserTimezone> {
  const moved = await env.DB.prepare(
    `UPDATE users SET timezone = ?, updated_at = ?
      WHERE id = ? AND timezone_source = 'client' AND timezone <> ?
      RETURNING id`,
  ).bind(timezone, nowIso(), userId, timezone).first<{ id: string }>();
  if (moved) await rederiveDigestsForTimezone(env, userId, timezone);
  return readUserTimezone(env, userId);
}
