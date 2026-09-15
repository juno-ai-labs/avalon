import { parse as parseDomain } from "tldts";
import type { FirecrawlClient } from "../lib/firecrawl";

const FAVICON_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
// A KV value cannot exceed 25 MiB. This is the platform's write boundary, not
// a product-selected favicon limit: anything larger cannot be cached and is
// therefore not a usable result for this service.
const KV_MAX_VALUE_BYTES = 25 * 1024 * 1024;

type FaviconCacheMetadata =
  | { kind: "icon"; contentType: string }
  | { kind: "missing" };

export interface ResolvedFavicon {
  bytes: ArrayBuffer;
  contentType: string;
}

function publicHostname(hostname: string): { hostname: string; domain: string } | null {
  if (!hostname || /[/\\:@\s]/u.test(hostname)) return null;
  let normalized: string;
  try {
    normalized = new URL(`https://${hostname}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  const parsed = parseDomain(normalized, { allowPrivateDomains: false });
  if (parsed.isIp || !parsed.domain || parsed.publicSuffix === null) return null;
  return { hostname: normalized, domain: parsed.domain };
}

/** Most-specific host first, then every parent down to the registrable domain. */
export function faviconHostChain(hostname: string): string[] | null {
  const parsed = publicHostname(hostname);
  if (!parsed) return null;
  const chain = [parsed.hostname];
  let current = parsed.hostname;
  while (current !== parsed.domain) {
    current = current.slice(current.indexOf(".") + 1);
    if (!current.endsWith(`.${parsed.domain}`) && current !== parsed.domain) return null;
    chain.push(current);
  }
  return chain;
}

function cacheKey(hostname: string): string {
  return `favicon:v3:${hostname}`;
}

function contentTypeForImage(bytes: Uint8Array, header: string | null): string | null {
  const declared = header?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 6 && new TextDecoder().decode(bytes.slice(0, 6)).match(/^GIF8[79]a$/u)) return "image/gif";
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return "image/jpeg";
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) return "image/x-icon";
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(4, 12)).match(/^ftyp(?:avif|avis)$/u)) return "image/avif";
  const prefix = new TextDecoder().decode(bytes.slice(0, 1_024)).trimStart();
  if ((declared === "image/svg+xml" || prefix.startsWith("<svg") || prefix.startsWith("<?xml")) && /<svg[\s>]/iu.test(prefix)) {
    return "image/svg+xml";
  }
  return null;
}

async function fetchSameHost(url: string, accept: string, fetcher: typeof fetch): Promise<Response | null> {
  const initial = new URL(url);
  const visited = new Set<string>();
  let current = initial;
  while (!visited.has(current.href)) {
    visited.add(current.href);
    let response: Response;
    try {
      response = await fetcher(current, { headers: { Accept: accept }, redirect: "manual" });
    } catch {
      return null;
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) return null;
    try {
      const next = new URL(location, current);
      // Firecrawl may return a CDN URL, but that image URL cannot redirect the
      // cache warmer onward to another host or a plaintext destination.
      if (next.protocol !== "https:" || next.hostname.toLowerCase() !== initial.hostname.toLowerCase()) return null;
      current = next;
    } catch {
      return null;
    }
  }
  return null;
}

async function fetchHostFavicon(
  hostname: string,
  firecrawl: Pick<FirecrawlClient, "scrapeBranding">,
  fetcher: typeof fetch,
): Promise<ResolvedFavicon | null> {
  const discovered = await firecrawl.scrapeBranding(`https://${hostname}/`);
  if (discovered.statusCode < 200 || discovered.statusCode >= 300 || !discovered.faviconUrl) return null;
  let faviconUrl: URL;
  try {
    faviconUrl = new URL(discovered.faviconUrl, discovered.url ?? `https://${hostname}/`);
  } catch {
    return null;
  }
  if (faviconUrl.protocol !== "https:" || !publicHostname(faviconUrl.hostname)) return null;

  const response = await fetchSameHost(
    faviconUrl.href,
    "image/avif,image/webp,image/svg+xml,image/png,image/*,*/*;q=0.2",
    fetcher,
  );
  if (!response?.ok) {
    await response?.body?.cancel();
    return null;
  }
  if (!publicHostname(new URL(response.url).hostname)) {
    await response.body?.cancel();
    return null;
  }
  const statedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(statedLength) && statedLength > KV_MAX_VALUE_BYTES) return null;
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > KV_MAX_VALUE_BYTES) return null;
  const contentType = contentTypeForImage(new Uint8Array(bytes), response.headers.get("content-type"));
  return contentType ? { bytes, contentType } : null;
}

async function cachedHostFavicon(
  cache: KVNamespace,
  hostname: string,
  firecrawl: Pick<FirecrawlClient, "scrapeBranding">,
  fetcher: typeof fetch,
): Promise<ResolvedFavicon | null> {
  const key = cacheKey(hostname);
  const cached = await cache.getWithMetadata<FaviconCacheMetadata>(key, "arrayBuffer");
  if (cached.metadata?.kind === "missing") return null;
  if (cached.value && cached.metadata?.kind === "icon") {
    return { bytes: cached.value, contentType: cached.metadata.contentType };
  }

  const favicon = await fetchHostFavicon(hostname, firecrawl, fetcher);
  if (favicon) {
    await cache.put(key, favicon.bytes, {
      expirationTtl: FAVICON_CACHE_TTL_SECONDS,
      metadata: { kind: "icon", contentType: favicon.contentType } satisfies FaviconCacheMetadata,
    });
    return favicon;
  }
  await cache.put(key, "missing", {
    expirationTtl: FAVICON_CACHE_TTL_SECONDS,
    metadata: { kind: "missing" } satisfies FaviconCacheMetadata,
  });
  return null;
}

/**
 * Resolve every level concurrently, but select the most-specific icon. A deep
 * host therefore never waits for a failed subdomain lookup before its parent
 * begins, while a favicon it owns still wins over the registrable domain.
 */
export async function resolveFavicon(
  cache: KVNamespace,
  hostname: string,
  firecrawl: Pick<FirecrawlClient, "scrapeBranding">,
  fetcher: typeof fetch = fetch,
): Promise<ResolvedFavicon | null> {
  const chain = faviconHostChain(hostname);
  if (!chain) return null;
  const results = await Promise.all(chain.map((candidate) => cachedHostFavicon(cache, candidate, firecrawl, fetcher)));
  return results.find((result) => result !== null) ?? null;
}
