import { asWorkspaceId } from "@rally/contracts";
import type {
  CreateEngineeringOrgInput,
  CreateEngineeringOrgResult,
} from "@rally/contracts/engineering-inspection";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { RegionalOnboardingService } from "./platform-onboarding-service";

export async function createEngineeringOrg(env: Env, input: CreateEngineeringOrgInput): Promise<CreateEngineeringOrgResult> {
  if (input.region !== env.AVALON_REGION) throw new ApiError(409, "region_mismatch", "The Organization must be created in the named region");
  const userIds = [...new Set([input.creatorUserId, ...input.userIds])];
  const orgId = asWorkspaceId(input.operationId);
  await new RegionalOnboardingService(env).createWorkspaceForMember({
    operationId: input.operationId, workspaceId: orgId, name: input.name, userId: input.creatorUserId, memberUserIds: input.userIds,
  });
  return { region: env.AVALON_REGION, orgId, userIds };
}
