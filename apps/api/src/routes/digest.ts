import { DigestScheduleSchema, UpdateDigestScheduleRequestSchema } from "@rally/contracts";
import { Hono } from "hono";

import type { HonoAppEnv } from "../env";
import { getAuth } from "../middleware/auth";
import { zValidator } from "../middleware/validation";
import { DigestService } from "../services/digest-service";

/**
 * A digest belongs to one person, so there is no id in the path: the caller's
 * own digest is the only one these routes can reach, and `PUT` replaces it
 * wholesale rather than patching it.
 */
export const digestRoutes = new Hono<HonoAppEnv>();

digestRoutes.get("/", async (c) =>
  c.json(DigestScheduleSchema.parse(await new DigestService(c.env, getAuth(c)).get())));
digestRoutes.put("/", zValidator("json", UpdateDigestScheduleRequestSchema), async (c) =>
  c.json(DigestScheduleSchema.parse(await new DigestService(c.env, getAuth(c)).replace(c.req.valid("json")))),
);
