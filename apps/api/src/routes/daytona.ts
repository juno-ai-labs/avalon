import { z } from "zod";
import { Hono } from "hono";
import type { HonoAppEnv } from "../env";
import { providerWebhookMaxBytes, readBoundedRequestBytes } from "../lib/bounded-request-body";
import { ingestDaytonaWebhook } from "../services/terminal/webhook";

const DaytonaWebhookResponseSchema = z.strictObject({ accepted: z.literal(true), ignored: z.boolean() });

export const daytonaWebhookRoutes = new Hono<HonoAppEnv>();
daytonaWebhookRoutes.post("/", async (c) => {
  const bytes = await readBoundedRequestBytes(c.req.raw, providerWebhookMaxBytes(c.env));
  return c.json(DaytonaWebhookResponseSchema.parse(
    await ingestDaytonaWebhook(c.env, new TextDecoder().decode(bytes), c.req.raw.headers),
  ));
});
