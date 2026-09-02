import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import { newId, nowIso } from "@rally/db";
import { asUserId, asWorkspaceId, type Region, type Session } from "@rally/contracts";
import { isDesktopDeepLinkProtocol } from "@rally/contracts/desktop-deep-link";
import type { Env, IdentityAuthContext } from "../env";
import { ApiError } from "../lib/api-error";
import { publishSessionRevocations, type RevokedSessionRow } from "./access-revocation";
import { logWarn } from "../observability/logger";
import { openString, randomToken, sealString, sha256, timingSafeEqualText } from "../lib/crypto";

const encoder = new TextEncoder();
const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const ACCESS_TTL_SECONDS = 15 * 60;
/**
 * How long a session may go without renewal, and how long it may live at all.
 *
 * Every renewal slides `expires_at` to thirty days from that moment, so a
 * person who opens Rally at least once a month is never signed out by expiry
 * alone; a session that stops being renewed dies thirty days after its last
 * renewal. The ceiling is absolute: ninety days from the session's creation a
 * fresh sign-in is required whatever happened in between, which bounds how
 * long a leaked refresh token can keep itself alive. Both numbers were named
 * by the team (2026-09-02); `refresh` is the one place they are applied.
 */
const SESSION_RENEWAL_WINDOW_SECONDS = 30 * 24 * 60 * 60;
const SESSION_MAX_LIFETIME_SECONDS = 90 * 24 * 60 * 60;
export const DEVELOPMENT_USER_ID = "00000000-0000-7000-8000-000000000001";
export const DEVELOPMENT_WORKSPACE_ID = "00000000-0000-7000-8000-000000000002";

function identityBootstrapWorkspaceId(): null {
  return null;
}

interface OAuthStateRow {
  id: string;
  region: Region;
  purpose: string;
  code_verifier_encrypted: string;
  user_id: string | null;
  workspace_id: string | null;
  workspace_name: string | null;
  invitation_id: string | null;
  desktop_attempt_id: string | null;
  desktop_code_challenge: string | null;
  return_uri: string;
  expires_at: string;
  consumed_at: string | null;
}

interface IdentityRow {
  user_id: string;
  email: string;
  user_name: string;
  avatar_url: string | null;
  user_timezone: string;
  user_created_at: string;
  workspace_id: string | null;
  workspace_name: string | null;
  workspace_slug: string | null;
  workspace_region: Region | null;
  workspace_timezone: string | null;
  workspace_created_at: string | null;
  role: "owner" | "admin" | "member" | null;
}

function secretKey(env: Env): Uint8Array {
  if (env.SESSION_SIGNING_KEY) return encoder.encode(env.SESSION_SIGNING_KEY);
  if (env.APP_ENV === "development" && env.RALLY_DEV_AUTH === "true") {
    return encoder.encode("avalon-development-session-key-not-for-production");
  }
  throw new ApiError(503, "auth_not_configured", "Authentication is not configured");
}

async function issueAccessToken(env: Env, context: Omit<IdentityAuthContext, "role">): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    sid: context.sessionId,
    wid: context.workspaceId,
    region: context.region,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(context.userId)
    .setIssuer("avalon-api")
    .setAudience("avalon-desktop")
    .setIssuedAt(now)
    .setExpirationTime(now + ACCESS_TTL_SECONDS)
    .sign(secretKey(env));
}

export async function verifyAccessToken(env: Env, token: string): Promise<Omit<IdentityAuthContext, "role">> {
  try {
    const { payload } = await jwtVerify(token, secretKey(env), {
      algorithms: ["HS256"],
      issuer: "avalon-api",
      audience: "avalon-desktop",
    });
    if (
      typeof payload.sub !== "string" ||
      typeof payload.sid !== "string" ||
      (payload.wid !== null && payload.wid !== undefined && typeof payload.wid !== "string") ||
      (payload.region !== "global" && payload.region !== "eu")
    ) {
      throw new Error("Incomplete session claims");
    }
    return {
      sessionId: payload.sid,
      userId: asUserId(payload.sub),
      workspaceId: typeof payload.wid === "string" ? asWorkspaceId(payload.wid) : null,
      region: payload.region,
    };
  } catch {
    throw new ApiError(401, "invalid_session", "The session is invalid or expired");
  }
}

/**
 * The desktop return URI, checked against the one destination this deployment
 * will send a completed sign-in to.
 *
 * Host and path are pinned to the configured value; the *scheme* is not, and
 * deliberately. A build shipped before the rename registered only `avalon:` and
 * sends it here as `returnUri` — it cannot be made to send anything else — so
 * pinning the scheme to `DESKTOP_DEEP_LINK_URI` would fail every one of those
 * clients at `POST /auth/google/start` with `invalid_return_uri`, before OAuth
 * begins. The caller's own scheme is returned rather than the configured one,
 * so the completion lands in the scheme that calling build actually claimed.
 *
 * This is the "widen what is read" half of the rule in `docs/domain-migration.md`.
 * It narrows again when the legacy scheme leaves `DESKTOP_DEEP_LINK_PROTOCOLS`.
 */
function allowedReturnUri(env: Env, candidate: string | undefined): string {
  const expected = new URL(env.DESKTOP_DEEP_LINK_URI);
  const value = new URL(candidate ?? env.DESKTOP_DEEP_LINK_URI);
  if (
    !isDesktopDeepLinkProtocol(value.protocol)
    || value.host !== expected.host
    || value.pathname !== expected.pathname
  ) {
    throw new ApiError(422, "invalid_return_uri", "The desktop return URI is not allowed");
  }
  return value.toString();
}

function callbackUrl(env: Env, purpose: "identity" | "connector"): string {
  return new URL(
    purpose === "identity" ? "/auth/google/callback" : "/connections/google/callback",
    env.PUBLIC_API_BASE_URL,
  ).toString();
}

export class AuthService {
  constructor(private readonly env: Env) {}

  async beginIdentity(input: {
    returnUri?: string;
    desktopAttemptId: string;
    desktopCodeChallenge: string;
  }): Promise<string> {
    if (this.env.AVALON_REGION !== "global") {
      throw new ApiError(409, "global_identity_required", "Sign in through the Avalon platform identity endpoint");
    }
    if (!this.env.GOOGLE_OAUTH_CLIENT_ID || !this.env.GOOGLE_OAUTH_CLIENT_SECRET) {
      throw new ApiError(503, "google_oauth_not_configured", "Google authentication is not configured");
    }
    if (!/^[A-Za-z0-9_-]{43}$/u.test(input.desktopAttemptId)) {
      throw new ApiError(422, "invalid_desktop_attempt", "The desktop authentication attempt is invalid");
    }
    if (!/^[A-Za-z0-9_-]{43}$/u.test(input.desktopCodeChallenge)) {
      throw new ApiError(422, "invalid_desktop_challenge", "The desktop authentication challenge is invalid");
    }
    const state = randomToken(32);
    const googleVerifier = randomToken(64);
    const googleChallenge = await sha256(googleVerifier);
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const encryptedVerifier = await sealString(googleVerifier, this.env.OAUTH_STATE_ENCRYPTION_KEY);
    await this.env.DB.prepare(
      `INSERT INTO oauth_states
       (id, region, provider, purpose, code_verifier_encrypted, workspace_id,
        workspace_name, invitation_id, desktop_attempt_id, desktop_code_challenge,
        return_uri, expires_at)
       VALUES (?, ?, 'google', 'identity', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        state,
        this.env.AVALON_REGION,
        encryptedVerifier,
        null,
        null,
        null,
        input.desktopAttemptId,
        input.desktopCodeChallenge,
        allowedReturnUri(this.env, input.returnUri),
        expiresAt,
      )
      .run();

    const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorize.search = new URLSearchParams({
      client_id: this.env.GOOGLE_OAUTH_CLIENT_ID,
      redirect_uri: callbackUrl(this.env, "identity"),
      response_type: "code",
      scope: "openid email profile",
      state,
      code_challenge: googleChallenge,
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return authorize.toString();
  }

  async createDevelopmentSession(workspaceName = "Avalon Development"): Promise<Session> {
    if (this.env.APP_ENV !== "development" || this.env.RALLY_DEV_AUTH !== "true") {
      throw new ApiError(404, "not_found", "Development authentication is unavailable");
    }
    const at = nowIso();
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO users (id, google_subject, email, name, avatar_url, created_at, updated_at)
         VALUES (?, 'development-user', 'dev@avalon.local', 'Adam', NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
      ).bind(DEVELOPMENT_USER_ID, at, at),
      this.env.DB.prepare(
        `INSERT INTO workspaces (id, name, slug, region, timezone, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, 'avalon-development', ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, updated_at = excluded.updated_at, abandoned_at = NULL`,
      ).bind(
        DEVELOPMENT_WORKSPACE_ID,
        workspaceName.trim(),
        this.env.AVALON_REGION,
        this.env.AVALON_REGION === "eu" ? "Europe/London" : "America/Los_Angeles",
        DEVELOPMENT_USER_ID,
        at,
        at,
      ),
      this.env.DB.prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
         VALUES (?, ?, 'owner', 'active', ?)
         ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = 'owner', status = 'active'`,
      ).bind(DEVELOPMENT_WORKSPACE_ID, DEVELOPMENT_USER_ID, at),
    ]);
    return this.createSession(await this.loadIdentity(DEVELOPMENT_USER_ID, DEVELOPMENT_WORKSPACE_ID));
  }

  async createDevelopmentIdentitySession(): Promise<Session> {
    if (this.env.APP_ENV !== "development" || this.env.RALLY_DEV_AUTH !== "true") {
      throw new ApiError(404, "not_found", "Development authentication is unavailable");
    }
    if (this.env.AVALON_REGION !== "global") {
      throw new ApiError(409, "global_identity_required", "Development identity belongs to the Global control plane");
    }
    const at = nowIso();
    await this.env.DB.prepare(
      `INSERT INTO users (id, google_subject, email, name, avatar_url, created_at, updated_at)
       VALUES (?, 'development-user', 'dev@avalon.local', 'Adam', NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
    ).bind(DEVELOPMENT_USER_ID, at, at).run();
    return this.createSession(await this.loadIdentity(DEVELOPMENT_USER_ID, null));
  }

  async consumeIdentityCallback(code: string, state: string): Promise<string> {
    if (this.env.AVALON_REGION !== "global") {
      throw new ApiError(409, "global_identity_required", "Sign in through the Avalon platform identity endpoint");
    }
    // The same guard `beginIdentity` applies, on the other half of the flow.
    // Without it an unconfigured deployment sends `undefined` to Google and
    // reports the provider's rejection as a token-exchange failure.
    if (!this.env.GOOGLE_OAUTH_CLIENT_ID || !this.env.GOOGLE_OAUTH_CLIENT_SECRET) {
      throw new ApiError(503, "google_oauth_not_configured", "Google authentication is not configured");
    }
    const row = await this.claimOAuthState(state, "identity");
    if (!row.desktop_attempt_id || !row.desktop_code_challenge) {
      throw new ApiError(401, "invalid_desktop_binding", "The desktop authentication binding is missing");
    }
    const verifier = await openString(row.code_verifier_encrypted, this.env.OAUTH_STATE_ENCRYPTION_KEY);
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.env.GOOGLE_OAUTH_CLIENT_ID,
        client_secret: this.env.GOOGLE_OAUTH_CLIENT_SECRET,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: callbackUrl(this.env, "identity"),
      }),
    });
    if (!tokenResponse.ok) {
      throw new ApiError(502, "google_token_exchange_failed", "Google did not complete sign-in");
    }
    const tokens = (await tokenResponse.json()) as { id_token?: string };
    if (!tokens.id_token) throw new ApiError(502, "google_identity_missing", "Google did not return an identity token");
    const verified = await jwtVerify(tokens.id_token, googleKeys, {
      audience: this.env.GOOGLE_OAUTH_CLIENT_ID,
      issuer: ["https://accounts.google.com", "accounts.google.com"],
    });
    const claims = verified.payload;
    if (
      typeof claims.sub !== "string" ||
      typeof claims.email !== "string" ||
      claims.email_verified !== true
    ) {
      throw new ApiError(401, "google_identity_invalid", "Google identity information is incomplete");
    }
    const identity = await this.upsertIdentity({
      subject: claims.sub,
      email: claims.email,
      name: typeof claims.name === "string" ? claims.name : claims.email.split("@")[0] ?? "Avalon user",
      avatarUrl: typeof claims.picture === "string" ? claims.picture : null,
    });
    const ticket = randomToken(40);
    const ticketHash = await sha256(ticket);
    const at = nowIso();
    await this.env.DB.prepare(
      `INSERT INTO desktop_login_tickets
       (id, ticket_hash, user_id, workspace_id, region, desktop_attempt_id,
        desktop_code_challenge, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        newId(),
        ticketHash,
        identity.user_id,
        // Google identity always returns an unbound Global bootstrap ticket.
        // Even an existing Global member must pass through cross-region
        // discovery so conflicting memberships cannot bypass the control plane.
        identityBootstrapWorkspaceId(),
        this.env.AVALON_REGION,
        row.desktop_attempt_id,
        row.desktop_code_challenge,
        new Date(Date.now() + 2 * 60_000).toISOString(),
        at,
      )
      .run();
    const target = new URL(row.return_uri);
    target.searchParams.set("ticket", ticket);
    target.searchParams.set("region", this.env.AVALON_REGION);
    target.searchParams.set("attempt", row.desktop_attempt_id);
    return target.toString();
  }

  async consumeIdentityDenial(state: string): Promise<string> {
    if (this.env.AVALON_REGION !== "global") {
      throw new ApiError(409, "global_identity_required", "Sign in through the Avalon platform identity endpoint");
    }
    const row = await this.claimOAuthState(state, "identity");
    const target = new URL(row.return_uri);
    target.searchParams.set("error", "google_oauth_denied");
    target.searchParams.set("region", this.env.AVALON_REGION);
    if (row.desktop_attempt_id) target.searchParams.set("attempt", row.desktop_attempt_id);
    return target.toString();
  }

  async exchangeDesktopTicket(input: {
    ticket: string;
    region: Region;
    attemptId: string;
    codeVerifier: string;
    timezone?: string | undefined;
  }): Promise<Session> {
    if (input.region !== this.env.AVALON_REGION) {
      throw new ApiError(409, "region_mismatch", "The login ticket belongs to another region");
    }
    const hash = await sha256(input.ticket);
    const claimed = await this.env.DB.prepare(
      `UPDATE desktop_login_tickets SET consumed_at = ?
       WHERE ticket_hash = ? AND region = ? AND desktop_attempt_id = ?
         AND consumed_at IS NULL AND expires_at > ?
       RETURNING user_id, workspace_id, desktop_code_challenge`,
    )
      .bind(nowIso(), hash, input.region, input.attemptId, nowIso())
      .first<{ user_id: string; workspace_id: string | null; desktop_code_challenge: string | null }>();
    if (!claimed) throw new ApiError(401, "invalid_login_ticket", "The login ticket is invalid, expired, or already used");
    const proof = await sha256(input.codeVerifier);
    if (!claimed.desktop_code_challenge || !timingSafeEqualText(proof, claimed.desktop_code_challenge)) {
      // Matching ticket + attempt claims are intentionally burned on a wrong
      // verifier, mirroring RFC 7636 authorization-code redemption semantics.
      throw new ApiError(401, "invalid_login_ticket", "The login ticket is invalid, expired, or already used");
    }
    // Seeding, not overwriting. The machine's zone is the best guess Avalon has
    // for an account that has never said, and it is worse than nothing for one
    // that has: signing in from a laptop in another zone would silently move
    // every automation and digest the person scheduled. A client that sends no
    // zone leaves the account alone rather than being answered with a default.
    if (input.timezone) {
      await this.env.DB.prepare(
        "UPDATE users SET timezone = ?, updated_at = ? WHERE id = ? AND timezone_source = 'client'",
      )
        .bind(input.timezone, nowIso(), claimed.user_id)
        .run();
    }
    const identity = await this.loadIdentity(claimed.user_id, claimed.workspace_id);
    return this.createSession(identity);
  }

  async refresh(refreshToken: string): Promise<Session> {
    const oldHash = await sha256(refreshToken);
    const newRefreshToken = randomToken(48);
    const newHash = await sha256(newRefreshToken);
    const rotatedAt = nowIso();
    const replayGraceStart = new Date(Date.now() - 60_000).toISOString();
    const renewedExpiry = new Date(Date.now() + SESSION_RENEWAL_WINDOW_SECONDS * 1_000).toISOString();
    // The ceiling is computed beside the row it bounds, in the same statement
    // that rotates the token, so a renewal can never extend a session past it
    // and a session already past it is refused rather than handed a token the
    // bearer check would reject a moment later. `strftime` is given the exact
    // shape `toISOString` writes, so the dates compared are one format and
    // order as text the way they order in time.
    const ceilingModifier = `+${SESSION_MAX_LIFETIME_SECONDS} seconds`;
    const row = await this.env.DB.prepare(
      `UPDATE sessions
       SET previous_refresh_token_hash = refresh_token_hash,
           refresh_token_hash = ?, refresh_rotated_at = ?,
           expires_at = MIN(?, strftime('%Y-%m-%dT%H:%M:%fZ', created_at, ?))
       WHERE (
           refresh_token_hash = ?
           OR (previous_refresh_token_hash = ? AND refresh_rotated_at >= ?)
         )
         AND region = ? AND revoked_at IS NULL AND expires_at > ?
         AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, ?) > ?
       RETURNING id, user_id, workspace_id`,
    )
      .bind(
        newHash,
        rotatedAt,
        renewedExpiry,
        ceilingModifier,
        oldHash,
        oldHash,
        replayGraceStart,
        this.env.AVALON_REGION,
        rotatedAt,
        ceilingModifier,
        rotatedAt,
      )
      .first<{ id: string; user_id: string; workspace_id: string | null }>();
    if (!row) throw new ApiError(401, "invalid_refresh_token", "The refresh token is invalid or expired");
    const identity = await this.loadIdentity(row.user_id, row.workspace_id);
    const accessToken = await issueAccessToken(this.env, {
      sessionId: row.id,
      userId: asUserId(row.user_id),
      workspaceId: row.workspace_id === null ? null : asWorkspaceId(row.workspace_id),
      region: this.env.AVALON_REGION,
    });
    return this.formatSession(identity, accessToken, newRefreshToken);
  }

  /**
   * End a session, and close the sockets it is holding.
   *
   * The revocation is published for every session this call actually revoked,
   * read back from the same statements that revoked them. Nothing else can tell
   * an object that a session ended — see `docs/access-revocation.md` — so a
   * session revoked without a message here stays connected until the window
   * closes.
   */
  async logout(input: { refreshToken?: string; sessionId?: string }): Promise<void> {
    // A verified bearer session is authoritative. A stale or attacker-supplied
    // refresh token must never prevent that authenticated session from being
    // revoked; when both are present, revoke both identifiers idempotently.
    //
    // Both statements skip a row already revoked, so what comes back is what
    // this call actually ended — a repeated logout revokes nothing and
    // announces nothing. The revocation stays idempotent either way; this is
    // the same exactly-once care the expiry sweep takes, applied here so the
    // two do not disagree about what a revocation announcement means.
    const revoked: RevokedSessionRow[] = [];
    if (input.sessionId) {
      const row = await this.env.DB.prepare(
        `UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
         RETURNING id, user_id, workspace_id`,
      )
        .bind(nowIso(), input.sessionId)
        .first<RevokedSessionRow>();
      if (row) revoked.push(row);
    }
    if (input.refreshToken) {
      const at = nowIso();
      const replayGraceStart = new Date(Date.now() - 60_000).toISOString();
      const tokenHash = await sha256(input.refreshToken);
      const result = await this.env.DB.prepare(
        `UPDATE sessions SET revoked_at = ?
         WHERE revoked_at IS NULL
           AND (refresh_token_hash = ?
             OR (previous_refresh_token_hash = ? AND refresh_rotated_at >= ?))
         RETURNING id, user_id, workspace_id`,
      )
        .bind(at, tokenHash, tokenHash, replayGraceStart)
        .all<RevokedSessionRow>();
      revoked.push(...(result.results ?? []));
    }
    // The return value says what was announced, and here it can only be logged:
    // these rows are already revoked, so unlike the expiry sweep there is no
    // later run that will pick up what did not go out. A logout whose message
    // was dropped leaves that session's sockets open until they reconnect —
    // this line is the only trace of it. See `docs/access-revocation.md`.
    const announced = await publishSessionRevocations(this.env, revoked, "session_revoked");
    if (announced.length !== revoked.length) {
      logWarn(this.env, "session_revocation_unannounced", {
        revoked: revoked.length,
        announced: announced.length,
      });
    }
  }

  private async claimOAuthState(state: string, purpose: string): Promise<OAuthStateRow> {
    const row = await this.env.DB.prepare(
      `UPDATE oauth_states SET consumed_at = ?
       WHERE id = ? AND provider = 'google' AND purpose = ? AND region = ?
         AND consumed_at IS NULL AND expires_at > ?
       RETURNING *`,
    )
      .bind(nowIso(), state, purpose, this.env.AVALON_REGION, nowIso())
      .first<OAuthStateRow>();
    if (!row) throw new ApiError(401, "invalid_oauth_state", "The OAuth request is invalid or expired");
    return row;
  }

  private async upsertIdentity(input: {
    subject: string;
    email: string;
    name: string;
    avatarUrl: string | null;
  }): Promise<IdentityRow> {
    const at = nowIso();
    const userId = newId();
    await this.env.DB.prepare(
      `INSERT INTO users (id, google_subject, email, name, avatar_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(google_subject) DO UPDATE SET
         email = excluded.email, name = excluded.name, avatar_url = excluded.avatar_url, updated_at = excluded.updated_at`,
    )
      .bind(userId, input.subject, input.email, input.name, input.avatarUrl, at, at)
      .run();
    const user = await this.env.DB.prepare("SELECT id FROM users WHERE google_subject = ?")
      .bind(input.subject)
      .first<{ id: string }>();
    if (!user) throw new ApiError(500, "identity_persistence_failed", "Could not persist the user identity");
    const platformLink = await this.env.DB.prepare(
      `UPDATE users SET platform_user_id = ?, updated_at = ?
       WHERE id = ? AND (platform_user_id IS NULL OR platform_user_id = ?)`,
    ).bind(user.id, at, user.id, user.id).run();
    if (Number(platformLink.meta.changes ?? 0) !== 1) {
      throw new ApiError(409, "platform_identity_conflict", "The Global identity could not be linked safely");
    }
    return this.loadIdentity(user.id, null);
  }

  private async loadIdentity(userId: string, workspaceId: string | null): Promise<IdentityRow> {
    if (!workspaceId) {
      const user = await this.env.DB.prepare(
        `SELECT id AS user_id, email, name AS user_name, avatar_url, timezone AS user_timezone,
           created_at AS user_created_at
         FROM users WHERE id = ?`,
      )
        .bind(userId)
        .first<Pick<IdentityRow, "user_id" | "email" | "user_name" | "avatar_url" | "user_timezone" | "user_created_at">>();
      if (!user) throw new ApiError(401, "identity_not_found", "The signed-in user no longer exists");
      return {
        ...user,
        workspace_id: null,
        workspace_name: null,
        workspace_slug: null,
        workspace_region: null,
        workspace_timezone: null,
        workspace_created_at: null,
        role: null,
      };
    }
    const row = await this.env.DB.prepare(
      `SELECT u.id AS user_id, u.email, u.name AS user_name, u.avatar_url,
         u.timezone AS user_timezone,
         u.created_at AS user_created_at, w.id AS workspace_id, w.name AS workspace_name,
         w.slug AS workspace_slug, w.region AS workspace_region, w.timezone AS workspace_timezone,
         w.created_at AS workspace_created_at, m.role
       FROM users u JOIN workspace_members m ON m.user_id = u.id
       JOIN workspaces w ON w.id = m.workspace_id
       WHERE u.id = ? AND w.id = ? AND m.status = 'active'
         AND w.abandoned_at IS NULL`,
    )
      .bind(userId, workspaceId)
      .first<IdentityRow>();
    if (!row || row.workspace_region !== this.env.AVALON_REGION) {
      throw new ApiError(403, "workspace_access_denied", "Workspace access is unavailable");
    }
    return row;
  }

  /** Issues a normal region-local session after the Global control plane has
   * authenticated and selected a regional membership. */
  async createRegionalSession(userId: string, workspaceId: string): Promise<Session> {
    return this.createSession(await this.loadIdentity(userId, workspaceId));
  }

  private async createSession(identity: IdentityRow): Promise<Session> {
    const sessionId = newId();
    const refreshToken = randomToken(48);
    const at = nowIso();
    await this.env.DB.prepare(
      `INSERT INTO sessions
       (id, user_id, workspace_id, region, refresh_token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        sessionId,
        identity.user_id,
        identity.workspace_id,
        this.env.AVALON_REGION,
        await sha256(refreshToken),
        new Date(Date.now() + SESSION_RENEWAL_WINDOW_SECONDS * 1_000).toISOString(),
        at,
      )
      .run();
    const accessToken = await issueAccessToken(this.env, {
      sessionId,
      userId: asUserId(identity.user_id),
      workspaceId: identity.workspace_id === null ? null : asWorkspaceId(identity.workspace_id),
      region: this.env.AVALON_REGION,
    });
    return this.formatSession(identity, accessToken, refreshToken);
  }

  private formatSession(identity: IdentityRow, accessToken: string, refreshToken: string): Session {
    return {
      accessToken,
      refreshToken,
      expiresAt: new Date(Date.now() + ACCESS_TTL_SECONDS * 1_000).toISOString(),
      user: {
        id: identity.user_id,
        email: identity.email,
        name: identity.user_name,
        avatarUrl: identity.avatar_url,
        timezone: identity.user_timezone,
        createdAt: identity.user_created_at,
      },
      workspace: identity.workspace_id && identity.workspace_name && identity.workspace_slug
        && identity.workspace_region && identity.workspace_timezone && identity.role && identity.workspace_created_at
        ? {
            id: identity.workspace_id,
            name: identity.workspace_name,
            slug: identity.workspace_slug,
            region: identity.workspace_region,
            role: identity.role,
            timezone: identity.workspace_timezone,
            createdAt: identity.workspace_created_at,
          }
        : null,
      apiBaseUrl: this.env.PUBLIC_API_BASE_URL,
    };
  }
}

export const __authServiceTesting = { identityBootstrapWorkspaceId };
