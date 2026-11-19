import type { AddEngineeringOrgMemberInput, AddEngineeringOrgMemberResult } from "@rally/contracts/engineering-inspection";

import type { Env } from "../env";
import { engineeringUserAuth } from "./engineering-creation";
import { WorkspaceService } from "./workspace-service";

/**
 * Add a person to an Organization as one of its owners or admins, through the
 * service the app's Add member action calls. Its admin check, account creation
 * for a new address, invitation revocation, relationship dispatch, directory
 * push and "added you" email all apply unchanged; nothing here writes a
 * membership row of its own.
 */
export async function addEngineeringOrgMember(
  env: Env, input: AddEngineeringOrgMemberInput,
): Promise<AddEngineeringOrgMemberResult> {
  const auth = await engineeringUserAuth(env, input.orgId, input.adminUserId);
  const added = await new WorkspaceService(env, auth).addMember(input.email, input.role);
  return { region: env.AVALON_REGION, orgId: input.orgId, ...added };
}
