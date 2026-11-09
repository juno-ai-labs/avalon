import type { ProviderPricingBasis } from "./plan";

/**
 * Synchronous provider billing-basis cost —
 * the configured-list-rate calculation used when a provider (Azure) reports
 * usage but not dollars. OpenRouter's provider-reported cost keeps the
 * existing path in `llm.ts` and never goes through this function.
 *
 * Results are USD cents at the inference log's numeric(10, 4) precision.
 */

export interface BillingBasisUsage {
  readonly inputTokens: number;
  /**
   * Provider-reported cached (discounted) input tokens. Whether this is a
   * subset of `inputTokens` or a disjoint count is DECLARED by the binding's
   * `cachedTokenSemantics` — never inferred from the relative sizes.
   */
  readonly cachedInputTokens: number;
  /**
   * Provider completion-token total. Already includes reasoning tokens — do
   * not add them a second time.
   */
  readonly outputTokens: number;
}

export type BillingBasisResult =
  | Readonly<{ ok: true; costCents: number }>
  | Readonly<{ ok: false; reason: string }>;

function isUsableCount(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function roundToScale4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Compute the list-rate cost in USD cents from usage and configured
 * per-million-token rates. Rejects internally inconsistent usage rather than
 * producing a zero-cost call: negative counts, non-integers,
 * all-zero usage (a request always consumes prompt tokens — zeros mean the
 * provider's accounting is broken, not that the call was free), and — under
 * declared `"subset"` semantics — cached counts exceeding total input.
 *
 * The uncached-input calculation follows the binding's declared
 * `cachedTokenSemantics`:
 * - `"subset"`  — cached ⊆ input (OpenAI): uncached = input − cached.
 * - `"disjoint"` — cached reported alongside input (Grok via Azure AI
 *   Foundry, observed live: cached 192 vs prompt 88): uncached = input.
 * Either way every token prices exactly once at its own rate.
 */
export function computeConfiguredRatesCostCents(
  pricing: Extract<ProviderPricingBasis, { kind: "configured_token_rates" }>,
  usage: BillingBasisUsage,
): BillingBasisResult {
  if (!isUsableCount(usage.inputTokens)) {
    return { ok: false, reason: `invalid input token count: ${usage.inputTokens}` };
  }
  if (!isUsableCount(usage.cachedInputTokens)) {
    return {
      ok: false,
      reason: `invalid cached input token count: ${usage.cachedInputTokens}`,
    };
  }
  if (!isUsableCount(usage.outputTokens)) {
    return { ok: false, reason: `invalid output token count: ${usage.outputTokens}` };
  }
  if (
    usage.inputTokens === 0 &&
    usage.cachedInputTokens === 0 &&
    usage.outputTokens === 0
  ) {
    return { ok: false, reason: "all-zero usage (provider reported no tokens)" };
  }
  let uncachedInputTokens: number;
  switch (pricing.cachedTokenSemantics) {
    case "subset":
      if (usage.cachedInputTokens > usage.inputTokens) {
        return {
          ok: false,
          reason:
            `cached input tokens (${usage.cachedInputTokens}) exceed input tokens ` +
            `(${usage.inputTokens}) under declared "subset" semantics — if this ` +
            `provider reports cached tokens alongside prompt tokens, declare ` +
            `cachedTokenSemantics: "disjoint" on its binding`,
        };
      }
      uncachedInputTokens = usage.inputTokens - usage.cachedInputTokens;
      break;
    case "disjoint":
      uncachedInputTokens = usage.inputTokens;
      break;
    default: {
      const _exhaustive: never = pricing.cachedTokenSemantics;
      throw new Error(`unknown cached-token semantics: ${JSON.stringify(_exhaustive)}`);
    }
  }
  const usd =
    (uncachedInputTokens * pricing.inputUsdPerM +
      usage.cachedInputTokens * pricing.cachedInputUsdPerM +
      usage.outputTokens * pricing.outputUsdPerM) /
    1_000_000;
  return { ok: true, costCents: roundToScale4(usd * 100) };
}
