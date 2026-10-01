import type { UserId, WorkspaceId } from "@rally/contracts";
import {
  SharedDirectorySchema,
  SharedNavigationDirectorySchema,
  SharedNavigationSpaceSchema,
  SharedNavigationWorkstreamSchema,
  SharedWorkstreamSchema,
  type SharedNavigationDirectory,
} from "@rally/contracts/scope-grants";
import { ScopeGrantCandidatesSchema } from "../durable-objects/scope-grant-directory";
import { workspaceDOName } from "../durable-objects/names";
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
  const items = candidates.length === 0 ? [] : SharedNavigationWorkstreamSchema.nullable().array().parse(
    await workspace.readSharedWorkstreams({
      workspaceId, parentIds: candidates, userId, membershipIncarnation: relationship.incarnation,
    }),
  );
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
/**
 * The navigation fields added after strict clients shipped: a Breakout's
 * origin turn and a Space's system role. Shipped desktop and browser builds
 * parse this response with strict schemas, so a caller receives them only when
 * it asks with `?origins=1`.
 */
export function withoutOriginFields(directory: SharedNavigationDirectory): SharedNavigationDirectory {
  return {
    spaces: directory.spaces.map((space) => {
      const shipped = { ...space };
      delete shipped.systemRole;
      return shipped;
    }),
    workstreams: directory.workstreams.map((workstream) => ({
      ...workstream,
      conversations: workstream.conversations.map((conversation) => {
        const shipped = { ...conversation };
        delete shipped.originTurnId;
        return shipped;
      }),
    })),
  };
}

export async function listSharedNavigationDirectory(env: Env, workspaceId: WorkspaceId, userId: UserId, includeAttention = false, includeOrigins = false) {
  const relationship = await readWorkspaceRelationship(env.DB, workspaceId, userId);
  if (relationship?.status !== "active") {
    return SharedNavigationDirectorySchema.parse({ spaces: [], workstreams: [] });
  }
  const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId,
    workspaceDOName(env.AVALON_REGION, workspaceId));
  const candidates = ScopeGrantCandidatesSchema.parse(await workspace.listScopeGrantCandidates({
    workspaceId, userId, membershipIncarnation: relationship.incarnation,
  }));
  // Every candidate Channel is hosted in this one object, so one RPC answers
  // for all of them; each Channel still decides what it releases. Nobody
  // shared anything with most members, and that answer needs no round trip.
  const items = candidates.length === 0 ? [] : SharedNavigationWorkstreamSchema.nullable().array().parse(
    await workspace.readSharedWorkstreams({
      workspaceId, parentIds: candidates, userId, membershipIncarnation: relationship.incarnation, includeAttention,
    }),
  );
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
  const directory = SharedNavigationDirectorySchema.parse({ spaces, workstreams });
  return includeOrigins ? directory : withoutOriginFields(directory);
}
