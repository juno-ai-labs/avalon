import type { ConversationParentKind } from "@rally/contracts/conversation-parent";
import { asAutomationId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import type { AutomationDO } from "../durable-objects/automation-do";
import { automationDOName, workstreamDOName } from "../durable-objects/names";
import type { WorkstreamDO } from "../durable-objects/workstream-do";
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
 * Both classes answer the conversation-parent contract, so a caller that only
 * needs that contract (the Queue consumer carrying a child's effects, the
 * Worker authorizing a viewer, revocation walking the hierarchy) asks here
 * and never branches on the kind itself.
 */
export async function conversationParentStub(
  env: Env,
  address: ConversationParentAddress,
): Promise<DurableObjectStub<WorkstreamDO> | DurableObjectStub<AutomationDO>> {
  const workspaceId = asWorkspaceId(address.workspaceId);
  if (address.parentKind === "automation") {
    return durableObjectStubForWorkspace(
      env,
      env.AUTOMATION_DOS,
      workspaceId,
      automationDOName(env.AVALON_REGION, workspaceId, asAutomationId(address.parentId)),
    );
  }
  return durableObjectStubForWorkspace(
    env,
    env.WORKSTREAM_DOS,
    workspaceId,
    workstreamDOName(env.AVALON_REGION, workspaceId, asWorkstreamId(address.parentId)),
  );
}
