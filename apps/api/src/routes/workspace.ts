import { PromoteWorkspaceGuestSchema, WorkspaceRelationshipSchema } from "@rally/contracts/scope-grants";
import { OnboardingJourneyService } from '../services/onboarding-journey-service';
import { OnboardingJourneySchema, UpdateOnboardingJourneySchema } from '@rally/contracts';
import { Hono, type Context } from "hono";
import { zValidator } from "../middleware/validation";
import {
  AcceptWorkspaceInvitationRequestSchema,
  ContainerOrderSchema,
  PinnedOrderWriteSchema,
  CreateWorkspaceInvitationRequestSchema,
  IdSchema,
  CreateWorkspaceInvitationResponseSchema,
  MemberPreferencesSchema,
  MemberPreferencesUpdateSchema,
  PersonalSystemPromptSchema,
  MemoryForgetResponseSchema,
  MemoryReviewSchema,
  UpdateUserTimezoneRequestSchema,
  DeviceTimezoneRequestSchema,
  UserTimezoneSchema,
  UpdateWorkspaceMemberRoleRequestSchema,
  UpdateWorkspaceRequestSchema,
  WorkspaceInvitationSchema,
  WorkspaceInviteeSchema,
  WorkspaceAttentionSchema,
  WorkspaceMemberSchema,
  UserSchema,
  WorkspaceSchema,
  TerminalWorkspaceSettingsSchema,
  TerminalNetworkPolicyPreviewSchema,
  PreviewTerminalNetworkPolicyRequestSchema,
  ApplyTerminalNetworkPolicyRequestSchema,
  SocketTicketSchema,
  SupportAccessSchema,
} from "@rally/contracts";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { clientReadsIndividualSpaces, requireCurrentClientContract } from "../lib/client-contract";
import { requestDeferral } from "../lib/defer";
import { getAuth, getWorkspaceAuth } from "../middleware/auth";
import { SpaceService } from "../services/space-service";
import { readUserTimezone, reportDeviceTimezone, WorkspaceService } from "../services/workspace-service";
import { SupportAccessService } from "../services/support-access";
import { workspaceAttention } from "../services/workspace-attention-service";
import { parseTerminalRegionConfiguration } from "../services/terminal/contract";
import { createTerminalProviderRpcClient } from "../services/terminal/provider-rpc-client";
import { TerminalSettingsService } from "../services/terminal/settings";
import { issueWorkspaceSocketTicket } from "../services/socket-service";
import { OrganizationUsageSchema, WorkspacePlanChangeSchema } from "@rally/contracts/usage";
import { publishOrganizationUsage, readOrganizationUsage } from "../services/usage-metering";
import { ApiError } from "../lib/api-error";

const invitationParam = z.object({ id: IdSchema });
const memberParam = z.object({ userId: IdSchema });
const memoryFactParam = z.object({ factId: z.string().min(1) });
const MemberPageSchema = z.object({ items: z.array(WorkspaceMemberSchema) });
const InvitationPageSchema = z.object({ items: z.array(WorkspaceInvitationSchema) });
const InviteePageSchema = z.object({ items: z.array(WorkspaceInviteeSchema) });

/**
 * The workspace socket's ticket, for members and guests alike.
 *
 * Mounted on the identity layer with the workspace-relationship check rather
 * than under `requireAuth`, which admits members only: WorkspaceDO already
 * shapes a guest's socket (no Space state, per-viewer rows), and a guest's
 * client needs it for the membership nudges its shared navigation follows.
 *
 * The door to the sidebar payload, which now carries both Space directories
 * and is parsed strictly by every shipped desktop. A build that cannot read it
 * is told to update here rather than left reconnecting to a socket whose first
 * frame it discards.
 */
export async function workspaceSocketTicket(c: Context<HonoAppEnv>) {
  requireCurrentClientContract((name) => c.req.header(name));
  const auth = getWorkspaceAuth(c);
  const ticket = await issueWorkspaceSocketTicket(c.env, auth, {
    readsIndividualSpaces: clientReadsIndividualSpaces((name) => c.req.header(name)),
  });
  const url = new URL(c.env.PUBLIC_API_BASE_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/socket/workspaces/${auth.workspaceId}`;
  url.search = "";
  return c.json(SocketTicketSchema.parse({ url: url.toString(), ticket }));
}

export const workspaceRoutes = new Hono<HonoAppEnv>();

async function withTerminalSettingsService<T>(
  c: Context<HonoAppEnv>,
  use: (service: TerminalSettingsService) => Promise<T>,
): Promise<T> {
  const configuration = parseTerminalRegionConfiguration(c.env);
  const provider = configuration.capability === "supported"
    ? createTerminalProviderRpcClient(c.env.TERMINAL_PROVIDER, configuration)
    : null;
  try {
    return await use(new TerminalSettingsService(c.env, getAuth(c), provider));
  } finally {
    provider?.[Symbol.dispose]();
  }
}

/**
 * The Organization's profile, for members and guests alike. Mounted on the
 * identity layer beside the socket ticket, for the same reason: the one shell
 * both mount reads it before anything else.
 */
export async function workspaceProfile(c: Context<HonoAppEnv>) {
  return c.json(WorkspaceSchema.parse(await new WorkspaceService(c.env, getWorkspaceAuth(c)).getWorkspace()));
}

/**
 * A client reporting its device's zone, for members and guests alike: both
 * receive digests in their own day. Mounted beside the profile for the same
 * reason. See `reportDeviceTimezone`.
 */
export const deviceTimezoneRoutes = new Hono<HonoAppEnv>();
deviceTimezoneRoutes.put("/", zValidator("json", DeviceTimezoneRequestSchema), async (c) =>
  c.json(UserTimezoneSchema.parse(
    await reportDeviceTimezone(c.env, getWorkspaceAuth(c).userId, c.req.valid("json").timezone))));

workspaceRoutes.get("/attention", async (c) =>
  c.json(WorkspaceAttentionSchema.parse(await workspaceAttention(c.env, getAuth(c)))));
// The usage meter. Every member role may read it: usage is shared by design.
workspaceRoutes.get("/usage", async (c) => {
  const usage = await readOrganizationUsage(c.env, getAuth(c).workspaceId, Date.now());
  if (!usage) throw new ApiError(404, "workspace_not_found", "Workspace not found");
  return c.json(OrganizationUsageSchema.parse(usage));
});
// An administrator choosing the Organization's plan. Answers with the meter as
// it reads under the new plan, so the picker repaints without a second read,
// and pushes the same meter to every other member after the response.
workspaceRoutes.put("/plan", zValidator("json", WorkspacePlanChangeSchema), async (c) => {
  const auth = getAuth(c);
  const usage = await new WorkspaceService(c.env, auth).setPlan(c.req.valid("json").plan);
  requestDeferral(c)(publishOrganizationUsage(c.env, auth.workspaceId));
  return c.json(OrganizationUsageSchema.parse(usage));
});
workspaceRoutes.patch("/", zValidator("json", UpdateWorkspaceRequestSchema), async (c) =>
  c.json(WorkspaceSchema.parse(await new WorkspaceService(c.env, getAuth(c)).updateWorkspace(c.req.valid("json")))),
);
// Rally access (`docs/impersonation.md`). Every member reads it; the service
// lets only an administrator who is not a support session change it.
workspaceRoutes.get("/support-access", async (c) =>
  c.json(SupportAccessSchema.parse(await new SupportAccessService(c.env, getAuth(c)).status())));
workspaceRoutes.put("/support-access", async (c) =>
  c.json(SupportAccessSchema.parse(await new SupportAccessService(c.env, getAuth(c)).grant())));
workspaceRoutes.delete("/support-access", async (c) =>
  c.json(SupportAccessSchema.parse(await new SupportAccessService(c.env, getAuth(c)).revoke())));
workspaceRoutes.patch("/me", zValidator("json", UpdateUserTimezoneRequestSchema), async (c) => {
  const { timezone, followDevice } = c.req.valid("json");
  // The person's user record, not a membership: parsing it as a membership
  // failed every save with a 500 after the write had already landed.
  return c.json(UserSchema.parse(
    await new WorkspaceService(c.env, getAuth(c)).updateMyTimezone(timezone, followDevice === true)));
});
workspaceRoutes.get("/me/timezone", async (c) =>
  c.json(UserTimezoneSchema.parse(await readUserTimezone(c.env, getAuth(c).userId))));
// Under `/me` and apart from the member record: other members read that record,
// and only its author may read this.
workspaceRoutes.get("/me/system-prompt", async (c) =>
  c.json(PersonalSystemPromptSchema.parse(
    await new WorkspaceService(c.env, getAuth(c)).getMyPersonalSystemPrompt())),
);
workspaceRoutes.get("/me/preferences", async (c) =>
  c.json(MemberPreferencesSchema.parse(await new WorkspaceService(c.env, getAuth(c)).getMyPreferences())),
);
workspaceRoutes.put("/me/preferences", zValidator("json", MemberPreferencesUpdateSchema), async (c) =>
  c.json(MemberPreferencesSchema.parse(
    await new WorkspaceService(c.env, getAuth(c)).updateMyPreferences(c.req.valid("json")))),
);
workspaceRoutes.put("/me/system-prompt", zValidator("json", PersonalSystemPromptSchema), async (c) =>
  c.json(PersonalSystemPromptSchema.parse(
    await new WorkspaceService(c.env, getAuth(c)).updateMyPersonalSystemPrompt(
      c.req.valid("json").personalSystemPrompt))),
);
/** What Rally remembers about this person; `docs/agent-memory.md` owns which facts and who may remove them. */
workspaceRoutes.get("/me/memory", async (c) =>
  c.json(MemoryReviewSchema.parse(await new WorkspaceService(c.env, getAuth(c)).getMyMemory())),
);
workspaceRoutes.delete("/me/memory/:factId", zValidator("param", memoryFactParam), async (c) =>
  c.json(MemoryForgetResponseSchema.parse(
    await new WorkspaceService(c.env, getAuth(c)).forgetMyMemory(c.req.valid("param").factId))),
);
/** What Rally remembers about the Organization, as this person may see it; removing takes an administrator. */
workspaceRoutes.get("/memory", async (c) =>
  c.json(MemoryReviewSchema.parse(await new WorkspaceService(c.env, getAuth(c)).getOrganizationMemory())),
);
workspaceRoutes.delete("/memory/:factId", zValidator("param", memoryFactParam), async (c) =>
  c.json(MemoryForgetResponseSchema.parse(
    await new WorkspaceService(c.env, getAuth(c)).forgetOrganizationMemory(c.req.valid("param").factId))),
);
/**
 * One person's order for one list they arranged by hand.
 *
 * At the workspace level rather than under `/spaces` because the container is
 * not always a Space: the same request orders the Organization's Spaces, one
 * Space's Channels and one Channel's Breakouts, and a `/spaces/order` that
 * carried a Breakout's arrangement would be a Space route about something no
 * Space has heard of. The authority is still the Space one — the rows, the
 * refusals and the snapshot the answer is republished on all belong to it — so
 * this reaches it through `SpaceService`.
 *
 * It answers with what was stored rather than with the whole directory: the
 * lists themselves arrive on the workspace socket, which this write
 * republishes to every session this person has open.
 */
workspaceRoutes.put("/order", zValidator("json", ContainerOrderSchema), async (c) =>
  c.json(ContainerOrderSchema.parse(
    await new SpaceService(c.env, getAuth(c)).reorderContainer(c.req.valid("json")),
  )),
);
/** All's Pinned order, which is not an `OrderedContainer`; see `PinnedOrderSchema`. */
workspaceRoutes.put("/pinned-order", zValidator("json", PinnedOrderWriteSchema), async (c) =>
  c.json(PinnedOrderWriteSchema.parse({
    itemIds: await new SpaceService(c.env, getAuth(c)).reorderAllPinned(c.req.valid("json").itemIds),
  })),
);
workspaceRoutes.get("/terminal", async (c) =>
  c.json(TerminalWorkspaceSettingsSchema.parse(await withTerminalSettingsService(c, (service) => service.get()))),
);
workspaceRoutes.post(
  "/terminal/network-policy/preview",
  zValidator("json", PreviewTerminalNetworkPolicyRequestSchema),
  async (c) => c.json(TerminalNetworkPolicyPreviewSchema.parse(
    await withTerminalSettingsService(c, (service) => service.preview(c.req.valid("json"))),
  )),
);
workspaceRoutes.post(
  "/terminal/network-policy/apply",
  zValidator("json", ApplyTerminalNetworkPolicyRequestSchema),
  async (c) => c.json(TerminalWorkspaceSettingsSchema.parse(
    await withTerminalSettingsService(c, (service) => service.apply(c.req.valid("json"))),
  )),
);
workspaceRoutes.get("/members", async (c) =>
  c.json(MemberPageSchema.parse({ items: await new WorkspaceService(c.env, getAuth(c)).listMembers() })),
);
/**
 * Make somebody an administrator, or take it back.
 *
 * `PATCH` on the membership rather than a `promote`/`demote` pair: the role is
 * one field with one assignable set, and two endpoints would be two places to
 * grow a third role into. It is a different operation from the guest promotion
 * below, which moves an access class rather than a role.
 */
workspaceRoutes.patch(
  "/members/:userId/role",
  zValidator("param", memberParam),
  zValidator("json", UpdateWorkspaceMemberRoleRequestSchema),
  async (c) => {
    await new WorkspaceService(c.env, getAuth(c)).setMemberRole(
      c.req.valid("param").userId,
      c.req.valid("json").role,
    );
    return c.body(null, 204);
  },
);
workspaceRoutes.post("/members/:id/promote", zValidator("param", invitationParam),
  zValidator("json", PromoteWorkspaceGuestSchema), async (c) =>
    c.json(WorkspaceRelationshipSchema.parse(await new WorkspaceService(c.env, getAuth(c))
      .promoteGuest(c.req.valid("param").id, c.req.valid("json")))),
);
/**
 * Pending Organization invitations as members see them, for the people
 * pickers; `/invitations` is the administrator's full list.
 */
workspaceRoutes.get("/invitees", async (c) =>
  c.json(InviteePageSchema.parse({ items: await new WorkspaceService(c.env, getAuth(c)).listInvitees() })),
);
workspaceRoutes.get("/invitations", async (c) =>
  c.json(InvitationPageSchema.parse({ items: await new WorkspaceService(c.env, getAuth(c)).listInvitations() })),
);
workspaceRoutes.post("/invitations", zValidator("json", CreateWorkspaceInvitationRequestSchema), async (c) => {
  const body = c.req.valid("json");
  return c.json(CreateWorkspaceInvitationResponseSchema.parse(
    await new WorkspaceService(c.env, getAuth(c)).createInvitation(body.email, body.role)), 201);
});
workspaceRoutes.delete("/invitations/:id", zValidator("param", invitationParam), async (c) => {
  await new WorkspaceService(c.env, getAuth(c)).revokeInvitation(c.req.valid("param").id);
  return c.body(null, 204);
});
workspaceRoutes.post("/invitations/accept", zValidator("json", AcceptWorkspaceInvitationRequestSchema), async (c) => {
  await new WorkspaceService(c.env, getAuth(c)).acceptInvitation(c.req.valid("json").token);
  return c.body(null, 204);
});

workspaceRoutes.get('/onboarding', async (c) => c.json(OnboardingJourneySchema.parse(await new OnboardingJourneyService(c.env, getAuth(c)).get())));
workspaceRoutes.patch('/onboarding', zValidator('json', UpdateOnboardingJourneySchema), async (c) =>
  c.json(OnboardingJourneySchema.parse(await new OnboardingJourneyService(c.env, getAuth(c)).get(c.req.valid('json')))));
