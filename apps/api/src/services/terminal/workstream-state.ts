import {
  createGitHubAppJwt,
  discoverGitHubConnectionRepositories,
  type ConnectorConnectionContext,
} from "@avalon/connectors";
import { newId, nowIso } from "@avalon/db";

import type { AuthContext, Env } from "../../env";
import { ApiError } from "../../lib/api-error";
import { connectorRegistryForEnv, githubConnectorConfig } from "../../lib/connector-registry";
import { logWarn } from "../../observability/logger";
import {
  emitProductUsageTelemetry,
  telemetryJourneyDuration,
} from "../../telemetry/product-usage";
import { parseTerminalRegionConfiguration } from "./contract";
import type { TerminalSandboxProvider } from "./daytona-provider";
import { withAuthorizedConnection } from "../connector-connection-access";
import { decryptVersionedConnectorCredentials } from "../connector-credential-envelope";
import { WorkstreamDirectoryService } from "../workstream-directory-service";
import { readWorkstreamAuthorityControl } from "../workstream-authority";
import { workstreamExecutionEnvironment } from "../workstream-runtime-database";

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

interface SandboxStateRow {
  state: string;
  provider_sandbox_id: string | null;
  last_activity_at: string;
  expire_due_at: string | null;
  final_diff_resource_id: string | null;
  failure_code: string | null;
}

interface RepositoryRow {
  connection_id: string;
  repository_id: number;
  repository_full_name: string;
  base_ref: string;
  base_sha: string;
  head_ref: string;
  state: "selected" | "revoked";
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
    const database = (await workstreamExecutionEnvironment(
      this.env,
      this.auth.workspaceId,
      workstreamId,
    )).DB;
    const [sandbox, repository] = await Promise.all([
      database.prepare(
        `SELECT state, provider_sandbox_id, last_activity_at, expire_due_at,
                final_diff_resource_id, failure_code
           FROM workstream_sandboxes WHERE workspace_id = ? AND workstream_id = ?`,
      ).bind(this.auth.workspaceId, workstreamId).first<SandboxStateRow>(),
      database.prepare(
        `SELECT connection_id, repository_id, repository_full_name, base_ref, base_sha, head_ref, state
           FROM workstream_terminal_repositories
          WHERE workspace_id = ? AND workstream_id = ?`,
      ).bind(this.auth.workspaceId, workstreamId).first<RepositoryRow>(),
    ]);
    const configuration = parseTerminalRegionConfiguration(this.env);
    const state = sandbox ? publicState(sandbox.state) : "absent";
    const expiresAt = sandbox?.expire_due_at ?? null;
    const remainingMs = expiresAt ? Date.parse(expiresAt) - Date.now() : Number.POSITIVE_INFINITY;
    return {
      availability: configuration.capability === "unsupported"
        ? "unsupported" as const
        : configuration.emergencyDisabled ? "emergency_disabled" as const : "supported" as const,
      state,
      lastActivityAt: sandbox?.last_activity_at ?? null,
      expiresAt,
      retentionWarning: remainingMs <= 24 * 60 * 60_000
        ? "expires_within_24_hours" as const
        : remainingMs <= 7 * 24 * 60 * 60_000 ? "expires_within_7_days" as const : null,
      localFilesRetained: Boolean(sandbox && !["expired", "failed"].includes(state)),
      finalDiffResourceId: sandbox?.final_diff_resource_id ?? null,
      failureCode: sandbox?.failure_code ?? null,
      repository: repository?.state === "selected" ? {
        id: repository.repository_id,
        fullName: repository.repository_full_name,
        baseRef: repository.base_ref,
        baseSha: repository.base_sha,
        headRef: repository.head_ref,
      } : null,
    };
  }

  async startFresh(workstreamId: string) {
    const telemetryStartedAt = Date.now();
    await this.requireParticipant(workstreamId);
    const database = (await workstreamExecutionEnvironment(
      this.env,
      this.auth.workspaceId,
      workstreamId,
    )).DB;
    const state = await database.prepare(
      "SELECT state FROM workstream_sandboxes WHERE workspace_id = ? AND workstream_id = ?",
    ).bind(this.auth.workspaceId, workstreamId).first<{ state: string }>();
    if (state && !["expired", "failed"].includes(state.state)) {
      throw new ApiError(409, "terminal_workspace_still_retained", "This Terminal workspace is still retained. Continue using it instead of starting a fresh workspace.");
    }
    await this.destroyCurrentSandbox(workstreamId);
    const next = await this.get(workstreamId);
    await emitProductUsageTelemetry(this.env, {
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
    }).catch(() => undefined);
    return next;
  }

  private async destroyCurrentSandbox(workstreamId: string): Promise<void> {
    const database = (await workstreamExecutionEnvironment(
      this.env,
      this.auth.workspaceId,
      workstreamId,
    )).DB;
    const row = await database.prepare(
      "SELECT provider_sandbox_id, state, generation FROM workstream_sandboxes WHERE workspace_id = ? AND workstream_id = ?",
    ).bind(this.auth.workspaceId, workstreamId).first<{ provider_sandbox_id: string | null; state: string; generation: number }>();
    if (row?.provider_sandbox_id) {
      if (!this.provider) throw new ApiError(503, "terminal_provider_unavailable", "The existing Terminal workspace could not be cleared in this region. Retry when Terminal is available.");
      try {
        await this.provider.clearGitHubReadAccess(row.provider_sandbox_id);
      } catch (error) {
        logWarn(this.env, "terminal_github_credential_cleanup_failed", {
          workspace_id: this.auth.workspaceId,
          workstream_id: workstreamId,
          sandbox_id: row.provider_sandbox_id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      await this.provider.deleteSandbox(row.provider_sandbox_id);
    }
    const [deleted] = await database.batch([
      row
        ? database.prepare(
          "DELETE FROM workstream_sandboxes WHERE workspace_id = ? AND workstream_id = ? AND generation = ?",
        ).bind(this.auth.workspaceId, workstreamId, row.generation)
        : database.prepare(
          "DELETE FROM workstream_sandboxes WHERE workspace_id = ? AND workstream_id = ?",
        ).bind(this.auth.workspaceId, workstreamId),
      database.prepare(
        `UPDATE workstream_terminal_repositories
            SET bootstrapped_sandbox_generation = NULL, read_token_expires_at = NULL, updated_at = ?
          WHERE workspace_id = ? AND workstream_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM workstream_sandboxes sandbox
               WHERE sandbox.workspace_id = ? AND sandbox.workstream_id = ?
            )`,
      ).bind(
        nowIso(),
        this.auth.workspaceId,
        workstreamId,
        this.auth.workspaceId,
        workstreamId,
      ),
    ]);
    if (row && Number(deleted?.meta.changes ?? 0) !== 1) {
      throw new ApiError(
        409,
        "terminal_workspace_changed",
        "The Terminal workspace changed while it was being cleared. Reload it before starting fresh.",
      );
    }
  }

  private async requireVisible(workstreamId: string): Promise<void> {
    const authority = await readWorkstreamAuthorityControl(this.env);
    const visible = authority.phase === "durable_object_open"
      ? await new WorkstreamDirectoryService(this.env, this.auth).visible(workstreamId)
      : Boolean(await this.env.DB.prepare(
        `SELECT 1 FROM workstreams workstream
          WHERE workstream.id = ? AND workstream.workspace_id = ?
            AND workstream.archived_at IS NULL
            AND (workstream.scope = 'workspace' OR workstream.created_by_user_id = ?
              OR EXISTS (SELECT 1 FROM workstream_participants participant
                  WHERE participant.workstream_id = workstream.id
                    AND participant.user_id = ? AND participant.removed_at IS NULL))`,
      ).bind(
        workstreamId,
        this.auth.workspaceId,
        this.auth.userId,
        this.auth.userId,
      ).first());
    if (!visible) {
      throw new ApiError(404, "workstream_not_found", "Work stream not found");
    }
  }

  private async requireParticipant(workstreamId: string): Promise<void> {
    await this.requireVisible(workstreamId);
    const participant = await (await workstreamExecutionEnvironment(
      this.env,
      this.auth.workspaceId,
      workstreamId,
    )).DB.prepare(
      `SELECT user_id FROM workstream_participants
        WHERE workstream_id = ? AND user_id = ? AND removed_at IS NULL`,
    ).bind(workstreamId, this.auth.userId).first<{ user_id: string }>();
    if (!participant) throw new ApiError(403, "workstream_participant_required", "Join this work stream before selecting or replacing its Terminal repository.");
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
    "user-agent": "Avalon-Terminal-Catalog",
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
    if (!config) throw new ApiError(503, "github_app_unavailable", "The regional Avalon GitHub App is not configured.");
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
    if (!connectorConfig) throw new ApiError(503, "github_app_unavailable", "The regional Avalon GitHub App is not configured.");
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
