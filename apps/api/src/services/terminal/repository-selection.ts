import type { HarnessToolContext } from "@rally/agent-harness";
import { createTerminalPortFactory, type TerminalPortFactory } from "./object-port";
import { asWorkspaceId } from "@rally/contracts";
import {
  githubRepositoryAuthorization,
  type GitHubRepositoryAccessLevel,
} from "@rally/connectors";
import { newId } from "@rally/db";

import type { Env } from "../../env";
import { sha256 } from "../../lib/crypto";
import { allocateWorkstreamEmailAddressCandidate } from "../../lib/workstream-email-address";
import { logWarn } from "../../observability/logger";
import type { WorkstreamRuntimeResourceAttacher } from "../workstream-object-client";
import {
  emitProductUsageTelemetry,
  telemetryJourneyDuration,
} from "../../telemetry/product-usage";
import type { TerminalSandboxCoordinator } from "./coordinator";
import type { TerminalSandboxProvider } from "./provider-contract";
import { createTerminalWorkspaceBackup, type TerminalWorkspaceBackup } from "./lifecycle";
import { admitTerminalPublicationGrant } from "./repository";
import type {
  TerminalRepositoryCatalogGateway,
  TerminalResolvedRepository,
} from "./workstream-state";
import { TerminalToolError } from "./tools";
import { createHarnessRunObjectPort } from "../../runtime/harness-run-port";
import { createIdentityObjectPort } from "../../runtime/identity-port";

interface ConnectionRow {
  id: string;
  display_name: string;
  config_json: string;
  scope: "personal" | "workspace";
  owner_user_id: string | null;
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
  env: Env,
  workspaceId: string,
  workstreamId: string,
  currentHeadRef: string | null,
): Promise<string> {
  if (currentHeadRef && AVALON_BRANCH_PATTERN.test(currentHeadRef)) return currentHeadRef;
  const workstream = await createIdentityObjectPort(env, workspaceId, workstreamId)
    .identity();
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
  terminalPortFactory: TerminalPortFactory = createTerminalPortFactory(env),
  inObjectResourceAttacher?: WorkstreamRuntimeResourceAttacher,
): TerminalRepositorySelector {
  return {
    async checkout(context, input) {
      const telemetryStartedAt = Date.now();
      if (context.executionPrincipal.type !== "user") {
        throw new TerminalToolError(
          "repository_user_authority_required",
          "Repository checkout requires an active participant's user authority. Run this work stream from an active participant account.",
          { reason: "A workspace automation cannot choose a repository until it has explicit repository authority." },
        );
      }
      const requesterUserId = context.executionPrincipal.userId;
      const participant = (await createIdentityObjectPort(
        env,
        context.workspaceId,
        context.workstreamId,
      ).participants()).find((row) => row.user_id === requesterUserId);
      const member = participant
        ? await env.DB.prepare(
          `SELECT user_id FROM workspace_members
            WHERE workspace_id = ? AND user_id = ? AND status = 'active'`,
        ).bind(context.workspaceId, context.executionPrincipal.userId).first<{ user_id: string }>()
        : null;
      if (!participant || !member) {
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
        policyAccess: GitHubRepositoryAccessLevel;
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
        candidates.push({
          connection,
          repository,
          remoteAccess: input.requiredRemoteAccess,
          policyAccess: verified.access,
        });
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
        Number(left.policyAccess === "full_access") - Number(right.policyAccess === "full_access")
      ));
      const selected = candidates[0]!;
      const terminal = terminalPortFactory(context.workspaceId, context.workstreamId);
      const current = await terminal.repository();
      const sameRepositoryIdentity = (
        current?.state === "selected"
        && current.connectionId === selected.connection.id
        && current.repositoryId === selected.repository.id
      );
      const unchangedSelection = (
        sameRepositoryIdentity
        && current.repositoryFullName === selected.repository.fullName
        && current.baseRef === selected.repository.defaultBranch
        && current.baseSha === selected.repository.baseSha
        && current.remoteAccess === selected.remoteAccess
      );
      const headRef = sameRepositoryIdentity
        ? current!.headRef
        : await workstreamBranchRef(
          env,
          context.workspaceId,
          context.workstreamId,
          current?.headRef ?? null,
        );
      if (unchangedSelection) {
        return output("already_selected", null);
      }

      const sandbox = await coordinator.claimMutation(context);

      if (await terminal.unsettledTaskCount() > 0) {
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
          }, inObjectResourceAttacher);
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
      const replaced = await terminal.replaceRepository({
        generation: sandbox.generation,
        connectionId: selected.connection.id,
        repositoryId: selected.repository.id,
        repositoryFullName: selected.repository.fullName,
        baseRef: selected.repository.defaultBranch,
        baseSha: selected.repository.baseSha,
        headRef,
        remoteAccess: selected.remoteAccess,
        selectedByUserId: context.executionPrincipal.userId,
        now: Date.now(),
      });
      if (!replaced) {
        throw new TerminalToolError(
          "sandbox_busy",
          "The Terminal workspace changed while its repository was being replaced. Retry checkout so Rally can reconcile the current sandbox generation.",
          { reason: "Retry repository checkout against the current Terminal workspace generation." },
        );
      }
      const triggerMessageId = await createHarnessRunObjectPort(
        env,
        context.workspaceId,
        context.workstreamId,
      ).triggerPartId({ runId: context.harnessRunId });
      await admitTerminalPublicationGrant(env, {
        workspaceId: context.workspaceId,
        workstreamId: context.workstreamId,
        harnessRunId: context.harnessRunId,
        triggerMessageId,
        executionPrincipal: context.executionPrincipal,
      }, new Date(), terminalPortFactory);
      emitProductUsageTelemetry(env, {
        workspaceId: asWorkspaceId(context.workspaceId),
        userId: context.executionPrincipal.userId,
        name: "terminal_workspace_terminal",
        properties: {
          workstreamId: context.workstreamId,
          action: current?.state === "selected" ? "repository_replace" : "repository_select",
          result: "success",
          duration: telemetryJourneyDuration(Date.now() - telemetryStartedAt),
          repositorySelected: true,
          connectorType: "github",
          localFilesRetained: false,
        },
        operationId: context.harnessRunId,
        eventId: newId(),
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
