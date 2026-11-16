import { SharedCanvasesSettingSchema } from "@rally/contracts/canvas-share-federation";
import { Hono } from "hono";

import type { HonoAppEnv } from "../env";
import { getWorkspaceAuth } from "../middleware/auth";
import { zValidator } from "../middleware/validation";
import { readSharedCanvasesEnabled, setSharedCanvasesEnabled } from "../services/shared-canvases";

/**
 * Settings › Account › Preferences: whether Canvases shared with this person
 * as a guest elsewhere join every Organization's list. One switch for every
 * Organization in this deployment; a change queues a rebuild of all of them
 * before the answer. Members and guests alike, with a support session refused, since it
 * spans the person's other Organizations. `docs/canvas-share-federation.md`.
 */
export const sharedCanvasesRoutes = new Hono<HonoAppEnv>();
sharedCanvasesRoutes.get("/", async (c) =>
  c.json(SharedCanvasesSettingSchema.parse({ enabled: await readSharedCanvasesEnabled(c.env, getWorkspaceAuth(c).userId) })));
sharedCanvasesRoutes.put("/", zValidator("json", SharedCanvasesSettingSchema), async (c) => {
  const { userId, workspaceId } = getWorkspaceAuth(c);
  const { enabled } = c.req.valid("json");
  await setSharedCanvasesEnabled(c.env, workspaceId, userId, enabled);
  return c.json(SharedCanvasesSettingSchema.parse({ enabled }));
});
