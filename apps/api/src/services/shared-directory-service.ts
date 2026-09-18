import { asWorkspaceId, asWorkstreamId, type UserId, type WorkspaceId } from "@rally/contracts";
import { SharedDirectorySchema, SharedWorkstreamSchema } from "@rally/contracts/scope-grants";
import { ScopeGrantCandidatesSchema } from "../durable-objects/scope-grant-directory";
import { workspaceDOName, workstreamDOName } from "../durable-objects/names";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { readWorkspaceRelationship } from "./workspace-relationship-service";
import type { Env } from "../env";

/** The index finds owners; only a current owner read may release navigation labels. */
export async function listSharedDirectory(env: Env, workspaceId: WorkspaceId, userId: UserId) {
  const relationship = await readWorkspaceRelationship(env.DB, workspaceId, userId);
  if (relationship?.status !== "active") return SharedDirectorySchema.parse({ workstreams: [] });
  const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId,
    workspaceDOName(env.AVALON_REGION, workspaceId));
  const candidates = ScopeGrantCandidatesSchema.parse(await workspace.listScopeGrantCandidates({
    workspaceId, userId, membershipIncarnation: relationship.incarnation,
  }));
  const items = await Promise.all(candidates.map(async (parentId) => {
    const parent = await durableObjectStubForWorkspace(env, env.WORKSTREAM_DOS, workspaceId,
      workstreamDOName(env.AVALON_REGION, asWorkspaceId(workspaceId), asWorkstreamId(parentId)));
    const item = SharedWorkstreamSchema.nullable().parse(await parent.readSharedWorkstream({
      workspaceId, parentId, userId, membershipIncarnation: relationship.incarnation,
    }));
    return item;
  }));
  const workstreams = items.filter((item) => item !== null);
  const current = await readWorkspaceRelationship(env.DB, workspaceId, userId);
  if (current?.status !== "active" || current.incarnation !== relationship.incarnation
    || current.revision !== relationship.revision) return SharedDirectorySchema.parse({ workstreams: [] });
  return SharedDirectorySchema.parse({ workstreams });
}
