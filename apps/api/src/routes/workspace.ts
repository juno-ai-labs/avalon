import { Hono } from "hono";
import { zValidator } from "../middleware/validation";
import {
  AcceptWorkspaceInvitationRequestSchema,
  CreateWorkspaceInvitationRequestSchema,
  IdSchema,
  OnboardingStepIdSchema,
  UpdateOnboardingChecklistRequestSchema,
  UpdateOnboardingStepRequestSchema,
  UpdateUserTimezoneRequestSchema,
  UpdateWorkspaceRequestSchema,
} from "@avalon/contracts";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { getAuth } from "../middleware/auth";
import { OnboardingChecklistService } from "../services/onboarding-checklist-service";
import { WorkspaceService } from "../services/workspace-service";

const invitationParam = z.object({ id: IdSchema });
const onboardingStepParam = z.object({ stepId: OnboardingStepIdSchema });

export const workspaceRoutes = new Hono<HonoAppEnv>();

workspaceRoutes.get("/", async (c) => c.json(await new WorkspaceService(c.env, getAuth(c)).getWorkspace()));
workspaceRoutes.patch("/", zValidator("json", UpdateWorkspaceRequestSchema), async (c) =>
  c.json(await new WorkspaceService(c.env, getAuth(c)).updateWorkspace(c.req.valid("json"))),
);
workspaceRoutes.patch("/me", zValidator("json", UpdateUserTimezoneRequestSchema), async (c) =>
  c.json(await new WorkspaceService(c.env, getAuth(c)).updateMyTimezone(c.req.valid("json").timezone)),
);
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

// Post-organization onboarding. The checklist is derived from the server-side
// catalog, so clients never enumerate steps themselves.
workspaceRoutes.get("/onboarding", async (c) =>
  c.json(await new OnboardingChecklistService(c.env, getAuth(c)).state()),
);
workspaceRoutes.patch("/onboarding", zValidator("json", UpdateOnboardingChecklistRequestSchema), async (c) =>
  c.json(await new OnboardingChecklistService(c.env, getAuth(c)).updateChecklist(c.req.valid("json"))),
);
workspaceRoutes.put(
  "/onboarding/steps/:stepId",
  zValidator("param", onboardingStepParam),
  zValidator("json", UpdateOnboardingStepRequestSchema),
  async (c) =>
    c.json(await new OnboardingChecklistService(c.env, getAuth(c))
      .setStepState(c.req.valid("param").stepId, c.req.valid("json").state)),
);
