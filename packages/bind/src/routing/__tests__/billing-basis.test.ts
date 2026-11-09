import { describe, expect, it } from "vitest";
import { computeConfiguredRatesCostCents } from "../billing-basis";

const PRICING = {
  kind: "configured_token_rates",
  inputUsdPerM: 1.25,
  cachedInputUsdPerM: 0.125,
  outputUsdPerM: 10,
  cachedTokenSemantics: "subset",
} as const;

const DISJOINT_PRICING = {
  ...PRICING,
  cachedTokenSemantics: "disjoint",
} as const;

describe("computeConfiguredRatesCostCents", () => {
  it("prices uncached input, cached input, and output at their own rates", () => {
    // 900k uncached × $1.25/M + 100k cached × $0.125/M + 50k out × $10/M
    // = $1.125 + $0.0125 + $0.5 = $1.6375 → 163.75 cents
    const result = computeConfiguredRatesCostCents(PRICING, {
      inputTokens: 1_000_000,
      cachedInputTokens: 100_000,
      outputTokens: 50_000,
    });
    expect(result).toEqual({ ok: true, costCents: 163.75 });
  });

  it("rounds to the inference log's numeric(10,4) scale", () => {
    const result = computeConfiguredRatesCostCents(PRICING, {
      inputTokens: 7,
      cachedInputTokens: 0,
      outputTokens: 3,
    });
    // 7 × $1.25/M + 3 × $10/M = $0.00003875 → 0.003875 cents → 0.0039
    expect(result).toEqual({ ok: true, costCents: 0.0039 });
  });

  it("rejects all-zero usage instead of pricing a call at $0", () => {
    const result = computeConfiguredRatesCostCents(PRICING, {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("all-zero");
  });

  it("under subset semantics, rejects cached > input with a disjoint pointer", () => {
    // Declared subset but the provider reported a disjoint-style count: the
    // binding is misdeclared — fail loudly instead of silently mispricing.
    const result = computeConfiguredRatesCostCents(PRICING, {
      inputTokens: 88,
      cachedInputTokens: 192,
      outputTokens: 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('"disjoint"');
  });

  it("under disjoint semantics, prices cached alongside full input", () => {
    // Grok-via-Foundry shape: cached is NOT a subset of prompt tokens.
    // 100 uncached × $1.25/M + 200 cached × $0.125/M = $0.000125 + $0.000025
    const result = computeConfiguredRatesCostCents(DISJOINT_PRICING, {
      inputTokens: 100,
      cachedInputTokens: 200,
      outputTokens: 0,
    });
    expect(result).toEqual({ ok: true, costCents: 0.015 });
  });

  it("under disjoint semantics, never subtracts cached from input", () => {
    // A disjoint provider can legitimately report cached < input — inferring
    // subset here would drop 100k billable input tokens (the Codex P1).
    // 1M input × $1.25/M + 100k cached × $0.125/M = $1.25 + $0.0125
    const result = computeConfiguredRatesCostCents(DISJOINT_PRICING, {
      inputTokens: 1_000_000,
      cachedInputTokens: 100_000,
      outputTokens: 0,
    });
    expect(result).toEqual({ ok: true, costCents: 126.25 });
  });

  it("rejects negative and non-integer usage", () => {
    expect(
      computeConfiguredRatesCostCents(PRICING, {
        inputTokens: -1,
        cachedInputTokens: 0,
        outputTokens: 0,
      }).ok,
    ).toBe(false);
    expect(
      computeConfiguredRatesCostCents(PRICING, {
        inputTokens: 10.5,
        cachedInputTokens: 0,
        outputTokens: 0,
      }).ok,
    ).toBe(false);
    expect(
      computeConfiguredRatesCostCents(PRICING, {
        inputTokens: Number.NaN,
        cachedInputTokens: 0,
        outputTokens: 0,
      }).ok,
    ).toBe(false);
  });
});
