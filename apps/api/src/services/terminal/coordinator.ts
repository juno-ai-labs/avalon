import type { HarnessToolContext } from "@rally/agent-harness";
import { newId } from "@rally/db";

import { sha256 } from "../../lib/crypto";
import { logStructuredEvent } from "../../observability/logger";
import {
  executionPrincipalKey,
} from "../workstream-resource-visibility";
import {
  isTerminalProviderNotFound,
  type TerminalSandboxProvider,
  type TerminalSandboxSnapshot,
  type TerminalSandboxState,
} from "./provider-contract";
import {
  compileTerminalNetworkPolicy,
  TERMINAL_NETWORK_MANIFEST_VERSION,
} from "./network-policy";
import type { ResourcePortFactory } from "../../runtime/resource-port";
import { TERMINAL_OUTPUT_ROOT } from "./contract";
import type { TerminalPortFactory } from "./object-port";
import {
  TERMINAL_OPERATION_LEASE_MS,
  type TerminalSandboxRecord,
} from "../../durable-objects/workstream-terminal-storage";
import type {
  TerminalObjectPort,
} from "../../durable-objects/workstream-terminal-protocol";
import { TerminalToolError } from "./tools";
import { asWorkspaceId } from "@rally/contracts";
import type { Env } from "../../env";
import { workspaceDOName } from "../../durable-objects/names";
import { WorkspaceNoteVisibilityResultSchema } from "../../durable-objects/workspace-notes-protocol";
import {
  WorkspaceTerminalNetworkSettingsSchema,
  type WorkspaceTerminalNetworkPolicy,
} from "../../durable-objects/workspace-terminal-network-protocol";
import { durableObjectStubForWorkspace } from "../../lib/durable-object-namespace";

const WARM_STOP_MINUTES = 5;
const ARCHIVE_MINUTES = 60;
const EXPIRE_DAYS = 30;

export interface TerminalClock {
  now(): Date;
}

const systemClock: TerminalClock = { now: () => new Date() };

interface RepositoryAuthorityRow {
  connection_id: string;
  repository_full_name: string;
  base_ref: string;
  base_sha: string;
  head_ref: string;
}

export interface AcquiredTerminalSandbox {
  providerSandboxId: string;
  stableName: string;
  generation: number;
  state: "running";
  authorityFingerprint: string;
  networkRevision: number;
  /** Exclusive operation lease boundary; reacquire only after this instant. */
  operationLeaseExpiresAt: number;
}

export interface TerminalSandboxMutationLease {
  providerSandboxId: string | null;
  state: string;
  generation: number;
}

export interface TerminalAcquisitionObservation {
  action: "start" | "restore" | "repository_replace" | "start_fresh";
  durationMs: number;
  repositorySelected: boolean;
  localFilesRetained: boolean;
}

function plusMinutes(now: Date, minutes: number): number {
  return now.getTime() + minutes * 60_000;
}

function plusDays(now: Date, days: number): number {
  return now.getTime() + days * 86_400_000;
}

/** The three deadlines every sandbox transition pushes out together. */
function deadlines(now: Date): {
  idleExpiresAt: number;
  archiveDueAt: number;
  expireDueAt: number;
} {
  return {
    idleExpiresAt: plusMinutes(now, WARM_STOP_MINUTES),
    archiveDueAt: plusMinutes(now, ARCHIVE_MINUTES),
    expireDueAt: plusDays(now, EXPIRE_DAYS),
  };
}

function requireStableName(row: TerminalSandboxRecord): string {
  if (!row.stableName) throw new Error("terminal_sandbox_stable_name_missing");
  return row.stableName;
}

function providerStateError(state: TerminalSandboxState): TerminalToolError {
  return new TerminalToolError(
    "sandbox_unavailable",
    `The Terminal sandbox could not be made ready (provider state: ${state}). Retry the tool; Rally replaces the workspace itself once Daytona reports it lost.`,
    { retryAfterMs: 5_000, reason: `Retry once after Daytona leaves its ${state} state.` },
  );
}

/**
 * A provider state Rally cannot use and cannot wait out.
 *
 * `expired` is Daytona's destroyed sandbox and `failed` covers its error
 * states — including an archived sandbox whose restore found no completed
 * backup. Neither becomes usable by retrying, and the row would otherwise name
 * it until the thirty-day expiry.
 */
function isLostProviderSandbox(state: TerminalSandboxState): boolean {
  return state === "expired" || state === "failed";
}

function parseEffectiveDomains(policy: WorkspaceTerminalNetworkPolicy): string[] {
  if (policy.effectiveDomains.length > 0) return policy.effectiveDomains;
  throw new TerminalToolError(
    "network_policy_unverified",
    "The workspace Terminal network policy is invalid. Ask a workspace owner to save and verify it again.",
    { reason: "Ask a workspace owner to save and verify the Terminal network policy." },
  );
}

export class TerminalSandboxCoordinator {
  constructor(
    /**
     * Workspace-scoped and cross-authority reads: connector rows in
     * WorkspaceDO and the resource/note visibility joins still go through the
     * runtime port on `env.DB`; the network policy is a typed method.
     * Terminal's own tables are reached through `terminalPort`.
     */
    /**
     * The Worker environment, for the regional reads below and for the
     * WorkspaceDO that owns the Terminal network policy. It used to be the
     * D1-shaped runtime port alone, which is how a policy read reached a
     * router rather than the object that holds the table.
     */
    private readonly env: Env,
    private readonly terminalPort: TerminalPortFactory,
    /** The work stream's attachment authority, for the revoked-import check. */
    private readonly resourcePort: ResourcePortFactory,
    private readonly provider: TerminalSandboxProvider,
    private readonly clock: TerminalClock = systemClock,
    private readonly lifecycleChanged?: (workspaceId: string) => Promise<void>,
    private readonly emergencyDisabled = false,
    private readonly acquisitionObserved?: (
      context: HarnessToolContext,
      observation: TerminalAcquisitionObservation,
    ) => Promise<void>,
  ) {}

  async claimMutation(context: HarnessToolContext): Promise<TerminalSandboxMutationLease> {
    if (this.emergencyDisabled) {
      throw new TerminalToolError(
        "sandbox_unavailable",
        "Terminal is temporarily disabled by an operator. Do not retry until a workspace owner confirms service has resumed.",
        { reason: "Wait for an operator to re-enable Terminal before trying another tool." },
      );
    }
    if (context.signal.aborted) {
      throw new TerminalToolError("cancelled", "The Terminal operation was cancelled before workspace mutation.");
    }
    const now = this.clock.now().getTime();
    const nowIso = this.clock.now().toISOString();
    let row = await this.terminal(context).sandbox();
    if (!row) {
      const [policy, repositoryAuthority] = await Promise.all([
        this.loadOrCreatePolicy(context.workspaceId, nowIso),
        this.loadRepositoryAuthority(context.workspaceId, context.workstreamId),
      ]);
      const authorityFingerprint = await sha256(JSON.stringify({
        principal: executionPrincipalKey(context.executionPrincipal),
        repository: repositoryAuthority ?? "scratch",
      }));
      row = await this.reserveFirstGeneration(
        context,
        authorityFingerprint,
        policy.revision,
        now,
      );
    }
    const claimed = await this.claimOperation(context, row, now);
    return {
      providerSandboxId: claimed.sandboxId,
      state: claimed.lifecycleState,
      generation: claimed.generation,
    };
  }

  async acquire(context: HarnessToolContext): Promise<AcquiredTerminalSandbox> {
    const acquisitionStartedAt = Date.now();
    if (this.emergencyDisabled) {
      throw new TerminalToolError(
        "sandbox_unavailable",
        "Terminal is temporarily disabled by an operator. Do not retry until a workspace owner confirms service has resumed.",
        { reason: "Wait for an operator to re-enable Terminal before trying another tool." },
      );
    }
    if (context.signal.aborted) {
      throw new TerminalToolError("cancelled", "The Terminal operation was cancelled before sandbox startup.");
    }
    const clockNow = this.clock.now();
    const now = clockNow.getTime();
    const nowIso = clockNow.toISOString();
    const [policy, repositoryAuthority] = await Promise.all([
      this.loadOrCreatePolicy(context.workspaceId, nowIso),
      this.loadRepositoryAuthority(context.workspaceId, context.workstreamId),
    ]);
    if (policy.verificationState !== "verified") {
      throw new TerminalToolError(
        "network_policy_unverified",
        "The workspace Terminal network policy is not verified. Ask a workspace owner to retry the policy verification before using Terminal.",
        { reason: policy.verificationState === "pending"
          ? "Wait for policy verification to finish, then retry."
          : "Ask a workspace owner to save and verify the Terminal network policy." },
      );
    }
    const authorityFingerprint = await sha256(JSON.stringify({
      principal: executionPrincipalKey(context.executionPrincipal),
      repository: repositoryAuthority ?? "scratch",
    }));
    const domains = policy.mode === "trusted_only" ? parseEffectiveDomains(policy) : [];
    let row = await this.terminal(context).sandbox();
    if (!row) {
      row = await this.reserveFirstGeneration(context, authorityFingerprint, policy.revision, now);
    }
    row = await this.claimOperation(context, row, now);
    let telemetryAction: TerminalAcquisitionObservation["action"] | null =
      row.sandboxId ? null : "start";
    let localFilesRetained = Boolean(row.sandboxId);

    const importedResourceRevoked = await this.hasRevokedImportedResource(context, row);
    if (row.authorityFingerprint !== authorityFingerprint || importedResourceRevoked) {
      telemetryAction = "repository_replace";
      localFilesRetained = false;
      row = await this.replaceForAuthority(context, row, authorityFingerprint, policy.revision, now);
    }

    if (row.appliedNetworkRevision !== policy.revision) {
      row = await this.reconcileNetworkPolicy(context, row, policy.revision, domains, now);
    }

    if (!row.sandboxId) {
      row = await this.createReservedSandbox(context, row, domains, now);
    } else {
      const resumed = await this.resumeProviderSandbox(
        context,
        row,
        authorityFingerprint,
        policy.revision,
        domains,
        now,
      );
      row = resumed.row;
      telemetryAction = resumed.action ?? telemetryAction;
      if (resumed.action === "start_fresh") localFilesRetained = false;
    }

    const currentPolicy = await this.loadOrCreatePolicy(context.workspaceId, nowIso);
    if (currentPolicy.verificationState !== "verified" || currentPolicy.revision !== policy.revision) {
      if (row.sandboxId) await this.provider.stopSandbox(row.sandboxId).catch(() => undefined);
      throw new TerminalToolError(
        "network_policy_unverified",
        "The workspace Terminal network policy changed during sandbox startup. Rally stopped the sandbox; retry after the new policy is verified.",
        { reason: "Wait for the network-policy change to finish, then retry the same tool." },
      );
    }
    await this.lifecycleChanged?.(context.workspaceId).catch(() => undefined);
    if (telemetryAction) {
      await this.acquisitionObserved?.(context, {
        action: telemetryAction,
        durationMs: Date.now() - acquisitionStartedAt,
        repositorySelected: repositoryAuthority !== null,
        localFilesRetained,
      }).catch(() => undefined);
    }
    return {
      providerSandboxId: row.sandboxId!,
      stableName: requireStableName(row),
      generation: row.generation,
      state: "running",
      authorityFingerprint,
      networkRevision: policy.revision,
      operationLeaseExpiresAt: row.operationLeaseExpiresAt ?? now,
    };
  }

  /**
   * The workspace's Terminal network policy, from the object that owns it.
   *
   * This was an insert-if-absent and a select through the workspace runtime
   * facade — two round trips whose only atomicity came from `ON CONFLICT DO
   * NOTHING`. The object does both in one transaction and returns the policy
   * with the allow-list it published.
   */
  private async loadOrCreatePolicy(
    workspaceId: string,
    timestamp: string,
  ): Promise<WorkspaceTerminalNetworkPolicy> {
    const workspace = await durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      asWorkspaceId(workspaceId),
      workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(workspaceId)),
    );
    return WorkspaceTerminalNetworkSettingsSchema.parse(await workspace.terminalNetworkSettings({
      workspaceId,
      baselineManifestVersion: TERMINAL_NETWORK_MANIFEST_VERSION,
      defaultEffectiveDomains: compileTerminalNetworkPolicy("trusted_only", []).effectiveDomains,
      at: timestamp,
    })).policy;
  }

  private terminal(context: HarnessToolContext): TerminalObjectPort {
    return this.terminalPort(context.workspaceId, context.workstreamId);
  }

  private async claimOperation(
    context: HarnessToolContext,
    row: TerminalSandboxRecord,
    now: number,
  ): Promise<TerminalSandboxRecord> {
    const terminal = this.terminal(context);
    const leaseExpiresAt = this.clock.now().getTime() + TERMINAL_OPERATION_LEASE_MS;
    let claimed = await terminal.claimOperation({
      runId: context.harnessRunId,
      generation: row.generation,
      leaseExpiresAt,
      now,
    });
    if (!claimed) {
      claimed = await this.recoverYieldedOperation(
        context,
        row,
        now,
      );
    }
    if (!claimed) {
      throw new TerminalToolError(
        "sandbox_busy",
        "Another agent run is changing this Terminal workspace. Wait for that run to finish, then retry the tool; do not repeat any earlier command.",
        { retryAfterMs: 5_000, reason: "Wait for the current agent run to release the Terminal workspace, then retry." },
      );
    }
    return claimed;
  }

  /**
   * A yielded run never resumes its Terminal lease; `needs_input` specifically
   * admits a new linked run. If the old generation retained a named Daytona
   * command after losing observation, the contender must first stop that
   * provider sandbox and fence its durable task before it may take the
   * workspace lease. A submitting command instead retires the sandbox. The
   * ambiguous command is cancelled, never replayed.
   */
  private async recoverYieldedOperation(
    context: HarnessToolContext,
    row: TerminalSandboxRecord,
    now: number,
  ): Promise<TerminalSandboxRecord | null> {
    const sandboxId = row.sandboxId;
    if (!sandboxId) return null;
    const terminal = this.terminal(context);
    const claimId = newId(now);
    const renewClaim = async (): Promise<void> => {
      const renewedAt = this.clock.now().getTime();
      const renewed = await terminal.renewLifecycleClaim({
        generation: row.generation,
        sandboxId,
        claimId,
        claimExpiresAt: renewedAt + TERMINAL_OPERATION_LEASE_MS,
        now: renewedAt,
      });
      if (!renewed) throw new Error("terminal_operation_recovery_claim_lost");
    };
    const recoveryClaimed = await terminal.claimYieldedOperationRecovery({
      runId: context.harnessRunId,
      generation: row.generation,
      sandboxId,
      version: row.version,
      claimId,
      claimExpiresAt: now + TERMINAL_OPERATION_LEASE_MS,
      now,
    });
    if (!recoveryClaimed) return null;

    let sandboxStopped = false;
    let sandboxRetired = false;
    const finishRecovery = async (): Promise<TerminalSandboxRecord | null> => {
      const handoffNow = this.clock.now().getTime();
      const handoffLeaseExpiresAt = handoffNow + TERMINAL_OPERATION_LEASE_MS;
      const recovered = sandboxRetired
        ? await terminal.retireYieldedOperationRecovery({
            runId: context.harnessRunId,
            generation: row.generation,
            sandboxId,
            claimId,
            leaseExpiresAt: handoffLeaseExpiresAt,
            ...deadlines(new Date(handoffNow)),
            now: handoffNow,
          })
        : await terminal.settleYieldedOperationRecovery({
            runId: context.harnessRunId,
            generation: row.generation,
            sandboxId,
            claimId,
            leaseExpiresAt: handoffLeaseExpiresAt,
            sandboxStopped,
            now: handoffNow,
          });
      return recovered;
    };
    try {
      while (true) {
        const task = await terminal.unsettledTask(row.generation);
        if (!task) return finishRecovery();

        if (!sandboxRetired && task.state !== "running") {
          // Pre-acceptance work can outlive removal of an observation handle
          // and arrive later, so only retirement of the provider sandbox
          // excludes a stale mutation from the successor generation. This also
          // keeps the schema-admitted `planned` state fail-safe if task
          // admission ever moves before provider submission.
          try {
            await renewClaim();
            await this.provider.deleteSandbox(sandboxId);
          } catch (error) {
            if (!isTerminalProviderNotFound(error)) {
              try {
                await this.provider.getSandbox(sandboxId);
              } catch (observationError) {
                if (isTerminalProviderNotFound(observationError)) sandboxRetired = true;
                else throw error;
              }
              if (!sandboxRetired) throw error;
            }
          }
          sandboxRetired = true;
          sandboxStopped = false;
        } else if (!sandboxRetired && !sandboxStopped && task.state === "running") {
          // Production proved that deleting Daytona's named session can remove
          // observation while its accepted command keeps running. Stop the
          // whole sandbox before cancelling the durable task or handing its
          // lease to a linked run; start preserves the sandbox filesystem.
          try {
            await renewClaim();
            await this.provider.stopSandbox(sandboxId);
            sandboxStopped = true;
          } catch (error) {
            if (isTerminalProviderNotFound(error)) {
              sandboxRetired = true;
            } else {
              let observed: Awaited<ReturnType<TerminalSandboxProvider["getSandbox"]>> | null = null;
              try {
                observed = await this.provider.getSandbox(sandboxId);
              } catch (observationError) {
                if (isTerminalProviderNotFound(observationError)) sandboxRetired = true;
                else throw error;
              }
              if (!sandboxRetired && observed?.state !== "stopped" && observed?.state !== "archived") {
                throw error;
              }
              sandboxStopped = !sandboxRetired;
            }
          }
        }

        const settled = await terminal.cancelTaskAfterProviderCleanup({
          taskId: task.taskId,
          runId: task.runId,
          effectIntentId: task.effectIntentId,
          sandboxGeneration: task.sandboxGeneration,
          providerTaskName: task.providerTaskName,
          claimId,
          now: this.clock.now().getTime(),
        });
        if (!settled && await terminal.unsettledTask(row.generation)) {
          throw new Error("terminal_task_cleanup_fence_lost");
        }
      }
    } catch {
      let observed: Awaited<ReturnType<TerminalSandboxProvider["getSandbox"]>> | null = null;
      try {
        observed = await this.provider.getSandbox(sandboxId);
      } catch (observationError) {
        sandboxRetired ||= isTerminalProviderNotFound(observationError);
      }
      sandboxStopped ||= observed?.state === "stopped" || observed?.state === "archived";
      await terminal.failLifecycleClaim({
        lifecycleState: sandboxRetired ? "failed" : sandboxStopped ? "stopped" : row.lifecycleState,
        failureCode: null,
        claimId,
        now: this.clock.now().getTime(),
      });
      return null;
    }
  }

  /**
   * The repository half of the authority fingerprint, or null when there is
   * none a run may still use.
   *
   * Two objects, deliberately not one query: the selection is the work
   * stream's own provenance, while whether its connection is still usable
   * belongs to the workspace. Disabling a connector therefore needs no fan-out
   * write to every child — the next acquisition simply fails this check.
   */
  private async loadRepositoryAuthority(
    workspaceId: string,
    workstreamId: string,
  ): Promise<RepositoryAuthorityRow | null> {
    const repository = await this.terminalPort(workspaceId, workstreamId).selectedRepository();
    if (!repository) return null;
    const connection = await this.env.DB.prepare(
      `SELECT id FROM connector_connections
        WHERE id = ? AND workspace_id = ? AND status <> 'disabled'`,
    ).bind(repository.connectionId, workspaceId).first<{ id: string }>();
    return connection
      ? {
          connection_id: repository.connectionId,
          repository_full_name: repository.repositoryFullName,
          base_ref: repository.baseRef,
          base_sha: repository.baseSha,
          head_ref: repository.headRef,
        }
      : null;
  }

  private async hasRevokedImportedResource(context: HarnessToolContext, row: TerminalSandboxRecord): Promise<boolean> {
    const principalUserId = context.executionPrincipal.type === "user" ? context.executionPrincipal.userId : null;
    const links = await this.terminal(context).importedResources(row.generation);
    if (links.length === 0) return false;
    if (links.some((candidate) => candidate.state !== "completed")) return true;
    // The attachment join used to ride along with the import rows. It cannot:
    // the imports are object-local and the relationship rows are not, so the
    // link check is its own statement against its own authority.
    const attached = await this.resourcePort(context.workspaceId, context.workstreamId)
      .attachedLinks({ resourceIds: links.map((candidate) => candidate.resourceId) });
    if (new Set(attached.map((link) => link.resource_id)).size !== links.length) {
      return true;
    }
    const placeholders = links.map(() => "?").join(", ");
    const resources = await this.env.DB.prepare(
      `SELECT id, provider FROM resources
        WHERE workspace_id = ? AND id IN (${placeholders})`,
    ).bind(context.workspaceId, ...links.map((candidate) => candidate.resourceId))
      .all<{ id: string; provider: string }>();
    if (resources.results.length !== links.length) return true;
    const noteIds = resources.results.filter((candidate) => candidate.provider === "avalon_note")
      .map((candidate) => candidate.id);
    if (noteIds.length === 0) return false;
    // Note visibility is the owning object's decision, asked as a typed
    // method; a null principal sees only workspace-scoped notes.
    const workspace = await durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      asWorkspaceId(context.workspaceId),
      workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(context.workspaceId)),
    );
    const visible = WorkspaceNoteVisibilityResultSchema.parse(
      await workspace.visibleNoteResourceIds({
        workspaceId: context.workspaceId,
        userId: principalUserId,
        resourceIds: noteIds,
      }),
    );
    return new Set(visible.resourceIds).size !== noteIds.length;
  }

  private async reserveFirstGeneration(
    context: HarnessToolContext,
    authorityFingerprint: string,
    networkRevision: number,
    now: number,
  ): Promise<TerminalSandboxRecord> {
    const stableHash = await sha256(`${context.workspaceId}:${context.workstreamId}`);
    const stableName = `avalon-${stableHash.replace(/[^a-zA-Z0-9]/gu, "").slice(0, 24).toLowerCase()}`;
    return this.terminal(context).reserveFirstGeneration({
      stableName,
      authorityFingerprint,
      networkRevision,
      runId: context.harnessRunId,
      operationLeaseExpiresAt: this.clock.now().getTime() + TERMINAL_OPERATION_LEASE_MS,
      ...deadlines(this.clock.now()),
      now,
    });
  }

  private async createReservedSandbox(
    context: HarnessToolContext,
    row: TerminalSandboxRecord,
    domains: string[],
    now: number,
  ): Promise<TerminalSandboxRecord> {
    let created: TerminalSandboxSnapshot;
    try {
      created = await this.provider.createSandbox({
        stableName: requireStableName(row),
        workspaceId: context.workspaceId,
        workstreamId: context.workstreamId,
        generation: row.generation,
        domainAllowList: domains,
        environment: { AVALON_RESOURCE_DIR: TERMINAL_OUTPUT_ROOT },
      });
    } catch {
      try {
        created = await this.provider.getSandbox(requireStableName(row));
      } catch {
        await this.terminal(context).failGeneration({
          generation: row.generation,
          failureCode: "provider_create_failed",
          now,
        });
        throw new TerminalToolError(
          "sandbox_unavailable",
          "Daytona did not confirm sandbox creation. Retry the Terminal tool; Rally will reconcile the stable sandbox name before creating another.",
          { reason: "Retry once so Rally can reconcile the stable sandbox name before creating another." },
        );
      }
    }
    if (created.state !== "running") {
      if (created.state === "stopped" || created.state === "archived") {
        await this.provider.startSandbox(created.id);
      } else {
        throw providerStateError(created.state);
      }
    }
    if (this.provider.prepareSandbox) {
      try {
        created = await this.provider.prepareSandbox(created.id, domains);
      } catch {
        await this.provider.deleteSandbox(created.id).catch(() => (
          this.provider.stopSandbox(created.id).catch(() => undefined)
        ));
        await this.terminal(context).failGeneration({
          generation: row.generation,
          failureCode: "provider_initialize_failed",
          now,
        });
        throw new TerminalToolError(
          "sandbox_unavailable",
          "Daytona could not verify the managed Terminal environment. The sandbox was discarded; retry after provider health or the managed snapshot is repaired.",
          { reason: "Retry after provider health or the managed Terminal snapshot is repaired." },
        );
      }
    }
    const expectedDomains = [...domains].sort();
    const observedDomains = [...created.domainAllowList].sort();
    if (expectedDomains.join("\n") !== observedDomains.join("\n")) {
      await this.provider.deleteSandbox(created.id).catch(() => (
        this.provider.stopSandbox(created.id).catch(() => undefined)
      ));
      await this.terminal(context).failGeneration({
        generation: row.generation,
        failureCode: "provider_policy_mismatch",
        now,
      });
      throw new TerminalToolError(
        "network_policy_unverified",
        "Daytona did not confirm the workspace Terminal network policy. The sandbox was discarded; ask a workspace owner to verify the policy before retrying.",
        { reason: "Ask a workspace owner to verify the Terminal network policy before retrying." },
      );
    }
    await this.terminal(context).attachProviderSandbox({
      generation: row.generation,
      sandboxId: created.id,
      lifecycleState: "running",
      ...deadlines(this.clock.now()),
      now,
    });
    return { ...row, sandboxId: created.id, lifecycleState: "running", version: row.version + 1 };
  }

  /**
   * Make the provider sandbox this row names actually running, driven by what
   * Daytona reports rather than by what the row last recorded.
   *
   * The row carries Rally's intent; only the provider knows the state, and the
   * two drift. Daytona auto-stops a sandbox after fifteen idle minutes and
   * auto-archives it an hour later on its own schedule, so a transition Rally's
   * alarm never ran — deferred behind a live run, lost with a run that died
   * mid-operation — leaves the row claiming `running` over a sandbox that has
   * been archived. Archiving releases the runner, so the first file or command
   * call answers `404 … does not have a runner`, and because nothing moves the
   * row, every later run repeats it. Reading the state back costs one provider
   * GET per acquisition — once per harness run, not once per tool — and it is
   * what turns that silent divergence into a start.
   *
   * A sandbox the provider has lost is replaced here rather than reported,
   * because reporting it is what made this permanent: an `archived` row has no
   * pending deadline, so the lifecycle pass has nothing to reconcile and the
   * dead id survives to the thirty-day expiry. Nothing durable lives only
   * inside a sandbox — published resources, the repository branch, and the
   * final diff are all outside it — so a replacement costs the run its scratch
   * files and gives back a workspace that works.
   */
  private async resumeProviderSandbox(
    context: HarnessToolContext,
    row: TerminalSandboxRecord,
    authorityFingerprint: string,
    networkRevision: number,
    domains: string[],
    now: number,
  ): Promise<{
    row: TerminalSandboxRecord;
    action: TerminalAcquisitionObservation["action"] | null;
  }> {
    const sandboxId = row.sandboxId!;
    const replaceLost = async (): Promise<{
      row: TerminalSandboxRecord;
      action: TerminalAcquisitionObservation["action"];
    }> => ({
      row: await this.replaceLostSandbox(
        context,
        row,
        authorityFingerprint,
        networkRevision,
        domains,
        now,
      ),
      action: "start_fresh",
    });
    const observed = await this.observeProviderSandbox(sandboxId);
    if (!observed || isLostProviderSandbox(observed.state)) return replaceLost();
    if (observed.state === "running") {
      if (row.lifecycleState === "running") {
        await this.refreshDeadlines(context, row, now);
        return { row, action: null };
      }
      await this.setRunning(context, row, now);
      return {
        row: { ...row, lifecycleState: "running", version: row.version + 1 },
        action: "restore",
      };
    }
    // `starting` is Daytona mid-transition, including the restore of an archive
    // that outlasts one start call. Waiting it out inside the tool would hold
    // the run against a provider deadline Rally does not set; the model retries.
    if (observed.state === "starting") throw providerStateError(observed.state);
    try {
      await this.provider.startSandbox(sandboxId);
    } catch (error) {
      // A start that throws has not said what became of the sandbox. Ask,
      // rather than treating every failure as a lost workspace: a restore that
      // ran past the start call's own deadline is still on its way, and
      // discarding the files for that would make this method cause the loss it
      // exists to recover from.
      const settled = await this.observeProviderSandbox(sandboxId);
      if (!settled || isLostProviderSandbox(settled.state)) return replaceLost();
      if (settled.state !== "running") throw providerStateError(settled.state);
      logStructuredEvent(this.env, "info", "terminal_sandbox_start_settled_after_error", {
        workspace_id: context.workspaceId,
        workstream_id: context.workstreamId,
        harness_run_id: context.harnessRunId,
        sandbox_generation: row.generation,
        reason: error instanceof Error ? error.name : "unknown",
      });
    }
    await this.setRunning(context, row, now);
    return {
      row: { ...row, lifecycleState: "running", version: row.version + 1 },
      action: "restore",
    };
  }

  /**
   * What the provider says this sandbox is, or `null` when it no longer has one.
   *
   * A provider that cannot be reached is not a lost sandbox and must not be
   * treated as one: the caller replaces what this reports absent.
   */
  private async observeProviderSandbox(
    sandboxId: string,
  ): Promise<TerminalSandboxSnapshot | null> {
    try {
      return await this.provider.getSandbox(sandboxId);
    } catch (error) {
      if (isTerminalProviderNotFound(error)) return null;
      throw new TerminalToolError(
        "sandbox_unavailable",
        "Rally could not reach Daytona to check this Terminal workspace. Retry the tool.",
        { retryAfterMs: 5_000, reason: "Retry once; the provider did not answer." },
      );
    }
  }

  /**
   * Retire a generation whose sandbox the provider lost, and provision its
   * successor under the same lease.
   *
   * `replaceGeneration` is the authority path repository replacement already
   * uses: it bumps the generation, clears the sandbox id, and drops the
   * imported-resource rows that named files in the sandbox that is gone. The
   * delete is best effort — the sandbox is already absent or unusable, and a
   * provider that will not answer a delete must not keep the work stream
   * pinned to a workspace it cannot start.
   */
  private async replaceLostSandbox(
    context: HarnessToolContext,
    row: TerminalSandboxRecord,
    authorityFingerprint: string,
    networkRevision: number,
    domains: string[],
    now: number,
  ): Promise<TerminalSandboxRecord> {
    logStructuredEvent(this.env, "warn", "terminal_sandbox_replaced_after_loss", {
      workspace_id: context.workspaceId,
      workstream_id: context.workstreamId,
      harness_run_id: context.harnessRunId,
      sandbox_generation: row.generation,
      lifecycle_state: row.lifecycleState,
    });
    if (row.sandboxId) await this.provider.deleteSandbox(row.sandboxId).catch(() => undefined);
    const replaced = await this.terminal(context).replaceGeneration({
      generation: row.generation,
      authorityFingerprint,
      networkRevision,
      runId: context.harnessRunId,
      operationLeaseExpiresAt: this.clock.now().getTime() + TERMINAL_OPERATION_LEASE_MS,
      ...deadlines(this.clock.now()),
      now,
    });
    return this.createReservedSandbox(context, replaced, domains, now);
  }

  private async replaceForAuthority(
    context: HarnessToolContext,
    row: TerminalSandboxRecord,
    authorityFingerprint: string,
    networkRevision: number,
    now: number,
  ): Promise<TerminalSandboxRecord> {
    if (row.sandboxId) await this.provider.deleteSandbox(row.sandboxId);
    return this.terminal(context).replaceGeneration({
      generation: row.generation,
      authorityFingerprint,
      networkRevision,
      runId: context.harnessRunId,
      operationLeaseExpiresAt: this.clock.now().getTime() + TERMINAL_OPERATION_LEASE_MS,
      ...deadlines(this.clock.now()),
      now,
    });
  }

  private async reconcileNetworkPolicy(
    context: HarnessToolContext,
    row: TerminalSandboxRecord,
    revision: number,
    domains: string[],
    now: number,
  ): Promise<TerminalSandboxRecord> {
    if (row.sandboxId) {
      if (row.lifecycleState === "running") await this.provider.stopSandbox(row.sandboxId);
      await this.provider.updateNetworkPolicy(row.sandboxId, domains.length ? domains : null);
    }
    await this.terminal(context).setAppliedNetworkRevision({ networkRevision: revision, now });
    return {
      ...row,
      lifecycleState: row.sandboxId ? "stopped" : "starting",
      appliedNetworkRevision: revision,
      version: row.version + 1,
    };
  }

  private async setRunning(
    context: HarnessToolContext,
    row: TerminalSandboxRecord,
    now: number,
  ): Promise<void> {
    await this.terminal(context).setRunning({
      generation: row.generation,
      ...deadlines(this.clock.now()),
      now,
    });
  }

  private async refreshDeadlines(
    context: HarnessToolContext,
    row: TerminalSandboxRecord,
    now: number,
  ): Promise<void> {
    await this.terminal(context).refreshDeadlines({
      generation: row.generation,
      ...deadlines(this.clock.now()),
      now,
    });
  }
}
