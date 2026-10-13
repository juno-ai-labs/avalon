import {
  AcknowledgeChannelReadRequestSchema,
  ChannelFeedPageSchema,
  ChannelStatsSchema,
  CreateSpaceRequestSchema,
  MoveChannelBetweenSpacesRequestSchema,
  MoveChannelBetweenSpacesResultSchema,
  SpaceChannelPageSchema,
  SpaceDefaultKindSchema,
  SpaceIdSchema,
  SpaceInviteesSchema,
  SpaceSummarySchema,
  UpdateSpaceAudienceRequestSchema,
  UpdateSpacePresentationRequestSchema,
  WorkstreamIdSchema,
  IdSchema,
} from "@rally/contracts";
import { Hono } from "hono";
import { z } from "zod";

import type { HonoAppEnv } from "../env";
import { requestDeferral } from "../lib/defer";
import { getAuth, getWorkspaceAuth, requireWorkspaceAuth } from "../middleware/auth";
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
    await new SpaceService(c.env, getAuth(c)).create(
      c.req.valid("json"),
      undefined,
      requestDeferral(c),
    ),
  ), 201),
);

/**
 * A Space's reads, for a member or a guest: WorkspaceDO lists what this
 * person may see by the listing rules (`docs/listing-rules.md`). Mounted ahead
 * of the member-only writes below.
 */
export const spaceReadRoutes = new Hono<HonoAppEnv>();

spaceReadRoutes.get(
  "/:id/channels",
  requireWorkspaceAuth,
  zValidator("param", idParam),
  zValidator("query", channelPageQuery),
  async (c) => c.json(SpaceChannelPageSchema.parse(
    await new SpaceService(c.env, getWorkspaceAuth(c)).listChannels(
      c.req.valid("param").id,
      c.req.valid("query").cursor ?? null,
    ),
  )),
);

/** A Channel's feed: the threads placed in it, newest first; see `ChannelFeedItemSchema`. */
spaceReadRoutes.get(
  "/:id/feed",
  requireWorkspaceAuth,
  zValidator("param", idParam),
  zValidator("query", channelPageQuery),
  async (c) => c.json(ChannelFeedPageSchema.parse(
    await new SpaceService(c.env, getWorkspaceAuth(c)).listFeed(
      c.req.valid("param").id,
      c.req.valid("query").cursor ?? null,
    ),
  )),
);

/**
 * A Channel's read position for the person asking: acknowledge through a
 * placement, answered with the person's `ChannelStats` row. A read route,
 * because reading is not changing the Channel: anybody who may list it has a
 * position in it.
 */
spaceReadRoutes.patch(
  "/:id/read-state",
  requireWorkspaceAuth,
  zValidator("param", idParam),
  zValidator("json", AcknowledgeChannelReadRequestSchema),
  async (c) => c.json(ChannelStatsSchema.parse(
    await new SpaceService(c.env, getWorkspaceAuth(c)).acknowledgeRead(
      c.req.valid("param").id,
      c.req.valid("json"),
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
  async (c) => {
    const space = await new SpaceService(c.env, getAuth(c)).updateAudience(
      c.req.valid("param").id,
      c.req.valid("json"),
    );
    // The caller left a private Channel: it is not theirs to be described.
    return space === null ? c.body(null, 204) : c.json(SpaceSummarySchema.parse(space));
  },
);

/** The Organization invitees a Space lists; see `SpaceInviteesSchema` for why this is not on the summary. */
spaceRoutes.get(
  "/:id/invitees",
  zValidator("param", idParam),
  async (c) => c.json(SpaceInviteesSchema.parse({
    items: (await new SpaceService(c.env, getAuth(c)).invitees(c.req.valid("param").id)).map((email) => ({ email })),
  })),
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

spaceRoutes.post(
  "/:id/channels/:workstreamId/move",
  zValidator("param", channelParam),
  zValidator("json", MoveChannelBetweenSpacesRequestSchema),
  async (c) => c.json(MoveChannelBetweenSpacesResultSchema.parse(
    await new SpaceService(c.env, getAuth(c)).moveChannel(
      c.req.valid("json").sourceSpaceId,
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
