import { SharedCanvasesSettingSchema } from "@rally/contracts/canvas-share-federation";
import { Hono } from "hono";

import type { HonoAppEnv } from "../env";
import { requestDeferral } from "../lib/defer";
import { getWorkspaceAuth } from "../middleware/auth";
import { zValidator } from "../middleware/validation";
import { logWarn, diagnosticErrorCode } from "../observability/logger";
import {
  readSharedCanvasesEnabled,
  refreshSharedCanvasesEverywhere,
  writeSharedCanvasesEnabled,
} from "../services/shared-canvases";

/**
 * Settings › Account › Preferences: whether Canvases shared with this person
 * as a guest elsewhere join every Organization's list. One switch for every
 * Organization in this deployment; a change rebuilds all of them after the
 * answer. Members and guests alike, with a support session refused, since it
 * spans the person's other Organizations. `docs/canvas-share-federation.md`.
 */
export const sharedCanvasesRoutes = new Hono<HonoAppEnv>();
sharedCanvasesRoutes.get("/", async (c) =>
  c.json(SharedCanvasesSettingSchema.parse({ enabled: await readSharedCanvasesEnabled(c.env, getWorkspaceAuth(c).userId) })));
sharedCanvasesRoutes.put("/", zValidator("json", SharedCanvasesSettingSchema), async (c) => {
  const { userId } = getWorkspaceAuth(c);
  const { enabled } = c.req.valid("json");
  await writeSharedCanvasesEnabled(c.env, userId, enabled);
  requestDeferral(c)(refreshSharedCanvasesEverywhere(c.env, userId).catch((error: unknown) =>
    logWarn(c.env, "shared_canvases_refresh_failed", { user_id: userId, code: diagnosticErrorCode(error, "shared_canvases_refresh_failed") })));
  return c.json(SharedCanvasesSettingSchema.parse({ enabled }));
});
