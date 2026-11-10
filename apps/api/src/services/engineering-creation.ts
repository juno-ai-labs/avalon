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
  const unavailable = () => new ApiError(409, "organization_authority_unavailable", "Organization authority is unavailable");
  if (!await resolveInspectionWorkspaceRoute(env, orgId)) throw unavailable();
  // One read answers two questions, and each refusal names its own. An
  // abandoned Organization refuses every user, so it is checked first: blaming
  // the membership there sends the operator to try users who cannot pass either.
  // A guest's role is null, so the member's own id says whether a row matched.
  const row = await env.DB.prepare(
    `SELECT w.abandoned_at, m.user_id AS member_user_id, m.role
       FROM workspaces w
       LEFT JOIN workspace_members m
         ON m.workspace_id = w.id AND m.user_id = ? AND m.status = 'active'
      WHERE w.id = ? AND w.region = ?`,
  ).bind(userId, orgId, env.AVALON_REGION)
    .first<{ abandoned_at: string | null; member_user_id: string | null; role: AuthContext["role"] }>();
  if (!row) throw unavailable();
  if (row.abandoned_at !== null) throw new ApiError(409, "organization_abandoned", "The Organization is abandoned, so nobody can act in it");
  if (row.member_user_id === null) throw new ApiError(403, "user_not_active_organization_user", "The user is not an active member or guest in this Organization");
  return { sessionId: operationId, workspaceId: orgId, userId, region: env.AVALON_REGION,
    role: row.role, principal: "engineering" };
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
