import { asWorkspaceId } from "@rally/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkstreamWorkflowInput } from "@rally/contracts";
import type { Env } from "../src/env";
import {
  FIRECRAWL_CACHE_MAX_AGE_MS,
  FirecrawlClient,
  parseRetryAfter,
} from "../src/lib/firecrawl";
import type { FirecrawlError } from "../src/lib/firecrawl";
import { __integrationTesting } from "../src/services/integrations";
import { createTestEnv } from "./helpers/cloudflare-test";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-000000000001");
const WORKSTREAM_ID = "00000000-0000-4000-8000-000000000002";
const HARNESS_RUN_ID = "00000000-0000-4000-8000-000000000003";

const workflowInput = {
  region: "global",
  workspaceId: WORKSPACE_ID,
  parentKind: "canvas",
  parentId: WORKSTREAM_ID,
  loopId: `workstream:${WORKSTREAM_ID}:substream:0:loop`,
  harnessRunId: HARNESS_RUN_ID,
  executionPrincipal: { type: "workspace", workspaceId: WORKSPACE_ID },
} as WorkstreamWorkflowInput;

function envWithFirecrawl(
  apiKey: string | undefined,
  overrides: Partial<Env> = {},
): Env {
  return createTestEnv({
    FIRECRAWL_API_KEY: apiKey,
    WEB_SEARCH_MAX_RESULTS: "8",
    WEB_FETCH_MAX_BYTES: "2000000",
    ...overrides,
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function mockFetchResponse(response: Response) {
  return vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Firecrawl API client", () => {
  it("performs link-only v2 search and preserves the provider's ranked order", async () => {
    const fetcher = mockFetchResponse(jsonResponse({
      success: true,
      data: {
        web: [
          { title: "First", url: "https://first.example", description: "One" },
          { title: "Second", url: "https://second.example", description: "Two" },
        ],
      },
      creditsUsed: 2,
    }));
    const client = new FirecrawlClient({
      apiKey: "fc-test-key",
      fetch: fetcher as typeof globalThis.fetch,
    });

    const result = await client.search({ query: "Avalon", limit: 5, tbs: "qdr:w" });

    expect(result.results.map((entry) => entry.title)).toEqual(["First", "Second"]);
    expect(result.creditsUsed).toBe(2);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.firecrawl.dev/v2/search");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fc-test-key");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      query: "Avalon",
      limit: 5,
      sources: ["web"],
      tbs: "qdr:w",
      timeout: 20_000,
    });
    expect(body).not.toHaveProperty("scrapeOptions");
  });

  it("scrapes main-content markdown with bounded freshness and proxy defaults", async () => {
    const fetcher = mockFetchResponse(jsonResponse({
      success: true,
      data: {
        markdown: "# Example",
        metadata: {
          title: "Example",
          sourceURL: "https://example.com/",
          statusCode: 200,
          creditsUsed: 1,
          proxyUsed: "basic",
        },
      },
    }));
    const client = new FirecrawlClient({
      apiKey: "fc-test-key",
      fetch: fetcher as typeof globalThis.fetch,
    });

    const result = await client.scrape({ url: "https://example.com", maxAgeMs: 0 });

    expect(result).toMatchObject({
      url: "https://example.com/",
      title: "Example",
      markdown: "# Example",
      statusCode: 200,
      creditsUsed: 1,
      proxyUsed: "basic",
    });
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      url: "https://example.com",
      formats: ["markdown"],
      onlyMainContent: true,
      proxy: "auto",
      waitFor: 2_000,
      timeout: 25_000,
      maxAge: 0,
    });
  });

  it("asks Firecrawl for uncached branding and returns its favicon URL", async () => {
    const fetcher = mockFetchResponse(jsonResponse({
      success: true,
      data: {
        branding: { images: { favicon: "https://cdn.example.com/icon.svg" } },
        metadata: {
          sourceURL: "https://docs.example.com/",
          url: "https://docs.example.com/introduction",
          statusCode: 200,
        },
      },
    }));
    const client = new FirecrawlClient({
      apiKey: "fc-test-key",
      fetch: fetcher as typeof globalThis.fetch,
    });

    await expect(client.scrapeBranding("https://docs.example.com/"))
      .resolves.toEqual({
        faviconUrl: "https://cdn.example.com/icon.svg",
        url: "https://docs.example.com/introduction",
        statusCode: 200,
      });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      url: "https://docs.example.com/",
      formats: ["branding"],
      onlyMainContent: false,
      proxy: "auto",
      timeout: 25_000,
      maxAge: 0,
      storeInCache: false,
    });
  });

  it("retries transient responses, including a non-JSON 5xx, within Retry-After", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetcher = mockFetchResponse(jsonResponse({ success: true, data: { web: [] } }))
      .mockResolvedValueOnce(new Response("upstream unavailable", {
        status: 503,
        headers: { "retry-after": "1" },
      }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { web: [] },
      }));
    const client = new FirecrawlClient({
      apiKey: "fc-test-key",
      fetch: fetcher as typeof globalThis.fetch,
      retry: { maxAttempts: 2, sleep, random: () => 0 },
    });

    await expect(client.search({ query: "Avalon", limit: 1 })).resolves.toEqual({ results: [] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000, undefined);
  });

  it("rejects malformed successful responses without retrying", async () => {
    const fetcher = mockFetchResponse(jsonResponse({ success: true, data: {} }));
    const client = new FirecrawlClient({
      apiKey: "fc-test-key",
      fetch: fetcher as typeof globalThis.fetch,
      retry: { maxAttempts: 4, sleep: vi.fn(async () => undefined) },
    });

    await expect(client.search({ query: "Avalon", limit: 1 })).rejects.toMatchObject({
      name: "FirecrawlError",
      kind: "parse",
      retryable: false,
    } satisfies Partial<FirecrawlError>);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("parses both Retry-After forms", () => {
    const now = Date.parse("2026-08-01T00:00:00.000Z");
    expect(parseRetryAfter("3", now)).toBe(3_000);
    expect(parseRetryAfter("Sat, 01 Aug 2026 00:00:04 GMT", now)).toBe(4_000);
  });
});

describe("Avalon Firecrawl harness tools", () => {
  it("omits both web tools unless Firecrawl is configured", () => {
    const absent = __integrationTesting
      .createAvalonTools(envWithFirecrawl(undefined), workflowInput)
      .filter((tool) => tool.definition.capability.startsWith("web."))
      .map((tool) => tool.definition.name);
    const present = __integrationTesting
      .createAvalonTools(envWithFirecrawl("fc-test-key"), workflowInput)
      .filter((tool) => tool.definition.capability.startsWith("web."))
      .map((tool) => tool.definition.name);

    expect(absent).not.toContain("search");
    expect(absent).not.toContain("fetch");
    expect(present).toContain("search");
    expect(present).toContain("fetch");
  });

  it("packages public-web tools as one loadable Avalon plugin", () => {
    const tools = __integrationTesting
      .createAvalonTools(envWithFirecrawl("fc-test-key"), workflowInput);
    const plugin = __integrationTesting.createAvalonWebPlugin(tools);

    expect(plugin).toMatchObject({
      canonicalId: "rally:web",
      modelId: "rally_web",
      shortWireName: "web",
      preload: false,
      explicit: false,
    });
    expect(plugin?.tools.map((tool) => tool.definition)).toEqual([
      expect.objectContaining({ name: "search", capability: "web.search", mode: "read", idempotency: "safe" }),
      expect.objectContaining({ name: "fetch", capability: "web.fetch", mode: "read", idempotency: "safe" }),
    ]);
  });

  it("gives an inbound-email run the same web tools as any other run", () => {
    // Deliberately the inverse of what this asserted before. The trigger no
    // longer decides the tool surface: mail reaches a run only after the sender
    // has resolved to an active workspace member, and a `connector_activity`
    // run reading an equally untrusted third-party page was never restricted,
    // so stripping one channel described a boundary the system did not have.
    // Pinned rather than deleted, because the comment it replaced read like an
    // invariant and the next person to see a mail-triggered run holding `fetch`
    // should find this instead of re-adding the filter.
    const tools = __integrationTesting
      .createAvalonTools(envWithFirecrawl("fc-test-key"), {
        ...workflowInput,
        reason: "inbound_email",
      })
      .filter((tool) => tool.definition.capability.startsWith("web.")
        || tool.definition.capability.startsWith("workstream.")
        || tool.definition.capability.startsWith("resource."))
      .map((tool) => tool.definition.name);

    expect(tools).toContain("search");
    expect(tools).toContain("fetch");
    expect(tools).toContain("list_resources");
    expect(tools).toContain("read_resource");
    expect(tools).toContain("search_resource");
  });

  it("returns link-only search output without exposing Firecrawl credit telemetry", async () => {
    const fetcher = mockFetchResponse(jsonResponse({
      success: true,
      data: {
        web: [{ title: "Avalon", url: "https://example.com", description: "Result" }],
      },
      creditsUsed: 7,
    }));
    vi.stubGlobal("fetch", fetcher);
    const tool = __integrationTesting
      .createAvalonTools(envWithFirecrawl("fc-test-key"), workflowInput)
      .find((candidate) => candidate.definition.name === "search");
    expect(tool).toBeDefined();

    const result = await tool!.execute(
      { query: "Avalon", recency: "month" },
      {
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        harnessRunId: HARNESS_RUN_ID,
        toolCallId: "tool-firecrawl-search",
        executionPrincipal: { type: "workspace", workspaceId: WORKSPACE_ID },
        signal: new AbortController().signal,
      },
    );

    expect(result.output).toEqual({
      query: "Avalon",
      results: [{ title: "Avalon", url: "https://example.com", description: "Result" }],
    });
    expect(result.output).not.toHaveProperty("creditsUsed");
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ limit: 5, tbs: "qdr:m" });
  });

  it("uses Firecrawl for page reads, forces freshness on request, and bounds markdown", async () => {
    const fetcher = mockFetchResponse(jsonResponse({
      success: true,
      data: {
        markdown: "0123456789abcdefghijklmnopqrstuvwxyz",
        metadata: {
          title: "Example",
          sourceURL: "https://example.com/",
          statusCode: 200,
          creditsUsed: 5,
        },
      },
    }));
    vi.stubGlobal("fetch", fetcher);
    const tool = __integrationTesting
      .createAvalonTools(envWithFirecrawl("fc-test-key", {
        WEB_FETCH_MAX_BYTES: "12",
      }), workflowInput)
      .find((candidate) => candidate.definition.name === "fetch");
    expect(tool).toBeDefined();

    const result = await tool!.execute(
      { url: "https://example.com", must_be_fresh: true },
      {
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        harnessRunId: HARNESS_RUN_ID,
        toolCallId: "tool-firecrawl-fresh-fetch",
        executionPrincipal: { type: "workspace", workspaceId: WORKSPACE_ID },
        signal: new AbortController().signal,
      },
    );

    expect(result.output).toEqual({
      url: "https://example.com/",
      title: "Example",
      markdown: "0123456789ab",
      statusCode: 200,
      truncated: true,
      totalChars: 36,
    });
    expect(result.output).not.toHaveProperty("creditsUsed");
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.maxAge).toBe(0);
  });

  it("uses the two-day cache window by default", async () => {
    const fetcher = mockFetchResponse(jsonResponse({
      success: true,
      data: { markdown: "ok", metadata: { sourceURL: "https://example.com" } },
    }));
    vi.stubGlobal("fetch", fetcher);
    const tool = __integrationTesting
      .createAvalonTools(envWithFirecrawl("fc-test-key"), workflowInput)
      .find((candidate) => candidate.definition.name === "fetch");

    await tool!.execute(
      { url: "https://example.com" },
      {
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        harnessRunId: HARNESS_RUN_ID,
        toolCallId: "tool-firecrawl-cached-fetch",
        executionPrincipal: { type: "workspace", workspaceId: WORKSPACE_ID },
        signal: new AbortController().signal,
      },
    );

    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.maxAge).toBe(FIRECRAWL_CACHE_MAX_AGE_MS);
  });
});
