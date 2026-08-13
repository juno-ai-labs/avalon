import type { Env } from "../env";
import { truncateUtf16Safe } from "../lib/text";
import { logWarn } from "../observability/logger";

const MAXIMUM_CLEANUP_BATCH = 100;

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

export async function reapDeletedResourceObjects(env: Env): Promise<void> {
  const pending = await env.DB.prepare(
    `SELECT object_ref, workspace_id, resource_id, object_kind
     FROM resource_object_deletion_outbox
     ORDER BY created_at ASC, object_ref ASC
     LIMIT ?`,
  ).bind(MAXIMUM_CLEANUP_BATCH).all<PendingResourceObject>();

  for (const object of pending.results) {
    try {
      const active = await env.DB.prepare(
        `SELECT 1 AS active FROM resources
          WHERE workspace_id = ? AND (content_ref = ? OR model_content_ref = ?)
         LIMIT 1`,
      ).bind(
        object.workspace_id,
        object.object_ref,
        object.object_ref,
      ).first();
      if (active) {
        await env.DB.prepare(
          "DELETE FROM resource_object_deletion_outbox WHERE workspace_id = ? AND object_ref = ?",
        ).bind(object.workspace_id, object.object_ref).run();
        continue;
      }
      await env.PAYLOADS.delete(object.object_ref);
      await env.DB.prepare(
        "DELETE FROM resource_object_deletion_outbox WHERE workspace_id = ? AND object_ref = ?",
      ).bind(object.workspace_id, object.object_ref).run();
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
}
