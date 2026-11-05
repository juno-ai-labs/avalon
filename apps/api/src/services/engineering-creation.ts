import { asSpaceId, asWorkspaceId, asWorkstreamId, type UserId, type WorkspaceId } from "@rally/contracts";
import type {
  AcceptEngineeringInvitationInput, AcceptEngineeringInvitationResult,
  ListEngineeringInvitationsInput, ListEngineeringInvitationsResult,
  CreateEngineeringChannelInput, CreateEngineeringChannelResult,
  CreateEngineeringOrgInput, CreateEngineeringOrgResult,
  CreateEngineeringThreadInput, CreateEngineeringThreadResult,
} from "@rally/contracts/engineering-inspection";

import type { AuthContext, Env } from "../env";
import { resolveInspectionWorkspaceRoute } from "../engineering-inspection-routes";
import { ApiError } from "../lib/api-error";
import { RegionalOnboardingService } from "./platform-onboarding-service";
import { SpaceService } from "./space-service";
import { acceptInvitationForUser } from "./workspace-service";
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

async function invitee(env: Env, userId: string): Promise<{ id: string; email: string; name: string }> {
  const user = await env.DB.prepare("SELECT id, email, name FROM users WHERE id = ?").bind(userId)
    .first<{ id: string; email: string; name: string }>();
  if (!user) throw new ApiError(404, "user_not_found", "No Rally user has this ID");
  return user;
}

/** The same pending invitations the app's invitation card lists for this person. */
export async function listEngineeringInvitations(env: Env, input: ListEngineeringInvitationsInput): Promise<ListEngineeringInvitationsResult> {
  const user = await invitee(env, input.userId);
  const rows = await env.DB.prepare(
    `SELECT i.id, i.workspace_id, w.name AS workspace_name, inviter.name AS invited_by_name
     FROM workspace_invitations i
     JOIN workspaces w ON w.id = i.workspace_id
     JOIN users inviter ON inviter.id = i.invited_by_user_id
     WHERE i.email = ? COLLATE NOCASE
       AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?
       AND w.region = ? AND w.abandoned_at IS NULL
     ORDER BY i.created_at DESC`,
  ).bind(user.email, new Date().toISOString(), env.AVALON_REGION)
    .all<{ id: string; workspace_id: string; workspace_name: string; invited_by_name: string }>();
  return {
    region: env.AVALON_REGION,
    items: (rows.results ?? []).map((row) => ({
      invitationId: row.id, orgId: asWorkspaceId(row.workspace_id), orgName: row.workspace_name, invitedByName: row.invited_by_name,
    })),
  };
}

/** Accepts as the user; the invitation's address must be the user's, as in the app. */
export async function acceptEngineeringInvitation(env: Env, input: AcceptEngineeringInvitationInput): Promise<AcceptEngineeringInvitationResult> {
  const orgId = await acceptInvitationForUser(env, input.invitationId, await invitee(env, input.userId));
  return { region: env.AVALON_REGION, orgId: asWorkspaceId(orgId) };
}

/** The Organization an invitation is for, which the audit entry names before anything is written. */
export async function invitationOrgId(env: Env, invitationId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT workspace_id FROM workspace_invitations WHERE id = ?").bind(invitationId)
    .first<{ workspace_id: string }>();
  if (!row) throw new ApiError(404, "invitation_invalid", "This invitation is invalid, expired, or no longer available");
  return row.workspace_id;
}

export async function createEngineeringChannel(env: Env, input: CreateEngineeringChannelInput, defer: (work: Promise<void>) => void): Promise<CreateEngineeringChannelResult> {
  const auth = await engineeringUserAuth(env, input.orgId, input.creatorUserId, input.operationId);
  const participantUserIds = [...new Set([input.creatorUserId, ...input.participantUserIds])];
  const spaces = new SpaceService(env, auth);
  const channelId = asSpaceId(input.operationId);
  const channel = await spaces.create({ name: input.name, scope: "workspace", colorKey: "blue", participantUserIds }, channelId, defer);
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
