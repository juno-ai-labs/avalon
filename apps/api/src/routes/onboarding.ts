import { zValidator } from "@hono/zod-validator";
import {
  ActivateWorkspaceRequestSchema,
  CreateWorkspaceRequestSchema,
  IdSchema,
  OnboardingRegionRequestSchema,
} from "@avalon/contracts";
import { Hono } from "hono";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { getIdentityAuth } from "../middleware/auth";
import { PlatformOnboardingService } from "../services/platform-onboarding-service";

const invitationParam = z.object({ id: IdSchema });

export const onboardingRoutes = new Hono<HonoAppEnv>();

onboardingRoutes.get("/", async (c) =>
  c.json(await new PlatformOnboardingService(c.env, getIdentityAuth(c)).state()),
);

onboardingRoutes.post("/workspace", zValidator("json", CreateWorkspaceRequestSchema), async (c) => {
  const body = c.req.valid("json");
  return c.json(await new PlatformOnboardingService(c.env, getIdentityAuth(c))
    .createWorkspace(body.name, body.region), 201);
});

onboardingRoutes.post(
  "/workspace/activate",
  zValidator("json", ActivateWorkspaceRequestSchema),
  async (c) => {
    const body = c.req.valid("json");
    return c.json(await new PlatformOnboardingService(c.env, getIdentityAuth(c))
      .activate(body.region, body.workspaceId));
  },
);

onboardingRoutes.post(
  "/invitations/:id/accept",
  zValidator("param", invitationParam),
  zValidator("json", OnboardingRegionRequestSchema),
  async (c) => {
    return c.json(await new PlatformOnboardingService(c.env, getIdentityAuth(c))
      .acceptInvitation(c.req.valid("param").id, c.req.valid("json").region));
  },
);

onboardingRoutes.post(
  "/invitations/:id/decline",
  zValidator("param", invitationParam),
  zValidator("json", OnboardingRegionRequestSchema),
  async (c) => {
    await new PlatformOnboardingService(c.env, getIdentityAuth(c))
      .declineInvitation(c.req.valid("param").id, c.req.valid("json").region);
    return c.body(null, 204);
  },
);
