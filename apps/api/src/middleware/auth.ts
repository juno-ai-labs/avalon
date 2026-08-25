import { RALLY_HEADERS, readRallyHeader } from "@rally/contracts/http-headers";
import { UserIdSchema, WorkspaceIdSchema } from "@rally/contracts";
import type { MiddlewareHandler } from "hono";
import type { AuthContext, Env, HonoAppEnv, IdentityAuthContext } from "../env";
import { ApiError } from "../lib/api-error";
import { requestDeferral } from "../lib/defer";
import { logWarn } from "../observability/logger";
import { verifyAccessToken } from "../services/auth-service";

type Context = Parameters<MiddlewareHandler<HonoAppEnv>>[0];

/**
 * How coarse the record of "this member is using Avalon" is allowed to be.
 *
 * It exists to schedule background work — suggested-work ranking follows
 * attention rather than running for everyone on every activity — and nothing
 * reads it at a finer grain than tens of minutes. Recording every request would
 * put a write on every authenticated read to answer a question no caller asks
 * that precisely.
 */
const LAST_SEEN_RESOLUTION_MS = 5 * 60_000;

/**
 * Record that a member is around, at most once per resolution window.
 *
 * The window is enforced in the statement rather than by reading first: the row
 * is found by primary key either way, and a guarded UPDATE that matches nothing
 * costs one indexed probe, where a read-then-write costs two round trips and
 * still races. Deferred because no response should wait on it, and swallowed
 * because a scheduling hint is never worth failing a request over.
 */
async function touchLastSeen(env: Env, workspaceId: string, userId: string): Promise<void> {
  try {
    const at = new Date();
    await env.DB.prepare(
      `UPDATE workspace_members SET last_seen_at = ?
        WHERE workspace_id = ? AND user_id = ? AND status = 'active'
          AND (last_seen_at IS NULL OR last_seen_at < ?)`,
    )
      .bind(
        at.toISOString(),
        workspaceId,
        userId,
        new Date(at.getTime() - LAST_SEEN_RESOLUTION_MS).toISOString(),
      )
      .run();
  } catch (error) {
    // Async so that a binding which is absent or not a database — as in a route
    // test that stubs only what the route under test touches — raises here
    // rather than synchronously past the caller's guard. Nothing about a request
    // depends on this write; failing one over it would be absurd.
    logWarn(env, "workspace_member_last_seen_write_failed", {
      workspace_id: workspaceId,
      user_id: userId,
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
}

async function authenticate(c: Context): Promise<IdentityAuthContext> {
  if (c.env.APP_ENV === "development" && c.env.RALLY_DEV_AUTH === "true") {
    // Parsed, not cast: a malformed development header is a request that
    // simply is not using dev auth, and must fall through to ordinary
    // authentication rather than 500 on the brand's validation.
    const userId = UserIdSchema.safeParse(readRallyHeader((name) => c.req.header(name), RALLY_HEADERS.DEV_USER_ID)).data;
    const workspaceId = WorkspaceIdSchema.safeParse(readRallyHeader((name) => c.req.header(name), RALLY_HEADERS.DEV_WORKSPACE_ID)).data;
    if (userId && workspaceId) {
      const member = await c.env.DB.prepare(
        `SELECT m.role FROM workspace_members m
         JOIN workspaces w ON w.id = m.workspace_id
         WHERE m.user_id = ? AND m.workspace_id = ? AND m.status = 'active' AND w.region = ?`,
      )
        .bind(userId, workspaceId, c.env.AVALON_REGION)
        .first<{ role: "owner" | "admin" | "member" }>();
      if (member) {
        return {
          sessionId: "development",
          userId,
          workspaceId,
          region: c.env.AVALON_REGION,
          role: member.role,
        };
      }
    }
  }

  const authorization = c.req.header("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw new ApiError(401, "authentication_required", "A valid Rally session is required");
  }
  const claims = await verifyAccessToken(c.env, authorization.slice(7));
  if (claims.region !== c.env.AVALON_REGION) {
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
  const session = await c.env.DB.prepare(
    `SELECT s.workspace_id, m.role, w.region AS workspace_region,
            u.analytics_person_id, w.analytics_workspace_id
     FROM sessions s
     LEFT JOIN users u ON u.id = s.user_id
     LEFT JOIN workspace_members m
       ON m.user_id = s.user_id AND m.workspace_id = s.workspace_id AND m.status = 'active'
     LEFT JOIN workspaces w ON w.id = s.workspace_id
     WHERE s.id = ? AND s.user_id = ? AND s.region = ?
       AND s.revoked_at IS NULL AND s.expires_at > ?`,
  )
    .bind(claims.sessionId, claims.userId, claims.region, new Date().toISOString())
    .first<{
      workspace_id: string | null;
      role: "owner" | "admin" | "member" | null;
      workspace_region: string | null;
      analytics_person_id: string | null;
      analytics_workspace_id: string | null;
    }>();
  if (!session || session.workspace_id !== claims.workspaceId) {
    throw new ApiError(401, "session_revoked", "The session is no longer active");
  }
  if (session.workspace_id && (!session.role || session.workspace_region !== c.env.AVALON_REGION)) {
    throw new ApiError(401, "session_revoked", "The session is no longer active");
  }
  return {
    ...claims,
    role: session.role,
    analyticsPersonId: session.analytics_person_id,
    analyticsWorkspaceId: session.analytics_workspace_id,
  };
}

/**
 * Times `authenticate` onto the request context. The session lookup is one
 * blocking, uncached D1 round trip that every authenticated request pays before
 * its handler runs, and it is invisible in a flow's own span because it happens
 * first. Recording the number is what turns "is auth expensive?" into a query
 * rather than an argument.
 */
async function timedAuthenticate(c: Context): Promise<IdentityAuthContext> {
  const startedAt = Date.now();
  try {
    return await authenticate(c);
  } finally {
    c.set("authDurationMs", Date.now() - startedAt);
  }
}

export const requireIdentityAuth: MiddlewareHandler<HonoAppEnv> = async (c, next) => {
  c.set("auth", await timedAuthenticate(c));
  await next();
};

export const requireAuth: MiddlewareHandler<HonoAppEnv> = async (c, next) => {
  const auth = await timedAuthenticate(c);
  if (!auth.workspaceId || !auth.role) {
    throw new ApiError(403, "workspace_setup_required", "Choose or join an organization to continue");
  }
  c.set("auth", auth);
  requestDeferral(c)(touchLastSeen(c.env, auth.workspaceId, auth.userId));
  await next();
};

export function getIdentityAuth(c: Context): IdentityAuthContext {
  const auth = c.get("auth");
  if (!auth) throw new ApiError(401, "authentication_required", "A valid Rally session is required");
  return auth;
}

export function getAuth(c: Context): AuthContext {
  const auth = getIdentityAuth(c);
  if (!auth.workspaceId || !auth.role) {
    throw new ApiError(403, "workspace_setup_required", "Choose or join an organization to continue");
  }
  return auth as AuthContext;
}

export function requireWorkspaceAdmin(c: Context): void {
  const auth = getAuth(c);
  if (auth.role !== "owner" && auth.role !== "admin") {
    throw new ApiError(403, "workspace_admin_required", "This action requires a workspace administrator");
  }
}
