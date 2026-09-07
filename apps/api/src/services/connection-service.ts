import { teammatesFromCalendarPage } from './onboarding-teammates';
import type { DiscoverOnboardingTeammates } from '@rally/contracts';
import { RALLY_HEADERS } from "@rally/contracts/http-headers";
import {
  CUSTOM_MCP_CONNECTOR_TYPE,
  ConnectorError,
  CustomMcpCapabilities,
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
  githubRepositoryAccessPolicy,
  listCustomMcpToolInventory,
  type AuthorizedConnectorConnection,
  type ConnectorConnectionContext,
  type GitHubWebhookResourceDiscovery,
  type GitHubWebhookResourceHint,
  type ResolvedConnectorAdapter,
  type VerifiedGranolaWebhook,
} from "@rally/connectors";
import type {
  Connection,
  ConnectorOAuthAttempt,
  ConnectorOAuthProvider,
  ConnectorOAuthStart,
  CreateCustomMcpConnectionRequestSchema,
  CreateWebhookConnectionRequestSchema,
  CustomMcpConnectionSettings,
  CustomMcpToolPolicy,
  GitHubRepositoryAccessSettings,
  UpdateGitHubRepositoryAccessSettings,
  Scope,
} from "@rally/contracts";
import { CustomMcpConnectionConfigSchema, asUserId, asWorkspaceId } from "@rally/contracts";
import { addWorkspaceTarget } from "@rally/contracts/workspace-target";
import { newId, nowIso } from "@rally/db";
import type { z } from "zod";
import type { AuthContext, Env, IdentityAuthContext } from "../env";
import { apiTelemetryEnvelope, emitAuthenticatedApiTelemetry } from "../telemetry/api-emitter";
import { linearNativeAgentEnabled, numericEnv } from "../env";
import { ApiError } from "../lib/api-error";
import { connectionFromRow } from "../mappers/connection";
import {
  connectorRegistryForEnv,
  githubConnectorConfig,
  xConnectorConfig,
} from "../lib/connector-registry";
import { encryptString, openString, randomToken, sealString, sha256 } from "../lib/crypto";
import {
  compatibleDesktopDeepLink,
  connectorAttemptTarget,
  normalizeConnectorOAuthErrorCode,
  type ConnectorAttemptTargetInput,
  unknownConnectorAttemptFailureTarget,
} from "../lib/desktop-handoff";
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
import {
  emitProductUsageTelemetry,
  telemetryCountBucket,
  telemetryJourneyDuration,
} from "../telemetry/product-usage";
import { publishWorkspaceSync } from "./workspace-realtime-service";
import { persistNormalizedActivity } from "./normalized-activity-service";
import { refreshWorkspaceSchedule } from "./workstream-wakeup-service";
import {
  withWorkspaceRuntimeDatabase,
  workspaceRegionalDatabase,
} from "./workspace-runtime-database";
import { workspaceDOName } from "../durable-objects/names";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import {
  WorkspaceConnectorOAuthAttemptFinishResultSchema,
  WorkspaceConnectorOAuthAttemptReadResultSchema,
  WorkspaceWebhookReceiptClaimResultSchema,
  type WorkspaceConnectorOAuthAttempt,
} from "../durable-objects/workspace-connections-protocol";

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

async function publishConnectorWorkspaceSync(env: Env, workspaceId: string): Promise<void> {
  try {
    await publishWorkspaceSync(env, workspaceId, [
      "connector_connections",
      "resources",
      "automations",
      "digest_schedule",
    ]);
  } catch (error) {
    // Connector authorization is already committed and must not be reported as
    // failed merely because a hibernating sync object was briefly unavailable.
    // Reconnect returns a full workspace invalidation; this warning identifies
    // the live-update gap for operators.
    logWarn(env, "connector_workspace_sync_publish_failed", {
      workspace_id: workspaceId,
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
}

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
  status?: string;
  encrypted_credentials?: string | null;
  credential_iv?: string | null;
  credential_key_version?: number;
}

interface ConnectorIngressRouteSource {
  id: string;
  workspace_id: string;
  connector_type: string;
  scope: Scope;
  provider_account_id: string | null;
  status: string;
  config_json: string;
  updated_at: string;
}

function connectorIngressRouteValues(
  connection: ConnectorIngressRouteSource,
  region: "global" | "eu",
) {
  const config = parseJson<Record<string, unknown>>(connection.config_json, {});
  const providerUserId = typeof config.providerUserId === "string"
    ? config.providerUserId
    : typeof config.githubUserId === "string" ? config.githubUserId : null;
  return {
    connectionId: connection.id,
    workspaceId: connection.workspace_id,
    region,
    connectorType: connection.connector_type,
    scope: connection.scope,
    providerAccountId: connection.provider_account_id,
    providerUserId,
    status: connection.status === "disabled" ? "disabled" as const : "active" as const,
    updatedAt: connection.updated_at,
  };
}

type OAuthConnectorProvider = Exclude<ConnectorOAuthProvider, "google" | "github">;

/** What a custom MCP authorization carries from its start to its callback. */
interface CustomMcpStartConfiguration {
  serverUrl: string;
  displayName: string;
  toolPolicy: CustomMcpToolPolicy;
}

/**
 * The stored form of a configured endpoint.
 *
 * One normalization, at every entry, so the string a reconnect matches against
 * and the string the adapter dials are the same one — `https://a.example/mcp`
 * and `https://a.example:443/mcp` are the same server and must not read as two.
 */
function normalizeCustomMcpServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(422, "invalid_connector_configuration", "The MCP server URL is not a valid URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new ApiError(
      422,
      "invalid_connector_configuration",
      "An MCP server URL must use HTTPS and carry no embedded credentials",
    );
  }
  return url.toString();
}

/** What a person is told when their server refused the first connection. */
function customMcpUnreachable(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(422, "custom_mcp_unreachable", `Rally could not use this MCP server: ${connectorFailureMessage(error)}`);
}

/**
 * A provider's own words on their way to a person's screen.
 *
 * Stripped as well as bounded: a JSON-RPC error message is remote text, and
 * the connections screen renders it beside Rally's own prose, so control and
 * bidi characters in it could reorder what a person reads.
 */
function connectorFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim().slice(0, 500);
}

const TELEMETRY_CONNECTOR_TYPES = new Set([
  "custom_mcp", "generic_webhook", "github", "google", "granola", "linear", "notion", "slack", "x",
]);

type TelemetryConnectorType =
  "custom_mcp" | "generic_webhook" | "github" | "google" | "granola" | "linear" | "notion" | "slack" | "x";

function telemetryConnector(value: unknown): TelemetryConnectorType | null {
  const connector = String(value);
  return TELEMETRY_CONNECTOR_TYPES.has(connector) ? connector as TelemetryConnectorType : null;
}

function telemetryConnectionHealth(value: unknown): "healthy" | "needs_reconnect" | "error" | "disabled" | "unknown" {
  const status = String(value);
  if (status === "healthy" || status === "needs_reconnect" || status === "error" || status === "disabled") return status;
  return "unknown";
}

export interface GitHubSetupResult {
  url: string;
  workspaceId: string;
}

const providerCapabilityScopes: Record<OAuthConnectorProvider, Record<string, readonly string[]>> = {
  // A configured server publishes its own scopes through protected-resource
  // metadata, and Rally asks for exactly those. There is no Rally-authored
  // scope vocabulary to map a capability onto here.
  custom_mcp: {
    [CustomMcpCapabilities.tools]: [],
  },
  granola: {
    [GranolaCapabilities.personalRead]: ["mcp", "offline_access"],
    [GranolaCapabilities.workspaceRead]: [],
  },
  linear: LinearCapabilityScopes,
  notion: {
    "notion.personal.mcp": ["default"],
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
  private env: Env;
  private readonly auth: AuthContext | undefined;

  constructor(env: Env, auth?: AuthContext) {
    this.env = auth ? withWorkspaceRuntimeDatabase(env, auth.workspaceId) : env;
    this.auth = auth;
  }

  private async emitConnectorAction(
    connection: StoredConnection,
    action: "test" | "reconnect" | "disconnect" | "secret_rotate",
    previousHealth: ReturnType<typeof telemetryConnectionHealth>,
    appliedHealth: ReturnType<typeof telemetryConnectionHealth>,
    result: "success" | "failed",
  ): Promise<void> {
    const connector = telemetryConnector(connection.connector_type);
    const auth = this.requireAuth();
    if (!connector) return;
    await emitProductUsageTelemetry(this.env, {
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      name: "connector_action_completed",
      properties: {
        connectorId: connection.id,
        connector,
        scope: connection.scope,
        action,
        previousHealth,
        appliedHealth,
        result,
      },
      operationId: connection.id,
      eventId: newId(),
    });
    if (previousHealth !== appliedHealth) {
      await emitProductUsageTelemetry(this.env, {
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        name: "connector_health_changed",
        properties: {
          connectorId: connection.id,
          connector,
          scope: connection.scope,
          previousHealth,
          appliedHealth,
          cause: action === "reconnect" ? "reconnect" : "user_action",
        },
        operationId: connection.id,
        eventId: newId(),
      });
    }
  }

  private async emitConnectorSetupCompleted(
    connection: StoredConnection,
    method: "oauth" | "api_key" | "direct" | "webhook",
    durationMs: number,
    reconnect: boolean,
  ): Promise<void> {
    const connector = telemetryConnector(connection.connector_type);
    const auth = this.requireAuth();
    if (!connector) return;
    await emitProductUsageTelemetry(this.env, {
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      name: "connector_setup_completed_v2",
      properties: {
        connector,
        scope: connection.scope,
        method,
        result: "success",
        duration: telemetryJourneyDuration(durationMs),
        capabilityCount: telemetryCountBucket(parseJson(connection.granted_scopes_json, []).length),
        reconnect,
      },
      operationId: connection.id,
      eventId: newId(),
    });
  }

  availableConnectorTypes(): string[] {
    this.requireAuth();
    return this.registry().list().map((manifest) => manifest.type).sort();
  }

  async list(): Promise<Connection[]> {
    const auth = this.requireAuth();
    const result = await this.env.DB.prepare(
      `SELECT c.* FROM connector_connections c
       WHERE c.workspace_id = ? AND (c.scope = 'workspace' OR c.owner_user_id = ?)
       ORDER BY c.display_name COLLATE NOCASE`,
    ).bind(auth.workspaceId, auth.userId).all<Record<string, unknown>>();
    const rows = result.results ?? [];
    const ownerIds = [...new Set(rows.flatMap((row) =>
      typeof row.owner_user_id === "string" ? [row.owner_user_id] : []))];
    const owners = ownerIds.length === 0 ? [] : (await workspaceRegionalDatabase(this.env).prepare(
      `SELECT id, name FROM users WHERE id IN (${ownerIds.map(() => "?").join(",")})`,
    ).bind(...ownerIds).all<{ id: string; name: string }>()).results;
    const ownerNames = new Map(owners.map((owner) => [owner.id, owner.name]));
    const userDelivery = await resolveUserDelivery(
      this.env,
      { workspaceId: auth.workspaceId, userId: auth.userId },
      rows.map((row) => ({ id: String(row.id), connector_type: row.connector_type, status: row.status })),
    );
    return rows.map((row) => connectionFromRow({
      ...row,
      owner_name: typeof row.owner_user_id === "string"
        ? ownerNames.get(row.owner_user_id) ?? null
        : null,
    }, userDelivery.get(String(row.id)) ?? null));
  }

  async getGitHubRepositoryAccess(id: string): Promise<GitHubRepositoryAccessSettings> {
    const connection = await this.loadVisible(id);
    if (connection.connector_type !== "github") {
      throw new ApiError(422, "connector_settings_unsupported", "This connector does not provide repository access settings");
    }
    this.assertConnectionEnabled(connection);
    return this.loadGitHubRepositoryAccessSettings(connection);
  }

  async updateGitHubRepositoryAccess(
    id: string,
    input: UpdateGitHubRepositoryAccessSettings,
  ): Promise<GitHubRepositoryAccessSettings> {
    const connection = await this.loadAuthorized(id);
    if (connection.connector_type !== "github") {
      throw new ApiError(422, "connector_settings_unsupported", "This connector does not provide repository access settings");
    }
    this.assertConnectionEnabled(connection);
    const current = await this.loadGitHubRepositoryAccessSettings(connection);
    if (current.revision !== input.expectedRevision) {
      throw new ApiError(409, "github_repository_access_revision_conflict", "GitHub repository access changed. Reload these settings and apply your changes to the current revision.");
    }
    const available = new Map(current.availableRepositories.map((repository) => [
      `${repository.repositoryId}:${repository.repositoryFullName.toLowerCase()}`,
      repository,
    ]));
    const seenIds = new Set<string>();
    const seenNames = new Set<string>();
    for (const repository of input.repositories) {
      const normalizedName = repository.repositoryFullName.toLowerCase();
      if (seenIds.has(repository.repositoryId) || seenNames.has(normalizedName)) {
        throw new ApiError(422, "github_repository_access_duplicate", "Each configured GitHub repository must appear exactly once.");
      }
      seenIds.add(repository.repositoryId);
      seenNames.add(normalizedName);
      if (!available.has(`${repository.repositoryId}:${normalizedName}`)) {
        throw new ApiError(422, "github_repository_identity_changed", `${repository.repositoryFullName} is no longer available with the approved repository identity. Reload GitHub settings and choose it again.`);
      }
    }
    const nextRevision = current.revision + 1;
    const updatedAt = nowIso();
    const nextPolicy = {
      version: 1 as const,
      revision: nextRevision,
      mode: input.mode,
      defaultAccess: input.defaultRemoteAccess,
      repositories: input.repositories.map((repository) => ({
        repositoryId: repository.repositoryId,
        repositoryFullName: repository.repositoryFullName,
        access: repository.remoteAccess,
      })),
    };
    const nextPolicyJson = JSON.stringify(nextPolicy);
    const update = await this.env.DB.prepare(
        `UPDATE connector_connections
            SET config_json = json_set(COALESCE(config_json, '{}'), '$.githubRepositoryAccess', json(?)),
                updated_at = ?
          WHERE id = ? AND workspace_id = ? AND connector_type = 'github' AND status <> 'disabled'
            AND COALESCE(CAST(json_extract(config_json, '$.githubRepositoryAccess.revision') AS INTEGER), 0) = ?
          RETURNING id`,
      ).bind(
        nextPolicyJson,
        updatedAt,
        connection.id,
        connection.workspace_id,
        input.expectedRevision,
      ).first<{ id: string }>();
    if (!update || update.id !== connection.id) {
      throw new ApiError(409, "github_repository_access_revision_conflict", "GitHub repository access changed. Reload these settings and apply your changes to the current revision.");
    }
    // No compensating write follows. The policy row above is the whole change:
    // a Terminal repository selection is object-local provenance, not a copy
    // of connector authority, and every bootstrap rechecks this WorkspaceDO
    // row — so a narrowed policy takes effect on next use without a fan-out
    // write to every SubstreamAgent. The rollback that used to live here
    // existed only to undo this row when that fan-out failed.
    await this.recordConnectionAudit(
      connection.workspace_id,
      this.requireAuth().userId,
      "connector.github_repository_access.updated",
      connection.id,
      {
        revision: nextRevision,
        mode: input.mode,
        defaultRemoteAccess: input.defaultRemoteAccess,
        repositoryCount: input.repositories.length,
      },
    );
    return {
      ...current,
      revision: nextRevision,
      mode: input.mode,
      defaultRemoteAccess: input.defaultRemoteAccess,
      repositories: input.repositories,
      availableRepositories: current.availableRepositories.map((repository) => ({
        ...repository,
        remoteAccess: input.repositories.find((candidate) => (
          candidate.repositoryId === repository.repositoryId
        ))?.remoteAccess ?? (input.mode === "all_repositories" ? input.defaultRemoteAccess : null),
      })),
    };
  }

  async bindOAuthTelemetry(attemptId: string, operationId: string, eventVersion: 1 | 2): Promise<void> {
    // Best-effort exactly as before: a bind refused by the operation-id unique
    // index, or an attempt id that never started, must not fail the OAuth
    // start it decorates. The facade statement swallowed with
    // `.catch(() => undefined)` on a call that needed nothing but the attempt
    // id; the typed call has to resolve a workspace first, so `requireAuth()`
    // is inside the swallow too — otherwise this decoration could fail a start
    // that already committed, which is the one thing the contract forbids.
    try {
      const workspaceId = this.requireAuth().workspaceId;
      await (await this.workspaceObject(workspaceId)).bindConnectorOAuthAttemptTelemetry({
        workspaceId,
        attemptId,
        region: this.env.AVALON_REGION,
        operationId,
        eventVersion,
        at: nowIso(),
      });
    } catch (error) {
      // Telemetry decoration only; the OAuth start it labels already stands.
      // Logged rather than dropped: from here the benign refusal (a second bind
      // losing to the operation-id unique index) and a structural one (a schema
      // mismatch after a deploy, an unreachable object) look identical, and
      // silently missing telemetry is the failure nobody goes looking for.
      logWarn(this.env, "connector_oauth_attempt_telemetry_bind_failed", {
        attempt_id: attemptId,
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  async beginGoogle(input: {
    scope: Scope;
    capabilities: string[];
    connectionId?: string;
    desktopHandoffVersion: 1 | 2;
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
      scope: input.scope,
      capabilityCount: capabilities.length,
      reconnect: input.connectionId !== undefined,
      desktopHandoffVersion: input.desktopHandoffVersion,
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
    if (attemptId) await this.finishOAuthAttempt(String(row.workspace_id), attemptId, "succeeded", { connectionId });
    await publishConnectorWorkspaceSync(this.env, String(row.workspace_id));
    return this.connectorAttemptTarget({
      provider: "google",
      status: "succeeded",
      ...(attemptId ? { attemptId } : {}),
      connectionId,
      workspaceId: String(row.workspace_id),
      returnUri: String(row.return_uri),
    });
  }

  async beginProvider(
    provider: OAuthConnectorProvider,
    input: {
      scope: Scope;
      capabilities: string[];
      connectionId?: string;
      desktopHandoffVersion: 1 | 2;
      /**
       * The connection-level configuration a custom MCP authorization needs.
       *
       * It travels through the sealed OAuth state rather than being written
       * before consent, so an abandoned authorization leaves no half-made
       * connection, and a callback cannot be pointed at a different server
       * than the one the person approved.
       */
      customMcp?: CustomMcpStartConfiguration;
    },
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
    if (provider === "custom_mcp" && !input.customMcp) {
      throw new ApiError(422, "invalid_connector_configuration", "A custom MCP authorization needs its server URL");
    }
    const authorization = await adapter.beginAuthorization?.({
      state,
      codeChallenge: challenge,
      connectionScope: input.scope,
      scopes: capabilities.flatMap((capability) => providerCapabilityScopes[provider][capability] ?? []),
      ...(input.customMcp ? { serverUrl: input.customMcp.serverUrl } : {}),
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
      customMcp: input.customMcp ?? null,
    }), this.env.OAUTH_STATE_ENCRYPTION_KEY);
    await this.persistOAuthStart({
      attemptId,
      provider,
      state,
      statePayload,
      auth,
      expiresAt,
      scope: input.scope,
      capabilityCount: capabilities.length,
      reconnect: input.connectionId !== undefined,
      desktopHandoffVersion: input.desktopHandoffVersion,
    });
    return { url: authorization.url, attemptId };
  }

  async beginGitHub(input: {
    scope: Scope;
    capabilities: string[];
    connectionId?: string;
    desktopHandoffVersion: 1 | 2;
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
      throw new ApiError(503, "github_app_unavailable", "The Rally GitHub App is not configured");
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
      scope: input.scope,
      capabilityCount: capabilities.length,
      reconnect: input.connectionId !== undefined,
      desktopHandoffVersion: input.desktopHandoffVersion,
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
    if (attemptId) await this.extendOAuthAttempt(String(installState.workspace_id), attemptId, oauthExpiresAt);
    const config = githubConnectorConfig(this.env);
    if (!config) throw new ApiError(503, "github_app_unavailable", "The Rally GitHub App is not configured");
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
    if (attemptId) await this.finishOAuthAttempt(String(row.workspace_id), attemptId, "succeeded", { connectionId });
    await publishConnectorWorkspaceSync(this.env, String(row.workspace_id));
    return this.connectorAttemptTarget({
      provider: "github",
      status: "succeeded",
      ...(attemptId ? { attemptId } : {}),
      connectionId,
      workspaceId: String(row.workspace_id),
      returnUri: String(row.return_uri),
    });
  }

  async completeProvider(provider: OAuthConnectorProvider, code: string, state: string): Promise<string> {
    const row = await this.consumeProviderState(provider, state, "connector");
    const stateData = JSON.parse(
      await openString(String(row.code_verifier_encrypted), this.env.OAUTH_STATE_ENCRYPTION_KEY),
    ) as {
      provider: OAuthConnectorProvider;
      attemptId?: unknown;
      verifier: string;
      scope: Scope;
      capabilities: string[];
      connectionId: string | null;
      authorizationState?: unknown;
      customMcp?: CustomMcpStartConfiguration | null;
    };
    const attemptId = oauthAttemptIdValue(stateData.attemptId);
    if (stateData.provider !== provider) throw new ApiError(401, "invalid_oauth_state", "The connector provider does not match this authorization");
    await this.assertOAuthStatePrincipalAllowed(row, stateData.scope);
    const adapter = this.registry().get(provider);
    if (!adapter.manifest.supportedScopes.includes(stateData.scope)) {
      throw new ApiError(422, "invalid_connector_scope", `${adapter.manifest.displayName} no longer supports ${stateData.scope} connections`);
    }
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
          throw new ApiError(409, "slack_workspace_already_connected", "This Slack workspace is already connected to another Rally workspace");
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
    // A custom server has no provider account to name a connection after, so
    // the name is the one the person typed, kept verbatim the way an inbound
    // webhook's is. Every other connector still reads as "<Provider> · <account>".
    const customMcp = provider === "custom_mcp"
      ? this.customMcpCompletionConfiguration(stateData.customMcp ?? null, existing)
      : null;
    const displayName = customMcp
      ? customMcp.displayName.slice(0, 180)
      : `${adapter.manifest.displayName} · ${label}`.slice(0, 180);
    if (customMcp && providerAccountId !== customMcp.serverUrl) {
      throw new ApiError(
        409,
        "custom_mcp_server_mismatch",
        "The authorization completed against a different MCP server than the one requested",
      );
    }
    const connectorConfig = {
      region: this.env.AVALON_REGION,
      ...verifiedIdentityConfig(provider, credentials, providerAccountId),
      ...(customMcp
        ? {
            serverUrl: customMcp.serverUrl,
            authMode: "oauth" as const,
            toolPolicy: customMcp.toolPolicy,
          }
        : {}),
    };
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
        JSON.stringify(connectorConfig),
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
          JSON.stringify(connectorConfig),
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
        await publishConnectorWorkspaceSync(this.env, String(row.workspace_id));
        throw error;
      }
    }
    if (provider === "notion" && stateData.scope === "workspace") {
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
        await publishConnectorWorkspaceSync(this.env, String(row.workspace_id));
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
        await publishConnectorWorkspaceSync(this.env, String(row.workspace_id));
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
    if (customMcp) {
      // The header path proves the server before it keeps the row, and an
      // authorized one has to make the same promise: a token exchange says
      // nothing about whether the MCP endpoint answers, speaks a protocol
      // Rally negotiates, or offers a tool this connection's policy admits.
      // Unproven, the desktop reports success and the failure surfaces days
      // later inside somebody's run.
      //
      // The row is kept and marked rather than deleted, unlike the header
      // path's compensation: the person completed a consent screen and Rally
      // holds a real grant, so the connection is theirs to reconnect or remove.
      // The attempt still fails, so the browser handoff says so.
      try {
        await this.verifyCustomMcp(connectionId);
      } catch (error) {
        await this.env.DB.prepare(
          `UPDATE connector_connections SET status = 'error', error_json = ?, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND connector_type = ?`,
        ).bind(
          JSON.stringify({
            code: "custom_mcp_unreachable",
            message: connectorFailureMessage(error),
            retryable: true,
          }),
          nowIso(),
          connectionId,
          row.workspace_id,
          CUSTOM_MCP_CONNECTOR_TYPE,
        ).run();
        await publishConnectorWorkspaceSync(this.env, String(row.workspace_id));
        throw customMcpUnreachable(error);
      }
    }
    await this.recordConnectionAudit(
      String(row.workspace_id),
      String(row.user_id),
      existing ? "connector.reauthorized" : "connector.authorized",
      connectionId,
      { provider, scope: stateData.scope, capabilities: grantedCapabilities, providerAccountId },
    );
    if (attemptId) await this.finishOAuthAttempt(String(row.workspace_id), attemptId, "succeeded", { connectionId });
    await publishConnectorWorkspaceSync(this.env, String(row.workspace_id));
    return this.connectorAttemptTarget({
      provider,
      status: "succeeded",
      ...(attemptId ? { attemptId } : {}),
      connectionId,
      workspaceId: String(row.workspace_id),
      returnUri: String(row.return_uri),
    });
  }

  async completeProviderDenial(provider: ConnectorOAuthProvider, state: string): Promise<string> {
    const row = await this.consumeProviderState(provider, state, "connector");
    const attemptId = await this.oauthAttemptIdFromState(row);
    await this.finishOAuthAttempt(String(row.workspace_id), attemptId, "denied", { errorCode: "oauth_denied" });
    return this.connectorAttemptTarget({
      provider,
      status: "denied",
      attemptId,
      errorCode: "oauth_denied",
      workspaceId: String(row.workspace_id),
      returnUri: String(row.return_uri),
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
      return unknownConnectorAttemptFailureTarget(this.env, {
        provider,
        errorCode: normalizeConnectorOAuthErrorCode(errorCode),
      });
    }
    const workspaceId = String(row.workspace_id);
    this.env = withWorkspaceRuntimeDatabase(this.env, workspaceId);
    let attemptId: string;
    try {
      attemptId = await this.oauthAttemptIdFromState(row);
    } catch {
      return this.connectorAttemptTarget({
        provider,
        status: "failed",
        errorCode: normalizeConnectorOAuthErrorCode(errorCode),
        workspaceId,
        returnUri: String(row.return_uri),
      });
    }
    const existing = await this.loadOAuthAttempt(workspaceId, attemptId);
    if (existing?.status === "succeeded" && existing.connectionId) {
      return this.connectorAttemptTarget({
        provider,
        status: "succeeded",
        attemptId,
        connectionId: existing.connectionId,
        workspaceId,
        returnUri: String(row.return_uri),
      });
    }
    if (
      existing?.connectionId
      && (existing.status === "pending" || existing.status === "failed")
    ) {
      const committed = await this.env.DB.prepare(
        `SELECT id FROM connector_connections
         WHERE id = ? AND workspace_id = ? AND connector_type = ? AND status = 'healthy'`,
      ).bind(existing.connectionId, row.workspace_id, provider).first<{ id: string }>();
      if (committed) {
        await this.finishOAuthAttempt(workspaceId, attemptId, "succeeded", { connectionId: committed.id });
        return this.connectorAttemptTarget({
          provider,
          status: "succeeded",
          attemptId,
          connectionId: committed.id,
          workspaceId,
          returnUri: String(row.return_uri),
        });
      }
    }
    const terminalStatus = existing?.status === "denied" ? "denied" : "failed";
    const terminalError = existing?.errorCode ?? normalizeConnectorOAuthErrorCode(errorCode);
    if (!existing || existing.status === "pending") {
      await this.finishOAuthAttempt(workspaceId, attemptId, terminalStatus, { errorCode: terminalError });
    }
    return this.connectorAttemptTarget({
      provider,
      status: terminalStatus,
      attemptId,
      errorCode: terminalError,
      workspaceId,
      returnUri: String(row.return_uri),
    });
  }

  async getOAuthAttempt(attemptId: string): Promise<ConnectorOAuthAttempt> {
    const auth = this.requireAuth();
    // Lazy expiry and the read are one object transaction, member-scoped: the
    // row reported is the row after the sweep, and another member's attempt is
    // neither expired nor revealed by this poll.
    const { attempt } = WorkspaceConnectorOAuthAttemptReadResultSchema.parse(
      await (await this.workspaceObject(auth.workspaceId)).connectorOAuthAttempt({
        workspaceId: auth.workspaceId,
        attemptId,
        region: this.env.AVALON_REGION,
        userId: auth.userId,
        expireDueAt: nowIso(),
      }),
    );
    if (!attempt) throw new ApiError(404, "oauth_attempt_not_found", "The connector authorization attempt was not found");
    await this.emitOAuthOutcome(attempt).catch(() => undefined);
    return {
      attemptId: attempt.attemptId,
      provider: attempt.provider,
      status: attempt.status,
      connectionId: attempt.connectionId,
      errorCode: attempt.errorCode,
      expiresAt: attempt.expiresAt,
    };
  }

  async reconnect(id: string, desktopHandoffVersion: 1 | 2): Promise<ConnectorOAuthStart> {
    const connection = await this.loadAuthorized(id);
    if (connection.connector_type === "google") {
      return this.beginGoogle({
        scope: connection.scope,
        capabilities: parseJson(connection.granted_scopes_json, []),
        connectionId: id,
        desktopHandoffVersion,
      });
    }
    if (connection.connector_type === CUSTOM_MCP_CONNECTOR_TYPE) {
      const config = this.customMcpConfig(connection);
      if (config.authMode !== "oauth") {
        throw new ApiError(
          422,
          "reconnect_not_supported",
          "This MCP connection authenticates with configured headers. Add the server again with the current values, then remove this connection.",
        );
      }
      return this.beginProvider(CUSTOM_MCP_CONNECTOR_TYPE, {
        scope: connection.scope,
        capabilities: parseJson(connection.granted_scopes_json, []),
        connectionId: id,
        desktopHandoffVersion,
        customMcp: {
          serverUrl: config.serverUrl,
          displayName: String(connection.display_name),
          toolPolicy: config.toolPolicy,
        },
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
        desktopHandoffVersion,
      });
    }
    if (connection.connector_type === "github") {
      return this.beginGitHub({
        scope: connection.scope,
        capabilities: parseJson(connection.granted_scopes_json, []),
        connectionId: id,
        desktopHandoffVersion,
      });
    }
    throw new ApiError(422, "reconnect_not_supported", "This connection does not use OAuth reconnect");
  }

  async discoverOnboardingTeammates(input: DiscoverOnboardingTeammates, signal: AbortSignal) {
    const auth = this.requireAuth();
    const connection = await this.loadVisible(input.connectionId);
    if (connection.connector_type !== 'google' || connection.scope !== 'personal' || connection.owner_user_id !== auth.userId || connection.status !== 'healthy') {
      throw new ApiError(403, 'personal_calendar_required', 'Choose your own connected Google Calendar account.');
    }
    const context = await this.context(connection);
    if (!context.grantedScopes.includes('calendar.read')) throw new ApiError(409, 'calendar_access_required', 'Connect Google Calendar to find teammates.');
    const adapter = this.registry().get('google');
    const result = await withAuthorizedConnection(this.env, { connection: context, adapter, signal },
      (authorized) => adapter.executeTool('calendar.list_events', {
        calendarId: 'primary', timeMin: input.timeMin, timeMax: input.timeMax,
        ...(input.pageToken ? { pageToken: input.pageToken } : {}),
      }, { connection: authorized, principal: { type: 'user', userId: auth.userId }, signal }));
    const members = await this.env.DB.prepare(`SELECT u.email FROM users u JOIN workspace_members m ON m.user_id = u.id
      WHERE m.workspace_id = ? AND m.status = 'active'`).bind(auth.workspaceId).all<{ email: string }>();
    const invitations = await this.env.DB.prepare(`SELECT email FROM workspace_invitations
      WHERE workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`)
      .bind(auth.workspaceId, new Date().toISOString()).all<{ email: string }>();
    return teammatesFromCalendarPage(result.output, new Set([...members.results, ...invitations.results].map((row) => row.email.toLowerCase())));
  }

  async test(id: string) {
    const connection = await this.loadAuthorized(id);
    const previousHealth = telemetryConnectionHealth(connection.status);
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
      // Every failure is an answer here, not a 500. Testing a connection is the
      // affordance a member reaches for *because* it is broken, so the one
      // thing it must not do is fail to report. This used to be narrower and
      // could afford to be: a non-healthy row skipped the refresh entirely.
      // Now the door refreshes for any row, which puts two more failures on
      // this path — the ten-second abort (a `DOMException`, not a
      // `ConnectorError`) and the lease compare-and-swap losing under a
      // concurrent refresh — and either one would have escaped as a 5xx, with
      // the terminal status write below skipped as well.
      const reconnectRequired = error instanceof ConnectorError && error.code === "unauthorized";
      result = {
        ok: false,
        message: error instanceof Error ? error.message : "The connection test failed",
        ...(reconnectRequired ? { reconnectRequired: true } : {}),
      };
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
    if (result.ok && connection.connector_type === "notion" && connection.scope === "workspace") {
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
    const appliedHealth = result.ok ? "healthy" : result.reconnectRequired ? "needs_reconnect" : "error";
    await this.emitConnectorAction(
      connection,
      "test",
      previousHealth,
      appliedHealth,
      result.ok ? "success" : "failed",
    ).catch(() => undefined);
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
          },
          (authorized) => adapter.revoke!(authorized, signal),
        );
        remoteRevocation = "succeeded";
      }
    } catch {
      remoteRevocation = "failed";
    } finally {
      const disabledAt = nowIso();
      await this.env.DB.prepare(
        `UPDATE connector_connections SET status = 'disabled', encrypted_credentials = NULL,
         credential_iv = NULL, next_poll_at = NULL, updated_at = ? WHERE id = ?`,
      ).bind(disabledAt, id).run();
      // Object-local Terminal repository selections are immutable provenance,
      // not a copy of connector authority. Every bootstrap rechecks this
      // WorkspaceDO row, so a disabled connection is unusable without a fanout
      // write to every SubstreamAgent.
      await this.env.DB.prepare("UPDATE schedules SET enabled = 0, updated_at = ? WHERE connector_connection_id = ?")
        .bind(nowIso(), id).run();
      await this.syncConnectorIngressRoute(id);
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
      if (connection.connector_type === "notion" && connection.scope === "workspace") {
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
      await this.emitConnectorAction(
        connection,
        "disconnect",
        telemetryConnectionHealth(connection.status),
        "disabled",
        "success",
      ).catch(() => undefined);
    }
  }

  async createWebhook(input: CreateWebhookInput) {
    const telemetryStartedAt = Date.now();
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
    await this.syncConnectorIngressRoute(id);
    await this.recordConnectionAudit(auth.workspaceId, auth.userId, "connector.authorized", id, {
      provider: "generic_webhook", scope: input.scope, eventTypes: input.eventTypes,
    });
    const stored: StoredConnection = {
      id,
      workspace_id: auth.workspaceId,
      connector_type: "generic_webhook",
      scope: input.scope,
      owner_user_id: input.scope === "personal" ? auth.userId : null,
      model_plugin_id: modelPluginId,
      status: "healthy",
      granted_scopes_json: "[]",
      encrypted_credentials: encrypted.ciphertext,
      credential_iv: encrypted.iv,
      credential_key_version: Number(this.env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1),
    };
    await this.emitConnectorSetupCompleted(stored, "webhook", Date.now() - telemetryStartedAt, false)
      .catch(() => undefined);
    return this.webhookConnectionResult(stored, secret);
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
    await this.emitConnectorAction(
      connection,
      "secret_rotate",
      telemetryConnectionHealth(connection.status),
      telemetryConnectionHealth(connection.status),
      "success",
    ).catch(() => undefined);
    return {
      endpoint: new URL(`/ingest/webhook/${id}`, this.env.PUBLIC_API_BASE_URL).toString(),
      signingSecret,
      signatureFormat: "t=<unix-seconds>,v1=<hex-hmac-sha256(t.raw-body)>",
    };
  }

  async createX(input: { scope: "workspace"; capabilities: string[] }) {
    const telemetryStartedAt = Date.now();
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
    await this.syncConnectorIngressRoute(id);
    await this.recordConnectionAudit(auth.workspaceId, auth.userId, "connector.authorized", id, {
      provider: "x",
      scope: input.scope,
      capabilities,
    });
    const connection = (await this.list()).find((item) => item.id === id);
    if (!connection) throw new ApiError(500, "connection_write_failed", "The X connection could not be loaded");
    await this.emitConnectorSetupCompleted(
      await this.loadAuthorized(id),
      "api_key",
      Date.now() - telemetryStartedAt,
      false,
    ).catch(() => undefined);
    return { connection };
  }

  async createGranolaWorkspace(input: { apiKey: string; capabilities: string[] }) {
    const telemetryStartedAt = Date.now();
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
      await this.env.DB.prepare(
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
        ).run();
      await this.env.DB.prepare(
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
        ).run();
      await this.syncConnectorIngressRoute(id);
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
    await this.emitConnectorSetupCompleted(
      await this.loadAuthorized(id),
      "api_key",
      Date.now() - telemetryStartedAt,
      false,
    ).catch(() => undefined);
    return { connection };
  }

  /**
   * Register a custom MCP server that authenticates with configured headers.
   *
   * Written and then proved: the row has to exist before the credential door
   * can hand the adapter an authorized connection, and a server that cannot be
   * reached is removed again rather than left as a connection whose only
   * symptom is a plugin that silently fails to load inside somebody's run.
   */
  async createCustomMcp(input: z.infer<typeof CreateCustomMcpConnectionRequestSchema>) {
    const telemetryStartedAt = Date.now();
    const auth = this.requireAuth();
    this.assertScopeAllowed(input.scope);
    this.customMcpAdapter();
    const capabilities = [CustomMcpCapabilities.tools];
    const serverUrl = normalizeCustomMcpServerUrl(input.serverUrl);
    const id = newId();
    const encrypted = await encryptString(
      JSON.stringify({ authMode: "headers", requestHeaders: input.requestHeaders }),
      this.env.CONNECTOR_CREDENTIALS_KEY,
      id,
    );
    const at = nowIso();
    const modelPluginId = await this.allocateModelPluginId(auth.workspaceId, CUSTOM_MCP_CONNECTOR_TYPE);
    await this.env.DB.prepare(
      `INSERT INTO connector_connections
       (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
        encrypted_credentials, credential_iv, credential_key_version, granted_scopes_json,
        model_plugin_id, status, cursor_json, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'healthy', '{}', ?, ?, ?)`,
    ).bind(
      id,
      auth.workspaceId,
      CUSTOM_MCP_CONNECTOR_TYPE,
      input.scope,
      input.scope === "personal" ? auth.userId : null,
      serverUrl,
      input.displayName.slice(0, 180),
      encrypted.ciphertext,
      encrypted.iv,
      Number(this.env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1),
      JSON.stringify(capabilities),
      modelPluginId,
      JSON.stringify(this.customMcpConfigJson(serverUrl, "headers", input.scope, input.toolPolicy)),
      at,
      at,
    ).run();
    try {
      await this.verifyCustomMcp(id);
    } catch (error) {
      await this.env.DB.prepare(
        `DELETE FROM connector_connections WHERE id = ? AND workspace_id = ?`,
      ).bind(id, auth.workspaceId).run();
      throw customMcpUnreachable(error);
    }
    await this.syncConnectorIngressRoute(id);
    await this.recordConnectionAudit(auth.workspaceId, auth.userId, "connector.authorized", id, {
      provider: CUSTOM_MCP_CONNECTOR_TYPE,
      scope: input.scope,
      capabilities,
      serverUrl,
      authMode: "headers",
    });
    const connection = (await this.list()).find((item) => item.id === id);
    if (!connection) throw new ApiError(500, "connection_write_failed", "The MCP connection could not be loaded");
    await this.emitConnectorSetupCompleted(
      await this.loadAuthorized(id),
      "api_key",
      Date.now() - telemetryStartedAt,
      false,
    ).catch(() => undefined);
    return { connection };
  }

  /** Begin the standards-based authorization for a custom MCP server. */
  async beginCustomMcp(input: {
    scope: Scope;
    displayName: string;
    serverUrl: string;
    toolPolicy: CustomMcpToolPolicy;
    desktopHandoffVersion: 1 | 2;
  }): Promise<ConnectorOAuthStart> {
    this.customMcpAdapter();
    return this.beginProvider(CUSTOM_MCP_CONNECTOR_TYPE, {
      scope: input.scope,
      capabilities: [CustomMcpCapabilities.tools],
      desktopHandoffVersion: input.desktopHandoffVersion,
      customMcp: {
        serverUrl: normalizeCustomMcpServerUrl(input.serverUrl),
        displayName: input.displayName.slice(0, 180),
        toolPolicy: input.scope === "workspace" ? input.toolPolicy : "all_tools",
      },
    });
  }

  /**
   * The server's live catalog, the annotations behind the read-only policy, and
   * which tools that policy currently admits.
   *
   * A server that cannot be reached is reported as an unavailable catalog
   * rather than as a failed request: the row's policy and endpoint are still
   * worth showing, and the alternative is a settings screen that shows nothing
   * at all whenever a third-party server is down.
   */
  async getCustomMcpSettings(id: string): Promise<CustomMcpConnectionSettings> {
    const auth = this.requireAuth();
    const connection = await this.loadVisible(id);
    this.assertCustomMcpConnection(connection);
    const config = this.customMcpConfig(connection);
    let tools: CustomMcpConnectionSettings["tools"] = [];
    let toolsUnavailable: string | null = null;
    try {
      const inventory = await this.readCustomMcpInventory(connection);
      tools = inventory.tools;
    } catch (error) {
      toolsUnavailable = connectorFailureMessage(error);
    }
    return {
      connectionId: String(connection.id),
      connectionName: String(connection.display_name),
      scope: connection.scope,
      serverUrl: config.serverUrl,
      authMode: config.authMode,
      toolPolicy: connection.scope === "workspace" ? config.toolPolicy : "all_tools",
      // The caller's own answer, not the row's: a member may read a workspace
      // connection's catalog, and `updateCustomMcpToolPolicy` refuses their
      // change. Reporting it editable would offer them a control that 403s.
      toolPolicyEditable: connection.scope === "workspace"
        && (auth.role === "owner" || auth.role === "admin"),
      tools,
      toolsUnavailable,
    };
  }

  /**
   * Change which of a server's tools a workspace connection exposes.
   *
   * Workspace only, and not because a personal connection is trusted more: a
   * workspace connection hands one credential to everybody, which is the
   * situation the policy exists for. A personal connection is usable only by
   * the person who authorized it, with their own provider identity.
   */
  async updateCustomMcpToolPolicy(
    id: string,
    toolPolicy: CustomMcpToolPolicy,
  ): Promise<CustomMcpConnectionSettings> {
    const connection = await this.loadAuthorized(id);
    this.assertCustomMcpConnection(connection);
    if (connection.scope !== "workspace") {
      throw new ApiError(
        422,
        "custom_mcp_policy_unsupported",
        "The tool policy applies to workspace connections; a personal connection is only ever your own",
      );
    }
    const config = this.customMcpConfig(connection);
    const auth = this.requireAuth();
    await this.assertCustomMcpPolicyIsUsable(connection, toolPolicy);
    await this.env.DB.prepare(
      `UPDATE connector_connections
       SET config_json = json_patch(config_json, ?), updated_at = ?
       WHERE id = ? AND workspace_id = ? AND connector_type = ?`,
    ).bind(
      JSON.stringify({ toolPolicy }),
      nowIso(),
      id,
      auth.workspaceId,
      CUSTOM_MCP_CONNECTOR_TYPE,
    ).run();
    await this.recordConnectionAudit(auth.workspaceId, auth.userId, "connector.settings_changed", id, {
      provider: CUSTOM_MCP_CONNECTOR_TYPE,
      scope: connection.scope,
      serverUrl: config.serverUrl,
      toolPolicy,
    });
    await publishConnectorWorkspaceSync(this.env, auth.workspaceId);
    return this.getCustomMcpSettings(id);
  }

  /**
   * The registry lookup is the whole check.
   *
   * Every other connector can be absent for want of credentials, and its
   * service method says so with a 503. This one has none to be missing —
   * `customMcpConnectorConfig` returns a callback URI and cannot fail — so a
   * guard here would read as protection while catching nothing. A region that
   * somehow did not register it raises `unsupported_capability` from the
   * registry, which is the honest answer.
   */
  private customMcpAdapter(): ResolvedConnectorAdapter {
    return this.registry().get(CUSTOM_MCP_CONNECTOR_TYPE);
  }

  private assertCustomMcpConnection(connection: StoredConnection): void {
    if (connection.connector_type !== CUSTOM_MCP_CONNECTOR_TYPE) {
      throw new ApiError(422, "connector_settings_unsupported", "This connector does not provide MCP tool settings");
    }
  }

  private customMcpConfig(connection: StoredConnection) {
    const parsed = CustomMcpConnectionConfigSchema.safeParse(parseJson(connection.config_json, {}));
    if (!parsed.success) {
      throw new ApiError(
        500,
        "custom_mcp_configuration_invalid",
        "This MCP connection is missing its server configuration",
      );
    }
    return parsed.data;
  }

  /**
   * A personal connection stores `all_tools` whatever the request asked for, so
   * the stored row and the policy in force can never disagree — the adapter
   * reads the same field for every scope.
   */
  private customMcpConfigJson(
    serverUrl: string,
    authMode: "oauth" | "headers",
    scope: Scope,
    toolPolicy: CustomMcpToolPolicy,
  ): Record<string, unknown> {
    return {
      region: this.env.AVALON_REGION,
      serverUrl,
      authMode,
      toolPolicy: scope === "workspace" ? toolPolicy : "all_tools",
    };
  }

  private customMcpCompletionConfiguration(
    sealed: CustomMcpStartConfiguration | null,
    existing: StoredConnection | null,
  ): CustomMcpStartConfiguration {
    if (!sealed) {
      throw new ApiError(401, "invalid_oauth_state", "The MCP authorization is missing its server configuration");
    }
    if (existing) {
      const current = this.customMcpConfig(existing);
      if (current.serverUrl !== sealed.serverUrl) {
        throw new ApiError(409, "custom_mcp_server_mismatch", "Reconnect this connection to the same MCP server");
      }
    }
    return sealed;
  }

  /**
   * Refuse a policy that would leave this connection able to call nothing.
   *
   * Creation already refuses that state, and narrowing an existing connection
   * into it silently is the same outcome arrived at a different way: the plugin
   * stops loading, and the only place that says why is a settings pane the
   * person has no reason to reopen.
   *
   * A server that cannot be reached does not block the change. A stored belief
   * about a third party is not evidence, and refusing somebody's setting
   * because their server is down right now would be the worse mistake.
   */
  private async assertCustomMcpPolicyIsUsable(
    connection: StoredConnection,
    toolPolicy: CustomMcpToolPolicy,
  ): Promise<void> {
    if (toolPolicy === "all_tools") return;
    const inventory = await this.readCustomMcpInventory(connection).catch(() => null);
    if (!inventory || inventory.tools.length === 0) return;
    if (inventory.tools.some((tool) => tool.readOnly)) return;
    throw new ApiError(
      422,
      "custom_mcp_policy_admits_nothing",
      "This MCP server marks none of its tools read-only, so a read-only connection could call nothing",
    );
  }

  private async readCustomMcpInventory(connection: StoredConnection) {
    const adapter = this.customMcpAdapter();
    const context = await this.context(connection);
    return withAuthorizedConnection(
      this.env,
      { connection: context, adapter, signal: AbortSignal.timeout(20_000) },
      (authorized) => listCustomMcpToolInventory(authorized, AbortSignal.timeout(20_000)),
    );
  }

  /**
   * Prove a stored connection can actually serve the model.
   *
   * Through the adapter's own health check, which runs the discovery the
   * plugin runs — the connection's tool policy, the model-facing name
   * normalization, the schema bounds, the collision checks. Counting the raw
   * catalog instead would accept a server whose every tool the policy filters
   * out, or whose names collide once normalized: nonempty here, and refused at
   * every activation afterwards.
   */
  private async verifyCustomMcp(id: string): Promise<void> {
    const row = await this.env.DB.prepare(
      `SELECT * FROM connector_connections WHERE id = ?`,
    ).bind(id).first<StoredConnection>();
    if (!row) throw new ApiError(500, "connection_write_failed", "The MCP connection could not be loaded");
    const adapter = this.customMcpAdapter();
    const context = await this.context(row);
    const health = await withAuthorizedConnection(
      this.env,
      { connection: context, adapter, signal: AbortSignal.timeout(20_000) },
      (authorized) => adapter.healthCheck(authorized, AbortSignal.timeout(20_000)),
    );
    if (!health.ok) throw new ConnectorError("unsupported_capability", health.message);
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
    await this.routeIngressConnection(connectionId, "granola");
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
    if (this.env.WORKSPACE_DOS) {
      const receipt = WorkspaceWebhookReceiptClaimResultSchema.parse(
        await (await this.workspaceObject(connection.workspace_id)).claimWebhookReceipt({
          workspaceId: connection.workspace_id,
          receiptId: newId(),
          connectionId: connection.id,
          signatureHash: envelope.receiptKey ?? envelope.deliveryId,
          receivedAt,
          expiresAt: new Date(Date.now() + 4 * 24 * 60 * 60_000).toISOString(),
        }),
      );
      const persisted = await persistNormalizedActivity(this.env, {
        ...normalized,
        rawContentHash: normalized.rawContentHash ?? envelope.bodyHash,
      }, "granola");
      return {
        duplicate: receipt.outcome === "duplicate" || persisted.duplicate,
        activityId: persisted.activityId,
      };
    }
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
    await this.routeIngressConnection(connectionId, "generic_webhook");
    const connection = await this.env.DB.prepare(
      `SELECT * FROM connector_connections WHERE id = ? AND connector_type = 'generic_webhook' AND status <> 'disabled'`,
    ).bind(connectionId).first<StoredConnection>();
    if (!connection) throw new ApiError(404, "connection_not_found", "Webhook connection not found");
    const context = await this.context(connection);
    const signingSecret = String(context.credentials.signingSecret ?? "");
    const source = this.registry().get("generic_webhook").webhookActivity;
    if (!source) throw new ApiError(500, "webhook_source_unavailable", "Webhook ingestion is unavailable");
    const webhookHeaders = new Headers();
    if (signatureHeader) webhookHeaders.set(RALLY_HEADERS.SIGNATURE, signatureHeader);
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
    if (this.env.WORKSPACE_DOS) {
      await this.env.PAYLOADS.put(payloadKey, rawBody, {
        httpMetadata: { contentType: "application/json" },
      });
      const receivedAt = nowIso();
      // The claim sweeps this connection's expired receipts in the same object
      // transaction, which is what the separate DELETE ahead of the insert
      // used to do in its own round trip.
      const receipt = WorkspaceWebhookReceiptClaimResultSchema.parse(
        await (await this.workspaceObject(connection.workspace_id)).claimWebhookReceipt({
          workspaceId: connection.workspace_id,
          receiptId,
          connectionId,
          signatureHash: envelope.receiptKey ?? envelope.deliveryId,
          receivedAt,
          expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        }),
      );
      const persisted = await persistNormalizedActivity(this.env, normalized, "generic_webhook");
      return {
        duplicate: receipt.outcome === "duplicate" || persisted.duplicate,
        activityId: persisted.activityId,
      };
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

  private async routeIngressConnection(connectionId: string, connectorType: string): Promise<void> {
    if (!this.env.WORKSPACE_DOS) {
      const legacy = await this.env.DB.prepare(
        `SELECT workspace_id FROM connector_connections
          WHERE id = ? AND connector_type = ? AND status <> 'disabled'`,
      ).bind(connectionId, connectorType).first<{ workspace_id: string }>();
      if (!legacy) throw new ApiError(404, "connection_not_found", "Connector route not found");
      return;
    }
    const route = await workspaceRegionalDatabase(this.env).prepare(
      `SELECT workspace_id FROM connector_ingress_routes
        WHERE connection_id = ? AND region = ? AND connector_type = ? AND status = 'active'`,
    ).bind(connectionId, this.env.AVALON_REGION, connectorType).first<{ workspace_id: string }>();
    if (!route) throw new ApiError(404, "connection_not_found", "Connector route not found");
    this.env = withWorkspaceRuntimeDatabase(this.env, route.workspace_id);
  }

  private async persistConnectionMutation(
    statement: D1PreparedStatement,
    attemptId: string | null,
    connectionId: string,
  ): Promise<D1Result<unknown>> {
    const at = nowIso();
    // Connection and attempt share WorkspaceDO authority, so the user-visible
    // handoff can never remain pending after its connection commits. The D1
    // ingress route is the recoverable post-commit control-plane edge.
    const result = attemptId
      ? (await this.env.DB.batch([
          statement,
          this.env.DB.prepare(
            `UPDATE connector_oauth_attempts
             SET connection_id = ?, updated_at = ?
             WHERE id = ? AND region = ?
               AND status IN ('pending', 'failed')`,
          ).bind(connectionId, at, attemptId, this.env.AVALON_REGION),
        ]))[0]
      : await statement.run();
    if (!result) {
      throw new ApiError(500, "connector_persistence_failed", "The connector could not be persisted");
    }
    await this.syncConnectorIngressRoute(connectionId);
    return result;
  }

  private async syncConnectorIngressRoute(connectionId: string): Promise<void> {
    // Focused unit/legacy environments without WorkspaceDO authority still
    // write connector rows directly; migration triggers maintain the route in
    // a real deployment. Explicit synchronization is required only after the
    // connector row has moved into WorkspaceDO.
    if (!this.env.WORKSPACE_DOS) return;
    const connection = await this.env.DB.prepare(
      `SELECT id, workspace_id, connector_type, scope, provider_account_id,
              status, config_json, updated_at
         FROM connector_connections WHERE id = ?`,
    ).bind(connectionId).first<ConnectorIngressRouteSource>();
    if (!connection) return;
    const route = connectorIngressRouteValues(connection, this.env.AVALON_REGION);
    await workspaceRegionalDatabase(this.env).prepare(
      `INSERT INTO connector_ingress_routes (
         connection_id, workspace_id, region, connector_type, scope,
         provider_account_id, provider_user_id, status, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(connection_id) DO UPDATE SET
         workspace_id = excluded.workspace_id, region = excluded.region,
         connector_type = excluded.connector_type, scope = excluded.scope,
         provider_account_id = excluded.provider_account_id,
         provider_user_id = excluded.provider_user_id,
         status = excluded.status, updated_at = excluded.updated_at`,
    ).bind(
      route.connectionId,
      route.workspaceId,
      route.region,
      route.connectorType,
      route.scope,
      route.providerAccountId,
      route.providerUserId,
      route.status,
      route.updatedAt,
    ).run();
  }

  private workspaceObject(workspaceId: string) {
    return durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      asWorkspaceId(workspaceId),
      workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(workspaceId)),
    );
  }

  private async extendOAuthAttempt(workspaceId: string, attemptId: string, expiresAt: string): Promise<void> {
    await (await this.workspaceObject(workspaceId)).extendConnectorOAuthAttempt({
      workspaceId,
      attemptId,
      region: this.env.AVALON_REGION,
      expiresAt,
      at: nowIso(),
    });
  }

  private async persistOAuthStart(input: {
    attemptId: string;
    provider: ConnectorOAuthProvider;
    purpose?: "connector" | "github_install";
    state: string;
    statePayload: string;
    auth: AuthContext;
    expiresAt: string;
    scope: Scope;
    capabilityCount: number;
    reconnect: boolean;
    desktopHandoffVersion: 1 | 2;
  }): Promise<void> {
    const at = nowIso();
    await (await this.workspaceObject(input.auth.workspaceId)).startConnectorOAuthAttempt({
      workspaceId: input.auth.workspaceId,
      attemptId: input.attemptId,
      region: this.env.AVALON_REGION,
      provider: input.provider,
      userId: input.auth.userId,
      expiresAt: input.expiresAt,
      telemetryScope: input.scope,
      telemetryCapabilityCount: input.capabilityCount,
      telemetryReconnect: input.reconnect,
      at,
    });
    try {
      await workspaceRegionalDatabase(this.env).prepare(
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
        (input.desktopHandoffVersion === 2
          ? addWorkspaceTarget(compatibleDesktopDeepLink(this.env), {
            region: this.env.AVALON_REGION,
            workspaceId: input.auth.workspaceId,
          })
          : compatibleDesktopDeepLink(this.env)).toString(),
        input.expiresAt,
      ).run();
    } catch (error) {
      // The attempt is workspace-local and is created first so a valid OAuth
      // state can never point at a missing product receipt. Best-effort cleanup
      // avoids leaving a pending row when the D1 routing receipt fails; expiry
      // remains the recovery fence if this compensating RPC is interrupted.
      try {
        await (await this.workspaceObject(input.auth.workspaceId)).abandonConnectorOAuthAttempt({
          workspaceId: input.auth.workspaceId,
          attemptId: input.attemptId,
        });
      } catch {
        // The original persistence error is authoritative; expiry reconciles
        // an undeleted pending row.
      }
      throw error;
    }
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
    workspaceId: string,
    attemptId: string,
    status: "succeeded" | "denied" | "failed",
    result: { connectionId?: string; errorCode?: string },
  ): Promise<void> {
    // Settlement, its replay convergence, and the settled row all come back
    // from one object transaction; the facade shape re-read the row after a
    // refused update and could describe a state between the two.
    const finished = WorkspaceConnectorOAuthAttemptFinishResultSchema.parse(
      await (await this.workspaceObject(workspaceId)).finishConnectorOAuthAttempt({
        workspaceId,
        attemptId,
        region: this.env.AVALON_REGION,
        status,
        connectionId: result.connectionId ?? null,
        errorCode: result.errorCode ?? null,
        at: nowIso(),
      }),
    );
    if (finished.outcome === "conflict") {
      throw new ApiError(409, "oauth_attempt_already_completed", "The connector authorization attempt already completed");
    }
    const settled = finished.attempt;
    await this.emitOAuthOutcome(settled).catch(() => undefined);
    try {
      await publishWorkspaceSync(this.env, settled.workspaceId, ["connector_oauth_attempts"]);
    } catch (error) {
      // The attempt is already durably settled. Reconnect's full workspace
      // snapshot provides another reconciliation edge if this live signal
      // cannot reach the hibernating WorkspaceDO.
      logWarn(this.env, "connector_oauth_attempt_sync_publish_failed", {
        workspace_id: settled.workspaceId,
        attempt_id: settled.attemptId,
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  private async loadOAuthAttempt(
    workspaceId: string,
    attemptId: string,
  ): Promise<WorkspaceConnectorOAuthAttempt | null> {
    return WorkspaceConnectorOAuthAttemptReadResultSchema.parse(
      await (await this.workspaceObject(workspaceId)).connectorOAuthAttempt({
        workspaceId,
        attemptId,
        region: this.env.AVALON_REGION,
        userId: null,
        expireDueAt: null,
      }),
    ).attempt;
  }

  private async emitOAuthOutcome(attempt: WorkspaceConnectorOAuthAttempt): Promise<void> {
    if (!attempt.telemetryOperationId || attempt.status === 'pending') return;
    const result = attempt.status === 'succeeded'
      ? 'success'
      : attempt.status === 'denied' ? 'denied'
        : attempt.errorCode === 'oauth_attempt_expired' ? 'unavailable' : 'failed';
    const auth: IdentityAuthContext = {
      sessionId: `telemetry:${attempt.attemptId}`,
      userId: asUserId(attempt.userId),
      workspaceId: asWorkspaceId(attempt.workspaceId),
      region: this.env.AVALON_REGION,
      role: null,
    };
    const connector = telemetryConnector(attempt.provider);
    if (attempt.telemetryEventVersion === 2
      && connector !== null
      && attempt.telemetryScope !== null
      && attempt.telemetryCapabilityCount !== null) {
      await emitAuthenticatedApiTelemetry(this.env, auth, apiTelemetryEnvelope(
        this.env,
        'connector_setup_completed_v2',
        {
          connector,
          scope: attempt.telemetryScope,
          method: 'oauth',
          result,
          duration: telemetryJourneyDuration(Math.max(0, Date.now() - Date.parse(attempt.createdAt))),
          capabilityCount: telemetryCountBucket(attempt.telemetryCapabilityCount),
          reconnect: attempt.telemetryReconnect,
        },
        attempt.telemetryOperationId,
        'workspace-user',
        this.env.AVALON_REGION,
        attempt.telemetryOperationId,
      ));
      return;
    }
    if (attempt.provider === 'granola') return;
    await emitAuthenticatedApiTelemetry(this.env, auth, apiTelemetryEnvelope(
      this.env,
      'connector_setup_completed',
      { connector: attempt.provider, result },
      attempt.telemetryOperationId,
      'workspace-user',
      this.env.AVALON_REGION,
      attempt.telemetryOperationId,
    ));
  }

  private connectorAttemptTarget(input: ConnectorAttemptTargetInput): string {
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
    this.env = withWorkspaceRuntimeDatabase(this.env, String(row.workspace_id));
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
    const row = await this.loadVisible(id);
    const auth = this.requireAuth();
    if (row.scope === "workspace" && auth.role !== "owner" && auth.role !== "admin") {
      throw new ApiError(403, "workspace_admin_required", "Only administrators can modify workspace connections");
    }
    return row;
  }

  private assertConnectionEnabled(row: StoredConnection): void {
    if (row.status === "disabled") {
      throw new ApiError(
        409,
        "connection_disabled",
        "This GitHub connection is disabled. Reconnect it before loading or changing repository access settings.",
      );
    }
  }

  private async loadVisible(id: string): Promise<StoredConnection> {
    const auth = this.requireAuth();
    const row = await this.env.DB.prepare(
      `SELECT * FROM connector_connections WHERE id = ? AND workspace_id = ?
       AND (scope = 'workspace' OR owner_user_id = ?)`,
    ).bind(id, auth.workspaceId, auth.userId).first<StoredConnection>();
    if (!row) throw new ApiError(404, "connection_not_found", "Connection not found");
    return row;
  }

  private async loadGitHubRepositoryAccessSettings(
    row: StoredConnection,
  ): Promise<GitHubRepositoryAccessSettings> {
    const context = await this.context(row);
    const adapter = this.registry().get("github");
    const connectorConfig = githubConnectorConfig(this.env);
    if (!connectorConfig) {
      throw new ApiError(503, "github_app_unavailable", "The Rally GitHub App is not configured in this region");
    }
    const discovery = await withAuthorizedConnection(
      this.env,
      { connection: context, adapter, signal: AbortSignal.timeout(30_000) },
      (authorized) => discoverGitHubConnectionRepositories(
        connectorConfig,
        authorized,
        AbortSignal.timeout(30_000),
        1_000,
      ),
    );
    const policy = githubRepositoryAccessPolicy(context.config);
    const configured = policy.repositories.map((repository) => ({
      repositoryId: repository.repositoryId,
      repositoryFullName: repository.repositoryFullName,
      remoteAccess: repository.access,
    }));
    const configuredByIdentity = new Map(configured.map((repository) => [
      `${repository.repositoryId}:${repository.repositoryFullName.toLowerCase()}`,
      repository.remoteAccess,
    ]));
    const availableRepositories = discovery.resources.flatMap((resource) => {
      const repositoryId = typeof resource.metadata.repositoryId === "string"
        ? resource.metadata.repositoryId
        : typeof resource.metadata.repositoryId === "number"
          ? String(resource.metadata.repositoryId)
          : null;
      if (!repositoryId) return [];
      const remoteAccess = configuredByIdentity.get(`${repositoryId}:${resource.providerResourceId.toLowerCase()}`)
        ?? (policy.mode === "all_repositories" ? policy.defaultAccess : null);
      return [{
        repositoryId,
        repositoryFullName: resource.providerResourceId,
        private: resource.metadata.private === true,
        remoteAccess,
      }];
    }).sort((left, right) => left.repositoryFullName.localeCompare(right.repositoryFullName));
    return {
      connectionId: row.id,
      connectionName: typeof row.display_name === "string" ? row.display_name : "GitHub",
      revision: policy.revision,
      mode: policy.mode,
      defaultRemoteAccess: policy.defaultAccess,
      repositories: configured,
      availableRepositories,
    };
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
    await refreshWorkspaceSchedule(this.env, workspaceId);
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
  // A configured MCP server is a resource, not a directory: it identifies no
  // Rally member, so it contributes nothing to actor resolution. Returning the
  // Slack-shaped fallback below would write "https" into `providerTenantId`.
  if (provider === "custom_mcp") return {
    providerTenantId: providerAccountId,
    providerUserId: null,
    handle: null,
    verifiedEmail: null,
    identityDisplayName: null,
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
  connectorIngressRouteValues,
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
