import {
  ConnectorError,
  GoogleCapabilityScopes,
  GranolaCapabilities,
  LinearCapabilityScopes,
  SlackCapabilityScopes,
  SlackWorkspaceCapabilities,
  assertGitHubCapabilitiesGranted,
  connectorCapabilitySupportsScope,
  createGranolaWebhookEndpoint,
  createWebhookSecret,
  deleteGranolaWebhookEndpoint,
  discoverGitHubConnectionRepositories,
  getGitHubInstallation,
  type AuthorizedConnectorConnection,
  type ConnectorConnectionContext,
  type GitHubWebhookResourceDiscovery,
  type GitHubWebhookResourceHint,
  type ResolvedConnectorAdapter,
  type VerifiedGranolaWebhook,
} from "@avalon/connectors";
import type {
  Connection,
  ConnectorOAuthAttempt,
  ConnectorOAuthProvider,
  ConnectorOAuthStart,
  CreateWebhookConnectionRequestSchema,
  Scope,
} from "@avalon/contracts";
import { newId, nowIso } from "@avalon/db";
import type { z } from "zod";
import type { AuthContext, Env } from "../env";
import { linearNativeAgentEnabled, numericEnv } from "../env";
import { ApiError } from "../lib/api-error";
import { connectionFromRow } from "../mappers/connection";
import { connectorRegistryForEnv, githubConnectorConfig, xConnectorConfig } from "../lib/connector-registry";
import { encryptString, openString, randomToken, sealString, sha256 } from "../lib/crypto";
import { connectorAttemptTarget, normalizeConnectorOAuthErrorCode } from "../lib/desktop-handoff";
import { durableObjectNamespaceForRegion } from "../lib/durable-object-namespace";
import { createGitHubInstallState } from "../lib/github-install-state";
import { createRegionRoutedState } from "../lib/region-routed-state";
import { withAuthorizedConnection } from "./connector-connection-access";
import { decryptVersionedConnectorCredentials } from "./connector-credential-envelope";
import { logWarn } from "../observability/logger";
import { GitHubRoutingService } from "./github-routing-service";
import { LinearRoutingService } from "./linear-routing-service";
import { NotionRoutingService } from "./notion-routing-service";
import { SlackAgentService } from "./slack-agent-service";
import { SlackRoutingService } from "./slack-routing-service";
import { resolveUserDelivery } from "./user-delivery";

type CreateWebhookInput = z.infer<typeof CreateWebhookConnectionRequestSchema>;

const capabilityScopes: Record<string, readonly string[]> = {
  "gmail.read": GoogleCapabilityScopes.gmailRead,
  "gmail.draft": GoogleCapabilityScopes.gmailDraft,
  "gmail.send": GoogleCapabilityScopes.gmailSend,
  "calendar.read": GoogleCapabilityScopes.calendarRead,
  "calendar.write": GoogleCapabilityScopes.calendarWrite,
  "drive.read": GoogleCapabilityScopes.driveRead,
  "docs.read": GoogleCapabilityScopes.docsRead,
  "docs.write": GoogleCapabilityScopes.docsWrite,
  "sheets.read": GoogleCapabilityScopes.sheetsRead,
  "sheets.write": GoogleCapabilityScopes.sheetsWrite,
};

const googleBroaderProviderScopeAliases: Readonly<Record<string, readonly string[]>> = {
  "https://www.googleapis.com/auth/gmail.modify": ["https://mail.google.com/"],
  "https://www.googleapis.com/auth/calendar.readonly": ["https://www.googleapis.com/auth/calendar"],
  "https://www.googleapis.com/auth/calendar.events": ["https://www.googleapis.com/auth/calendar"],
  "https://www.googleapis.com/auth/drive.readonly": ["https://www.googleapis.com/auth/drive"],
  "https://www.googleapis.com/auth/drive.file": ["https://www.googleapis.com/auth/drive"],
};

interface StoredConnection extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  connector_type: string;
  scope: Scope;
  owner_user_id: string | null;
  model_plugin_id: string;
  encrypted_credentials?: string | null;
  credential_iv?: string | null;
  credential_key_version?: number;
}

type OAuthConnectorProvider = Exclude<ConnectorOAuthProvider, "google" | "github">;

interface ConnectorOAuthAttemptRow {
  id: string;
  provider: ConnectorOAuthProvider;
  status: "pending" | "succeeded" | "denied" | "failed";
  connection_id: string | null;
  error_code: string | null;
  expires_at: string;
}

export interface GitHubSetupResult {
  url: string;
  workspaceId: string;
}

const providerCapabilityScopes: Record<OAuthConnectorProvider, Record<string, readonly string[]>> = {
  granola: {
    [GranolaCapabilities.personalRead]: ["mcp", "offline_access"],
    [GranolaCapabilities.workspaceRead]: [],
  },
  linear: LinearCapabilityScopes,
  notion: {
    "notion.read": ["notion.read"],
    "notion.insert": ["notion.insert"],
    "notion.update": ["notion.update"],
    "notion.comment.read": ["notion.comment.read"],
    "notion.comment.insert": ["notion.comment.insert"],
  },
  slack: SlackCapabilityScopes,
};

/**
 * Runs an adapter's repair before its health check, and reports what happened.
 *
 * A repair never fails the test: the health check is the answer being asked
 * for, and a connection that could not be repaired still has a state worth
 * reporting. But the outcome is returned rather than only logged — a connection
 * whose delivery is still broken must not read the same as one just fixed.
 */
async function attemptConnectorRepair(
  env: Env,
  adapter: { repair?: ResolvedConnectorAdapter["repair"] },
  connection: AuthorizedConnectorConnection,
  identity: { connectionId: string; connectorType: string },
): Promise<string | null> {
  if (!adapter.repair) return null;
  try {
    const repair = await adapter.repair(connection, AbortSignal.timeout(10_000));
    return repair.repaired ? repair.message ?? "Repaired the connection" : null;
  } catch (error) {
    logWarn(env, "connector_repair_failed", {
      connection_id: identity.connectionId,
      connector_type: identity.connectorType,
      reason: error instanceof Error ? error.message : String(error),
    });
    return error instanceof Error
      ? `A repair was attempted and failed: ${error.message}`
      : "A repair was attempted and failed";
  }
}

export class ConnectionService {
  constructor(private readonly env: Env, private readonly auth?: AuthContext) {}

  availableConnectorTypes(): string[] {
    this.requireAuth();
    return this.registry().list().map((manifest) => manifest.type).sort();
  }

  async list(): Promise<Connection[]> {
    const auth = this.requireAuth();
    const result = await this.env.DB.prepare(
      `SELECT c.*, u.name AS owner_name FROM connector_connections c
       LEFT JOIN users u ON u.id = c.owner_user_id
       WHERE c.workspace_id = ? AND (c.scope = 'workspace' OR c.owner_user_id = ?)
       ORDER BY c.display_name COLLATE NOCASE`,
    ).bind(auth.workspaceId, auth.userId).all<Record<string, unknown>>();
    const rows = result.results ?? [];
    const userDelivery = await resolveUserDelivery(
      this.env,
      { workspaceId: auth.workspaceId, userId: auth.userId },
      rows.map((row) => ({ id: String(row.id), connector_type: row.connector_type, status: row.status })),
    );
    return rows.map((row) => connectionFromRow(row, userDelivery.get(String(row.id)) ?? null));
  }

  async beginGoogle(input: {
    scope: Scope;
    capabilities: string[];
    connectionId?: string;
  }): Promise<ConnectorOAuthStart> {
    const auth = this.requireAuth();
    this.assertScopeAllowed(input.scope);
    const capabilities = [...new Set(input.capabilities)];
    if (capabilities.length === 0 || capabilities.some((capability) => !capabilityScopes[capability])) {
      throw new ApiError(422, "invalid_google_capabilities", "Choose at least one supported Google capability");
    }
    const verifier = randomToken(64);
    const challenge = await sha256(verifier);
    const state = randomToken(32);
    const attemptId = randomToken(32);
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const statePayload = await sealString(JSON.stringify({
      provider: "google",
      attemptId,
      verifier,
      scope: input.scope,
      capabilities,
      connectionId: input.connectionId ?? null,
    }), this.env.OAUTH_STATE_ENCRYPTION_KEY);
    await this.persistOAuthStart({
      attemptId,
      provider: "google",
      state,
      statePayload,
      auth,
      expiresAt,
    });
    const adapter = this.registry().get("google");
    const authorization = await adapter.beginAuthorization?.({
      state,
      codeChallenge: challenge,
      scopes: [
        ...new Set([
          ...GoogleCapabilityScopes.identity,
          ...googleProviderScopesForCapabilities(capabilities),
        ]),
      ],
    });
    if (!authorization) throw new ApiError(503, "google_oauth_unavailable", "Google authorization is unavailable");
    return { url: authorization.url, attemptId };
  }

  async completeGoogle(code: string, state: string): Promise<string> {
    const row = await this.consumeProviderState("google", state, "connector");
    const stateData = JSON.parse(
      await openString(String(row.code_verifier_encrypted), this.env.OAUTH_STATE_ENCRYPTION_KEY),
    ) as { provider?: "google"; attemptId?: unknown; verifier: string; scope: Scope; capabilities: string[]; connectionId: string | null };
    await this.assertOAuthStatePrincipalAllowed(row, stateData.scope);
    const attemptId = oauthAttemptIdValue(stateData.attemptId);
    const adapter = this.registry().get("google");
    const incomingCredentials = await adapter.handleAuthorizationCallback?.({ code, codeVerifier: stateData.verifier });
    if (!incomingCredentials) throw new ApiError(502, "google_token_exchange_failed", "Google did not return connector credentials");
    assertGoogleCapabilitiesGranted(stateData.capabilities, incomingCredentials);
    const at = nowIso();
    const connectionId = stateData.connectionId ?? newId();
    let existing: StoredConnection | null = null;
    let existingCredentials: Record<string, unknown> = {};
    if (stateData.connectionId) {
      existing = await this.env.DB.prepare(
        `SELECT * FROM connector_connections
         WHERE id = ? AND workspace_id = ? AND connector_type = 'google'`,
      ).bind(connectionId, row.workspace_id).first<StoredConnection>();
      if (!existing) throw new ApiError(404, "connection_not_found", "Google connection not found");
      if (
        existing.scope !== stateData.scope ||
        (existing.scope === "personal" && existing.owner_user_id !== row.user_id)
      ) {
        throw new ApiError(401, "invalid_oauth_state", "Google reconnect scope no longer matches the connection");
      }
      existingCredentials = (await this.context(existing)).credentials;
    }
    const account = reconcileGoogleAccount(existing, existingCredentials, incomingCredentials);
    const displayName = googleConnectionDisplayName(stateData.capabilities, account.displayName);
    const encrypted = await encryptString(
      JSON.stringify(account.credentials),
      this.env.CONNECTOR_CREDENTIALS_KEY,
      connectionId,
    );
    const modelPluginId = await this.allocateModelPluginId(
      String(row.workspace_id),
      "google",
      stateData.connectionId ? connectionId : null,
    );
    const identityConfig = JSON.stringify(verifiedIdentityConfig(
      "google",
      account.credentials,
      account.providerAccountId,
    ));
    if (stateData.connectionId) {
      const updated = await this.persistConnectionMutation(this.env.DB.prepare(
        `UPDATE connector_connections SET encrypted_credentials = ?, credential_iv = ?,
         credential_key_version = ?, granted_scopes_json = ?, provider_account_id = ?, display_name = ?,
         model_plugin_id = ?, status = 'healthy', error_json = NULL, config_json = ?,
         next_poll_at = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND connector_type = 'google'`,
      ).bind(
        encrypted.ciphertext,
        encrypted.iv,
        Number(this.env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1),
        JSON.stringify(stateData.capabilities),
        account.providerAccountId,
        displayName,
        modelPluginId,
        identityConfig,
        at,
        at,
        connectionId,
        row.workspace_id,
      ), attemptId, connectionId);
      if (Number(updated.meta.changes ?? 0) === 0) {
        throw new ApiError(404, "connection_not_found", "Google connection not found");
      }
    } else {
      await this.persistConnectionMutation(this.env.DB.prepare(
        `INSERT INTO connector_connections
         (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
          encrypted_credentials, credential_iv, credential_key_version, granted_scopes_json,
          model_plugin_id, status, cursor_json, config_json, next_poll_at, created_at, updated_at)
         VALUES (?, ?, 'google', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'healthy', '{}', ?, ?, ?, ?)`,
      ).bind(
        connectionId,
        row.workspace_id,
        stateData.scope,
        stateData.scope === "personal" ? row.user_id : null,
        account.providerAccountId,
        displayName,
        encrypted.ciphertext,
        encrypted.iv,
        Number(this.env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1),
        JSON.stringify(stateData.capabilities),
        modelPluginId,
        identityConfig,
        at,
        at,
        at,
      ), attemptId, connectionId);
      await this.createPollSchedule(String(row.workspace_id), connectionId, 300);
    }
    await this.refreshScheduler(String(row.workspace_id));
    await this.recordConnectionAudit(
      String(row.workspace_id),
      String(row.user_id),
      stateData.connectionId ? "connector.reauthorized" : "connector.authorized",
      connectionId,
      { provider: "google", scope: stateData.scope, capabilities: stateData.capabilities, providerAccountId: account.providerAccountId },
    );
    const redirect = new URL(String(row.return_uri));
    redirect.searchParams.set("connection", connectionId);
    redirect.searchParams.set("status", "connected");
    redirect.searchParams.set("region", this.env.AVALON_REGION);
    if (attemptId) redirect.searchParams.set("attempt", attemptId);
    redirect.searchParams.set("provider", "google");
    if (attemptId) await this.finishOAuthAttempt(attemptId, "succeeded", { connectionId });
    return redirect.toString();
  }

  async beginProvider(
    provider: OAuthConnectorProvider,
    input: { scope: Scope; capabilities: string[]; connectionId?: string },
  ): Promise<ConnectorOAuthStart> {
    const auth = this.requireAuth();
    this.assertScopeAllowed(input.scope);
    const adapter = this.registry().get(provider);
    if (!adapter.manifest.supportedScopes.includes(input.scope)) {
      throw new ApiError(422, "invalid_connector_scope", `${adapter.manifest.displayName} does not support ${input.scope} connections`);
    }
    const supported = new Set(adapter.manifest.capabilities.map((capability) => capability.id));
    const capabilities = provider === "slack" && input.scope === "workspace"
      ? [...SlackWorkspaceCapabilities]
      : [...new Set(input.capabilities)];
    if (
      !capabilities.length
      || capabilities.some((capability) =>
        !supported.has(capability)
        || !connectorCapabilitySupportsScope(adapter, capability, input.scope))
    ) {
      throw new ApiError(422, "invalid_connector_capabilities", `Choose supported ${adapter.manifest.displayName} capabilities`);
    }
    if (provider === "linear") {
      assertLinearScopeCapabilities(input.scope, capabilities);
      assertLinearNativeAgentCapabilityEnabled(
        capabilities,
        this.env,
        adapter.manifest.nativeAgent?.runtimeStatus,
      );
    }
    const verifier = randomToken(64);
    const challenge = await sha256(verifier);
    // Notion accepts one redirect URI for the whole public connection, so its
    // callback lands on the shared Global ingress whichever region started it,
    // and the region prefix is the only thing that ingress can route on. Every
    // other connector answers on its own regional host and needs no prefix.
    const state = provider === "notion"
      ? createRegionRoutedState(this.env.AVALON_REGION, randomToken(32))
      : randomToken(32);
    const attemptId = randomToken(32);
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const authorization = await adapter.beginAuthorization?.({
      state,
      codeChallenge: challenge,
      connectionScope: input.scope,
      scopes: capabilities.flatMap((capability) => providerCapabilityScopes[provider][capability] ?? []),
    });
    if (!authorization) throw new ApiError(503, "connector_oauth_unavailable", `${adapter.manifest.displayName} authorization is unavailable`);
    const statePayload = await sealString(JSON.stringify({
      provider,
      attemptId,
      verifier,
      scope: input.scope,
      capabilities,
      connectionId: input.connectionId ?? null,
      authorizationState: authorization.state ?? null,
    }), this.env.OAUTH_STATE_ENCRYPTION_KEY);
    await this.persistOAuthStart({
      attemptId,
      provider,
      state,
      statePayload,
      auth,
      expiresAt,
    });
    return { url: authorization.url, attemptId };
  }

  async beginGitHub(input: {
    scope: Scope;
    capabilities: string[];
    connectionId?: string;
  }): Promise<ConnectorOAuthStart> {
    const auth = this.requireAuth();
    this.assertScopeAllowed(input.scope);
    const adapter = this.registry().get("github");
    const supported = new Set(adapter.manifest.tools.map((tool) => tool.capability));
    const capabilities = [...new Set(input.capabilities)];
    if (!capabilities.length || capabilities.some((capability) => !supported.has(capability))) {
      throw new ApiError(422, "invalid_connector_capabilities", "Choose supported GitHub capabilities");
    }
    if (!this.env.GITHUB_APP_SLUG || !githubConnectorConfig(this.env)) {
      throw new ApiError(503, "github_app_unavailable", "The Avalon GitHub App is not configured");
    }
    // The public App has one setup URL. Keep the unpredictable value in this
    // regional D1 row and expose only the region as a routing prefix.
    const state = createGitHubInstallState(this.env.AVALON_REGION, randomToken(32));
    const attemptId = randomToken(32);
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const statePayload = await sealString(JSON.stringify({
      provider: "github",
      attemptId,
      scope: input.scope,
      capabilities,
      connectionId: input.connectionId ?? null,
    }), this.env.OAUTH_STATE_ENCRYPTION_KEY);
    await this.persistOAuthStart({
      attemptId,
      provider: "github",
      purpose: "github_install",
      state,
      statePayload,
      auth,
      expiresAt,
    });
    const url = new URL(`https://github.com/apps/${encodeURIComponent(this.env.GITHUB_APP_SLUG)}/installations/new`);
    url.searchParams.set("state", state);
    return { url: url.toString(), attemptId };
  }

  async setupGitHub(installationId: string, state: string): Promise<GitHubSetupResult> {
    const installState = await this.consumeProviderState("github", state, "github_install");
    const stateData = JSON.parse(
      await openString(String(installState.code_verifier_encrypted), this.env.OAUTH_STATE_ENCRYPTION_KEY),
    ) as { provider: "github"; attemptId?: unknown; scope: Scope; capabilities: string[]; connectionId: string | null };
    const attemptId = oauthAttemptIdValue(stateData.attemptId);
    const oauthExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    if (attemptId) await this.extendOAuthAttempt(attemptId, oauthExpiresAt);
    const config = githubConnectorConfig(this.env);
    if (!config) throw new ApiError(503, "github_app_unavailable", "The Avalon GitHub App is not configured");
    const installation = await getGitHubInstallation(config, installationId, AbortSignal.timeout(15_000));
    if (String(installation.id ?? "") !== installationId) {
      throw new ApiError(401, "github_installation_mismatch", "GitHub returned a different App installation");
    }
    const verifier = randomToken(64);
    const challenge = await sha256(verifier);
    const oauthState = randomToken(32);
    const oauthPayload = await sealString(JSON.stringify({
      ...stateData,
      verifier,
      installationId,
    }), this.env.OAUTH_STATE_ENCRYPTION_KEY);
    await this.env.DB.prepare(
      `INSERT INTO oauth_states
       (id, region, provider, purpose, code_verifier_encrypted, user_id, workspace_id, return_uri, expires_at)
       VALUES (?, ?, 'github', 'connector', ?, ?, ?, ?, ?)`,
    ).bind(
      oauthState,
      this.env.AVALON_REGION,
      oauthPayload,
      installState.user_id,
      installState.workspace_id,
      installState.return_uri,
      oauthExpiresAt,
    ).run();
    const authorization = await this.registry().get("github").beginAuthorization?.({
      state: oauthState,
      codeChallenge: challenge,
      scopes: [],
      installationId,
      connectionScope: stateData.scope,
    });
    if (!authorization) throw new ApiError(503, "github_oauth_unavailable", "GitHub authorization is unavailable");
    return {
      url: authorization.url,
      workspaceId: String(installState.workspace_id),
    };
  }

  async completeGitHub(code: string, state: string): Promise<string> {
    const row = await this.consumeProviderState("github", state, "connector");
    const stateData = JSON.parse(
      await openString(String(row.code_verifier_encrypted), this.env.OAUTH_STATE_ENCRYPTION_KEY),
    ) as { provider: "github"; attemptId?: unknown; verifier: string; installationId: string; scope: Scope; capabilities: string[]; connectionId: string | null };
    await this.assertOAuthStatePrincipalAllowed(row, stateData.scope);
    const attemptId = oauthAttemptIdValue(stateData.attemptId);
    const adapter = this.registry().get("github");
    const incomingCredentials = await adapter.handleAuthorizationCallback?.({
      code,
      codeVerifier: stateData.verifier,
      installationId: stateData.installationId,
      connectionScope: stateData.scope,
    });
    if (!incomingCredentials) throw new ApiError(502, "github_token_exchange_failed", "GitHub did not return connector credentials");
    assertGitHubCapabilitiesGranted(stateData.capabilities, incomingCredentials);
    const providerAccountId = stringField(incomingCredentials, "providerAccountId");
    if (!providerAccountId || providerAccountId !== stateData.installationId) {
      throw new ApiError(502, "github_installation_mismatch", "GitHub did not authorize the expected App installation");
    }
    const connectionId = stateData.connectionId ?? newId();
    let existing: StoredConnection | null = null;
    let existingCredentials: Record<string, unknown> = {};
    if (stateData.connectionId) {
      existing = await this.env.DB.prepare(
        `SELECT * FROM connector_connections WHERE id = ? AND workspace_id = ? AND connector_type = 'github'`,
      ).bind(connectionId, row.workspace_id).first<StoredConnection>();
      if (!existing) throw new ApiError(404, "connection_not_found", "GitHub connection not found");
      if (existing.scope !== stateData.scope || (existing.scope === "personal" && existing.owner_user_id !== row.user_id)) {
        throw new ApiError(401, "invalid_oauth_state", "The reconnect scope no longer matches the GitHub connection");
      }
      if (existing.provider_account_id != null && String(existing.provider_account_id) !== providerAccountId) {
        throw new ApiError(409, "connector_account_mismatch", "Reconnect the same GitHub App installation");
      }
      existingCredentials = (await this.context(existing)).credentials;
    }
    const credentials: Record<string, unknown> = {
      ...existingCredentials,
      ...incomingCredentials,
      installationId: providerAccountId,
    };
    const githubUserId = stateData.scope === "personal"
      ? stringField(credentials, "githubUserId")
      : null;
    if (stateData.scope === "personal" && !githubUserId) {
      throw new ApiError(502, "connector_identity_missing", "GitHub did not return the authorized user identity");
    }
    const connectorConfig = githubConnectorConfig(this.env);
    if (!connectorConfig) throw new ApiError(503, "github_app_unavailable", "The regional GitHub App is not configured");
    let repositoryBootstrap: GitHubWebhookResourceDiscovery = {
      resources: [],
      truncated: false,
    };
    let repositoryBootstrapStatus: "complete" | "deferred" = "complete";
    try {
      repositoryBootstrap = await discoverGitHubConnectionRepositories(
        connectorConfig,
        {
          id: connectionId,
          workspaceId: String(row.workspace_id),
          scope: stateData.scope,
          ownerUserId: stateData.scope === "personal" ? String(row.user_id) : null,
          grantedScopes: stateData.capabilities,
          credentials,
          cursor: {},
          config: {
            region: this.env.AVALON_REGION,
            installationId: providerAccountId,
          },
        },
        AbortSignal.timeout(15_000),
      );
    } catch {
      // Authorization already proved the connection. A transient repository
      // listing failure must not consume OAuth state while leaving users
      // disconnected; later webhooks will populate the same catalog.
      repositoryBootstrapStatus = "deferred";
    }
    const encrypted = await encryptString(JSON.stringify(credentials), this.env.CONNECTOR_CREDENTIALS_KEY, connectionId);
    const at = nowIso();
    const providerAccountName = stringField(credentials, "providerAccountName") ?? `installation ${providerAccountId}`;
    const displayName = `GitHub · ${providerAccountName}`.slice(0, 180);
    const modelPluginId = await this.allocateModelPluginId(
      String(row.workspace_id),
      "github",
      existing ? connectionId : null,
    );
    const config = JSON.stringify({
      region: this.env.AVALON_REGION,
      installationId: providerAccountId,
      githubUserId,
      githubLogin: stateData.scope === "personal" ? stringField(credentials, "githubLogin") : null,
      githubName: stateData.scope === "personal" ? stringField(credentials, "githubName") : null,
      githubEmail: stateData.scope === "personal" ? stringField(credentials, "githubEmail") : null,
      ...verifiedIdentityConfig("github", credentials, providerAccountId),
      repositorySelection: credentials["repositorySelection"] ?? null,
      repositoryBootstrap: {
        status: repositoryBootstrapStatus,
        count: repositoryBootstrap.resources.length,
        truncated: repositoryBootstrap.truncated,
        completedAt: at,
      },
      account: credentials["account"] ?? {},
    });
    if (existing) {
      await this.persistConnectionMutation(this.env.DB.prepare(
        `UPDATE connector_connections SET encrypted_credentials = ?, credential_iv = ?, credential_key_version = ?,
         granted_scopes_json = ?, provider_account_id = ?, display_name = ?, model_plugin_id = ?, status = 'healthy', error_json = NULL,
         config_json = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND connector_type = 'github'`,
      ).bind(
        encrypted.ciphertext,
        encrypted.iv,
        Number(this.env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1),
        JSON.stringify(stateData.capabilities),
        providerAccountId,
        displayName,
        modelPluginId,
        config,
        at,
        connectionId,
        row.workspace_id,
      ), attemptId, connectionId);
    } else {
      await this.persistConnectionMutation(this.env.DB.prepare(
        `INSERT INTO connector_connections
         (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
          encrypted_credentials, credential_iv, credential_key_version, granted_scopes_json,
          model_plugin_id, status, cursor_json, config_json, created_at, updated_at)
         VALUES (?, ?, 'github', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'healthy', '{}', ?, ?, ?)`,
      ).bind(
        connectionId,
        row.workspace_id,
        stateData.scope,
        stateData.scope === "personal" ? row.user_id : null,
        providerAccountId,
        displayName,
        encrypted.ciphertext,
        encrypted.iv,
        Number(this.env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1),
        JSON.stringify(stateData.capabilities),
        modelPluginId,
        config,
        at,
        at,
      ), attemptId, connectionId);
    }
    await this.upsertGitHubRepositoryResources(
      String(row.workspace_id),
      connectionId,
      repositoryBootstrap.resources,
      at,
    );
    await this.recordConnectionAudit(
      String(row.workspace_id),
      String(row.user_id),
      existing ? "connector.reauthorized" : "connector.authorized",
      connectionId,
      { provider: "github", scope: stateData.scope, capabilities: stateData.capabilities, installationId: providerAccountId },
    );
    const redirect = new URL(String(row.return_uri));
    redirect.searchParams.set("connection", connectionId);
    redirect.searchParams.set("status", "connected");
    redirect.searchParams.set("region", this.env.AVALON_REGION);
    if (attemptId) redirect.searchParams.set("attempt", attemptId);
    redirect.searchParams.set("provider", "github");
    if (attemptId) await this.finishOAuthAttempt(attemptId, "succeeded", { connectionId });
    return redirect.toString();
  }

  async completeProvider(provider: OAuthConnectorProvider, code: string, state: string): Promise<string> {
    const row = await this.consumeProviderState(provider, state, "connector");
    const stateData = JSON.parse(
      await openString(String(row.code_verifier_encrypted), this.env.OAUTH_STATE_ENCRYPTION_KEY),
    ) as { provider: OAuthConnectorProvider; attemptId?: unknown; verifier: string; scope: Scope; capabilities: string[]; connectionId: string | null; authorizationState?: unknown };
    const attemptId = oauthAttemptIdValue(stateData.attemptId);
    if (stateData.provider !== provider) throw new ApiError(401, "invalid_oauth_state", "The connector provider does not match this authorization");
    await this.assertOAuthStatePrincipalAllowed(row, stateData.scope);
    const adapter = this.registry().get(provider);
    if (provider === "linear") {
      assertLinearScopeCapabilities(stateData.scope, stateData.capabilities);
      assertLinearNativeAgentCapabilityEnabled(
        stateData.capabilities,
        this.env,
        adapter.manifest.nativeAgent?.runtimeStatus,
      );
    }
    const incomingCredentials = await adapter.handleAuthorizationCallback?.({
      code,
      codeVerifier: stateData.verifier,
      connectionScope: stateData.scope,
      authorizationState: stateData.authorizationState,
    });
    if (!incomingCredentials) throw new ApiError(502, "connector_token_exchange_failed", `${adapter.manifest.displayName} did not return connector credentials`);
    if (provider === "linear") {
      assertLinearCapabilitiesGranted(stateData.capabilities, incomingCredentials);
    }
    const providerAccountId = stringField(incomingCredentials, "providerAccountId");
    if (!providerAccountId) throw new ApiError(502, "connector_identity_missing", `${adapter.manifest.displayName} did not return a stable account identity`);
    let connectionId = stateData.connectionId ?? newId();
    let existing: StoredConnection | null = null;
    let existingCredentials: Record<string, unknown> = {};
    if (stateData.connectionId) {
      existing = await this.env.DB.prepare(
        `SELECT * FROM connector_connections WHERE id = ? AND workspace_id = ? AND connector_type = ?`,
      ).bind(connectionId, row.workspace_id, provider).first<StoredConnection>();
      if (!existing) throw new ApiError(404, "connection_not_found", `${adapter.manifest.displayName} connection not found`);
      if (existing.scope !== stateData.scope || (existing.scope === "personal" && existing.owner_user_id !== row.user_id)) {
        throw new ApiError(401, "invalid_oauth_state", "The reconnect scope no longer matches the connection");
      }
      if (existing.provider_account_id != null && String(existing.provider_account_id) !== providerAccountId) {
        throw new ApiError(409, "connector_account_mismatch", `Reconnect the same ${adapter.manifest.displayName} account`);
      }
      existingCredentials = (await this.context(existing)).credentials;
    } else if (provider === "linear") {
      // Starting "Connect" twice for the same Linear identity should repair the
      // existing authorization rather than create two competing webhook/tool
      // identities for one person or workspace.
      existing = await this.env.DB.prepare(
        `SELECT * FROM connector_connections
         WHERE workspace_id = ? AND connector_type = 'linear' AND scope = ?
           AND provider_account_id = ? AND status <> 'disabled'
           AND ((scope = 'personal' AND owner_user_id = ?)
             OR (scope = 'workspace' AND owner_user_id IS NULL))
         ORDER BY created_at LIMIT 1`,
      ).bind(
        row.workspace_id,
        stateData.scope,
        providerAccountId,
        row.user_id,
      ).first<StoredConnection>();
      if (existing) {
        connectionId = existing.id;
        existingCredentials = (await this.context(existing)).credentials;
      }
    } else if (provider === "slack") {
      existing = await this.env.DB.prepare(
        `SELECT * FROM connector_connections
         WHERE connector_type = 'slack' AND scope = ? AND provider_account_id = ? AND status <> 'disabled'
           AND ((scope = 'personal' AND workspace_id = ? AND owner_user_id = ?)
             OR (scope = 'workspace'))
         ORDER BY created_at LIMIT 1`,
      ).bind(stateData.scope, providerAccountId, row.workspace_id, row.user_id).first<StoredConnection>();
      if (existing) {
        if (existing.workspace_id !== row.workspace_id) {
          throw new ApiError(409, "slack_workspace_already_connected", "This Slack workspace is already connected to another Avalon workspace");
        }
        connectionId = existing.id;
        existingCredentials = (await this.context(existing)).credentials;
      }
    }
    if (provider === "linear" && stateData.scope === "personal") {
      assertSameLinearPersonalIdentity(existingCredentials, incomingCredentials);
    } else if (provider === "linear") {
      assertSameLinearWorkspaceIdentity(existingCredentials, incomingCredentials);
    }
    const grantedCapabilities = provider === "slack" && stateData.scope === "workspace"
      ? [...SlackWorkspaceCapabilities]
      : provider === "slack" && existing
        ? [...new Set([
            ...parseJson<string[]>(existing.granted_scopes_json, []),
            ...stateData.capabilities,
          ])]
        : stateData.capabilities;
    const credentials = { ...existingCredentials, ...incomingCredentials, providerAccountId };
    const encrypted = await encryptString(JSON.stringify(credentials), this.env.CONNECTOR_CREDENTIALS_KEY, connectionId);
    const at = nowIso();
    const label = stringField(credentials, "connectionDisplayName")
      ?? stringField(credentials, "providerAccountName")
      ?? stringField(credentials, "workspaceName")
      ?? providerAccountId;
    const displayName = `${adapter.manifest.displayName} · ${label}`.slice(0, 180);
    const modelPluginId = await this.allocateModelPluginId(
      String(row.workspace_id),
      provider,
      existing ? connectionId : null,
    );
    if (existing) {
      await this.persistConnectionMutation(this.env.DB.prepare(
        `UPDATE connector_connections SET encrypted_credentials = ?, credential_iv = ?, credential_key_version = ?,
         granted_scopes_json = ?, provider_account_id = ?, display_name = ?, model_plugin_id = ?, status = 'healthy', error_json = NULL,
         config_json = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND connector_type = ?`,
      ).bind(
        encrypted.ciphertext,
        encrypted.iv,
        Number(this.env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1),
        JSON.stringify(grantedCapabilities),
        providerAccountId,
        displayName,
        modelPluginId,
        JSON.stringify({
          region: this.env.AVALON_REGION,
          ...verifiedIdentityConfig(provider, credentials, providerAccountId),
        }),
        at,
        connectionId,
        row.workspace_id,
        provider,
      ), attemptId, connectionId);
    } else {
      try {
        await this.persistConnectionMutation(this.env.DB.prepare(
          `INSERT INTO connector_connections
           (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
            encrypted_credentials, credential_iv, credential_key_version, granted_scopes_json,
            model_plugin_id, status, cursor_json, config_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'healthy', '{}', ?, ?, ?)`,
        ).bind(
          connectionId,
          row.workspace_id,
          provider,
          stateData.scope,
          stateData.scope === "personal" ? row.user_id : null,
          providerAccountId,
          displayName,
          encrypted.ciphertext,
          encrypted.iv,
          Number(this.env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1),
          JSON.stringify(grantedCapabilities),
          modelPluginId,
          JSON.stringify({
            region: this.env.AVALON_REGION,
            ...verifiedIdentityConfig(provider, credentials, providerAccountId),
          }),
          at,
          at,
        ), attemptId, connectionId);
      } catch (error) {
        if (provider === "linear" && isUniqueConstraintError(error)) {
          throw new ApiError(
            409,
            "linear_connection_exists",
            `This ${stateData.scope} Linear identity is already connected`,
          );
        }
        throw error;
      }
    }
    if (provider === "linear") {
      try {
        await new LinearRoutingService(this.env).registerConnection({
          organizationId: providerAccountId,
          region: this.env.AVALON_REGION,
          workspaceId: String(row.workspace_id),
          connectionId,
        });
      } catch (error) {
        await this.env.DB.prepare(
          `UPDATE connector_connections SET status = 'error', error_json = ?, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND connector_type = 'linear'`,
        ).bind(
          JSON.stringify({
            code: "linear_route_registration_failed",
            message: "The shared Linear webhook route could not be registered",
            retryable: true,
          }),
          nowIso(),
          connectionId,
          row.workspace_id,
        ).run();
        throw error;
      }
    }
    if (provider === "notion") {
      // Routed on the Notion workspace rather than on `providerAccountId`: that
      // is the installed bot, and a delivery names the workspace it happened in.
      try {
        const notionWorkspaceId = stringField(credentials, "notionWorkspaceId");
        if (!notionWorkspaceId) {
          throw new ApiError(502, "connector_identity_missing", "Notion did not return a workspace identity");
        }
        await new NotionRoutingService(this.env).registerConnection({
          notionWorkspaceId,
          region: this.env.AVALON_REGION,
          workspaceId: String(row.workspace_id),
          connectionId,
        });
      } catch (error) {
        await this.env.DB.prepare(
          `UPDATE connector_connections SET status = 'error', error_json = ?, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND connector_type = 'notion'`,
        ).bind(
          JSON.stringify({
            code: "notion_route_registration_failed",
            message: "The shared Notion webhook route could not be registered",
            retryable: true,
          }),
          nowIso(),
          connectionId,
          row.workspace_id,
        ).run();
        throw error;
      }
    }
    if (provider === "slack" && stateData.scope === "workspace") {
      try {
        await new SlackRoutingService(this.env).registerConnection({
          teamId: providerAccountId,
          region: this.env.AVALON_REGION,
          workspaceId: String(row.workspace_id),
          connectionId,
        });
      } catch (error) {
        await this.env.DB.prepare(
          `UPDATE connector_connections SET status = 'error', error_json = ?, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND connector_type = 'slack'`,
        ).bind(JSON.stringify({ code: "slack_route_registration_failed", message: error instanceof Error ? error.message : "Slack route registration failed", retryable: true }), nowIso(), connectionId, row.workspace_id).run();
        throw error;
      }
      try {
        await new SlackAgentService(this.env).schedulePublicChannelSync(connectionId);
      } catch (error) {
        // Auto-join is recoverable and must not invalidate otherwise healthy
        // Slack credentials or routing after the OAuth state is consumed.
        logWarn(this.env, "slack_public_channel_sync_schedule_failed", {
          connection_id: connectionId,
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
    }
    await this.recordConnectionAudit(
      String(row.workspace_id),
      String(row.user_id),
      existing ? "connector.reauthorized" : "connector.authorized",
      connectionId,
      { provider, scope: stateData.scope, capabilities: grantedCapabilities, providerAccountId },
    );
    const redirect = new URL(String(row.return_uri));
    redirect.searchParams.set("connection", connectionId);
    redirect.searchParams.set("status", "connected");
    redirect.searchParams.set("region", this.env.AVALON_REGION);
    if (attemptId) redirect.searchParams.set("attempt", attemptId);
    redirect.searchParams.set("provider", provider);
    if (attemptId) await this.finishOAuthAttempt(attemptId, "succeeded", { connectionId });
    return redirect.toString();
  }

  async completeProviderDenial(provider: ConnectorOAuthProvider, state: string): Promise<string> {
    const row = await this.consumeProviderState(provider, state, "connector");
    const attemptId = await this.oauthAttemptIdFromState(row);
    await this.finishOAuthAttempt(attemptId, "denied", { errorCode: "oauth_denied" });
    return this.connectorAttemptTarget({
      provider,
      status: "denied",
      attemptId,
      errorCode: "oauth_denied",
    });
  }

  async failProviderAttempt(
    provider: ConnectorOAuthProvider,
    state: string,
    errorCode: string,
  ): Promise<string> {
    const row = await this.env.DB.prepare(
      `SELECT * FROM oauth_states
       WHERE id = ? AND provider = ? AND region = ?
         AND purpose IN ('connector', 'github_install')`,
    ).bind(state, provider, this.env.AVALON_REGION).first<Record<string, unknown>>();
    if (!row) {
      return this.connectorAttemptTarget({
        provider,
        status: "failed",
        errorCode: normalizeConnectorOAuthErrorCode(errorCode),
      });
    }
    let attemptId: string;
    try {
      attemptId = await this.oauthAttemptIdFromState(row);
    } catch {
      return this.connectorAttemptTarget({
        provider,
        status: "failed",
        errorCode: normalizeConnectorOAuthErrorCode(errorCode),
      });
    }
    const existing = await this.loadOAuthAttempt(attemptId);
    if (existing?.status === "succeeded" && existing.connection_id) {
      return this.connectorAttemptTarget({
        provider,
        status: "succeeded",
        attemptId,
        connectionId: existing.connection_id,
      });
    }
    if (
      existing?.connection_id
      && (existing.status === "pending" || existing.status === "failed")
    ) {
      const committed = await this.env.DB.prepare(
        `SELECT id FROM connector_connections
         WHERE id = ? AND workspace_id = ? AND connector_type = ? AND status = 'healthy'`,
      ).bind(existing.connection_id, row.workspace_id, provider).first<{ id: string }>();
      if (committed) {
        await this.finishOAuthAttempt(attemptId, "succeeded", { connectionId: committed.id });
        return this.connectorAttemptTarget({
          provider,
          status: "succeeded",
          attemptId,
          connectionId: committed.id,
        });
      }
    }
    const terminalStatus = existing?.status === "denied" ? "denied" : "failed";
    const terminalError = existing?.error_code ?? normalizeConnectorOAuthErrorCode(errorCode);
    if (!existing || existing.status === "pending") {
      await this.finishOAuthAttempt(attemptId, terminalStatus, { errorCode: terminalError });
    }
    return this.connectorAttemptTarget({
      provider,
      status: terminalStatus,
      attemptId,
      errorCode: terminalError,
    });
  }

  async getOAuthAttempt(attemptId: string): Promise<ConnectorOAuthAttempt> {
    const auth = this.requireAuth();
    const at = nowIso();
    await this.env.DB.prepare(
      `UPDATE connector_oauth_attempts
       SET status = 'failed', error_code = 'oauth_attempt_expired', completed_at = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND user_id = ? AND region = ?
         AND status = 'pending' AND expires_at <= ?`,
    ).bind(
      at,
      at,
      attemptId,
      auth.workspaceId,
      auth.userId,
      this.env.AVALON_REGION,
      at,
    ).run();
    const row = await this.env.DB.prepare(
      `SELECT id, provider, status, connection_id, error_code, expires_at
       FROM connector_oauth_attempts
       WHERE id = ? AND workspace_id = ? AND user_id = ? AND region = ?`,
    ).bind(
      attemptId,
      auth.workspaceId,
      auth.userId,
      this.env.AVALON_REGION,
    ).first<ConnectorOAuthAttemptRow>();
    if (!row) throw new ApiError(404, "oauth_attempt_not_found", "The connector authorization attempt was not found");
    return {
      attemptId: row.id,
      provider: row.provider,
      status: row.status,
      connectionId: row.connection_id,
      errorCode: row.error_code,
      expiresAt: row.expires_at,
    };
  }

  async reconnect(id: string): Promise<ConnectorOAuthStart> {
    const connection = await this.loadAuthorized(id);
    if (connection.connector_type === "google") {
      return this.beginGoogle({
        scope: connection.scope,
        capabilities: parseJson(connection.granted_scopes_json, []),
        connectionId: id,
      });
    }
    if (
      connection.connector_type === "linear"
      || connection.connector_type === "notion"
      || connection.connector_type === "slack"
      || (connection.connector_type === "granola" && connection.scope === "personal")
    ) {
      return this.beginProvider(connection.connector_type, {
        scope: connection.scope,
        capabilities: parseJson(connection.granted_scopes_json, []),
        connectionId: id,
      });
    }
    if (connection.connector_type === "github") {
      return this.beginGitHub({
        scope: connection.scope,
        capabilities: parseJson(connection.granted_scopes_json, []),
        connectionId: id,
      });
    }
    throw new ApiError(422, "reconnect_not_supported", "This connection does not use OAuth reconnect");
  }

  async test(id: string) {
    const connection = await this.loadAuthorized(id);
    const context = await this.context(connection);
    const adapter = this.registry().get(connection.connector_type);
    let result: { ok: boolean; message: string; reconnectRequired?: boolean };
    let repairOutcome: string | null = null;
    try {
      result = await withAuthorizedConnection(
        this.env,
        {
          connection: context,
          adapter,
          signal: AbortSignal.timeout(10_000),
          connectionStatus: String(connection.status),
        },
        async (authorized) => {
          // Testing a connection is the one moment somebody has asked Avalon to
          // put it right, so this is where a provider-side repair belongs — not
          // in the health check, which reauthorization runs on every plugin
          // activation. A repair that fails must not fail the test: the check
          // below is still the answer being asked for.
          repairOutcome = await attemptConnectorRepair(this.env, adapter, authorized, {
            connectionId: String(connection.id),
            connectorType: String(connection.connector_type),
          });
          return adapter.healthCheck(authorized, AbortSignal.timeout(10_000));
        },
      );
    } catch (error) {
      if (!(error instanceof ConnectorError) || error.code !== "unauthorized") throw error;
      result = { ok: false, message: error.message, reconnectRequired: true };
    }
    if (result.ok && connection.connector_type === "linear") {
      const organizationId = connection.provider_account_id == null
        ? null
        : String(connection.provider_account_id);
      if (!organizationId) {
        result = { ok: false, message: "The Linear organization identity is missing", reconnectRequired: true };
      } else {
        try {
          await new LinearRoutingService(this.env).registerConnection({
            organizationId,
            region: this.env.AVALON_REGION,
            workspaceId: connection.workspace_id,
            connectionId: connection.id,
          });
        } catch {
          result = { ok: false, message: "The shared Linear webhook route could not be registered" };
        }
      }
    }
    if (result.ok && connection.connector_type === "notion") {
      const notionWorkspaceId = notionWorkspaceIdFromConfig(connection.config_json);
      if (!notionWorkspaceId) {
        result = { ok: false, message: "The Notion workspace identity is missing", reconnectRequired: true };
      } else {
        try {
          await new NotionRoutingService(this.env).registerConnection({
            notionWorkspaceId,
            region: this.env.AVALON_REGION,
            workspaceId: connection.workspace_id,
            connectionId: connection.id,
          });
        } catch {
          result = { ok: false, message: "The shared Notion webhook route could not be registered" };
        }
      }
    }
    if (result.ok && connection.connector_type === "slack" && connection.scope === "workspace") {
      const teamId = connection.provider_account_id == null ? null : String(connection.provider_account_id);
      if (!teamId) {
        result = { ok: false, message: "The Slack workspace identity is missing", reconnectRequired: true };
      } else {
        try {
          await new SlackRoutingService(this.env).registerConnection({
            teamId,
            region: this.env.AVALON_REGION,
            workspaceId: connection.workspace_id,
            connectionId: connection.id,
          });
        } catch {
          result = { ok: false, message: "The shared Slack ingress route could not be registered" };
        }
      }
    }
    // The compensating write this used to need is gone: the door now persists
    // for any row a person has not disabled, so a probe that revives a
    // `needs_reconnect` connection has its recovered credential stored by the
    // door itself. Writing again here would encrypt and store the same value
    // twice for one test.
    if (result.ok && connection.connector_type === "granola" && connection.scope === "personal") {
      const providerAccountId = stringField(context.credentials, "providerAccountId");
      if (!providerAccountId) {
        result = { ok: false, message: "Granola did not return the active account identity", reconnectRequired: true };
      } else {
        const displayLabel = stringField(context.credentials, "providerAccountName")
          ?? stringField(context.credentials, "workspaceName")
          ?? providerAccountId;
        await this.env.DB.prepare(
          `UPDATE connector_connections
           SET provider_account_id = ?, display_name = ?, config_json = ?, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND connector_type = 'granola' AND scope = 'personal'`,
        ).bind(
          providerAccountId,
          `Granola · ${displayLabel}`.slice(0, 180),
          JSON.stringify({
            region: this.env.AVALON_REGION,
            ...verifiedIdentityConfig("granola", context.credentials, providerAccountId),
          }),
          nowIso(),
          connection.id,
          connection.workspace_id,
        ).run();
      }
    }
    if (repairOutcome) result = { ...result, message: `${result.message}. ${repairOutcome}` };
    await this.env.DB.prepare(
      `UPDATE connector_connections SET status = ?, error_json = ?, updated_at = ? WHERE id = ?`,
    ).bind(
      result.ok ? "healthy" : result.reconnectRequired ? "needs_reconnect" : "error",
      result.ok ? null : JSON.stringify({ message: result.message, reconnectRequired: result.reconnectRequired ?? false }),
      nowIso(),
      id,
    ).run();
    return result;
  }

  async disable(id: string): Promise<void> {
    const connection = await this.loadAuthorized(id);
    const adapter = this.registry().get(connection.connector_type);
    // Google OAuth revocation is project-wide for the token grant. A regional
    // database cannot prove that no sibling connection exists in another
    // region, so disabling one Google connection must remain a local action.
    const mayRevokeRemotely = connection.connector_type !== "google";
    let remoteRevocation: "skipped" | "succeeded" | "failed" = "skipped";
    try {
      if (mayRevokeRemotely && adapter.revoke) {
        const signal = AbortSignal.timeout(15_000);
        await withAuthorizedConnection(
          this.env,
          {
            connection: await this.context(connection),
            adapter,
            signal,
            connectionStatus: String(connection.status),
          },
          (authorized) => adapter.revoke!(authorized, signal),
        );
        remoteRevocation = "succeeded";
      }
    } catch {
      remoteRevocation = "failed";
    } finally {
      await this.env.DB.prepare(
        `UPDATE connector_connections SET status = 'disabled', encrypted_credentials = NULL,
         credential_iv = NULL, next_poll_at = NULL, updated_at = ? WHERE id = ?`,
      ).bind(nowIso(), id).run();
      await this.env.DB.prepare("UPDATE schedules SET enabled = 0, updated_at = ? WHERE connector_connection_id = ?")
        .bind(nowIso(), id).run();
      await this.refreshScheduler(connection.workspace_id);
      if (connection.connector_type === "github" && connection.provider_account_id) {
        const sibling = await this.env.DB.prepare(
          `SELECT id FROM connector_connections
           WHERE workspace_id = ? AND connector_type = 'github'
             AND provider_account_id = ? AND status <> 'disabled' AND id <> ?
           LIMIT 1`,
        ).bind(
          connection.workspace_id,
          connection.provider_account_id,
          connection.id,
        ).first<{ id: string }>();
        if (!sibling) {
          try {
            await new GitHubRoutingService(this.env).setInstallationRouteStatus({
              installationId: String(connection.provider_account_id),
              region: this.env.AVALON_REGION,
              workspaceId: connection.workspace_id,
              status: "disabled",
            });
          } catch (error) {
            logWarn(this.env, "github_route_deactivation_failed", {
              connection_id: connection.id,
              reason: error instanceof Error ? error.message : "unknown route error",
            });
          }
        }
      }
      if (
        connection.connector_type === "linear"
        && connection.provider_account_id
      ) {
        try {
          await new LinearRoutingService(this.env).setConnectionStatus({
            organizationId: String(connection.provider_account_id),
            region: this.env.AVALON_REGION,
            workspaceId: connection.workspace_id,
            connectionId: connection.id,
            status: "disabled",
          });
        } catch (error) {
          // The regional connection is already disabled and cannot consume the
          // event. Keep teardown recoverable; reconciliation can retire the
          // opaque Global route later without restoring credentials.
          logWarn(this.env, "linear_route_deactivation_failed", {
            connection_id: connection.id,
            reason: error instanceof Error ? error.message : "unknown route error",
          });
        }
      }
      if (connection.connector_type === "notion") {
        const notionWorkspaceId = notionWorkspaceIdFromConfig(connection.config_json);
        if (notionWorkspaceId) {
          try {
            await new NotionRoutingService(this.env).setConnectionStatus({
              notionWorkspaceId,
              region: this.env.AVALON_REGION,
              workspaceId: connection.workspace_id,
              connectionId: connection.id,
              status: "disabled",
            });
          } catch (error) {
            // The regional connection is already disabled and cannot consume the
            // event. Keep teardown recoverable; reconciliation can retire the
            // opaque Global route later without restoring credentials.
            logWarn(this.env, "notion_route_deactivation_failed", {
              connection_id: connection.id,
              reason: error instanceof Error ? error.message : "unknown route error",
            });
          }
        }
      }
      if (
        connection.connector_type === "slack"
        && connection.scope === "workspace"
        && connection.provider_account_id
      ) {
        try {
          await new SlackRoutingService(this.env).setConnectionStatus({
            teamId: String(connection.provider_account_id),
            region: this.env.AVALON_REGION,
            workspaceId: connection.workspace_id,
            connectionId: connection.id,
            status: "disabled",
          });
        } catch (error) {
          logWarn(this.env, "slack_route_deactivation_failed", {
            connection_id: connection.id,
            reason: error instanceof Error ? error.message : "unknown route error",
          });
        }
      }
      await this.recordConnectionAudit(
        connection.workspace_id,
        this.requireAuth().userId,
        "connector.disabled",
        connection.id,
        { provider: connection.connector_type, scope: connection.scope, remoteRevocation },
      );
    }
  }

  async createWebhook(input: CreateWebhookInput) {
    const auth = this.requireAuth();
    this.assertScopeAllowed(input.scope);
    if (input.idempotencyKey) {
      const existing = await this.findIdempotentWebhookConnection(
        input.scope,
        input.idempotencyKey,
      );
      if (existing) {
        this.assertWebhookCreationReplay(existing, input);
        return this.webhookConnectionResult(existing);
      }
    }
    const id = newId();
    const secret = createWebhookSecret();
    const encrypted = await encryptString(
      JSON.stringify({ signingSecret: secret }),
      this.env.CONNECTOR_CREDENTIALS_KEY,
      id,
    );
    const at = nowIso();
    const modelPluginId = await this.allocateModelPluginId(auth.workspaceId, "generic_webhook");
    try {
      await this.env.DB.prepare(
        `INSERT INTO connector_connections
         (id, workspace_id, connector_type, scope, owner_user_id, display_name,
          encrypted_credentials, credential_iv, credential_key_version, granted_scopes_json,
          model_plugin_id, status, cursor_json, config_json, created_at, updated_at)
         VALUES (?, ?, 'generic_webhook', ?, ?, ?, ?, ?, ?, '[]', ?, 'healthy', '{}', ?, ?, ?)`,
      ).bind(
        id,
        auth.workspaceId,
        input.scope,
        input.scope === "personal" ? auth.userId : null,
        input.displayName,
        encrypted.ciphertext,
        encrypted.iv,
        Number(this.env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1),
        modelPluginId,
        JSON.stringify({
          eventTypes: [...new Set(input.eventTypes)],
          ...(input.idempotencyKey ? { creationIdempotencyKey: input.idempotencyKey } : {}),
        }),
        at,
        at,
      ).run();
    } catch (error) {
      if (!input.idempotencyKey || !isUniqueConstraintError(error)) throw error;
      const winner = await this.findIdempotentWebhookConnection(input.scope, input.idempotencyKey);
      if (!winner) throw error;
      this.assertWebhookCreationReplay(winner, input);
      return this.webhookConnectionResult(winner);
    }
    await this.recordConnectionAudit(auth.workspaceId, auth.userId, "connector.authorized", id, {
      provider: "generic_webhook", scope: input.scope, eventTypes: input.eventTypes,
    });
    return this.webhookConnectionResult({
      id,
      workspace_id: auth.workspaceId,
      connector_type: "generic_webhook",
      scope: input.scope,
      owner_user_id: input.scope === "personal" ? auth.userId : null,
      model_plugin_id: modelPluginId,
      encrypted_credentials: encrypted.ciphertext,
      credential_iv: encrypted.iv,
      credential_key_version: Number(this.env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1),
    }, secret);
  }

  async rotateWebhookSecret(id: string) {
    const auth = this.requireAuth();
    const connection = await this.env.DB.prepare(
      `SELECT * FROM connector_connections
       WHERE id = ? AND workspace_id = ? AND connector_type = 'generic_webhook'
         AND status <> 'disabled'`,
    ).bind(id, auth.workspaceId).first<StoredConnection>();
    if (!connection) throw new ApiError(404, "connection_not_found", "Webhook connection not found");
    if (connection.scope === "personal" && connection.owner_user_id !== auth.userId) {
      throw new ApiError(403, "connection_forbidden", "This personal webhook belongs to another user");
    }
    this.assertScopeAllowed(connection.scope);
    const signingSecret = createWebhookSecret();
    const encrypted = await encryptString(
      JSON.stringify({ signingSecret }),
      this.env.CONNECTOR_CREDENTIALS_KEY,
      connection.id,
    );
    await this.env.DB.prepare(
      `UPDATE connector_connections
       SET encrypted_credentials = ?, credential_iv = ?, credential_key_version = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status <> 'disabled'`,
    ).bind(
      encrypted.ciphertext,
      encrypted.iv,
      Number(this.env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1),
      nowIso(),
      connection.id,
      auth.workspaceId,
    ).run();
    await this.recordConnectionAudit(auth.workspaceId, auth.userId, "connector.credentials_rotated", id, {
      provider: "generic_webhook",
      scope: connection.scope,
    });
    return {
      endpoint: new URL(`/ingest/webhook/${id}`, this.env.PUBLIC_API_BASE_URL).toString(),
      signingSecret,
      signatureFormat: "t=<unix-seconds>,v1=<hex-hmac-sha256(t.raw-body)>",
    };
  }

  async createX(input: { scope: "workspace"; capabilities: string[] }) {
    const auth = this.requireAuth();
    this.assertScopeAllowed(input.scope);
    const adapter = xConnectorConfig(this.env) ? this.registry().get("x") : null;
    if (!adapter) throw new ApiError(503, "x_connector_unavailable", "X access is not configured");
    const capabilities = [...new Set(input.capabilities)];
    const supported = new Set(adapter.manifest.capabilities.map((capability) => capability.id));
    if (
      capabilities.length === 0
      || capabilities.some((capability) =>
        !supported.has(capability)
        || !connectorCapabilitySupportsScope(adapter, capability, input.scope))
    ) {
      throw new ApiError(422, "invalid_connector_capabilities", "Choose supported X capabilities");
    }

    const existing = await this.env.DB.prepare(
      `SELECT id FROM connector_connections
       WHERE workspace_id = ? AND connector_type = 'x' AND scope = 'workspace'
         AND status <> 'disabled' LIMIT 1`,
    ).bind(auth.workspaceId).first<{ id: string }>();
    if (existing) {
      throw new ApiError(
        409,
        "x_connection_exists",
        "An active workspace X connection already exists",
      );
    }

    // No connection exists yet, and X authenticates with the regional
    // TwitterAPI.io key rather than per-connection credentials. The
    // connectionless health check is the accurate probe here; a synthetic
    // context would only be claiming a freshness nothing established.
    const health = await adapter.healthCheck();
    if (!health.ok) throw new ApiError(503, "x_connector_unhealthy", health.message);

    const id = newId();
    const encrypted = await encryptString("{}", this.env.CONNECTOR_CREDENTIALS_KEY, id);
    const at = nowIso();
    const modelPluginId = await this.allocateModelPluginId(auth.workspaceId, "x");
    await this.env.DB.prepare(
      `INSERT INTO connector_connections
       (id, workspace_id, connector_type, scope, owner_user_id, display_name,
        encrypted_credentials, credential_iv, credential_key_version, granted_scopes_json,
        model_plugin_id, status, cursor_json, config_json, created_at, updated_at)
       VALUES (?, ?, 'x', ?, ?, 'Public X via TwitterAPI.io', ?, ?, ?, ?, ?, 'healthy', '{}', '{}', ?, ?)`,
    ).bind(
      id,
      auth.workspaceId,
      input.scope,
      null,
      encrypted.ciphertext,
      encrypted.iv,
      Number(this.env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1),
      JSON.stringify(capabilities),
      modelPluginId,
      at,
      at,
    ).run();
    await this.recordConnectionAudit(auth.workspaceId, auth.userId, "connector.authorized", id, {
      provider: "x",
      scope: input.scope,
      capabilities,
    });
    const connection = (await this.list()).find((item) => item.id === id);
    if (!connection) throw new ApiError(500, "connection_write_failed", "The X connection could not be loaded");
    return { connection };
  }

  async createGranolaWorkspace(input: { apiKey: string; capabilities: string[] }) {
    const auth = this.requireAuth();
    this.assertScopeAllowed("workspace");
    const capabilities = [...new Set(input.capabilities)];
    if (capabilities.length !== 1 || capabilities[0] !== GranolaCapabilities.workspaceRead) {
      throw new ApiError(422, "invalid_connector_capabilities", "Choose the Granola workspace read capability");
    }
    const existing = await this.env.DB.prepare(
      `SELECT id FROM connector_connections
       WHERE workspace_id = ? AND connector_type = 'granola' AND scope = 'workspace'
         AND status <> 'disabled' LIMIT 1`,
    ).bind(auth.workspaceId).first<{ id: string }>();
    if (existing) throw new ApiError(409, "granola_workspace_connection_exists", "A Granola workspace connection already exists");

    const id = newId();
    const apiKey = input.apiKey.trim();
    const webhookUrl = new URL(`/ingest/granola/${id}`, this.env.PUBLIC_API_BASE_URL).toString();
    const webhook = await createGranolaWebhookEndpoint(
      apiKey,
      webhookUrl,
      AbortSignal.timeout(15_000),
    );
    try {
      const credentials = {
        apiKey,
        webhookEndpointId: webhook.id,
        webhookSigningSecret: webhook.signingSecret,
      };
      const encrypted = await encryptString(
        JSON.stringify(credentials),
        this.env.CONNECTOR_CREDENTIALS_KEY,
        id,
      );
      const providerAccountId = `workspace:${(await sha256(apiKey)).slice(0, 32)}`;
      const at = nowIso();
      const modelPluginId = await this.allocateModelPluginId(auth.workspaceId, "granola");
      await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO connector_connections
           (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
            display_name, encrypted_credentials, credential_iv, credential_key_version,
            granted_scopes_json, model_plugin_id, status, cursor_json, config_json,
            created_at, updated_at)
           VALUES (?, ?, 'granola', 'workspace', NULL, ?, 'Granola workspace', ?, ?, ?, ?, ?,
                   'healthy', '{}', '{}', ?, ?)`,
        ).bind(
          id,
          auth.workspaceId,
          providerAccountId,
          encrypted.ciphertext,
          encrypted.iv,
          Number(this.env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1),
          JSON.stringify(capabilities),
          modelPluginId,
          at,
          at,
        ),
        this.env.DB.prepare(
          `INSERT INTO audit_events
           (id, workspace_id, actor_type, actor_user_id, action, target_type, target_id, metadata_json, created_at)
           VALUES (?, ?, 'user', ?, 'connector.authorized', 'connector_connection', ?, ?, ?)`,
        ).bind(
          newId(),
          auth.workspaceId,
          auth.userId,
          id,
          JSON.stringify({ provider: "granola", scope: "workspace", capabilities }),
          at,
        ),
      ]);
    } catch (error) {
      try {
        await deleteGranolaWebhookEndpoint(apiKey, webhook.id, AbortSignal.timeout(10_000));
      } catch {
        // The original persistence error is authoritative. Granola admins can
        // remove a rare orphaned endpoint from connector settings.
      }
      throw error;
    }
    const connection = (await this.list()).find((item) => item.id === id);
    if (!connection) throw new ApiError(500, "connection_write_failed", "The Granola connection could not be loaded");
    return { connection };
  }

  async ingestGranolaWebhook(
    connectionId: string,
    rawBody: Uint8Array,
    headers: {
      webhookId: string | null;
      webhookTimestamp: string | null;
      webhookSignature: string | null;
    },
  ) {
    if (rawBody.byteLength > numericEnv(this.env, "PROVIDER_WEBHOOK_MAX_BYTES", 1_000_000)) {
      throw new ApiError(413, "webhook_too_large", "Granola webhook payload exceeds the configured limit");
    }
    const connection = await this.env.DB.prepare(
      `SELECT * FROM connector_connections
       WHERE id = ? AND connector_type = 'granola' AND scope = 'workspace' AND status <> 'disabled'`,
    ).bind(connectionId).first<StoredConnection>();
    if (!connection) throw new ApiError(404, "connection_not_found", "Granola webhook connection not found");
    const context = await this.context(connection);
    const signingSecret = stringField(context.credentials, "webhookSigningSecret");
    if (!signingSecret) throw new ApiError(401, "webhook_secret_unavailable", "Granola webhook verification is unavailable");
    let rawBodyText: string;
    try {
      rawBodyText = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
    } catch {
      throw new ApiError(400, "invalid_webhook_body", "Granola webhook body is not valid UTF-8");
    }
    const source = this.registry().get("granola").webhookActivity;
    if (!source) throw new ApiError(500, "webhook_source_unavailable", "Granola webhook ingestion is unavailable");
    const webhookHeaders = new Headers();
    if (headers.webhookId) webhookHeaders.set("webhook-id", headers.webhookId);
    if (headers.webhookTimestamp) webhookHeaders.set("webhook-timestamp", headers.webhookTimestamp);
    if (headers.webhookSignature) webhookHeaders.set("webhook-signature", headers.webhookSignature);
    const envelope = await source.verify({
      rawBody: rawBodyText,
      headers: webhookHeaders,
      receivedAt: nowIso(),
      maxBytes: numericEnv(this.env, "PROVIDER_WEBHOOK_MAX_BYTES", 1_000_000),
      now: Date.now(),
      verificationSecret: signingSecret,
      replayWindowMs: numericEnv(this.env, "WEBHOOK_REPLAY_WINDOW_SECONDS", 300) * 1_000,
    });
    const verified = envelope.event as VerifiedGranolaWebhook;
    const receivedAt = nowIso();
    const payloadKey = `${this.env.AVALON_REGION}/${connection.workspace_id}/activities/granola-${verified.event_id}.json`;
    await this.env.PAYLOADS.put(payloadKey, rawBody, { httpMetadata: { contentType: "application/json" } });
    const normalized = source.normalize(context, envelope, payloadKey);
    if (!normalized) throw new ApiError(400, "unsupported_webhook_event", "Granola webhook event is not supported");
    const activityId = newId();
    const receiptId = newId();
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO webhook_receipts (id, connection_id, signature_hash, received_at, expires_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(connection_id, signature_hash) DO NOTHING`,
      ).bind(
        receiptId,
        connection.id,
        envelope.receiptKey ?? envelope.deliveryId,
        receivedAt,
        new Date(Date.now() + 4 * 24 * 60 * 60_000).toISOString(),
      ),
      this.env.DB.prepare(
        `INSERT INTO activities
         (id, workspace_id, connection_id, connection_scope, connection_owner_user_id,
          provider, provider_event_id, event_type, resource_type, provider_resource_id,
          actor_json, subject_json, occurred_at, received_at, title, summary, text_snippet,
          payload_ref, visibility_json, entity_keys_json, dedupe_key, raw_content_hash,
          target_user_ids_json, external_people_json,
          processing_status, metadata_json)
         VALUES (?, ?, ?, 'workspace', NULL, 'granola', ?, ?, 'granola_note', ?,
                 '{}', ?, ?, ?, ?, '', '', ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        activityId,
        connection.workspace_id,
        connection.id,
        verified.event_id,
        normalized.eventType,
        normalized.providerResourceId,
        JSON.stringify(normalized.subject),
        normalized.occurredAt,
        receivedAt,
        normalized.title,
        payloadKey,
        JSON.stringify(normalized.visibility),
        JSON.stringify(normalized.entityKeys),
        normalized.dedupeKey,
        normalized.rawContentHash,
        JSON.stringify(normalized.targetUserIds),
        JSON.stringify(normalized.externalPeople ?? []),
        JSON.stringify(normalized.metadata),
      ),
    ]);
    const insertedActivity = Number(results[1]?.meta.changes ?? 0) > 0;
    const canonical = insertedActivity
      ? { id: activityId }
      : await this.env.DB.prepare(
          `SELECT id FROM activities
           WHERE connection_id = ? AND provider_event_id = ? AND event_type = ?
           ORDER BY received_at DESC LIMIT 1`,
        ).bind(connection.id, verified.event_id, verified.event_type).first<{ id: string }>();
    if (!canonical) throw new ApiError(500, "webhook_activity_write_failed", "The Granola activity could not be stored");
    // Re-enqueue the canonical row on retries as crash-window recovery. If a
    // previous request committed D1 but failed before queue delivery, Granola's
    // retry must still make the durable activity visible to the consumer.
    await this.env.ACTIVITY_QUEUE.send({
      region: this.env.AVALON_REGION,
      workspaceId: connection.workspace_id,
      activityId: canonical.id,
      attempt: 0,
    });
    return {
      duplicate: Number(results[0]?.meta.changes ?? 0) === 0 || !insertedActivity,
      activityId: canonical.id,
    };
  }

  async ingestWebhook(connectionId: string, rawBody: Uint8Array, signatureHeader: string | null) {
    const maxBytes = numericEnv(this.env, "PROVIDER_WEBHOOK_MAX_BYTES", 1_000_000);
    if (rawBody.byteLength > maxBytes) {
      throw new ApiError(413, "webhook_too_large", "Webhook payload exceeds the configured limit");
    }
    let rawBodyText: string;
    try {
      rawBodyText = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
    } catch {
      throw new ApiError(400, "invalid_webhook_body", "Webhook body is not valid UTF-8");
    }
    const connection = await this.env.DB.prepare(
      `SELECT * FROM connector_connections WHERE id = ? AND connector_type = 'generic_webhook' AND status <> 'disabled'`,
    ).bind(connectionId).first<StoredConnection>();
    if (!connection) throw new ApiError(404, "connection_not_found", "Webhook connection not found");
    const context = await this.context(connection);
    const signingSecret = String(context.credentials.signingSecret ?? "");
    const source = this.registry().get("generic_webhook").webhookActivity;
    if (!source) throw new ApiError(500, "webhook_source_unavailable", "Webhook ingestion is unavailable");
    const webhookHeaders = new Headers();
    if (signatureHeader) webhookHeaders.set("x-avalon-signature", signatureHeader);
    const envelope = await source.verify({
      rawBody: rawBodyText,
      rawBodyBytes: rawBody,
      headers: webhookHeaders,
      receivedAt: nowIso(),
      maxBytes,
      now: Date.now(),
      verificationSecret: signingSecret,
      replayWindowMs: numericEnv(this.env, "WEBHOOK_REPLAY_WINDOW_SECONDS", 300) * 1_000,
    });
    const configuredEventTypes = parseJson<Record<string, unknown>>(connection.config_json, {}).eventTypes;
    const allowedEventTypes = Array.isArray(configuredEventTypes)
      ? configuredEventTypes.filter((value): value is string => typeof value === "string")
      : [];
    if (allowedEventTypes.length > 0 && !allowedEventTypes.includes(envelope.eventType)) {
      throw new ApiError(422, "webhook_event_not_allowed", "This webhook connection does not accept that event type");
    }
    const receiptId = newId();
    const payloadKey = `${this.env.AVALON_REGION}/${connection.workspace_id}/activities/webhook-${envelope.bodyHash}.json`;
    const normalized = source.normalize(context, envelope, payloadKey);
    if (!normalized) throw new ApiError(400, "unsupported_webhook_event", "Webhook event is not supported");
    if (connection.scope === "workspace" && normalized.targetUserIds.length > 0) {
      const uniqueTargets = [...new Set(normalized.targetUserIds)];
      const members = await this.env.DB.prepare(
        `SELECT user_id FROM workspace_members
         WHERE workspace_id = ? AND status = 'active'
           AND user_id IN (${uniqueTargets.map(() => "?").join(", ")})`,
      ).bind(connection.workspace_id, ...uniqueTargets).all<{ user_id: string }>();
      if ((members.results ?? []).length !== uniqueTargets.length) {
        throw new ApiError(422, "invalid_target_user", "Every webhook target must be an active member of this workspace");
      }
    }
    await this.env.DB.prepare(
      `DELETE FROM webhook_receipts
       WHERE id IN (
         SELECT id FROM webhook_receipts
         WHERE connection_id = ? AND expires_at <= ?
         ORDER BY expires_at ASC LIMIT 100
       )`,
    ).bind(connectionId, nowIso()).run();
    const existingReceipt = await this.env.DB.prepare(
      `SELECT id FROM webhook_receipts
       WHERE connection_id = ? AND signature_hash = ? AND expires_at > ?
       LIMIT 1`,
    ).bind(connectionId, envelope.receiptKey ?? envelope.deliveryId, nowIso()).first<{ id: string }>();
    if (existingReceipt) {
      const existing = await this.resolveCanonicalWebhookActivity(connectionId, normalized);
      if (existing) {
        if (existing.processing_status === "pending" || existing.processing_status === "failed") {
          await this.env.ACTIVITY_QUEUE.send({
            region: this.env.AVALON_REGION,
            workspaceId: connection.workspace_id,
            activityId: existing.id,
            attempt: 0,
          });
        }
        return { duplicate: true, activityId: existing.id };
      }
    }
    await this.env.PAYLOADS.put(payloadKey, rawBody, { httpMetadata: { contentType: "application/json" } });
    const activityId = newId();
    const receivedAt = nowIso();
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO webhook_receipts (id, connection_id, signature_hash, received_at, expires_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(connection_id, signature_hash) DO NOTHING`,
      ).bind(receiptId, connectionId, envelope.receiptKey ?? envelope.deliveryId, receivedAt, new Date(Date.now() + 24 * 60 * 60_000).toISOString()),
      this.env.DB.prepare(
        `INSERT INTO activities
         (id, workspace_id, connection_id, connection_scope, connection_owner_user_id,
          provider, provider_event_id, event_type, resource_type, provider_resource_id,
          actor_json, subject_json, occurred_at, received_at, title, summary, text_snippet,
          payload_ref, visibility_json, entity_keys_json, dedupe_key, raw_content_hash,
          target_user_ids_json, external_people_json,
          processing_status, metadata_json)
         VALUES (?, ?, ?, ?, ?, 'generic_webhook', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        activityId,
        connection.workspace_id,
        connection.id,
        connection.scope,
        connection.owner_user_id,
        normalized.providerEventId,
        normalized.eventType,
        normalized.resourceType,
        normalized.providerResourceId,
        JSON.stringify(normalized.actor),
        JSON.stringify(normalized.subject),
        normalized.occurredAt,
        receivedAt,
        normalized.title,
        normalized.summary,
        normalized.textSnippet,
        payloadKey,
        JSON.stringify(normalized.visibility),
        JSON.stringify(normalized.entityKeys),
        normalized.dedupeKey,
        normalized.rawContentHash,
        JSON.stringify(normalized.targetUserIds),
        JSON.stringify(normalized.externalPeople ?? []),
        JSON.stringify(normalized.metadata),
      ),
    ]);
    const insertedActivity = Number(results[1]?.meta.changes ?? 0) > 0;
    let canonical: { id: string; processing_status: string } | null = insertedActivity
      ? { id: activityId, processing_status: "pending" }
      : null;
    if (!canonical) {
      canonical = await this.resolveCanonicalWebhookActivity(connectionId, normalized);
    }
    if (!canonical) throw new ApiError(500, "webhook_activity_write_failed", "The webhook activity could not be stored");
    if (insertedActivity || canonical.processing_status === "pending" || canonical.processing_status === "failed") {
      await this.env.ACTIVITY_QUEUE.send({
        region: this.env.AVALON_REGION,
        workspaceId: connection.workspace_id,
        activityId: canonical.id,
        attempt: 0,
      });
    }
    return {
      duplicate: Number(results[0]?.meta.changes ?? 0) === 0 || !insertedActivity,
      activityId: canonical.id,
    };
  }

  private async findIdempotentWebhookConnection(
    scope: Scope,
    idempotencyKey: string,
  ): Promise<StoredConnection | null> {
    const auth = this.requireAuth();
    return this.env.DB.prepare(
      `SELECT * FROM connector_connections
       WHERE workspace_id = ? AND connector_type = 'generic_webhook'
         AND scope = ? AND COALESCE(owner_user_id, '') = ?
         AND status != 'disabled'
         AND json_extract(config_json, '$.creationIdempotencyKey') = ?
       LIMIT 1`,
    ).bind(
      auth.workspaceId,
      scope,
      scope === "personal" ? auth.userId : "",
      idempotencyKey,
    ).first<StoredConnection>();
  }

  private async resolveCanonicalWebhookActivity(
    connectionId: string,
    normalized: {
      dedupeKey: string;
      providerEventId: string;
      eventType: string;
      rawContentHash: string | null;
    },
  ): Promise<{ id: string; processing_status: string } | null> {
    type ExistingActivity = {
      id: string;
      raw_content_hash: string | null;
      processing_status: string;
    };
    const [byDedupe, byProviderEvent] = await Promise.all([
      this.env.DB.prepare(
        `SELECT id, raw_content_hash, processing_status FROM activities
         WHERE connection_id = ? AND dedupe_key = ? LIMIT 1`,
      ).bind(connectionId, normalized.dedupeKey).first<ExistingActivity>(),
      this.env.DB.prepare(
        `SELECT id, raw_content_hash, processing_status FROM activities
         WHERE connection_id = ? AND provider_event_id = ? AND event_type = ? LIMIT 1`,
      ).bind(connectionId, normalized.providerEventId, normalized.eventType).first<ExistingActivity>(),
    ]);
    if (byDedupe && byProviderEvent && byDedupe.id !== byProviderEvent.id) {
      throw new ApiError(409, "webhook_dedupe_collision", "The webhook dedupe key and provider event identity refer to different activities");
    }
    const existing = byDedupe ?? byProviderEvent;
    if (existing && existing.raw_content_hash !== normalized.rawContentHash) {
      throw new ApiError(409, "webhook_identity_reused", "The webhook reused an activity identity with different content");
    }
    return existing
      ? { id: existing.id, processing_status: existing.processing_status }
      : null;
  }

  private async webhookConnectionResult(connection: StoredConnection, signingSecret?: string) {
    let secret = signingSecret;
    if (!secret) {
      const context = await this.context(connection);
      secret = typeof context.credentials.signingSecret === "string"
        ? context.credentials.signingSecret
        : undefined;
    }
    if (!secret) throw new ApiError(500, "webhook_secret_unavailable", "The webhook signing secret is unavailable");
    const item = (await this.list()).find((candidate) => candidate.id === connection.id);
    if (!item) throw new ApiError(500, "webhook_connection_unavailable", "The webhook connection could not be loaded");
    return {
      connection: item,
      endpoint: new URL(`/ingest/webhook/${connection.id}`, this.env.PUBLIC_API_BASE_URL).toString(),
      signingSecret: secret,
      signatureFormat: "t=<unix-seconds>,v1=<hex-hmac-sha256(t.raw-body)>",
    };
  }

  private assertWebhookCreationReplay(connection: StoredConnection, input: CreateWebhookInput): void {
    const config = parseJson<Record<string, unknown>>(connection.config_json, {});
    const storedEventTypes = Array.isArray(config.eventTypes)
      ? config.eventTypes.filter((value): value is string => typeof value === "string").sort()
      : [];
    const requestedEventTypes = [...new Set(input.eventTypes)].sort();
    if (
      connection.scope !== input.scope
      || String(connection.display_name ?? "") !== input.displayName
      || JSON.stringify(storedEventTypes) !== JSON.stringify(requestedEventTypes)
    ) {
      throw new ApiError(409, "idempotency_key_reused", "This idempotency key was already used with different webhook settings");
    }
  }

  private registry() {
    return connectorRegistryForEnv(this.env);
  }

  private async persistConnectionMutation(
    statement: D1PreparedStatement,
    attemptId: string | null,
    connectionId: string,
  ): Promise<D1Result<unknown>> {
    if (!attemptId) return statement.run();
    const at = nowIso();
    const [result] = await this.env.DB.batch([
      statement,
      this.env.DB.prepare(
        `UPDATE connector_oauth_attempts
         SET connection_id = ?, updated_at = ?
         WHERE id = ? AND region = ?
           AND status IN ('pending', 'failed')`,
      ).bind(connectionId, at, attemptId, this.env.AVALON_REGION),
    ]);
    if (!result) throw new ApiError(500, "connector_persistence_failed", "The connector could not be persisted");
    return result;
  }

  private async extendOAuthAttempt(attemptId: string, expiresAt: string): Promise<void> {
    const at = nowIso();
    await this.env.DB.prepare(
      `UPDATE connector_oauth_attempts
       SET status = 'pending', error_code = NULL, completed_at = NULL, expires_at = ?, updated_at = ?
       WHERE id = ? AND region = ?
         AND (status = 'pending' OR (status = 'failed' AND error_code = 'oauth_attempt_expired'))`,
    ).bind(expiresAt, at, attemptId, this.env.AVALON_REGION).run();
  }

  private async persistOAuthStart(input: {
    attemptId: string;
    provider: ConnectorOAuthProvider;
    purpose?: "connector" | "github_install";
    state: string;
    statePayload: string;
    auth: AuthContext;
    expiresAt: string;
  }): Promise<void> {
    const at = nowIso();
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO connector_oauth_attempts
         (id, region, provider, user_id, workspace_id, status, connection_id,
          error_code, expires_at, completed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL, ?, ?)`,
      ).bind(
        input.attemptId,
        this.env.AVALON_REGION,
        input.provider,
        input.auth.userId,
        input.auth.workspaceId,
        input.expiresAt,
        at,
        at,
      ),
      this.env.DB.prepare(
        `INSERT INTO oauth_states
         (id, region, provider, purpose, code_verifier_encrypted, user_id, workspace_id,
          return_uri, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        input.state,
        this.env.AVALON_REGION,
        input.provider,
        input.purpose ?? "connector",
        input.statePayload,
        input.auth.userId,
        input.auth.workspaceId,
        this.env.DESKTOP_DEEP_LINK_URI,
        input.expiresAt,
      ),
    ]);
  }

  private async oauthAttemptIdFromState(row: Record<string, unknown>): Promise<string> {
    const payload = JSON.parse(
      await openString(String(row.code_verifier_encrypted), this.env.OAUTH_STATE_ENCRYPTION_KEY),
    ) as { attemptId?: unknown };
    if (typeof payload.attemptId !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(payload.attemptId)) {
      throw new ApiError(401, "invalid_oauth_state", "The connector authorization attempt is invalid");
    }
    return payload.attemptId;
  }

  private async finishOAuthAttempt(
    attemptId: string,
    status: "succeeded" | "denied" | "failed",
    result: { connectionId?: string; errorCode?: string },
  ): Promise<void> {
    const at = nowIso();
    const updated = await this.env.DB.prepare(
      `UPDATE connector_oauth_attempts
       SET status = ?, connection_id = ?, error_code = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND region = ?
         AND (status = 'pending' OR (? = 'succeeded' AND status = 'failed'))
       RETURNING id`,
    ).bind(
      status,
      result.connectionId ?? null,
      result.errorCode ?? null,
      at,
      at,
      attemptId,
      this.env.AVALON_REGION,
      status,
    ).first<{ id: string }>();
    if (!updated) {
      const existing = await this.loadOAuthAttempt(attemptId);
      if (!existing || existing.status !== status || existing.connection_id !== (result.connectionId ?? null)) {
        throw new ApiError(409, "oauth_attempt_already_completed", "The connector authorization attempt already completed");
      }
    }
  }

  private async loadOAuthAttempt(attemptId: string): Promise<ConnectorOAuthAttemptRow | null> {
    return this.env.DB.prepare(
      `SELECT id, provider, status, connection_id, error_code, expires_at
       FROM connector_oauth_attempts WHERE id = ? AND region = ?`,
    ).bind(attemptId, this.env.AVALON_REGION).first<ConnectorOAuthAttemptRow>();
  }

  private connectorAttemptTarget(input: {
    provider: ConnectorOAuthProvider;
    status: "succeeded" | "denied" | "failed";
    attemptId?: string;
    connectionId?: string;
    errorCode?: string;
  }): string {
    return connectorAttemptTarget(this.env, input);
  }

  private requireAuth(): AuthContext {
    if (!this.auth) throw new ApiError(401, "authentication_required", "Authentication is required");
    return this.auth;
  }

  private async consumeProviderState(provider: string, state: string, purpose: string): Promise<Record<string, unknown>> {
    const row = await this.env.DB.prepare(
      `UPDATE oauth_states SET consumed_at = ? WHERE id = ? AND provider = ? AND purpose = ? AND region = ?
       AND consumed_at IS NULL AND expires_at > ? RETURNING *`,
    ).bind(nowIso(), state, provider, purpose, this.env.AVALON_REGION, nowIso()).first<Record<string, unknown>>();
    if (!row) throw new ApiError(401, "invalid_oauth_state", "The connector authorization is invalid or expired");
    return row;
  }

  private async assertOAuthStatePrincipalAllowed(
    state: Record<string, unknown>,
    scope: Scope,
  ): Promise<void> {
    const workspaceId = stringField(state, "workspace_id");
    const userId = stringField(state, "user_id");
    if (!workspaceId || !userId) {
      throw new ApiError(401, "invalid_oauth_state", "The connector authorization is missing its workspace principal");
    }
    const membership = await this.env.DB.prepare(
      `SELECT role, status FROM workspace_members
       WHERE workspace_id = ? AND user_id = ?`,
    ).bind(workspaceId, userId).first<{ role: string; status: string }>();
    if (!membership || membership.status !== "active") {
      throw new ApiError(403, "workspace_membership_required", "Your workspace membership is no longer active");
    }
    if (scope === "workspace" && membership.role !== "owner" && membership.role !== "admin") {
      throw new ApiError(403, "workspace_admin_required", "Workspace connections require an administrator");
    }
  }

  private async upsertGitHubRepositoryResources(
    workspaceId: string,
    connectionId: string,
    resources: GitHubWebhookResourceHint[],
    at: string,
  ): Promise<void> {
    if (resources.length === 0) return;
    const rows = resources.map((resource) => ({
      id: newId(),
      resourceType: resource.resourceType,
      providerResourceId: resource.providerResourceId,
      title: resource.title,
      canonicalUrl: resource.canonicalUrl,
      metadataJson: JSON.stringify({
        ...resource.metadata,
        selected: true,
        discoveredBy: "oauth_bootstrap",
      }),
    }));
    await this.env.DB.prepare(
      `INSERT INTO resources
       (id, workspace_id, connection_id, resource_type, provider,
        provider_resource_id, title, canonical_url, metadata_json,
        created_at, updated_at)
       SELECT json_extract(value, '$.id'), ?, ?,
              json_extract(value, '$.resourceType'), 'github',
              json_extract(value, '$.providerResourceId'),
              json_extract(value, '$.title'),
              json_extract(value, '$.canonicalUrl'),
              json_extract(value, '$.metadataJson'), ?, ?
       FROM json_each(?)
       WHERE true
       ON CONFLICT(workspace_id, connection_id, provider, provider_resource_id)
       WHERE connection_id IS NOT NULL AND provider_resource_id IS NOT NULL
       DO UPDATE SET
         resource_type = excluded.resource_type,
         title = excluded.title,
         canonical_url = COALESCE(excluded.canonical_url, resources.canonical_url),
         metadata_json = json_patch(resources.metadata_json, excluded.metadata_json),
         updated_at = excluded.updated_at`,
    ).bind(workspaceId, connectionId, at, at, JSON.stringify(rows)).run();
  }

  private async recordConnectionAudit(
    workspaceId: string,
    userId: string,
    action: string,
    connectionId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO audit_events
       (id, workspace_id, actor_type, actor_user_id, action, target_type, target_id, metadata_json, created_at)
       VALUES (?, ?, 'user', ?, ?, 'connector_connection', ?, ?, ?)`,
    ).bind(newId(), workspaceId, userId, action, connectionId, JSON.stringify(metadata), nowIso()).run();
  }

  private assertScopeAllowed(scope: Scope): void {
    const auth = this.requireAuth();
    if (scope === "workspace" && auth.role !== "owner" && auth.role !== "admin") {
      throw new ApiError(403, "workspace_admin_required", "Workspace connections require an administrator");
    }
  }

  /**
   * Allocate the stable, workspace-local name shown to the model. Opaque
   * connection UUIDs remain the only authorization identity. Disabled rows do
   * not reserve a name, so removing and later adding the same provider reuses
   * the clean base (plugin_google, plugin_linear, and so on).
   */
  private async allocateModelPluginId(
    workspaceId: string,
    connectorType: string,
    existingConnectionId: string | null = null,
  ): Promise<string> {
    const base = modelPluginIdBase(connectorType);
    const active = await this.env.DB.prepare(
      `SELECT id, model_plugin_id FROM connector_connections
       WHERE workspace_id = ? AND status <> 'disabled' AND (? IS NULL OR id <> ?)`,
    ).bind(workspaceId, existingConnectionId, existingConnectionId).all<{
      id: string;
      model_plugin_id: string;
    }>();
    const used = new Set(
      (active.results ?? [])
        .map((row) => row.model_plugin_id)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    );
    if (existingConnectionId) {
      const current = await this.env.DB.prepare(
        `SELECT model_plugin_id FROM connector_connections WHERE id = ? AND workspace_id = ?`,
      ).bind(existingConnectionId, workspaceId).first<{ model_plugin_id: string }>();
      const currentId = current?.model_plugin_id;
      if (currentId && isModelPluginIdForBase(currentId, base) && !used.has(currentId)) return currentId;
    }
    if (!used.has(base)) return base;
    for (let suffix = 2; suffix < 100_000; suffix += 1) {
      const candidate = `${base}_${suffix}`;
      if (!used.has(candidate)) return candidate;
    }
    throw new ApiError(409, "connector_plugin_namespace_exhausted", "No connector plugin name is available");
  }

  private async loadAuthorized(id: string): Promise<StoredConnection> {
    const auth = this.requireAuth();
    const row = await this.env.DB.prepare(
      `SELECT * FROM connector_connections WHERE id = ? AND workspace_id = ?
       AND (scope = 'workspace' OR owner_user_id = ?)`,
    ).bind(id, auth.workspaceId, auth.userId).first<StoredConnection>();
    if (!row) throw new ApiError(404, "connection_not_found", "Connection not found");
    if (row.scope === "workspace" && auth.role !== "owner" && auth.role !== "admin") {
      throw new ApiError(403, "workspace_admin_required", "Only administrators can modify workspace connections");
    }
    return row;
  }

  private async context(row: StoredConnection): Promise<ConnectorConnectionContext> {
    let credentials: Record<string, unknown> = {};
    if (typeof row.encrypted_credentials === "string" && typeof row.credential_iv === "string") {
      credentials = JSON.parse(await decryptVersionedConnectorCredentials(this.env, {
        id: row.id,
        encrypted_credentials: row.encrypted_credentials,
        credential_iv: row.credential_iv,
        credential_key_version: row.credential_key_version ?? null,
      })) as Record<string, unknown>;
    }
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      scope: row.scope,
      ownerUserId: row.owner_user_id,
      grantedScopes: parseJson(row.granted_scopes_json, []),
      credentials,
      cursor: parseJson(row.cursor_json, {}),
      config: parseJson(row.config_json, {}),
    };
  }

  private async persistCredentials(row: StoredConnection, credentials: Record<string, unknown>): Promise<void> {
    const encrypted = await encryptString(
      JSON.stringify(credentials),
      this.env.CONNECTOR_CREDENTIALS_KEY,
      row.id,
    );
    await this.env.DB.prepare(
      `UPDATE connector_connections SET encrypted_credentials = ?, credential_iv = ?,
       credential_key_version = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`,
    ).bind(
      encrypted.ciphertext,
      encrypted.iv,
      Number(this.env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1),
      nowIso(),
      row.id,
      row.workspace_id,
    ).run();
  }

  private async createPollSchedule(workspaceId: string, connectionId: string, intervalSeconds: number): Promise<void> {
    const at = nowIso();
    await this.env.DB.prepare(
      `INSERT INTO schedules
       (id, workspace_id, connector_connection_id, schedule_type, interval_seconds,
        timezone, next_run_at, enabled, version, created_at, updated_at)
       VALUES (?, ?, ?, 'interval', ?, 'UTC', ?, 1, 1, ?, ?)`,
    ).bind(newId(), workspaceId, connectionId, intervalSeconds, new Date(Date.now() + intervalSeconds * 1_000).toISOString(), at, at).run();
  }

  private async refreshScheduler(workspaceId: string): Promise<void> {
    const schedulers = durableObjectNamespaceForRegion(this.env.WORKSPACE_SCHEDULERS, this.env.AVALON_REGION, this.env.APP_ENV);
    const id = schedulers.idFromName(`${this.env.AVALON_REGION}:${workspaceId}`);
    const response = await schedulers.get(id).fetch("https://scheduler.internal/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, region: this.env.AVALON_REGION }),
    });
    if (!response.ok) throw new Error(`Scheduler refresh failed (${response.status})`);
  }
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export function modelPluginIdBase(connectorType: string): string {
  const provider = connectorType === "generic_webhook" ? "webhook" : connectorType;
  const safe = provider
    .toLowerCase()
    .replace(/[^a-z0-9_]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 48);
  if (!safe) throw new ApiError(422, "invalid_connector_type", "Connector type cannot form a plugin name");
  return `plugin_${safe}`;
}

function isModelPluginIdForBase(value: string, base: string): boolean {
  return value === base || new RegExp(`^${base}_[2-9][0-9]*$`, "u").test(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
function arrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * The Notion workspace a connection was installed into, as recorded by
 * `verifiedIdentityConfig`. Reading it from the connection's own config keeps
 * route teardown and re-registration off the credential-decryption path.
 */
function notionWorkspaceIdFromConfig(configJson: unknown): string | null {
  try {
    const parsed = JSON.parse(String(configJson ?? "{}")) as unknown;
    return parsed && typeof parsed === "object"
      ? stringField(parsed as Record<string, unknown>, "providerTenantId")
      : null;
  } catch {
    return null;
  }
}

function verifiedIdentityConfig(
  provider: ConnectorOAuthProvider,
  credentials: Record<string, unknown>,
  providerAccountId: string,
): Record<string, string | null> {
  if (provider === "google") return {
    providerTenantId: providerAccountId,
    providerUserId: providerAccountId,
    handle: null,
    verifiedEmail: credentials["providerAccountEmailVerified"] === true
      ? stringField(credentials, "providerAccountEmail")
      : null,
    identityDisplayName: stringField(credentials, "providerAccountName"),
  };
  if (provider === "github") return {
    providerTenantId: providerAccountId,
    providerUserId: stringField(credentials, "githubUserId"),
    handle: stringField(credentials, "githubLogin"),
    verifiedEmail: stringField(credentials, "githubEmail"),
    identityDisplayName: stringField(credentials, "githubName"),
  };
  if (provider === "linear") return {
    providerTenantId: stringField(credentials, "organizationId") ?? providerAccountId,
    providerUserId: stringField(credentials, "authorizedUserId"),
    handle: null,
    verifiedEmail: stringField(credentials, "authorizedUserEmail"),
    identityDisplayName: stringField(credentials, "authorizedUserName"),
  };
  if (provider === "notion") return {
    providerTenantId: stringField(credentials, "notionWorkspaceId") ?? providerAccountId,
    providerUserId: stringField(credentials, "notionOwnerUserId"),
    handle: null,
    verifiedEmail: credentials["notionOwnerUserEmailVerified"] === true
      ? stringField(credentials, "notionOwnerUserEmail")
      : null,
    identityDisplayName: stringField(credentials, "notionOwnerUserName"),
  };
  if (provider === "granola") return {
    providerTenantId: stringField(credentials, "workspaceId") ?? providerAccountId,
    providerUserId: stringField(credentials, "userId") ?? stringField(credentials, "providerUserId"),
    handle: null,
    verifiedEmail: stringField(credentials, "verifiedEmail") ?? stringField(credentials, "userEmail"),
    identityDisplayName: stringField(credentials, "userName") ?? stringField(credentials, "providerAccountName"),
  };
  return {
    providerTenantId: stringField(credentials, "teamId") ?? providerAccountId.split(":")[0] ?? providerAccountId,
    providerUserId: stringField(credentials, "slackUserId") ?? providerAccountId.split(":")[1] ?? null,
    handle: null,
    verifiedEmail: null,
    identityDisplayName: null,
  };
}

function reconcileGoogleAccount(
  existing: StoredConnection | null,
  existingCredentials: Record<string, unknown>,
  incomingCredentials: Record<string, unknown>,
): {
  credentials: Record<string, unknown>;
  providerAccountId: string;
  displayName: string;
} {
  const providerAccountId = stringField(incomingCredentials, "providerAccountId");
  if (!providerAccountId) {
    throw new ApiError(502, "google_identity_missing", "Google did not return a stable account identity");
  }
  if (
    existing?.provider_account_id != null &&
    String(existing.provider_account_id) !== providerAccountId
  ) {
    throw new ApiError(
      409,
      "google_account_mismatch",
      "Reconnect with the same Google account originally used for this connection",
    );
  }
  const credentials = { ...existingCredentials, ...incomingCredentials, providerAccountId };
  if (!stringField(credentials, "refreshToken")) {
    throw new ApiError(
      502,
      "google_refresh_token_missing",
      "Google did not return offline access; reconnect and approve background access",
    );
  }
  const label =
    stringField(incomingCredentials, "providerAccountEmail") ??
    stringField(incomingCredentials, "providerAccountName") ??
    providerAccountId;
  return {
    credentials,
    providerAccountId,
    displayName: `Google · ${label}`.slice(0, 180),
  };
}

function googleConnectionDisplayName(capabilities: string[], accountDisplayName: string): string {
  const accountLabel = accountDisplayName.replace(/^Google · /u, "");
  const hasMailOrCalendar = capabilities.some((capability) =>
    capability.startsWith("gmail.") || capability.startsWith("calendar.")
  );
  const hasWorkspaceFiles = capabilities.some((capability) =>
    capability.startsWith("drive.") || capability.startsWith("docs.") || capability.startsWith("sheets.")
  );
  const product = hasMailOrCalendar && !hasWorkspaceFiles
    ? "Google Mail + Calendar"
    : hasWorkspaceFiles && !hasMailOrCalendar
      ? "Google Drive + Docs + Sheets"
      : "Google Workspace";
  return `${product} · ${accountLabel}`.slice(0, 180);
}

function googleProviderScopesForCapabilities(capabilities: string[]): string[] {
  return [...new Set(capabilities.flatMap((capability) => capabilityScopes[capability] ?? []))];
}

function assertGoogleCapabilitiesGranted(
  capabilities: string[],
  credentials: Record<string, unknown>,
): void {
  const rawScopes = credentials.scopes;
  const granted = new Set(
    Array.isArray(rawScopes)
      ? rawScopes.filter((scope): scope is string => typeof scope === "string")
      : [],
  );
  if (granted.size === 0) {
    throw new ApiError(
      502,
      "google_scope_response_missing",
      "Google did not report which connector permissions were granted; restart the connection",
    );
  }
  const missing = capabilities.filter((capability) => {
    const requiredScopes = capabilityScopes[capability];
    if (!requiredScopes || requiredScopes.length === 0) return true;
    return requiredScopes.some((requiredScope) =>
      !granted.has(requiredScope)
      && !(googleBroaderProviderScopeAliases[requiredScope] ?? []).some((alias) => granted.has(alias))
    );
  });
  if (missing.length > 0) {
    throw new ApiError(
      403,
      "google_scopes_not_granted",
      `Google access was not granted for: ${missing.join(", ")}. Restart the connection and approve those permissions.`,
    );
  }
}

function assertLinearCapabilitiesGranted(
  capabilities: string[],
  credentials: Record<string, unknown>,
): void {
  const granted = new Set(arrayField(credentials, "providerScopes"));
  if (granted.size === 0) {
    throw new ApiError(
      502,
      "linear_scope_response_missing",
      "Linear did not report which connector permissions were granted; restart the connection",
    );
  }
  const required = new Set([
    "read",
    ...capabilities.flatMap((capability) => providerCapabilityScopes.linear[capability] ?? []),
  ]);
  const missing = [...required].filter((scope) => !granted.has(scope));
  if (missing.length > 0) {
    throw new ApiError(
      403,
      "linear_scopes_not_granted",
      `Linear access was not granted for: ${missing.join(", ")}. Restart the connection and approve those permissions.`,
    );
  }
}

function assertLinearScopeCapabilities(scope: Scope, capabilities: string[]): void {
  if (scope === "personal" && capabilities.includes("linear.agent")) {
    throw new ApiError(
      422,
      "linear_agent_workspace_required",
      "Linear delegation and mentions require a workspace connection",
    );
  }
}

function assertSameLinearPersonalIdentity(
  existingCredentials: Record<string, unknown>,
  incomingCredentials: Record<string, unknown>,
): void {
  const incomingUserId = stringField(incomingCredentials, "authorizedUserId");
  if (!incomingUserId) {
    throw new ApiError(
      502,
      "connector_identity_missing",
      "Linear did not return the authorized personal user identity",
    );
  }
  const existingUserId = stringField(existingCredentials, "authorizedUserId");
  if (existingUserId && existingUserId !== incomingUserId) {
    throw new ApiError(
      409,
      "connector_account_mismatch",
      "Reconnect the same personal Linear user",
    );
  }
}

function assertSameLinearWorkspaceIdentity(
  existingCredentials: Record<string, unknown>,
  incomingCredentials: Record<string, unknown>,
): void {
  const incomingAppUserId = stringField(incomingCredentials, "appUserId");
  if (!incomingAppUserId) {
    throw new ApiError(
      502,
      "connector_identity_missing",
      "Linear did not return the authorized workspace app identity",
    );
  }
  const existingAppUserId = stringField(existingCredentials, "appUserId");
  if (existingAppUserId && existingAppUserId !== incomingAppUserId) {
    throw new ApiError(
      409,
      "connector_account_mismatch",
      "Reconnect the same Linear application identity",
    );
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /unique constraint failed|constraint_unique/iu.test(error.message);
}

function oauthAttemptIdValue(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : null;
}

function assertLinearNativeAgentCapabilityEnabled(
  capabilities: string[],
  env: Pick<Env, "LINEAR_NATIVE_AGENT_ENABLED">,
  runtimeStatus: "protocol_only" | "operational" | undefined = "protocol_only",
): void {
  if (!capabilities.includes("linear.agent")) return;
  if (runtimeStatus !== "operational") {
    throw new ApiError(
      409,
      "linear_native_agent_protocol_only",
      "Linear's native-agent protocol is implemented, but its coordinating Avalon runtime is not operational yet",
    );
  }
  if (!linearNativeAgentEnabled(env)) {
    throw new ApiError(
      409,
      "linear_native_agent_unavailable",
      "Linear delegation and mentions are still in preview and are not enabled for this Avalon environment",
    );
  }
}

export const __connectionServiceTesting = {
  attemptConnectorRepair,
  reconcileGoogleAccount,
  googleConnectionDisplayName,
  googleProviderScopesForCapabilities,
  assertGoogleCapabilitiesGranted,
  assertLinearCapabilitiesGranted,
  assertLinearScopeCapabilities,
  assertSameLinearPersonalIdentity,
  assertSameLinearWorkspaceIdentity,
  isUniqueConstraintError,
  normalizeOAuthErrorCode: normalizeConnectorOAuthErrorCode,
  oauthAttemptIdValue,
  assertLinearNativeAgentCapabilityEnabled,
};
