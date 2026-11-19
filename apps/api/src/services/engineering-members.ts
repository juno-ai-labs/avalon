import type { AddEngineeringOrgMemberInput, AddEngineeringOrgMemberResult } from "@rally/contracts/engineering-inspection";

import type { Env } from "../env";
import { diagnosticErrorCode, logWarn } from "../observability/logger";
import { engineeringUserAuth } from "./engineering-user-auth";
import { publishWorkspaceSync, workspaceSyncPublicationsForMutation } from "./workspace-realtime-service";
import { WorkspaceService } from "./workspace-service";

/** Add a member as a named owner or admin through the app's own `WorkspaceService.addMember`. */
export async function addEngineeringOrgMember(
  env: Env, input: AddEngineeringOrgMemberInput, operationId: string,
): Promise<AddEngineeringOrgMemberResult> {
  const auth = await engineeringUserAuth(env, input.orgId, input.adminUserId, { operationId });
  const added = await new WorkspaceService(env, auth).addMember(input.email, input.role);
  // In the app, the route middleware sends the Organization-wide refresh, which
  // covers the invitation `addMember` may have revoked. This path has no route,
  // so it sends what that route sends, from the same map.
  for (const { topics } of workspaceSyncPublicationsForMutation("POST", "/workspace/members")) {
    await publishWorkspaceSync(env, input.orgId, topics).catch((error: unknown) =>
      logWarn(env, "workspace_realtime_publish_failed", { workspace_id: input.orgId, topics,
        code: diagnosticErrorCode(error, "workspace_realtime_publish_failed") }));
  }
  return { region: env.AVALON_REGION, orgId: input.orgId, ...added };
}
