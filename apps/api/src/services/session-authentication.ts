import type { Env, IdentityAuthContext, RequestMembershipObservation } from "../env";
import { ApiError } from "../lib/api-error";
import { asUserId } from "@rally/contracts";
import { supportSessionLive } from "./support-access";

/** One ordinary-session authority check, shared by bearer and browser transports. */
export async function authenticateSession(env: Env, claims: Omit<IdentityAuthContext, "role">,
  observeMembership?: (membership: RequestMembershipObservation) => void,
): Promise<IdentityAuthContext> {
  if (claims.region !== env.AVALON_REGION) {
    throw new ApiError(409, "region_mismatch", "The session belongs to a different data region");
  }
  // The two analytics surrogates are selected here rather than looked up
  // anywhere else. `workspaces` is already joined, and `users` is one primary
  // key away, so both arrive on a query this request was making regardless —
  // no second round trip, no cache to invalidate, and no copy of identity data
  // outside the region's own database. See `docs/performance-tracing.md`.
  //
  // Both joins are LEFT joins so that a diagnostic can never decide an
  // authentication. A session without its user row is unreachable while the
  // foreign key holds, but the cost of being wrong about that is a signed-out
  // member, and the cost of the defence is nothing.
  const now = new Date().toISOString();
  const session = await env.DB.prepare(
    `SELECT s.workspace_id, m.role, m.access_class, m.incarnation, m.revision, w.region AS workspace_region,
            u.analytics_person_id, w.analytics_workspace_id, s.impersonator_user_id
     FROM sessions s
     LEFT JOIN users u ON u.id = s.user_id
     LEFT JOIN workspace_members m
       ON m.user_id = s.user_id AND m.workspace_id = s.workspace_id AND m.status = 'active'
       AND m.incarnation = s.workspace_incarnation
     LEFT JOIN workspaces w ON w.id = s.workspace_id AND w.abandoned_at IS NULL
     WHERE s.id = ? AND s.user_id = ? AND s.region = ?
       AND s.revoked_at IS NULL AND s.expires_at > ?`,
  )
    .bind(claims.sessionId, claims.userId, claims.region, now)
    .first<{
      workspace_id: string | null;
      access_class: "member" | "guest" | null;
      role: "owner" | "admin" | "member" | null;
      workspace_region: string | null;
      analytics_person_id: string | null;
      analytics_workspace_id: string | null;
      impersonator_user_id: string | null;
      incarnation: string;
      revision: number;
    }>();
  if (!session || session.workspace_id !== claims.workspaceId) {
    throw new ApiError(401, "session_revoked", "The session is no longer active");
  }
  // A support session must also name a live grant and a live staff member,
  // read fresh on every request so a revoke or a removal from Juno Labs ends it
  // on the next one with nothing to invalidate. It is a second statement so an
  // ordinary session, nearly every request, pays nothing for it.
  if (session.impersonator_user_id && !await supportSessionLive(env, claims.sessionId, now)) {
    throw new ApiError(401, "session_revoked", "The session is no longer active");
  }
  if (session.workspace_id && (!(session.access_class === "guest" || session.role) || session.workspace_region !== env.AVALON_REGION)) {
    throw new ApiError(401, "session_revoked", "The session is no longer active");
  }
  if (claims.workspaceId && session.access_class) {
    observeMembership?.({
      workspaceId: claims.workspaceId, userId: claims.userId, accessClass: session.access_class, validatedAt: Date.now(),
      relationship: { workspaceId: claims.workspaceId, userId: claims.userId, accessClass: session.access_class,
        role: session.role, status: 'active', incarnation: session.incarnation, revision: session.revision },
    });
  }
  return {
    ...claims,
    role: session.role,
    ...(session.access_class ? { accessClass: session.access_class } : {}),
    analyticsPersonId: session.analytics_person_id,
    analyticsWorkspaceId: session.analytics_workspace_id,
    ...(session.impersonator_user_id ? { impersonatorUserId: asUserId(session.impersonator_user_id) } : {}),
  };
}

