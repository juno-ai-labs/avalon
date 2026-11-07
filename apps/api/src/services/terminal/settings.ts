import type {
  ApplyTerminalNetworkPolicyRequestSchema,
  PreviewTerminalNetworkPolicyRequestSchema,
  TerminalNetworkPolicyPreview,
  TerminalWorkspaceSettings,
} from "@rally/contracts";
import { newId, nowIso } from "@rally/db";
import { isLegacyTerminalAliasRow } from "./coordinator";
import { createTerminalPortFactory } from "./object-port";
import type { z } from "zod";

import type { AuthContext, Env } from "../../env";
import { ApiError } from "../../lib/api-error";
import { conversationParentStub } from "../conversation-parent-client";
import { withWorkspaceRuntimeDatabase } from "../workspace-runtime-database";
import { workspaceDOName } from "../../durable-objects/names";
import {
  WorkspaceTerminalNetworkSettingsSchema,
  WorkspaceTerminalPolicyClaimResultSchema,
  type WorkspaceTerminalNetworkPolicy,
} from "../../durable-objects/workspace-terminal-network-protocol";
import { durableObjectStubForWorkspace } from "../../lib/durable-object-namespace";
import { asWorkspaceId } from "@rally/contracts";
import { codeShaped } from "@rally/contracts/zod-diagnostics";
import { logWarn } from "../../observability/logger";
import { parseTerminalRegionConfiguration } from "./contract";
import { isTerminalProviderNotFound, terminalProviderErrorCode, type TerminalSandboxProvider } from "./provider-contract";
import { TerminalToolError } from "./tools";
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
  /** The conversation whose object owns the sandbox; a work stream can have several. */
  substream_id: string;
  provider_sandbox_id: string;
  state: string;
  generation: number;
  title: string;
}

/** A policy step this service rejected itself, named by a code it composed. */
class PolicyStepError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PolicyStepError";
  }
}

/**
 * Which step of a policy change failed for one sandbox, and why: this
 * service's own code, the Terminal tool code, or the provider's error class and
 * status. Never a provider's message, which is its text.
 */
function policyStepFailure(step: string, error: unknown): string {
  const reason = error instanceof PolicyStepError || error instanceof TerminalToolError
    ? error.code
    : isTerminalProviderNotFound(error) ? "not_found" : terminalProviderErrorCode(error);
  return codeShaped(`${step}:${reason}`);
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
    const compiled = compileTerminalNetworkPolicy(policy.mode, customDomains, { stored: true });
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
    const currentCompiled = compileTerminalNetworkPolicy(policy.mode, currentDomains, { stored: true });
    if (
      policy.mode === input.mode
      && currentCompiled.customDomains.join("\n") === compiled.customDomains.join("\n")
    ) {
      throw new ApiError(409, "terminal_policy_unchanged", "The Terminal network policy is unchanged. Edit the mode or destinations before reviewing it.");
    }
    // No sandbox walk: apply finds the sandboxes itself, and nothing reads a
    // preview's list of them. Walking here doubled the slowest part of a save.
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
      at: timestamp,
    });
    return {
      mutationId,
      expectedRevision: input.expectedRevision,
      proposedMode: input.mode,
      customDomains: compiled.customDomains,
      remainingCustomSlots: compiled.remainingCustomSlots,
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
    const resultingRevision = current.revision + 1;

    const affected = await this.loadActiveSandboxes();
    if (affected.length > 0 && !this.provider) {
      await this.failApplication(input.mutationId, current, "terminal_provider_unavailable");
      throw new ApiError(503, "terminal_provider_unavailable", "Terminal is unavailable in this region, so active sandbox network policy cannot be changed.");
    }

    const epochMs = Date.parse(timestamp);
    // A sandbox that fails here is left for its next Terminal call to catch up
    // on, never deleted and never a reason to undo the change for everyone:
    // its applied revision stays behind, and acquisition reapplies the policy
    // before it resumes a sandbox whose revision is stale. Deleting on failure
    // destroyed every archived sandbox in an organization on 2026-10-08,
    // because Daytona will not stop one that is already archived.
    for (const sandbox of affected) {
      const terminal = createTerminalPortFactory(this.env)(
        this.auth.workspaceId,
        sandbox.workstream_id,
        sandbox.substream_id,
      );
      await terminal.cancelUnsettledTasks(epochMs);
      let stopped = false;
      const failures: string[] = [];
      let step = "observe";
      try {
        // Daytona's state, not Rally's intent: a row can still read stopped or
        // archived while the sandbox runs, and a running one must stop first.
        const running = (await this.provider!.getSandbox(sandbox.provider_sandbox_id)).state === "running";
        step = "stop";
        if (running) {
          // Still the routed environment: the preserver writes the resource and
          // its work-stream link, which are not Terminal tables.
          await createTerminalFinalDiffPreserver(
            this.env,
            this.provider!,
            this.auth.workspaceId,
            sandbox.workstream_id,
            sandbox.substream_id,
          )(sandbox.provider_sandbox_id, sandbox.generation).catch((error: unknown) => {
            failures.push(policyStepFailure("final_diff", error));
          });
          await this.provider!.stopSandbox(sandbox.provider_sandbox_id);
          const observed = await this.provider!.getSandbox(sandbox.provider_sandbox_id);
          if (observed.state !== "stopped" && observed.state !== "archived") throw new PolicyStepError(`provider_state_${observed.state}`);
          stopped = true;
        }
        // A stopped or archived sandbox takes the new policy as it is; it has
        // nothing running to stop.
        step = "policy";
        await this.provider!.updateNetworkPolicy(
          sandbox.provider_sandbox_id,
          mutation.proposedMode === "trusted_only" ? effectiveDomains : null,
        );
        const observed = await this.provider!.getSandbox(sandbox.provider_sandbox_id);
        const expected = mutation.proposedMode === "trusted_only" ? [...effectiveDomains].sort() : [];
        if (observed.domainAllowList.slice().sort().join("\n") !== expected.join("\n")) throw new PolicyStepError("provider_policy_mismatch");
      } catch (error) {
        failures.push(policyStepFailure(step, error));
      }
      const applied = failures.every((failure) => failure.startsWith("final_diff:"));
      if (failures.length > 0) {
        logWarn(this.env, "terminal_policy_sandbox_failed", {
          workspace_id: this.auth.workspaceId,
          mutation_id: input.mutationId,
          workstream_id: sandbox.workstream_id,
          substream_id: sandbox.substream_id,
          sandbox_id: sandbox.provider_sandbox_id,
          reason: failures.join("."),
        });
      }
      await terminal.settlePolicyTransition({
        // Untouched unless this pass stopped it: the idle alarm may have moved it since it was loaded.
        lifecycleState: stopped ? "stopped" : null,
        failureCode: failures.length > 0 ? codeShaped(`policy_transition:${failures.join(".")}`) : null,
        clearSandboxId: false,
        clearOperationLease: stopped,
        // Revision 0 when the policy did not land: no organization revision is
        // 0, so the next acquisition reapplies the policy, and a run holding
        // this sandbox from before sees its claim go stale rather than keep
        // using the old egress.
        appliedNetworkRevision: applied ? resultingRevision : 0,
        generation: sandbox.generation,
        sandboxId: sandbox.provider_sandbox_id,
        now: epochMs,
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
      baselineManifestVersion: TERMINAL_NETWORK_MANIFEST_VERSION,
      at: timestamp,
    });
    const telemetryMode = (mode: TerminalNetworkMode, domains: string[]) => mode === "full_internet"
      ? "unrestricted" as const
      : domains.length > 0 ? "custom" as const : "restricted" as const;
    emitProductUsageTelemetry(this.env, {
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
    });
    return this.get();
  }

  private async loadActiveSandboxes(): Promise<SandboxRow[]> {
    // Every Canvas and Sidekick, whose conversations are the ones that can
    // own a sandbox now that Threads are retired (plan step C-2).
    const workspace = await durableObjectStubForWorkspace(this.env, this.env.WORKSPACE_DOS, this.auth.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(this.auth.workspaceId)));
    const directory = (await workspace.terminalSandboxParents({ workspaceId: this.auth.workspaceId }))
      .map((parent) => ({ workstream_id: parent.workstreamId, title: parent.title }));
    const rows: SandboxRow[] = [];
    const entries = directory;
    for (let offset = 0; offset < entries.length; offset += 20) {
      const page = entries.slice(offset, offset + 20);
      const loaded = await Promise.all(page.map(async (entry) => {
        // Every conversation of the work stream that owns a sandbox, from the
        // work stream's own object: a side thread's sandbox is under the same
        // egress policy as the main conversation's. The main conversation is
        // asked whatever the parent lists, as it was before conversations
        // reported their own: the list is a projection that reaches the parent
        // after the sandbox exists, and a policy applied in that gap must not
        // skip the main conversation's sandbox. A side thread's sandbox that
        // has not projected yet is skipped here and converges at its next
        // claim, which re-runs readiness against the new revision.
        const { items } = await (await conversationParentStub(this.env, {
          workspaceId: this.auth.workspaceId,
          parentKind: "workstream",
          parentId: entry.workstream_id,
        })).childTerminalDeadlines({ workspaceId: this.auth.workspaceId, parentId: entry.workstream_id });
        const substreamIds = ["0", ...items.map((item) => item.substreamId).filter((id) => id !== "0")];
        return Promise.all(substreamIds.map(async (substreamId) => {
          const sandbox = await createTerminalPortFactory(this.env)(
            this.auth.workspaceId,
            entry.workstream_id,
            substreamId,
          ).policyTarget();
          // A row a side thread or agent reserved under the work stream's one
          // name, before a sandbox belonged to a conversation, names the main
          // conversation's sandbox, which the main row already covers. Acting
          // on the alias as well would stop that sandbox twice and, on a
          // failure, delete one this conversation does not own.
          if (sandbox && await isLegacyTerminalAliasRow(sandbox, this.auth.workspaceId, entry.workstream_id, substreamId)) {
            return null;
          }
          return sandbox
            ? {
                workstream_id: entry.workstream_id,
                substream_id: substreamId,
                provider_sandbox_id: sandbox.sandboxId,
                state: sandbox.lifecycleState,
                generation: sandbox.generation,
                title: entry.title,
              }
            : null;
        }));
      }));
      rows.push(...loaded.flat().filter((row): row is SandboxRow => row !== null));
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
