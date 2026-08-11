import {
  IdSchema,
  RecordWorkOpportunityImpressionsRequestSchema,
  StartWorkOpportunityRequestSchema,
  WorkOpportunityPageSchema,
  WorkstreamSchema,
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

/**
 * What starting a suggestion hands back: the work stream it opened, and where.
 *
 * `WorkstreamSchema`, not `WorkstreamDetailSchema`. The two exits of
 * `WorkOpportunityService.start` return different shapes — a replay reloads the
 * detail, a fresh start returns what `workstreams.create` built — and the detail
 * schema's `participants`/`resources`/`suggestions` carry no defaults, so
 * demanding it here 500s the fresh-start path after the work stream, its email
 * route and its harness run have all committed. The desktop client parses this
 * response with the base schema, so the detail's extra keys were never read.
 */
export const StartedWorkOpportunityResponseSchema = z.object({
  workstream: WorkstreamSchema,
  messageId: IdSchema,
  harnessRunId: IdSchema.nullable(),
});

export const workOpportunityRoutes = new Hono<HonoAppEnv>();

workOpportunityRoutes.get("/", zValidator("query", listQuery), async (c) =>
  c.json(WorkOpportunityPageSchema.parse(
    await new WorkOpportunityService(c.env, getAuth(c), requestDeferral(c)).list(c.req.valid("query").limit))),
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
    return c.json(StartedWorkOpportunityResponseSchema.parse(
      await new WorkOpportunityService(c.env, getAuth(c), requestDeferral(c)).start(
        c.req.valid("param").id,
        input.version,
        input.idempotencyKey,
      )), 201);
  },
);
