import { newId, nowIso } from "@rally/db";
import {
  MCP_SCOPE,
  isAllowedMcpRedirectUri,
  type McpAuthorizationApproval,
  type McpAuthorizationDescription,
  type McpAuthorizationRequest,
  type McpClientRegistration,
  type McpClientRegistrationRequest,
  type McpTokenRequest,
  type McpTokenResponse,
} from "@rally/contracts/mcp-oauth";

import type { Env, IdentityAuthContext } from "../env";
import { ApiError } from "../lib/api-error";
import { randomToken, sha256, timingSafeEqualText } from "../lib/crypto";
import { ACCESS_TOKEN_TTL_SECONDS, AuthService, verifyAudiencedAccessToken } from "./auth-service";

/**
 * How long an approved code may wait for its exchange. RFC 6749 §4.1.2:
 * "A maximum authorization code lifetime of 10 minutes is RECOMMENDED."
 * Transcribed 2026-11-09. The client exchanges it within a second of the
 * redirect, so the bound only matters for a code that leaked.
 */
const AUTHORIZATION_CODE_TTL_SECONDS = 10 * 60;

/** An OAuth error response (RFC 6749 §5.2), which MCP clients read instead of Rally's error envelope. */
export class McpOAuthError extends Error {
  constructor(
    readonly error: "invalid_request" | "invalid_client" | "invalid_grant" | "unsupported_grant_type" | "invalid_client_metadata" | "invalid_redirect_uri",
    readonly description: string,
    readonly status: 400 | 401 = 400,
  ) {
    super(description);
    this.name = "McpOAuthError";
  }
}

interface ClientRow { client_id: string; client_name: string; redirect_uris: string }

/**
 * Rally's OAuth 2.1 authorization server for MCP clients. A grant is an
 * ordinary workspace session (`AuthService.createMcpSession`), so everything
 * that ends a session ends a grant; this service registers clients, issues
 * and exchanges codes, and refreshes and revokes only the sessions a client
 * holds. `docs/rally-mcp.md`.
 */
export class McpOAuthService {
  constructor(private readonly env: Env) {}

  async register(input: McpClientRegistrationRequest): Promise<McpClientRegistration> {
    const clientId = newId();
    const createdAt = nowIso();
    const name = input.client_name ?? "MCP client";
    await this.env.DB.prepare("INSERT INTO mcp_oauth_clients(client_id,client_name,redirect_uris,created_at) VALUES (?,?,?,?)")
      .bind(clientId, name, JSON.stringify(input.redirect_uris), createdAt).run();
    return {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.parse(createdAt) / 1_000),
      client_name: name,
      redirect_uris: input.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
  }

  /**
   * The registered client and the redirect it asked for, or a refusal. The
   * consent page shows nothing, and redirects nowhere, until this passes:
   * an unregistered redirect is never followed (RFC 6749 §4.1.2.1).
   */
  async describe(request: McpAuthorizationRequest): Promise<McpAuthorizationDescription> {
    const client = await this.client(request.clientId, request.redirectUri);
    return { clientName: client.client_name, redirectOrigin: new URL(request.redirectUri).origin };
  }

  /** The person approved: a single-use code for the Organization they chose, on the client's redirect. */
  async approve(identity: IdentityAuthContext, approval: McpAuthorizationApproval): Promise<string> {
    await this.client(approval.clientId, approval.redirectUri);
    const workspaces = await new AuthService(this.env).listRegionalWorkspaces(identity.userId);
    if (!workspaces.some((workspace) => workspace.id === approval.workspaceId)) {
      throw new ApiError(403, "mcp_workspace_unavailable", "Choose an Organization you belong to");
    }
    const code = randomToken(32);
    const createdAt = new Date();
    await this.env.DB.prepare(`INSERT INTO mcp_oauth_codes
      (code_hash,client_id,user_id,workspace_id,redirect_uri,code_challenge,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .bind(await sha256(code), approval.clientId, identity.userId, approval.workspaceId, approval.redirectUri,
        approval.codeChallenge, createdAt.toISOString(),
        new Date(createdAt.getTime() + AUTHORIZATION_CODE_TTL_SECONDS * 1_000).toISOString())
      .run();
    return redirectWith(approval.redirectUri, { code, ...(approval.state ? { state: approval.state } : {}) });
  }

  /** The person declined: the client's redirect with `access_denied` (RFC 6749 §4.1.2.1). */
  async deny(request: McpAuthorizationRequest): Promise<string> {
    await this.client(request.clientId, request.redirectUri);
    return redirectWith(request.redirectUri, { error: "access_denied", ...(request.state ? { state: request.state } : {}) });
  }

  async token(request: McpTokenRequest): Promise<McpTokenResponse> {
    if (request.grant_type === "refresh_token") {
      await this.client(request.client_id);
      const session = await new AuthService(this.env).refresh(request.refresh_token, { mcpClientId: request.client_id })
        .catch((error: unknown) => {
          if (error instanceof ApiError && error.status === 401) throw new McpOAuthError("invalid_grant", "The refresh token is invalid or expired");
          throw error;
        });
      return tokenResponse(session.accessToken, session.refreshToken);
    }
    // Consumed in the statement that reads it, so a code replayed or raced
    // reaches nothing the second time.
    const row = await this.env.DB.prepare(`UPDATE mcp_oauth_codes SET consumed_at=?
      WHERE code_hash=? AND consumed_at IS NULL AND expires_at>?
      RETURNING client_id,user_id,workspace_id,redirect_uri,code_challenge`)
      .bind(nowIso(), await sha256(request.code), nowIso())
      .first<{ client_id: string; user_id: string; workspace_id: string; redirect_uri: string; code_challenge: string }>();
    if (!row) throw new McpOAuthError("invalid_grant", "The authorization code is invalid, expired or already used");
    if (row.client_id !== request.client_id || row.redirect_uri !== request.redirect_uri) {
      throw new McpOAuthError("invalid_grant", "The authorization code was issued to another client or redirect");
    }
    if (!timingSafeEqualText(await sha256(request.code_verifier), row.code_challenge)) {
      throw new McpOAuthError("invalid_grant", "The code verifier does not match the code challenge");
    }
    const session = await new AuthService(this.env).createMcpSession(row.user_id, row.workspace_id, row.client_id)
      .catch((error: unknown) => {
        // The person left the Organization between approving and the exchange.
        if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404)) {
          throw new McpOAuthError("invalid_grant", "The Organization is no longer available to this account");
        }
        throw error;
      });
    return tokenResponse(session.accessToken, session.refreshToken);
  }

  /**
   * RFC 7009: end the session behind a refresh or access token this client
   * holds. Anything else, including a token of another client or of the
   * desktop, is ignored and still answered 200, as §2.2 requires.
   */
  async revoke(token: string, clientId: string): Promise<void> {
    const refreshHash = await sha256(token);
    const byRefresh = await this.env.DB.prepare(`SELECT s.id FROM sessions s JOIN mcp_oauth_grants g ON g.session_id=s.id
      WHERE g.client_id=? AND (s.refresh_token_hash=? OR s.previous_refresh_token_hash=?)`)
      .bind(clientId, refreshHash, refreshHash).first<{ id: string }>();
    let sessionId = byRefresh?.id;
    if (!sessionId) {
      const access = await verifyAudiencedAccessToken(this.env, token, ["mcp"]).catch(() => null);
      if (access) {
        const grant = await this.env.DB.prepare("SELECT session_id FROM mcp_oauth_grants WHERE session_id=? AND client_id=?")
          .bind(access.claims.sessionId, clientId).first<{ session_id: string }>();
        sessionId = grant?.session_id;
      }
    }
    if (sessionId) await new AuthService(this.env).logout({ sessionId });
  }

  /** A registered client, and when given, a redirect it registered. */
  private async client(clientId: string, redirectUri?: string): Promise<ClientRow> {
    const row = await this.env.DB.prepare("SELECT client_id,client_name,redirect_uris FROM mcp_oauth_clients WHERE client_id=?")
      .bind(clientId).first<ClientRow>();
    if (!row) throw new McpOAuthError("invalid_client", "This MCP client is not registered with Rally", 401);
    if (redirectUri !== undefined) {
      const registered = JSON.parse(row.redirect_uris) as string[];
      if (!registered.includes(redirectUri) || !isAllowedMcpRedirectUri(redirectUri)) {
        throw new McpOAuthError("invalid_redirect_uri", "This redirect was not registered by the MCP client");
      }
    }
    return row;
  }
}

function redirectWith(redirectUri: string, parameters: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url.toString();
}

function tokenResponse(accessToken: string, refreshToken: string): McpTokenResponse {
  return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken, scope: MCP_SCOPE };
}
