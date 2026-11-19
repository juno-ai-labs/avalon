import type { AddEngineeringOrgMemberInput, AddEngineeringOrgMemberResult } from "@rally/contracts/engineering-inspection";

import type { Env } from "../env";
import { engineeringUserAuth } from "./engineering-creation";
import { WorkspaceService } from "./workspace-service";

/** Add a member as a named owner or admin through the app's own `WorkspaceService.addMember`. */
export async function addEngineeringOrgMember(
  env: Env, input: AddEngineeringOrgMemberInput, operationId: string,
): Promise<AddEngineeringOrgMemberResult> {
  const auth = await engineeringUserAuth(env, input.orgId, input.adminUserId, { operationId });
  const added = await new WorkspaceService(env, auth).addMember(input.email, input.role);
  return { region: env.AVALON_REGION, orgId: input.orgId, ...added };
}
