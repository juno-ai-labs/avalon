import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAzureModelPricingResolver,
  OPENROUTER_ENDPOINT_AVERAGE_CACHE_KEY,
} from "../src/services/openrouter-pricing-cache";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";

const NOW = Date.UTC(2026, 7, 30, 12);

describe("OpenRouter endpoint-average pricing cache", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("serves a fresh shared KV snapshot without fetching OpenRouter", async () => {
    const get = vi.fn(async () => snapshotJson(NOW - 1_000));
    const put = vi.fn(async (key: string, value: string) => {
      void key;
      void value;
    });
    const fetcher = vi.fn<typeof fetch>();
    const resolver = createAzureModelPricingResolver(
      { INFERENCE_PRICING_CACHE: createCloudflareTestBinding<KVNamespace>({ get, put }) },
      { fetch: fetcher, now: () => NOW },
    );

    const prices = await resolver(["x-ai/grok-4.6"], new AbortController().signal);

    expect(prices.get("x-ai/grok-4.6")).toEqual({
      inputUsdPerM: 2.84,
      cachedInputUsdPerM: 0.71,
      outputUsdPerM: 8.52,
      sourceFingerprint: "openrouter-endpoint-average:v1:x-ai/grok-4.6:5:2.84:0.71:8.52",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("averages every endpoint for both models and stores one shared snapshot", async () => {
    const get = vi.fn(async () => null);
    const put = vi.fn(async (key: string, value: string) => {
      void key;
      void value;
    });
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/x-ai/grok-4.3/endpoints")) {
        return endpointResponse([
          [1.25, 0.2, 2.5],
          [2.5, 0.4, 5],
        ]);
      }
      if (url.endsWith("/x-ai/grok-4.6/endpoints")) {
        return endpointResponse([
          [2, 0.5, 6],
          [4, 1, 12],
          [2.2, 0.55, 6.6],
        ]);
      }
      throw new Error(`Unexpected endpoint: ${url}`);
    });
    const resolver = createAzureModelPricingResolver(
      { INFERENCE_PRICING_CACHE: createCloudflareTestBinding<KVNamespace>({ get, put }) },
      { fetch: fetcher, now: () => NOW },
    );

    const prices = await resolver(
      ["x-ai/grok-4.3", "x-ai/grok-4.6"],
      new AbortController().signal,
    );

    expect(prices.get("x-ai/grok-4.3")?.inputUsdPerM).toBeCloseTo(1.875);
    expect(prices.get("x-ai/grok-4.3")?.cachedInputUsdPerM).toBeCloseTo(0.3);
    expect(prices.get("x-ai/grok-4.3")?.outputUsdPerM).toBeCloseTo(3.75);
    expect(prices.get("x-ai/grok-4.6")?.inputUsdPerM).toBeCloseTo(2.7333333333333334);
    expect(prices.get("x-ai/grok-4.6")?.cachedInputUsdPerM).toBeCloseTo(0.6833333333333333);
    expect(prices.get("x-ai/grok-4.6")?.outputUsdPerM).toBeCloseTo(8.2);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(
      OPENROUTER_ENDPOINT_AVERAGE_CACHE_KEY,
      expect.any(String),
    );
    const stored = JSON.parse(put.mock.calls[0]![1] as string) as {
      fetchedAtMs: number;
      models: Record<string, { endpointCount: number }>;
    };
    expect(stored.fetchedAtMs).toBe(NOW);
    expect(stored.models["x-ai/grok-4.3"]?.endpointCount).toBe(2);
    expect(stored.models["x-ai/grok-4.6"]?.endpointCount).toBe(3);
  });

  it("uses a stale KV snapshot when OpenRouter cannot refresh it", async () => {
    const get = vi.fn(async () => snapshotJson(0));
    const put = vi.fn(async (key: string, value: string) => {
      void key;
      void value;
    });
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error("catalog unavailable");
    });
    const resolver = createAzureModelPricingResolver(
      { INFERENCE_PRICING_CACHE: createCloudflareTestBinding<KVNamespace>({ get, put }) },
      { fetch: fetcher, now: () => NOW },
    );

    const prices = await resolver(["x-ai/grok-4.3"], new AbortController().signal);

    expect(prices.get("x-ai/grok-4.3")?.inputUsdPerM).toBe(1.875);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(put).not.toHaveBeenCalled();
  });

  it("fails closed when neither KV nor OpenRouter has pricing", async () => {
    const get = vi.fn(async () => null);
    const fetcher = vi.fn<typeof fetch>(async () => new Response("unavailable", { status: 503 }));
    const resolver = createAzureModelPricingResolver(
      { INFERENCE_PRICING_CACHE: createCloudflareTestBinding<KVNamespace>({ get }) },
      { fetch: fetcher, now: () => NOW },
    );

    await expect(resolver(["x-ai/grok-4.3"], new AbortController().signal))
      .rejects.toThrow("OpenRouter endpoint catalog failed (503)");
  });
});

function endpointResponse(rates: ReadonlyArray<readonly [number, number, number]>): Response {
  return Response.json({
    data: {
      endpoints: rates.map(([input, cachedInput, output]) => ({
        pricing: {
          prompt: String(input / 1_000_000),
          input_cache_read: String(cachedInput / 1_000_000),
          completion: String(output / 1_000_000),
        },
      })),
    },
  });
}

function snapshotJson(fetchedAtMs: number): string {
  return JSON.stringify({
    version: 1,
    fetchedAtMs,
    models: {
      "x-ai/grok-4.3": {
        inputUsdPerM: 1.875,
        cachedInputUsdPerM: 0.3,
        outputUsdPerM: 3.75,
        endpointCount: 4,
        sourceFingerprint: "openrouter-endpoint-average:v1:x-ai/grok-4.3:4:1.875:0.3:3.75",
      },
      "x-ai/grok-4.6": {
        inputUsdPerM: 2.84,
        cachedInputUsdPerM: 0.71,
        outputUsdPerM: 8.52,
        endpointCount: 5,
        sourceFingerprint: "openrouter-endpoint-average:v1:x-ai/grok-4.6:5:2.84:0.71:8.52",
      },
    },
  });
}
