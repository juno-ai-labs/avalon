import { RegisterPushDeviceRequestSchema } from "@rally/contracts/push-notifications";
import { Hono } from "hono";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { getAuth } from "../middleware/auth";
import { zValidator } from "../middleware/validation";
import { registerPushDevice, deletePushDevice } from "../services/push-device-service";

export const pushDeviceRoutes = new Hono<HonoAppEnv>();
const params = z.object({ installationId: z.string().uuid() });
pushDeviceRoutes.put("/:installationId", zValidator("param", params), zValidator("json", RegisterPushDeviceRequestSchema), async (c) => {
  await registerPushDevice(c.env, getAuth(c), c.req.valid("param").installationId, c.req.valid("json"));
  return c.json({ status: "registered" });
});
pushDeviceRoutes.delete("/:installationId", zValidator("param", params), async (c) => {
  await deletePushDevice(c.env, getAuth(c).userId, c.req.valid("param").installationId);
  return c.body(null, 204);
});
