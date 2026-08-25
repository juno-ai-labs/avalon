import { Hono, type Context } from "hono";
import { zValidator } from "../middleware/validation";
import {
  AcceptWorkspaceInvitationRequestSchema,
  CreateWorkspaceInvitationRequestSchema,
  IdSchema,
  CreateWorkspaceInvitationResponseSchema,
  UpdateUserTimezoneRequestSchema,
  UpdateWorkspaceRequestSchema,
  WorkspaceInvitationSchema,
  WorkspaceMemberSchema,
  WorkspaceSchema,
  TerminalWorkspaceSettingsSchema,
  TerminalNetworkPolicyPreviewSchema,
  PreviewTerminalNetworkPolicyRequestSchema,
  ApplyTerminalNetworkPolicyRequestSchema,
} from "@rally/contracts";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { getAuth } from "../middleware/auth";
import { WorkspaceService } from "../services/workspace-service";
import { parseTerminalRegionConfiguration } from "../services/terminal/contract";
import { createDaytonaTerminalProvider } from "../services/terminal/daytona-provider";
import { TerminalSettingsService } from "../services/terminal/settings";
import { issueWorkspaceSocketTicket } from "../services/socket-service";

const invitationParam = z.object({ id: IdSchema });
const MemberPageSchema = z.object({ items: z.array(WorkspaceMemberSchema) });
const InvitationPageSchema = z.object({ items: z.array(WorkspaceInvitationSchema) });
const SocketTicketSchema = z.object({ url: z.string().min(1), ticket: z.string().min(1) });

export const workspaceRoutes = new Hono<HonoAppEnv>();

function terminalSettingsService(c: Context<HonoAppEnv>): TerminalSettingsService {
  const configuration = parseTerminalRegionConfiguration(c.env);
  const provider = configuration.capability === "supported"
    ? createDaytonaTerminalProvider(configuration)
    : null;
  return new TerminalSettingsService(c.env, getAuth(c), provider);
}

workspaceRoutes.get("/", async (c) =>
  c.json(WorkspaceSchema.parse(await new WorkspaceService(c.env, getAuth(c)).getWorkspace())));
workspaceRoutes.get("/socket", async (c) => {
  const auth = getAuth(c);
  const ticket = await issueWorkspaceSocketTicket(c.env, auth);
  const url = new URL(c.env.PUBLIC_API_BASE_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/socket/workspaces/${auth.workspaceId}`;
  url.search = new URLSearchParams({ ticket }).toString();
  return c.json(SocketTicketSchema.parse({ url: url.toString(), ticket }));
});
workspaceRoutes.patch("/", zValidator("json", UpdateWorkspaceRequestSchema), async (c) =>
  c.json(WorkspaceSchema.parse(await new WorkspaceService(c.env, getAuth(c)).updateWorkspace(c.req.valid("json")))),
);
workspaceRoutes.patch("/me", zValidator("json", UpdateUserTimezoneRequestSchema), async (c) =>
  c.json(WorkspaceMemberSchema.parse(
    await new WorkspaceService(c.env, getAuth(c)).updateMyTimezone(c.req.valid("json").timezone))),
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
