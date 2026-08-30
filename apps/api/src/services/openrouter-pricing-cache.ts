import {
  type AzureModelPricing,
  type RunHarnessInput,
} from "@rally/agent-harness";
import { AGENT_MODEL_OVERRIDES } from "@rally/contracts";
import { z } from "zod";
import type { Env } from "../env";

/**
 * The Monad production Azure deployments that also have OpenRouter chat-model
 * identities. Realtime transcription is absent because OpenRouter does not
 * assign that deployment a model id.
 */
export const AZURE_DEPLOYED_OPENROUTER_MODEL_IDS = [
  "x-ai/grok-4.3",
  "x-ai/grok-4.6",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash-0731",
  "openai/text-embedding-3-large",
  "openai/gpt-image-2",
  "black-forest-labs/flux.2-flex",
] as const;

/** Every developer-selectable model plus every Azure deployment OpenRouter carries. */
export const OPENROUTER_PRICING_MODEL_IDS = Array.from(new Set([
  ...AGENT_MODEL_OVERRIDES,
  ...AZURE_DEPLOYED_OPENROUTER_MODEL_IDS,
]));
const OPENROUTER_PRICING_MODEL_ID_SET = new Set<string>(OPENROUTER_PRICING_MODEL_IDS);
const OPENROUTER_IMAGE_MODEL_ID_SET = new Set<string>([
  "openai/gpt-image-2",
  "black-forest-labs/flux.2-flex",
]);

const OPENROUTER_ENDPOINTS_BASE_URL = "https://openrouter.ai/api/v1/models";

const DecimalStringSchema = z.string().refine((value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0;
}, "Expected a non-negative decimal string");

const CachedTokenModelPricingSchema = z.object({
  version: z.literal(1),
  fetchedAtMs: z.number().int().nonnegative(),
  inputUsdPerM: DecimalStringSchema,
  cachedInputUsdPerM: DecimalStringSchema,
  outputUsdPerM: DecimalStringSchema,
  endpointCount: z.number().int().positive(),
  sourceFingerprint: z.string().startsWith("openrouter-endpoint-average:v1:"),
});

const CachedImageModelPricingSchema = z.object({
  version: z.literal(1),
  fetchedAtMs: z.number().int().nonnegative(),
  costs: z.array(z.object({
    billable: z.string().min(1),
    unit: z.string().min(1),
    costUsd: DecimalStringSchema,
    endpointCount: z.number().int().positive(),
    variant: z.string().min(1).optional(),
  })).min(1),
  endpointCount: z.number().int().positive(),
  sourceFingerprint: z.string().startsWith("openrouter-endpoint-average:v1:"),
});

const EndpointEnvelopeSchema = z.object({
  data: z.object({
    endpoints: z.array(z.object({
      pricing: z.object({
        prompt: z.string(),
        completion: z.string(),
        input_cache_read: z.string().nullish(),
      }).passthrough(),
    }).passthrough()).min(1),
  }).passthrough(),
});

const ImageEndpointEnvelopeSchema = z.object({
  endpoints: z.array(z.object({
    pricing: z.array(z.object({
      billable: z.string().min(1),
      unit: z.string().min(1),
      cost_usd: z.union([z.number().finite().nonnegative(), DecimalStringSchema]),
      variant: z.string().nullish(),
    }).passthrough()).min(1),
  }).passthrough()).min(1),
}).passthrough();

type CachedModelPricing =
  | z.infer<typeof CachedTokenModelPricingSchema>
  | z.infer<typeof CachedImageModelPricingSchema>;

export interface PricingRefreshResult {
  fetchedAtMs: number;
  models: Readonly<Record<string, CachedModelPricing>>;
}

interface PricingRefreshOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export function createAzureModelPricingResolver(
  env: Pick<Env, "INFERENCE_PRICING_CACHE">,
): NonNullable<RunHarnessInput["resolveAzureModelPricing"]> {
  return async (canonicalModelIds) => {
    const requestedModelIds = Array.from(new Set(
      canonicalModelIds.filter(isPricingModelId),
    ));
    const cachedEntries = await Promise.all(requestedModelIds.map(async (modelId) => [
      modelId,
      parseCachedTokenModelPricing(await env.INFERENCE_PRICING_CACHE.get(modelId)),
    ] as const));

    const resolved = new Map<string, AzureModelPricing>();
    for (const [modelId, pricing] of cachedEntries) {
      if (!pricing) throw new Error(`Azure model pricing cache is unavailable for ${modelId}`);
      resolved.set(modelId, {
        inputUsdPerM: Number(pricing.inputUsdPerM),
        cachedInputUsdPerM: Number(pricing.cachedInputUsdPerM),
        outputUsdPerM: Number(pricing.outputUsdPerM),
        sourceFingerprint: pricing.sourceFingerprint,
      });
    }
    return resolved;
  };
}

export async function refreshOpenRouterPricingCache(
  env: Pick<Env, "INFERENCE_PRICING_CACHE">,
  options: PricingRefreshOptions = {},
): Promise<PricingRefreshResult> {
  const fetchedAtMs = (options.now ?? Date.now)();
  const pairs = await Promise.all(OPENROUTER_PRICING_MODEL_IDS.map(async (modelId) => [
    modelId,
    await fetchModelPricing(options.fetch ?? globalThis.fetch, modelId, fetchedAtMs),
  ] as const));

  // Do not replace any stale record until every OpenRouter response has been
  // validated. KV has no transaction, but catalog failure cannot create a
  // deliberately mixed refresh generation this way.
  await Promise.all(pairs.map(([modelId, pricing]) => (
    env.INFERENCE_PRICING_CACHE.put(modelId, JSON.stringify(pricing))
  )));

  return { fetchedAtMs, models: Object.fromEntries(pairs) };
}

async function fetchModelPricing(
  fetcher: typeof globalThis.fetch,
  modelId: string,
  fetchedAtMs: number,
): Promise<CachedModelPricing> {
  if (OPENROUTER_IMAGE_MODEL_ID_SET.has(modelId)) {
    return fetchImageModelPricing(fetcher, modelId, fetchedAtMs);
  }
  const response = await fetcher(`${OPENROUTER_ENDPOINTS_BASE_URL}/${modelId}/endpoints`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`OpenRouter endpoint catalog failed for ${modelId} (${response.status})`);
  const envelope = EndpointEnvelopeSchema.parse(await response.json());
  return CachedTokenModelPricingSchema.parse({
    version: 1,
    fetchedAtMs,
    ...averageEndpointPricing(modelId, envelope.data.endpoints),
  });
}

async function fetchImageModelPricing(
  fetcher: typeof globalThis.fetch,
  modelId: string,
  fetchedAtMs: number,
): Promise<CachedModelPricing> {
  const response = await fetcher(`https://openrouter.ai/api/v1/images/models/${modelId}/endpoints`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`OpenRouter endpoint catalog failed for ${modelId} (${response.status})`);
  const envelope = ImageEndpointEnvelopeSchema.parse(await response.json());
  const costs = averageImageCosts(envelope.endpoints);
  const endpointCount = envelope.endpoints.length;
  return CachedImageModelPricingSchema.parse({
    version: 1,
    fetchedAtMs,
    costs,
    endpointCount,
    sourceFingerprint: [
      "openrouter-endpoint-average:v1",
      modelId,
      endpointCount,
      ...costs.map((cost) => [
        cost.billable,
        cost.unit,
        cost.variant ?? "",
        cost.endpointCount,
        cost.costUsd,
      ].join(":")),
    ].join(":"),
  });
}

function averageImageCosts(
  endpoints: z.infer<typeof ImageEndpointEnvelopeSchema>["endpoints"],
) {
  const groups = new Map<string, {
    billable: string;
    unit: string;
    variant?: string;
    values: string[];
  }>();
  for (const endpoint of endpoints) {
    for (const price of endpoint.pricing) {
      const variant = price.variant ?? undefined;
      const key = JSON.stringify([price.billable, price.unit, variant]);
      const group = groups.get(key) ?? {
        billable: price.billable,
        unit: price.unit,
        ...(variant ? { variant } : {}),
        values: [],
      };
      group.values.push(String(price.cost_usd));
      groups.set(key, group);
    }
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => ({
      billable: group.billable,
      unit: group.unit,
      costUsd: averageDecimal(group.values),
      endpointCount: group.values.length,
      ...(group.variant ? { variant: group.variant } : {}),
    }));
}

function averageEndpointPricing(
  modelId: string,
  endpoints: z.infer<typeof EndpointEnvelopeSchema>["data"]["endpoints"],
) {
  const endpointCount = endpoints.length;
  const inputUsdPerM = averageUsdPerMillion(endpoints.map((endpoint) => endpoint.pricing.prompt));
  const cachedInputUsdPerM = averageUsdPerMillion(endpoints.map((endpoint) => (
    endpoint.pricing.input_cache_read ?? endpoint.pricing.prompt
  )));
  const outputUsdPerM = averageUsdPerMillion(endpoints.map((endpoint) => endpoint.pricing.completion));
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

/** Average decimal prices without first introducing binary floating-point noise. */
function averageUsdPerMillion(values: readonly string[]): string {
  return averageDecimal(values, 1_000_000n);
}

function averageDecimal(values: readonly string[], multiplier = 1n): string {
  const parsed = values.map(parseDecimal);
  const commonScale = Math.max(...parsed.map((value) => value.scale));
  const sum = parsed.reduce((total, value) => (
    total + value.integer * 10n ** BigInt(commonScale - value.scale)
  ), 0n);
  return formatRatio(sum * multiplier, BigInt(values.length) * 10n ** BigInt(commonScale));
}

function parseDecimal(value: string): { integer: bigint; scale: number } {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) throw new Error("OpenRouter returned an invalid token price");
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? "0");
  if (!Number.isSafeInteger(exponent)) throw new Error("OpenRouter returned an invalid token price");
  let integer = BigInt(`${match[1]}${fraction}`);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    integer *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { integer, scale };
}

function formatRatio(rawNumerator: bigint, rawDenominator: bigint): string {
  const divisor = greatestCommonDivisor(rawNumerator, rawDenominator);
  const numerator = rawNumerator / divisor;
  const denominator = rawDenominator / divisor;
  let remainder = denominator;
  let twos = 0;
  let fives = 0;
  while (remainder % 2n === 0n) {
    remainder /= 2n;
    twos += 1;
  }
  while (remainder % 5n === 0n) {
    remainder /= 5n;
    fives += 1;
  }
  if (remainder !== 1n) return String(Number(numerator) / Number(denominator));

  const scale = Math.max(twos, fives);
  const scaled = numerator
    * 2n ** BigInt(scale - twos)
    * 5n ** BigInt(scale - fives);
  if (scale === 0) return scaled.toString();
  const digits = scaled.toString().padStart(scale + 1, "0");
  const decimal = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return decimal.replace(/\.?0+$/, "");
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function parseCachedTokenModelPricing(value: string | null): z.infer<typeof CachedTokenModelPricingSchema> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    const result = CachedTokenModelPricingSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function isPricingModelId(modelId: string): boolean {
  return OPENROUTER_PRICING_MODEL_ID_SET.has(modelId);
}
