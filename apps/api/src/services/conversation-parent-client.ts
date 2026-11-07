import type { RetirementParentKind } from "@rally/contracts";
import { asWorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../durable-objects/names";
import type { WorkspaceDO } from "../durable-objects/workspace-do";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";

export interface ConversationParentAddress {
  workspaceId: string;
  /** Wide enough for a retired parent's effect, which the parent refuses by name. */
  parentKind: RetirementParentKind;
  parentId: string;
}

/**
 * The stub for whichever object is a conversation's parent.
 *
 * Every parent authority, a Channel's, a Space's and a Sidekick's, lives in
 * the Organization's `WorkspaceDO`, which answers the conversation-parent
 * contract for each by parent id and finds the kind itself
 * (`docs/hosted-conversation-parents.md`). The address's kind is kept for the
 * callers that log it; it no longer decides where the call goes.
 */
export async function conversationParentStub(
  env: Env,
  address: ConversationParentAddress,
): Promise<DurableObjectStub<WorkspaceDO>> {
  return hostedParentStub(env, asWorkspaceId(address.workspaceId));
}

/**
 * The Organization object that hosts every parent of one workspace: its
 * Channels, Spaces and Sidekicks. A caller that needs several of them, or
 * several Sidekicks, holds this one stub and asks in one call where a batch
 * method exists, since every call queues on the same object.
 */
export async function hostedParentStub(env: Env, workspaceId: string): Promise<DurableObjectStub<WorkspaceDO>> {
  const id = asWorkspaceId(workspaceId);
  return durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, id, workspaceDOName(env.AVALON_REGION, id));
}
