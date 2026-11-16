import { SharedCanvasesSettingSchema } from "@rally/contracts/canvas-share-federation";
import { Hono } from "hono";

import type { HonoAppEnv } from "../env";
import { getWorkspaceAuth } from "../middleware/auth";
import { zValidator } from "../middleware/validation";
import {
  publishSharedCanvasesToOrganizations,
  readSharedCanvasesEnabled,
  writeSharedCanvasesEnabled,
} from "../services/canvas-share-inbox";

/**
 * Settings › Account › Preferences: whether Canvases shared with this person
 * in their other Organizations join every Organization's list. Stored on their
 * inbox, so one switch covers every Organization in this deployment; a change
 * is pushed to all of them, this one included. Members and guests alike, with
 * a support session refused, since it spans the person's other Organizations.
 * `docs/canvas-share-federation.md`.
 */
export const sharedCanvasesRoutes = new Hono<HonoAppEnv>();
sharedCanvasesRoutes.get("/", async (c) =>
  c.json(SharedCanvasesSettingSchema.parse({ enabled: await readSharedCanvasesEnabled(c.env, getWorkspaceAuth(c).userId) })));
sharedCanvasesRoutes.put("/", zValidator("json", SharedCanvasesSettingSchema), async (c) => {
  const { userId } = getWorkspaceAuth(c);
  const { enabled } = c.req.valid("json");
  await writeSharedCanvasesEnabled(c.env, userId, enabled);
  await publishSharedCanvasesToOrganizations(c.env, userId, null);
  return c.json(SharedCanvasesSettingSchema.parse({ enabled }));
});
