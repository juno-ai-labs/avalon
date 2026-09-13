import { Hono } from "hono";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { numericEnv } from "../env";
import { readBoundedRequestBytes as readBoundedBytes } from "../lib/bounded-request-body";
import { ResendInboundEmailRoutingService } from "../services/resend-inbound-email-service";

const DEFAULT_MAX_WEBHOOK_BYTES = 2_000_000;

/** What Resend is told about an inbound message; the route owns this shape. */
const ResendInboundResponseSchema = z.object({
  accepted: z.literal(true),
  duplicate: z.boolean(),
  ignored: z.boolean(),
  routedCount: z.number().int().nonnegative(),
});

export const resendInboundRoutes = new Hono<HonoAppEnv>();

resendInboundRoutes.post("/", async (c) => {
  const maxBytes = numericEnv(c.env, "PROVIDER_WEBHOOK_MAX_BYTES", DEFAULT_MAX_WEBHOOK_BYTES);
  const result = await new ResendInboundEmailRoutingService(c.env).ingest(
    await readBoundedRequestBytes(c.req.raw, maxBytes),
    c.req.raw.headers,
  );
  // Resend treats any 2xx as accepted. A consistent 200 also avoids provider
  // ambiguity about whether Avalon still has asynchronous work outstanding.
  return c.json(ResendInboundResponseSchema.parse(result), 200);
});


const readBoundedRequestBytes = (request: Request, maxBytes: number) => readBoundedBytes(request, maxBytes, "The Resend webhook is too large");

export const __resendRouteTesting = { readBoundedRequestBytes };
