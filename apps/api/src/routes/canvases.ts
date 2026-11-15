import { Hono } from "hono";
import { z } from "zod";

import { IdSchema, UserIdSchema } from "@rally/contracts";
import {
  CanvasAccessDecisionRequestSchema,
  CanvasAccessDecisionSchema,
  CanvasAccessRequestResultSchema,
  CanvasAccessRequestSchema,
  DiscardCanvasRequestSchema,
  CanvasAccessSchema,
  CanvasAudienceUpdateSchema,
  CanvasDetailSchema,
  AddCanvasSidekickRequestSchema,
  AddedCanvasSidekickSchema,
  CanvasListSchema,
  CanvasPublishRequestSchema,
  CanvasPublishedArtifactSchema,
  CanvasUpdateRequestSchema,
  CreateCanvasRequestSchema,
  CreatedCanvasSchema,
  SidebarPinRequestSchema,
  SidebarPinOrderRequestSchema,
} from "@rally/contracts/canvases";

import type { HonoAppEnv } from "../env";
import { getRequestMembership, getWorkspaceAuth, requireWorkspaceAuth } from "../middleware/auth";
import { ApiError } from "../lib/api-error";
import { ResourceService } from "../services/resource-service";
import { namedZValidator, zValidator } from "../middleware/validation";
import { CanvasPublicationService } from "../services/canvas-publication-service";
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
// The reader's Canvas list, for a client that holds no workspace socket.
canvasRoutes.get("/", zValidator("query", z.object({ query: z.string().trim().min(1).optional() })), async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(CanvasListSchema.parse({ items: await new CanvasService(c.env, getWorkspaceAuth(c)).list(c.req.valid("query").query) }));
});
canvasRoutes.post("/", zValidator("json", CreateCanvasRequestSchema), async (c) =>
  c.json(CreatedCanvasSchema.parse(await new CanvasService(c.env, getWorkspaceAuth(c)).create(c.req.valid("json"))), 201));
// Guests can arrange the same personal pins they can create.
canvasRoutes.put("/pinned-order", namedZValidator("canvas_pin_order", "Canvas pin order must contain Canvas ids")(
  "json", SidebarPinOrderRequestSchema.pick({ itemIds: true })), async (c) => {
  await new CanvasService(c.env, getWorkspaceAuth(c)).reorderPins("canvas", c.req.valid("json").itemIds);
  return c.body(null, 204);
});
canvasRoutes.get("/:id", canvasIdParam, async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(CanvasDetailSchema.parse(await new CanvasService(c.env, getWorkspaceAuth(c)).detail(c.req.valid("param").id)));
});
// The title, the appearance, or both. The refusal keeps the rename's released
// label, which the desktop reads a title's issue from, and names the field it
// refused (`canvas_rename_invalid:appearance.icon:invalid_value`); its one
// sentence holds for a title, an appearance and a body that changes nothing.
canvasRoutes.patch("/:id", canvasIdParam, namedZValidator("canvas_rename",
  "A Canvas change needs a title of 1 to 300 characters other than spaces at either end, or an icon or colour from the catalog")("json", CanvasUpdateRequestSchema), async (c) =>
  c.json(CanvasDetailSchema.parse(await new CanvasService(c.env, getWorkspaceAuth(c))
    .update(c.req.valid("param").id, c.req.valid("json")))));
canvasRoutes.post("/:id/audience", canvasIdParam, zValidator("json", CanvasAudienceUpdateSchema), async (c) =>
  c.json(CanvasDetailSchema.parse(await new CanvasService(c.env, getWorkspaceAuth(c))
    .setAudience(c.req.valid("param").id, c.req.valid("json")))));
// Publish something made elsewhere as one of this Canvas's artifacts, as the
// person; the same name again is a new version. `docs/rally-mcp.md#publishing`.
canvasRoutes.post("/:id/artifacts", canvasIdParam, namedZValidator("canvas_publish",
  "A publish names a file or a static site, with a relative name and its content")("json", CanvasPublishRequestSchema), async (c) => {
  const published = await new CanvasPublicationService(c.env, getWorkspaceAuth(c))
    .publish(c.req.valid("param").id, c.req.valid("json"), c.req.raw.signal);
  return c.json(CanvasPublishedArtifactSchema.parse(published), published.outcome === "created" ? 201 : 200);
});
/**
 * One version of one of this Canvas's artifacts, as `GET /resources/:id/versions/:version/content`
 * (or `model-content`) answers it, for a reader who may open the Canvas. An
 * MCP client reads artifacts here rather than through `/resources`, so its
 * token reaches only what a Canvas holds (`docs/rally-mcp.md`).
 */
canvasRoutes.get("/:id/artifacts/:resourceId/versions/:version/:representation", namedZValidator("canvas_artifact", "This is not a Canvas artifact version")("param",
  z.object({ id: IdSchema, resourceId: IdSchema, version: z.coerce.number().int().positive(), representation: z.enum(["content", "model-content"]) })), async (c) => {
  const param = c.req.valid("param");
  const auth = getWorkspaceAuth(c);
  const canvas = await new CanvasService(c.env, auth).detail(param.id);
  const artifact = canvas.artifacts.find((candidate) => candidate.resourceId === param.resourceId);
  if (!artifact) throw new ApiError(404, "canvas_artifact_not_found", "That is not one of this Canvas's artifacts");
  const resources = new ResourceService(c.env, auth, undefined, getRequestMembership(c));
  if (param.representation === "content") return resources.versionContent(param.resourceId, param.version, "original");
  try {
    return await resources.versionContent(param.resourceId, param.version, "model");
  } catch (error) {
    // A published file's text is extracted when someone first reads it, not
    // when it lands, so the current version's first read prepares it here
    // (the app's preview does the same). An older version keeps its answer.
    if (!(error instanceof ApiError) || error.code !== "resource_version_content_unavailable" || param.version !== artifact.version) throw error;
    return resources.preview(param.resourceId, c.req.raw.signal);
  }
});
// A Sidekick for this Canvas, made by a client that is not the Canvas's Chat.
canvasRoutes.post("/:id/sidekicks", canvasIdParam, namedZValidator("canvas_sidekick",
  "A Sidekick for a Canvas needs instructions with text and a clientMessageId")("json", AddCanvasSidekickRequestSchema), async (c) =>
  c.json(AddedCanvasSidekickSchema.parse(await new CanvasService(c.env, getWorkspaceAuth(c))
    .addSidekick(c.req.valid("param").id, c.req.valid("json"))), 201));
canvasRoutes.post("/:id/pin", canvasIdParam, zValidator("json", SidebarPinRequestSchema), async (c) => {
  await new CanvasService(c.env, getWorkspaceAuth(c)).pin("canvas", c.req.valid("param").id, c.req.valid("json").pinned);
  return c.body(null, 204);
});
// Join the participant list of a Canvas the person may already open.
canvasRoutes.post("/:id/join", canvasIdParam, async (c) =>
  c.json(CanvasDetailSchema.parse(await new CanvasService(c.env, getWorkspaceAuth(c)).join(c.req.valid("param").id))));
canvasRoutes.post("/:id/archive", canvasIdParam, async (c) => {
  await new CanvasService(c.env, getWorkspaceAuth(c)).archive(c.req.valid("param").id);
  return c.body(null, 204);
});

// See `CanvasService.discardIfBlank`.
canvasRoutes.post("/:id/discard", canvasIdParam, namedZValidator("canvas_discard",
  "A discard names at most the leaving socket's ticket")("json", DiscardCanvasRequestSchema), async (c) => {
  await new CanvasService(c.env, getWorkspaceAuth(c)).discardIfBlank(c.req.valid("param").id, c.req.valid("json").leavingTicketId);
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
canvasRoutes.post("/:id/access-requests/:userId/decision", canvasIdParam, requesterParam, namedZValidator("canvas_access_decision",
  "A decision is approve or deny")("json", CanvasAccessDecisionRequestSchema), async (c) => {
  // Each validator checks its own part of the path; the Canvas id was checked by the first.
  const id = c.req.param("id");
  const { userId } = c.req.valid("param");
  return c.json(CanvasAccessDecisionSchema.parse(await new CanvasService(c.env, getWorkspaceAuth(c))
    .decideAccess(id, userId, c.req.valid("json").decision)));
});
