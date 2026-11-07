import { Hono } from "hono";
import { z } from "zod";

import { IdSchema } from "@rally/contracts";
import {
  CanvasAudienceUpdateSchema,
  CanvasDetailSchema,
  CanvasRenameRequestSchema,
  CreateCanvasRequestSchema,
  CreatedCanvasSchema,
  SidebarPinRequestSchema,
} from "@rally/contracts/canvases";

import type { HonoAppEnv } from "../env";
import { getWorkspaceAuth, requireWorkspaceAuth } from "../middleware/auth";
import { zValidator } from "../middleware/validation";
import { CanvasService } from "../services/canvas-service";

const idParam = z.object({ id: IdSchema });

/**
 * A Canvas: create one (with no artifacts, and optionally its first prompt),
 * read what its reader sees, retitle it, change who can open it, and pin it.
 * `docs/canvases.md`. Its Chat is an ordinary conversation, opened through
 * `/conversations/:canvasId`.
 */
export const canvasRoutes = new Hono<HonoAppEnv>();
canvasRoutes.use("*", requireWorkspaceAuth);
canvasRoutes.post("/", zValidator("json", CreateCanvasRequestSchema), async (c) =>
  c.json(CreatedCanvasSchema.parse(await new CanvasService(c.env, getWorkspaceAuth(c)).create(c.req.valid("json"))), 201));
canvasRoutes.get("/:id", zValidator("param", idParam), async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(CanvasDetailSchema.parse(await new CanvasService(c.env, getWorkspaceAuth(c)).detail(c.req.valid("param").id)));
});
canvasRoutes.patch("/:id", zValidator("param", idParam), zValidator("json", CanvasRenameRequestSchema), async (c) =>
  c.json(CanvasDetailSchema.parse(await new CanvasService(c.env, getWorkspaceAuth(c))
    .rename(c.req.valid("param").id, c.req.valid("json").title))));
canvasRoutes.post("/:id/audience", zValidator("param", idParam), zValidator("json", CanvasAudienceUpdateSchema), async (c) =>
  c.json(CanvasDetailSchema.parse(await new CanvasService(c.env, getWorkspaceAuth(c))
    .setAudience(c.req.valid("param").id, c.req.valid("json")))));
canvasRoutes.post("/:id/pin", zValidator("param", idParam), zValidator("json", SidebarPinRequestSchema), async (c) => {
  await new CanvasService(c.env, getWorkspaceAuth(c)).pin("canvas", c.req.valid("param").id, c.req.valid("json").pinned);
  return c.body(null, 204);
});
