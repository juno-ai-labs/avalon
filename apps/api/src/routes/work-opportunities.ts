import {
  IdSchema,
  RecordWorkOpportunityImpressionsRequestSchema,
  StartWorkOpportunityRequestSchema,
} from "@avalon/contracts";
import { Hono } from "hono";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { requestDeferral } from "../lib/defer";
import { getAuth } from "../middleware/auth";
import { zValidator } from "../middleware/validation";
import { WorkOpportunityService } from "../services/work-opportunity-service";

const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(4).default(4) });
const idParam = z.object({ id: IdSchema });

export const workOpportunityRoutes = new Hono<HonoAppEnv>();

workOpportunityRoutes.get("/", zValidator("query", listQuery), async (c) =>
  c.json(await new WorkOpportunityService(c.env, getAuth(c), requestDeferral(c)).list(c.req.valid("query").limit)),
);

workOpportunityRoutes.post(
  "/impressions",
  zValidator("json", RecordWorkOpportunityImpressionsRequestSchema),
  async (c) => {
    await new WorkOpportunityService(c.env, getAuth(c)).recordImpressions(c.req.valid("json").opportunityIds);
    return c.body(null, 204);
  },
);

workOpportunityRoutes.delete("/:id", zValidator("param", idParam), async (c) => {
  await new WorkOpportunityService(c.env, getAuth(c)).dismiss(c.req.valid("param").id);
  return c.body(null, 204);
});

workOpportunityRoutes.post(
  "/:id/start",
  zValidator("param", idParam),
  zValidator("json", StartWorkOpportunityRequestSchema),
  async (c) => {
    const input = c.req.valid("json");
    return c.json(await new WorkOpportunityService(c.env, getAuth(c), requestDeferral(c)).start(
      c.req.valid("param").id,
      input.version,
      input.idempotencyKey,
    ), 201);
  },
);
