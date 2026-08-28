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
  cleanup_eligible: number;
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

/**
 * Hand an object back to the reaper after its publisher knows no pointer was
 * committed. An ambiguous database failure deliberately does not call this:
 * preserving an unreferenced object is recoverable, while deleting bytes a
 * committed pointer may name is not.
 */
export async function releaseStagedResourceObject(
  database: D1Database,
  workspaceId: string,
  objectRef: string,
): Promise<void> {
  await database.prepare(
    `UPDATE resource_object_deletion_outbox
        SET cleanup_eligible = 1, updated_at = ?
      WHERE workspace_id = ? AND object_ref = ? AND cleanup_eligible = 0`,
  ).bind(new Date().toISOString(), workspaceId, objectRef).run();
}

/**
 * Register cleanup ownership before an R2 put without duplicating the only
 * safe failure transition in every resource writer.
 *
 * Pointer publication remains caller-owned because its compare-and-swap and
 * ambiguity semantics differ by resource type. A failed put is unambiguous:
 * no later pointer can name bytes this call did not store, so cleanup may take
 * the staged row. Failure to release must not replace the storage error; the
 * durable staging row is the recoverable residue.
 */
export async function putStagedResourceObject(input: {
  database: D1Database;
  payloads: R2Bucket;
  objectRef: string;
  workspaceId: string;
  resourceId: string;
  objectKind: PendingResourceObject["object_kind"];
  value: ArrayBuffer | Uint8Array | string;
  options?: R2PutOptions;
  at: string;
}): Promise<void> {
  try {
    await input.database.prepare(
      `INSERT OR IGNORE INTO resource_object_deletion_outbox
        (object_ref, workspace_id, resource_id, object_kind, cleanup_eligible, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    ).bind(
      input.objectRef,
      input.workspaceId,
      input.resourceId,
      input.objectKind,
      input.at,
      input.at,
    ).run();
  } catch (error) {
    // No put was attempted, so even a staging insert that committed before its
    // response was lost can be released without risking referenced bytes.
    await releaseStagedResourceObject(input.database, input.workspaceId, input.objectRef)
      .catch(() => undefined);
    throw error;
  }
  try {
    await input.payloads.put(input.objectRef, input.value, input.options);
  } catch (error) {
    await releaseStagedResourceObject(input.database, input.workspaceId, input.objectRef)
      .catch(() => undefined);
    throw error;
  }
}

/** Returns how many outbox rows the pass retired; the alarm reads it as progress. */
export async function reapDeletedResourceObjects(env: Env, workspaceId?: string): Promise<number> {
  if (!workspaceId && env.WORKSPACE_DOS) throw new Error("resource_cleanup_workspace_required");
  if (workspaceId) env = withWorkspaceRuntimeDatabase(env, workspaceId);
  const pending = await env.DB.prepare(
    `SELECT pending.object_ref, pending.workspace_id, pending.resource_id,
            pending.object_kind, pending.cleanup_eligible
       FROM resource_object_deletion_outbox pending
      WHERE pending.cleanup_eligible = 1
         OR EXISTS (
           SELECT 1 FROM resources current_resource
            WHERE current_resource.workspace_id = pending.workspace_id
              AND (current_resource.content_ref = pending.object_ref
                OR current_resource.model_content_ref = pending.object_ref)
         )
         OR EXISTS (
           SELECT 1 FROM resource_versions historical_version
            WHERE historical_version.workspace_id = pending.workspace_id
              AND (historical_version.content_ref = pending.object_ref
                OR historical_version.model_content_ref = pending.object_ref)
         )
     ORDER BY pending.created_at ASC, pending.object_ref ASC
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
        // Recheck the reference inside the same WorkspaceDO statement that
        // retires staging. A resource deletion can otherwise promote the row
        // after the read above and before an unconditional delete here.
        const result = await env.DB.prepare(
          `DELETE FROM resource_object_deletion_outbox
            WHERE workspace_id = ? AND object_ref = ?
              AND (
                EXISTS (
                  SELECT 1 FROM resources
                   WHERE workspace_id = ? AND (content_ref = ? OR model_content_ref = ?)
                )
                OR EXISTS (
                  SELECT 1 FROM resource_versions
                   WHERE workspace_id = ? AND (content_ref = ? OR model_content_ref = ?)
                )
              )`,
        ).bind(
          object.workspace_id,
          object.object_ref,
          object.workspace_id,
          object.object_ref,
          object.object_ref,
          object.workspace_id,
          object.object_ref,
          object.object_ref,
        ).run();
        if ((result.meta.changes ?? 0) > 0) retired += 1;
        continue;
      }
      // A publisher owns this object until it either commits a resource
      // pointer or explicitly releases the row. The alarm can run between the
      // R2 put and that commit; treating "not active yet" as "abandoned"
      // deletes the bytes underneath the pointer the writer is about to save.
      if (object.cleanup_eligible === 0) continue;
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
        AND NOT EXISTS (
          SELECT 1 FROM pending_attachment_reservations reservation
           WHERE reservation.resource_id = resource.id
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
        AND NOT EXISTS (
          SELECT 1 FROM pending_attachment_reservations reservation
           WHERE reservation.resource_id = resources.id
        )
      RETURNING id`,
  ).bind(resource.id, workspaceId, cutoff)));
  // The rows the batch removed, not the rows the select found: a draft that
  // was attached between the two is progress the select would have claimed.
  return deleted.reduce((count, result) => count + result.results.length, 0);
}
