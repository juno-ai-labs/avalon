import { asSpaceId, asWorkspaceId, asWorkstreamId, type UserId, type WorkspaceId } from "@rally/contracts";
import type {
  CreateEngineeringChannelInput, CreateEngineeringChannelResult,
  CreateEngineeringOrgInput, CreateEngineeringOrgResult,
  CreateEngineeringThreadInput, CreateEngineeringThreadResult,
} from "@rally/contracts/engineering-inspection";

import type { AuthContext, Env } from "../env";
import { resolveInspectionWorkspaceRoute } from "../engineering-inspection-routes";
import { ApiError } from "../lib/api-error";
import { RegionalOnboardingService } from "./platform-onboarding-service";
import { SpaceService } from "./space-service";
import { WorkstreamObjectCreationService } from "./workstream-object-creation-service";

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

export async function createEngineeringChannel(env: Env, input: CreateEngineeringChannelInput, defer: (work: Promise<void>) => void): Promise<CreateEngineeringChannelResult> {
  const auth = await engineeringUserAuth(env, input.orgId, input.creatorUserId, input.operationId);
  const participantUserIds = [...new Set([input.creatorUserId, ...input.participantUserIds])];
  const spaces = new SpaceService(env, auth);
  const channelId = asSpaceId(input.operationId);
  await spaces.create({ name: input.name, scope: "workspace", colorKey: "blue" }, channelId, defer);
  const channel = await spaces.updateAudience(channelId, { scope: "workspace", participantUserIds });
  if (!channel) throw new ApiError(409, "created_channel_unavailable", "The created Channel is unavailable");
  return { region: env.AVALON_REGION, orgId: input.orgId, channelId, channel };
}

export async function createEngineeringThread(
  env: Env, input: CreateEngineeringThreadInput, defer: (work: Promise<unknown>) => void,
): Promise<CreateEngineeringThreadResult> {
  const auth = await engineeringUserAuth(env, input.orgId, input.creatorUserId, input.operationId);
  const created = await new WorkstreamObjectCreationService(env, auth, defer).create({
    workstreamId: asWorkstreamId(input.operationId),
    spaceIds: [input.channelId],
    openingMessage: input.prompt,
    clientMessageId: input.operationId,
    participantUserIds: [], attachmentIds: [], scope: "workspace",
  }, { narrowInPrivateSpaces: true, notifyParticipants: true });
  return { region: env.AVALON_REGION, orgId: input.orgId, channelId: input.channelId,
    threadId: asWorkstreamId(created.workstream.id), turnId: created.turnId, harnessRunId: created.harnessRunId };
}
