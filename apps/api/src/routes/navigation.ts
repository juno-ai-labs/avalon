import { ArtifactPinListSchema } from "@rally/contracts";
import { Hono } from "hono";

import type { HonoAppEnv } from "../env";
import { requireWorkspaceAuth } from "../middleware/auth";

/**
 * The person's own artifact pins, which a detached artifact window reads to
 * show its pin state. An artifact pin named the Thread whose Main generated
 * it, and was listed only while that Main could be opened; every Thread is
 * retired (`docs/PRDs/2026-11-06_canvases-and-sidekicks/plan.md` step C-2), so
 * no stored pin can be listed and the answer is empty. The route stays until
 * the desktop's detached window stops reading it (plan step B-8).
 */
export const navigationRoutes = new Hono<HonoAppEnv>();

navigationRoutes.use("*", requireWorkspaceAuth);

navigationRoutes.get("/artifact-pins", (c) => c.json(ArtifactPinListSchema.parse([])));
