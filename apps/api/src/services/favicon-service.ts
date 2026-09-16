import { parse as parseDomain } from "tldts";
import type { FirecrawlClient } from "../lib/firecrawl";

const FAVICON_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
// A KV value cannot exceed 25 MiB. This is the platform's write boundary, not
// a product-selected favicon limit: anything larger cannot be cached and is
// therefore not a usable result for this service.
const KV_MAX_VALUE_BYTES = 25 * 1024 * 1024;
const textDecoder = new TextDecoder();

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

/** The exact host first, then its registrable domain when those differ. */
export function faviconHostChain(hostname: string): string[] | null {
  const parsed = publicHostname(hostname);
  if (!parsed) return null;
  return parsed.hostname === parsed.domain ? [parsed.hostname] : [parsed.hostname, parsed.domain];
}

function cacheKey(hostname: string): string {
  return `favicon:${hostname}`;
}

function contentTypeForImage(bytes: Uint8Array, header: string | null): string | null {
  const declared = header?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 6 && textDecoder.decode(bytes.slice(0, 6)).match(/^GIF8[79]a$/u)) return "image/gif";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.length >= 12 && textDecoder.decode(bytes.slice(0, 4)) === "RIFF" && textDecoder.decode(bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) return "image/x-icon";
  if (bytes.length >= 12 && textDecoder.decode(bytes.slice(4, 12)).match(/^ftyp(?:avif|avis)$/u)) return "image/avif";
  const prefix = textDecoder.decode(bytes.slice(0, 1_024)).trimStart();
  if ((declared === "image/svg+xml" || prefix.startsWith("<svg") || prefix.startsWith("<?xml")) && /<svg[\s>]/iu.test(prefix)) {
    return "image/svg+xml";
  }
  return null;
}

function transientStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
}

function transientFailure(hostname: string, phase: "branding" | "image", cause?: unknown): Error {
  return new Error(`favicon_${phase}_fetch_failed for ${hostname}`, { cause });
}

async function fetchImage(url: URL, accept: string, fetcher: typeof fetch): Promise<Response | null> {
  let response: Response;
  try {
    response = await fetcher(url, { headers: { Accept: accept }, redirect: "manual" });
  } catch (error) {
    throw transientFailure(url.hostname, "image", error);
  }
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    await response.body?.cancel();
    return null;
  }
  if (transientStatus(response.status)) {
    await response.body?.cancel();
    throw transientFailure(url.hostname, "image");
  }
  return response;
}

async function readImageBytes(response: Response): Promise<ArrayBuffer | null> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const statedLength = Number(contentLength);
    if (Number.isFinite(statedLength) && statedLength > KV_MAX_VALUE_BYTES) {
      await response.body?.cancel();
      return null;
    }
  }
  const reader = response.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > KV_MAX_VALUE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

async function fetchHostFavicon(
  hostname: string,
  firecrawl: Pick<FirecrawlClient, "scrapeBranding">,
  fetcher: typeof fetch,
): Promise<ResolvedFavicon | null> {
  const discovered = await firecrawl.scrapeBranding(`https://${hostname}/`);
  if (transientStatus(discovered.statusCode)) throw transientFailure(hostname, "branding");
  if (discovered.statusCode < 200 || discovered.statusCode >= 300 || !discovered.faviconUrl) return null;
  let faviconUrl: URL;
  try {
    faviconUrl = new URL(discovered.faviconUrl, discovered.url ?? `https://${hostname}/`);
  } catch {
    return null;
  }
  if (faviconUrl.protocol !== "https:" || !publicHostname(faviconUrl.hostname)) return null;

  const response = await fetchImage(
    faviconUrl,
    "image/avif,image/webp,image/svg+xml,image/png,image/*,*/*;q=0.2",
    fetcher,
  );
  if (!response?.ok) {
    await response?.body?.cancel();
    return null;
  }
  let bytes: ArrayBuffer | null;
  try {
    bytes = await readImageBytes(response);
  } catch (error) {
    throw transientFailure(faviconUrl.hostname, "image", error);
  }
  if (!bytes || bytes.byteLength === 0) return null;
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
 * Resolve the exact and registrable hosts concurrently, but select the exact
 * host first. A provider failure cannot discard an icon returned by the other
 * candidate, and is propagated only when neither candidate produced one.
 */
export async function resolveFavicon(
  cache: KVNamespace,
  hostname: string,
  firecrawl: Pick<FirecrawlClient, "scrapeBranding">,
  fetcher: typeof fetch = fetch,
): Promise<ResolvedFavicon | null> {
  const chain = faviconHostChain(hostname);
  if (!chain) return null;
  const results = await Promise.allSettled(
    chain.map((candidate) => cachedHostFavicon(cache, candidate, firecrawl, fetcher)),
  );
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) return result.value;
  }
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return null;
}
