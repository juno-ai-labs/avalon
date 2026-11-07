import { ArtifactPinListSchema } from "@rally/contracts";
import { Hono } from "hono";

import type { HonoAppEnv } from "../env";
import { getWorkspaceAuth, requireWorkspaceAuth } from "../middleware/auth";
import { SpaceService } from "../services/space-service";

/**
 * The person's own artifact pins, which a detached artifact window reads to
 * show its pin state. Members and guests alike, because it answers only for
 * what this person pinned. The Thread, Channel and Activity reads that lived
 * here went with them (`docs/PRDs/2026-11-06_canvases-and-sidekicks/plan.md`
 * step C-1).
 */
export const navigationRoutes = new Hono<HonoAppEnv>();

navigationRoutes.use("*", requireWorkspaceAuth);

navigationRoutes.get("/artifact-pins", async (c) =>
  c.json(ArtifactPinListSchema.parse(await new SpaceService(c.env, getWorkspaceAuth(c)).listArtifactPins())),
);
