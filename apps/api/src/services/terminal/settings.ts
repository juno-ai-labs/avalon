import type {
  ApplyTerminalNetworkPolicyRequestSchema,
  PreviewTerminalNetworkPolicyRequestSchema,
  TerminalNetworkPolicyPreview,
  TerminalWorkspaceSettings,
} from "@rally/contracts";
import { newId, nowIso } from "@rally/db";
import { createTerminalPortFactory } from "./object-port";
import type { z } from "zod";

import type { AuthContext, Env } from "../../env";
import { ApiError } from "../../lib/api-error";
import { WorkstreamDirectoryService } from "../workstream-directory-service";
import { withWorkspaceRuntimeDatabase } from "../workspace-runtime-database";
import { parseTerminalRegionConfiguration } from "./contract";
import type { TerminalSandboxProvider } from "./daytona-provider";
import { createTerminalFinalDiffPreserver } from "./lifecycle";
import {
  emitProductUsageTelemetry,
  telemetryCountBucket,
} from "../../telemetry/product-usage";
import {
  compileTerminalNetworkPolicy,
  TERMINAL_NETWORK_MANIFEST_VERSION,
  type TerminalNetworkMode,
} from "./network-policy";

type PreviewInput = z.infer<typeof PreviewTerminalNetworkPolicyRequestSchema>;
type ApplyInput = z.infer<typeof ApplyTerminalNetworkPolicyRequestSchema>;

interface PolicyRow {
  mode: TerminalNetworkMode;
  revision: number;
  verification_state: "pending" | "verified" | "failed";
  baseline_manifest_version: string;
  failure_code: string | null;
}

interface MutationRow {
  id: string;
  expected_revision: number;
  proposed_mode: TerminalNetworkMode;
  proposed_domains_json: string;
  effective_domains_json: string;
  affected_sandboxes_json: string;
  state: "preview" | "pending" | "verified" | "failed" | "conflict";
}

interface SandboxRow {
  workstream_id: string;
  provider_sandbox_id: string;
  state: string;
  generation: number;
  title: string;
}

export class TerminalSettingsService {
  private readonly env: Env;
  private readonly auth: AuthContext;
  private readonly provider: TerminalSandboxProvider | null;

  constructor(
    env: Env,
    auth: AuthContext,
    provider: TerminalSandboxProvider | null,
  ) {
    this.env = withWorkspaceRuntimeDatabase(env, auth.workspaceId);
    this.auth = auth;
    this.provider = provider;
  }

  async get(): Promise<TerminalWorkspaceSettings> {
    const policy = await this.loadOrCreatePolicy();
    const domains = await this.customDomains();
    const compiled = compileTerminalNetworkPolicy(policy.mode, domains);
    const configuration = parseTerminalRegionConfiguration(this.env);
    return {
      availability: configuration.capability === "unsupported"
        ? "unsupported"
        : configuration.emergencyDisabled ? "emergency_disabled" : "supported",
      mode: policy.mode,
      revision: policy.revision,
      verificationState: policy.verification_state,
      customDomains: compiled.customDomains,
      remainingCustomSlots: compiled.remainingCustomSlots,
      failureCode: policy.failure_code,
    };
  }

  async preview(input: PreviewInput): Promise<TerminalNetworkPolicyPreview> {
    this.requireAdmin();
    const policy = await this.loadOrCreatePolicy();
    if (policy.verification_state !== "verified") {
      throw new ApiError(409, "terminal_policy_application_pending", "A Terminal network policy change is still being reconciled. Reload settings after it finishes.");
    }
    if (policy.revision !== input.expectedRevision) {
      throw new ApiError(
        409,
        "terminal_policy_revision_conflict",
        "The Terminal network policy changed; reload workspace settings, review the current targets, and preview your change again.",
        { expectedRevision: input.expectedRevision, currentRevision: policy.revision },
      );
    }
    let compiled;
    try {
      compiled = compileTerminalNetworkPolicy(input.mode, input.customDomains);
    } catch (error) {
      throw new ApiError(422, "invalid_terminal_network_policy", error instanceof Error ? error.message : "The Terminal network policy is invalid");
    }
    const currentCompiled = compileTerminalNetworkPolicy(policy.mode, await this.customDomains());
    if (
      policy.mode === input.mode
      && currentCompiled.customDomains.join("\n") === compiled.customDomains.join("\n")
    ) {
      throw new ApiError(409, "terminal_policy_unchanged", "The Terminal network policy is unchanged. Edit the mode or destinations before reviewing it.");
    }
    const sandboxes = await this.loadActiveSandboxes();
    const affectedWorkstreamIds = sandboxes.map((sandbox) => sandbox.workstream_id);
    const mutationId = newId();
    const timestamp = nowIso();
    await this.env.DB.prepare(
      `INSERT INTO workspace_sandbox_network_policy_mutations
       (id, workspace_id, expected_revision, proposed_mode, proposed_domains_json,
        effective_domains_json, affected_sandboxes_json, state, requested_by_user_id,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'preview', ?, ?, ?)`,
    ).bind(
      mutationId,
      this.auth.workspaceId,
      input.expectedRevision,
      input.mode,
      JSON.stringify(compiled.customDomains),
      JSON.stringify(compiled.effectiveDomains),
      JSON.stringify(affectedWorkstreamIds),
      this.auth.userId,
      timestamp,
      timestamp,
    ).run();
    return {
      mutationId,
      expectedRevision: input.expectedRevision,
      proposedMode: input.mode,
      customDomains: compiled.customDomains,
      remainingCustomSlots: compiled.remainingCustomSlots,
      affectedWorkstreamIds,
      affectedWorkstreams: sandboxes.map((sandbox) => ({ id: sandbox.workstream_id, title: sandbox.title })),
      warning: input.mode === "full_internet"
        ? "Full internet lets Terminal code contact arbitrary public destinations. Active sandboxes will stop and stay stopped until the next Terminal tool call."
        : "Trusted only applies Rally-managed platform access and workspace-approved domains. Active sandboxes will stop while Daytona applies the policy.",
    };
  }

  async apply(input: ApplyInput): Promise<TerminalWorkspaceSettings> {
    this.requireAdmin();
    const mutation = await this.env.DB.prepare(
      `SELECT id, expected_revision, proposed_mode, proposed_domains_json,
              effective_domains_json, affected_sandboxes_json, state
         FROM workspace_sandbox_network_policy_mutations
        WHERE workspace_id = ? AND id = ? AND requested_by_user_id = ?`,
    ).bind(this.auth.workspaceId, input.mutationId, this.auth.userId).first<MutationRow>();
    if (!mutation || mutation.state !== "preview" || mutation.expected_revision !== input.expectedRevision) {
      throw new ApiError(409, "terminal_policy_preview_stale", "This preview is no longer current. Reload settings and preview the policy again before confirming.");
    }
    const current = await this.loadOrCreatePolicy();
    if (current.revision !== input.expectedRevision) {
      await this.markMutation(mutation.id, "conflict", "revision_conflict");
      throw new ApiError(409, "terminal_policy_revision_conflict", "The Terminal network policy changed; reload settings and preview the policy again.");
    }
    const customDomains = JSON.parse(mutation.proposed_domains_json) as string[];
    const effectiveDomains = JSON.parse(mutation.effective_domains_json) as string[];
    const previousCustomDomains = await this.customDomains();
    const currentDomains = compileTerminalNetworkPolicy(current.mode, previousCustomDomains).effectiveDomains;
    const resultingRevision = current.revision + 1;
    const timestamp = nowIso();
    const claimed = await this.env.DB.prepare(
      `UPDATE workspace_sandbox_network_policies
          SET verification_state = 'pending', failure_code = NULL, updated_at = ?
        WHERE workspace_id = ? AND revision = ? AND verification_state = 'verified'
        RETURNING revision`,
    ).bind(timestamp, this.auth.workspaceId, input.expectedRevision).first<{ revision: number }>();
    if (!claimed) {
      throw new ApiError(409, "terminal_policy_revision_conflict", "The Terminal network policy changed; reload settings and preview the policy again.");
    }
    const mutationClaimed = await this.env.DB.prepare(
      `UPDATE workspace_sandbox_network_policy_mutations
          SET state = 'pending', resulting_revision = ?, confirmed_at = ?, updated_at = ?
        WHERE workspace_id = ? AND id = ? AND state = 'preview'
        RETURNING id`,
    ).bind(resultingRevision, timestamp, timestamp, this.auth.workspaceId, mutation.id).first<{ id: string }>();
    if (!mutationClaimed) {
      await this.restoreCurrentPolicy(current, "preview_stale");
      throw new ApiError(409, "terminal_policy_preview_stale", "This preview is no longer current. Reload settings and preview the policy again before confirming.");
    }

    const affected = await this.loadActiveSandboxes();
    if (affected.length > 0 && !this.provider) {
      await this.failApplication(mutation.id, current, "terminal_provider_unavailable");
      throw new ApiError(503, "terminal_provider_unavailable", "Terminal is unavailable in this region, so active sandbox network policy cannot be changed.");
    }

    const epochMs = Date.parse(timestamp);
    const failures: string[] = [];
    const deleted = new Set<string>();
    for (const sandbox of affected) {
      const terminal = createTerminalPortFactory(this.env)(
        this.auth.workspaceId,
        sandbox.workstream_id,
      );
      await terminal.cancelUnsettledTasks(epochMs);
      if (sandbox.state === "running") {
        // Still the routed environment: the preserver writes the resource and
        // its work-stream link, which are not Terminal tables.
        await createTerminalFinalDiffPreserver(
          this.env,
          this.provider!,
          this.auth.workspaceId,
          sandbox.workstream_id,
        )(sandbox.provider_sandbox_id, sandbox.generation).catch(() => {
          failures.push(`${sandbox.workstream_id}:final_diff`);
        });
      }
      try {
        await this.provider!.stopSandbox(sandbox.provider_sandbox_id);
        const observed = await this.provider!.getSandbox(sandbox.provider_sandbox_id);
        if (observed.state !== "stopped" && observed.state !== "archived") throw new Error(`provider_state_${observed.state}`);
        await terminal.settlePolicyTransition({
          lifecycleState: "stopped",
          failureCode: null,
          clearSandboxId: false,
          clearOperationLease: true,
          appliedNetworkRevision: null,
          generation: sandbox.generation,
          sandboxId: sandbox.provider_sandbox_id,
          now: epochMs,
        });
      } catch {
        failures.push(`${sandbox.workstream_id}:stop`);
        try {
          await this.provider!.deleteSandbox(sandbox.provider_sandbox_id);
          deleted.add(sandbox.workstream_id);
          await terminal.settlePolicyTransition({
            lifecycleState: "failed",
            failureCode: "policy_stop_failed_deleted",
            clearSandboxId: true,
            clearOperationLease: true,
            appliedNetworkRevision: null,
            generation: sandbox.generation,
            sandboxId: sandbox.provider_sandbox_id,
            now: epochMs,
          });
        } catch {
          failures.push(`${sandbox.workstream_id}:delete`);
          await terminal.settlePolicyTransition({
            lifecycleState: "failed",
            failureCode: "policy_quarantine_failed",
            clearSandboxId: false,
            clearOperationLease: true,
            appliedNetworkRevision: null,
            generation: sandbox.generation,
            sandboxId: sandbox.provider_sandbox_id,
            now: epochMs,
          });
        }
      }
    }

    if (failures.length === 0) {
      const expected = mutation.proposed_mode === "trusted_only" ? [...effectiveDomains].sort() : [];
      for (const sandbox of affected) {
        if (deleted.has(sandbox.workstream_id)) continue;
        try {
          await this.provider!.updateNetworkPolicy(
            sandbox.provider_sandbox_id,
            mutation.proposed_mode === "trusted_only" ? effectiveDomains : null,
          );
          const observed = await this.provider!.getSandbox(sandbox.provider_sandbox_id);
          if (observed.domainAllowList.slice().sort().join("\n") !== expected.join("\n")) throw new Error("provider_policy_mismatch");
        } catch {
          failures.push(`${sandbox.workstream_id}:policy`);
        }
      }
    }

    if (failures.length > 0) {
      for (const sandbox of affected) {
        if (deleted.has(sandbox.workstream_id)) continue;
        try {
          await this.provider!.updateNetworkPolicy(
            sandbox.provider_sandbox_id,
            current.mode === "trusted_only" ? currentDomains : null,
          );
          const observed = await this.provider!.getSandbox(sandbox.provider_sandbox_id);
          const expected = current.mode === "trusted_only" ? [...currentDomains].sort() : [];
          if (observed.domainAllowList.slice().sort().join("\n") !== expected.join("\n")) throw new Error("provider_policy_rollback_mismatch");
        } catch {
          await this.provider!.deleteSandbox(sandbox.provider_sandbox_id).then(async () => {
            deleted.add(sandbox.workstream_id);
            await createTerminalPortFactory(this.env)(
              this.auth.workspaceId,
              sandbox.workstream_id,
            ).settlePolicyTransition({
              lifecycleState: "failed",
              failureCode: "policy_rollback_deleted",
              clearSandboxId: true,
              clearOperationLease: false,
              appliedNetworkRevision: null,
              generation: sandbox.generation,
              sandboxId: sandbox.provider_sandbox_id,
              now: Date.now(),
            });
          }).catch(() => undefined);
        }
      }
      await this.failApplication(mutation.id, current, "provider_policy_mismatch");
      throw new ApiError(502, "terminal_policy_verification_failed", "Daytona did not confirm the requested network policy. Rally stopped or quarantined every affected sandbox and kept the last verified policy; retry the settings change or contact support.", {
        reason: failures.slice(0, 10).join("; "),
        sandboxOutcomes: affected.slice(0, 100).map((sandbox) => ({
          workstreamId: sandbox.workstream_id,
          title: sandbox.title,
          outcome: deleted.has(sandbox.workstream_id)
            ? "deleted"
            : failures.includes(`${sandbox.workstream_id}:delete`)
              ? "quarantined"
              : "stopped",
        })),
        outcomesTruncated: affected.length > 100,
      });
    }

    const domainDeletes = this.env.DB.prepare(
      "DELETE FROM workspace_sandbox_network_domains WHERE workspace_id = ?",
    ).bind(this.auth.workspaceId);
    const domainInserts = customDomains.map((domain) => this.env.DB.prepare(
      `INSERT INTO workspace_sandbox_network_domains
       (workspace_id, domain, created_by_user_id, created_at) VALUES (?, ?, ?, ?)`,
    ).bind(this.auth.workspaceId, domain, this.auth.userId, timestamp));
    for (const sandbox of affected.filter((entry) => !deleted.has(entry.workstream_id))) {
      await createTerminalPortFactory(this.env)(
        this.auth.workspaceId,
        sandbox.workstream_id,
      ).settlePolicyTransition({
        lifecycleState: "stopped",
        failureCode: null,
        clearSandboxId: false,
        clearOperationLease: false,
        appliedNetworkRevision: resultingRevision,
        generation: sandbox.generation,
        sandboxId: sandbox.provider_sandbox_id,
        now: Date.parse(timestamp),
      });
    }
    await this.env.DB.batch([
      domainDeletes,
      ...domainInserts,
      this.env.DB.prepare(
        `UPDATE workspace_sandbox_network_policies
            SET mode = ?, revision = ?, verification_state = 'verified',
                effective_domains_json = ?, failure_code = NULL,
                last_verified_at = ?, updated_at = ?
          WHERE workspace_id = ? AND revision = ? AND verification_state = 'pending'`,
      ).bind(
        mutation.proposed_mode, resultingRevision, JSON.stringify(effectiveDomains), timestamp,
        timestamp, this.auth.workspaceId, current.revision,
      ),
      this.env.DB.prepare(
        `UPDATE workspace_sandbox_network_policy_mutations
            SET state = 'verified', completed_at = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ? AND state = 'pending'`,
      ).bind(timestamp, timestamp, this.auth.workspaceId, mutation.id),
    ]);
    const telemetryMode = (mode: TerminalNetworkMode, domains: string[]) => mode === "full_internet"
      ? "unrestricted" as const
      : domains.length > 0 ? "custom" as const : "restricted" as const;
    await emitProductUsageTelemetry(this.env, {
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      name: "terminal_policy_changed",
      properties: {
        previousMode: telemetryMode(current.mode, previousCustomDomains),
        appliedMode: telemetryMode(mutation.proposed_mode, customDomains),
        customDomainCount: telemetryCountBucket(customDomains.length),
        activeSandboxCount: telemetryCountBucket(affected.length),
        result: "success",
      },
      operationId: mutation.id,
      eventId: mutation.id,
    }).catch(() => undefined);
    return this.get();
  }

  private async loadActiveSandboxes(): Promise<SandboxRow[]> {
    const directory: Array<{ workstream_id: string; title: string }> = [];
    const service = new WorkstreamDirectoryService(this.env, this.auth);
    let before: string | undefined;
    do {
      const page = await service.list(250, before, true);
      directory.push(...page.items.map((workstream) => ({
        workstream_id: workstream.id,
        title: workstream.title,
      })));
      before = page.nextCursor ?? undefined;
    } while (before);
    const rows: SandboxRow[] = [];
    const entries = directory;
    for (let offset = 0; offset < entries.length; offset += 20) {
      const page = entries.slice(offset, offset + 20);
      const loaded = await Promise.all(page.map(async (entry) => {
        const sandbox = await createTerminalPortFactory(this.env)(
          this.auth.workspaceId,
          entry.workstream_id,
        ).policyTarget();
        return sandbox
          ? {
              workstream_id: entry.workstream_id,
              provider_sandbox_id: sandbox.sandboxId,
              state: sandbox.lifecycleState,
              generation: sandbox.generation,
              title: entry.title,
            }
          : null;
      }));
      rows.push(...loaded.filter((row): row is SandboxRow => row !== null));
    }
    return rows;
  }

  private async restoreCurrentPolicy(current: PolicyRow, failureCode: string): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE workspace_sandbox_network_policies
          SET verification_state = 'verified', failure_code = ?, updated_at = ?
        WHERE workspace_id = ? AND revision = ?`,
    ).bind(failureCode, nowIso(), this.auth.workspaceId, current.revision).run();
  }

  private async failApplication(mutationId: string, current: PolicyRow, failureCode: string): Promise<void> {
    const timestamp = nowIso();
    await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE workspace_sandbox_network_policies
            SET verification_state = 'verified', failure_code = ?, updated_at = ?
          WHERE workspace_id = ? AND revision = ?`,
      ).bind(failureCode, timestamp, this.auth.workspaceId, current.revision),
      this.env.DB.prepare(
        `UPDATE workspace_sandbox_network_policy_mutations
            SET state = 'failed', failure_code = ?, completed_at = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
      ).bind(failureCode, timestamp, timestamp, this.auth.workspaceId, mutationId),
    ]);
  }

  private requireAdmin(): void {
    if (this.auth.role !== "owner" && this.auth.role !== "admin") {
      throw new ApiError(403, "workspace_admin_required", "Only workspace administrators can change Terminal network access.");
    }
  }

  private async loadOrCreatePolicy(): Promise<PolicyRow> {
    const compiled = compileTerminalNetworkPolicy("trusted_only", []);
    const timestamp = nowIso();
    await this.env.DB.prepare(
      `INSERT INTO workspace_sandbox_network_policies
       (workspace_id, mode, revision, verification_state, baseline_manifest_version,
        effective_domains_json, last_verified_at, created_at, updated_at)
       VALUES (?, 'trusted_only', 1, 'verified', ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO NOTHING`,
    ).bind(
      this.auth.workspaceId,
      TERMINAL_NETWORK_MANIFEST_VERSION,
      JSON.stringify(compiled.effectiveDomains),
      timestamp,
      timestamp,
      timestamp,
    ).run();
    const row = await this.env.DB.prepare(
      `SELECT mode, revision, verification_state, baseline_manifest_version, failure_code
         FROM workspace_sandbox_network_policies WHERE workspace_id = ?`,
    ).bind(this.auth.workspaceId).first<PolicyRow>();
    if (!row) throw new Error("Unable to initialize Terminal network settings");
    return row;
  }

  private async customDomains(): Promise<string[]> {
    const rows = await this.env.DB.prepare(
      "SELECT domain FROM workspace_sandbox_network_domains WHERE workspace_id = ? ORDER BY domain",
    ).bind(this.auth.workspaceId).all<{ domain: string }>();
    return (rows.results ?? []).map((row) => row.domain);
  }

  private async markMutation(id: string, state: "conflict" | "failed", failureCode: string): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE workspace_sandbox_network_policy_mutations
          SET state = ?, failure_code = ?, completed_at = ?, updated_at = ?
        WHERE workspace_id = ? AND id = ?`,
    ).bind(state, failureCode, nowIso(), nowIso(), this.auth.workspaceId, id).run();
  }
}
