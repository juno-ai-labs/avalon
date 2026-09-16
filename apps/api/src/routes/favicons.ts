import { Hono } from "hono";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { ApiError } from "../lib/api-error";
import { FirecrawlClient } from "../lib/firecrawl";
import { zValidator } from "../middleware/validation";
import { faviconHostChain, resolveFavicon } from "../services/favicon-service";

export const faviconRoutes = new Hono<HonoAppEnv>();
const FaviconParamsSchema = z.strictObject({
  hostname: z.string().refine((hostname) => faviconHostChain(hostname) !== null, "must be a public domain name"),
});

faviconRoutes.get("/:hostname", zValidator("param", FaviconParamsSchema), async (c) => {
  const { hostname } = c.req.valid("param");
  const apiKey = c.env.FIRECRAWL_API_KEY?.trim();
  if (!apiKey) throw new ApiError(503, "favicon_unavailable", "Favicon discovery is not configured");
  const favicon = await resolveFavicon(
    c.env.FAVICON_CACHE,
    hostname,
    new FirecrawlClient({ apiKey }),
    fetch,
    (promise) => c.executionCtx.waitUntil(promise),
  );
  if (!favicon) {
    return c.body(null, 404, { "Cache-Control": "private, max-age=2592000" });
  }
  return new Response(favicon.bytes, {
    headers: {
      "Cache-Control": "private, max-age=2592000",
      "Content-Type": favicon.contentType,
      "X-Content-Type-Options": "nosniff",
    },
  });
});
