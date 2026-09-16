import { describe, expect, it, vi } from "vitest";
import {
  FAVICON_ORIGIN_TIMEOUT_MS,
  faviconHostChain,
  resolveFavicon,
} from "../src/services/favicon-service";
import { createTestBinaryKvNamespace } from "./helpers/cloudflare-test";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

function response(url: string, bytes: Uint8Array, contentType: string, status = 200, location?: string): Response {
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const value = new Response(body, {
    status,
    headers: { "content-type": contentType, ...(location ? { location } : {}) },
  });
  Object.defineProperty(value, "url", { value: url });
  return value;
}

function cacheFixture() {
  const values = new Map<string, { value: ArrayBuffer | string; metadata: object }>();
  const put = vi.fn(async (key: string, value: ArrayBuffer | string, options?: KVNamespacePutOptions) => {
    values.set(key, { value, metadata: options?.metadata as object });
  });
  const getWithMetadata = vi.fn(async (key: string, type: "arrayBuffer") => {
    void type;
    const found = values.get(key);
    if (!found) return { value: null, metadata: null, cacheStatus: null };
    const value = typeof found.value === "string"
      ? new TextEncoder().encode(found.value).buffer
      : found.value;
    return { value, metadata: found.metadata, cacheStatus: null };
  });
  return {
    cache: createTestBinaryKvNamespace({ getWithMetadata, put }),
    getWithMetadata,
    put,
  };
}

describe("favicon host resolution", () => {
  it("pairs a deep public host with its registrable domain and rejects non-public targets", () => {
    expect(faviconHostChain("deep.docs.example.co.uk")).toEqual([
      "deep.docs.example.co.uk",
      "example.co.uk",
    ]);
    expect(faviconHostChain("127.0.0.1")).toBeNull();
    expect(faviconHostChain("localhost")).toBeNull();
    expect(faviconHostChain("example.com/path")).toBeNull();
  });

  it("asks Firecrawl for every host in parallel and prefers the most-specific favicon", async () => {
    const { cache, put } = cacheFixture();
    const scrapeBranding = vi.fn(async (url: string) => {
      if (url === "https://deep.docs.example.com/") {
        return { faviconUrl: "https://assets.example.net/deep.svg", url, statusCode: 200 };
      }
      if (url === "https://example.com/") {
        return { faviconUrl: "/favicon.png", url, statusCode: 200 };
      }
      return { faviconUrl: null, url, statusCode: 200 };
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://assets.example.net/deep.svg") return response(url, svg, "image/svg+xml");
      if (url === "https://example.com/favicon.png") return response(url, png, "image/png");
      return response(url, new Uint8Array(), "text/plain", 404);
    });

    const found = await resolveFavicon(
      cache,
      "deep.docs.example.com",
      { scrapeBranding },
      fetchMock as unknown as typeof fetch,
    );

    expect(found?.contentType).toBe("image/svg+xml");
    expect(scrapeBranding.mock.calls.map(([url]) => url)).toEqual([
      "https://deep.docs.example.com/",
      "https://example.com/",
    ]);
    expect(put).toHaveBeenCalledTimes(2);
    for (const call of put.mock.calls) {
      expect(call[2]).toMatchObject({ expirationTtl: 30 * 24 * 60 * 60 });
    }
  });

  it("returns an exact-host icon without waiting for the started fallback", async () => {
    const { cache, put } = cacheFixture();
    let releaseFallback: ((value: { faviconUrl: null; url: string; statusCode: number }) => void) | undefined;
    const fallbackBranding = new Promise<{ faviconUrl: null; url: string; statusCode: number }>((resolve) => {
      releaseFallback = resolve;
    });
    const scrapeBranding = vi.fn(async (url: string) => url === "https://example.com/"
      ? fallbackBranding
      : { faviconUrl: "/favicon.png", url, statusCode: 200 });
    const fetchMock = vi.fn(async (input: string | URL | Request) => response(String(input), png, "image/png"));
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
    let settled = false;
    const resolving = resolveFavicon(
      cache,
      "docs.example.com",
      { scrapeBranding },
      fetchMock as unknown as typeof fetch,
      waitUntil,
    ).then((result) => {
      settled = true;
      return result;
    });

    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1_000 });
    await expect(resolving).resolves.toMatchObject({ contentType: "image/png" });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    releaseFallback?.({ faviconUrl: null, url: "https://example.com/", statusCode: 200 });
    await expect(waitUntil.mock.calls[0]?.[0]).resolves.toBeNull();
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2), { timeout: 1_000 });
  });

  it("rejects image redirects and falls back to the registrable domain", async () => {
    const { cache } = cacheFixture();
    const scrapeBranding = vi.fn(async (url: string) => url.startsWith("https://docs.")
      ? { faviconUrl: "https://cdn.example.net/start.svg", url, statusCode: 200 }
      : { faviconUrl: "https://example.com/favicon.png", url, statusCode: 200 });
    const requested: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url === "https://cdn.example.net/start.svg") {
        return response(url, new Uint8Array(), "text/plain", 307, "/final.svg");
      }
      if (url === "https://example.com/favicon.png") return response(url, png, "image/png");
      return response(url, new Uint8Array(), "text/plain", 404);
    });

    await expect(resolveFavicon(cache, "docs.example.com", { scrapeBranding }, fetchMock as unknown as typeof fetch))
      .resolves.toMatchObject({ contentType: "image/png" });
    expect(requested).toEqual(expect.arrayContaining([
      "https://cdn.example.net/start.svg",
      "https://example.com/favicon.png",
    ]));
    expect(requested).not.toContain("https://cdn.example.net/final.svg");
  });

  it("keeps a successful parent fallback when the exact-host provider call fails", async () => {
    const { cache, put } = cacheFixture();
    const scrapeBranding = vi.fn(async (url: string) => {
      if (url === "https://docs.example.com/") throw new Error("provider unavailable");
      return { faviconUrl: "/favicon.png", url, statusCode: 200 };
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => response(String(input), png, "image/png"));

    await expect(resolveFavicon(cache, "docs.example.com", { scrapeBranding }, fetchMock as unknown as typeof fetch))
      .resolves.toMatchObject({ contentType: "image/png" });
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[0]).toBe("favicon:example.com");
  });

  it("reuses a cached icon and subdomain miss during parent fallback", async () => {
    const { cache } = cacheFixture();
    const scrapeBranding = vi.fn(async (url: string) => url === "https://example.com/"
      ? { faviconUrl: "/favicon.png", url, statusCode: 200 }
      : { faviconUrl: null, url, statusCode: 200 });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return response(url, png, "application/octet-stream");
    });
    const fetcher = fetchMock as unknown as typeof fetch;

    await expect(resolveFavicon(cache, "example.com", { scrapeBranding }, fetcher)).resolves.toMatchObject({ contentType: "image/png" });
    await expect(resolveFavicon(cache, "example.com", { scrapeBranding }, fetcher)).resolves.toMatchObject({ contentType: "image/png" });
    expect(scrapeBranding).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(resolveFavicon(cache, "missing.example.com", { scrapeBranding }, fetcher)).resolves.toMatchObject({ contentType: "image/png" });
    const callsAfterFirstMiss = scrapeBranding.mock.calls.length;
    await expect(resolveFavicon(cache, "missing.example.com", { scrapeBranding }, fetcher)).resolves.toMatchObject({ contentType: "image/png" });
    expect(scrapeBranding).toHaveBeenCalledTimes(callsAfterFirstMiss);
  });

  it("does not turn a Firecrawl failure into a 30-day missing entry", async () => {
    const { cache, put } = cacheFixture();
    const failure = new Error("provider unavailable");
    const scrapeBranding = vi.fn(async () => { throw failure; });

    await expect(resolveFavicon(cache, "example.com", { scrapeBranding })).rejects.toBe(failure);
    expect(put).not.toHaveBeenCalled();
  });

  it.each([0, 429, 503])("does not cache transient Firecrawl status %i as missing", async (statusCode) => {
    const { cache, put } = cacheFixture();
    const scrapeBranding = vi.fn(async (url: string) => ({ faviconUrl: null, url, statusCode }));

    await expect(resolveFavicon(cache, "example.com", { scrapeBranding })).rejects.toThrow("favicon_branding_fetch_failed");
    expect(put).not.toHaveBeenCalled();
  });

  it("does not cache a transient image response as missing", async () => {
    const { cache, put } = cacheFixture();
    const scrapeBranding = vi.fn(async (url: string) => ({ faviconUrl: "/favicon.png", url, statusCode: 200 }));
    const fetchMock = vi.fn(async (input: string | URL | Request) => response(String(input), new Uint8Array(), "text/plain", 503));

    await expect(resolveFavicon(cache, "example.com", { scrapeBranding }, fetchMock as unknown as typeof fetch))
      .rejects.toThrow("favicon_image_fetch_failed");
    expect(put).not.toHaveBeenCalled();
  });

  it.each(["headers", "body"] as const)("ends a stalled favicon-origin %s read at its deadline", async (phase) => {
    const { cache, put } = cacheFixture();
    const scrapeBranding = vi.fn(async (url: string) => ({ faviconUrl: "/favicon.png", url, statusCode: 200 }));
    let observedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal as AbortSignal;
      if (phase === "headers") {
        return await new Promise<Response>((_resolve, reject) => {
          observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), { once: true });
        });
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          observedSignal?.addEventListener("abort", () => controller.error(observedSignal?.reason), { once: true });
        },
      });
      return new Response(body, { headers: { "content-type": "image/png" } });
    });

    await expect(resolveFavicon(
      cache,
      "example.com",
      { scrapeBranding },
      fetchMock as unknown as typeof fetch,
      undefined,
      0,
    )).rejects.toThrow("favicon_image_fetch_failed");
    expect(observedSignal?.aborted).toBe(true);
    expect(put).not.toHaveBeenCalled();
  });

  it("keeps the team-selected origin deadline above an ordinary image response", async () => {
    const { cache } = cacheFixture();
    const scrapeBranding = vi.fn(async (url: string) => ({ faviconUrl: "/favicon.png", url, statusCode: 200 }));
    let observedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal as AbortSignal;
      return response(String(input), png, "image/png");
    });

    await expect(resolveFavicon(cache, "example.com", { scrapeBranding }, fetchMock as unknown as typeof fetch))
      .resolves.toMatchObject({ contentType: "image/png" });
    expect(FAVICON_ORIGIN_TIMEOUT_MS).toBeGreaterThan(0);
    expect(observedSignal?.aborted).toBe(false);
  });

  it("stops reading an unbounded image body at the KV value boundary", async () => {
    const { cache, put } = cacheFixture();
    const scrapeBranding = vi.fn(async (url: string) => ({ faviconUrl: "/favicon.png", url, statusCode: 200 }));
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(13 * 1024 * 1024));
        controller.enqueue(new Uint8Array(13 * 1024 * 1024));
      },
      cancel() { cancelled = true; },
    });
    const fetchMock = vi.fn(async () => {
      const value = new Response(body, { headers: { "content-type": "image/png" } });
      Object.defineProperty(value, "url", { value: "https://example.com/favicon.png" });
      return value;
    });

    await expect(resolveFavicon(cache, "example.com", { scrapeBranding }, fetchMock as unknown as typeof fetch))
      .resolves.toBeNull();
    expect(cancelled).toBe(true);
    expect(put).toHaveBeenCalledWith("favicon:example.com", "missing", expect.anything());
  });

  it("accepts a JPEG with bytes after its end marker and rejects an HTML body", async () => {
    const jpegCache = cacheFixture();
    const htmlCache = cacheFixture();
    const scrapeBranding = vi.fn(async (url: string) => ({ faviconUrl: "/favicon.jpg", url, statusCode: 200 }));
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 0x0a]);
    const jpegFetch = vi.fn(async (input: string | URL | Request) => response(String(input), jpeg, "image/jpeg"));
    const html = new TextEncoder().encode("<html>not an image</html>");
    const htmlFetch = vi.fn(async (input: string | URL | Request) => response(String(input), html, "text/html"));

    await expect(resolveFavicon(jpegCache.cache, "example.com", { scrapeBranding }, jpegFetch as unknown as typeof fetch))
      .resolves.toMatchObject({ contentType: "image/jpeg" });
    await expect(resolveFavicon(htmlCache.cache, "example.com", { scrapeBranding }, htmlFetch as unknown as typeof fetch))
      .resolves.toBeNull();
  });
});
