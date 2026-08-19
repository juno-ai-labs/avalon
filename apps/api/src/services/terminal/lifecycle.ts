import { newId } from "@avalon/db";

import type { Env } from "../../env";
import { sha256Hex } from "../../lib/crypto";
import { attachWorkstreamRuntimeResource } from "../workstream-object-client";
import { regionalDatabase } from "../workstream-runtime-database";
import { isTerminalProviderNotFound, type TerminalSandboxProvider } from "./daytona-provider";
import { TerminalToolError } from "./tools";

const MAX_WORKSPACE_BACKUP_BYTES = 50 * 1_048_576;

export interface TerminalWorkspaceBackup {
  resourceId: string;
  title: string;
  mimeType: "application/gzip";
  sizeBytes: number;
  sourceSha256: string;
  createdAt: string;
}

interface LifecycleRow {
  state: string;
  provider_sandbox_id: string | null;
  generation: number;
  version: number;
  warm_stop_due_at: string | null;
  archive_due_at: string | null;
  expire_due_at: string | null;
  lifecycle_claim_id: string | null;
  lifecycle_claim_expires_at: string | null;
  operation_run_id: string | null;
  operation_lease_expires_at: string | null;
}

export type TerminalLifecycleTransition = "none" | "deferred" | "stopped" | "archived" | "expired";

function isDue(value: string | null, now: Date): boolean {
  return value !== null && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now.getTime();
}

export async function reconcileDueTerminalSandbox(
  database: D1Database,
  provider: TerminalSandboxProvider,
  workspaceId: string,
  workstreamId: string,
  now = new Date(),
  preserveBeforeExpiry?: (providerSandboxId: string, generation: number) => Promise<void>,
): Promise<{ transition: TerminalLifecycleTransition }> {
  const row = await database.prepare(
    `SELECT state, provider_sandbox_id, generation, version, warm_stop_due_at,
            archive_due_at, expire_due_at, lifecycle_claim_id, lifecycle_claim_expires_at,
            operation_run_id, operation_lease_expires_at
       FROM workstream_sandboxes WHERE workspace_id = ? AND workstream_id = ?`,
  ).bind(workspaceId, workstreamId).first<LifecycleRow>();
  if (!row?.provider_sandbox_id || row.state === "expired") return { transition: "none" };

  if (
    row.operation_run_id
    && row.operation_lease_expires_at
    && Date.parse(row.operation_lease_expires_at) > now.getTime()
  ) {
    const activeRun = await database.prepare(
      `SELECT 1 AS active FROM harness_runs
        WHERE id = ? AND workspace_id = ? AND workstream_id = ?
          AND status IN ('scheduled', 'running', 'needs_input')`,
    ).bind(row.operation_run_id, workspaceId, workstreamId).first<{ active: number }>();
    if (activeRun) return { transition: "deferred" };
  }

  const activeTask = await database.prepare(
    `SELECT id FROM sandbox_tasks
      WHERE workspace_id = ? AND workstream_id = ? AND sandbox_generation = ?
        AND state IN ('planned', 'submitting', 'running') AND command_deadline_at > ?
      LIMIT 1`,
  ).bind(workspaceId, workstreamId, row.generation, now.toISOString()).first<{ id: string }>();
  if (activeTask) return { transition: "deferred" };

  const desired = row.state === "expiring"
    ? "expired" as const
    : row.state === "archiving"
      ? "archived" as const
      : row.state === "stopping"
        ? "stopped" as const
        : isDue(row.expire_due_at, now)
    ? "expired" as const
    : row.state === "running" && isDue(row.warm_stop_due_at, now)
      ? "stopped" as const
      : row.state === "stopped" && isDue(row.archive_due_at, now)
        ? "archived" as const
        : null;
  if (!desired) return { transition: "none" };

  const claimId = newId(now.getTime());
  const claimExpiresAt = new Date(now.getTime() + 2 * 60_000).toISOString();
  const intermediate = desired === "expired" ? "expiring" : desired === "archived" ? "archiving" : "stopping";
  const claimed = await database.prepare(
    `UPDATE workstream_sandboxes
        SET state = ?, lifecycle_claim_id = ?, lifecycle_claim_expires_at = ?,
            version = version + 1, updated_at = ?
      WHERE workspace_id = ? AND workstream_id = ? AND generation = ? AND version = ?
        AND (lifecycle_claim_id IS NULL OR lifecycle_claim_expires_at <= ?)
      RETURNING provider_sandbox_id`,
  ).bind(
    intermediate,
    claimId,
    claimExpiresAt,
    now.toISOString(),
    workspaceId,
    workstreamId,
    row.generation,
    row.version,
    now.toISOString(),
  ).first<{ provider_sandbox_id: string }>();
  if (!claimed) return { transition: "none" };

  try {
    if (desired === "stopped") {
      await preserveBeforeExpiry?.(claimed.provider_sandbox_id, row.generation);
      await provider.stopSandbox(claimed.provider_sandbox_id);
    } else if (desired === "archived") {
      await provider.archiveSandbox(claimed.provider_sandbox_id);
    } else {
      // The final diff was captured before the sandbox was stopped. Daytona
      // archives cannot execute commands, so expiry only deletes them.
      if (row.state !== "archived") await preserveBeforeExpiry?.(claimed.provider_sandbox_id, row.generation);
      await provider.clearGitHubReadAccess(claimed.provider_sandbox_id).catch(() => undefined);
      await provider.deleteSandbox(claimed.provider_sandbox_id);
    }
  } catch (error) {
    let observed = null;
    let observedNotFound = false;
    try {
      observed = await provider.getSandbox(claimed.provider_sandbox_id);
    } catch (observationError) {
      observedNotFound = isTerminalProviderNotFound(observationError);
    }
    const reconciled = desired === "expired" && (isTerminalProviderNotFound(error) || observedNotFound)
      ? true
      : desired === "stopped"
      ? observed?.state === "stopped" || observed?.state === "archived"
      : desired === "archived"
        ? observed?.state === "archived"
        : observed?.state === "expired";
    if (!reconciled) {
      const stableState = desired === "stopped" ? "running" : desired === "archived" ? "stopped" : row.state === "archived" ? "archived" : "stopped";
      await database.prepare(
        `UPDATE workstream_sandboxes
            SET state = ?, failure_code = ?, lifecycle_claim_id = NULL,
                lifecycle_claim_expires_at = NULL, version = version + 1, updated_at = ?
          WHERE workspace_id = ? AND workstream_id = ? AND lifecycle_claim_id = ?`,
      ).bind(
        stableState,
        `${desired}_provider_failed`,
        now.toISOString(),
        workspaceId,
        workstreamId,
        claimId,
      ).run();
      throw error;
    }
  }

  await database.prepare(
    `UPDATE workstream_sandboxes
        SET state = ?,
            provider_sandbox_id = CASE WHEN ? = 'expired' THEN NULL ELSE provider_sandbox_id END,
            warm_stop_due_at = CASE WHEN ? IN ('stopped', 'expired') THEN NULL ELSE warm_stop_due_at END,
            archive_due_at = CASE WHEN ? IN ('archived', 'expired') THEN NULL ELSE archive_due_at END,
            expire_due_at = CASE WHEN ? = 'expired' THEN NULL ELSE expire_due_at END,
            operation_run_id = CASE WHEN ? = 'expired' THEN NULL ELSE operation_run_id END,
            operation_lease_expires_at = CASE WHEN ? = 'expired' THEN NULL ELSE operation_lease_expires_at END,
            lifecycle_claim_id = NULL, lifecycle_claim_expires_at = NULL,
            failure_code = NULL, version = version + 1, updated_at = ?
      WHERE workspace_id = ? AND workstream_id = ? AND lifecycle_claim_id = ?`,
  ).bind(
    desired,
    desired,
    desired,
    desired,
    desired,
    desired,
    desired,
    now.toISOString(),
    workspaceId,
    workstreamId,
    claimId,
  ).run();
  return { transition: desired };
}

/**
 * Captures repository work that would otherwise disappear with an expired
 * Daytona archive. The provider command bounds bytes before they cross the
 * Worker boundary; large diffs become a bounded stat summary instead of a
 * corrupt partial patch.
 */
export function createTerminalFinalDiffPreserver(
  env: Env,
  provider: TerminalSandboxProvider,
  workspaceId: string,
  workstreamId: string,
): (providerSandboxId: string, generation: number) => Promise<void> {
  return async (providerSandboxId, generation) => {
    const regional = regionalDatabase(env);
    const alreadyCaptured = await env.DB.prepare(
      `SELECT final_diff_resource_id FROM workstream_sandboxes
        WHERE workspace_id = ? AND workstream_id = ?`,
    ).bind(workspaceId, workstreamId).first<{ final_diff_resource_id: string | null }>();
    if (alreadyCaptured?.final_diff_resource_id) return;
    const result = await provider.runCommand(providerSandboxId, {
      taskName: `avalon-final-diff-${generation}`,
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
    await regional.prepare(
      `INSERT OR IGNORE INTO resource_object_deletion_outbox
       (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
       VALUES (?, ?, ?, 'original', ?, ?)`,
    ).bind(objectRef, workspaceId, resourceId, timestamp, timestamp).run();
    await env.PAYLOADS.put(objectRef, bytes, {
      httpMetadata: { contentType: summaryOnly ? "text/plain" : "text/x-diff" },
      customMetadata: { source: "terminal", sandboxGeneration: String(generation) },
    });
    const resourceStatement = regional.prepare(
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
    const attachmentStatement = env.DB.prepare(
        `INSERT INTO workstream_resources
         (workstream_id, resource_id, attached_by_user_id, watch_enabled, relationship_type, attached_at)
         VALUES (?, ?, NULL, 0, 'generated', ?)`,
      ).bind(workstreamId, resourceId, timestamp);
    const terminalStatement = env.DB.prepare(
        `UPDATE workstream_sandboxes SET final_diff_resource_id = ?
          WHERE workspace_id = ? AND workstream_id = ?`,
      ).bind(resourceId, workspaceId, workstreamId);
    const cleanupStatement = regional.prepare(
        "DELETE FROM resource_object_deletion_outbox WHERE workspace_id = ? AND object_ref = ?",
      ).bind(workspaceId, objectRef);
    if (regional === env.DB) {
      await env.DB.batch([resourceStatement, attachmentStatement, terminalStatement, cleanupStatement]);
    } else {
      await resourceStatement.run();
      await attachWorkstreamRuntimeResource(env, {
        workspaceId,
        workstreamId,
        resourceId,
        attachedByUserId: null,
        relationshipType: "generated",
      });
      await terminalStatement.run();
      await cleanupStatement.run();
    }
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
  provider: TerminalSandboxProvider,
  input: {
    workspaceId: string;
    workstreamId: string;
    toolCallId: string;
    repositoryFullName: string;
    providerSandboxId: string;
    generation: number;
    signal: AbortSignal;
  },
): Promise<TerminalWorkspaceBackup | null> {
  return createWorkspaceBackup();

  async function createWorkspaceBackup(): Promise<TerminalWorkspaceBackup | null> {
    const regional = regionalDatabase(env);
    const providerResourceId = `terminal-workspace-backup:${input.toolCallId}`;
    const existing = await env.DB.prepare(
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
    const result = await provider.runCommand(input.providerSandboxId, {
      taskName: `avalon-workspace-backup-${input.generation}-${input.toolCallId.replace(/[^a-zA-Z0-9_-]/gu, "").slice(0, 48)}`,
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
        "if ! find . -mindepth 1 -maxdepth 1 ! -name .avalon ! -name .git -print -quit | grep -q . && [ \"$has_bundle\" -eq 0 ]; then rm -rf -- \"$staging\"; printf 'EMPTY\\n'; exit 0; fi",
        "if [ \"$has_bundle\" -eq 1 ]; then",
        "  tar --exclude='./.avalon' --exclude='*/.avalon' --exclude='./.git' --exclude='*/.git' --exclude='./node_modules' --exclude='*/node_modules' --exclude='./.venv' --exclude='*/.venv' --exclude='./vendor/bundle' --exclude='*/vendor/bundle' -czf \"$archive\" . -C \"$staging\" .avalon-recovery",
        "else",
        "  tar --exclude='./.avalon' --exclude='*/.avalon' --exclude='./.git' --exclude='*/.git' --exclude='./node_modules' --exclude='*/node_modules' --exclude='./.venv' --exclude='*/.venv' --exclude='./vendor/bundle' --exclude='*/vendor/bundle' -czf \"$archive\" .",
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
        "Avalon could not create a recovery backup, so the repository was not changed. Inspect free space and retry repository checkout.",
        { reason: "Repository replacement is blocked until Avalon can create its recovery backup." },
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
        "Avalon could not verify the recovery backup, so the repository was not changed. Retry repository checkout.",
        { reason: "Repository replacement is blocked until the backup size and digest can be verified." },
      );
    }
    const expectedSize = Number(ready[1]);
    const expectedSha256 = ready[2]!;
    const bytes = await provider.readFile(input.providerSandboxId, archivePath);
    await provider.runCommand(input.providerSandboxId, {
      taskName: `avalon-workspace-backup-cleanup-${input.generation}-${input.toolCallId.replace(/[^a-zA-Z0-9_-]/gu, "").slice(0, 40)}`,
      cwd: "/workspace",
      timeoutMs: 10_000,
      signal: input.signal,
      command: `rm -f -- '${archivePath}'`,
    }).catch(() => undefined);
    const actualSha256 = await sha256Hex(bytes);
    if (bytes.byteLength !== expectedSize || actualSha256 !== expectedSha256) {
      throw new TerminalToolError(
        "workspace_backup_changed",
        "The recovery backup changed while Avalon read it, so the repository was not changed. Stop workspace writers and retry repository checkout.",
        { reason: "Wait for active writes to finish, then retry repository checkout." },
      );
    }
    const resourceId = newId();
    const createdAt = new Date().toISOString();
    const title = `Terminal backup before ${input.repositoryFullName}`;
    const objectRef = `${env.AVALON_REGION}/${input.workspaceId}/resources/${resourceId}/terminal-workspace-backup/${actualSha256}`;
    await regional.prepare(
      `INSERT OR IGNORE INTO resource_object_deletion_outbox
       (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
       VALUES (?, ?, ?, 'original', ?, ?)`,
    ).bind(objectRef, input.workspaceId, resourceId, createdAt, createdAt).run();
    await env.PAYLOADS.put(objectRef, bytes, {
      httpMetadata: { contentType: "application/gzip" },
      customMetadata: { source: "terminal_repository_replacement", sandboxGeneration: String(input.generation) },
    });
    const resourceStatement = regional.prepare(
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
          excluded: [".avalon", ".git", "node_modules", ".venv", "vendor/bundle"],
          gitHistory: ".avalon-recovery/repository.bundle",
        }),
        createdAt,
        createdAt,
        createdAt,
      );
    const attachmentStatement = env.DB.prepare(
        `INSERT INTO workstream_resources
         (workstream_id, resource_id, attached_by_user_id, watch_enabled, relationship_type, attached_at)
         VALUES (?, ?, NULL, 0, 'generated', ?)`,
      ).bind(input.workstreamId, resourceId, createdAt);
    const cleanupStatement = regional.prepare(
        "DELETE FROM resource_object_deletion_outbox WHERE workspace_id = ? AND object_ref = ?",
      ).bind(input.workspaceId, objectRef);
    if (regional === env.DB) {
      await env.DB.batch([resourceStatement, attachmentStatement, cleanupStatement]);
    } else {
      await resourceStatement.run();
      await attachWorkstreamRuntimeResource(env, {
        workspaceId: input.workspaceId,
        workstreamId: input.workstreamId,
        resourceId,
        attachedByUserId: null,
        relationshipType: "generated",
      });
      await cleanupStatement.run();
    }
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
