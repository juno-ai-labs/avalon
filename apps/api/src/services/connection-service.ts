import {
  ConnectorError,
  connectorCapabilitySupportsScope,
  createWebhookSecret,
  discoverGitHubConnectionRepositories,
  getGitHubInstallation,
  GoogleCapabilityScopes,
  LinearCapabilityScopes,
  SlackCapabilityScopes,
  verifyGenericWebhook,
  type ConnectorConnectionContext,
  type GitHubWebhookResourceDiscovery,
  type GitHubWebhookResourceHint,
} from "@avalon/connectors";
import type {
  Connection,
  CreateWebhookConnectionRequestSchema,
  Scope,
} from "@avalon/contracts";
import { newId, nowIso } from "@avalon/db";
import type { z } from "zod";
import type { AuthContext, Env } from "../env";
import { linearNativeAgentEnabled, numericEnv } from "../env";
import { ApiError } from "../lib/api-error";
import { connectionFromRow } from "../mappers/connection";
import { connectorRegistryForEnv, githubConnectorConfig } from "../lib/connector-registry";
import { decryptString, encryptString, openString, randomToken, sealString, sha256 } from "../lib/crypto";
import { durableObjectNamespaceForRegion } from "../lib/durable-object-namespace";
import { createGitHubInstallState } from "../lib/github-install-state";
import { LinearRoutingService } from "./linear-routing-service";
import { SlackRoutingService } from "./slack-routing-service";

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

interface StoredConnection extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  connector_type: string;
  scope: Scope;
  owner_user_id: string | null;
  model_plugin_id: string;
}

type OAuthConnectorProvider = "linear" | "notion" | "slack";

export interface GitHubSetupResult {
  url: string;
  workspaceId: string;
}

const providerCapabilityScopes: Record<OAuthConnectorProvider, Record<string, readonly string[]>> = {
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

export class ConnectionService {
  constructor(private readonly env: Env, private readonly auth?: AuthContext) {}

  async list(): Promise<Connection[]> {
    const auth = this.requireAuth();
    const result = await this.env.DB.prepare(
      `SELECT c.*, u.name AS owner_name FROM connector_connections c
       LEFT JOIN users u ON u.id = c.owner_user_id
       WHERE c.workspace_id = ? AND (c.scope = 'workspace' OR c.owner_user_id = ?)
       ORDER BY c.display_name COLLATE NOCASE`,
    ).bind(auth.workspaceId, auth.userId).all<Record<string, unknown>>();
    return (result.results ?? []).map(connectionFromRow);
  }

  async beginGoogle(input: {
    scope: Scope;
    capabilities: string[];
    connectionId?: string;
  }): Promise<{ url: string }> {
    const auth = this.requireAuth();
    this.assertScopeAllowed(input.scope);
    const capabilities = [...new Set(input.capabilities)];
    if (capabilities.length === 0 || capabilities.some((capability) => !capabilityScopes[capability])) {
      throw new ApiError(422, "invalid_google_capabilities", "Choose at least one supported Google capability");
    }
    const verifier = randomToken(64);
    const challenge = await sha256(verifier);
    const state = randomToken(32);
    const statePayload = await sealString(JSON.stringify({
      verifier,
      scope: input.scope,
      capabilities,
      connectionId: input.connectionId ?? null,
    }), this.env.OAUTH_STATE_ENCRYPTION_KEY);
    await this.env.DB.prepare(
      `INSERT INTO oauth_states
       (id, region, provider, purpose, code_verifier_encrypted, user_id, workspace_id,
        return_uri, expires_at)
       VALUES (?, ?, 'google', 'connector', ?, ?, ?, ?, ?)`,
    ).bind(state, this.env.AVALON_REGION, statePayload, auth.userId, auth.workspaceId, this.env.DESKTOP_DEEP_LINK_URI, new Date(Date.now() + 10 * 60_000).toISOString()).run();
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
    return { url: authorization.url };
  }

  async completeGoogle(code: string, state: string): Promise<string> {
    const row = await this.env.DB.prepare(
      `UPDATE oauth_states SET consumed_at = ?
       WHERE id = ? AND provider = 'google' AND purpose = 'connector' AND region = ?
         AND consumed_at IS NULL AND expires_at > ?
       RETURNING *`,
    ).bind(nowIso(), state, this.env.AVALON_REGION, nowIso()).first<Record<string, unknown>>();
    if (!row) throw new ApiError(401, "invalid_oauth_state", "Google authorization is invalid or expired");
    const stateData = JSON.parse(
      await openString(String(row.code_verifier_encrypted), this.env.OAUTH_STATE_ENCRYPTION_KEY),
    ) as { verifier: string; scope: Scope; capabilities: string[]; connectionId: string | null };
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
    if (stateData.connectionId) {
      const updated = await this.env.DB.prepare(
        `UPDATE connector_connections SET encrypted_credentials = ?, credential_iv = ?,
         credential_key_version = ?, granted_scopes_json = ?, provider_account_id = ?, display_name = ?,
         model_plugin_id = ?, status = 'healthy', error_json = NULL,
         next_poll_at = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND connector_type = 'google'
         RETURNING id`,
      ).bind(
        encrypted.ciphertext,
        encrypted.iv,
        Number(this.env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1),
        JSON.stringify(stateData.capabilities),
        account.providerAccountId,
        displayName,
        modelPluginId,
        at,
        at,
        connectionId,
        row.workspace_id,
      ).first<{ id: string }>();
      if (!updated) throw new ApiError(404, "connection_not_found", "Google connection not found");
    } else {
      await this.env.DB.prepare(
        `INSERT INTO connector_connections
         (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
          encrypted_credentials, credential_iv, credential_key_version, granted_scopes_json,
          model_plugin_id, status, cursor_json, config_json, next_poll_at, created_at, updated_at)
         VALUES (?, ?, 'google', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'healthy', '{}', '{}', ?, ?, ?)`,
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
        at,
        at,
        at,
      ).run();
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
    return redirect.toString();
  }

  async beginProvider(
    provider: OAuthConnectorProvider,
    input: { scope: Scope; capabilities: string[]; connectionId?: string },
  ): Promise<{ url: string }> {
    const auth = this.requireAuth();
    this.assertScopeAllowed(input.scope);
    const adapter = this.registry().get(provider);
    if (!adapter.manifest.supportedScopes.includes(input.scope)) {
      throw new ApiError(422, "invalid_connector_scope", `${adapter.manifest.displayName} does not support ${input.scope} connections`);
    }
    const supported = new Set(adapter.manifest.capabilities.map((capability) => capability.id));
    const capabilities = [...new Set(input.capabilities)];
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
    const state = randomToken(32);
    const statePayload = await sealString(JSON.stringify({
      provider,
      verifier,
      scope: input.scope,
      capabilities,
      connectionId: input.connectionId ?? null,
    }), this.env.OAUTH_STATE_ENCRYPTION_KEY);
    await this.env.DB.prepare(
      `INSERT INTO oauth_states
       (id, region, provider, purpose, code_verifier_encrypted, user_id, workspace_id,
        return_uri, expires_at)
       VALUES (?, ?, ?, 'connector', ?, ?, ?, ?, ?)`,
    ).bind(
      state,
      this.env.AVALON_REGION,
      provider,
      statePayload,
      auth.userId,
      auth.workspaceId,
      this.env.DESKTOP_DEEP_LINK_URI,
      new Date(Date.now() + 10 * 60_000).toISOString(),
    ).run();
    const authorization = await adapter.beginAuthorization?.({
      state,
      codeChallenge: challenge,
      connectionScope: input.scope,
      scopes: capabilities.flatMap((capability) => providerCapabilityScopes[provider][capability] ?? []),
    });
    if (!authorization) throw new ApiError(503, "connector_oauth_unavailable", `${adapter.manifest.displayName} authorization is unavailable`);
    return { url: authorization.url };
  }

  async beginGitHub(input: {
    scope: Scope;
    capabilities: string[];
    connectionId?: string;
  }): Promise<{ url: string }> {
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
    const statePayload = await sealString(JSON.stringify({
      provider: "github",
      scope: input.scope,
      capabilities,
      connectionId: input.connectionId ?? null,
    }), this.env.OAUTH_STATE_ENCRYPTION_KEY);
    await this.env.DB.prepare(
      `INSERT INTO oauth_states
       (id, region, provider, purpose, code_verifier_encrypted, user_id, workspace_id, return_uri, expires_at)
       VALUES (?, ?, 'github', 'github_install', ?, ?, ?, ?, ?)`,
    ).bind(
      state,
      this.env.AVALON_REGION,
      statePayload,
      auth.userId,
      auth.workspaceId,
      this.env.DESKTOP_DEEP_LINK_URI,
      new Date(Date.now() + 15 * 60_000).toISOString(),
    ).run();
    const url = new URL(`https://github.com/apps/${encodeURIComponent(this.env.GITHUB_APP_SLUG)}/installations/new`);
    url.searchParams.set("state", state);
    return { url: url.toString() };
  }

  async setupGitHub(installationId: string, state: string): Promise<GitHubSetupResult> {
    const installState = await this.consumeProviderState("github", state, "github_install");
    const stateData = JSON.parse(
      await openString(String(installState.code_verifier_encrypted), this.env.OAUTH_STATE_ENCRYPTION_KEY),
    ) as { provider: "github"; scope: Scope; capabilities: string[]; connectionId: string | null };
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
      new Date(Date.now() + 10 * 60_000).toISOString(),
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
    ) as { provider: "github"; verifier: string; installationId: string; scope: Scope; capabilities: string[]; connectionId: string | null };
    const adapter = this.registry().get("github");
    const incomingCredentials = await adapter.handleAuthorizationCallback?.({
      code,
      codeVerifier: stateData.verifier,
      installationId: stateData.installationId,
      connectionScope: stateData.scope,
    });
    if (!incomingCredentials) throw new ApiError(502, "github_token_exchange_failed", "GitHub did not return connector credentials");
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
      await this.env.DB.prepare(
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
      ).run();
    } else {
      await this.env.DB.prepare(
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
      ).run();
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
    return redirect.toString();
  }

  async completeProvider(provider: OAuthConnectorProvider, code: string, state: string): Promise<string> {
    const row = await this.consumeProviderState(provider, state, "connector");
    const stateData = JSON.parse(
      await openString(String(row.code_verifier_encrypted), this.env.OAUTH_STATE_ENCRYPTION_KEY),
    ) as { provider: OAuthConnectorProvider; verifier: string; scope: Scope; capabilities: string[]; connectionId: string | null };
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
    const grantedCapabilities = provider === "slack" && stateData.scope === "personal" && existing
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
      await this.env.DB.prepare(
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
        JSON.stringify({ region: this.env.AVALON_REGION, providerAccountId }),
        at,
        connectionId,
        row.workspace_id,
        provider,
      ).run();
    } else {
      try {
        await this.env.DB.prepare(
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
          JSON.stringify({ region: this.env.AVALON_REGION, providerAccountId }),
          at,
          at,
        ).run();
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
    if (provider === "linear" && stateData.scope === "workspace") {
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
    return redirect.toString();
  }

  async reconnect(id: string): Promise<{ url: string }> {
    const connection = await this.loadAuthorized(id);
    if (connection.connector_type === "google") {
      return this.beginGoogle({
        scope: connection.scope,
        capabilities: parseJson(connection.granted_scopes_json, []),
        connectionId: id,
      });
    }
    if (connection.connector_type === "linear" || connection.connector_type === "notion" || connection.connector_type === "slack") {
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
    const before = JSON.stringify(context.credentials);
    let result: { ok: boolean; message: string; reconnectRequired?: boolean };
    try {
      result = await this.registry().get(connection.connector_type).healthCheck(context);
    } catch (error) {
      if (!(error instanceof ConnectorError) || error.code !== "unauthorized") throw error;
      result = { ok: false, message: error.message, reconnectRequired: true };
    }
    if (result.ok && connection.connector_type === "linear" && connection.scope === "workspace") {
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
    if (JSON.stringify(context.credentials) !== before) {
      await this.persistCredentials(connection, context.credentials);
    }
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
    const sibling =
      connection.connector_type === "google" && typeof connection.provider_account_id === "string"
        ? await this.env.DB.prepare(
            `SELECT id FROM connector_connections
             WHERE connector_type = 'google' AND provider_account_id = ?
               AND id != ? AND status != 'disabled' LIMIT 1`,
          ).bind(connection.provider_account_id, connection.id).first<{ id: string }>()
        : null;
    const mayRevokeRemotely =
      connection.connector_type !== "google" ||
      (typeof connection.provider_account_id === "string" && !sibling);
    let remoteRevocation: "skipped" | "succeeded" | "failed" = "skipped";
    try {
      if (mayRevokeRemotely && adapter.revoke) {
        await adapter.revoke(await this.context(connection), AbortSignal.timeout(15_000));
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
      if (
        connection.connector_type === "linear"
        && connection.scope === "workspace"
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
          console.warn("Linear route deactivation failed", {
            region: this.env.AVALON_REGION,
            connection_id: connection.id,
            reason: error instanceof Error ? error.message : "unknown route error",
          });
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
          console.warn("Slack route deactivation failed", {
            region: this.env.AVALON_REGION,
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
    const id = newId();
    const secret = createWebhookSecret();
    const encrypted = await encryptString(
      JSON.stringify({ signingSecret: secret }),
      this.env.CONNECTOR_CREDENTIALS_KEY,
      id,
    );
    const at = nowIso();
    const modelPluginId = await this.allocateModelPluginId(auth.workspaceId, "generic_webhook");
    await this.env.DB.prepare(
      `INSERT INTO connector_connections
       (id, workspace_id, connector_type, scope, owner_user_id, display_name,
        encrypted_credentials, credential_iv, credential_key_version, granted_scopes_json,
        model_plugin_id, status, cursor_json, config_json, created_at, updated_at)
       VALUES (?, ?, 'generic_webhook', ?, ?, ?, ?, ?, ?, '[]', ?, 'healthy', '{}', ?, ?, ?)`,
    ).bind(id, auth.workspaceId, input.scope, input.scope === "personal" ? auth.userId : null, input.displayName, encrypted.ciphertext, encrypted.iv, Number(this.env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1), modelPluginId, JSON.stringify({ eventTypes: input.eventTypes }), at, at).run();
    await this.recordConnectionAudit(auth.workspaceId, auth.userId, "connector.authorized", id, {
      provider: "generic_webhook", scope: input.scope, eventTypes: input.eventTypes,
    });
    return {
      connection: (await this.list()).find((item) => item.id === id),
      endpoint: new URL(`/ingest/webhook/${id}`, this.env.PUBLIC_API_BASE_URL).toString(),
      signingSecret: secret,
      signatureFormat: "t=<unix-seconds>,v1=<hex-hmac-sha256(t.raw-body)>",
    };
  }

  async ingestWebhook(connectionId: string, rawBody: string, signatureHeader: string | null) {
    if (rawBody.length > numericEnv(this.env, "WEB_FETCH_MAX_BYTES", 2_000_000)) {
      throw new ApiError(413, "webhook_too_large", "Webhook payload exceeds the configured limit");
    }
    const connection = await this.env.DB.prepare(
      `SELECT * FROM connector_connections WHERE id = ? AND connector_type = 'generic_webhook' AND status = 'healthy'`,
    ).bind(connectionId).first<StoredConnection>();
    if (!connection) throw new ApiError(404, "connection_not_found", "Webhook connection not found");
    const context = await this.context(connection);
    const signingSecret = String(context.credentials.signingSecret ?? "");
    const verified = await verifyGenericWebhook({
      secret: signingSecret,
      signatureHeader,
      body: rawBody,
      replayWindowSeconds: numericEnv(this.env, "WEBHOOK_REPLAY_WINDOW_SECONDS", 300),
    });
    const receiptId = newId();
    const event = verified.event;
    const dedupeKey = stringField(event, "dedupe_key") ?? stringField(event, "id") ?? verified.signatureHash;
    const providerEventId = stringField(event, "provider_event_id") ?? stringField(event, "id") ?? dedupeKey;
    const occurredAt = validDateField(event, "occurred_at") ?? nowIso();
    const payloadKey = `${this.env.AVALON_REGION}/${connection.workspace_id}/activities/webhook-${verified.signatureHash}.json`;
    await this.env.PAYLOADS.put(payloadKey, rawBody, { httpMetadata: { contentType: "application/json" } });
    const activityId = newId();
    const eventType = stringField(event, "event_type") ?? "webhook.received";
    const receivedAt = nowIso();
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO webhook_receipts (id, connection_id, signature_hash, received_at, expires_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(connection_id, signature_hash) DO NOTHING`,
      ).bind(receiptId, connectionId, verified.signatureHash, receivedAt, new Date(Date.now() + 24 * 60 * 60_000).toISOString()),
      this.env.DB.prepare(
        `INSERT INTO activities
         (id, workspace_id, connection_id, connection_scope, connection_owner_user_id,
          provider, provider_event_id, event_type, resource_type, provider_resource_id,
          actor_json, subject_json, occurred_at, received_at, title, summary, text_snippet,
          payload_ref, visibility_json, entity_keys_json, dedupe_key, raw_content_hash,
          processing_status, metadata_json)
         VALUES (?, ?, ?, ?, ?, 'generic_webhook', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        activityId,
        connection.workspace_id,
        connection.id,
        connection.scope,
        connection.owner_user_id,
        providerEventId,
        eventType,
        stringField(event, "resource_type"),
        stringField(event, "provider_resource_id"),
        JSON.stringify(recordField(event, "actor")),
        JSON.stringify(recordField(event, "subject")),
        occurredAt,
        receivedAt,
        stringField(event, "title") ?? "Webhook event received",
        stringField(event, "summary") ?? "",
        (stringField(event, "text") ?? stringField(event, "text_snippet") ?? "").slice(0, 4_000),
        payloadKey,
        JSON.stringify({ scope: connection.scope, ownerUserId: connection.owner_user_id }),
        JSON.stringify(arrayField(event, "entity_keys")),
        dedupeKey,
        await sha256(rawBody),
        JSON.stringify(recordField(event, "metadata")),
      ),
    ]);
    const insertedActivity = Number(results[1]?.meta.changes ?? 0) > 0;
    const canonical = insertedActivity
      ? { id: activityId }
      : await this.env.DB.prepare(
          `SELECT id FROM activities WHERE connection_id = ?
           AND (dedupe_key = ? OR (provider_event_id = ? AND event_type = ?))
           ORDER BY received_at DESC LIMIT 1`,
        ).bind(connectionId, dedupeKey, providerEventId, eventType).first<{ id: string }>();
    if (!canonical) throw new ApiError(500, "webhook_activity_write_failed", "The webhook activity could not be stored");
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

  private registry() {
    return connectorRegistryForEnv(this.env);
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
      credentials = JSON.parse(await decryptString(
        row.encrypted_credentials,
        row.credential_iv,
        this.env.CONNECTOR_CREDENTIALS_KEY,
        row.id,
      )) as Record<string, unknown>;
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
function validDateField(record: Record<string, unknown>, key: string): string | null {
  const value = stringField(record, key);
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function arrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
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
  const scopes = new Set(capabilities.flatMap((capability) => capabilityScopes[capability] ?? []));
  if (scopes.has("https://www.googleapis.com/auth/gmail.compose")) {
    scopes.delete("https://www.googleapis.com/auth/gmail.send");
  }
  if (scopes.has("https://www.googleapis.com/auth/calendar.events")) {
    scopes.delete("https://www.googleapis.com/auth/calendar.events.readonly");
  }
  if (scopes.has("https://www.googleapis.com/auth/documents")) {
    scopes.delete("https://www.googleapis.com/auth/documents.readonly");
  }
  if (scopes.has("https://www.googleapis.com/auth/spreadsheets")) {
    scopes.delete("https://www.googleapis.com/auth/spreadsheets.readonly");
  }
  return [...scopes];
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
  const has = (...scopes: string[]) => scopes.some((scope) => granted.has(scope));
  const allAccess = "https://mail.google.com/";
  const capabilityGranted: Record<string, boolean> = {
    "gmail.read": has(
      GoogleCapabilityScopes.gmailRead[0],
      "https://www.googleapis.com/auth/gmail.modify",
      allAccess,
    ),
    "gmail.draft": has(
      GoogleCapabilityScopes.gmailDraft[0],
      "https://www.googleapis.com/auth/gmail.modify",
      allAccess,
    ),
    "gmail.send": has(
      GoogleCapabilityScopes.gmailSend[0],
      GoogleCapabilityScopes.gmailDraft[0],
      "https://www.googleapis.com/auth/gmail.modify",
      allAccess,
    ),
    "calendar.read": has(
      GoogleCapabilityScopes.calendarRead[0],
      GoogleCapabilityScopes.calendarWrite[0],
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar",
    ),
    "calendar.write": has(
      GoogleCapabilityScopes.calendarWrite[0],
      "https://www.googleapis.com/auth/calendar",
    ),
    "drive.read": has(
      GoogleCapabilityScopes.driveRead[0],
      "https://www.googleapis.com/auth/drive",
    ),
    "docs.read": has(
      GoogleCapabilityScopes.docsRead[0],
      GoogleCapabilityScopes.docsWrite[0],
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/drive",
    ),
    "docs.write": has(
      GoogleCapabilityScopes.docsWrite[0],
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/drive",
    ),
    "sheets.read": has(
      GoogleCapabilityScopes.sheetsRead[0],
      GoogleCapabilityScopes.sheetsWrite[0],
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/drive",
    ),
    "sheets.write": has(
      GoogleCapabilityScopes.sheetsWrite[0],
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/drive",
    ),
  };
  const missing = capabilities.filter((capability) => !capabilityGranted[capability]);
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
  reconcileGoogleAccount,
  googleConnectionDisplayName,
  googleProviderScopesForCapabilities,
  assertGoogleCapabilitiesGranted,
  assertLinearCapabilitiesGranted,
  assertLinearScopeCapabilities,
  assertSameLinearPersonalIdentity,
  assertSameLinearWorkspaceIdentity,
  isUniqueConstraintError,
  assertLinearNativeAgentCapabilityEnabled,
};
