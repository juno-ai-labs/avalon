import {
  SupportAccessSchema,
  SupportPeopleSchema,
  SupportWorkspacesSchema,
  asUserId,
  type Session,
  type SupportAccess,
  type UserId,
} from "@rally/contracts";
import { newId, nowIso } from "@rally/db";
import type { Env, IdentityAuthContext } from "../env";
import { ApiError } from "../lib/api-error";
import { logWarn } from "../observability/logger";
import { publishSessionRevocations, type RevokedSessionRow } from "./access-revocation";
import { AuthService, DEVELOPMENT_WORKSPACE_ID } from "./auth-service";

/**
 * Juno Labs, the Organization whose members are Rally staff. Hard-coded by
 * product decision (2026-10-07): staff is "a member of this Organization", and
 * nothing else grants it. Guests of it are not staff.
 */
export const SUPPORT_ORGANIZATION_ID = "019fc068-22e8-739a-8394-a760fdc7c376";

/**
 * How long one grant lasts. A product number: the person who asked for the
 * feature named seven calendar days, and the settings row counts it down.
 */
export const SUPPORT_ACCESS_GRANT_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * The staff Organization for this deployment. Local development has no copy of
 * Juno Labs, so its seeded Organization stands in for it, which is what lets
 * the feature be driven end to end on a workstation.
 */
export function supportOrganizationId(env: Pick<Env, "APP_ENV" | "RALLY_DEV_AUTH">): string {
  return env.APP_ENV === "development" && env.RALLY_DEV_AUTH === "true" ? DEVELOPMENT_WORKSPACE_ID : SUPPORT_ORGANIZATION_ID;
}

/**
 * The SQL that keeps a support session alive, for every statement that admits
 * or renews one: a live grant for the session's Organization, and a live staff
 * membership for the person acting. `alias` names the `sessions` row.
 */
export function supportSessionLiveSql(alias: string): string {
  return `EXISTS (SELECT 1 FROM support_access_grants grant_row
      WHERE grant_row.workspace_id = ${alias}.workspace_id AND grant_row.expires_at > ?)
    AND EXISTS (SELECT 1 FROM workspace_members staff
      WHERE staff.workspace_id = ? AND staff.user_id = ${alias}.impersonator_user_id
        AND staff.status = 'active' AND staff.access_class = 'member')`;
}

/** Whether support session `sessionId` still has a live grant and a live staff member. */
export async function supportSessionLive(env: Env, sessionId: string, now: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS live FROM sessions support WHERE support.id = ? AND ${supportSessionLiveSql("support")}`,
  ).bind(sessionId, now, supportOrganizationId(env)).first();
  return row !== null;
}

/** Revoke support sessions and close their sockets; `filter` picks which. */
export async function revokeSupportSessions(
  env: Env,
  filter: { workspaceId: string } | { impersonatorUserId: string },
): Promise<void> {
  const [column, value] = "workspaceId" in filter
    ? ["workspace_id", filter.workspaceId]
    : ["impersonator_user_id", filter.impersonatorUserId];
  const rows = await env.DB.prepare(
    `UPDATE sessions SET revoked_at = ?
     WHERE ${column} = ? AND impersonator_user_id IS NOT NULL AND revoked_at IS NULL
     RETURNING id, user_id, workspace_id`,
  ).bind(nowIso(), value).all<RevokedSessionRow>();
  const revoked = rows.results ?? [];
  const announced = await publishSessionRevocations(env, revoked, "session_revoked");
  if (announced.length !== revoked.length) {
    logWarn(env, "support_session_revocation_unannounced", { revoked: revoked.length, announced: announced.length });
  }
}

/** Grants, staff discovery, and the support sessions they admit. */
export class SupportAccessService {
  constructor(private readonly env: Env, private readonly auth: IdentityAuthContext) {}

  /** The calling Organization's grant. Readable by anyone in it; only admins change it. */
  async status(): Promise<SupportAccess> {
    const workspaceId = this.requireWorkspace();
    if (workspaceId === supportOrganizationId(this.env)) return { available: false, expiresAt: null };
    const row = await this.env.DB.prepare(
      "SELECT expires_at FROM support_access_grants WHERE workspace_id = ? AND expires_at > ?",
    ).bind(workspaceId, nowIso()).first<{ expires_at: string }>();
    return SupportAccessSchema.parse({ available: true, expiresAt: row?.expires_at ?? null });
  }

  /** Start, or restart, the seven days. */
  async grant(): Promise<SupportAccess> {
    const workspaceId = this.requireAdministrator();
    // A support session acts with the person's own authority, an
    // administrator's included. Letting it extend its own grant would let
    // staff keep access no person in the Organization chose to give.
    if (this.auth.impersonatorUserId) {
      throw new ApiError(403, "support_access_grant_requires_member", "Only a person in this organization can grant Rally access");
    }
    if (workspaceId === supportOrganizationId(this.env)) {
      throw new ApiError(409, "support_access_unavailable", "Rally access does not apply to this organization");
    }
    const at = nowIso();
    const expiresAt = new Date(Date.parse(at) + SUPPORT_ACCESS_GRANT_MS).toISOString();
    await this.env.DB.prepare(
      `INSERT INTO support_access_grants (workspace_id, granted_by_user_id, granted_at, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         granted_by_user_id = excluded.granted_by_user_id,
         granted_at = excluded.granted_at,
         expires_at = excluded.expires_at`,
    ).bind(workspaceId, this.auth.userId, at, expiresAt).run();
    await this.audit(workspaceId, "support_access.granted", "workspace", workspaceId, { expiresAt });
    return { available: true, expiresAt };
  }

  /** End the grant and every support session it admitted. */
  async revoke(): Promise<SupportAccess> {
    const workspaceId = this.requireAdministrator();
    await this.env.DB.prepare("DELETE FROM support_access_grants WHERE workspace_id = ?").bind(workspaceId).run();
    await revokeSupportSessions(this.env, { workspaceId });
    await this.audit(workspaceId, "support_access.revoked", "workspace", workspaceId, {});
    return { available: workspaceId !== supportOrganizationId(this.env), expiresAt: null };
  }

  /** Organizations a staff member may act in, A-Z by name. */
  async workspaces() {
    await this.requireStaff();
    const rows = await this.env.DB.prepare(
      `SELECT w.id, w.name, w.region, g.expires_at FROM support_access_grants g
       JOIN workspaces w ON w.id = g.workspace_id
       WHERE g.expires_at > ? AND w.region = ? AND w.abandoned_at IS NULL AND w.id != ?
       ORDER BY w.name COLLATE NOCASE, w.id`,
    ).bind(nowIso(), this.env.AVALON_REGION, supportOrganizationId(this.env))
      .all<{ id: string; name: string; region: string; expires_at: string }>();
    return SupportWorkspacesSchema.parse({
      workspaces: rows.results.map((row) => ({ id: row.id, name: row.name, region: row.region, expiresAt: row.expires_at })),
    });
  }

  /** Members, then guests, A-Z by name, of an Organization with a live grant. */
  async people(workspaceId: string) {
    await this.requireStaff();
    await this.requireGrant(workspaceId);
    const rows = await this.env.DB.prepare(
      `SELECT u.id, u.name, u.email, u.avatar_url, m.access_class FROM workspace_members m
       JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = ? AND m.status = 'active'
       ORDER BY CASE m.access_class WHEN 'member' THEN 0 ELSE 1 END, u.name COLLATE NOCASE, u.id`,
    ).bind(workspaceId).all<{ id: string; name: string; email: string; avatar_url: string | null; access_class: "member" | "guest" }>();
    return SupportPeopleSchema.parse({
      people: rows.results.map((row) => ({
        id: row.id, name: row.name, email: row.email, avatarUrl: row.avatar_url, accessClass: row.access_class,
      })),
    });
  }

  /**
   * Open a session as `userId` in `workspaceId`. The insert re-checks the grant,
   * the staff membership and the represented membership in its own statement,
   * so a grant revoked between the reads above and this write admits nothing.
   */
  async start(input: { workspaceId: string; userId: string }): Promise<{ session: Session; sessionId: string }> {
    const operator = await this.requireStaff();
    await this.requireGrant(input.workspaceId);
    const { session, sessionId } = await new AuthService(this.env).createSupportSession({
      operatorUserId: operator,
      representedUserId: input.userId,
      workspaceId: input.workspaceId,
      staffWorkspaceId: supportOrganizationId(this.env),
    });
    await this.audit(input.workspaceId, "support_session.started", "user", input.userId, { sessionId }, operator);
    return { session, sessionId };
  }

  private requireWorkspace(): string {
    if (!this.auth.workspaceId) {
      throw new ApiError(403, "workspace_setup_required", "Choose or join a workspace to continue");
    }
    return this.auth.workspaceId;
  }

  private requireAdministrator(): string {
    const workspaceId = this.requireWorkspace();
    if (this.auth.role !== "owner" && this.auth.role !== "admin") {
      throw new ApiError(403, "workspace_admin_required", "This action requires a workspace administrator");
    }
    return workspaceId;
  }

  private async requireStaff(): Promise<UserId> {
    // A support session is somebody else's authority; it cannot open another.
    if (this.auth.impersonatorUserId) {
      throw new ApiError(403, "support_access_staff_required", "Rally access is available to Rally staff only");
    }
    const row = await this.env.DB.prepare(
      `SELECT 1 AS present FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.workspace_id = ? AND m.user_id = ? AND m.status = 'active' AND m.access_class = 'member'
         AND w.region = ? AND w.abandoned_at IS NULL`,
    ).bind(supportOrganizationId(this.env), this.auth.userId, this.env.AVALON_REGION).first();
    if (!row) throw new ApiError(403, "support_access_staff_required", "Rally access is available to Rally staff only");
    return asUserId(this.auth.userId);
  }

  private async requireGrant(workspaceId: string): Promise<void> {
    const row = await this.env.DB.prepare(
      "SELECT 1 AS present FROM support_access_grants WHERE workspace_id = ? AND expires_at > ?",
    ).bind(workspaceId, nowIso()).first();
    if (!row || workspaceId === supportOrganizationId(this.env)) {
      throw new ApiError(403, "support_access_not_granted", "This organization has not granted Rally access");
    }
  }

  private async audit(
    workspaceId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown>,
    actorUserId: string = this.auth.userId,
  ): Promise<void> {
    await this.env.AUDIT_DB.prepare(
      `INSERT INTO audit_events
         (id, workspace_id, actor_type, actor_user_id, workstream_id, action, target_type, target_id, metadata_json, request_id, created_at)
       VALUES (?, ?, 'user', ?, NULL, ?, ?, ?, ?, NULL, ?)`,
    ).bind(
      `${action}:${newId()}`,
      workspaceId,
      actorUserId,
      action,
      targetType,
      targetId,
      JSON.stringify({ ...metadata, ...(this.auth.impersonatorUserId ? { impersonatorUserId: this.auth.impersonatorUserId } : {}) }),
      nowIso(),
    ).run();
  }
}
