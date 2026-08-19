import type { HarnessToolContext } from "@avalon/agent-harness";

import { sha256 } from "../../lib/crypto";
import {
  executionPrincipalKey,
} from "../workstream-resource-visibility";
import type {
  TerminalSandboxProvider,
  TerminalSandboxSnapshot,
  TerminalSandboxState,
} from "./daytona-provider";
import {
  compileTerminalNetworkPolicy,
  TERMINAL_NETWORK_MANIFEST_VERSION,
  type TerminalNetworkMode,
} from "./network-policy";
import { TerminalToolError } from "./tools";

const WARM_STOP_MINUTES = 5;
const ARCHIVE_MINUTES = 60;
const EXPIRE_DAYS = 30;

export interface TerminalClock {
  now(): Date;
}

const systemClock: TerminalClock = { now: () => new Date() };

interface SandboxRow {
  workspace_id: string;
  workstream_id: string;
  state: string;
  stable_name: string;
  provider_sandbox_id: string | null;
  generation: number;
  authority_fingerprint: string;
  applied_network_revision: number;
  version: number;
  operation_run_id: string | null;
  operation_lease_expires_at: string | null;
}

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

function plusMinutes(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

function plusDays(now: Date, days: number): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString();
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
    private readonly database: D1Database,
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
    const timestamp = this.clock.now().toISOString();
    let row = await this.loadSandbox(context.workspaceId, context.workstreamId);
    if (!row) {
      const [policy, repositoryAuthority] = await Promise.all([
        this.loadOrCreatePolicy(context.workspaceId, timestamp),
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
        timestamp,
      );
    }
    const claimed = await this.claimOperation(context, row, timestamp);
    return {
      providerSandboxId: claimed.provider_sandbox_id,
      state: claimed.state,
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
    const now = this.clock.now();
    const timestamp = now.toISOString();
    const [policy, repositoryAuthority] = await Promise.all([
      this.loadOrCreatePolicy(context.workspaceId, timestamp),
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
    let row = await this.loadSandbox(context.workspaceId, context.workstreamId);
    let telemetryAction: TerminalAcquisitionObservation["action"] | null = !row
      ? "start"
      : row.state === "stopped" || row.state === "archived"
        ? "restore"
        : row.state === "running" && row.provider_sandbox_id
          ? null
          : "start";
    const localFilesRetained = Boolean(row?.provider_sandbox_id);
    if (!row) {
      row = await this.reserveFirstGeneration(context, authorityFingerprint, policy.revision, timestamp);
    }
    row = await this.claimOperation(context, row, timestamp);

    const importedResourceRevoked = await this.hasRevokedImportedResource(context, row);
    if (row.authority_fingerprint !== authorityFingerprint || importedResourceRevoked) {
      telemetryAction = "repository_replace";
      row = await this.replaceForAuthority(context, row, authorityFingerprint, policy.revision, timestamp);
    }

    if (row.applied_network_revision !== policy.revision) {
      row = await this.reconcileNetworkPolicy(context, row, policy.revision, domains, timestamp);
    }

    if (!row.provider_sandbox_id) {
      row = await this.createReservedSandbox(context, row, domains, timestamp);
    } else if (row.state === "stopped" || row.state === "archived") {
      await this.provider.startSandbox(row.provider_sandbox_id);
      await this.setRunning(context, row, timestamp);
      row = { ...row, state: "running", version: row.version + 1 };
    } else if (row.state !== "running") {
      const observed = await this.provider.getSandbox(row.provider_sandbox_id);
      if (observed.state === "stopped" || observed.state === "archived") {
        await this.provider.startSandbox(row.provider_sandbox_id);
      } else if (observed.state !== "running") {
        throw providerStateError(observed.state);
      }
      await this.setRunning(context, row, timestamp);
      row = { ...row, state: "running", version: row.version + 1 };
    } else {
      await this.refreshDeadlines(context, row, timestamp);
    }

    const currentPolicy = await this.loadOrCreatePolicy(context.workspaceId, timestamp);
    if (currentPolicy.verification_state !== "verified" || currentPolicy.revision !== policy.revision) {
      if (row.provider_sandbox_id) await this.provider.stopSandbox(row.provider_sandbox_id).catch(() => undefined);
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
      providerSandboxId: row.provider_sandbox_id!,
      stableName: row.stable_name,
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

  private loadSandbox(workspaceId: string, workstreamId: string): Promise<SandboxRow | null> {
    return this.database.prepare(
      `SELECT workspace_id, workstream_id, state, stable_name, provider_sandbox_id,
              generation, authority_fingerprint, applied_network_revision, version,
              operation_run_id, operation_lease_expires_at
         FROM workstream_sandboxes WHERE workspace_id = ? AND workstream_id = ?`,
    ).bind(workspaceId, workstreamId).first<SandboxRow>();
  }

  private async claimOperation(
    context: HarnessToolContext,
    row: SandboxRow,
    timestamp: string,
  ): Promise<SandboxRow> {
    const leaseExpiresAt = plusMinutes(this.clock.now(), 16);
    const claimed = await this.database.prepare(
      `UPDATE workstream_sandboxes
          SET operation_run_id = ?, operation_lease_expires_at = ?, updated_at = ?
        WHERE workspace_id = ? AND workstream_id = ? AND generation = ?
          AND (
            operation_run_id IS NULL
            OR operation_run_id = ?
            OR operation_lease_expires_at IS NULL
            OR operation_lease_expires_at <= ?
            OR NOT EXISTS (
              SELECT 1 FROM harness_runs active
               WHERE active.id = workstream_sandboxes.operation_run_id
                 AND active.workspace_id = workstream_sandboxes.workspace_id
                 AND active.workstream_id = workstream_sandboxes.workstream_id
                 AND active.status IN ('scheduled', 'running', 'needs_input')
            )
          )
        RETURNING operation_run_id, operation_lease_expires_at`,
    ).bind(
      context.harnessRunId,
      leaseExpiresAt,
      timestamp,
      context.workspaceId,
      context.workstreamId,
      row.generation,
      context.harnessRunId,
      timestamp,
    ).first<{ operation_run_id: string; operation_lease_expires_at: string }>();
    if (!claimed) {
      throw new TerminalToolError(
        "sandbox_busy",
        "Another agent run is changing this Terminal workspace. Wait for that run to finish, then retry the tool; do not repeat any earlier command.",
        { retryAfterMs: 5_000, reason: "Wait for the current agent run to release the Terminal workspace, then retry." },
      );
    }
    return { ...row, ...claimed };
  }

  private loadRepositoryAuthority(workspaceId: string, workstreamId: string): Promise<RepositoryAuthorityRow | null> {
    return this.loadRepositoryAuthorityAcrossBoundaries(workspaceId, workstreamId);
  }

  private async loadRepositoryAuthorityAcrossBoundaries(
    workspaceId: string,
    workstreamId: string,
  ): Promise<RepositoryAuthorityRow | null> {
    const repository = await this.database.prepare(
      `SELECT repository.connection_id, repository.repository_full_name, repository.base_ref,
              repository.base_sha, repository.head_ref
         FROM workstream_terminal_repositories repository
        WHERE repository.workspace_id = ? AND repository.workstream_id = ?
          AND repository.state = 'selected'`,
    ).bind(workspaceId, workstreamId).first<RepositoryAuthorityRow>();
    if (!repository) return null;
    const connection = await this.database.prepare(
      `SELECT id FROM connector_connections
        WHERE id = ? AND workspace_id = ? AND status <> 'disabled'`,
    ).bind(repository.connection_id, workspaceId).first<{ id: string }>();
    return connection ? repository : null;
  }

  private async hasRevokedImportedResource(context: HarnessToolContext, row: SandboxRow): Promise<boolean> {
    const principalUserId = context.executionPrincipal.type === "user" ? context.executionPrincipal.userId : null;
    const imported = await this.database.prepare(
      `SELECT imported.resource_id, imported.state,
              CASE WHEN relationship.resource_id IS NULL THEN 0 ELSE 1 END AS attached
         FROM sandbox_imported_resources imported
         LEFT JOIN workstream_resources relationship
           ON relationship.workstream_id = imported.workstream_id
          AND relationship.resource_id = imported.resource_id
        WHERE imported.workspace_id = ? AND imported.workstream_id = ?
          AND imported.sandbox_generation = ?`,
    ).bind(
      context.workspaceId,
      context.workstreamId,
      row.generation,
    ).all<{ resource_id: string; state: string; attached: number }>();
    const links = imported.results ?? [];
    if (links.some((candidate) => candidate.state !== "completed" || candidate.attached !== 1)) return true;
    if (links.length === 0) return false;
    const placeholders = links.map(() => "?").join(", ");
    const resources = await this.database.prepare(
      `SELECT id, provider FROM resources
        WHERE workspace_id = ? AND id IN (${placeholders})`,
    ).bind(context.workspaceId, ...links.map((candidate) => candidate.resource_id))
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
    timestamp: string,
  ): Promise<SandboxRow> {
    const stableHash = await sha256(`${context.workspaceId}:${context.workstreamId}`);
    const stableName = `avalon-${stableHash.replace(/[^a-zA-Z0-9]/gu, "").slice(0, 24).toLowerCase()}`;
    await this.database.prepare(
      `INSERT INTO workstream_sandboxes
       (workspace_id, workstream_id, state, stable_name, provider_sandbox_id, generation,
        authority_fingerprint, applied_network_revision, version, operation_run_id,
        operation_lease_expires_at, last_activity_at, warm_stop_due_at, archive_due_at,
        expire_due_at, created_at, updated_at)
       VALUES (?, ?, 'starting', ?, NULL, 1, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, workstream_id) DO NOTHING`,
    ).bind(
      context.workspaceId,
      context.workstreamId,
      stableName,
      authorityFingerprint,
      networkRevision,
      context.harnessRunId,
      plusMinutes(this.clock.now(), 16),
      timestamp,
      plusMinutes(this.clock.now(), WARM_STOP_MINUTES),
      plusMinutes(this.clock.now(), ARCHIVE_MINUTES),
      plusDays(this.clock.now(), EXPIRE_DAYS),
      timestamp,
      timestamp,
    ).run();
    const row = await this.loadSandbox(context.workspaceId, context.workstreamId);
    if (!row) throw new Error("Unable to reserve a Terminal sandbox");
    return row;
  }

  private async createReservedSandbox(
    context: HarnessToolContext,
    row: SandboxRow,
    domains: string[],
    timestamp: string,
  ): Promise<SandboxRow> {
    let created: TerminalSandboxSnapshot;
    try {
      created = await this.provider.createSandbox({
        stableName: row.stable_name,
        workspaceId: context.workspaceId,
        workstreamId: context.workstreamId,
        generation: row.generation,
        domainAllowList: domains,
        environment: { AVALON_RESOURCE_DIR: "/workspace/.avalon-output" },
      });
    } catch {
      try {
        created = await this.provider.getSandbox(row.stable_name);
      } catch {
        await this.database.prepare(
          `UPDATE workstream_sandboxes SET state = 'failed', failure_code = 'provider_create_failed',
                  version = version + 1, updated_at = ?
            WHERE workspace_id = ? AND workstream_id = ? AND generation = ?`,
        ).bind(timestamp, context.workspaceId, context.workstreamId, row.generation).run();
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
        await this.database.prepare(
          `UPDATE workstream_sandboxes
              SET state = 'failed', failure_code = 'provider_initialize_failed',
                  version = version + 1, updated_at = ?
            WHERE workspace_id = ? AND workstream_id = ? AND generation = ?`,
        ).bind(timestamp, context.workspaceId, context.workstreamId, row.generation).run();
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
      await this.database.prepare(
        `UPDATE workstream_sandboxes
            SET state = 'failed', failure_code = 'provider_policy_mismatch',
                version = version + 1, updated_at = ?
          WHERE workspace_id = ? AND workstream_id = ? AND generation = ?`,
      ).bind(timestamp, context.workspaceId, context.workstreamId, row.generation).run();
      throw new TerminalToolError(
        "network_policy_unverified",
        "Daytona did not confirm the workspace Terminal network policy. The sandbox was discarded; ask a workspace owner to verify the policy before retrying.",
        { reason: "Ask a workspace owner to verify the Terminal network policy before retrying." },
      );
    }
    await this.database.prepare(
      `UPDATE workstream_sandboxes
          SET provider_sandbox_id = ?, state = 'running', failure_code = NULL,
              final_diff_resource_id = NULL,
              version = version + 1, last_activity_at = ?, warm_stop_due_at = ?,
              archive_due_at = ?, expire_due_at = ?, updated_at = ?
        WHERE workspace_id = ? AND workstream_id = ? AND generation = ?`,
    ).bind(
      created.id,
      timestamp,
      plusMinutes(this.clock.now(), WARM_STOP_MINUTES),
      plusMinutes(this.clock.now(), ARCHIVE_MINUTES),
      plusDays(this.clock.now(), EXPIRE_DAYS),
      timestamp,
      context.workspaceId,
      context.workstreamId,
      row.generation,
    ).run();
    return { ...row, provider_sandbox_id: created.id, state: "running", version: row.version + 1 };
  }

  private async replaceForAuthority(
    context: HarnessToolContext,
    row: SandboxRow,
    authorityFingerprint: string,
    networkRevision: number,
    timestamp: string,
  ): Promise<SandboxRow> {
    if (row.provider_sandbox_id) await this.provider.deleteSandbox(row.provider_sandbox_id);
    await this.database.prepare(
      `UPDATE workstream_sandboxes
          SET state = 'starting', provider_sandbox_id = NULL, generation = generation + 1,
              authority_fingerprint = ?, applied_network_revision = ?, version = version + 1,
              operation_run_id = ?, operation_lease_expires_at = ?, failure_code = NULL,
              final_diff_resource_id = NULL,
              last_activity_at = ?, warm_stop_due_at = ?, archive_due_at = ?, expire_due_at = ?, updated_at = ?
        WHERE workspace_id = ? AND workstream_id = ? AND generation = ?`,
    ).bind(
      authorityFingerprint,
      networkRevision,
      context.harnessRunId,
      plusMinutes(this.clock.now(), 16),
      timestamp,
      plusMinutes(this.clock.now(), WARM_STOP_MINUTES),
      plusMinutes(this.clock.now(), ARCHIVE_MINUTES),
      plusDays(this.clock.now(), EXPIRE_DAYS),
      timestamp,
      context.workspaceId,
      context.workstreamId,
      row.generation,
    ).run();
    return {
      ...row,
      state: "starting",
      provider_sandbox_id: null,
      generation: row.generation + 1,
      authority_fingerprint: authorityFingerprint,
      applied_network_revision: networkRevision,
      version: row.version + 1,
      operation_run_id: context.harnessRunId,
      operation_lease_expires_at: plusMinutes(this.clock.now(), 16),
    };
  }

  private async reconcileNetworkPolicy(
    context: HarnessToolContext,
    row: SandboxRow,
    revision: number,
    domains: string[],
    timestamp: string,
  ): Promise<SandboxRow> {
    if (row.provider_sandbox_id) {
      if (row.state === "running") await this.provider.stopSandbox(row.provider_sandbox_id);
      await this.provider.updateNetworkPolicy(row.provider_sandbox_id, domains.length ? domains : null);
    }
    await this.database.prepare(
      `UPDATE workstream_sandboxes
          SET state = CASE WHEN provider_sandbox_id IS NULL THEN 'starting' ELSE 'stopped' END,
              applied_network_revision = ?, version = version + 1, updated_at = ?
        WHERE workspace_id = ? AND workstream_id = ?`,
    ).bind(revision, timestamp, context.workspaceId, context.workstreamId).run();
    return {
      ...row,
      state: row.provider_sandbox_id ? "stopped" : "starting",
      applied_network_revision: revision,
      version: row.version + 1,
    };
  }

  private async setRunning(context: HarnessToolContext, row: SandboxRow, timestamp: string): Promise<void> {
    await this.database.prepare(
      `UPDATE workstream_sandboxes
          SET state = 'running', version = version + 1, last_activity_at = ?,
              final_diff_resource_id = NULL,
              warm_stop_due_at = ?, archive_due_at = ?, expire_due_at = ?, updated_at = ?
        WHERE workspace_id = ? AND workstream_id = ? AND generation = ?`,
    ).bind(
      timestamp,
      plusMinutes(this.clock.now(), WARM_STOP_MINUTES),
      plusMinutes(this.clock.now(), ARCHIVE_MINUTES),
      plusDays(this.clock.now(), EXPIRE_DAYS),
      timestamp,
      context.workspaceId,
      context.workstreamId,
      row.generation,
    ).run();
  }

  private async refreshDeadlines(context: HarnessToolContext, row: SandboxRow, timestamp: string): Promise<void> {
    await this.database.prepare(
      `UPDATE workstream_sandboxes
          SET last_activity_at = ?, warm_stop_due_at = ?, archive_due_at = ?, expire_due_at = ?, updated_at = ?
        WHERE workspace_id = ? AND workstream_id = ? AND generation = ?`,
    ).bind(
      timestamp,
      plusMinutes(this.clock.now(), WARM_STOP_MINUTES),
      plusMinutes(this.clock.now(), ARCHIVE_MINUTES),
      plusDays(this.clock.now(), EXPIRE_DAYS),
      timestamp,
      context.workspaceId,
      context.workstreamId,
      row.generation,
    ).run();
  }
}
