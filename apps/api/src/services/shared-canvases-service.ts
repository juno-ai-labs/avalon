import { asWorkspaceId, type CanvasSidebarRow, type Workspace, type WorkspaceId } from "@rally/contracts";
import type { Region } from "@rally/contracts/regions";

import { workspaceDOName } from "../durable-objects/names";
import type { Env } from "../env";
import { durableObjectStubForWorkspace, workspacePlacementAffinity } from "../lib/durable-object-namespace";
import { settledFailureCode } from "../lib/settled-failure-code";

export interface ListedSharedCanvases {
  region: Region;
  workspaceId: WorkspaceId;
  items: CanvasSidebarRow[];
}

/**
 * The Canvases someone else shared with this person in each of their
 * Organizations in this deployment, read in parallel from each WorkspaceDO's
 * own list for them (`canvasListFor`, the rows their sidebar holds), keeping
 * only `sharedWithMe`. A guest relationship is read too: being shared a Canvas
 * is what a guest is for. One Organization whose read fails is left out rather
 * than failing the rest, as `membershipAttention` does.
 */
export async function membershipSharedCanvases(
  env: Env,
  userId: string,
  workspaces: readonly Pick<Workspace, "id" | "accessClass">[],
): Promise<{ canvases: ListedSharedCanvases[]; failed: Array<{ workspaceId: string; code: string }> }> {
  const settled = await Promise.allSettled(workspaces.map(async (workspace) => {
    const stub = await durableObjectStubForWorkspace(
      env,
      env.WORKSPACE_DOS,
      workspace.id,
      workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspace.id)),
      await workspacePlacementAffinity(env, workspace.id),
    );
    const rows = await stub.canvasListFor({
      workspaceId: workspace.id,
      userId,
      accessClass: workspace.accessClass === "guest" ? "guest" : "member",
    });
    return rows.filter((row) => row.sharedWithMe);
  }));
  return {
    canvases: settled.flatMap((result, index) => result.status === "fulfilled"
      ? [{ region: env.AVALON_REGION, workspaceId: asWorkspaceId(workspaces[index]!.id), items: result.value }]
      : []),
    failed: settled.flatMap((result, index) => result.status === "rejected"
      ? [{ workspaceId: workspaces[index]!.id, code: settledFailureCode(result.reason, "shared_canvases") }]
      : []),
  };
}
