import { describe, expect, it } from "vitest";
import { embeddingCallCostUsd } from "./index";

describe("embeddingCallCostUsd", () => {
  it("adds the provider's upstream charge on a bring-your-own-key account", () => {
    expect(embeddingCallCostUsd({ cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0.0004 } })).toBe(0.0004);
    expect(embeddingCallCostUsd({ cost: 0.00002, is_byok: true, cost_details: { upstream_inference_cost: 0.0004 } })).toBeCloseTo(0.00042, 10);
  });

  it("reads OpenRouter's cost alone off a bring-your-own-key account, and nothing when none is reported", () => {
    expect(embeddingCallCostUsd({ cost: 0.0003, is_byok: false, cost_details: { upstream_inference_cost: 0.0004 } })).toBe(0.0003);
    expect(embeddingCallCostUsd({ prompt_tokens: 10 })).toBeUndefined();
    expect(embeddingCallCostUsd(undefined)).toBeUndefined();
  });
});
