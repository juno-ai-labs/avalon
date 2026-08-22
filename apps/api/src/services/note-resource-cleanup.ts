import type { Env } from "../env";
import { logWarn } from "../observability/logger";
import { withWorkspaceRuntimeDatabase } from "./workspace-runtime-database";

/** Returns how many outbox rows the pass retired; the alarm reads it as progress. */
export async function reapDeletedNoteObjects(env: Env, workspaceId?: string): Promise<number> {
  if (!workspaceId && env.WORKSPACE_DOS) throw new Error("note_cleanup_workspace_required");
  if (workspaceId) env = withWorkspaceRuntimeDatabase(env, workspaceId);
  const pending = await env.DB.prepare(
    `SELECT resource_id, content_ref, model_content_ref
     FROM note_resource_deletion_outbox ORDER BY created_at ASC LIMIT 100`,
  ).all<{ resource_id: string; content_ref: string | null; model_content_ref: string | null }>();
  let retired = 0;
  for (const resource of pending.results) {
    try {
      await Promise.all([
        ...(resource.content_ref ? [env.PAYLOADS.delete(resource.content_ref)] : []),
        ...(resource.model_content_ref ? [env.PAYLOADS.delete(resource.model_content_ref)] : []),
      ]);
      await env.DB.prepare(
        "DELETE FROM note_resource_deletion_outbox WHERE resource_id = ?",
      ).bind(resource.resource_id).run();
      retired += 1;
    } catch (error) {
      logWarn(env, "note_object_cleanup_failed", {
        resource_id: resource.resource_id,
        reason: error instanceof Error ? error.message : "unknown R2 cleanup error",
      });
    }
  }
  return retired;
}
