import { RegisterPushDeviceRequestSchema, WebPushConfigurationSchema } from "@rally/contracts/push-notifications";
import { Hono } from "hono";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { ApiError } from "../lib/api-error";
import { getWorkspaceAuth, requireWorkspaceAuth } from "../middleware/auth";
import { zValidator } from "../middleware/validation";
import { registerPushDevice, deletePushDevice } from "../services/push-device-service";
import { webPushAvailable } from "../services/push/web-push-transport";

export const pushDeviceRoutes = new Hono<HonoAppEnv>();
pushDeviceRoutes.use("*", requireWorkspaceAuth);
const params = z.object({ installationId: z.string().uuid() });
/** The VAPID public key a browser subscribes with, or 404 where Web Push cannot send. */
pushDeviceRoutes.get("/web-push", (c) => {
  if (!webPushAvailable(c.env)) throw new ApiError(404, "web_push_unavailable", "Browser notifications are not available here");
  return c.json(WebPushConfigurationSchema.parse({ publicKey: c.env.WEB_PUSH_VAPID_PUBLIC_KEY!.trim() }));
});
pushDeviceRoutes.put("/:installationId", zValidator("param", params), zValidator("json", RegisterPushDeviceRequestSchema), async (c) => {
  await registerPushDevice(c.env, getWorkspaceAuth(c), c.req.valid("param").installationId, c.req.valid("json"));
  return c.json({ status: "registered" });
});
pushDeviceRoutes.delete("/:installationId", zValidator("param", params), async (c) => {
  await deletePushDevice(c.env, getWorkspaceAuth(c).userId, c.req.valid("param").installationId);
  return c.body(null, 204);
});
