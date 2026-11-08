import { Hono } from "hono";
import { z } from "zod";

import { IdSchema, UserIdSchema } from "@rally/contracts";
import {
  CanvasAccessDecisionRequestSchema,
  CanvasAccessDecisionSchema,
  CanvasAccessRequestResultSchema,
  CanvasAccessRequestSchema,
  CanvasAccessSchema,
  CanvasAudienceUpdateSchema,
  CanvasDetailSchema,
  CanvasRenameRequestSchema,
  CreateCanvasRequestSchema,
  CreatedCanvasSchema,
  SidebarPinRequestSchema,
} from "@rally/contracts/canvases";

import type { HonoAppEnv } from "../env";
import { getWorkspaceAuth, requireWorkspaceAuth } from "../middleware/auth";
import { namedZValidator, zValidator } from "../middleware/validation";
import { CanvasService } from "../services/canvas-service";

const idParam = z.object({ id: IdSchema });
/** A malformed Canvas id is refused by name (`canvas_id_invalid:id:…`), a well-formed missing one is `canvas_not_found`. */
const canvasIdParam = namedZValidator("canvas_id", "This is not a Canvas id")("param", idParam);
const requesterParam = namedZValidator("canvas_id", "This is not a Canvas id or a person's id")("param",
  z.object({ id: IdSchema, userId: UserIdSchema }));

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
canvasRoutes.get("/:id", canvasIdParam, async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(CanvasDetailSchema.parse(await new CanvasService(c.env, getWorkspaceAuth(c)).detail(c.req.valid("param").id)));
});
canvasRoutes.patch("/:id", canvasIdParam, namedZValidator("canvas_rename",
  "A Canvas title needs 1 to 300 characters other than spaces at either end")("json", CanvasRenameRequestSchema), async (c) =>
  c.json(CanvasDetailSchema.parse(await new CanvasService(c.env, getWorkspaceAuth(c))
    .rename(c.req.valid("param").id, c.req.valid("json").title))));
canvasRoutes.post("/:id/audience", canvasIdParam, zValidator("json", CanvasAudienceUpdateSchema), async (c) =>
  c.json(CanvasDetailSchema.parse(await new CanvasService(c.env, getWorkspaceAuth(c))
    .setAudience(c.req.valid("param").id, c.req.valid("json")))));
canvasRoutes.post("/:id/pin", canvasIdParam, zValidator("json", SidebarPinRequestSchema), async (c) => {
  await new CanvasService(c.env, getWorkspaceAuth(c)).pin("canvas", c.req.valid("param").id, c.req.valid("json").pinned);
  return c.body(null, 204);
});
// A member who cannot open a Canvas: whether they may ask, asking, and a
// decider's answer. `docs/canvas-access-requests.md`.
canvasRoutes.get("/:id/access", canvasIdParam, async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(CanvasAccessSchema.parse(await new CanvasService(c.env, getWorkspaceAuth(c)).access(c.req.valid("param").id)));
});
canvasRoutes.post("/:id/access-requests", canvasIdParam, namedZValidator("canvas_access_request",
  "An access request carries at most a message")("json", CanvasAccessRequestSchema), async (c) =>
  c.json(CanvasAccessRequestResultSchema.parse(await new CanvasService(c.env, getWorkspaceAuth(c))
    .requestAccess(c.req.valid("param").id, c.req.valid("json")))));
canvasRoutes.post("/:id/access-requests/:userId/decision", requesterParam, namedZValidator("canvas_access_decision",
  "A decision is approve or deny")("json", CanvasAccessDecisionRequestSchema), async (c) => {
  const { id, userId } = c.req.valid("param");
  return c.json(CanvasAccessDecisionSchema.parse(await new CanvasService(c.env, getWorkspaceAuth(c))
    .decideAccess(id, userId, c.req.valid("json").decision)));
});
