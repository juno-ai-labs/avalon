import { describe, expect, it } from "vitest";

import { effectiveDerivativeState } from "../src/services/attachment-derivative-state";

describe("legacy attachment derivative state", () => {
  it("honors explicit state before legacy compatibility", () => {
    expect(effectiveDerivativeState({
      modelContentStatus: "failed",
      contentRef: "original",
      modelContentRef: "model",
      modelMimeType: "image/png",
    })).toBe("failed");
  });

  it("reuses a legacy model image and lazily queues other hydrated rows", () => {
    expect(effectiveDerivativeState({
      modelContentStatus: null,
      contentRef: "original",
      modelContentRef: "model",
      modelMimeType: "image/png",
    })).toBe("ready");
    expect(effectiveDerivativeState({
      modelContentStatus: null,
      contentRef: "original",
      modelContentRef: null,
      modelMimeType: null,
    })).toBe("pending");
    expect(effectiveDerivativeState({
      modelContentStatus: null,
      contentRef: null,
      modelContentRef: null,
      modelMimeType: null,
    })).toBe("failed");
  });
});
