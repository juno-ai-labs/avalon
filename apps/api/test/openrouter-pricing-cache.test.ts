import { beforeEach, describe, expect, it, vi } from "vitest";

import { inferencePricingWorker } from "../src/inference-pricing-worker";
import {
  AZURE_DEPLOYED_OPENROUTER_MODEL_IDS,
  calculateAzureImageCostUsd,
  createAzureModelPricingResolver,
  loadAzureImageModelPricing,
  OPENROUTER_PRICING_MODEL_IDS,
  refreshOpenRouterPricingCache,
} from "../src/services/openrouter-pricing-cache";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";

const NOW = Date.UTC(2026, 7, 30, 12);
const EXPECTED_MODEL_IDS = [
  "x-ai/grok-4.7",
  "x-ai/grok-4.6",
  "x-ai/grok-4.5",
  "google/gemini-4-argon",
  "google/gemini-3.8-flash",
  "google/gemini-3.7-flash",
  "openai/gpt-6.1-sol",
  "openai/gpt-6-luna",
  "openai/gpt-5.6-sol",
  "anthropic/claude-opus-5.5",
  "anthropic/claude-sonnet-5.5",
  "deepseek/deepseek-v4.1-flash-1017",
  "deepseek/deepseek-v4.1-flash",
  "deepseek/deepseek-v4-pro",
  "x-ai/grok-4.3",
  "openai/gpt-5.6-terra",
  "deepseek/deepseek-v4-flash-0731",
  "openai/text-embedding-3-large",
  "openai/gpt-image-2",
  "black-forest-labs/flux.2-flex",
];

describe("OpenRouter endpoint-average pricing cache", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("covers every developer choice and every Azure deployment with an OpenRouter id", () => {
    expect(OPENROUTER_PRICING_MODEL_IDS).toEqual(EXPECTED_MODEL_IDS);
    expect(AZURE_DEPLOYED_OPENROUTER_MODEL_IDS).toEqual([
      "x-ai/grok-4.3",
      "x-ai/grok-4.6",
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-terra",
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4-flash-0731",
      "openai/text-embedding-3-large",
      "openai/gpt-image-2",
      "black-forest-labs/flux.2-flex",
    ]);
  });

  it("reads a model-id KV key and converts decimal strings at the billing boundary", async () => {
    const get = vi.fn(async () => pricingJson("x-ai/grok-4.6", NOW - 1_000));
    const put = vi.fn(async (key: string, value: string) => {
      void key;
      void value;
    });
    const resolver = createAzureModelPricingResolver({
      INFERENCE_PRICING_CACHE: createCloudflareTestBinding<KVNamespace>({ get, put }),
    });

    const prices = await resolver(["x-ai/grok-4.6"], new AbortController().signal);

    expect(get).toHaveBeenCalledWith("x-ai/grok-4.6");
    expect(prices.get("x-ai/grok-4.6")).toEqual({
      inputUsdPerM: 2.84,
      cachedInputUsdPerM: 0.71,
      outputUsdPerM: 8.52,
      overrides: [{
        minPromptTokens: 200_000,
        inputUsdPerM: 5.68,
        cachedInputUsdPerM: 1.42,
        outputUsdPerM: 17.04,
      }],
      sourceFingerprint: "openrouter-endpoint-average:v2:x-ai/grok-4.6:5:2.84:0.71:8.52:200000:5.68:1.42:17.04",
    });
    expect(put).not.toHaveBeenCalled();
  });

  it("writes one string-valued KV record per canonical OpenRouter model id", async () => {
    const put = vi.fn(async (key: string, value: string) => {
      void key;
      void value;
    });
    const fetcher = catalogFetcher();

    const result = await refreshOpenRouterPricingCache(
      { INFERENCE_PRICING_CACHE: createCloudflareTestBinding<KVNamespace>({ put }) },
      { fetch: fetcher, now: () => NOW },
    );

    expect(fetcher).toHaveBeenCalledTimes(EXPECTED_MODEL_IDS.length);
    expect(put).toHaveBeenCalledTimes(EXPECTED_MODEL_IDS.length);
    expect(put.mock.calls.map(([key]) => key)).toEqual(EXPECTED_MODEL_IDS);
    const grok43Call = put.mock.calls.find(([key]) => key === "x-ai/grok-4.3");
    expect(grok43Call).toBeDefined();
    const stored = JSON.parse(String(grok43Call![1])) as Record<string, unknown>;
    expect(stored).toEqual({
      version: 2,
      fetchedAtMs: NOW,
      inputUsdPerM: "1.875",
      cachedInputUsdPerM: "0.3",
      outputUsdPerM: "3.75",
      overrides: [{
        minPromptTokens: 200_000,
        inputUsdPerM: "3.75",
        cachedInputUsdPerM: "0.6",
        outputUsdPerM: "7.5",
      }],
      endpointCount: 2,
      sourceFingerprint: "openrouter-endpoint-average:v2:x-ai/grok-4.3:2:1.875:0.3:3.75:200000:3.75:0.6:7.5",
    });
    expect(stored).not.toHaveProperty("models");
    expect(result.models["x-ai/grok-4.6"]).toMatchObject({
      inputUsdPerM: "2.7333333333333334",
      cachedInputUsdPerM: "0.6833333333333333",
      outputUsdPerM: "8.2",
    });
    expect(result.models["deepseek/deepseek-v4-flash-0731"]).toMatchObject({
      cachedInputUsdPerM: "1",
    });
    expect(result.models["openai/gpt-image-2"]).toMatchObject({
      costs: [
        { billable: "input_image", unit: "token", costUsd: "0.000008", endpointCount: 1 },
        { billable: "input_text", unit: "token", costUsd: "0.000005", endpointCount: 1 },
        { billable: "output_image", unit: "token", costUsd: "0.00003", endpointCount: 1 },
      ],
    });
    expect(result.models["black-forest-labs/flux.2-flex"]).toMatchObject({
      costs: [
        { billable: "input_image", unit: "megapixel", costUsd: "0.06", endpointCount: 1 },
        { billable: "output_image", unit: "megapixel", costUsd: "0.06", endpointCount: 1 },
      ],
    });
  });

  it("continues to use stale valid pricing without performing a refresh", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const get = vi.fn(async () => pricingJson("x-ai/grok-4.3", 0));
    const resolver = createAzureModelPricingResolver({
      INFERENCE_PRICING_CACHE: createCloudflareTestBinding<KVNamespace>({ get }),
    });

    const prices = await resolver(["x-ai/grok-4.3"], new AbortController().signal);

    expect(prices.get("x-ai/grok-4.3")?.inputUsdPerM).toBe(1.875);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reads image prices from the model-id KV key and calculates token cost exactly", async () => {
    const get = vi.fn(async () => JSON.stringify({
      version: 1,
      fetchedAtMs: NOW,
      costs: [
        { billable: "input_image", unit: "token", costUsd: "0.000008", endpointCount: 1 },
        { billable: "input_text", unit: "token", costUsd: "0.000005", endpointCount: 1 },
        { billable: "output_image", unit: "token", costUsd: "0.00003", endpointCount: 1 },
      ],
      endpointCount: 1,
      sourceFingerprint: "openrouter-endpoint-average:v1:openai/gpt-image-2:1",
    }));
    const pricing = await loadAzureImageModelPricing({
      INFERENCE_PRICING_CACHE: createCloudflareTestBinding<KVNamespace>({ get }),
    }, "openai/gpt-image-2");

    expect(get).toHaveBeenCalledWith("openai/gpt-image-2");
    expect(calculateAzureImageCostUsd(pricing, {
      input_text: 100,
      input_image: 50,
      output_image: 1_000,
    })).toBe("0.0309");
  });

  it("omits a missing or legacy numeric-price record without dropping valid peers", async () => {
    const missingResolver = createAzureModelPricingResolver({
      INFERENCE_PRICING_CACHE: createCloudflareTestBinding<KVNamespace>({
        get: vi.fn(async () => null),
      }),
    });
    await expect(missingResolver(["x-ai/grok-4.3"], new AbortController().signal))
      .resolves.toEqual(new Map());

    const numericResolver = createAzureModelPricingResolver({
      INFERENCE_PRICING_CACHE: createCloudflareTestBinding<KVNamespace>({
        get: vi.fn(async () => pricingJson("x-ai/grok-4.3", NOW, true)),
      }),
    });
    await expect(numericResolver(["x-ai/grok-4.3"], new AbortController().signal))
      .resolves.toEqual(new Map());

    const mixedGet = vi.fn(async (modelId: string) => modelId === "x-ai/grok-4.3"
      ? pricingJson(modelId, NOW)
      : null) as unknown as KVNamespace["get"];
    const mixedResolver = createAzureModelPricingResolver({
      INFERENCE_PRICING_CACHE: createCloudflareTestBinding<KVNamespace>({
        get: mixedGet,
      }),
    });
    const mixed = await mixedResolver(
      ["x-ai/grok-4.3", "openai/gpt-5.6-sol"],
      new AbortController().signal,
    );
    expect([...mixed.keys()]).toEqual(["x-ai/grok-4.3"]);
    expect(mixed.get("x-ai/grok-4.3")?.inputUsdPerM).toBe(1.875);
  });

  it("does not write any records unless every catalog response succeeds", async () => {
    const put = vi.fn(async (key: string, value: string) => {
      void key;
      void value;
    });
    const fetcher = catalogFetcher("google/gemini-3.7-flash");

    await expect(refreshOpenRouterPricingCache(
      { INFERENCE_PRICING_CACHE: createCloudflareTestBinding<KVNamespace>({ put }) },
      { fetch: fetcher, now: () => NOW },
    )).rejects.toThrow("OpenRouter endpoint catalog failed for google/gemini-3.7-flash (503)");
    expect(put).not.toHaveBeenCalled();
  });

  it("refreshes all model records from the dedicated scheduled handler", async () => {
    const put = vi.fn(async (key: string, value: string) => {
      void key;
      void value;
    });
    const fetcher = catalogFetcher();
    vi.stubGlobal("fetch", fetcher);
    const controller = createCloudflareTestBinding<ScheduledController>({
      cron: "0 * * * *",
      scheduledTime: NOW,
      noRetry: vi.fn(),
    });

    await inferencePricingWorker.scheduled(controller, {
      INFERENCE_PRICING_CACHE: createCloudflareTestBinding<KVNamespace>({
        put,
        get: vi.fn(async () => ({ version: 1, fetchedAtMs: NOW, windows: { "test/model": 100 } })),
      }),
    });

    expect(fetcher).toHaveBeenCalledTimes(EXPECTED_MODEL_IDS.length);
    expect(put).toHaveBeenCalledTimes(EXPECTED_MODEL_IDS.length);
  });
});

function catalogFetcher(failingModelId?: string) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    const modelId = EXPECTED_MODEL_IDS.find((candidate) => url.endsWith(`/${candidate}/endpoints`));
    if (!modelId) throw new Error(`Unexpected endpoint: ${url}`);
    if (modelId === failingModelId) return new Response("unavailable", { status: 503 });
    if (modelId === "x-ai/grok-4.3") {
      return endpointResponse([
        ["0.00000125", "0.0000002", "0.0000025", [
          [200_000, "0.0000025", "0.0000004", "0.000005"],
        ]],
        ["0.0000025", "0.0000004", "0.000005", [
          [200_000, "0.000005", "0.0000008", "0.00001"],
        ]],
      ]);
    }
    if (modelId === "x-ai/grok-4.6") {
      return endpointResponse([
        ["0.000002", "0.0000005", "0.000006", [
          [200_000, "0.000004", "0.000001", "0.000012"],
        ]],
        ["0.000004", "0.000001", "0.000012", [
          [200_000, "0.000008", "0.000002", "0.000024"],
        ]],
        ["0.0000022", "0.00000055", "0.0000066", [
          [200_000, "0.0000044", "0.0000011", "0.0000132"],
        ]],
      ]);
    }
    if (modelId === "deepseek/deepseek-v4-flash-0731") {
      return Response.json({
        data: {
          endpoints: [{
            pricing: {
              prompt: "0.000001",
              completion: "0.000002",
              // OpenRouter also publishes time-of-day overrides. They are not
              // prompt-size tiers and must not make the shared refresh fail.
              overrides: [{
                utc_start: 0,
                utc_end: 1_400,
                prompt: "0.000000352",
                completion: "0.000001056",
                input_cache_read: "0.0000000352",
              }],
            },
          }],
        },
      });
    }
    if (modelId === "openai/gpt-image-2") {
      return imageEndpointResponse([
        ["input_image", "token", 0.000008],
        ["input_text", "token", 0.000005],
        ["output_image", "token", 0.00003],
      ]);
    }
    if (modelId === "black-forest-labs/flux.2-flex") {
      return imageEndpointResponse([
        ["input_image", "megapixel", 0.06],
        ["output_image", "megapixel", 0.06],
      ]);
    }
    return endpointResponse([["0.000001", "0.0000001", "0.000002"]]);
  });
}

function endpointResponse(
  rates: ReadonlyArray<readonly [
    string,
    string | null,
    string,
    ReadonlyArray<readonly [number, string, string | null, string]>?,
  ]>,
): Response {
  return Response.json({
    data: {
      endpoints: rates.map(([input, cachedInput, output, overrides = []]) => ({
        pricing: {
          prompt: input,
          ...(cachedInput === null
            ? {}
            : { input_cache_read: cachedInput }),
          completion: output,
          overrides: overrides.map(([minPromptTokens, overrideInput, overrideCachedInput, overrideOutput]) => ({
            min_prompt_tokens: minPromptTokens,
            prompt: overrideInput,
            ...(overrideCachedInput === null
              ? { input_cache_read: null }
              : { input_cache_read: overrideCachedInput }),
            completion: overrideOutput,
          })),
        },
      })),
    },
  });
}

function imageEndpointResponse(
  rates: ReadonlyArray<readonly [string, string, number]>,
): Response {
  return Response.json({
    endpoints: [{
      pricing: rates.map(([billable, unit, costUsd]) => ({
        billable,
        unit,
        cost_usd: costUsd,
      })),
    }],
  });
}

function pricingJson(modelId: string, fetchedAtMs: number, numeric = false): string {
  const values = modelId === "x-ai/grok-4.6"
    ? ["2.84", "0.71", "8.52", "5.68", "1.42", "17.04", 5]
    : ["1.875", "0.3", "3.75", "3.75", "0.6", "7.5", 4];
  const [
    inputUsdPerM,
    cachedInputUsdPerM,
    outputUsdPerM,
    overrideInputUsdPerM,
    overrideCachedInputUsdPerM,
    overrideOutputUsdPerM,
    endpointCount,
  ] = values;
  return JSON.stringify({
    version: 2,
    fetchedAtMs,
    inputUsdPerM: numeric ? Number(inputUsdPerM) : inputUsdPerM,
    cachedInputUsdPerM: numeric ? Number(cachedInputUsdPerM) : cachedInputUsdPerM,
    outputUsdPerM: numeric ? Number(outputUsdPerM) : outputUsdPerM,
    overrides: [{
      minPromptTokens: 200_000,
      inputUsdPerM: numeric ? Number(overrideInputUsdPerM) : overrideInputUsdPerM,
      cachedInputUsdPerM: numeric ? Number(overrideCachedInputUsdPerM) : overrideCachedInputUsdPerM,
      outputUsdPerM: numeric ? Number(overrideOutputUsdPerM) : overrideOutputUsdPerM,
    }],
    endpointCount,
    sourceFingerprint: [
      "openrouter-endpoint-average:v2",
      modelId,
      endpointCount,
      inputUsdPerM,
      cachedInputUsdPerM,
      outputUsdPerM,
      200_000,
      overrideInputUsdPerM,
      overrideCachedInputUsdPerM,
      overrideOutputUsdPerM,
    ].join(":"),
  });
}
