import { PromoteWorkspaceGuestSchema, WorkspaceRelationshipSchema } from "@rally/contracts/scope-grants";
import { OnboardingJourneyService } from '../services/onboarding-journey-service';
import { OnboardingJourneySchema, UpdateOnboardingJourneySchema } from '@rally/contracts';
import { Hono, type Context } from "hono";
import { zValidator } from "../middleware/validation";
import {
  AcceptWorkspaceInvitationRequestSchema,
  ContainerOrderSchema,
  CreateWorkspaceInvitationRequestSchema,
  IdSchema,
  CreateWorkspaceInvitationResponseSchema,
  UpdateUserTimezoneRequestSchema,
  UpdateWorkspaceMemberRoleRequestSchema,
  UpdateWorkspaceRequestSchema,
  WorkspaceInvitationSchema,
  WorkspaceAttentionSchema,
  WorkspaceMemberSchema,
  WorkspaceSchema,
  TerminalWorkspaceSettingsSchema,
  TerminalNetworkPolicyPreviewSchema,
  PreviewTerminalNetworkPolicyRequestSchema,
  ApplyTerminalNetworkPolicyRequestSchema,
  SocketTicketSchema,
} from "@rally/contracts";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { requireCurrentClientContract } from "../lib/client-contract";
import { getAuth } from "../middleware/auth";
import { SpaceService } from "../services/space-service";
import { WorkspaceService } from "../services/workspace-service";
import { workspaceAttention } from "../services/workspace-attention-service";
import { parseTerminalRegionConfiguration } from "../services/terminal/contract";
import { createTerminalProviderRpcClient } from "../services/terminal/provider-rpc-client";
import { TerminalSettingsService } from "../services/terminal/settings";
import { issueWorkspaceSocketTicket } from "../services/socket-service";

const invitationParam = z.object({ id: IdSchema });
const memberParam = z.object({ userId: IdSchema });
const MemberPageSchema = z.object({ items: z.array(WorkspaceMemberSchema) });
const InvitationPageSchema = z.object({ items: z.array(WorkspaceInvitationSchema) });

export const workspaceRoutes = new Hono<HonoAppEnv>();

function terminalSettingsService(c: Context<HonoAppEnv>): TerminalSettingsService {
  const configuration = parseTerminalRegionConfiguration(c.env);
  const provider = configuration.capability === "supported"
    ? createTerminalProviderRpcClient(c.env.TERMINAL_PROVIDER, configuration)
    : null;
  return new TerminalSettingsService(c.env, getAuth(c), provider);
}

workspaceRoutes.get("/", async (c) =>
  c.json(WorkspaceSchema.parse(await new WorkspaceService(c.env, getAuth(c)).getWorkspace())));
workspaceRoutes.get("/attention", async (c) =>
  c.json(WorkspaceAttentionSchema.parse(await workspaceAttention(c.env, getAuth(c)))));
workspaceRoutes.get("/socket", async (c) => {
  // The door to the sidebar payload, which now carries both Space directories
  // and is parsed strictly by every shipped desktop. A build that cannot read
  // it is told to update here rather than left reconnecting to a socket whose
  // first frame it discards.
  requireCurrentClientContract((name) => c.req.header(name));
  const auth = getAuth(c);
  const ticket = await issueWorkspaceSocketTicket(c.env, auth);
  const url = new URL(c.env.PUBLIC_API_BASE_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/socket/workspaces/${auth.workspaceId}`;
  url.search = "";
  return c.json(SocketTicketSchema.parse({ url: url.toString(), ticket }));
});
workspaceRoutes.patch("/", zValidator("json", UpdateWorkspaceRequestSchema), async (c) =>
  c.json(WorkspaceSchema.parse(await new WorkspaceService(c.env, getAuth(c)).updateWorkspace(c.req.valid("json")))),
);
workspaceRoutes.patch("/me", zValidator("json", UpdateUserTimezoneRequestSchema), async (c) =>
  c.json(WorkspaceMemberSchema.parse(
    await new WorkspaceService(c.env, getAuth(c)).updateMyTimezone(c.req.valid("json").timezone))),
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
workspaceRoutes.get("/terminal", async (c) =>
  c.json(TerminalWorkspaceSettingsSchema.parse(await terminalSettingsService(c).get())),
);
workspaceRoutes.post(
  "/terminal/network-policy/preview",
  zValidator("json", PreviewTerminalNetworkPolicyRequestSchema),
  async (c) => c.json(TerminalNetworkPolicyPreviewSchema.parse(
    await terminalSettingsService(c).preview(c.req.valid("json")),
  )),
);
workspaceRoutes.post(
  "/terminal/network-policy/apply",
  zValidator("json", ApplyTerminalNetworkPolicyRequestSchema),
  async (c) => c.json(TerminalWorkspaceSettingsSchema.parse(
    await terminalSettingsService(c).apply(c.req.valid("json")),
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
