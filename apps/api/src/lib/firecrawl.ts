import { z } from "zod/v3";

export const DEFAULT_FIRECRAWL_BASE_URL = "https://api.firecrawl.dev/v2";
export const FIRECRAWL_CACHE_MAX_AGE_MS = 172_800_000;

const SEARCH_TIMEOUT_MS = 20_000;
const SCRAPE_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_RETRY_BASE_DELAY_MS = 2_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 16_000;
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const searchResponseSchema = z.object({
  success: z.boolean().optional(),
  data: z.object({
    web: z.array(z.object({
      title: z.string(),
      url: z.string(),
      description: z.string(),
      // Firecrawl has returned this in practice, but its current v2 contract
      // does not promise it for web results. Preserve the provider's ranked
      // array order rather than requiring or sorting on this optional field.
      position: z.number().int().safe().optional(),
    })),
  }),
  creditsUsed: z.number().finite().nonnegative().optional(),
  warning: z.string().nullish(),
  id: z.string().optional(),
});

const scrapeMetadataSchema = z.object({
  title: z.string().nullish(),
  sourceURL: z.string().nullish(),
  url: z.string().nullish(),
  statusCode: z.number().int().safe().nullish(),
  error: z.string().nullish(),
  // These fields are useful for future accounting but are intentionally
  // optional because Firecrawl's public scrape response schema does not
  // guarantee them.
  creditsUsed: z.number().finite().nonnegative().nullish(),
  proxyUsed: z.string().nullish(),
  cacheState: z.string().nullish(),
});

const scrapeResponseSchema = z.object({
  success: z.boolean().optional(),
  data: z.object({
    markdown: z.string().nullish(),
    metadata: scrapeMetadataSchema,
    warning: z.string().nullish(),
  }),
});

const errorEnvelopeSchema = z.object({
  success: z.literal(false).optional(),
  error: z.string().optional(),
  details: z.unknown().optional(),
});

export interface FirecrawlSearchInput {
  query: string;
  limit: number;
  tbs?: string;
}

export interface FirecrawlSearchResult {
  title: string;
  url: string;
  description: string;
}

export interface FirecrawlSearchOutput {
  results: FirecrawlSearchResult[];
  creditsUsed?: number;
}

export interface FirecrawlScrapeInput {
  url: string;
  maxAgeMs?: number;
}

export interface FirecrawlScrapeOutput {
  url: string | null;
  title: string | null;
  markdown: string;
  statusCode: number;
  creditsUsed?: number;
  proxyUsed?: string;
  cacheState?: string;
}

export interface FirecrawlCallOptions {
  signal?: AbortSignal;
}

export interface FirecrawlRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export interface FirecrawlClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  retry?: FirecrawlRetryOptions;
}

export type FirecrawlErrorKind = "http" | "parse" | "network";

export class FirecrawlError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly kind: FirecrawlErrorKind,
    readonly status: number,
    message: string,
    readonly providerMessage?: string,
    readonly details?: unknown,
    readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FirecrawlError";
    this.retryable = kind === "network" || RETRYABLE_HTTP_STATUSES.has(status);
  }
}

export class FirecrawlClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly retry: FirecrawlRetryOptions;

  constructor(options: FirecrawlClientOptions) {
    if (!options.apiKey.trim()) throw new Error("Firecrawl requires a non-empty API key");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_FIRECRAWL_BASE_URL).replace(/\/+$/u, "");
    this.fetcher = (options.fetch ?? globalThis.fetch).bind(globalThis);
    this.retry = options.retry ?? {};
  }

  async search(
    input: FirecrawlSearchInput,
    options: FirecrawlCallOptions = {},
  ): Promise<FirecrawlSearchOutput> {
    const response = await this.request(
      "/search",
      {
        query: input.query,
        limit: input.limit,
        sources: ["web"],
        timeout: SEARCH_TIMEOUT_MS,
        ...(input.tbs ? { tbs: input.tbs } : {}),
        // Deliberately no scrapeOptions: search is link discovery, while the
        // separate scrape tool reads only the pages the model selects.
      },
      searchResponseSchema,
      options.signal,
    );
    return {
      results: response.data.web.map((result) => ({
        title: result.title,
        url: result.url,
        description: result.description,
      })),
      ...(response.creditsUsed === undefined ? {} : { creditsUsed: response.creditsUsed }),
    };
  }

  async scrape(
    input: FirecrawlScrapeInput,
    options: FirecrawlCallOptions = {},
  ): Promise<FirecrawlScrapeOutput> {
    const response = await this.request(
      "/scrape",
      {
        url: input.url,
        formats: ["markdown"],
        onlyMainContent: true,
        proxy: "auto",
        waitFor: 2_000,
        timeout: SCRAPE_TIMEOUT_MS,
        maxAge: input.maxAgeMs ?? FIRECRAWL_CACHE_MAX_AGE_MS,
      },
      scrapeResponseSchema,
      options.signal,
    );
    const metadata = response.data.metadata;
    return {
      url: metadata.url ?? metadata.sourceURL ?? null,
      title: metadata.title ?? null,
      markdown: response.data.markdown ?? "",
      statusCode: metadata.statusCode ?? 0,
      ...(metadata.creditsUsed == null ? {} : { creditsUsed: metadata.creditsUsed }),
      ...(metadata.proxyUsed == null ? {} : { proxyUsed: metadata.proxyUsed }),
      ...(metadata.cacheState == null ? {} : { cacheState: metadata.cacheState }),
    };
  }

  private async request<T>(
    path: string,
    body: Record<string, unknown>,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return withRetry(async () => {
      let response: Response;
      try {
        response = await this.fetcher(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw new FirecrawlError(
          "network",
          0,
          "Firecrawl request could not be sent",
          undefined,
          undefined,
          undefined,
          { cause: error },
        );
      }

      const responseText = await readResponseText(response);
      if (!response.ok) {
        const raw = parseJsonBestEffort(responseText);
        const envelope = errorEnvelopeSchema.safeParse(raw);
        const providerMessage = envelope.success ? envelope.data.error : undefined;
        throw new FirecrawlError(
          "http",
          response.status,
          `Firecrawl request failed (${response.status})`,
          providerMessage ?? (responseText ? responseText.slice(0, 500) : undefined),
          envelope.success ? envelope.data.details : raw ?? responseText.slice(0, 1_000),
          parseRetryAfter(response.headers.get("retry-after")),
        );
      }

      const raw = parseJson(responseText, response.status);
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        throw new FirecrawlError(
          "parse",
          response.status,
          "Firecrawl returned an unexpected response shape",
          undefined,
          parsed.error.issues,
        );
      }
      return parsed.data;
    }, { ...this.retry, ...(signal ? { signal } : {}) });
  }
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw new FirecrawlError(
      "parse",
      response.status,
      "Firecrawl response could not be read",
      undefined,
      undefined,
      undefined,
      { cause: error },
    );
  }
}

function parseJson(text: string, status: number): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new FirecrawlError(
      "parse",
      status,
      "Firecrawl response was not valid JSON",
      undefined,
      undefined,
      undefined,
      { cause: error },
    );
  }
}

function parseJsonBestEffort(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (value == null || !value.trim()) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) return Number(trimmed) * 1_000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

async function withRetry<T>(
  operation: () => Promise<T>,
  options: FirecrawlRetryOptions & { signal?: AbortSignal },
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS);
  const maxDelayMs = Math.max(0, options.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS);
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 1; ; attempt += 1) {
    if (options.signal?.aborted) throw abortReason(options.signal);
    try {
      return await operation();
    } catch (error) {
      if (
        !(error instanceof FirecrawlError) ||
        !error.retryable ||
        attempt >= maxAttempts
      ) throw error;
      if (options.signal?.aborted) throw abortReason(options.signal);
      const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const jittered = backoff / 2 + random() * (backoff / 2);
      const delay = error.retryAfterMs === undefined
        ? jittered
        : Math.min(error.retryAfterMs, maxDelayMs);
      await sleep(delay, options.signal);
    }
  }
}

function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    function onAbort() {
      clearTimeout(timer);
      reject(abortReason(signal));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal?: AbortSignal): unknown {
  if (signal?.reason !== undefined) return signal.reason;
  return new DOMException("The operation was aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}
