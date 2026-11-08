import { Hono } from "hono";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { ApiError } from "../lib/api-error";
import { FirecrawlClient } from "../lib/firecrawl";
import { zValidator } from "../middleware/validation";
import { faviconFailureReason, faviconHostChain, resolveFavicon } from "../services/favicon-service";

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
  ).catch((error: unknown) => {
    // The provider, or the host behind it, failed: a gateway failure that
    // names why, never the generic 500 a request with the reason in hand
    // would otherwise reach (CLAUDE.md, "Naming a schema failure").
    const reason = faviconFailureReason(error);
    if (reason === null) throw error;
    throw new ApiError(502, `favicon_unavailable:${reason}`, "The site's icon could not be fetched");
  });
  if (!favicon) {
    return c.body(null, 404, { "Cache-Control": "private, no-cache" });
  }
  return new Response(favicon.bytes, {
    headers: {
      "Cache-Control": "private, no-cache",
      "Content-Type": favicon.contentType,
      "X-Content-Type-Options": "nosniff",
    },
  });
});
