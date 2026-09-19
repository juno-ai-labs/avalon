import {
  CreateSpaceRequestSchema,
  ReorderSpacesRequestSchema,
  SpaceChannelPageSchema,
  SpaceDirectorySchema,
  SpaceIdSchema,
  SpaceSummarySchema,
  UpdateSpaceAudienceRequestSchema,
  UpdateSpacePresentationRequestSchema,
  WorkstreamIdSchema,
  IdSchema,
} from "@rally/contracts";
import { Hono } from "hono";
import { z } from "zod";

import { SpaceDefaultKindSchema } from "../durable-objects/workspace-space-protocol";
import type { HonoAppEnv } from "../env";
import { getAuth } from "../middleware/auth";
import { zValidator } from "../middleware/validation";
import { SpaceService } from "../services/space-service";

const idParam = z.strictObject({ id: SpaceIdSchema });
const channelParam = z.strictObject({ id: SpaceIdSchema, workstreamId: WorkstreamIdSchema });
const channelBody = z.strictObject({ workstreamId: WorkstreamIdSchema });
const defaultParam = z.strictObject({
  id: SpaceIdSchema,
  kind: SpaceDefaultKindSchema,
  targetId: IdSchema,
});
const defaultBody = z.strictObject({ kind: SpaceDefaultKindSchema, targetId: IdSchema });
const channelPageQuery = z.strictObject({ cursor: z.string().min(1).max(200).optional() });

/**
 * The Organization's Space surface.
 *
 * Mutations only, plus the two paginated reads. Space *state* comes down the
 * workspace socket — the connect payload carries both directories and every
 * write republishes them — so there is deliberately no `GET /spaces`: a client
 * that fetched one would hold a second answer to a question the socket already
 * answers, and the two would disagree across a mutation.
 */
export const spaceRoutes = new Hono<HonoAppEnv>();

spaceRoutes.post("/", zValidator("json", CreateSpaceRequestSchema), async (c) =>
  c.json(SpaceSummarySchema.parse(
    await new SpaceService(c.env, getAuth(c)).create(c.req.valid("json")),
  ), 201),
);

spaceRoutes.put("/order", zValidator("json", ReorderSpacesRequestSchema), async (c) =>
  c.json(SpaceDirectorySchema.parse(
    await new SpaceService(c.env, getAuth(c)).reorder(c.req.valid("json")),
  )),
);

spaceRoutes.get(
  "/:id/channels",
  zValidator("param", idParam),
  zValidator("query", channelPageQuery),
  async (c) => c.json(SpaceChannelPageSchema.parse(
    await new SpaceService(c.env, getAuth(c)).listChannels(
      c.req.valid("param").id,
      c.req.valid("query").cursor ?? null,
    ),
  )),
);

spaceRoutes.patch(
  "/:id",
  zValidator("param", idParam),
  zValidator("json", UpdateSpacePresentationRequestSchema),
  async (c) => c.json(SpaceSummarySchema.parse(
    await new SpaceService(c.env, getAuth(c)).updatePresentation(
      c.req.valid("param").id,
      c.req.valid("json"),
    ),
  )),
);

spaceRoutes.patch(
  "/:id/audience",
  zValidator("param", idParam),
  zValidator("json", UpdateSpaceAudienceRequestSchema),
  async (c) => c.json(SpaceSummarySchema.parse(
    await new SpaceService(c.env, getAuth(c)).updateAudience(
      c.req.valid("param").id,
      c.req.valid("json"),
    ),
  )),
);

spaceRoutes.post(
  "/:id/archive",
  zValidator("param", idParam),
  async (c) => c.json(SpaceSummarySchema.parse(
    await new SpaceService(c.env, getAuth(c)).archive(c.req.valid("param").id),
  )),
);

spaceRoutes.post(
  "/:id/restore",
  zValidator("param", idParam),
  async (c) => c.json(SpaceSummarySchema.parse(
    await new SpaceService(c.env, getAuth(c)).restore(c.req.valid("param").id),
  )),
);

spaceRoutes.post(
  "/:id/channels",
  zValidator("param", idParam),
  zValidator("json", channelBody),
  async (c) => c.json(SpaceSummarySchema.parse(
    await new SpaceService(c.env, getAuth(c)).addChannel(
      c.req.valid("param").id,
      c.req.valid("json").workstreamId,
    ),
  )),
);

spaceRoutes.delete(
  "/:id/channels/:workstreamId",
  zValidator("param", channelParam),
  async (c) => c.json(SpaceSummarySchema.parse(
    await new SpaceService(c.env, getAuth(c)).removeChannel(
      c.req.valid("param").id,
      c.req.valid("param").workstreamId,
    ),
  )),
);

// One route per kind would be two routes that differ in a literal. The kind is
// what the registry, the delivery target and the Queue message all carry, so it
// is what the route carries too.
spaceRoutes.post(
  "/:id/defaults",
  zValidator("param", idParam),
  zValidator("json", defaultBody),
  async (c) => c.json(SpaceSummarySchema.parse(
    await new SpaceService(c.env, getAuth(c)).addDefault(
      c.req.valid("param").id,
      c.req.valid("json").kind,
      c.req.valid("json").targetId,
    ),
  )),
);

spaceRoutes.delete(
  "/:id/defaults/:kind/:targetId",
  zValidator("param", defaultParam),
  async (c) => c.json(SpaceSummarySchema.parse(
    await new SpaceService(c.env, getAuth(c)).removeDefault(
      c.req.valid("param").id,
      c.req.valid("param").kind,
      c.req.valid("param").targetId,
    ),
  )),
);
