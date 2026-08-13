import { newId } from "@avalon/db";

import type { Env } from "../../env";
import { sha256Hex } from "../../lib/crypto";
import { isTerminalProviderNotFound, type TerminalSandboxProvider } from "./daytona-provider";

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
  env: Pick<Env, "AVALON_REGION" | "DB" | "PAYLOADS">,
  provider: TerminalSandboxProvider,
  workspaceId: string,
  workstreamId: string,
): (providerSandboxId: string, generation: number) => Promise<void> {
  return async (providerSandboxId, generation) => {
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
    await env.DB.prepare(
      `INSERT OR IGNORE INTO resource_object_deletion_outbox
       (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
       VALUES (?, ?, ?, 'original', ?, ?)`,
    ).bind(objectRef, workspaceId, resourceId, timestamp, timestamp).run();
    await env.PAYLOADS.put(objectRef, bytes, {
      httpMetadata: { contentType: summaryOnly ? "text/plain" : "text/x-diff" },
      customMetadata: { source: "terminal", sandboxGeneration: String(generation) },
    });
    await env.DB.batch([
      env.DB.prepare(
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
      ),
      env.DB.prepare(
        `INSERT INTO workstream_resources
         (workstream_id, resource_id, attached_by_user_id, watch_enabled, relationship_type, attached_at)
         VALUES (?, ?, NULL, 0, 'generated', ?)`,
      ).bind(workstreamId, resourceId, timestamp),
      env.DB.prepare(
        `UPDATE workstream_sandboxes SET final_diff_resource_id = ?
          WHERE workspace_id = ? AND workstream_id = ?`,
      ).bind(resourceId, workspaceId, workstreamId),
      env.DB.prepare(
        "DELETE FROM resource_object_deletion_outbox WHERE workspace_id = ? AND object_ref = ?",
      ).bind(workspaceId, objectRef),
    ]);
  };
}
