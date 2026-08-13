import { createGitHubAppJwt } from "@avalon/connectors";
import { nowIso } from "@avalon/db";

import type { AuthContext, Env } from "../../env";
import { ApiError } from "../../lib/api-error";
import { githubConnectorConfig } from "../../lib/connector-registry";
import { WORKSTREAM_VISIBILITY_SQL, workstreamVisibilityBindings } from "../../lib/workstream-visibility";
import { parseTerminalRegionConfiguration } from "./contract";
import type { TerminalSandboxProvider } from "./daytona-provider";
import { createTerminalFinalDiffPreserver } from "./lifecycle";

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
  listRepositories(connectionId: string, workspaceId: string, signal: AbortSignal): Promise<TerminalCatalogRepository[]>;
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
  repository_id: number;
  repository_full_name: string;
  base_ref: string;
  base_sha: string;
  head_ref: string;
  state: "selected" | "revoked";
}

interface ConnectionRow { id: string; display_name: string | null }

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
    private readonly catalog: TerminalRepositoryCatalogGateway,
    private readonly provider: TerminalSandboxProvider | null = null,
  ) {}

  async get(workstreamId: string) {
    await this.requireVisible(workstreamId);
    const [sandbox, repository] = await Promise.all([
      this.env.DB.prepare(
        `SELECT state, provider_sandbox_id, last_activity_at, expire_due_at,
                final_diff_resource_id, failure_code
           FROM workstream_sandboxes WHERE workspace_id = ? AND workstream_id = ?`,
      ).bind(this.auth.workspaceId, workstreamId).first<SandboxStateRow>(),
      this.env.DB.prepare(
        `SELECT repository_id, repository_full_name, base_ref, base_sha, head_ref, state
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

  async repositories(workstreamId: string, signal: AbortSignal) {
    await this.requireParticipant(workstreamId);
    const connections = await this.env.DB.prepare(
      `SELECT id, display_name FROM connector_connections
        WHERE workspace_id = ? AND connector_type = 'github' AND status = 'healthy'
        ORDER BY created_at, id`,
    ).bind(this.auth.workspaceId).all<ConnectionRow>();
    if ((connections.results ?? []).length === 0) return { state: "disconnected" as const, connections: [] };
    const available = [];
    for (const connection of connections.results ?? []) {
      const repositories = await this.catalog.listRepositories(connection.id, this.auth.workspaceId, signal);
      available.push({
        connectionId: connection.id,
        displayName: connection.display_name ?? "GitHub",
        repositories,
      });
    }
    return {
      state: available.some((connection) => connection.repositories.length > 0) ? "available" as const : "empty" as const,
      connections: available,
    };
  }

  async selectRepository(
    workstreamId: string,
    input: { connectionId: string; repositoryFullName: string; confirmDiscardLocalFiles?: boolean | undefined },
    signal: AbortSignal,
  ) {
    await this.requireParticipant(workstreamId);
    const connection = await this.env.DB.prepare(
      `SELECT id FROM connector_connections
        WHERE workspace_id = ? AND id = ? AND connector_type = 'github' AND status = 'healthy'`,
    ).bind(this.auth.workspaceId, input.connectionId).first<{ id: string }>();
    if (!connection) throw new ApiError(409, "github_connection_revoked", "That GitHub connection is no longer available. Reconnect GitHub and choose the repository again.");
    let resolved: TerminalResolvedRepository;
    try {
      resolved = await this.catalog.resolveRepository(
        input.connectionId,
        this.auth.workspaceId,
        input.repositoryFullName,
        signal,
      );
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(422, "github_repository_unavailable", "That repository is not available to the selected GitHub App installation. Reload the repository list and choose an accessible repository.");
    }
    if (resolved.fullName.toLowerCase() !== input.repositoryFullName.toLowerCase()) {
      throw new ApiError(422, "github_repository_identity_mismatch", "GitHub returned a different repository identity. Reload the repository list and select it again.");
    }
    if (!/^[0-9a-f]{40}$/u.test(resolved.baseSha)) {
      throw new ApiError(502, "github_response_invalid", "GitHub returned an invalid base revision. Retry repository selection.");
    }
    const retained = await this.env.DB.prepare(
      `SELECT state FROM workstream_sandboxes
        WHERE workspace_id = ? AND workstream_id = ?
          AND state NOT IN ('absent', 'expired', 'failed')`,
    ).bind(this.auth.workspaceId, workstreamId).first<{ state: string }>();
    if (retained && input.confirmDiscardLocalFiles !== true) {
      throw new ApiError(
        409,
        "terminal_local_files_confirmation_required",
        "Replacing the repository destroys retained local Terminal files after Avalon saves the final Git diff. Confirm that unpublished scratch files may be discarded, then retry the selection.",
      );
    }
    await this.destroyCurrentSandbox(workstreamId, true);
    const timestamp = nowIso();
    await this.env.DB.prepare(
      `INSERT INTO workstream_terminal_repositories
       (workspace_id, workstream_id, connection_id, repository_id, repository_full_name,
        base_ref, base_sha, head_ref, state, selected_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'selected', ?, ?, ?)
       ON CONFLICT(workspace_id, workstream_id) DO UPDATE SET
         connection_id = excluded.connection_id,
         repository_id = excluded.repository_id,
         repository_full_name = excluded.repository_full_name,
         base_ref = excluded.base_ref,
         base_sha = excluded.base_sha,
         head_ref = excluded.head_ref,
         state = 'selected',
         bootstrapped_sandbox_generation = NULL,
         read_token_expires_at = NULL,
         selected_by_user_id = excluded.selected_by_user_id,
         updated_at = excluded.updated_at`,
    ).bind(
      this.auth.workspaceId,
      workstreamId,
      input.connectionId,
      resolved.id,
      resolved.fullName,
      resolved.defaultBranch,
      resolved.baseSha,
      `avalon/${workstreamId}`,
      this.auth.userId,
      timestamp,
      timestamp,
    ).run();
    return this.get(workstreamId);
  }

  async startFresh(workstreamId: string) {
    await this.requireParticipant(workstreamId);
    const state = await this.env.DB.prepare(
      "SELECT state FROM workstream_sandboxes WHERE workspace_id = ? AND workstream_id = ?",
    ).bind(this.auth.workspaceId, workstreamId).first<{ state: string }>();
    if (state && !["expired", "failed"].includes(state.state)) {
      throw new ApiError(409, "terminal_workspace_still_retained", "This Terminal workspace is still retained. Continue using it instead of starting a fresh workspace.");
    }
    await this.destroyCurrentSandbox(workstreamId);
    return this.get(workstreamId);
  }

  private async destroyCurrentSandbox(workstreamId: string, preserveFinalDiff = false): Promise<void> {
    const row = await this.env.DB.prepare(
      "SELECT provider_sandbox_id, state, generation FROM workstream_sandboxes WHERE workspace_id = ? AND workstream_id = ?",
    ).bind(this.auth.workspaceId, workstreamId).first<{ provider_sandbox_id: string | null; state: string; generation: number }>();
    if (row?.provider_sandbox_id) {
      if (!this.provider) throw new ApiError(503, "terminal_provider_unavailable", "The existing Terminal workspace could not be cleared in this region. Retry when Terminal is available.");
      if (preserveFinalDiff) {
        if (row.state === "stopped" || row.state === "archived") await this.provider.startSandbox(row.provider_sandbox_id);
        await createTerminalFinalDiffPreserver(
          this.env,
          this.provider,
          this.auth.workspaceId,
          workstreamId,
        )(row.provider_sandbox_id, row.generation);
      }
      await this.provider.clearGitHubReadAccess(row.provider_sandbox_id).catch(() => undefined);
      await this.provider.deleteSandbox(row.provider_sandbox_id);
    }
    await this.env.DB.batch([
      this.env.DB.prepare("DELETE FROM workstream_sandboxes WHERE workspace_id = ? AND workstream_id = ?").bind(this.auth.workspaceId, workstreamId),
      this.env.DB.prepare(
        `UPDATE workstream_terminal_repositories
            SET bootstrapped_sandbox_generation = NULL, read_token_expires_at = NULL, updated_at = ?
          WHERE workspace_id = ? AND workstream_id = ?`,
      ).bind(nowIso(), this.auth.workspaceId, workstreamId),
    ]);
  }

  private async requireVisible(workstreamId: string): Promise<void> {
    const row = await this.env.DB.prepare(
      `SELECT w.id FROM workstreams w
        WHERE w.id = ? AND w.workspace_id = ? AND w.archived_at IS NULL
          AND ${WORKSTREAM_VISIBILITY_SQL}`,
    ).bind(workstreamId, this.auth.workspaceId, ...workstreamVisibilityBindings(this.auth.userId)).first<{ id: string }>();
    if (!row) throw new ApiError(404, "workstream_not_found", "Work stream not found");
  }

  private async requireParticipant(workstreamId: string): Promise<void> {
    await this.requireVisible(workstreamId);
    const participant = await this.env.DB.prepare(
      `SELECT user_id FROM workstream_participants
        WHERE workstream_id = ? AND user_id = ? AND removed_at IS NULL`,
    ).bind(workstreamId, this.auth.userId).first<{ user_id: string }>();
    if (!participant) throw new ApiError(403, "workstream_participant_required", "Join this work stream before selecting or replacing its Terminal repository.");
  }
}

interface GitHubConnection { provider_account_id: string | null }

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
  async function installationToken(connectionId: string, workspaceId: string, signal: AbortSignal): Promise<string> {
    const connection = await env.DB.prepare(
      `SELECT provider_account_id FROM connector_connections
        WHERE id = ? AND workspace_id = ? AND connector_type = 'github' AND status = 'healthy'`,
    ).bind(connectionId, workspaceId).first<GitHubConnection>();
    if (!connection?.provider_account_id || !/^\d+$/u.test(connection.provider_account_id)) {
      throw new ApiError(409, "github_connection_revoked", "The GitHub App connection is unavailable. Reconnect GitHub and retry.");
    }
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
  return {
    async listRepositories(connectionId, workspaceId, signal) {
      const token = await installationToken(connectionId, workspaceId, signal);
      const repositories: TerminalCatalogRepository[] = [];
      for (let page = 1; page <= 10; page += 1) {
        const value = await responseValue(await fetch(`${api}/installation/repositories?per_page=100&page=${page}`, { headers: headers(token), signal }));
        const entries = Array.isArray(value.repositories) ? value.repositories : [];
        repositories.push(...entries.map((entry) => repositoryValue(entry as Record<string, unknown>)));
        if (entries.length < 100) break;
      }
      return repositories.sort((left, right) => left.fullName.localeCompare(right.fullName));
    },
    async resolveRepository(connectionId, workspaceId, repositoryFullName, signal) {
      const token = await installationToken(connectionId, workspaceId, signal);
      const repository = repositoryValue(await responseValue(await fetch(`${api}/repos/${repositoryFullName}`, { headers: headers(token), signal })));
      const encodedRef = repository.defaultBranch.split("/").map(encodeURIComponent).join("/");
      const ref = await responseValue(await fetch(`${api}/repos/${repository.fullName}/git/ref/heads/${encodedRef}`, { headers: headers(token), signal }));
      const object = ref.object && typeof ref.object === "object" ? ref.object as Record<string, unknown> : {};
      const baseSha = String(object.sha ?? "");
      return { ...repository, baseSha };
    },
  };
}
