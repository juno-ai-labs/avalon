import { parse as parseDomain } from "tldts";
import { FirecrawlError, type FirecrawlClient } from "../lib/firecrawl";
import { createDeadline } from "../lib/deadline";

const FAVICON_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
/**
 * Bounds one complete candidate lookup: branding discovery plus image headers
 * and body.
 * Set to 25 seconds by the team on 2026-09-16, matching Firecrawl's branding
 * scrape budget and fitting inside Cloudflare's 30-second waitUntil window.
 */
export const FAVICON_CANDIDATE_TIMEOUT_MS = 25_000;
// A KV value cannot exceed 25 MiB. This is the platform's write boundary, not
// a product-selected favicon limit: anything larger cannot be cached and is
// therefore not a usable result for this service.
const KV_MAX_VALUE_BYTES = 25 * 1024 * 1024;
const textDecoder = new TextDecoder();
const oversizedImageBody = new Error("favicon_image_body_too_large");

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

/** A discovery or image fetch that did not complete, so its host's favicon is unknown rather than missing. */
export class FaviconFetchError extends Error {
  constructor(readonly phase: "branding" | "image", hostname: string, options?: ErrorOptions) {
    super(`favicon_${phase}_fetch_failed for ${hostname}`, options);
    this.name = "FaviconFetchError";
  }
}

function transientFailure(hostname: string, phase: "branding" | "image", cause?: unknown): Error {
  return new FaviconFetchError(phase, hostname, { cause });
}

/**
 * Why a favicon could not be resolved, as the `favicon_unavailable:<reason>`
 * code a caller and the log both read, or `null` for a failure this module did
 * not anticipate: a fetch that did not complete names its phase, and a
 * Firecrawl failure its kind and HTTP status (`firecrawl_http_400`). Neither
 * carries the provider's message, which may quote the request.
 */
export function faviconFailureReason(error: unknown): string | null {
  if (error instanceof FaviconFetchError) return `${error.phase}_fetch_failed`;
  if (error instanceof FirecrawlError) return error.kind === "network" ? "firecrawl_network" : `firecrawl_${error.kind}_${error.status}`;
  return null;
}

async function fetchImage(
  url: URL,
  accept: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<Response | null> {
  let response: Response;
  try {
    response = await fetcher(url, { headers: { Accept: accept }, redirect: "manual", signal });
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
  if (!response.body) return new ArrayBuffer(0);
  let total = 0;
  try {
    const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (total + chunk.byteLength > KV_MAX_VALUE_BYTES) {
          controller.error(oversizedImageBody);
          return;
        }
        total += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }));
    return await new Response(bounded).arrayBuffer();
  } catch (error) {
    if (error === oversizedImageBody) return null;
    throw error;
  }
}

async function fetchHostFavicon(
  hostname: string,
  firecrawl: Pick<FirecrawlClient, "scrapeBranding">,
  fetcher: typeof fetch,
  candidateTimeoutMs: number,
): Promise<ResolvedFavicon | null> {
  const deadline = createDeadline(candidateTimeoutMs);
  try {
    let discovered: Awaited<ReturnType<FirecrawlClient["scrapeBranding"]>>;
    try {
      discovered = await firecrawl.scrapeBranding(`https://${hostname}/`, { signal: deadline.signal });
    } catch (error) {
      if (deadline.signal.aborted) throw transientFailure(hostname, "branding", error);
      throw error;
    }
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
      deadline.signal,
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
  } finally {
    deadline.dispose();
  }
}

async function cachedHostFavicon(
  cache: KVNamespace,
  hostname: string,
  firecrawl: Pick<FirecrawlClient, "scrapeBranding">,
  fetcher: typeof fetch,
  candidateTimeoutMs: number,
): Promise<ResolvedFavicon | null> {
  const key = cacheKey(hostname);
  const cached = await cache.getWithMetadata<FaviconCacheMetadata>(key, "arrayBuffer");
  if (cached.metadata?.kind === "missing") return null;
  if (cached.value && cached.metadata?.kind === "icon") {
    return { bytes: cached.value, contentType: cached.metadata.contentType };
  }

  const favicon = await fetchHostFavicon(hostname, firecrawl, fetcher, candidateTimeoutMs);
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
  waitUntil?: (promise: Promise<unknown>) => void,
  candidateTimeoutMs = FAVICON_CANDIDATE_TIMEOUT_MS,
): Promise<ResolvedFavicon | null> {
  const chain = faviconHostChain(hostname);
  if (!chain) return null;
  const exact = cachedHostFavicon(cache, chain[0]!, firecrawl, fetcher, candidateTimeoutMs);
  const fallback = chain[1]
    ? cachedHostFavicon(cache, chain[1], firecrawl, fetcher, candidateTimeoutMs)
    : null;
  // The fallback has already started, but its failure must not become an
  // unhandled rejection when the exact-host icon lets this request return.
  void fallback?.catch(() => undefined);
  let exactFailure: unknown;
  try {
    const result = await exact;
    if (result) {
      if (fallback && waitUntil) waitUntil(fallback.catch(() => undefined));
      return result;
    }
  } catch (error) {
    exactFailure = error;
  }
  if (fallback) {
    try {
      const result = await fallback;
      if (result) return result;
    } catch (error) {
      if (exactFailure === undefined) throw error;
    }
  }
  if (exactFailure !== undefined) throw exactFailure;
  return null;
}
