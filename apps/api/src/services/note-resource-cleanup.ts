import { asWorkspaceId } from "@rally/contracts";
import { workspaceDOName } from "../durable-objects/names";
import {
  WorkspaceNoteDeletionOutboxSchema,
  WorkspaceNoteDeletionRetireResultSchema,
} from "../durable-objects/workspace-notes-protocol";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { logWarn } from "../observability/logger";

/** Returns how many outbox rows the pass retired; the alarm reads it as progress. */
export async function reapDeletedNoteObjects(env: Env, workspaceId: string): Promise<number> {
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    asWorkspaceId(workspaceId),
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)),
  );
  const pending = WorkspaceNoteDeletionOutboxSchema.parse(
    await workspace.noteResourceDeletionOutbox({ workspaceId }),
  );
  let retired = 0;
  for (const resource of pending.items) {
    try {
      await Promise.all([
        ...(resource.contentRef ? [env.PAYLOADS.delete(resource.contentRef)] : []),
        ...(resource.modelContentRef ? [env.PAYLOADS.delete(resource.modelContentRef)] : []),
      ]);
      WorkspaceNoteDeletionRetireResultSchema.parse(
        await workspace.retireNoteResourceDeletion({
          workspaceId,
          resourceId: resource.resourceId,
        }),
      );
      retired += 1;
    } catch (error) {
      logWarn(env, "note_object_cleanup_failed", {
        resource_id: resource.resourceId,
        reason: error instanceof Error ? error.message : "unknown R2 cleanup error",
      });
    }
  }
  return retired;
}
