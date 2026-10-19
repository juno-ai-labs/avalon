import { asWorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../durable-objects/names";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";

/**
 * Archive a new import's Channel that its run ended without opening.
 *
 * The desktop opens the Channel inside the finish tool, before the run's
 * final turn, so a reservation still unopened when the run ends never will
 * be: the agent gave up, failed, or was stopped, or the import window closed
 * or crashed and its own discard never arrived. Retiring the create key first
 * refuses any `complete` that arrives later. A `failed` receipt is matched
 * too: an abandon that retired the key before the reservation published left
 * the Channel listed. A Channel imported before has a completed receipt, so
 * its update runs match nothing here.
 */
export async function reclaimUnopenedImport(
  env: Env,
  input: { workspaceId: string; workstreamId: string; userId: string },
): Promise<void> {
  const retired = await env.DB.prepare(
    `UPDATE workstream_create_receipts
        SET state = 'failed', updated_at = ?,
            error_code = CASE WHEN state = 'failed' THEN error_code ELSE 'session_import_unfinished' END
      WHERE workspace_id = ? AND creator_user_id = ? AND workstream_id = ? AND state IN ('reserved', 'failed')
      RETURNING workstream_id`,
  ).bind(new Date().toISOString(), input.workspaceId, input.userId, input.workstreamId)
    .first<{ workstream_id: string }>();
  if (!retired) return;
  const parent = await durableObjectStubForWorkspace(
    env, env.WORKSPACE_DOS, input.workspaceId, workspaceDOName(env.AVALON_REGION, asWorkspaceId(input.workspaceId)),
  );
  await parent.discardReservedMain({ workspaceId: input.workspaceId, parentId: input.workstreamId, userId: input.userId });
}
