import type { HarnessToolContext } from "@avalon/agent-harness";
import {
  githubRepositoryAuthorization,
  type GitHubRepositoryAccessLevel,
} from "@avalon/connectors";
import { nowIso } from "@avalon/db";

import type { Env } from "../../env";
import { sha256 } from "../../lib/crypto";
import { allocateWorkstreamEmailAddressCandidate } from "../../lib/workstream-email-address";
import { logWarn } from "../../observability/logger";
import type { TerminalSandboxCoordinator } from "./coordinator";
import type { TerminalSandboxProvider } from "./daytona-provider";
import { createTerminalWorkspaceBackup, type TerminalWorkspaceBackup } from "./lifecycle";
import { admitTerminalPublicationGrant } from "./repository";
import type {
  TerminalRepositoryCatalogGateway,
  TerminalResolvedRepository,
} from "./workstream-state";
import { TerminalToolError } from "./tools";

interface ConnectionRow {
  id: string;
  display_name: string;
  config_json: string;
  scope: "personal" | "workspace";
  owner_user_id: string | null;
}

interface CurrentRepositoryRow {
  connection_id: string;
  repository_id: number;
  repository_full_name: string;
  base_ref: string;
  base_sha: string;
  head_ref: string;
  state: "selected" | "revoked";
}

export interface TerminalCheckoutRepositoryOutput {
  repository: string;
  repositoryId: number;
  connectionId: string;
  connectionName: string;
  baseRef: string;
  baseSha: string;
  headRef: string;
  remoteAccess: GitHubRepositoryAccessLevel;
  localEditsAllowed: true;
  remoteWritesAllowed: boolean;
  outcome: "selected" | "already_selected";
  backup: TerminalWorkspaceBackup | null;
}

export interface TerminalRepositorySelector {
  checkout(
    context: HarnessToolContext,
    input: {
      repositoryFullName: string;
      requiredRemoteAccess: GitHubRepositoryAccessLevel;
    },
  ): Promise<TerminalCheckoutRepositoryOutput>;
}

function parseConfig(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function accessSatisfies(
  available: GitHubRepositoryAccessLevel,
  required: GitHubRepositoryAccessLevel,
): boolean {
  return required === "read_only" || available === "full_access";
}

const AVALON_BRANCH_PATTERN = /^avalon\/[a-z]+-[a-z]+-[a-z]+-[a-z]+$/u;

async function workstreamBranchRef(
  env: Pick<Env, "DB" | "SESSION_SIGNING_KEY">,
  workspaceId: string,
  workstreamId: string,
  currentHeadRef: string | null,
): Promise<string> {
  if (currentHeadRef && AVALON_BRANCH_PATTERN.test(currentHeadRef)) return currentHeadRef;
  const workstream = await env.DB.prepare(
    "SELECT email_address FROM workstreams WHERE workspace_id = ? AND id = ?",
  ).bind(workspaceId, workstreamId).first<{ email_address: string | null }>();
  const localPart = workstream?.email_address?.split("@", 1)[0];
  const slug = localPart && /^[a-z]+-[a-z]+-[a-z]+-[a-z]+$/u.test(localPart)
    ? localPart
    : await allocateWorkstreamEmailAddressCandidate({
      secretKey: await sha256(`terminal-branch:${env.SESSION_SIGNING_KEY}`),
      workstreamId: `${workspaceId}:${workstreamId}`,
    });
  return `avalon/${slug}`;
}

export function createTerminalRepositorySelector(
  env: Env,
  provider: TerminalSandboxProvider,
  catalog: TerminalRepositoryCatalogGateway,
  coordinator: TerminalSandboxCoordinator,
): TerminalRepositorySelector {
  return {
    async checkout(context, input) {
      if (context.executionPrincipal.type !== "user") {
        throw new TerminalToolError(
          "repository_user_authority_required",
          "Repository checkout requires an active participant's user authority. Run this work stream from an active participant account.",
          { reason: "A workspace automation cannot choose a repository until it has explicit repository authority." },
        );
      }
      const participant = await env.DB.prepare(
        `SELECT participant.user_id
           FROM workstream_participants participant
           JOIN workspace_members member
             ON member.workspace_id = ? AND member.user_id = participant.user_id
          WHERE participant.workstream_id = ? AND participant.user_id = ?
            AND participant.removed_at IS NULL AND member.status = 'active'`,
      ).bind(context.workspaceId, context.workstreamId, context.executionPrincipal.userId)
        .first<{ user_id: string }>();
      if (!participant) {
        throw new TerminalToolError(
          "repository_user_authority_required",
          "The requesting user is no longer an active participant in this work stream. Repository checkout was not changed.",
          { reason: "Ask an active participant to run the repository task." },
        );
      }
      const connections = await env.DB.prepare(
        `SELECT id, display_name, COALESCE(config_json, '{}') AS config_json, scope, owner_user_id
           FROM connector_connections
          WHERE workspace_id = ? AND connector_type = 'github' AND status <> 'disabled'
            AND (scope = 'workspace' OR owner_user_id = ?)
          ORDER BY CASE scope WHEN 'personal' THEN 0 ELSE 1 END, created_at, id`,
      ).bind(context.workspaceId, context.executionPrincipal.userId).all<ConnectionRow>();

      const candidates: Array<{
        connection: ConnectionRow;
        repository: TerminalResolvedRepository;
        remoteAccess: GitHubRepositoryAccessLevel;
      }> = [];
      for (const connection of connections.results ?? []) {
        const config = parseConfig(connection.config_json);
        let repository: TerminalResolvedRepository;
        try {
          repository = await catalog.resolveRepository(
            connection.id,
            context.workspaceId,
            input.repositoryFullName,
            context.signal,
          );
        } catch {
          continue;
        }
        const verified = githubRepositoryAuthorization(config, repository.fullName, repository.id);
        if (!verified || !accessSatisfies(verified.access, input.requiredRemoteAccess)) continue;
        candidates.push({ connection, repository, remoteAccess: verified.access });
      }
      if (candidates.length === 0) {
        const requirement = input.requiredRemoteAccess === "full_access"
          ? " with full remote access"
          : "";
        throw new TerminalToolError(
          "repository_not_authorized",
          `${input.repositoryFullName} is not available${requirement} through the active GitHub connector policy. Use GitHub repository search to choose an authorized repository, or ask a connector administrator to update GitHub settings.`,
          { field: "repositoryFullName", expected: `an exact owner/name authorized${requirement}` },
        );
      }
      // A read-only request prefers a read-only connection. Asking for full
      // access is an explicit model choice and filters candidates above.
      candidates.sort((left, right) => (
        Number(left.remoteAccess === "full_access") - Number(right.remoteAccess === "full_access")
      ));
      const selected = candidates[0]!;
      const current = await env.DB.prepare(
        `SELECT connection_id, repository_id, repository_full_name, base_ref, base_sha, head_ref, state
           FROM workstream_terminal_repositories
          WHERE workspace_id = ? AND workstream_id = ?`,
      ).bind(context.workspaceId, context.workstreamId).first<CurrentRepositoryRow>();
      const sameRepositoryIdentity = (
        current?.state === "selected"
        && current.connection_id === selected.connection.id
        && current.repository_id === selected.repository.id
      );
      const unchangedSelection = (
        sameRepositoryIdentity
        && current.repository_full_name === selected.repository.fullName
        && current.base_ref === selected.repository.defaultBranch
        && current.base_sha === selected.repository.baseSha
      );
      const headRef = sameRepositoryIdentity
        ? current!.head_ref
        : await workstreamBranchRef(
          env,
          context.workspaceId,
          context.workstreamId,
          current?.head_ref ?? null,
        );
      if (unchangedSelection) {
        return output("already_selected", null);
      }

      const sandbox = await coordinator.claimMutation(context);

      const activeTasks = await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM sandbox_tasks
          WHERE workspace_id = ? AND workstream_id = ?
            AND state IN ('planned', 'submitting', 'running')`,
      ).bind(context.workspaceId, context.workstreamId).first<{ count: number }>();
      if (Number(activeTasks?.count ?? 0) > 0) {
        throw new TerminalToolError(
          "workspace_busy",
          "Another Terminal command is still using this workspace. Wait for it to finish, then retry repository checkout; no repository or files were changed.",
          { reason: "Retry after every active Terminal command has completed." },
        );
      }
      let backup: TerminalWorkspaceBackup | null = null;
      if (sandbox.providerSandboxId) {
        const priorState = sandbox.state;
        let temporarilyStarted = false;
        let providerDeleted = false;
        const restorePriorState = async (): Promise<void> => {
          if (!temporarilyStarted || providerDeleted) return;
          await provider.stopSandbox(sandbox.providerSandboxId!);
          if (priorState === "archived") await provider.archiveSandbox(sandbox.providerSandboxId!);
        };
        try {
          if (sandbox.state === "stopped" || sandbox.state === "archived") {
            await provider.startSandbox(sandbox.providerSandboxId);
            temporarilyStarted = true;
          } else if (sandbox.state !== "running") {
            throw new TerminalToolError(
              "workspace_busy",
              `The Terminal workspace is currently ${sandbox.state}. Wait for that lifecycle transition to finish, then retry repository checkout.`,
              { reason: "Retry after the Terminal workspace is running, stopped, or archived." },
            );
          }
          backup = await createTerminalWorkspaceBackup(env, provider, {
            workspaceId: context.workspaceId,
            workstreamId: context.workstreamId,
            toolCallId: context.toolCallId,
            repositoryFullName: selected.repository.fullName,
            providerSandboxId: sandbox.providerSandboxId,
            generation: sandbox.generation,
            signal: context.signal,
          });
          try {
            await provider.clearGitHubReadAccess(sandbox.providerSandboxId);
          } catch (error) {
            logWarn(env, "terminal_github_credential_cleanup_failed", {
              workspace_id: context.workspaceId,
              workstream_id: context.workstreamId,
              sandbox_id: sandbox.providerSandboxId,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
          await provider.deleteSandbox(sandbox.providerSandboxId);
          providerDeleted = true;
        } catch (error) {
          try {
            await restorePriorState();
          } catch (restoreError) {
            logWarn(env, "terminal_repository_replacement_restore_failed", {
              workspace_id: context.workspaceId,
              workstream_id: context.workstreamId,
              sandbox_id: sandbox.providerSandboxId,
              prior_state: priorState,
              reason: restoreError instanceof Error ? restoreError.message : String(restoreError),
            });
          }
          throw error;
        }
      }
      const timestamp = nowIso();
      const [sandboxDeletion] = await env.DB.batch([
        env.DB.prepare(
          `DELETE FROM workstream_sandboxes
            WHERE workspace_id = ? AND workstream_id = ?
              AND generation = ?`,
        ).bind(
          context.workspaceId,
          context.workstreamId,
          sandbox.generation,
        ),
        env.DB.prepare(
          `INSERT INTO workstream_terminal_repositories
           (workspace_id, workstream_id, connection_id, repository_id, repository_full_name,
            base_ref, base_sha, head_ref, state, selected_by_user_id, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'selected', ?, ?, ?
            WHERE NOT EXISTS (
              SELECT 1 FROM workstream_sandboxes sandbox
               WHERE sandbox.workspace_id = ? AND sandbox.workstream_id = ?
            )
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
          context.workspaceId,
          context.workstreamId,
          selected.connection.id,
          selected.repository.id,
          selected.repository.fullName,
          selected.repository.defaultBranch,
          selected.repository.baseSha,
          headRef,
          context.executionPrincipal.userId,
          timestamp,
          timestamp,
          context.workspaceId,
          context.workstreamId,
        ),
      ]);
      if (Number(sandboxDeletion?.meta.changes ?? 0) !== 1) {
        throw new TerminalToolError(
          "sandbox_busy",
          "The Terminal workspace changed while its repository was being replaced. Retry checkout so Avalon can reconcile the current sandbox generation.",
          { reason: "Retry repository checkout against the current Terminal workspace generation." },
        );
      }
      const run = await env.DB.prepare(
        "SELECT trigger_message_id FROM harness_runs WHERE workspace_id = ? AND workstream_id = ? AND id = ?",
      ).bind(context.workspaceId, context.workstreamId, context.harnessRunId)
        .first<{ trigger_message_id: string | null }>();
      await admitTerminalPublicationGrant(env, {
        workspaceId: context.workspaceId,
        workstreamId: context.workstreamId,
        harnessRunId: context.harnessRunId,
        triggerMessageId: run?.trigger_message_id ?? null,
        executionPrincipal: context.executionPrincipal,
      });
      return output("selected", backup);

      function output(
        outcome: TerminalCheckoutRepositoryOutput["outcome"],
        captured: TerminalWorkspaceBackup | null,
      ): TerminalCheckoutRepositoryOutput {
        return {
          repository: selected.repository.fullName,
          repositoryId: selected.repository.id,
          connectionId: selected.connection.id,
          connectionName: selected.connection.display_name,
          baseRef: selected.repository.defaultBranch,
          baseSha: selected.repository.baseSha,
          headRef,
          remoteAccess: selected.remoteAccess,
          localEditsAllowed: true,
          remoteWritesAllowed: selected.remoteAccess === "full_access",
          outcome,
          backup: captured,
        };
      }
    },
  };
}
