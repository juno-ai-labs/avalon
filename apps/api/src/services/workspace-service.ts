import {
  asUserId,
  asWorkspaceId,
  type UserId,
  type PendingWorkspaceInvitation,
  type WorkspaceInvitation,
  type WorkspaceInvitationPreview,
  type WorkspaceInvitationRole,
} from "@rally/contracts";
import { newId, nowIso } from "@rally/db";
import type { AuthContext, Env, IdentityAuthContext } from "../env";
import { ApiError } from "../lib/api-error";
import { randomToken, sha256 } from "../lib/crypto";
import { logWarn } from "../observability/logger";
import {
  sendWorkspaceInvitationEmail,
  sendWorkspaceInvitationResolutionEmail,
  type InvitationEmailDelivery,
} from "./invitation-email-service";
import { publishAccessRevocation } from "./access-revocation";
import { publishWorkspaceSync } from "./workspace-realtime-service";
import { SlackAgentService } from "./slack-agent-service";
import { rebuildDigestSchedulesForTimezone } from "./digest-service";
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
  workspace_region: "global" | "eu";
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
    await emitProductUsageTelemetry(env, {
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
  region: "global" | "eu";
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
  if (transitioned) {
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
    // invitations for EU workspaces, so the two can disagree and the logger
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

  async getWorkspace() {
    const row = await this.env.DB.prepare(
      `SELECT w.id, w.name, w.slug, w.region, w.timezone, w.created_at, m.role
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
      role: String(row.role),
      createdAt: String(row.created_at),
    };
  }

  async updateMyTimezone(timezone: string) {
    // `timezone_source` is what stops the next sign-in writing the machine's
    // zone back over this choice.
    await this.env.DB.prepare(
      "UPDATE users SET timezone = ?, timezone_source = 'user', updated_at = ? WHERE id = ?",
    )
      .bind(timezone, nowIso(), this.auth.userId)
      .run();
    // A digest's times are wall-clock times in this person's day, so moving
    // timezone moves every occurrence — in every workspace they belong to, since
    // this is one column for the whole account. The configuration is unchanged;
    // the instants it resolves to are not, and those live in derived `schedules`
    // rows the workspace alarm reads.
    await rebuildDigestSchedulesForTimezone(this.env, {
      userId: this.auth.userId,
      timezone,
    }).catch((error: unknown) => {
      // The preference itself is saved, and the cron reconciler rebuilds any
      // derived row whose timezone disagrees with the account. Failing the
      // request here would lose the preference to fix a thing that self-heals.
      logWarn(this.env, "digest_schedule_rederive_failed", {
        workspace_id: this.auth.workspaceId,
        reason: error instanceof Error ? error.message : "unknown",
      });
    });
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

  async updateWorkspace(input: { timezone: string }) {
    this.requireAdmin();
    await this.env.DB.prepare(
      `UPDATE workspaces
       SET timezone = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        input.timezone,
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
      `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    ).bind(this.auth.workspaceId, userId).first<{ role: string }>();
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
        WHERE workspace_id = ? AND user_id = ? AND role = ?
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
    await publishAccessRevocation(this.env, {
      reason: "workspace_membership_removed",
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(userId),
      // No session: the membership is gone, so none of their windows is
      // admissible any longer.
      sessionId: null,
    });
    await publishWorkspaceSync(this.env, this.auth.workspaceId, ["member_directory"]);
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
      ]);
      const abandoned = Number(abandonment[0]?.meta?.changes ?? 0) === 1;
      if (abandoned) {
        await this.publishOwnMembershipRevocation();
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
       RETURNING user_id`,
    ).bind(this.auth.workspaceId, this.auth.userId).first<{ user_id: string }>();
    if (departure) {
      await this.publishOwnMembershipRevocation();
      await publishWorkspaceSync(this.env, this.auth.workspaceId, ["member_directory"]);
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

  private async publishOwnMembershipRevocation(): Promise<void> {
    await publishAccessRevocation(this.env, {
      reason: "workspace_membership_removed",
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      sessionId: null,
    });
  }

  async listMembers() {
    const result = await this.env.DB.prepare(
      `SELECT u.id, u.email, u.name, u.avatar_url, u.timezone, u.created_at, m.role, m.status, m.joined_at
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
        timezone: String(row.timezone),
        createdAt: String(row.created_at),
      },
      role: String(row.role),
      status: String(row.status),
      joinedAt: row.joined_at == null ? null : String(row.joined_at),
    }));
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
    if (role === "admin" && this.auth.role !== "owner") {
      throw new ApiError(403, "workspace_owner_required", "Only the workspace owner can invite an administrator");
    }
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
    await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE workspace_invitations SET revoked_at = ?
         WHERE workspace_id = ? AND email = ? COLLATE NOCASE
           AND accepted_at IS NULL AND revoked_at IS NULL`,
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
    const row = await loadInvitationById(this.env, id);
    if (!row) throw new ApiError(500, "invitation_persistence_failed", "Could not create the invitation");
    const inviteUrl = new URL("/invite/", this.env.PUBLIC_WEB_BASE_URL);
    inviteUrl.hash = new URLSearchParams({ region: this.env.AVALON_REGION, token }).toString();
    let emailDelivery: InvitationEmailDelivery;
    try {
      emailDelivery = await sendWorkspaceInvitationEmail(this.env, {
        id: row.id,
        recipientEmail: row.email,
        workspaceName: row.workspace_name,
        inviterName: row.invited_by_name,
        role: row.role,
        region: row.workspace_region,
        expiresAt: row.expires_at,
        inviteUrl: inviteUrl.toString(),
      });
    } catch (error) {
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
      throw new ApiError(403, "workspace_admin_required", "Only workspace administrators can manage invitations");
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
    const slugBase = normalized.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 40) || "workspace";
    const slug = `${slugBase}-${workspaceId.slice(0, 8)}`;
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
        this.env.AVALON_REGION === "eu" ? "Europe/London" : "America/Los_Angeles",
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
