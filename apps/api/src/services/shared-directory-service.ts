import { asWorkspaceId, asWorkstreamId, type UserId, type WorkspaceId } from "@rally/contracts";
import {
  SharedDirectorySchema,
  SharedNavigationDirectorySchema,
  SharedNavigationSpaceSchema,
  SharedNavigationWorkstreamSchema,
  SharedWorkstreamSchema,
} from "@rally/contracts/scope-grants";
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
    const item = SharedNavigationWorkstreamSchema.nullable().parse(await parent.readSharedWorkstream({
      workspaceId, parentId, userId, membershipIncarnation: relationship.incarnation,
    }));
    return item;
  }));
  const workstreams = items.filter((item) => item !== null).map((item) => SharedWorkstreamSchema.parse({
    parentId: item.parentId,
    title: item.conversations.some((conversation) => conversation.substreamId === "0") ? item.title : null,
    ...(item.appearance ? { appearance: item.appearance } : {}),
    ...(item.archived === undefined ? {} : { archived: item.archived }),
    conversations: item.conversations.map((conversation) => ({
      substreamId: conversation.substreamId,
      title: conversation.title,
      archived: conversation.archived,
    })),
  }));
  const current = await readWorkspaceRelationship(env.DB, workspaceId, userId);
  if (current?.status !== "active" || current.incarnation !== relationship.incarnation
    || current.revision !== relationship.revision) return SharedDirectorySchema.parse({ workstreams: [] });
  return SharedDirectorySchema.parse({ workstreams });
}

/** Guest browser hierarchy; canonical Channel owners still decide every label released. */
export async function listSharedNavigationDirectory(env: Env, workspaceId: WorkspaceId, userId: UserId, includeAttention = false) {
  const relationship = await readWorkspaceRelationship(env.DB, workspaceId, userId);
  if (relationship?.status !== "active") {
    return SharedNavigationDirectorySchema.parse({ spaces: [], workstreams: [] });
  }
  const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId,
    workspaceDOName(env.AVALON_REGION, workspaceId));
  const candidates = ScopeGrantCandidatesSchema.parse(await workspace.listScopeGrantCandidates({
    workspaceId, userId, membershipIncarnation: relationship.incarnation,
  }));
  const items = await Promise.all(candidates.map(async (parentId) => {
    const parent = await durableObjectStubForWorkspace(env, env.WORKSTREAM_DOS, workspaceId,
      workstreamDOName(env.AVALON_REGION, asWorkspaceId(workspaceId), asWorkstreamId(parentId)));
    return SharedNavigationWorkstreamSchema.nullable().parse(await parent.readSharedWorkstream({
      workspaceId, parentId, userId, membershipIncarnation: relationship.incarnation, includeAttention,
    }));
  }));
  const workstreams = items.filter((item) => item !== null);
  const spaces = SharedNavigationSpaceSchema.array().parse(await workspace.listSharedNavigationSpaces({
    workspaceId,
    userId,
    membershipIncarnation: relationship.incarnation,
    workstreamIds: workstreams.map((workstream) => workstream.parentId),
  }));
  const current = await readWorkspaceRelationship(env.DB, workspaceId, userId);
  if (current?.status !== "active" || current.incarnation !== relationship.incarnation
    || current.revision !== relationship.revision) {
    return SharedNavigationDirectorySchema.parse({ spaces: [], workstreams: [] });
  }
  return SharedNavigationDirectorySchema.parse({ spaces, workstreams });
}
