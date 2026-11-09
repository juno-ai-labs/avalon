/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { createExecutionContext, reset, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HonoAppEnv } from "../src/env";
import { errorHandler } from "../src/middleware/errors";
import { faviconRoutes } from "../src/routes/favicons";

const EXACT_HOST = "docs.runtime-favicon.example";
const PRIMARY_HOST = "runtime-favicon.example";
const EXACT_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PRIMARY_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

beforeEach(async () => {
  await reset();
});

function brandingResponse(hostname: string): Response {
  return Response.json({
    success: true,
    data: {
      branding: { images: { favicon: `https://${hostname}/favicon` } },
      metadata: { url: `https://${hostname}/`, statusCode: 200 },
    },
  });
}

describe("favicon route on workerd", () => {
  it("answers a Firecrawl refusal with a named gateway failure, not internal_error, and caches nothing", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).hostname === "api.firecrawl.dev") {
        return Response.json({ success: false, error: "Could not resolve the host" }, { status: 400 });
      }
      throw new Error(`unexpected favicon runtime fetch: ${request.url}`);
    }));
    const app = new Hono<HonoAppEnv>().onError(errorHandler).route("/favicons", faviconRoutes);
    const ctx = createExecutionContext();
    const response = await app.request(`https://api.rally.test/favicons/${EXACT_HOST}`, undefined,
      { ...env, FIRECRAWL_API_KEY: "test-firecrawl-key" }, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: {
      code: "favicon_unavailable:firecrawl_http_400", message: "The site's icon could not be fetched" } });
    expect(await env.FAVICON_CACHE.get(`favicon:${EXACT_HOST}`)).toBeNull();
  });

  it("returns the exact icon while waitUntil persists the fallback in real KV", async () => {
    let releasePrimaryBranding!: () => void;
    const primaryBranding = new Promise<void>((resolve) => { releasePrimaryBranding = resolve; });
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname === "api.firecrawl.dev") {
        const body = await request.json() as { url: string };
        const hostname = new URL(body.url).hostname;
        if (hostname === PRIMARY_HOST) await primaryBranding;
        return brandingResponse(hostname);
      }
      if (url.hostname === EXACT_HOST) {
        return new Response(EXACT_BYTES, { headers: { "Content-Type": "image/png" } });
      }
      if (url.hostname === PRIMARY_HOST) {
        return new Response(PRIMARY_BYTES, { headers: { "Content-Type": "image/gif" } });
      }
      throw new Error(`unexpected favicon runtime fetch: ${request.url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    const ctx = createExecutionContext();
    const response = await faviconRoutes.request(
      `https://api.rally.test/${EXACT_HOST}`,
      undefined,
      { ...env, FIRECRAWL_API_KEY: "test-firecrawl-key" },
      ctx,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(EXACT_BYTES);
    expect(await env.FAVICON_CACHE.get("favicon:runtime-favicon.example")).toBeNull();

    let contextSettled = false;
    const contextSettlement = waitOnExecutionContext(ctx).then(() => { contextSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(contextSettled).toBe(false);
    releasePrimaryBranding();
    await contextSettlement;

    const exact = await env.FAVICON_CACHE.getWithMetadata<{ kind: string; contentType: string }>(
      `favicon:${EXACT_HOST}`,
      "arrayBuffer",
    );
    expect(exact.metadata).toEqual({ kind: "icon", contentType: "image/png" });
    expect(new Uint8Array(exact.value!)).toEqual(EXACT_BYTES);
    const primary = await env.FAVICON_CACHE.getWithMetadata<{ kind: string; contentType: string }>(
      `favicon:${PRIMARY_HOST}`,
      "arrayBuffer",
    );
    expect(primary.metadata).toEqual({ kind: "icon", contentType: "image/gif" });
    expect(new Uint8Array(primary.value!)).toEqual(PRIMARY_BYTES);

    fetcher.mockClear();
    const cached = await faviconRoutes.request(
      `https://api.rally.test/${EXACT_HOST}`,
      undefined,
      { ...env, FIRECRAWL_API_KEY: "test-firecrawl-key" },
      createExecutionContext(),
    );
    expect(cached.status).toBe(200);
    expect(new Uint8Array(await cached.arrayBuffer())).toEqual(EXACT_BYTES);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
