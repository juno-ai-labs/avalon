import {
  ActivityFilterSchema,
  ActivityPageSchema,
  ActivityEventsRequestSchema,
  ActivitySeenRequestSchema,
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

import type { HonoAppEnv } from "../env";
import { getWorkspaceAuth, requireWorkspaceAuth } from "../middleware/auth";
import { zValidator } from "../middleware/validation";
import { SpaceService } from "../services/space-service";

const pageQuery = z.strictObject({ cursor: z.string().min(1).max(200).optional() });
const activityQuery = pageQuery.extend({ only: ActivityFilterSchema.optional() });
const pinParam = z.strictObject({ kind: PinKindSchema, id: IdSchema });

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

navigationRoutes.get("/activity", zValidator("query", activityQuery), async (c) => {
  const { cursor, only } = c.req.valid("query");
  return c.json(ActivityPageSchema.parse(
    await new SpaceService(c.env, getWorkspaceAuth(c)).listActivity(cursor ?? null, only ?? null),
  ));
});

navigationRoutes.post("/activity/events", zValidator("json", ActivityEventsRequestSchema), async (c) => {
  await new SpaceService(c.env, getWorkspaceAuth(c)).recordActivityEvents(c.req.valid("json").events);
  return c.body(null, 204);
});

navigationRoutes.put("/activity/seen", zValidator("json", ActivitySeenRequestSchema), async (c) => {
  await new SpaceService(c.env, getWorkspaceAuth(c)).markActivitySeen(Date.parse(c.req.valid("json").seenThrough));
  return c.body(null, 204);
});
