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
  CanvasUpdateRequestSchema,
  CreateCanvasRequestSchema,
  CreatedCanvasSchema,
  SidebarPinRequestSchema,
} from "@rally/contracts/canvases";

import type { HonoAppEnv } from "../env";
import { clientReadsAccessDenials } from "../lib/client-contract";
import { getWorkspaceAuth, requireWorkspaceAuth } from "../middleware/auth";
import { namedZValidator, zValidator } from "../middleware/validation";
import { CanvasService } from "../services/canvas-service";

const idParam = z.object({ id: IdSchema });
/** A malformed Canvas id is refused by name (`canvas_id_invalid:id:…`), a well-formed missing one is `canvas_not_found`. */
const canvasIdParam = namedZValidator("canvas_id", "This is not a Canvas id")("param", idParam);
/** The person a decision is about, refused under its own label (`canvas_access_requester:userId:…`). */
const requesterParam = namedZValidator("canvas_access_requester", "This is not a person's id")("param",
  z.object({ userId: UserIdSchema }));

/**
 * A Canvas: create one (with no artifacts, and optionally its first prompt),
 * read what its reader sees, retitle it or choose its icon and colour, change
 * who can open it, and pin it.
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
// The title, the appearance, or both. The refusal keeps the rename's released
// label and sentence, so a client that only renames reads it as it always has:
// only a typed title can be refused for a reason a person fixes, and the
// appearance picker sends catalog keys alone. An appearance refusal still names
// its field (`canvas_rename_invalid:appearance.icon:invalid_value`).
canvasRoutes.patch("/:id", canvasIdParam, namedZValidator("canvas_rename",
  "A Canvas title needs 1 to 300 characters other than spaces at either end")("json", CanvasUpdateRequestSchema), async (c) =>
  c.json(CanvasDetailSchema.parse(await new CanvasService(c.env, getWorkspaceAuth(c))
    .update(c.req.valid("param").id, c.req.valid("json")))));
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
  const access = CanvasAccessSchema.parse(await new CanvasService(c.env, getWorkspaceAuth(c)).access(c.req.valid("param").id));
  // A build before the denial contract parses `request` strictly: it is
  // served the request without `decidedAt`, as before the field existed.
  const served = access.request && !clientReadsAccessDenials((name) => c.req.header(name))
    ? { ...access, request: { state: access.request.state, requestedAt: access.request.requestedAt } }
    : access;
  return c.json(CanvasAccessSchema.parse(served));
});
canvasRoutes.post("/:id/access-requests", canvasIdParam, namedZValidator("canvas_access_request",
  "An access request carries at most a message")("json", CanvasAccessRequestSchema), async (c) =>
  c.json(CanvasAccessRequestResultSchema.parse(await new CanvasService(c.env, getWorkspaceAuth(c))
    .requestAccess(c.req.valid("param").id, c.req.valid("json")))));
canvasRoutes.post("/:id/access-requests/:userId/decision", canvasIdParam, requesterParam, namedZValidator("canvas_access_decision",
  "A decision is approve or deny")("json", CanvasAccessDecisionRequestSchema), async (c) => {
  // Each validator checks its own part of the path; the Canvas id was checked by the first.
  const id = c.req.param("id");
  const { userId } = c.req.valid("param");
  return c.json(CanvasAccessDecisionSchema.parse(await new CanvasService(c.env, getWorkspaceAuth(c))
    .decideAccess(id, userId, c.req.valid("json").decision)));
});
