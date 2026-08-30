import {
  OPENROUTER_CATALOG_CACHE_TTL_MS,
  type AzureModelPricing,
  type RunHarnessInput,
} from "@rally/agent-harness";
import { z } from "zod";
import type { Env } from "../env";

export const OPENROUTER_ENDPOINT_AVERAGE_CACHE_KEY =
  "inference-pricing:openrouter-endpoint-average:v1";

const OPENROUTER_ENDPOINTS = {
  "x-ai/grok-4.3": "https://openrouter.ai/api/v1/models/x-ai/grok-4.3/endpoints",
  "x-ai/grok-4.6": "https://openrouter.ai/api/v1/models/x-ai/grok-4.6/endpoints",
} as const;

type CachedModelId = keyof typeof OPENROUTER_ENDPOINTS;

const ModelPricingSchema = z.object({
  inputUsdPerM: z.number().finite().nonnegative(),
  cachedInputUsdPerM: z.number().finite().nonnegative(),
  outputUsdPerM: z.number().finite().nonnegative(),
  endpointCount: z.number().int().positive(),
  sourceFingerprint: z.string().startsWith("openrouter-endpoint-average:v1:"),
});

const PricingSnapshotSchema = z.object({
  version: z.literal(1),
  fetchedAtMs: z.number().int().nonnegative(),
  models: z.object({
    "x-ai/grok-4.3": ModelPricingSchema,
    "x-ai/grok-4.6": ModelPricingSchema,
  }),
});

const EndpointEnvelopeSchema = z.object({
  data: z.object({
    endpoints: z.array(z.object({
      pricing: z.object({
        prompt: z.string(),
        completion: z.string(),
        input_cache_read: z.string(),
      }).passthrough(),
    }).passthrough()).min(1),
  }).passthrough(),
});

type PricingSnapshot = z.infer<typeof PricingSnapshotSchema>;

interface PricingCacheOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export function createAzureModelPricingResolver(
  env: Pick<Env, "INFERENCE_PRICING_CACHE">,
  options: PricingCacheOptions = {},
): NonNullable<RunHarnessInput["resolveAzureModelPricing"]> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  return async (canonicalModelIds, signal) => {
    const snapshot = await loadPricingSnapshot(env.INFERENCE_PRICING_CACHE, fetcher, now, signal);
    const resolved = new Map<string, AzureModelPricing>();
    for (const modelId of canonicalModelIds) {
      if (!isCachedModelId(modelId)) continue;
      const pricing = snapshot.models[modelId];
      resolved.set(modelId, {
        inputUsdPerM: pricing.inputUsdPerM,
        cachedInputUsdPerM: pricing.cachedInputUsdPerM,
        outputUsdPerM: pricing.outputUsdPerM,
        sourceFingerprint: pricing.sourceFingerprint,
      });
    }
    return resolved;
  };
}

async function loadPricingSnapshot(
  cache: KVNamespace,
  fetcher: typeof globalThis.fetch,
  now: () => number,
  signal: AbortSignal,
): Promise<PricingSnapshot> {
  const cached = parseCachedSnapshot(await cache.get(OPENROUTER_ENDPOINT_AVERAGE_CACHE_KEY));
  const currentTime = now();
  if (cached && currentTime >= cached.fetchedAtMs
    && currentTime - cached.fetchedAtMs < OPENROUTER_CATALOG_CACHE_TTL_MS) {
    return cached;
  }

  try {
    const refreshed = await fetchPricingSnapshot(fetcher, currentTime, signal);
    // Pricing remains usable even if two regions race the same-key KV write or
    // KV is temporarily unavailable. The next run will retry persistence.
    try {
      await cache.put(OPENROUTER_ENDPOINT_AVERAGE_CACHE_KEY, JSON.stringify(refreshed));
    } catch {
      // Best-effort cache population; the provider response is authoritative.
    }
    return refreshed;
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    if (cached) return cached;
    throw error;
  }
}

async function fetchPricingSnapshot(
  fetcher: typeof globalThis.fetch,
  fetchedAtMs: number,
  signal: AbortSignal,
): Promise<PricingSnapshot> {
  const pairs = await Promise.all(
    Object.entries(OPENROUTER_ENDPOINTS).map(async ([modelId, url]) => {
      const response = await fetcher(url, { headers: { accept: "application/json" }, signal });
      if (!response.ok) throw new Error(`OpenRouter endpoint catalog failed (${response.status})`);
      const envelope = EndpointEnvelopeSchema.parse(await response.json());
      return [modelId, averageEndpointPricing(modelId as CachedModelId, envelope.data.endpoints)] as const;
    }),
  );
  return PricingSnapshotSchema.parse({
    version: 1,
    fetchedAtMs,
    models: Object.fromEntries(pairs),
  });
}

function averageEndpointPricing(
  modelId: CachedModelId,
  endpoints: z.infer<typeof EndpointEnvelopeSchema>["data"]["endpoints"],
) {
  const prices = endpoints.map((endpoint) => ({
    input: perTokenPrice(endpoint.pricing.prompt),
    cachedInput: perTokenPrice(endpoint.pricing.input_cache_read),
    output: perTokenPrice(endpoint.pricing.completion),
  }));
  const endpointCount = prices.length;
  const inputUsdPerM = mean(prices.map((price) => price.input)) * 1_000_000;
  const cachedInputUsdPerM = mean(prices.map((price) => price.cachedInput)) * 1_000_000;
  const outputUsdPerM = mean(prices.map((price) => price.output)) * 1_000_000;
  return {
    inputUsdPerM,
    cachedInputUsdPerM,
    outputUsdPerM,
    endpointCount,
    sourceFingerprint: [
      "openrouter-endpoint-average:v1",
      modelId,
      endpointCount,
      inputUsdPerM,
      cachedInputUsdPerM,
      outputUsdPerM,
    ].join(":"),
  };
}

function perTokenPrice(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("OpenRouter returned an invalid token price");
  return parsed;
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function parseCachedSnapshot(value: string | null): PricingSnapshot | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    const result = PricingSnapshotSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function isCachedModelId(modelId: string): modelId is CachedModelId {
  return Object.hasOwn(OPENROUTER_ENDPOINTS, modelId);
}
