import { z } from "zod";
import { WorkspaceRelationshipSchema } from "./workspace-relationship-service";
import type { Env } from "../env";
import { logWarn } from "../observability/logger";

export const WorkspaceRelationshipChangeMessageSchema = z.strictObject({
  kind: z.literal("workspace_relationship_changed"),
  sequence: z.number().int().positive(),
  relationship: WorkspaceRelationshipSchema,
  removed: z.boolean(),
});
export type WorkspaceRelationshipChangeMessage = z.infer<typeof WorkspaceRelationshipChangeMessageSchema>;

/**
 * Publish transactionally recorded membership changes. Queue acceptance is only
 * dispatch, not proof that every socket holder has applied the change. A crash
 * after send but before the marker produces a harmless duplicate on recovery.
 */
export async function dispatchWorkspaceRelationshipChanges(
  env: Env,
  target?: { workspaceId: string; userId: string },
): Promise<number> {
  const query = env.DB.prepare(`SELECT sequence, workspace_id AS workspaceId, user_id AS userId,
    incarnation, revision, access_class AS accessClass, role, status, change_kind AS changeKind
    FROM workspace_relationship_deliveries WHERE dispatched_at IS NULL
    ${target ? "AND workspace_id = ? AND user_id = ?" : ""} ORDER BY sequence`);
  const result = await (target ? query.bind(target.workspaceId, target.userId) : query).all<{
    sequence: number; workspaceId: string; userId: string; incarnation: string;
    revision: number; accessClass: string; role: string | null; status: string; changeKind: string;
  }>();
  let dispatched = 0;
  for (const row of result.results) {
    try {
      const { sequence, changeKind, ...relationship } = row;
      const message = WorkspaceRelationshipChangeMessageSchema.parse({
        kind: "workspace_relationship_changed", sequence, relationship, removed: changeKind === "removed",
      });
      await env.ACCESS_REVOCATION_QUEUE.send(message);
      await env.DB.prepare(`UPDATE workspace_relationship_deliveries SET dispatched_at = ?
        WHERE sequence = ? AND dispatched_at IS NULL`).bind(new Date().toISOString(), sequence).run();
      dispatched += 1;
    } catch (error) {
      // The trigger's intent remains pending. An unrelated recipient must not
      // be starved by this delivery failure; the cron will retry the failed row.
      logWarn(env, "workspace_relationship_dispatch_failed", { sequence: row.sequence,
        error: error instanceof Error ? error.message : "unknown" });
    }
  }
  return dispatched;
}
