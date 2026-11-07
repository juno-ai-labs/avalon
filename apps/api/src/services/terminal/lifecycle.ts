import { newId } from "@rally/db";
import {
  createTerminalPortFactory,
  type TerminalPortFactory,
} from "./object-port";
import type { TerminalObjectPort } from "../../durable-objects/workstream-terminal-protocol";
import { TERMINAL_OPERATION_LEASE_MS } from "../../durable-objects/workstream-terminal-storage";

import type { Env } from "../../env";
import { sha256Hex } from "../../lib/crypto";
import {
  attachWorkstreamRuntimeResource,
  type WorkstreamRuntimeResourceAttacher,
} from "../workstream-object-client";
import {
  deleteTerminalSandbox,
  isTerminalSandboxLost,
  observeTerminalSandbox,
  stopTerminalSandbox,
  type TerminalSandboxProvider,
} from "./provider-contract";
import { isLegacyTerminalAliasRow, TERMINAL_WARM_STOP_MS } from "./coordinator";
import { TerminalToolError } from "./tools";
import type { HarnessRunPortFactory } from "../../runtime/harness-run-port";
import { putStagedResourceObject } from "../resource-object-cleanup";
import { unlistedResourceMetadata } from "../resource-listing";

const MAX_WORKSPACE_BACKUP_BYTES = 50 * 1_048_576;

export interface TerminalWorkspaceBackup {
  resourceId: string;
  title: string;
  mimeType: "application/gzip";
  sizeBytes: number;
  sourceSha256: string;
  createdAt: string;
}

export type TerminalLifecycleTransition = "none" | "deferred" | "stopped" | "archived" | "expired";

function isDue(value: number | null, now: Date): boolean {
  return value !== null && value <= now.getTime();
}

/**
 * Make every unsettled durable command task quiescent at Daytona before a
 * lifecycle transition runs preservation or another provider operation.
 */
async function quiesceUnsettledTasks(
  terminal: TerminalObjectPort,
  provider: TerminalSandboxProvider,
  providerSandboxId: string,
  generation: number,
  claimId: string,
  claimNow: () => number,
): Promise<{ sandboxStopped: boolean; sandboxAbsent: boolean; sandboxLost: boolean }> {
  let sandboxStopped = false;
  let sandboxAbsent = false;
  let sandboxLost = false;
  const renewClaim = async (): Promise<void> => {
    const renewedAt = claimNow();
    const renewed = await terminal.renewLifecycleClaim({
      generation,
      sandboxId: providerSandboxId,
      claimId,
      claimExpiresAt: renewedAt + TERMINAL_OPERATION_LEASE_MS,
      now: renewedAt,
    });
    if (!renewed) throw new Error("terminal_lifecycle_claim_lost");
  };
  while (true) {
    const task = await terminal.unsettledTask(generation);
    if (!task) return { sandboxStopped, sandboxAbsent, sandboxLost };

    if (!sandboxAbsent && task.state !== "running") {
      // Stop/restart cannot exclude pre-acceptance work that may still reach
      // the provider. Retire the sandbox so any stale request targets only the
      // old generation; `planned` stays fail-safe if admission ever moves
      // before provider submission.
      await renewClaim();
      await deleteTerminalSandbox(provider, providerSandboxId);
      // Successful deletion and provider-confirmed absence both retire this generation.
      sandboxAbsent = true;
      sandboxStopped = false;
    } else if (!sandboxAbsent && !sandboxStopped && task.state === "running") {
      // Removing a Daytona session is not process-quiescence evidence: a live
      // accepted command can keep mutating after the session handle disappears.
      // Whole-sandbox stop is the provider boundary scheduled cleanup needs.
      await renewClaim();
      try {
        sandboxAbsent = await stopTerminalSandbox(provider, providerSandboxId) === "absent";
      } catch (error) {
        // An unrecoverable sandbox never stops, and its command dies with it.
        const observed = await observeTerminalSandbox(provider, providerSandboxId).catch(() => null);
        if (!isTerminalSandboxLost(observed)) throw error;
        await deleteTerminalSandbox(provider, providerSandboxId);
        sandboxAbsent = true;
        sandboxLost = true;
      }
      sandboxStopped = !sandboxAbsent;
    }

    const settled = await terminal.cancelTaskAfterProviderCleanup({
      taskId: task.taskId,
      runId: task.runId,
      effectIntentId: task.effectIntentId,
      sandboxGeneration: task.sandboxGeneration,
      providerTaskName: task.providerTaskName,
      claimId,
      now: claimNow(),
    });
    if (!settled) throw new Error("terminal_task_cleanup_fence_lost");
  }
}

export async function reconcileDueTerminalSandbox(
  runsPort: HarnessRunPortFactory,
  terminalPort: TerminalPortFactory,
  provider: TerminalSandboxProvider,
  workspaceId: string,
  workstreamId: string,
  now = new Date(),
  preserveBeforeExpiry?: (providerSandboxId: string, generation: number) => Promise<void>,
  providerClaimClock?: () => number,
  /** The conversation whose object owns this sandbox; the main one by default. */
  substreamId = "0",
): Promise<{
  transition: TerminalLifecycleTransition;
  /** Set when the pass deleted a sandbox Daytona reported unrecoverable. */
  lostSandbox?: true;
}> {
  const claimClockStartedAt = Date.now();
  const claimNow = providerClaimClock
    ?? (() => now.getTime() + (Date.now() - claimClockStartedAt));
  const terminal = terminalPort(workspaceId, workstreamId, substreamId);
  const row = await terminal.sandbox();
  if (!row?.sandboxId || row.lifecycleState === "expired") return { transition: "none" };
  // A row a side thread or background agent reserved under the work stream's
  // one name, before a sandbox belonged to a conversation, names the main
  // conversation's sandbox. It is dropped without a provider call: that
  // sandbox is the main conversation's to stop, archive or delete, and this
  // conversation reserves its own on its next use.
  if (await isLegacyTerminalAliasRow(row, workspaceId, workstreamId, substreamId)) {
    await terminal.resetSandbox({ generation: row.generation, now: now.getTime() });
    return { transition: "none" };
  }

  if (
    row.operationRunId
    && row.operationLeaseExpiresAt
    && row.operationLeaseExpiresAt > now.getTime()
  ) {
    // The holder's run row is in the conversation it executed in, which is
    // the sandbox's own unless a background agent holds its owner's lease.
    const holderSubstreamId = row.operationRunSubstreamId ?? substreamId;
    if (await runsPort(workspaceId, workstreamId, holderSubstreamId).runIsActive({ runId: row.operationRunId })) {
      return { transition: "deferred" };
    }
  }

  // A running sandbox whose last tool call is inside the warm window is in
  // use, whatever `idle_expires_at` says: the lease is held per call, so a
  // busy run holds nothing between two of its calls, and the claim's
  // `last_command_at` stamp is what stands in for the holder it used to be.
  if (
    row.lifecycleState === "running"
    && row.lastCommandAt !== null
    && row.lastCommandAt + TERMINAL_WARM_STOP_MS > now.getTime()
  ) return { transition: "deferred" };

  if (await terminal.hasLiveTask(row.generation, now.getTime())) return { transition: "deferred" };

  const desired = row.lifecycleState === "expiring"
    ? "expired" as const
    : row.lifecycleState === "archiving"
      ? "archived" as const
      : row.lifecycleState === "stopping"
        ? "stopped" as const
        : isDue(row.expireDueAt, now)
    ? "expired" as const
    : row.lifecycleState === "running" && isDue(row.idleExpiresAt, now)
      ? "stopped" as const
      : row.lifecycleState === "stopped" && isDue(row.archiveDueAt, now)
        ? "archived" as const
        : null;
  if (!desired) return { transition: "none" };

  const claimId = newId(now.getTime());
  const intermediate = desired === "expired" ? "expiring" : desired === "archived" ? "archiving" : "stopping";
  const claimed = await terminal.claimLifecycleTransition({
    lifecycleState: intermediate,
    claimId,
    claimExpiresAt: now.getTime() + TERMINAL_OPERATION_LEASE_MS,
    generation: row.generation,
    version: row.version,
    now: now.getTime(),
  });
  // A refused claim means another pass holds the transition or moved the row
  // first; either way the deadline stays put, so wait rather than stall.
  if (!claimed) return { transition: "deferred" };
  if (!claimed.sandboxId) return { transition: "none" };
  const claimedSandboxId = claimed.sandboxId;
  const renewClaim = async (): Promise<void> => {
    const renewedAt = claimNow();
    const renewed = await terminal.renewLifecycleClaim({
      generation: row.generation,
      sandboxId: claimedSandboxId,
      claimId,
      claimExpiresAt: renewedAt + TERMINAL_OPERATION_LEASE_MS,
      now: renewedAt,
    });
    if (!renewed) throw new Error("terminal_lifecycle_claim_lost");
  };
  const settleMissingSandbox = async (
    deletionConfirmed = false,
    lost = false,
  ): Promise<{ transition: TerminalLifecycleTransition; lostSandbox?: true }> => {
    const flag = lost ? { lostSandbox: true as const } : {};
    if (desired === "expired") {
      const settled = await terminal.settleLifecycleTransition({
        lifecycleState: "expired",
        claimId,
        now: now.getTime(),
      });
      if (!settled) {
        throw new Error(
          `terminal_lifecycle_expiry_tasks_unsettled: generation=${row.generation} claim=${claimId}`,
        );
      }
      return { transition: "expired", ...flag };
    }
    if (!deletionConfirmed) throw new Error("terminal_lifecycle_metadata_missing");
    const retired = await terminal.retireMissingSandboxAfterLifecycleClaim({
      generation: row.generation,
      sandboxId: claimedSandboxId,
      claimId,
      now: now.getTime(),
    });
    if (!retired) throw new Error("terminal_lifecycle_missing_sandbox_retirement_lost");
    return { transition: "deferred", ...flag };
  };

  let settledState = desired;
  let archiveRequested = false;
  let transitionError: unknown;
  try {
    const cleanup = await quiesceUnsettledTasks(
      terminal,
      provider,
      claimedSandboxId,
      row.generation,
      claimId,
      claimNow,
    );
    if (cleanup.sandboxAbsent) return await settleMissingSandbox(true, cleanup.sandboxLost);
    const observed = await observeTerminalSandbox(provider, claimedSandboxId);
    if (!observed || observed.state === "expired") return await settleMissingSandbox(observed?.state === "expired");
    if (isTerminalSandboxLost(observed)) {
      // Nothing reaches an unrecoverable sandbox; delete it, as acquisition does.
      await renewClaim();
      await deleteTerminalSandbox(provider, claimedSandboxId);
      return await settleMissingSandbox(true, true);
    }
    let providerStopped = observed.state === "stopped" || observed.state === "archived";
    if (desired !== "expired" && !providerStopped && observed.state !== "running") {
      throw new Error("terminal_lifecycle_provider_transition_pending");
    }
    if (desired !== "expired" && observed.state === "archived") {
      // Daytona's backstop already advanced further than Rally's deadline.
      settledState = "archived";
    } else if (desired === "stopped") {
      if (providerStopped && preserveBeforeExpiry) {
        await renewClaim();
        await provider.startSandbox(claimedSandboxId);
        providerStopped = false;
      }
      await renewClaim();
      await preserveBeforeExpiry?.(claimedSandboxId, row.generation);
      if (!providerStopped) {
        await renewClaim();
        await provider.stopSandbox(claimedSandboxId);
      }
    } else if (desired === "archived") {
      await renewClaim();
      if (!providerStopped) await provider.stopSandbox(claimedSandboxId);
      await renewClaim();
      await provider.archiveSandbox(claimedSandboxId);
      archiveRequested = true;
      // archive() accepts the request; unlike start()/stop() it does not wait.
      const archived = await observeTerminalSandbox(provider, claimedSandboxId);
      if (!archived || archived.state === "expired") return await settleMissingSandbox(archived?.state === "expired");
      if (archived.state !== "archived") throw new Error("terminal_lifecycle_archive_pending");
    } else {
      // The final diff was captured before the sandbox was stopped. Daytona
      // archives cannot execute commands, so expiry only deletes them.
      if (observed.state !== "archived") {
        if (preserveBeforeExpiry && observed.state === "failed" && observed.recoverable === true) {
          await renewClaim();
          await provider.recoverSandbox(claimedSandboxId);
        }
        if (providerStopped && preserveBeforeExpiry) {
          await renewClaim();
          await provider.startSandbox(claimedSandboxId);
          providerStopped = false;
        }
        await renewClaim();
        await preserveBeforeExpiry?.(claimedSandboxId, row.generation);
      }
      await renewClaim();
      await provider.clearGitHubReadAccess(claimedSandboxId).catch(() => undefined);
      await renewClaim();
      await provider.deleteSandbox(claimedSandboxId);
    }
  } catch (error) {
    transitionError = error;
    // Toolbox/runner 404s say nothing about the retained sandbox identity.
    const observed = await observeTerminalSandbox(provider, claimedSandboxId).catch(() => undefined);
    if (observed?.state === "expired" || (observed === null && desired === "expired")) {
      return settleMissingSandbox(true);
    }
    const reconciled = desired === "stopped"
      ? observed?.state === "stopped" || observed?.state === "archived"
      : desired === "archived"
        ? observed?.state === "archived"
        : false;
    if (reconciled && observed?.state === "archived") settledState = "archived";
    if (!reconciled) {
      const stableState = desired === "stopped"
        ? "running" as const
        : desired === "archived"
          ? "stopped" as const
          : row.lifecycleState === "archived" ? "archived" as const : "stopped" as const;
      const pending = observed?.state === "starting"
        || (archiveRequested && observed?.state === "stopped");
      // Releasing the claim also clears its deadline. Restore the prior stable
      // intent so the directory continues projecting the due stop/archive
      // deadline; an intermediate state without a claim would sleep to expiry.
      await terminal.failLifecycleClaim({
        lifecycleState: stableState,
        failureCode: pending ? null : `${desired}_provider_failed`,
        claimId,
        now: now.getTime(),
      });
      if (pending) return { transition: "deferred" };
      throw error;
    }
  }

  const settled = await terminal.settleLifecycleTransition({
    lifecycleState: settledState,
    claimId,
    now: now.getTime(),
  });
  if (!settled) throw transitionError ?? new Error("terminal_lifecycle_settlement_lost");
  return { transition: settledState };
}

/**
 * Captures repository work that would otherwise disappear with an expired
 * Daytona archive. The provider command bounds bytes before they cross the
 * Worker boundary; large diffs become a bounded stat summary instead of a
 * corrupt partial patch.
 */
export function createTerminalFinalDiffPreserver(
  env: Env,
  provider: Pick<TerminalSandboxProvider, "runUtilityCommand">,
  workspaceId: string,
  workstreamId: string,
  /** The conversation whose object owns the sandbox; the main one by default. */
  substreamId = "0",
): (providerSandboxId: string, generation: number) => Promise<void> {
  return async (providerSandboxId, generation) => {
    const workspace = env.DB;
    const terminal = createTerminalPortFactory(env)(workspaceId, workstreamId, substreamId);
    if (await terminal.finalDiffResourceId()) return;
    const result = await provider.runUtilityCommand(providerSandboxId, {
      operation: "lifecycle.final_diff",
      cwd: "/workspace",
      timeoutMs: 60_000,
      command: [
        "set -euo pipefail",
        "git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0",
        "tmp=$(mktemp)",
        "trap 'rm -f \"$tmp\"' EXIT",
        "git diff --binary --no-ext-diff HEAD > \"$tmp\"",
        "test -s \"$tmp\" || exit 0",
        "if [ \"$(wc -c < \"$tmp\")\" -le 10485760 ]; then cat \"$tmp\"; else printf 'AVALON_DIFF_SUMMARY\\n'; git diff --stat --no-ext-diff HEAD | sed -n '1,2000p'; fi",
      ].join("\n"),
    });
    if (result.exitCode !== 0 || !result.stdout) return;
    const summaryOnly = result.stdout.startsWith("AVALON_DIFF_SUMMARY\n");
    const content = summaryOnly ? result.stdout.slice("AVALON_DIFF_SUMMARY\n".length) : result.stdout;
    const bytes = new TextEncoder().encode(content);
    if (bytes.byteLength === 0 || bytes.byteLength > 10 * 1_048_576) return;
    const resourceId = newId();
    const providerResourceId = `terminal-final-diff:${workstreamId}:${generation}:${resourceId}`;
    const digest = await sha256Hex(bytes);
    const timestamp = new Date().toISOString();
    const objectRef = `${env.AVALON_REGION}/${workspaceId}/resources/${resourceId}/terminal-final-diff/${digest}`;
    await putStagedResourceObject({
      database: workspace,
      payloads: env.PAYLOADS,
      objectRef,
      workspaceId,
      resourceId,
      objectKind: "original",
      value: bytes,
      options: {
        httpMetadata: { contentType: summaryOnly ? "text/plain" : "text/x-diff" },
        customMetadata: { source: "terminal", sandboxGeneration: String(generation) },
      },
      at: timestamp,
    });
    const resourceStatement = workspace.prepare(
        `INSERT INTO resources
         (id, workspace_id, resource_type, provider, provider_resource_id, title, mime_type,
          content_ref, content_sha256, metadata_json, last_hydrated_at, attachment_status,
          model_content_status, created_at, updated_at)
         VALUES (?, ?, 'generated_file', 'avalon_generated', ?, ?, ?, ?, ?, ?, ?,
                 'attached', 'pending', ?, ?)`,
      ).bind(
        resourceId,
        workspaceId,
        providerResourceId,
        summaryOnly ? "Terminal final diff summary" : "Terminal final diff",
        summaryOnly ? "text/plain" : "text/x-diff",
        objectRef,
        digest,
        JSON.stringify({ source: "terminal_expiry", generation, summaryOnly, size: bytes.byteLength }),
        timestamp,
        timestamp,
        timestamp,
      );
    const cleanupStatement = workspace.prepare(
        `DELETE FROM resource_object_deletion_outbox
          WHERE workspace_id = ? AND object_ref = ? AND cleanup_eligible = 0`,
      ).bind(workspaceId, objectRef);
    // The resource and its object-cleanup outbox are WorkspaceDO authority;
    // the link is the work-stream object's. The link runs after the resource
    // is durable, so a failure between them leaves a capturable diff rather
    // than a resource id pointing at nothing.
    //
    // The one-batch arm that used to sit here ran only when no workspace
    // runtime database was installed, which production requires before request
    // dispatch — so it has not run since the cutover, and it wrote
    // `workstream_resources` through a view this slice retires.
    // A resource or link mutation failure may be an acknowledged-after-commit
    // response loss. Keep staging fenced; a committed pointer is reconciled by
    // maintenance, while an inactive row requires explicit recovery.
    await resourceStatement.run();
    await attachWorkstreamRuntimeResource(env, {
      workspaceId,
      workstreamId,
      resourceId,
      attachedByUserId: null,
      relationshipType: "generated",
    });
    await cleanupStatement.run().catch(() => undefined);
    await terminal.setFinalDiffResourceId(resourceId, Date.now());
  };
}

/**
 * Creates the durable recovery point required before repository replacement.
 * Provider credentials and the live .git directory are excluded; source files,
 * untracked files, databases, generated artifacts, and a portable Git bundle
 * of local refs remain in the archive.
 */
export function createTerminalWorkspaceBackup(
  env: Env,
  provider: Pick<TerminalSandboxProvider, "readFile" | "runUtilityCommand">,
  input: {
    workspaceId: string;
    workstreamId: string;
    toolCallId: string;
    repositoryFullName: string;
    providerSandboxId: string;
    generation: number;
    signal: AbortSignal;
  },
  inObjectResourceAttacher?: WorkstreamRuntimeResourceAttacher,
): Promise<TerminalWorkspaceBackup | null> {
  return createWorkspaceBackup();

  async function createWorkspaceBackup(): Promise<TerminalWorkspaceBackup | null> {
    const workspace = env.DB;
    const providerResourceId = `terminal-workspace-backup:${input.toolCallId}`;
    const existing = await workspace.prepare(
      `SELECT id, title, mime_type, content_sha256, metadata_json, created_at
         FROM resources
        WHERE workspace_id = ? AND provider = 'avalon_generated' AND provider_resource_id = ?`,
    ).bind(input.workspaceId, providerResourceId).first<{
      id: string;
      title: string;
      mime_type: string;
      content_sha256: string;
      metadata_json: string;
      created_at: string;
    }>();
    if (existing) {
      const metadata = JSON.parse(existing.metadata_json) as { size?: unknown };
      return {
        resourceId: existing.id,
        title: existing.title,
        mimeType: "application/gzip",
        sizeBytes: Number(metadata.size ?? 0),
        sourceSha256: existing.content_sha256,
        createdAt: existing.created_at,
      };
    }

    const safeCallId = input.toolCallId.replace(/[^a-zA-Z0-9_-]/gu, "").slice(0, 64);
    const archivePath = `/tmp/avalon-workspace-backup-${safeCallId}.tar.gz`;
    const stagingPath = `/tmp/avalon-workspace-backup-${safeCallId}-staging`;
    const result = await provider.runUtilityCommand(input.providerSandboxId, {
      operation: "lifecycle.backup",
      cwd: "/workspace",
      timeoutMs: 120_000,
      signal: input.signal,
      command: [
        "set -euo pipefail",
        `archive='${archivePath}'`,
        `staging='${stagingPath}'`,
        "rm -rf -- \"$staging\"",
        "mkdir -p -- \"$staging/.avalon-recovery\"",
        "has_bundle=0",
        "if [ -d .git ] && git show-ref --quiet; then git bundle create \"$staging/.avalon-recovery/repository.bundle\" --all; has_bundle=1; fi",
        "if ! find . -mindepth 1 -maxdepth 1 ! -name .rally ! -name .avalon ! -name .git -print -quit | grep -q . && [ \"$has_bundle\" -eq 0 ]; then rm -rf -- \"$staging\"; printf 'EMPTY\\n'; exit 0; fi",
        "if [ \"$has_bundle\" -eq 1 ]; then",
        "  tar --exclude='./.rally' --exclude='*/.rally' --exclude='./.avalon' --exclude='*/.avalon' --exclude='./.git' --exclude='*/.git' --exclude='./node_modules' --exclude='*/node_modules' --exclude='./.venv' --exclude='*/.venv' --exclude='./vendor/bundle' --exclude='*/vendor/bundle' -czf \"$archive\" . -C \"$staging\" .avalon-recovery",
        "else",
        "  tar --exclude='./.rally' --exclude='*/.rally' --exclude='./.avalon' --exclude='*/.avalon' --exclude='./.git' --exclude='*/.git' --exclude='./node_modules' --exclude='*/node_modules' --exclude='./.venv' --exclude='*/.venv' --exclude='./vendor/bundle' --exclude='*/vendor/bundle' -czf \"$archive\" .",
        "fi",
        "rm -rf -- \"$staging\"",
        "size=$(stat -c %s -- \"$archive\")",
        `if [ "$size" -gt ${MAX_WORKSPACE_BACKUP_BYTES} ]; then rm -f -- "$archive"; printf 'TOO_LARGE %s\\n' "$size"; exit 0; fi`,
        "digest=$(sha256sum -- \"$archive\" | cut -d ' ' -f 1)",
        "printf 'READY %s %s\\n' \"$size\" \"$digest\"",
      ].join("\n"),
    });
    if (result.exitCode !== 0) {
      throw new TerminalToolError(
        "workspace_backup_failed",
        "Rally could not create a recovery backup, so the repository was not changed. Inspect free space and retry repository checkout.",
        { reason: "Repository replacement is blocked until Rally can create its recovery backup." },
      );
    }
    if (result.stdout.trim() === "EMPTY") return null;
    const tooLarge = /^TOO_LARGE (\d+)$/u.exec(result.stdout.trim());
    if (tooLarge) {
      throw new TerminalToolError(
        "workspace_backup_too_large",
        `The recoverable workspace state is ${tooLarge[1]} bytes compressed, above the ${MAX_WORKSPACE_BACKUP_BYTES}-byte backup limit. Remove regenerable dependency directories or publish large artifacts, then retry repository checkout.`,
        { expected: `compressed backup at most ${MAX_WORKSPACE_BACKUP_BYTES} bytes` },
      );
    }
    const ready = /^READY (\d+) ([0-9a-f]{64})$/u.exec(result.stdout.trim());
    if (!ready) {
      throw new TerminalToolError(
        "workspace_backup_failed",
        "Rally could not verify the recovery backup, so the repository was not changed. Retry repository checkout.",
        { reason: "Repository replacement is blocked until the backup size and digest can be verified." },
      );
    }
    const expectedSize = Number(ready[1]);
    const expectedSha256 = ready[2]!;
    const bytes = await provider.readFile(input.providerSandboxId, archivePath);
    await provider.runUtilityCommand(input.providerSandboxId, {
      operation: "lifecycle.backup_cleanup",
      cwd: "/workspace",
      timeoutMs: 10_000,
      signal: input.signal,
      command: `rm -f -- '${archivePath}'`,
    }).catch(() => undefined);
    const actualSha256 = await sha256Hex(bytes);
    if (bytes.byteLength !== expectedSize || actualSha256 !== expectedSha256) {
      throw new TerminalToolError(
        "workspace_backup_changed",
        "The recovery backup changed while Rally read it, so the repository was not changed. Stop workspace writers and retry repository checkout.",
        { reason: "Wait for active writes to finish, then retry repository checkout." },
      );
    }
    const resourceId = newId();
    const createdAt = new Date().toISOString();
    const title = `Terminal backup before ${input.repositoryFullName}`;
    const objectRef = `${env.AVALON_REGION}/${input.workspaceId}/resources/${resourceId}/terminal-workspace-backup/${actualSha256}`;
    await putStagedResourceObject({
      database: workspace,
      payloads: env.PAYLOADS,
      objectRef,
      workspaceId: input.workspaceId,
      resourceId,
      objectKind: "original",
      value: bytes,
      options: {
        httpMetadata: { contentType: "application/gzip" },
        customMetadata: { source: "terminal_repository_replacement", sandboxGeneration: String(input.generation) },
      },
      at: createdAt,
    });
    const resourceStatement = workspace.prepare(
        `INSERT INTO resources
         (id, workspace_id, resource_type, provider, provider_resource_id, title, mime_type,
          content_ref, content_sha256, metadata_json, last_hydrated_at, attachment_status,
          model_content_status, created_at, updated_at)
         VALUES (?, ?, 'generated_file', 'avalon_generated', ?, ?, 'application/gzip', ?, ?, ?, ?,
                 'attached', 'unsupported', ?, ?)`,
      ).bind(
        resourceId,
        input.workspaceId,
        providerResourceId,
        title,
        objectRef,
        actualSha256,
        JSON.stringify({
          source: "terminal_repository_replacement",
          generation: input.generation,
          size: bytes.byteLength,
          excluded: [".rally", ".avalon", ".git", "node_modules", ".venv", "vendor/bundle"],
          gitHistory: ".avalon-recovery/repository.bundle",
          // Nobody asked for this archive; checkout made it so the workspace it
          // is about to delete stays recoverable. It is still attached, so the
          // checkout receipt's `backup.resourceId` opens and imports it, but the
          // artifacts rail and the model's inventory are for what the work
          // produced, and a compressed copy of the previous workspace is not
          // that. See `services/resource-listing.ts`.
          ...unlistedResourceMetadata(),
        }),
        createdAt,
        createdAt,
        createdAt,
      );
    const cleanupStatement = workspace.prepare(
        `DELETE FROM resource_object_deletion_outbox
          WHERE workspace_id = ? AND object_ref = ? AND cleanup_eligible = 0`,
      ).bind(input.workspaceId, objectRef);
    // Same two authorities and ordering as the final-diff preserver: resource
    // and outbox via WorkspaceDO, followed by the conversation's link
    // (`AgentLoopDO`).
    // As above, an ambiguous resource/link response keeps staging fenced until
    // pointer state is observable.
    await resourceStatement.run();
    await (inObjectResourceAttacher ?? ((attachment) =>
      attachWorkstreamRuntimeResource(env, attachment)))({
      workspaceId: input.workspaceId,
      workstreamId: input.workstreamId,
      resourceId,
      attachedByUserId: null,
      relationshipType: "generated",
    });
    await cleanupStatement.run().catch(() => undefined);
    return {
      resourceId,
      title,
      mimeType: "application/gzip",
      sizeBytes: bytes.byteLength,
      sourceSha256: actualSha256,
      createdAt,
    };
  }
}
