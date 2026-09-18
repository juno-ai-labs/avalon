import { UserSchema, asUserId, asWorkspaceId, type Session } from "@rally/contracts";
import type { Env, IdentityAuthContext } from "../env";
import { ApiError } from "../lib/api-error";
import { hmacSha256, sha256 } from "../lib/crypto";
import { authenticateSession } from "./session-authentication";
import { AuthService, verifyAccessToken, sessionRenewalPolicy } from "./auth-service";

import { BrowserSessionSchema, type BrowserSession } from "@rally/contracts/browser-session";
export { BrowserSessionSchema, BrowserWorkspacesSchema } from "@rally/contracts/browser-session";

/** A credential index into the ordinary session ledger, never a second user identity. */
export class BrowserSessionService {
  constructor(private readonly env: Env) {}

  async register(session: Session): Promise<{ credential:string; expiresAt:string; session: BrowserSession }> {
    const claims = await verifyAccessToken(this.env, session.accessToken);
    if (claims.workspaceId !== null) throw new Error("browser_identity_session_required");
    await authenticateSession(this.env,claims);
    // Email redemption retries recover the same cookie without storing a
    // readable credential or invalidating a different tab's successful login.
    const credential = await hmacSha256(this.env.SESSION_SIGNING_KEY,
      JSON.stringify(["browser-session",claims.sessionId,session.refreshToken]));
    await this.env.DB.prepare("INSERT INTO browser_sessions(session_id,credential_hash) VALUES (?,?) ON CONFLICT(session_id) DO NOTHING")
      .bind(claims.sessionId,await sha256(credential)).run();
    const auth = await this.read(credential);
    const description = await this.describe(auth);
    return { credential, expiresAt: description.expiresAt, session: description };
  }

  async read(credential: string, workspaceId?: string): Promise<IdentityAuthContext> {
    return authenticateSession(this.env, await this.resolve(credential, workspaceId));
  }

  /** Resolve the root cookie binding; ordinary middleware authenticates the target once. */
  async resolve(credential: string, workspaceId?: string) {
    const selected = workspaceId === undefined ? "root.id" : "selected.session_id";
    const join = workspaceId === undefined ? "" : "JOIN browser_workspace_sessions selected ON selected.browser_session_id=browser.session_id AND selected.workspace_id=?";
    const row = await this.env.DB.prepare(`SELECT target.id,target.user_id,target.workspace_id
      FROM browser_sessions browser JOIN sessions root ON root.id=browser.session_id
      ${join} JOIN sessions target ON target.id=${selected} AND target.user_id=root.user_id
      WHERE browser.credential_hash=? AND root.workspace_id IS NULL AND root.region=?
        AND root.revoked_at IS NULL AND root.expires_at>? AND target.region=?`)
      .bind(...(workspaceId === undefined ? [] : [workspaceId]),await sha256(credential),this.env.AVALON_REGION,
        new Date().toISOString(),this.env.AVALON_REGION)
      .first<{ id:string;user_id:string;workspace_id:string|null }>();
    if (!row || row.workspace_id !== (workspaceId ?? null)) throw new ApiError(401,"browser_session_required","Sign in to continue");
    return { sessionId:row.id,userId:asUserId(row.user_id),
      workspaceId:row.workspace_id === null ? null : asWorkspaceId(row.workspace_id),region:this.env.AVALON_REGION };
  }

  async describe(auth: IdentityAuthContext) {
    const row = await this.env.DB.prepare("SELECT id,email,name,avatar_url,timezone,created_at FROM users WHERE id=?")
      .bind(auth.userId).first<{ id:string;email:string;name:string;avatar_url:string|null;timezone:string;created_at:string }>();
    if (!row) throw new ApiError(401,"browser_session_required","Sign in to continue");
    const workspace = auth.workspaceId === null ? null
      : (await new AuthService(this.env).listRegionalWorkspaces(auth.userId)).find((entry) => entry.id === auth.workspaceId);
    if (auth.workspaceId !== null && !workspace) throw new ApiError(401,"session_revoked","Workspace access has ended");
    return BrowserSessionSchema.parse({ user:UserSchema.parse({ id:row.id,email:row.email,name:row.name,
      avatarUrl:row.avatar_url,timezone:row.timezone,createdAt:row.created_at }),workspace,
      expiresAt:await this.expiry(auth.sessionId) });
  }

  async select(credential: string, workspaceId: string) {
    const root = await this.read(credential);
    try { return await this.describe(await this.read(credential,workspaceId)); }
    catch (error) { if (!(error instanceof ApiError) || error.status !== 401) throw error; }
    const previous = await this.env.DB.prepare("SELECT session_id FROM browser_workspace_sessions WHERE browser_session_id=? AND workspace_id=?")
      .bind(root.sessionId,workspaceId).first<{ session_id:string }>();
    const service = new AuthService(this.env);
    const session = await service.createRegionalSession(root.userId,workspaceId);
    const claims = await verifyAccessToken(this.env,session.accessToken);
    // A workspace session must never outlive the browser identity that owns it.
    await this.env.DB.prepare("UPDATE sessions SET expires_at=MIN(expires_at,(SELECT expires_at FROM sessions WHERE id=?)) WHERE id=?")
      .bind(root.sessionId,claims.sessionId).run();
    const inserted = await this.env.DB.prepare(`INSERT INTO browser_workspace_sessions(browser_session_id,workspace_id,session_id)
      SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM sessions WHERE id=? AND revoked_at IS NULL AND expires_at>?)
      ON CONFLICT(browser_session_id,workspace_id) DO UPDATE SET session_id=excluded.session_id
      WHERE browser_workspace_sessions.session_id IS ? RETURNING session_id`)
      .bind(root.sessionId,workspaceId,claims.sessionId,root.sessionId,new Date().toISOString(),previous?.session_id ?? null)
      .first<{ session_id:string }>();
    if (!inserted) await service.logout({ sessionId:claims.sessionId });
    return this.describe(await this.read(credential,workspaceId));
  }

  async renew(credential: string) {
    const root = await this.read(credential);
    const renewal = sessionRenewalPolicy(this.env.AVALON_REGION);
    const results = await this.env.DB.batch([
      this.env.DB.prepare(`UPDATE sessions SET expires_at=${renewal.expirySql}
        WHERE id=? AND ${renewal.eligibilitySql}`)
        .bind(...renewal.expiryValues,root.sessionId,...renewal.eligibilityValues),
      this.env.DB.prepare(`UPDATE sessions SET expires_at=MIN(${renewal.expirySql},
        (SELECT expires_at FROM sessions WHERE id=?)) WHERE id IN (
          SELECT session_id FROM browser_workspace_sessions WHERE browser_session_id=?)
        AND ${renewal.eligibilitySql}`)
        .bind(...renewal.expiryValues,root.sessionId,root.sessionId,...renewal.eligibilityValues),
    ]);
    if (results[0]?.meta.changes !== 1) throw new ApiError(401,"browser_session_required","Sign in to continue");
    return this.describe(await this.read(credential));
  }

  async logout(credential: string): Promise<void> {
    const row = await this.env.DB.prepare("SELECT session_id FROM browser_sessions WHERE credential_hash=?")
      .bind(await sha256(credential)).first<{ session_id:string }>();
    if (!row) return;
    // End identity first: racing workspace activations can no longer admit a
    // browser request. Ordinary logout publishes each socket revocation.
    const service = new AuthService(this.env);
    await service.logout({ sessionId:row.session_id });
    const children = await this.env.DB.prepare("SELECT session_id FROM browser_workspace_sessions WHERE browser_session_id=?")
      .bind(row.session_id).all<{ session_id:string }>();
    await Promise.all(children.results.map((child) => service.logout({ sessionId:child.session_id })));
  }

  private async expiry(sessionId: string): Promise<string> {
    const row = await this.env.DB.prepare("SELECT expires_at FROM sessions WHERE id=?").bind(sessionId).first<{ expires_at:string }>();
    if (!row) throw new ApiError(401,"browser_session_required","Sign in to continue");
    return row.expires_at;
  }
}
