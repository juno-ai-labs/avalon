import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  AcceptWorkspaceInvitationRequestSchema,
  CreateWorkspaceInvitationRequestSchema,
  IdSchema,
} from "@avalon/contracts";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { getAuth } from "../middleware/auth";
import { WorkspaceService } from "../services/workspace-service";

const invitationParam = z.object({ id: IdSchema });

export const workspaceRoutes = new Hono<HonoAppEnv>();

workspaceRoutes.get("/", async (c) => c.json(await new WorkspaceService(c.env, getAuth(c)).getWorkspace()));
workspaceRoutes.get("/members", async (c) =>
  c.json({ items: await new WorkspaceService(c.env, getAuth(c)).listMembers() }),
);
workspaceRoutes.get("/invitations", async (c) =>
  c.json({ items: await new WorkspaceService(c.env, getAuth(c)).listInvitations() }),
);
workspaceRoutes.post("/invitations", zValidator("json", CreateWorkspaceInvitationRequestSchema), async (c) => {
  const body = c.req.valid("json");
  return c.json(await new WorkspaceService(c.env, getAuth(c)).createInvitation(body.email, body.role), 201);
});
workspaceRoutes.delete("/invitations/:id", zValidator("param", invitationParam), async (c) => {
  await new WorkspaceService(c.env, getAuth(c)).revokeInvitation(c.req.valid("param").id);
  return c.body(null, 204);
});
workspaceRoutes.post("/invitations/accept", zValidator("json", AcceptWorkspaceInvitationRequestSchema), async (c) => {
  await new WorkspaceService(c.env, getAuth(c)).acceptInvitation(c.req.valid("json").token);
  return c.body(null, 204);
});
