import { describe, expect, it } from "vitest";

import { openRouterCallCostUsd } from "./index";

describe("an OpenRouter call's cost", () => {
  it("adds the provider's charge on a bring-your-own-key account, where OpenRouter's own fee is 0", () => {
    expect(openRouterCallCostUsd({ cost: 0, isByok: true, costDetails: { upstreamInferenceCost: 0.000076, upstreamInferencePromptCost: 0.000016, upstreamInferenceCompletionsCost: 0.00006 } })).toBeCloseTo(0.000076, 9);
  });

  it("is OpenRouter's cost alone on an ordinary account, and unknown when nothing is reported", () => {
    expect(openRouterCallCostUsd({ cost: 0.0021, isByok: false, costDetails: { upstreamInferenceCost: 0.0021, upstreamInferencePromptCost: 0.0011, upstreamInferenceCompletionsCost: 0.001 } })).toBe(0.0021);
    expect(openRouterCallCostUsd({})).toBeUndefined();
  });
});
