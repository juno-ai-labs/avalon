import {
  ActivityFilterSchema,
  ActivityPageSchema,
  ActivityEventsRequestSchema,
  ActivitySeenRequestSchema,
  ArtifactPinListSchema,
  ArtifactPinOrderRequestSchema,
  ArtifactPinRequestSchema,
  ChannelStatsListSchema,
  IdSchema,
  MyThreadsPageSchema,
  PinKindSchema,
  PinListSchema,
  PinOrderRequestSchema,
  PinRequestSchema,
} from "@rally/contracts";
import { Hono } from "hono";
import { z } from "zod";

import { clientReadsNewMessages, clientReadsArtifactUpdates, clientReadsChannelMerges, clientReadsPrivateChannelMerges } from "../lib/client-contract";
import type { HonoAppEnv } from "../env";
import { getWorkspaceAuth, requireWorkspaceAuth } from "../middleware/auth";
import { zValidator } from "../middleware/validation";
import { SpaceService } from "../services/space-service";

const pageQuery = z.strictObject({ cursor: z.string().min(1).max(200).optional() });
const activityQuery = pageQuery.extend({ only: ActivityFilterSchema.optional() });
const pinParam = z.strictObject({ kind: PinKindSchema, id: IdSchema });
const artifactPinParam = z.strictObject({ id: IdSchema });

/**
 * The person's own navigation: the threads and breakouts they take part in,
 * and what they pinned. Members and guests alike, because each answers only
 * for what this person may already list. See
 * `docs/PRDs/2026-10-10_channels-threads-navigation/prd.md`.
 */
export const navigationRoutes = new Hono<HonoAppEnv>();

navigationRoutes.use("*", requireWorkspaceAuth);

navigationRoutes.get("/threads", zValidator("query", pageQuery), async (c) =>
  c.json(MyThreadsPageSchema.parse(
    await new SpaceService(c.env, getWorkspaceAuth(c)).listMyThreads(c.req.valid("query").cursor ?? null),
  )),
);

navigationRoutes.get("/channel-stats", async (c) =>
  c.json(ChannelStatsListSchema.parse(await new SpaceService(c.env, getWorkspaceAuth(c)).listChannelStats())),
);

navigationRoutes.get("/pins", async (c) =>
  c.json(PinListSchema.parse(await new SpaceService(c.env, getWorkspaceAuth(c)).listPins())),
);

navigationRoutes.put("/pins", zValidator("json", PinOrderRequestSchema), async (c) =>
  c.json(PinListSchema.parse(
    await new SpaceService(c.env, getWorkspaceAuth(c)).reorderPins(c.req.valid("json").kind, c.req.valid("json").ids),
  )),
);

navigationRoutes.put("/pins/:kind/:id", zValidator("param", pinParam), zValidator("json", PinRequestSchema), async (c) => {
  const { kind, id } = c.req.valid("param");
  return c.json(PinListSchema.parse(
    await new SpaceService(c.env, getWorkspaceAuth(c)).changePin(kind, id, c.req.valid("json").parentId ?? null, true),
  ));
});

navigationRoutes.delete("/pins/:kind/:id", zValidator("param", pinParam), async (c) => {
  const { kind, id } = c.req.valid("param");
  return c.json(PinListSchema.parse(
    await new SpaceService(c.env, getWorkspaceAuth(c)).changePin(kind, id, null, false),
  ));
});

// Artifact pins have routes of their own because they have a list of their
// own; see `ArtifactPinSchema` and docs/workstream-pinning.md.
navigationRoutes.get("/artifact-pins", async (c) =>
  c.json(ArtifactPinListSchema.parse(await new SpaceService(c.env, getWorkspaceAuth(c)).listArtifactPins())),
);

navigationRoutes.put("/artifact-pins", zValidator("json", ArtifactPinOrderRequestSchema), async (c) =>
  c.json(ArtifactPinListSchema.parse(
    await new SpaceService(c.env, getWorkspaceAuth(c)).reorderArtifactPins(c.req.valid("json").ids),
  )),
);

navigationRoutes.put("/artifact-pins/:id", zValidator("param", artifactPinParam), zValidator("json", ArtifactPinRequestSchema), async (c) =>
  c.json(ArtifactPinListSchema.parse(
    await new SpaceService(c.env, getWorkspaceAuth(c)).changeArtifactPin(c.req.valid("param").id, c.req.valid("json").threadId, true),
  )),
);

navigationRoutes.delete("/artifact-pins/:id", zValidator("param", artifactPinParam), async (c) =>
  c.json(ArtifactPinListSchema.parse(
    await new SpaceService(c.env, getWorkspaceAuth(c)).changeArtifactPin(c.req.valid("param").id, null, false),
  )),
);

navigationRoutes.get("/activity", zValidator("query", activityQuery), async (c) => {
  const { cursor, only } = c.req.valid("query");
  const page = await new SpaceService(c.env, getWorkspaceAuth(c)).listActivity(cursor ?? null, only ?? null);
  // A build before merges, artifact pins or private merges parses each
  // strictly: it is served the page without those rows, whose cursor still
  // continues correctly.
  const header = (name: string) => c.req.header(name);
  const newMessages = clientReadsNewMessages(header);
  const merges = clientReadsChannelMerges(header);
  const artifactUpdates = clientReadsArtifactUpdates(header);
  const privateMerges = clientReadsPrivateChannelMerges(header);
  return c.json(ActivityPageSchema.parse(newMessages && merges && artifactUpdates && privateMerges ? page : {
    ...page,
    items: page.items.filter((item) => (merges || item.kind !== "merged")
      && (newMessages || item.kind !== "new_message")
      && (artifactUpdates || item.kind !== "artifact_updated")
      && (privateMerges || !item.mergedInto?.threadPrivate)),
  }));
});

navigationRoutes.post("/activity/events", zValidator("json", ActivityEventsRequestSchema), async (c) => {
  await new SpaceService(c.env, getWorkspaceAuth(c)).recordActivityEvents(c.req.valid("json").events);
  return c.body(null, 204);
});

navigationRoutes.put("/activity/seen", zValidator("json", ActivitySeenRequestSchema), async (c) => {
  await new SpaceService(c.env, getWorkspaceAuth(c)).markActivitySeen(Date.parse(c.req.valid("json").seenThrough));
  return c.body(null, 204);
});
