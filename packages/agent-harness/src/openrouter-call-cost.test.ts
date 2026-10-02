import { describe, expect, it } from "vitest";

import { openRouterCallCostUsd, parseOpenRouterStreamChunk } from "./index";

describe("an OpenRouter call's cost", () => {
  it("adds the provider's charge on a bring-your-own-key account, where OpenRouter's own fee is 0", () => {
    expect(openRouterCallCostUsd({ cost: 0, isByok: true, costDetails: { upstreamInferenceCost: 0.000076, upstreamInferencePromptCost: 0.000016, upstreamInferenceCompletionsCost: 0.00006 } })).toBeCloseTo(0.000076, 9);
  });

  it("is OpenRouter's cost alone on an ordinary account, and unknown when nothing is reported", () => {
    expect(openRouterCallCostUsd({ cost: 0.0021, isByok: false, costDetails: { upstreamInferenceCost: 0.0021, upstreamInferencePromptCost: 0.0011, upstreamInferenceCompletionsCost: 0.001 } })).toBe(0.0021);
    expect(openRouterCallCostUsd({})).toBeUndefined();
  });

  it("keeps a bring-your-own-key charge when the stream is read raw rather than by the SDK", () => {
    const chunk = parseOpenRouterStreamChunk(JSON.stringify({
      id: "gen-1", choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, cost: 0, is_byok: true,
        cost_details: { upstream_inference_cost: 0.000076, upstream_inference_prompt_cost: 0.000016, upstream_inference_completions_cost: 0.00006 } },
    }));
    expect(openRouterCallCostUsd(chunk.usage!)).toBeCloseTo(0.000076, 9);
  });
});
