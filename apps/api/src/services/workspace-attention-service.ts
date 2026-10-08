import {
  WorkspaceAttentionSchema,
  asWorkspaceId,
  type Workspace,
  type WorkspaceAttention,
  type WorkspaceId,
} from "@rally/contracts";
import type { Region } from "@rally/contracts/regions";

import { workspaceDOName } from "../durable-objects/names";
import type { AuthContext, Env } from "../env";
import { settledFailureCode } from "../lib/settled-failure-code";
import {
  durableObjectStubForWorkspace,
  workspacePlacementAffinity,
} from "../lib/durable-object-namespace";

/** One person's attention in one workspace of this deployment, read from its WorkspaceDO. */
async function readWorkspaceAttention(
  env: Env,
  input: { workspaceId: string; userId: string; accessClass: "member" | "guest" },
): Promise<WorkspaceAttention> {
  const placementAffinity = await workspacePlacementAffinity(env, input.workspaceId);
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    input.workspaceId,
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(input.workspaceId)),
    placementAffinity,
  );
  return WorkspaceAttentionSchema.parse(await workspace.attention(input));
}

/** Read the current member's cross-work-stream attention from WorkspaceDO. */
export async function workspaceAttention(
  env: Env,
  auth: AuthContext,
): Promise<WorkspaceAttention> {
  return readWorkspaceAttention(env, {
    workspaceId: auth.workspaceId,
    userId: auth.userId,
    accessClass: auth.accessClass ?? "member",
  });
}

export interface ListedWorkspaceAttention {
  region: Region;
  workspaceId: WorkspaceId;
  attention: WorkspaceAttention;
}

/**
 * Attention for each of a person's memberships in this deployment, read in
 * parallel. A guest relationship is skipped because WorkspaceDO refuses it, and
 * one workspace whose read fails is left out rather than failing the rest: the
 * row simply shows no count, as it would with nothing new.
 */
export async function membershipAttention(
  env: Env,
  userId: string,
  workspaces: readonly Pick<Workspace, "id" | "accessClass">[],
): Promise<{ attention: ListedWorkspaceAttention[]; failed: Array<{ workspaceId: string; code: string }> }> {
  const members = workspaces.filter((workspace) => workspace.accessClass !== "guest");
  const settled = await Promise.allSettled(members.map((workspace) => readWorkspaceAttention(env, {
    workspaceId: workspace.id,
    userId,
    accessClass: "member",
  })));
  return {
    attention: settled.flatMap((result, index) => result.status === "fulfilled"
      ? [{ region: env.AVALON_REGION, workspaceId: asWorkspaceId(members[index]!.id), attention: result.value }]
      : []),
    failed: settled.flatMap((result, index) => result.status === "rejected"
      ? [{
          workspaceId: members[index]!.id,
          code: settledFailureCode(result.reason, "workspace_attention"),
        }]
      : []),
  };
}
