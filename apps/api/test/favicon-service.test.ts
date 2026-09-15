import { describe, expect, it, vi } from "vitest";
import { faviconHostChain, resolveFavicon } from "../src/services/favicon-service";
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
  it("walks a deep public host to its registrable domain and rejects non-public targets", () => {
    expect(faviconHostChain("deep.docs.example.co.uk")).toEqual([
      "deep.docs.example.co.uk",
      "docs.example.co.uk",
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
      "https://docs.example.com/",
      "https://example.com/",
    ]);
    expect(put).toHaveBeenCalledTimes(3);
    for (const call of put.mock.calls) {
      expect(call[2]).toMatchObject({ expirationTtl: 30 * 24 * 60 * 60 });
    }
  });

  it("follows same-host image redirects but rejects redirects to another host", async () => {
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
      if (url === "https://cdn.example.net/final.svg") {
        return response(url, new Uint8Array(), "text/plain", 302, "https://private.example.org/icon.svg");
      }
      if (url === "https://example.com/favicon.png") return response(url, png, "image/png");
      return response(url, new Uint8Array(), "text/plain", 404);
    });

    await expect(resolveFavicon(cache, "docs.example.com", { scrapeBranding }, fetchMock as unknown as typeof fetch))
      .resolves.toMatchObject({ contentType: "image/png" });
    expect(requested).toContain("https://cdn.example.net/final.svg");
    expect(requested).not.toContain("https://private.example.org/icon.svg");
  });

  it("serves cached icons and cached misses without returning to Firecrawl or the origin", async () => {
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
});
