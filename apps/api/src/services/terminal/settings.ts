import type {
  ApplyTerminalNetworkPolicyRequestSchema,
  PreviewTerminalNetworkPolicyRequestSchema,
  TerminalNetworkPolicyPreview,
  TerminalWorkspaceSettings,
} from "@rally/contracts";
import { newId, nowIso } from "@rally/db";
import { createTerminalPortFactory } from "./object-port";
import type { z } from "zod/v3";

import type { AuthContext, Env } from "../../env";
import { ApiError } from "../../lib/api-error";
import { WorkstreamDirectoryService } from "../workstream-directory-service";
import { withWorkspaceRuntimeDatabase } from "../workspace-runtime-database";
import { workspaceDOName } from "../../durable-objects/names";
import {
  WorkspaceTerminalNetworkSettingsSchema,
  WorkspaceTerminalPolicyClaimResultSchema,
  type WorkspaceTerminalNetworkPolicy,
} from "../../durable-objects/workspace-terminal-network-protocol";
import { durableObjectStubForWorkspace } from "../../lib/durable-object-namespace";
import { asWorkspaceId } from "@rally/contracts";
import { parseTerminalRegionConfiguration } from "./contract";
import type { TerminalSandboxProvider } from "./provider-contract";
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
    // Still routed, deliberately. The policy statements left `env.DB` for typed
    // methods, but this service is not the only thing that reads it: `apply`
    // hands this environment to `createTerminalFinalDiffPreserver`, which
    // writes `resources` and `resource_object_deletion_outbox` through
    // `env.DB`. Both are WorkspaceDO tables that migration 0090 dropped from
    // regional D1, so an unrouted handle turns a policy change made while any
    // sandbox holds a diff into `no such table` — the same routing defect this
    // change exists to remove, arriving from the other side.
    this.env = withWorkspaceRuntimeDatabase(env, auth.workspaceId);
    this.auth = auth;
    this.provider = provider;
  }

  async get(): Promise<TerminalWorkspaceSettings> {
    const { policy, customDomains } = await this.settings();
    const compiled = compileTerminalNetworkPolicy(policy.mode, customDomains);
    const configuration = parseTerminalRegionConfiguration(this.env);
    return {
      availability: configuration.capability === "unsupported"
        ? "unsupported"
        : configuration.emergencyDisabled ? "emergency_disabled" : "supported",
      mode: policy.mode,
      revision: policy.revision,
      verificationState: policy.verificationState,
      customDomains: compiled.customDomains,
      remainingCustomSlots: compiled.remainingCustomSlots,
      failureCode: policy.failureCode,
    };
  }

  async preview(input: PreviewInput): Promise<TerminalNetworkPolicyPreview> {
    this.requireAdmin();
    const { policy, customDomains: currentDomains } = await this.settings();
    if (policy.verificationState !== "verified") {
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
    const currentCompiled = compileTerminalNetworkPolicy(policy.mode, currentDomains);
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
    await (await this.workspace()).recordTerminalPolicyPreview({
      workspaceId: this.auth.workspaceId,
      mutationId,
      requestedByUserId: this.auth.userId,
      expectedRevision: input.expectedRevision,
      proposedMode: input.mode,
      proposedDomains: compiled.customDomains,
      effectiveDomains: compiled.effectiveDomains,
      affectedWorkstreamIds,
      at: timestamp,
    });
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
    const timestamp = nowIso();
    // One claim rather than four statements. Reading the preview, checking the
    // revision, taking the policy row and taking the preview row are a single
    // transaction inside the object, so there is no window where the policy is
    // `pending` with nobody applying anything — which is what the old
    // `restoreCurrentPolicy` compensation existed to clean up, and which a
    // failing compensation could leave behind anyway.
    const claim = WorkspaceTerminalPolicyClaimResultSchema.parse(
      await (await this.workspace()).claimTerminalPolicyApplication({
        workspaceId: this.auth.workspaceId,
        mutationId: input.mutationId,
        requestedByUserId: this.auth.userId,
        expectedRevision: input.expectedRevision,
        at: timestamp,
      }),
    );
    if (claim.outcome === "preview_stale") {
      throw new ApiError(409, "terminal_policy_preview_stale", "This preview is no longer current. Reload settings and preview the policy again before confirming.");
    }
    if (claim.outcome === "revision_conflict") {
      throw new ApiError(409, "terminal_policy_revision_conflict", "The Terminal network policy changed; reload settings and preview the policy again.");
    }
    const { mutation, current } = claim;
    const customDomains = mutation.proposedDomains;
    const effectiveDomains = mutation.effectiveDomains;
    const previousCustomDomains = claim.currentCustomDomains;
    const currentDomains = compileTerminalNetworkPolicy(current.mode, previousCustomDomains).effectiveDomains;
    const resultingRevision = current.revision + 1;

    const affected = await this.loadActiveSandboxes();
    if (affected.length > 0 && !this.provider) {
      await this.failApplication(input.mutationId, current, "terminal_provider_unavailable");
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
      const expected = mutation.proposedMode === "trusted_only" ? [...effectiveDomains].sort() : [];
      for (const sandbox of affected) {
        if (deleted.has(sandbox.workstream_id)) continue;
        try {
          await this.provider!.updateNetworkPolicy(
            sandbox.provider_sandbox_id,
            mutation.proposedMode === "trusted_only" ? effectiveDomains : null,
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
      await this.failApplication(input.mutationId, current, "provider_policy_mismatch");
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
    await (await this.workspace()).commitTerminalPolicyApplication({
      workspaceId: this.auth.workspaceId,
      mutationId: input.mutationId,
      createdByUserId: this.auth.userId,
      mode: mutation.proposedMode,
      claimedRevision: current.revision,
      resultingRevision,
      customDomains,
      effectiveDomains,
      at: timestamp,
    });
    const telemetryMode = (mode: TerminalNetworkMode, domains: string[]) => mode === "full_internet"
      ? "unrestricted" as const
      : domains.length > 0 ? "custom" as const : "restricted" as const;
    await emitProductUsageTelemetry(this.env, {
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      name: "terminal_policy_changed",
      properties: {
        previousMode: telemetryMode(current.mode, previousCustomDomains),
        appliedMode: telemetryMode(mutation.proposedMode, customDomains),
        customDomainCount: telemetryCountBucket(customDomains.length),
        activeSandboxCount: telemetryCountBucket(affected.length),
        result: "success",
      },
      operationId: input.mutationId,
      eventId: input.mutationId,
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

  private async failApplication(
    mutationId: string,
    current: WorkspaceTerminalNetworkPolicy,
    failureCode: string,
  ): Promise<void> {
    await (await this.workspace()).failTerminalPolicyApplication({
      workspaceId: this.auth.workspaceId,
      mutationId,
      revision: current.revision,
      failureCode,
      at: nowIso(),
    });
  }

  private requireAdmin(): void {
    if (this.auth.role !== "owner" && this.auth.role !== "admin") {
      throw new ApiError(403, "workspace_admin_required", "Only workspace administrators can change Terminal network access.");
    }
  }

  /** The WorkspaceDO that owns this workspace's Terminal network policy. */
  private workspace() {
    return durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      asWorkspaceId(this.auth.workspaceId),
      workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(this.auth.workspaceId)),
    );
  }

  /**
   * The policy and its domains, in one question.
   *
   * They were two statements and every caller wanted both: the policy alone
   * cannot be compiled into what a person sees. The object creates the
   * workspace's default row if this is the first read.
   */
  private async settings() {
    // Parsed here rather than trusting the return type: the value crossed an
    // RPC boundary, and the object it came from may be running an older
    // deployment than this Worker.
    return WorkspaceTerminalNetworkSettingsSchema.parse(
      await (await this.workspace()).terminalNetworkSettings({
        workspaceId: this.auth.workspaceId,
        baselineManifestVersion: TERMINAL_NETWORK_MANIFEST_VERSION,
        defaultEffectiveDomains: compileTerminalNetworkPolicy("trusted_only", []).effectiveDomains,
        at: nowIso(),
      }),
    );
  }

}
