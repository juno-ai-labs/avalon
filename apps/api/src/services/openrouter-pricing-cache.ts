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
  version: z.literal(2),
  fetchedAtMs: z.number().int().nonnegative(),
  inputUsdPerM: DecimalStringSchema,
  cachedInputUsdPerM: DecimalStringSchema,
  outputUsdPerM: DecimalStringSchema,
  overrides: z.array(z.object({
    minPromptTokens: z.number().int().nonnegative(),
    inputUsdPerM: DecimalStringSchema,
    cachedInputUsdPerM: DecimalStringSchema,
    outputUsdPerM: DecimalStringSchema,
  })).superRefine((overrides, context) => {
    for (let index = 0; index < overrides.length; index += 1) {
      if (index > 0 && overrides[index]!.minPromptTokens <= overrides[index - 1]!.minPromptTokens) {
        context.addIssue({
          code: "custom",
          message: "Pricing overrides must have strictly increasing prompt-token thresholds",
          path: [index, "minPromptTokens"],
        });
      }
    }
  }),
  endpointCount: z.number().int().positive(),
  sourceFingerprint: z.string().startsWith("openrouter-endpoint-average:v2:"),
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
        overrides: z.array(z.object({
          min_prompt_tokens: z.number().int().nonnegative().optional(),
          prompt: z.string().nullish(),
          completion: z.string().nullish(),
          input_cache_read: z.string().nullish(),
        }).passthrough()).optional().default([]),
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

export interface AzureImageModelPricingCost {
  billable: string;
  unit: string;
  costUsd: string;
  endpointCount: number;
  variant?: string;
}

export interface AzureImageModelPricing {
  costs: AzureImageModelPricingCost[];
  sourceFingerprint: string;
}

export interface AzureTokenModelPricingRecord {
  inputUsdPerM: string;
  cachedInputUsdPerM: string;
  outputUsdPerM: string;
  sourceFingerprint: string;
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
        overrides: pricing.overrides.map((override) => ({
          minPromptTokens: override.minPromptTokens,
          inputUsdPerM: Number(override.inputUsdPerM),
          cachedInputUsdPerM: Number(override.cachedInputUsdPerM),
          outputUsdPerM: Number(override.outputUsdPerM),
        })),
        sourceFingerprint: pricing.sourceFingerprint,
      });
    }
    return resolved;
  };
}

/** Read the shared OpenRouter endpoint-average price used to bill one Azure image deployment. */
export async function loadAzureImageModelPricing(
  env: Pick<Env, "INFERENCE_PRICING_CACHE">,
  modelId: string,
): Promise<AzureImageModelPricing> {
  const pricing = parseCachedImageModelPricing(await env.INFERENCE_PRICING_CACHE.get(modelId));
  if (!pricing) throw new Error(`Azure image pricing cache is unavailable for ${modelId}`);
  return {
    costs: pricing.costs.map((cost) => ({
      billable: cost.billable,
      unit: cost.unit,
      costUsd: cost.costUsd,
      endpointCount: cost.endpointCount,
      ...(cost.variant === undefined ? {} : { variant: cost.variant }),
    })),
    sourceFingerprint: pricing.sourceFingerprint,
  };
}

/** Read one token-priced Azure deployment directly from its shared model-id KV key. */
export async function loadAzureTokenModelPricing(
  env: Pick<Env, "INFERENCE_PRICING_CACHE">,
  modelId: string,
): Promise<AzureTokenModelPricingRecord> {
  const pricing = parseCachedTokenModelPricing(await env.INFERENCE_PRICING_CACHE.get(modelId));
  if (!pricing) throw new Error(`Azure token pricing cache is unavailable for ${modelId}`);
  return {
    inputUsdPerM: pricing.inputUsdPerM,
    cachedInputUsdPerM: pricing.cachedInputUsdPerM,
    outputUsdPerM: pricing.outputUsdPerM,
    sourceFingerprint: pricing.sourceFingerprint,
  };
}

/** Sum token quantities against decimal-string prices without binary floating-point drift. */
export function calculateAzureImageCostUsd(
  pricing: AzureImageModelPricing,
  quantities: Readonly<Record<"input_text" | "input_image" | "output_image", number>>,
): string {
  const products = Object.entries(quantities).flatMap(([billable, quantity]) => {
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      throw new Error(`Azure image usage for ${billable} is invalid`);
    }
    if (quantity === 0) return [];
    const candidates = pricing.costs.filter((cost) => (
      cost.billable === billable
      && cost.unit === "token"
      && (cost.variant === undefined || cost.variant === "medium")
    ));
    const cost = candidates.find((candidate) => candidate.variant === undefined) ?? candidates[0];
    if (!cost) throw new Error(`Azure image pricing is unavailable for ${billable}/token`);
    return [{ decimal: cost.costUsd, multiplier: BigInt(quantity) }];
  });
  if (products.length === 0) return "0";
  const parsed = products.map(({ decimal, multiplier }) => ({ ...parseDecimal(decimal), multiplier }));
  const commonScale = Math.max(...parsed.map((value) => value.scale));
  const numerator = parsed.reduce((total, value) => (
    total + value.integer * value.multiplier * 10n ** BigInt(commonScale - value.scale)
  ), 0n);
  return formatRatio(numerator, 10n ** BigInt(commonScale));
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
    version: 2,
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
  const thresholds = Array.from(new Set(endpoints.flatMap((endpoint) => (
    endpoint.pricing.overrides.flatMap((override) => (
      override.min_prompt_tokens === undefined ? [] : [override.min_prompt_tokens]
    ))
  )))).sort((left, right) => left - right);
  const baseRates = averageEndpointRatesAtThreshold(endpoints, 0);
  const overrides = thresholds
    .filter((threshold) => threshold > 0)
    .map((minPromptTokens) => ({
      minPromptTokens,
      ...averageEndpointRatesAtThreshold(endpoints, minPromptTokens),
    }));
  return {
    ...baseRates,
    overrides,
    endpointCount,
    sourceFingerprint: [
      "openrouter-endpoint-average:v2",
      modelId,
      endpointCount,
      baseRates.inputUsdPerM,
      baseRates.cachedInputUsdPerM,
      baseRates.outputUsdPerM,
      ...overrides.map((override) => [
        override.minPromptTokens,
        override.inputUsdPerM,
        override.cachedInputUsdPerM,
        override.outputUsdPerM,
      ].join(":")),
    ].join(":"),
  };
}

function averageEndpointRatesAtThreshold(
  endpoints: z.infer<typeof EndpointEnvelopeSchema>["data"]["endpoints"],
  promptTokens: number,
) {
  const rates = endpoints.map((endpoint) => endpointRatesAtThreshold(endpoint.pricing, promptTokens));
  return {
    inputUsdPerM: averageUsdPerMillion(rates.map((rate) => rate.input)),
    cachedInputUsdPerM: averageUsdPerMillion(rates.map((rate) => rate.cachedInput)),
    outputUsdPerM: averageUsdPerMillion(rates.map((rate) => rate.output)),
  };
}

function endpointRatesAtThreshold(
  pricing: z.infer<typeof EndpointEnvelopeSchema>["data"]["endpoints"][number]["pricing"],
  promptTokens: number,
) {
  let input = pricing.prompt;
  let output = pricing.completion;
  let cachedInput = pricing.input_cache_read ?? input;
  let cachedInputFollowsInput = pricing.input_cache_read == null;
  const overrides = [...pricing.overrides]
    .filter((override) => override.min_prompt_tokens !== undefined)
    .sort((left, right) => (
      (left.min_prompt_tokens ?? Number.POSITIVE_INFINITY)
      - (right.min_prompt_tokens ?? Number.POSITIVE_INFINITY)
    ));
  for (const override of overrides) {
    if (override.min_prompt_tokens === undefined) continue;
    if (override.min_prompt_tokens > promptTokens) break;
    input = override.prompt ?? input;
    output = override.completion ?? output;
    if (override.input_cache_read === null) {
      cachedInputFollowsInput = true;
      cachedInput = input;
    } else if (override.input_cache_read !== undefined) {
      cachedInputFollowsInput = false;
      cachedInput = override.input_cache_read;
    } else if (cachedInputFollowsInput) {
      cachedInput = input;
    }
  }
  return { input, cachedInput, output };
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

function parseCachedImageModelPricing(value: string | null): z.infer<typeof CachedImageModelPricingSchema> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    const result = CachedImageModelPricingSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function isPricingModelId(modelId: string): boolean {
  return OPENROUTER_PRICING_MODEL_ID_SET.has(modelId);
}
