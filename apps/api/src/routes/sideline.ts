import { SidelineCatalogSchema, SidelineSendRequestSchema, SidelineSendResponseSchema } from "@rally/contracts";
import { Hono } from "hono";

import type { HonoAppEnv } from "../env";
import { getAuth } from "../middleware/auth";
import { requireSendableMessageLength, zValidator } from "../middleware/validation";
import { ImpersonationService } from "../services/impersonation-service";

export const sidelineRoutes = new Hono<HonoAppEnv>();

sidelineRoutes.get("/catalog", async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(SidelineCatalogSchema.parse(await new ImpersonationService(c.env, getAuth(c)).catalog()));
});

sidelineRoutes.post(
  "/messages",
  requireSendableMessageLength("message"),
  zValidator("json", SidelineSendRequestSchema),
  async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(SidelineSendResponseSchema.parse(
      await new ImpersonationService(c.env, getAuth(c)).send(c.req.valid("json"), c.get("requestReceivedAt")),
    ));
  },
);
