import type { ConversationParentKind } from "@rally/contracts/conversation-parent";
import { asAutomationId, asWorkspaceId } from "@rally/contracts";

import type { AutomationDO } from "../durable-objects/automation-do";
import { automationDOName, workspaceDOName } from "../durable-objects/names";
import type { WorkspaceDO } from "../durable-objects/workspace-do";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";

export interface ConversationParentAddress {
  workspaceId: string;
  parentKind: ConversationParentKind;
  parentId: string;
}

/**
 * The stub for whichever object is a conversation's parent.
 *
 * A Channel's and a Space's parent authority lives in the Organization's
 * `WorkspaceDO`, which answers the conversation-parent contract for every one
 * of them by parent id (`docs/hosted-conversation-parents.md`). A Sidekick's
 * parent is still its own `SidekickDO`. A caller that only needs the contract
 * asks here and never branches on the kind itself.
 */
export async function conversationParentStub(
  env: Env,
  address: ConversationParentAddress,
): Promise<DurableObjectStub<WorkspaceDO> | DurableObjectStub<AutomationDO>> {
  const workspaceId = asWorkspaceId(address.workspaceId);
  if (address.parentKind === "automation") {
    return durableObjectStubForWorkspace(
      env,
      env.AUTOMATION_DOS,
      workspaceId,
      automationDOName(env.AVALON_REGION, workspaceId, asAutomationId(address.parentId)),
    );
  }
  return hostedParentStub(env, workspaceId);
}

/** The Organization object that hosts every Channel and Space parent of one workspace. */
export async function hostedParentStub(env: Env, workspaceId: string): Promise<DurableObjectStub<WorkspaceDO>> {
  const id = asWorkspaceId(workspaceId);
  return durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, id, workspaceDOName(env.AVALON_REGION, id));
}
