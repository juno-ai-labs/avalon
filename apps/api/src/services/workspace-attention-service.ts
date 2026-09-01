import {
  WorkspaceAttentionSchema,
  asWorkspaceId,
  type WorkspaceAttention,
} from "@rally/contracts";

import { workspaceDOName } from "../durable-objects/names";
import type { AuthContext, Env } from "../env";
import {
  durableObjectStubForWorkspace,
  workspacePlacementAffinity,
} from "../lib/durable-object-namespace";

/** Read the current member's cross-work-stream attention from WorkspaceDO. */
export async function workspaceAttention(
  env: Env,
  auth: AuthContext,
): Promise<WorkspaceAttention> {
  const placementAffinity = await workspacePlacementAffinity(env, auth.workspaceId);
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    auth.workspaceId,
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(auth.workspaceId)),
    placementAffinity,
  );
  return WorkspaceAttentionSchema.parse(await workspace.attention({
    workspaceId: auth.workspaceId,
    userId: auth.userId,
  }));
}
