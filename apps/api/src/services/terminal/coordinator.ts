import type { HarnessToolContext } from "@rally/agent-harness";
import { newId } from "@rally/db";

import { sha256 } from "../../lib/crypto";
import {
  executionPrincipalKey,
} from "../workstream-resource-visibility";
import {
  isTerminalProviderNotFound,
  type TerminalSandboxProvider,
  type TerminalSandboxSnapshot,
  type TerminalSandboxState,
} from "./daytona-provider";
import {
  compileTerminalNetworkPolicy,
  TERMINAL_NETWORK_MANIFEST_VERSION,
  type TerminalNetworkMode,
} from "./network-policy";
import type { ResourcePortFactory } from "../../runtime/resource-port";
import type { TerminalPortFactory } from "./object-port";
import {
  TERMINAL_OPERATION_LEASE_MS,
  type TerminalSandboxRecord,
} from "../../durable-objects/workstream-terminal-storage";
import type {
  TerminalObjectPort,
} from "../../durable-objects/workstream-terminal-protocol";
import { TerminalToolError } from "./tools";

const WARM_STOP_MINUTES = 5;
const ARCHIVE_MINUTES = 60;
const EXPIRE_DAYS = 30;

export interface TerminalClock {
  now(): Date;
}

const systemClock: TerminalClock = { now: () => new Date() };

interface NetworkPolicyRow {
  mode: TerminalNetworkMode;
  revision: number;
  verification_state: "pending" | "verified" | "failed";
  effective_domains_json: string;
}

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
}

export interface TerminalSandboxMutationLease {
  providerSandboxId: string | null;
  state: string;
  generation: number;
}

export interface TerminalAcquisitionObservation {
  action: "start" | "restore" | "repository_replace";
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
    `The Terminal sandbox could not be made ready (provider state: ${state}). Retry the tool; if it persists, start a fresh Terminal workspace.`,
    { reason: `Retry once after Daytona leaves its ${state} state; if it persists, start a fresh Terminal workspace.` },
  );
}

function parseEffectiveDomains(row: NetworkPolicyRow): string[] {
  try {
    const value = JSON.parse(row.effective_domains_json) as unknown;
    if (Array.isArray(value) && value.every((domain) => typeof domain === "string")) return value;
  } catch {
    // A malformed durable policy is a fail-closed configuration fault below.
  }
  throw new TerminalToolError(
    "network_policy_unverified",
    "The workspace Terminal network policy is invalid. Ask a workspace owner to save and verify it again.",
    { reason: "Ask a workspace owner to save and verify the Terminal network policy." },
  );
}

export class TerminalSandboxCoordinator {
  constructor(
    /**
     * Workspace-scoped and cross-authority reads only: the network policy and
     * connector rows in WorkspaceDO, and the resource/note visibility joins.
     * Terminal's own tables are reached through `terminalPort`.
     */
    private readonly database: D1Database,
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
    if (policy.verification_state !== "verified") {
      throw new TerminalToolError(
        "network_policy_unverified",
        "The workspace Terminal network policy is not verified. Ask a workspace owner to retry the policy verification before using Terminal.",
        { reason: policy.verification_state === "pending"
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
      row.lifecycleState === "stopped" || row.lifecycleState === "archived"
        ? "restore"
        : row.lifecycleState === "running" && row.sandboxId
          ? null
          : "start";
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
    } else if (row.lifecycleState === "stopped" || row.lifecycleState === "archived") {
      await this.provider.startSandbox(row.sandboxId);
      await this.setRunning(context, row, now);
      row = { ...row, lifecycleState: "running", version: row.version + 1 };
    } else if (row.lifecycleState !== "running") {
      const observed = await this.provider.getSandbox(row.sandboxId);
      if (observed.state === "stopped" || observed.state === "archived") {
        await this.provider.startSandbox(row.sandboxId);
      } else if (observed.state !== "running") {
        throw providerStateError(observed.state);
      }
      await this.setRunning(context, row, now);
      row = { ...row, lifecycleState: "running", version: row.version + 1 };
    } else {
      await this.refreshDeadlines(context, row, now);
    }

    const currentPolicy = await this.loadOrCreatePolicy(context.workspaceId, nowIso);
    if (currentPolicy.verification_state !== "verified" || currentPolicy.revision !== policy.revision) {
      if (row.sandboxId) await this.provider.stopSandbox(row.sandboxId).catch(() => undefined);
      throw new TerminalToolError(
        "network_policy_unverified",
        "The workspace Terminal network policy changed during sandbox startup. Avalon stopped the sandbox; retry after the new policy is verified.",
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
    };
  }

  private async loadOrCreatePolicy(workspaceId: string, timestamp: string): Promise<NetworkPolicyRow> {
    const compiled = compileTerminalNetworkPolicy("trusted_only", []);
    await this.database.prepare(
      `INSERT INTO workspace_sandbox_network_policies
       (workspace_id, mode, revision, verification_state, baseline_manifest_version,
        effective_domains_json, last_verified_at, created_at, updated_at)
       VALUES (?, 'trusted_only', 1, 'verified', ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO NOTHING`,
    ).bind(
      workspaceId,
      TERMINAL_NETWORK_MANIFEST_VERSION,
      JSON.stringify(compiled.effectiveDomains),
      timestamp,
      timestamp,
      timestamp,
    ).run();
    const policy = await this.database.prepare(
      `SELECT mode, revision, verification_state, effective_domains_json
         FROM workspace_sandbox_network_policies WHERE workspace_id = ?`,
    ).bind(workspaceId).first<NetworkPolicyRow>();
    if (!policy) throw new Error("Unable to initialize the Terminal network policy");
    return policy;
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
    const connection = await this.database.prepare(
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
    const resources = await this.database.prepare(
      `SELECT id, provider FROM resources
        WHERE workspace_id = ? AND id IN (${placeholders})`,
    ).bind(context.workspaceId, ...links.map((candidate) => candidate.resourceId))
      .all<{ id: string; provider: string }>();
    if (resources.results.length !== links.length) return true;
    const noteIds = resources.results.filter((candidate) => candidate.provider === "avalon_note")
      .map((candidate) => candidate.id);
    if (noteIds.length === 0) return false;
    const notePlaceholders = noteIds.map(() => "?").join(", ");
    const notes = await this.database.prepare(
      `SELECT resource_id FROM notes
        WHERE workspace_id = ? AND resource_id IN (${notePlaceholders})
          AND archived_at IS NULL AND (scope = 'workspace' OR owner_user_id = ?)`,
    ).bind(context.workspaceId, ...noteIds, principalUserId).all<{ resource_id: string }>();
    return new Set((notes.results ?? []).map((note) => note.resource_id)).size !== noteIds.length;
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
        environment: { AVALON_RESOURCE_DIR: "/workspace/.avalon-output" },
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
          "Daytona did not confirm sandbox creation. Retry the Terminal tool; Avalon will reconcile the stable sandbox name before creating another.",
          { reason: "Retry once so Avalon can reconcile the stable sandbox name before creating another." },
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
