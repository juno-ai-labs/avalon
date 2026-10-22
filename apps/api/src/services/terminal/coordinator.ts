import { refreshTerminalProviderObservation } from "./observation";
import type { HarnessToolContext } from "@rally/agent-harness";
import { newId } from "@rally/db";

import { asWorkspaceId } from "@rally/contracts";
import { workspaceDOName } from "../../durable-objects/names";
import {
  WorkspaceTerminalNetworkSettingsSchema,
  type WorkspaceTerminalNetworkPolicy,
} from "../../durable-objects/workspace-terminal-network-protocol";
import type {
  TerminalObjectPort,
} from "../../durable-objects/workstream-terminal-protocol";
import {
  TERMINAL_OPERATION_LEASE_MS,
  TERMINAL_YIELDED_RUN_STATUS_LIST,
  type TerminalRepositoryRecord,
  type TerminalSandboxRecord,
} from "../../durable-objects/workstream-terminal-storage";
import type { Env } from "../../env";
import { sha256 } from "../../lib/crypto";
import { durableObjectStubForWorkspace } from "../../lib/durable-object-namespace";
import { diagnosticErrorCode, logStructuredEvent } from "../../observability/logger";
import {
  createHarnessRunPortFactory,
  type HarnessRunPortFactory,
} from "../../runtime/harness-run-port";
import { conversationResourceLinksFrom, type ResourcePortFactory } from "../../runtime/resource-port";
import {
  executionPrincipalKey,
} from "../workstream-resource-visibility";
import type { TerminalRunScope } from "./authority";
import {
  terminalAcquisitionDeadlineAt,
  TERMINAL_OUTPUT_ROOT,
} from "./contract";
import {
  compileTerminalNetworkPolicy,
  TERMINAL_NETWORK_MANIFEST_VERSION,
} from "./network-policy";
import type { TerminalPortFactory } from "./object-port";
import {
  isTerminalProviderNotFound,
  deleteTerminalSandbox,
  observeTerminalSandbox,
  stopTerminalSandbox,
  isTerminalSandboxLost,
  assertTerminalSandboxReady,
  type TerminalSandboxProvider,
  type TerminalSandboxSnapshot,
  type TerminalSandboxState,
  type TerminalSandboxWaitOptions,
} from "./provider-contract";
import { TerminalToolError } from "./tools";

const WARM_STOP_MINUTES = 5;
const ARCHIVE_MINUTES = 60;
const EXPIRE_DAYS = 30;

/**
 * How long a running sandbox may go without a tool call before the lifecycle
 * sweep stops it. The same window `idle_expires_at` is derived from; exported
 * because the sweep reads activity from `last_command_at` too, now that a
 * lease is held per call and a busy run holds nothing between calls.
 */
export const TERMINAL_WARM_STOP_MS = WARM_STOP_MINUTES * 60_000;

/**
 * How long Daytona keeps a stopped sandbox that no Rally sweep will reach.
 *
 * A work stream's sandboxes are stopped, archived and expired by the
 * workspace alarm, whose directory entry the work stream's parent projects.
 * An automation's parent projects no Terminal deadline, so a Sidekick's
 * shared sandbox, owned by its authoring conversation, is retired by the
 * provider instead: Daytona stops one fifteen idle minutes
 * after its last use and deletes it this many minutes after that stop. The
 * number is Rally's own thirty-day expiry so that both kinds of sandbox
 * outlive their last use by the same time. Each later activation reuses the
 * Sidekick's sandbox while it remains available.
 */
export const AUTOMATION_SANDBOX_DELETE_AFTER_STOPPED_MINUTES = EXPIRE_DAYS * 24 * 60;

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

/**
 * Which conversation the coordinator's sandbox belongs to, and which one the
 * run holding it executes in.
 *
 * The two differ for Sidekick activations and for background agents. Their
 * sandbox lives in another conversation, while the lease they take is
 * held by a run whose row lives in another object, and `runsPort` is how the
 * coordinator asks that object whether such a holder has yielded.
 */
export interface TerminalSandboxScope extends TerminalRunScope {
  runsPort: HarnessRunPortFactory;
  /** Stable file identity, never execution authority. Preserves pre-delegation generations. */
  sharedFileUserId?: string;
}

const YIELDED_RUN_STATUSES = new Set<string>(TERMINAL_YIELDED_RUN_STATUS_LIST);

/**
 * The Daytona name a conversation's sandbox is created under.
 *
 * The main conversation keeps the derivation every deployed sandbox was
 * created with, so a work stream's existing sandbox is still found by name.
 * Any other conversation folds its substream in: before it did, a private
 * side thread of a work stream reserved the main conversation's name, the
 * provider refused the duplicate, and the fallback lookup by name handed the
 * thread the main conversation's sandbox under a second, independent lease.
 */
export async function terminalSandboxStableName(
  workspaceId: string,
  workstreamId: string,
  substreamId: string,
): Promise<string> {
  const identity = substreamId === "0"
    ? `${workspaceId}:${workstreamId}`
    : `${workspaceId}:${workstreamId}:${substreamId}`;
  const stableHash = await sha256(identity);
  return `avalon-${stableHash.replace(/[^a-zA-Z0-9]/gu, "").slice(0, 24).toLowerCase()}`;
}

/**
 * Whether a row was reserved under a name that is not this conversation's.
 *
 * Before a sandbox belonged to a conversation, every conversation of a work
 * stream derived the one name the main conversation still uses, so a side
 * thread or background agent that used Terminal reserved its row under that
 * name and was handed the main conversation's Daytona sandbox by the
 * create-then-lookup fallback. Such a row names a sandbox this conversation
 * does not own: readiness drops the row and reserves this conversation's own
 * name, and the lifecycle sweep and the policy application, which now reach
 * every conversation's row, refuse to stop, archive or delete through it.
 * The main conversation's derivation is unchanged, so its rows never match.
 */
export async function isLegacyTerminalAliasRow(
  row: { stableName: string | null },
  workspaceId: string,
  workstreamId: string,
  substreamId: string,
): Promise<boolean> {
  if (substreamId === "0" || !row.stableName) return false;
  return row.stableName !== await terminalSandboxStableName(workspaceId, workstreamId, substreamId);
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
    `The Terminal sandbox could not be made ready (provider state: ${state}). Retry the tool; Rally preserves this workspace while Daytona restores or recovers it.`,
    { retryAfterMs: 5_000, reason: `Retry once after Daytona leaves its ${state} state.` },
  );
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
    /**
     * The main conversation, holding its own sandbox, unless the plugin says
     * otherwise: the default is what every run was before a conversation's
     * sandbox could be used by the agents it starts.
     */
    private readonly scope: TerminalSandboxScope = {
      parentKind: "workstream",
      backgroundAgent: false,
      runSubstreamId: "0",
      authoritySubstreamId: "0",
      runsPort: createHarnessRunPortFactory(env),
    },
  ) {}

  /**
   * The conversation to record as the lease holder's, or `null` when the
   * holder's run row is in the sandbox's own object and the storage can read
   * its liveness itself.
   */
  /**
   * The conversation this run executes in, when it is not the sandbox's own;
   * what a lease claim and a task record carry so the owner's object can
   * tell a holder it cannot see from one it can.
   */
  holderSubstreamId(): string | null {
    return this.scope.runSubstreamId === this.scope.authoritySubstreamId
      ? null
      : this.scope.runSubstreamId;
  }

  /**
   * Ordinary conversations freeze files to their execution principal. A
   * Sidekick retains its original file identity across eligible coordinators;
   * the plugin checks live delegation separately before every operation.
   */
  private authorityFingerprint(
    context: HarnessToolContext,
    repositoryAuthority: RepositoryAuthorityRow | null,
  ): Promise<string> {
    return sha256(JSON.stringify({
      principal: this.scope.parentKind === "automation" && this.scope.sharedFileUserId
        ? `user:${this.scope.sharedFileUserId}` : executionPrincipalKey(context.executionPrincipal),
      repository: repositoryAuthority ?? "scratch",
    }));
  }

  /**
   * Take the operation lease for one tool call on a sandbox this run already
   * made ready.
   *
   * `acquire` returns holding the lease so its transitions are exclusive, and
   * every tool call releases the lease when it ends, so the next call takes
   * it again here rather than repeating the provider reads readiness paid
   * for. The answer is `stale` when the row no longer describes the sandbox
   * the caller was handed — another run replaced the generation, the sweep
   * stopped it, or the policy moved it — and the caller then runs readiness
   * again, which re-claims by the same run id and transitions under the lease
   * this call may already hold. A lease someone else holds is `sandbox_busy`,
   * as in `acquire`.
   */
  async claimForOperation(
    context: HarnessToolContext,
    sandbox: AcquiredTerminalSandbox,
  ): Promise<"held" | "stale"> {
    if (context.signal.aborted) {
      throw new TerminalToolError("cancelled", "The Terminal operation was cancelled before it took the workspace lease.");
    }
    const row = await this.terminal(context).sandbox();
    if (!row || row.generation !== sandbox.generation) return "stale";
    const claimed = await this.claimOperation(context, row, this.clock.now().getTime());
    return claimed.lifecycleState === "running"
      && claimed.sandboxId === sandbox.providerSandboxId
      && claimed.appliedNetworkRevision === sandbox.networkRevision
      ? "held"
      : "stale";
  }

  /**
   * Give the lease back; a no-op when this run does not hold it.
   *
   * Never throws: the call this follows has already produced its result, and
   * a release that fails is not that result's failure. The release is fenced
   * on this run being the holder, so a second attempt after a failed one
   * repeats nothing the first already did; it is made once, because a hop
   * that fails twice in a row is not going to be talked round by a third. A
   * release that still fails leaves the lease with this run until its next
   * call releases it, the run yields, or the lease deadline passes, and every
   * sibling sees `sandbox_busy` until then, so the failure is logged with its
   * reason rather than swallowed.
   */
  async release(context: HarnessToolContext): Promise<void> {
    const attempt = () => this.terminal(context).releaseOperation({
      runId: context.harnessRunId,
      now: this.clock.now().getTime(),
    });
    try {
      await attempt();
    } catch {
      try {
        await attempt();
      } catch (error) {
        logStructuredEvent(this.env, "warn", "terminal_lease_release_failed", {
          workspace_id: context.workspaceId,
          workstream_id: context.workstreamId,
          substream_id: this.scope.runSubstreamId,
          terminal_substream_id: this.scope.authoritySubstreamId,
          harness_run_id: context.harnessRunId,
          tool_call_id: context.toolCallId,
          reason: diagnosticErrorCode(error, "release_failed"),
        });
      }
    }
  }

  /**
   * The sandbox as a read may use it without taking the lease, or `null`
   * when a read has to go through `acquire` after all.
   *
   * A read changes nothing, so it needs no exclusivity; it needs the sandbox
   * to be running and to be *this caller's*: the authority fingerprint is
   * checked here exactly as `acquire` checks it, because a read of another
   * principal's files is the exposure that fingerprint exists to prevent.
   * Whether the provider still has it running is read from the last
   * observation rather than asked of Daytona on every read; a stale answer
   * costs one failed read and a retry through readiness.
   */
  async peekRunning(context: HarnessToolContext): Promise<AcquiredTerminalSandbox | null> {
    if (this.emergencyDisabled || context.signal.aborted) return null;
    const terminal = this.terminal(context);
    const [row, observation, repository] = await Promise.all([
      terminal.sandbox(),
      terminal.providerObservation(),
      terminal.selectedRepository(),
    ]);
    if (!row?.sandboxId || row.lifecycleState !== "running") return null;
    if (await isLegacyTerminalAliasRow(row, context.workspaceId, context.workstreamId, this.scope.authoritySubstreamId)) {
      return null;
    }
    // Everything readiness checks before it hands a sandbox out is checked
    // here too; a read is otherwise the one path that would run without it.
    const repositoryAuthority = await this.loadRepositoryAuthority(context.workspaceId, context.workstreamId, repository);
    if (row.authorityFingerprint !== await this.authorityFingerprint(context, repositoryAuthority)) return null;
    // A repository selected but not yet bootstrapped into this generation is
    // some run's preparation still in flight, and a read of a half-made
    // checkout is a read of the wrong files.
    if (repository && repository.bootstrappedSandboxGeneration !== row.generation) return null;
    if (await this.hasRevokedImportedResource(context, row)) return null;
    if (
      observation
      && observation.generation === row.generation
      && observation.sandboxId === row.sandboxId
      && observation.state !== null
      && observation.state !== "running"
    ) return null;
    return {
      providerSandboxId: row.sandboxId,
      stableName: requireStableName(row),
      generation: row.generation,
      state: "running",
      authorityFingerprint: row.authorityFingerprint,
      networkRevision: row.appliedNetworkRevision,
    };
  }

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
      const authorityFingerprint = await this.authorityFingerprint(context, repositoryAuthority);
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
    /**
     * The instant every provider wait below must not outlive: the same budget
     * the calling tool's own deadline was sized from. Policy loading,
     * authority replacement and network reconciliation all run before a
     * sandbox is started and all spend it, as do the provider RPC hop and the
     * adapter's sandbox lookup — so what is left is subtracted where it is
     * spent, and this end point stays fixed for the whole acquisition.
     */
    const waitBudget: TerminalSandboxWaitOptions = {
      deadlineAtMs: terminalAcquisitionDeadlineAt(acquisitionStartedAt),
    };
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
    const authorityFingerprint = await this.authorityFingerprint(context, repositoryAuthority);
    const domains = policy.mode === "trusted_only" ? parseEffectiveDomains(policy) : [];
    let row = await this.terminal(context).sandbox();
    if (row && await isLegacyTerminalAliasRow(row, context.workspaceId, context.workstreamId, this.scope.authoritySubstreamId)) {
      row = await this.retireLegacyAliasRow(context, row, now);
    }
    if (!row) {
      row = await this.reserveFirstGeneration(context, authorityFingerprint, policy.revision, now);
    }
    row = await this.claimOperation(context, row, now);
    let telemetryAction: TerminalAcquisitionObservation["action"] | null =
      row.sandboxId ? null : "start";
    let localFilesRetained = Boolean(row.sandboxId);

    // Before anything else touches the provider. Authority replacement deletes
    // the sandbox and policy reconciliation stops and reconfigures it, and both
    // used to drive from the row — so a work stream whose sandbox Daytona had
    // lost *and* whose authority or policy revision had moved threw a raw
    // provider error one branch earlier than the recovery below, and repeated
    // it on every later run. One read answers for all three.
    let observed = row.sandboxId ? await this.observeProviderSandbox(context, row) : null;
    if (row.sandboxId && !observed) throw providerStateError("unknown");
    if (row.sandboxId && isTerminalSandboxLost(observed)) {
      // A replacement carries this run's authority and policy revision, and
      // bumps the generation — which is everything the two steps below would
      // have done, without asking the provider about a sandbox it has lost.
      row = await this.replaceLostSandbox(
        context,
        row,
        authorityFingerprint,
        policy.revision,
        domains,
        now,
        waitBudget,
      );
      telemetryAction = "start_fresh";
      localFilesRetained = false;
    } else {
      const importedResourceRevoked = await this.hasRevokedImportedResource(context, row);
      if (
        (row.authorityFingerprint !== authorityFingerprint || importedResourceRevoked)
        && this.scope.backgroundAgent
      ) {
        // Only a primary run may replace shared files after authority changes.
        // A Sidekick activation is primary even though its sandbox lives in
        // the authoring conversation; delegated workers must leave it intact.
        throw new TerminalToolError(
          "sandbox_authority_mismatch",
          "The shared sandbox needs to be rebuilt because its permissions changed or an imported resource was revoked. A background agent cannot reset it.",
          { reason: "Ask the main agent in the owning conversation, or a Sidekick activation, to run a Terminal tool; then retry." },
        );
      }
      if (row.authorityFingerprint !== authorityFingerprint || importedResourceRevoked) {
        telemetryAction = "repository_replace";
        localFilesRetained = false;
        row = await this.replaceForAuthority(context, row, authorityFingerprint, policy.revision, now);
        observed = null;
      }

      if (row.appliedNetworkRevision !== policy.revision) {
        row = await this.reconcileNetworkPolicy(context, row, policy.revision, domains, now, observed);
        // That stop and policy write moved the sandbox, so the observation is
        // spent; the resume below reads the provider again rather than
        // deciding from a state that is now one transition old.
        observed = null;
      }

      if (!row.sandboxId) {
        row = await this.createReservedSandbox(context, row, domains, now, waitBudget);
      } else {
        const resumed = await this.resumeProviderSandbox(
          context,
          row,
          observed,
          authorityFingerprint,
          policy.revision,
          domains,
          now,
          waitBudget,
        );
        row = resumed.row;
        telemetryAction = resumed.action ?? telemetryAction;
        if (resumed.action === "start_fresh") localFilesRetained = false;
      }
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
    const runSubstreamId = this.holderSubstreamId();
    let claimed = await terminal.claimOperation({
      runId: context.harnessRunId,
      runSubstreamId,
      generation: row.generation,
      leaseExpiresAt,
      now,
    });
    let yieldedForeignHolder: { runId: string; substreamId: string } | null = null;
    if (!claimed) {
      // The storage could not read the holder's liveness if the holder ran in
      // another conversation. Ask that conversation, and hand the answer back
      // as an exact identity to take over from.
      yieldedForeignHolder = await this.yieldedForeignHolder(context, row);
      if (yieldedForeignHolder) {
        claimed = await terminal.claimOperation({
          runId: context.harnessRunId,
          runSubstreamId,
          generation: row.generation,
          leaseExpiresAt,
          now,
          yieldedForeignHolder,
        });
      }
    }
    if (!claimed) {
      claimed = await this.recoverYieldedOperation(
        context,
        row,
        now,
        yieldedForeignHolder,
      );
    }
    if (!claimed) {
      throw new TerminalToolError(
        "sandbox_busy",
        "Another agent run is using this Terminal workspace right now. Retry the tool in a few seconds; do not repeat any earlier command.",
        { retryAfterMs: 5_000, reason: "Retry in a few seconds; the workspace is released after each tool call." },
      );
    }
    return claimed;
  }

  /**
   * The lease holder as an identity to take over from, when it ran in another
   * conversation and that conversation says it has yielded; otherwise `null`.
   *
   * Asked over the wire rather than inside the claim because the holder's run
   * row is in the other conversation's object. The answer cannot go stale: a
   * yielded run never resumes its lease, and the takeover names the exact
   * holder, so a lease that moved on in between is simply not taken.
   */
  private async yieldedForeignHolder(
    context: HarnessToolContext,
    row: TerminalSandboxRecord,
  ): Promise<{ runId: string; substreamId: string } | null> {
    if (
      !row.operationRunId
      || !row.operationRunSubstreamId
      || row.operationRunId === context.harnessRunId
    ) return null;
    const holder = await this.scope
      .runsPort(context.workspaceId, context.workstreamId, row.operationRunSubstreamId)
      .run({ runId: row.operationRunId });
    // No row is what the storage's own predicate reads as yielded for a local
    // holder: a run that does not exist cannot be executing.
    if (holder && !YIELDED_RUN_STATUSES.has(holder.status)) return null;
    return { runId: row.operationRunId, substreamId: row.operationRunSubstreamId };
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
    yieldedForeignHolder: { runId: string; substreamId: string } | null = null,
  ): Promise<TerminalSandboxRecord | null> {
    const sandboxId = row.sandboxId;
    if (!sandboxId) return null;
    const terminal = this.terminal(context);
    const runSubstreamId = this.holderSubstreamId();
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
      yieldedForeignHolder,
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
            runSubstreamId,
            generation: row.generation,
            sandboxId,
            claimId,
            leaseExpiresAt: handoffLeaseExpiresAt,
            ...deadlines(new Date(handoffNow)),
            now: handoffNow,
          })
        : await terminal.settleYieldedOperationRecovery({
            runId: context.harnessRunId,
            runSubstreamId,
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
          await renewClaim();
          await deleteTerminalSandbox(this.provider, sandboxId);
          sandboxRetired = true;
          sandboxStopped = false;
        } else if (!sandboxRetired && !sandboxStopped && task.state === "running") {
          // Production proved that deleting Daytona's named session can remove
          // observation while its accepted command keeps running. Stop the
          // whole sandbox before cancelling the durable task or handing its
          // lease to a linked run; start preserves the sandbox filesystem.
          await renewClaim();
          sandboxRetired = await stopTerminalSandbox(this.provider, sandboxId) === "absent";
          sandboxStopped = !sandboxRetired;
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
    selected?: TerminalRepositoryRecord | null,
  ): Promise<RepositoryAuthorityRow | null> {
    const repository = selected === undefined
      ? await this.terminalPort(workspaceId, workstreamId).selectedRepository()
      : selected;
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
    const links = await this.terminal(context).importedResources(row.generation);
    if (links.length === 0) return false;
    if (links.some((candidate) => candidate.state !== "completed")) return true;
    // Completed imports are retained Sidekick state, like its shared history.
    // A new import still checks the selected user's current read access.
    if (this.scope.parentKind === "automation") return false;
    // The attachment join used to ride along with the import rows. It cannot:
    // the imports are object-local and the relationship rows are not, so the
    // link check is its own statement against its own authority. Which
    // authority is the import's own: use the conversation whose run made it,
    // the sandbox's own unless the row names another. Sidekicks may also use
    // the execution user's current canonical read access without a link.
    // Asking the acquiring run's conversation instead
    // would read a background agent's imports against its owner's
    // attachments, and the owner's against the agent's, and revoke both.
    // Read through the conversation's links, not its bare port: a Breakout
    // imports what its Channel attached, and that link is not in its own table.
    const byConversation = new Map<string, Set<string>>();
    for (const link of links) {
      const substreamId = link.attachedSubstreamId ?? this.scope.authoritySubstreamId;
      const resourceIds = byConversation.get(substreamId) ?? new Set<string>();
      resourceIds.add(link.resourceId);
      byConversation.set(substreamId, resourceIds);
    }
    for (const [substreamId, resourceIds] of byConversation) {
      const readable = new Set((await conversationResourceLinksFrom(
        this.resourcePort, context.workspaceId, context.workstreamId, substreamId, { env: this.env, principal: context.executionPrincipal },
      ).links({ resourceIds: [...resourceIds] })).readableResourceIds);
      for (const resourceId of resourceIds) {
        if (!readable.has(resourceId)) return true;
      }
    }
    const resourceIds = [...new Set(links.map((candidate) => candidate.resourceId))];
    const placeholders = resourceIds.map(() => "?").join(", ");
    const resources = await this.env.DB.prepare(
      `SELECT id, provider FROM resources
        WHERE workspace_id = ? AND id IN (${placeholders})`,
    ).bind(context.workspaceId, ...resourceIds)
      .all<{ id: string; provider: string }>();
    if (resources.results.length !== resourceIds.length) return true;
    return resources.results.some((candidate) => candidate.provider === "avalon_note");
  }

  /**
   * Forget a row reserved under another conversation's name; see
   * `isLegacyTerminalAliasRow`. Nothing here stops, archives or deletes the
   * sandbox the row names, because it is the main conversation's: the row
   * alone is dropped, with the imports and bootstrap mark that belonged to
   * it, and the caller reserves this conversation's own name as if the row
   * had never existed.
   */
  private async retireLegacyAliasRow(
    context: HarnessToolContext,
    row: TerminalSandboxRecord,
    now: number,
  ): Promise<null> {
    await this.terminal(context).resetSandbox({ generation: row.generation, now });
    logStructuredEvent(this.env, "info", "terminal_legacy_alias_row_retired", {
      workspace_id: context.workspaceId,
      workstream_id: context.workstreamId,
      substream_id: this.scope.runSubstreamId,
      terminal_substream_id: this.scope.authoritySubstreamId,
      harness_run_id: context.harnessRunId,
      sandbox_generation: row.generation,
    });
    return null;
  }

  private async reserveFirstGeneration(
    context: HarnessToolContext,
    authorityFingerprint: string,
    networkRevision: number,
    now: number,
  ): Promise<TerminalSandboxRecord> {
    const stableName = await terminalSandboxStableName(
      context.workspaceId,
      context.workstreamId,
      this.scope.authoritySubstreamId,
    );
    return this.terminal(context).reserveFirstGeneration({
      stableName,
      authorityFingerprint,
      networkRevision,
      runId: context.harnessRunId,
      runSubstreamId: this.holderSubstreamId(),
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
    waitBudget: TerminalSandboxWaitOptions,
  ): Promise<TerminalSandboxRecord> {
    let created: TerminalSandboxSnapshot;
    try {
      created = await this.provider.createSandbox({
        stableName: requireStableName(row),
        workspaceId: context.workspaceId,
        workstreamId: context.workstreamId,
        substreamId: this.scope.authoritySubstreamId,
        generation: row.generation,
        domainAllowList: domains,
        environment: { AVALON_RESOURCE_DIR: TERMINAL_OUTPUT_ROOT },
        ...(this.scope.parentKind === "automation"
          ? { autoDeleteAfterStoppedMinutes: AUTOMATION_SANDBOX_DELETE_AFTER_STOPPED_MINUTES }
          : {}),
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
        try {
          await this.provider.startSandbox(created.id, waitBudget);
        } catch {
          // The same reasoning `resumeProviderSandbox` documents, and this
          // call site now needs it for the same reason: the wait is bounded by
          // the caller's deadline rather than a fixed minute, so running out
          // of it is an ordinary outcome rather than a provider fault. A raw
          // Daytona error escaping here would reach the model as an
          // unclassified tool failure instead of a retryable
          // `sandbox_unavailable` with guidance.
          //
          // The generation is deliberately not failed. The sandbox exists and
          // is most likely still starting, and it is reachable by its stable
          // name — the ambiguous-create reconcile above adopts it on the next
          // attempt. Failing the generation here would discard a live sandbox
          // over a wait that merely ran out.
          const settled = await observeTerminalSandbox(this.provider, created.id)
            .catch(() => undefined);
          if (settled?.state !== "running") throw providerStateError(settled?.state ?? "unknown");
        }
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

  private async assertRestoredSandboxReady(sandboxId: string): Promise<void> {
    try {
      await assertTerminalSandboxReady(this.provider, sandboxId);
    } catch {
      // Only restore/recovery needs a preflight. Ordinary operations establish
      // their own availability without treating an endpoint error as deletion.
      throw new TerminalToolError(
        "sandbox_unavailable",
        "The Terminal sandbox is retained, but its command or file service is not ready. Retry the tool.",
        { reason: "Retry when Daytona can serve both commands and files." },
      );
    }
  }

  /** Resume the same identity, or recover its backup, before considering replacement. */
  private async resumeProviderSandbox(
    context: HarnessToolContext,
    row: TerminalSandboxRecord,
    /** What the caller already observed, or `null` to read it here. */
    observation: TerminalSandboxSnapshot | null,
    authorityFingerprint: string,
    networkRevision: number,
    domains: string[],
    now: number,
    waitBudget: TerminalSandboxWaitOptions,
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
        waitBudget,
      ),
      action: "start_fresh",
    });
    const observed = observation ?? await this.observeProviderSandbox(context, row);
    if (!observed) throw providerStateError("unknown");
    if (isTerminalSandboxLost(observed)) return replaceLost();
    if (observed.state === "running") {
      if (row.lifecycleState === "running") {
        await this.refreshDeadlines(context, row, now);
        return { row, action: null };
      }
      await this.assertRestoredSandboxReady(sandboxId);
      await this.setRunning(context, row, now);
      return {
        row: { ...row, lifecycleState: "running", version: row.version + 1 },
        action: "restore",
      };
    }
    const recover = observed.state === "failed" && observed.recoverable === true;
    if (!recover && observed.state !== "stopped" && observed.state !== "archived") {
      throw providerStateError(observed.state);
    }
    try {
      if (recover) await this.provider.recoverSandbox(sandboxId, waitBudget);
      else await this.provider.startSandbox(sandboxId, waitBudget);
    } catch (error) {
      // A start that throws has not said what became of the sandbox. Ask,
      // rather than treating every failure as a lost workspace: a restore that
      // ran past the start call's own deadline is still on its way, and
      // discarding the files for that would make this method cause the loss it
      // exists to recover from.
      const settled = await this.observeProviderSandbox(context, row);
      if (isTerminalSandboxLost(settled)) return replaceLost();
      if (!settled || settled.state !== "running") throw providerStateError(settled?.state ?? "unknown");
      logStructuredEvent(this.env, "info", "terminal_sandbox_start_settled_after_error", {
        workspace_id: context.workspaceId,
        workstream_id: context.workstreamId,
        substream_id: this.scope.runSubstreamId,
        terminal_substream_id: this.scope.authoritySubstreamId,
        harness_run_id: context.harnessRunId,
        sandbox_generation: row.generation,
        reason: error instanceof Error ? error.name : "unknown",
      });
    }
    await this.assertRestoredSandboxReady(sandboxId);
    await this.setRunning(context, row, now);
    return {
      row: { ...row, lifecycleState: "running", version: row.version + 1 },
      action: "restore",
    };
  }

  /**
   * What the provider reports, or `null` when its metadata lookup returns 404.
   *
   * A provider that cannot be reached is not a lost sandbox and must not be
   * treated as one. Unexpected absence preserves the binding for reconciliation.
   */
  private async observeProviderSandbox(
    context: HarnessToolContext,
    row: TerminalSandboxRecord,
  ): Promise<TerminalSandboxSnapshot | null> {
    try {
      return await refreshTerminalProviderObservation(this.terminal(context), this.provider, {
        sandboxId: row.sandboxId!, generation: row.generation,
      });
    } catch {
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
   * delete must succeed or metadata must confirm absence before Rally releases
   * the identity. An errored sandbox still exists and must not be orphaned.
   */
  private async replaceLostSandbox(
    context: HarnessToolContext,
    row: TerminalSandboxRecord,
    authorityFingerprint: string,
    networkRevision: number,
    domains: string[],
    now: number,
    waitBudget: TerminalSandboxWaitOptions,
  ): Promise<TerminalSandboxRecord> {
    logStructuredEvent(this.env, "warn", "terminal_sandbox_replaced_after_loss", {
      workspace_id: context.workspaceId,
      workstream_id: context.workstreamId,
      substream_id: this.scope.runSubstreamId,
      terminal_substream_id: this.scope.authoritySubstreamId,
      harness_run_id: context.harnessRunId,
      sandbox_generation: row.generation,
      lifecycle_state: row.lifecycleState,
    });
    if (row.sandboxId) await deleteTerminalSandbox(this.provider, row.sandboxId);
    const replaced = await this.terminal(context).replaceGeneration({
      generation: row.generation,
      authorityFingerprint,
      networkRevision,
      runId: context.harnessRunId,
      runSubstreamId: this.holderSubstreamId(),
      operationLeaseExpiresAt: this.clock.now().getTime() + TERMINAL_OPERATION_LEASE_MS,
      ...deadlines(this.clock.now()),
      now,
    });
    return this.createReservedSandbox(context, replaced, domains, now, waitBudget);
  }

  private async replaceForAuthority(
    context: HarnessToolContext,
    row: TerminalSandboxRecord,
    authorityFingerprint: string,
    networkRevision: number,
    now: number,
  ): Promise<TerminalSandboxRecord> {
    if (row.sandboxId) await deleteTerminalSandbox(this.provider, row.sandboxId);
    return this.terminal(context).replaceGeneration({
      generation: row.generation,
      authorityFingerprint,
      networkRevision,
      runId: context.harnessRunId,
      runSubstreamId: this.holderSubstreamId(),
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
    /** The provider state acquisition already read, when it has one. */
    observation: TerminalSandboxSnapshot | null = null,
  ): Promise<TerminalSandboxRecord> {
    if (row.sandboxId) {
      // The provider decides whether there is anything to stop. Driving this
      // from `lifecycle_state` stopped a sandbox Daytona had already stopped —
      // and, worse, left one Daytona still had running unstopped while its
      // egress policy was rewritten underneath it.
      const running = observation ? observation.state === "running" : row.lifecycleState === "running";
      if (running) await this.provider.stopSandbox(row.sandboxId);
      await this.provider.updateNetworkPolicy(row.sandboxId, domains.length ? domains : null);
      // Read back before stamping the revision: a policy change that failed for
      // this sandbox leaves it to this path, and a write Daytona accepted but did
      // not apply would otherwise resume it on the old egress, no longer stale.
      const applied = (await this.provider.getSandbox(row.sandboxId)).domainAllowList.slice().sort();
      if (applied.join("\n") !== [...domains].sort().join("\n")) {
        throw new TerminalToolError(
          "network_policy_unverified",
          "Daytona did not confirm the organization's network policy on this sandbox, so Rally left it stopped.",
          { reason: "Retry the same tool; Rally applies the policy again before it starts the sandbox." },
        );
      }
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
