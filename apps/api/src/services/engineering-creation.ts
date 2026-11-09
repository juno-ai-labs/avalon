import { asWorkspaceId, type UserId, type WorkspaceId } from "@rally/contracts";
import type {
  CreateEngineeringOrgInput,
  CreateEngineeringOrgResult,
} from "@rally/contracts/engineering-inspection";

import type { AuthContext, Env } from "../env";
import { resolveInspectionWorkspaceRoute } from "../engineering-inspection-routes";
import { ApiError } from "../lib/api-error";
import { RegionalOnboardingService } from "./platform-onboarding-service";

/** Access authorizes the operator; product services still verify the named member or guest. */
export async function engineeringUserAuth(env: Env, orgId: WorkspaceId, userId: UserId, operationId = "engineering-read"): Promise<AuthContext> {
  if (!await resolveInspectionWorkspaceRoute(env, orgId)) throw new ApiError(409, "organization_authority_unavailable", "Organization authority is unavailable");
  const member = await env.DB.prepare(
    `SELECT m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.workspace_id = ? AND m.user_id = ? AND m.status = 'active'
       AND w.region = ? AND w.abandoned_at IS NULL`,
  ).bind(orgId, userId, env.AVALON_REGION).first<{ role: AuthContext["role"] }>();
  if (!member) throw new ApiError(403, "user_not_active_organization_user", "The user is not an active member or guest in this Organization");
  return { sessionId: operationId, workspaceId: orgId, userId, region: env.AVALON_REGION,
    role: member.role, principal: "engineering" };
}

export async function createEngineeringOrg(env: Env, input: CreateEngineeringOrgInput): Promise<CreateEngineeringOrgResult> {
  if (input.region !== env.AVALON_REGION) throw new ApiError(409, "region_mismatch", "The Organization must be created in the named region");
  const userIds = [...new Set([input.creatorUserId, ...input.userIds])];
  const orgId = asWorkspaceId(input.operationId);
  await new RegionalOnboardingService(env).createWorkspaceForMember({
    operationId: input.operationId, workspaceId: orgId, name: input.name, userId: input.creatorUserId, memberUserIds: input.userIds,
  });
  return { region: env.AVALON_REGION, orgId, userIds };
}
