import type { Env } from "../env";

export async function reapDeletedNoteObjects(env: Env): Promise<void> {
  const pending = await env.DB.prepare(
    `SELECT resource_id, content_ref, model_content_ref
     FROM note_resource_deletion_outbox ORDER BY created_at ASC LIMIT 100`,
  ).all<{ resource_id: string; content_ref: string | null; model_content_ref: string | null }>();
  for (const resource of pending.results) {
    try {
      await Promise.all([
        ...(resource.content_ref ? [env.PAYLOADS.delete(resource.content_ref)] : []),
        ...(resource.model_content_ref ? [env.PAYLOADS.delete(resource.model_content_ref)] : []),
      ]);
      await env.DB.prepare(
        "DELETE FROM note_resource_deletion_outbox WHERE resource_id = ?",
      ).bind(resource.resource_id).run();
    } catch (error) {
      console.warn("Deleted note object cleanup failed", {
        resourceId: resource.resource_id,
        reason: error instanceof Error ? error.message : "unknown R2 cleanup error",
      });
    }
  }
}
