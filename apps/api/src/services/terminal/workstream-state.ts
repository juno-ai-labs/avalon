import {
  createGitHubAppJwt,
  discoverGitHubConnectionRepositories,
  type ConnectorConnectionContext,
} from "@rally/connectors";
import { newId } from "@rally/db";
import { createTerminalPortFactory } from "./object-port";

import type { AuthContext, Env } from "../../env";
import { ApiError } from "../../lib/api-error";
import { connectorRegistryForEnv, githubConnectorConfig } from "../../lib/connector-registry";
import { logWarn } from "../../observability/logger";
import {
  emitProductUsageTelemetry,
  telemetryJourneyDuration,
} from "../../telemetry/product-usage";
import { parseTerminalRegionConfiguration } from "./contract";
import type { TerminalSandboxProvider } from "./provider-contract";
import { withAuthorizedConnection } from "../connector-connection-access";
import { decryptVersionedConnectorCredentials } from "../connector-credential-envelope";
import { ConversationService } from "../conversation-service";
import { createIdentityObjectPort } from "../../runtime/identity-port";

export interface TerminalCatalogRepository {
  id: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export interface TerminalResolvedRepository extends TerminalCatalogRepository {
  baseSha: string;
}

export interface TerminalRepositoryCatalogGateway {
  resolveRepository(
    connectionId: string,
    workspaceId: string,
    repositoryFullName: string,
    signal: AbortSignal,
  ): Promise<TerminalResolvedRepository>;
}

function publicState(state: string): "absent" | "starting" | "running" | "stopped" | "archived" | "restoring" | "expired" | "failed" {
  switch (state) {
    case "starting": return "starting";
    case "running": return "running";
    case "stopping":
    case "stopped": return "stopped";
    case "archiving":
    case "archived": return "archived";
    case "restoring": return "restoring";
    case "expiring":
    case "expired": return "expired";
    case "failed": return "failed";
    default: return "absent";
  }
}

export class TerminalWorkstreamService {
  constructor(
    private readonly env: Env,
    private readonly auth: AuthContext,
    private readonly provider: TerminalSandboxProvider | null = null,
  ) {}

  async get(workstreamId: string) {
    await this.requireVisible(workstreamId);
    return this.readState(workstreamId);
  }

  private async readState(workstreamId: string) {
    const terminal = createTerminalPortFactory(this.env)(this.auth.workspaceId, workstreamId);
    const [sandbox, repository, observation] = await Promise.all([
      terminal.sandbox(),
      terminal.repository(),
      terminal.providerObservation(),
    ]);
    const configuration = parseTerminalRegionConfiguration(this.env);
    const state = sandbox ? publicState(sandbox.lifecycleState) : "absent";
    // The object stores epoch milliseconds; this is a member-facing payload,
    // so it reports ISO-8601.
    const expiresAt = sandbox?.expireDueAt ? new Date(sandbox.expireDueAt).toISOString() : null;
    const remainingMs = sandbox?.expireDueAt
      ? sandbox.expireDueAt - Date.now()
      : Number.POSITIVE_INFINITY;
    return {
      providerObservation: observation && observation.generation === sandbox?.generation
        && observation.sandboxId === sandbox.sandboxId ? {
        state: observation.state,
        observedAt: observation.observedAt === null ? null : new Date(observation.observedAt).toISOString(),
        nextObserveAt: new Date(observation.nextObserveAt).toISOString(),
        recoverable: observation.recoverable,
        errorCode: observation.errorCode,
      } : null,
      availability: configuration.capability === "unsupported"
        ? "unsupported" as const
        : configuration.emergencyDisabled ? "emergency_disabled" as const : "supported" as const,
      state,
      lastActivityAt: sandbox?.lastCommandAt
        ? new Date(sandbox.lastCommandAt).toISOString()
        : null,
      expiresAt,
      retentionWarning: remainingMs <= 24 * 60 * 60_000
        ? "expires_within_24_hours" as const
        : remainingMs <= 7 * 24 * 60 * 60_000 ? "expires_within_7_days" as const : null,
      localFilesRetained: Boolean(sandbox && !["expired", "failed"].includes(state)),
      finalDiffResourceId: sandbox?.finalDiffResourceId ?? null,
      failureCode: sandbox?.failureCode ?? null,
      repository: repository?.state === "selected" ? {
        id: repository.repositoryId,
        fullName: repository.repositoryFullName,
        baseRef: repository.baseRef,
        baseSha: repository.baseSha,
        headRef: repository.headRef,
      } : null,
    };
  }

  async startFresh(workstreamId: string) {
    const telemetryStartedAt = Date.now();
    await this.requireParticipant(workstreamId);
    const sandbox = await createTerminalPortFactory(this.env)(
      this.auth.workspaceId,
      workstreamId,
    ).sandbox();
    if (sandbox && !["expired", "failed"].includes(sandbox.lifecycleState)) {
      throw new ApiError(409, "terminal_workspace_still_retained", "This Terminal workspace is still retained. Continue using it instead of starting a fresh workspace.");
    }
    await this.destroyCurrentSandbox(workstreamId);
    const next = await this.readState(workstreamId);
    emitProductUsageTelemetry(this.env, {
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      name: "terminal_workspace_terminal",
      properties: {
        workstreamId,
        action: "start_fresh",
        result: "success",
        duration: telemetryJourneyDuration(Date.now() - telemetryStartedAt),
        repositorySelected: next.repository !== null,
        connectorType: next.repository ? "github" : "none",
        localFilesRetained: false,
      },
      operationId: workstreamId,
      eventId: newId(),
    });
    return next;
  }

  private async destroyCurrentSandbox(workstreamId: string): Promise<void> {
    const terminal = createTerminalPortFactory(this.env)(this.auth.workspaceId, workstreamId);
    const row = await terminal.sandbox();
    if (row?.sandboxId) {
      if (!this.provider) throw new ApiError(503, "terminal_provider_unavailable", "The existing Terminal workspace could not be cleared in this region. Retry when Terminal is available.");
      try {
        await this.provider.clearGitHubReadAccess(row.sandboxId);
      } catch (error) {
        logWarn(this.env, "terminal_github_credential_cleanup_failed", {
          workspace_id: this.auth.workspaceId,
          workstream_id: workstreamId,
          sandbox_id: row.sandboxId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      await this.provider.deleteSandbox(row.sandboxId);
    }
    // One operation, not the two-statement batch this used to be: the delete
    // and the bootstrap clear have to land together, and the object runs them
    // in a single transaction.
    const { deleted } = await terminal.resetSandbox({
      generation: row?.generation ?? null,
      now: Date.now(),
    });
    if (row && !deleted) {
      throw new ApiError(
        409,
        "terminal_workspace_changed",
        "The Terminal workspace changed while it was being cleared. Reload it before starting fresh.",
      );
    }
  }

  private async requireVisible(workstreamId: string): Promise<void> {
    // The conversation's own parent decides, as opening it does.
    await new ConversationService(this.env, this.auth).authorizeViewer(workstreamId);
  }

  private async requireParticipant(workstreamId: string): Promise<void> {
    const participant = (await createIdentityObjectPort(
      this.env,
      this.auth.workspaceId,
      workstreamId,
    ).participants()).find((row) => row.user_id === this.auth.userId);
    if (!participant) throw new ApiError(403, "workstream_participant_required", "Join this thread before selecting or replacing its Terminal repository.");
  }
}

interface GitHubConnection extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  provider_account_id: string | null;
  scope: "personal" | "workspace";
  owner_user_id: string | null;
  granted_scopes_json: string;
  cursor_json: string;
  config_json: string;
  encrypted_credentials: string | null;
  credential_iv: string | null;
  credential_key_version: number | null;
}

function headers(token: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "Rally-Terminal-Catalog",
  };
}

async function responseValue(response: Response): Promise<Record<string, unknown>> {
  const value = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new ApiError(
    response.status === 404 ? 422 : 502,
    "github_catalog_failed",
    response.status === 404
      ? "GitHub could not find that installation or repository catalog. Reconnect GitHub and retry."
      : "GitHub could not load the Terminal repository catalog. Retry after GitHub recovers.",
  );
  return value;
}

function repositoryValue(value: Record<string, unknown>): TerminalCatalogRepository {
  const id = Number(value.id);
  const fullName = String(value.full_name ?? "");
  const defaultBranch = String(value.default_branch ?? "");
  if (!Number.isSafeInteger(id) || id <= 0 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(fullName) || !defaultBranch) {
    throw new ApiError(502, "github_response_invalid", "GitHub returned an invalid repository identity. Retry loading repositories.");
  }
  return { id, fullName, defaultBranch, private: value.private === true };
}

export function createGitHubTerminalCatalogGateway(env: Env): TerminalRepositoryCatalogGateway {
  const api = "https://api.github.com";
  async function loadConnection(connectionId: string, workspaceId: string): Promise<GitHubConnection> {
    const connection = await env.DB.prepare(
      `SELECT id, workspace_id, provider_account_id, scope, owner_user_id,
              granted_scopes_json, cursor_json, config_json, encrypted_credentials,
              credential_iv, credential_key_version
         FROM connector_connections
        WHERE id = ? AND workspace_id = ? AND connector_type = 'github' AND status <> 'disabled'`,
    ).bind(connectionId, workspaceId).first<GitHubConnection>();
    if (!connection?.provider_account_id || !/^\d+$/u.test(connection.provider_account_id)) {
      throw new ApiError(409, "github_connection_revoked", "The GitHub App connection is unavailable. Reconnect GitHub and retry.");
    }
    return connection;
  }
  async function installationToken(connection: GitHubConnection, signal: AbortSignal): Promise<string> {
    const config = githubConnectorConfig(env);
    if (!config) throw new ApiError(503, "github_app_unavailable", "The regional Rally GitHub App is not configured.");
    const jwt = await createGitHubAppJwt({ clientId: config.clientId, privateKey: config.privateKey });
    const value = await responseValue(await fetch(`${api}/app/installations/${connection.provider_account_id}/access_tokens`, {
      method: "POST",
      headers: headers(jwt),
      body: JSON.stringify({ permissions: { contents: "read", metadata: "read", pull_requests: "read", actions: "read", checks: "read" } }),
      signal,
    }));
    if (typeof value.token !== "string" || !value.token) throw new ApiError(502, "github_response_invalid", "GitHub did not return a repository catalog token.");
    return value.token;
  }
  async function assertPersonalRepositoryAccess(
    connection: GitHubConnection,
    repositoryFullName: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (connection.scope !== "personal") return;
    if (!connection.encrypted_credentials || !connection.credential_iv) {
      throw new ApiError(409, "github_connection_revoked", "The personal GitHub connection needs reconnecting before this repository can be used.");
    }
    const credentials = JSON.parse(await decryptVersionedConnectorCredentials(env, {
      id: connection.id,
      encrypted_credentials: connection.encrypted_credentials,
      credential_iv: connection.credential_iv,
      credential_key_version: connection.credential_key_version,
    })) as Record<string, unknown>;
    const parseRecord = (value: string): Record<string, unknown> => {
      try {
        const parsed = JSON.parse(value) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
      } catch {
        return {};
      }
    };
    const context: ConnectorConnectionContext = {
      id: connection.id,
      workspaceId: connection.workspace_id,
      scope: connection.scope,
      ownerUserId: connection.owner_user_id,
      grantedScopes: JSON.parse(connection.granted_scopes_json) as string[],
      credentials,
      cursor: parseRecord(connection.cursor_json),
      config: parseRecord(connection.config_json),
    };
    const connectorConfig = githubConnectorConfig(env);
    if (!connectorConfig) throw new ApiError(503, "github_app_unavailable", "The regional Rally GitHub App is not configured.");
    const discovered = await withAuthorizedConnection(
      env,
      { connection: context, adapter: connectorRegistryForEnv(env).get("github"), signal },
      (authorized) => discoverGitHubConnectionRepositories(connectorConfig, authorized, signal, 1_000),
    );
    if (!discovered.resources.some((resource) => (
      resource.providerResourceId.toLowerCase() === repositoryFullName.toLowerCase()
    ))) {
      throw new ApiError(422, "github_repository_unavailable", "The authorizing GitHub user can no longer access that repository. Choose another authorized repository or reconnect GitHub.");
    }
  }
  return {
    async resolveRepository(connectionId, workspaceId, repositoryFullName, signal) {
      const connection = await loadConnection(connectionId, workspaceId);
      await assertPersonalRepositoryAccess(connection, repositoryFullName, signal);
      const token = await installationToken(connection, signal);
      const repository = repositoryValue(await responseValue(await fetch(`${api}/repos/${repositoryFullName}`, { headers: headers(token), signal })));
      const encodedRef = repository.defaultBranch.split("/").map(encodeURIComponent).join("/");
      const ref = await responseValue(await fetch(`${api}/repos/${repository.fullName}/git/ref/heads/${encodedRef}`, { headers: headers(token), signal }));
      const object = ref.object && typeof ref.object === "object" ? ref.object as Record<string, unknown> : {};
      const baseSha = String(object.sha ?? "");
      return { ...repository, baseSha };
    },
  };
}
