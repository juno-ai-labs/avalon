import type { Env } from "../env";
import { truncateUtf16Safe } from "../lib/text";
import { logWarn } from "../observability/logger";
import { withWorkspaceRuntimeDatabase } from "./workspace-runtime-database";

/**
 * How many rows one workspace maintenance pass over resources takes.
 *
 * Exported because the alias backfill is the same alarm doing the same kind of
 * bounded work over the same table; two literals would be two decisions
 * nobody had made.
 */
export const MAXIMUM_CLEANUP_BATCH = 100;
const DRAFT_ATTACHMENT_TTL_HOURS = 24;

interface PendingResourceObject {
  object_ref: string;
  workspace_id: string;
  resource_id: string;
  object_kind: "original" | "derivative" | "receipt";
}

function boundedCleanupErrorCode(error: unknown): string {
  const candidate = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : null;
  if (typeof candidate === "string" && /^[a-z0-9_.-]{1,120}$/iu.test(candidate)) {
    return candidate.toLowerCase();
  }
  return "r2_delete_failed";
}

/** Returns how many outbox rows the pass retired; the alarm reads it as progress. */
export async function reapDeletedResourceObjects(env: Env, workspaceId?: string): Promise<number> {
  if (!workspaceId && env.WORKSPACE_DOS) throw new Error("resource_cleanup_workspace_required");
  if (workspaceId) env = withWorkspaceRuntimeDatabase(env, workspaceId);
  const pending = await env.DB.prepare(
    `SELECT object_ref, workspace_id, resource_id, object_kind
     FROM resource_object_deletion_outbox
     ORDER BY created_at ASC, object_ref ASC
     LIMIT ?`,
  ).bind(MAXIMUM_CLEANUP_BATCH).all<PendingResourceObject>();

  let retired = 0;
  for (const object of pending.results) {
    try {
      const active = await env.DB.prepare(
        `SELECT 1 AS active FROM resources
          WHERE workspace_id = ? AND (content_ref = ? OR model_content_ref = ?)
         UNION ALL
         SELECT 1 AS active FROM resource_versions
          WHERE workspace_id = ? AND (content_ref = ? OR model_content_ref = ?)
         LIMIT 1`,
      ).bind(
        object.workspace_id,
        object.object_ref,
        object.object_ref,
        object.workspace_id,
        object.object_ref,
        object.object_ref,
      ).first();
      if (active) {
        await env.DB.prepare(
          "DELETE FROM resource_object_deletion_outbox WHERE workspace_id = ? AND object_ref = ?",
        ).bind(object.workspace_id, object.object_ref).run();
        retired += 1;
        continue;
      }
      await env.PAYLOADS.delete(object.object_ref);
      await env.DB.prepare(
        "DELETE FROM resource_object_deletion_outbox WHERE workspace_id = ? AND object_ref = ?",
      ).bind(object.workspace_id, object.object_ref).run();
      retired += 1;
    } catch (error) {
      const reason = boundedCleanupErrorCode(error);
      await env.DB.prepare(
        `UPDATE resource_object_deletion_outbox
         SET attempt_count = attempt_count + 1, last_error_code = ?, updated_at = ?
         WHERE workspace_id = ? AND object_ref = ?`,
      ).bind(
        truncateUtf16Safe(reason, 120),
        new Date().toISOString(),
        object.workspace_id,
        object.object_ref,
      ).run();
      logWarn(env, "resource_object_cleanup_failed", {
        resource_id: object.resource_id,
        object_kind: object.object_kind,
        reason,
      });
    }
  }
  return retired;
}

/**
 * Remove unattached upload drafts from one WorkspaceDO; its SQL trigger queues
 * R2 cleanup. Returns how many it removed, which the alarm reads as progress.
 */
export async function reapExpiredDraftResources(env: Env, workspaceId: string): Promise<number> {
  env = withWorkspaceRuntimeDatabase(env, workspaceId);
  const cutoff = new Date(
    Date.now() - DRAFT_ATTACHMENT_TTL_HOURS * 60 * 60 * 1_000,
  ).toISOString();
  const stale = await env.DB.prepare(
    `SELECT id FROM resources resource
      WHERE resource.workspace_id = ?
        AND resource.provider = 'avalon_upload'
        AND resource.attachment_status = 'draft'
        AND resource.created_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM workspace_workstream_resource_links link
           WHERE link.resource_id = resource.id
        )
      ORDER BY resource.created_at, resource.id
      LIMIT ?`,
  ).bind(workspaceId, cutoff, MAXIMUM_CLEANUP_BATCH).all<{ id: string }>();
  if (stale.results.length === 0) return 0;
  const deleted = await env.DB.batch(stale.results.map((resource) => env.DB.prepare(
    `DELETE FROM resources
      WHERE id = ? AND workspace_id = ? AND provider = 'avalon_upload'
        AND attachment_status = 'draft' AND created_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM workspace_workstream_resource_links link
           WHERE link.resource_id = resources.id
        )
      RETURNING id`,
  ).bind(resource.id, workspaceId, cutoff)));
  // The rows the batch removed, not the rows the select found: a draft that
  // was attached between the two is progress the select would have claimed.
  return deleted.reduce((count, result) => count + result.results.length, 0);
}
