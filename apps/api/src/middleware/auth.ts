import type { MiddlewareHandler } from "hono";
import type { AuthContext, HonoAppEnv, IdentityAuthContext } from "../env";
import { ApiError } from "../lib/api-error";
import { verifyAccessToken } from "../services/auth-service";

type Context = Parameters<MiddlewareHandler<HonoAppEnv>>[0];

async function authenticate(c: Context): Promise<IdentityAuthContext> {
  if (c.env.APP_ENV === "development" && c.env.AVALON_DEV_AUTH === "true") {
    const userId = c.req.header("x-avalon-dev-user-id");
    const workspaceId = c.req.header("x-avalon-dev-workspace-id");
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
    throw new ApiError(401, "authentication_required", "A valid Avalon session is required");
  }
  const claims = await verifyAccessToken(c.env, authorization.slice(7));
  if (claims.region !== c.env.AVALON_REGION) {
    throw new ApiError(409, "region_mismatch", "The session belongs to a different data region");
  }
  const session = await c.env.DB.prepare(
    `SELECT s.workspace_id, m.role, w.region AS workspace_region
     FROM sessions s
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
  };
}

export const requireIdentityAuth: MiddlewareHandler<HonoAppEnv> = async (c, next) => {
  c.set("auth", await authenticate(c));
  await next();
};

export const requireAuth: MiddlewareHandler<HonoAppEnv> = async (c, next) => {
  const auth = await authenticate(c);
  if (!auth.workspaceId || !auth.role) {
    throw new ApiError(403, "workspace_setup_required", "Choose or join an organization to continue");
  }
  c.set("auth", auth);
  await next();
};

export function getIdentityAuth(c: Context): IdentityAuthContext {
  const auth = c.get("auth");
  if (!auth) throw new ApiError(401, "authentication_required", "A valid Avalon session is required");
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
