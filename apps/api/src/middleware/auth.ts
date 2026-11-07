import { authenticateSession } from "../services/session-authentication";
import { RALLY_HEADERS, readRallyHeader } from "@rally/contracts/http-headers";
import { UserIdSchema, WorkspaceIdSchema } from "@rally/contracts";
import type { MiddlewareHandler } from "hono";
import type {
  AuthContext,
  Env,
  HonoAppEnv,
  IdentityAuthContext,
  RequestMembershipObservation,
} from "../env";
import { ApiError } from "../lib/api-error";
import { requestDeferral } from "../lib/defer";
import { logWarn } from "../observability/logger";
import { verifyAccessToken } from "../services/auth-service";
import { recordSupportAction } from "../services/support-access";

type Context = Parameters<MiddlewareHandler<HonoAppEnv>>[0];

/**
 * How coarse the record of "this member is using Avalon" is allowed to be.
 *
 * It exists to schedule background work that follows attention rather than
 * running for everyone on every activity, and nothing
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

export async function authenticate(c: Context): Promise<IdentityAuthContext> {
  if (c.env.APP_ENV === "development" && c.env.RALLY_DEV_AUTH === "true") {
    // Parsed, not cast: a malformed development header is a request that
    // simply is not using dev auth, and must fall through to ordinary
    // authentication rather than 500 on the brand's validation.
    const userId = UserIdSchema.safeParse(readRallyHeader((name) => c.req.header(name), RALLY_HEADERS.DEV_USER_ID)).data;
    const workspaceId = WorkspaceIdSchema.safeParse(readRallyHeader((name) => c.req.header(name), RALLY_HEADERS.DEV_WORKSPACE_ID)).data;
    if (userId && workspaceId) {
      const member = await c.env.DB.prepare(
        `SELECT m.role, m.access_class FROM workspace_members m
         JOIN workspaces w ON w.id = m.workspace_id
         WHERE m.user_id = ? AND m.workspace_id = ? AND m.status = 'active'
           AND w.region = ? AND w.abandoned_at IS NULL`,
      )
        .bind(userId, workspaceId, c.env.AVALON_REGION)
        .first<{ role: "owner" | "admin" | "member" | null; access_class: "member" | "guest" }>();
      if (member) {
        return {
          sessionId: "development",
          userId,
          workspaceId,
          region: c.env.AVALON_REGION,
          role: member.role,
          accessClass: member.access_class,
        };
      }
    }
  }

  const authorization = c.req.header("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw new ApiError(401, "authentication_required", "A valid Rally session is required");
  }
  const claims = await verifyAccessToken(c.env, authorization.slice(7));
  return authenticateSession(c.env, claims, (membership) => c.set('requestMembership', membership));
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
  // Root-mounted `requireIdentityAuth` writes this request-local value before
  // protected routes reach us. The fallback keeps this middleware correct when
  // mounted alone; every new request still checks revocation.
  const auth = c.get("auth") ?? await timedAuthenticate(c);
  if (!auth.workspaceId || !auth.role) {
    throw new ApiError(403, "workspace_setup_required", "Choose or join a workspace to continue");
  }
  c.set("auth", auth);
  // Staff acting as somebody is not that somebody being around.
  if (!auth.impersonatorUserId) requestDeferral(c)(touchLastSeen(c.env, auth.workspaceId, auth.userId));
  await next();
};

export function getIdentityAuth(c: Context): IdentityAuthContext {
  const auth = c.get("auth");
  if (!auth) throw new ApiError(401, "authentication_required", "A valid Rally session is required");
  return auth;
}

/** Workspace relationship only; the caller must authorize the exact product scope. */
export function getWorkspaceAuth(c: Context): AuthContext {
  const auth = getIdentityAuth(c);
  if (!auth.workspaceId || (!auth.role && auth.accessClass !== "guest")) {
    throw new ApiError(403,"workspace_setup_required","Choose or join a workspace to continue");
  }
  return auth as AuthContext;
}

export const requireWorkspaceAuth: MiddlewareHandler<HonoAppEnv> = async (c,next) => {
  c.set("auth",c.get("auth") ?? await timedAuthenticate(c));
  const auth = getWorkspaceAuth(c);
  c.set("requestMembership", c.get("requestMembership") ?? {
    workspaceId: auth.workspaceId,
    userId: auth.userId,
    accessClass: auth.accessClass ?? "member",
    validatedAt: Date.now(),
  });
  if (!auth.impersonatorUserId) requestDeferral(c)(touchLastSeen(c.env,auth.workspaceId,auth.userId));
  await next();
};

/** Membership proof created by this request's authentication middleware. */
export function getRequestMembership(c: Context): RequestMembershipObservation {
  const observation = c.get("requestMembership");
  if (!observation) throw new Error("request_membership_observation_missing");
  return observation;
}

export function getAuth(c: Context): AuthContext {
  const auth = getIdentityAuth(c);
  if (!auth.workspaceId || !auth.role) {
    throw new ApiError(403, "workspace_setup_required", "Choose or join a workspace to continue");
  }
  return auth as AuthContext;
}

/**
 * Record every write a support session makes over HTTP (`docs/impersonation.md`),
 * after the response and off the request's critical path. Mounted at the root:
 * the auth context is set by whichever sub-app authenticated the request, and
 * reads (GET, HEAD, OPTIONS) are not recorded.
 */
export const auditSupportWrites: MiddlewareHandler<HonoAppEnv> = async (c, next) => {
  await next();
  const auth = c.get("auth");
  if (!auth?.impersonatorUserId || !auth.workspaceId || ["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return;
  requestDeferral(c)(recordSupportAction(c.env, {
    workspaceId: auth.workspaceId,
    impersonatorUserId: auth.impersonatorUserId,
    representedUserId: auth.userId,
    sessionId: auth.sessionId,
    action: "support_session.request",
    metadata: { method: c.req.method, path: c.req.path, status: c.res.status },
  }));
};

/**
 * Refuse a support session (`docs/impersonation.md`) at a door that mints
 * another credential or binds a device to the person. A support session is
 * the person's own authority inside one Organization for as long as its grant
 * lasts; exchanging it for an ordinary session, opening another Organization,
 * or registering for the person's notifications would outlive or exceed that.
 */
export const refuseSupportSession: MiddlewareHandler<HonoAppEnv> = async (c, next) => {
  const auth = c.get("auth") ?? await timedAuthenticate(c);
  c.set("auth", auth);
  if (auth.impersonatorUserId) {
    throw new ApiError(403, "support_session_not_allowed", "This is not available while signed in through Rally access");
  }
  await next();
};

export function requireWorkspaceAdmin(c: Context): void {
  const auth = getAuth(c);
  if (auth.role !== "owner" && auth.role !== "admin") {
    throw new ApiError(403, "workspace_admin_required", "This action requires a workspace administrator");
  }
}
