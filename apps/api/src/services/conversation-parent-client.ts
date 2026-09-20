import type { ConversationParentKind } from "@rally/contracts/conversation-parent";
import { asAutomationId, asSpaceId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import type { AutomationDO } from "../durable-objects/automation-do";
import { automationDOName, spaceDOName, workstreamDOName } from "../durable-objects/names";
import type { SpaceDO } from "../durable-objects/space-do";
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
 * All three classes answer the conversation-parent contract, so a caller that
 * only needs that contract (the Queue consumer carrying a child's effects, the
 * Worker authorizing a viewer, revocation walking the hierarchy) asks here
 * and never branches on the kind itself.
 *
 * This is the one dispatch point, and deliberately: `SpaceDO` and `WorkstreamDO`
 * are the same class under different roles, so a caller that resolved the
 * binding itself would reach a *real object* under the wrong namespace rather
 * than failing — an empty Space where a Channel was meant, with no error on
 * either side.
 */
export async function conversationParentStub(
  env: Env,
  address: ConversationParentAddress,
): Promise<
  DurableObjectStub<WorkstreamDO> | DurableObjectStub<AutomationDO> | DurableObjectStub<SpaceDO>
> {
  const workspaceId = asWorkspaceId(address.workspaceId);
  if (address.parentKind === "automation") {
    return durableObjectStubForWorkspace(
      env,
      env.AUTOMATION_DOS,
      workspaceId,
      automationDOName(env.AVALON_REGION, workspaceId, asAutomationId(address.parentId)),
    );
  }
  if (address.parentKind === "space") {
    return durableObjectStubForWorkspace(
      env,
      env.SPACE_DOS,
      workspaceId,
      spaceDOName(env.AVALON_REGION, workspaceId, asSpaceId(address.parentId)),
    );
  }
  return durableObjectStubForWorkspace(
    env,
    env.WORKSTREAM_DOS,
    workspaceId,
    workstreamDOName(env.AVALON_REGION, workspaceId, asWorkstreamId(address.parentId)),
  );
}
