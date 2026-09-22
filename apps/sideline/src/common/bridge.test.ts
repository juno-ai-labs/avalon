import { describe, expect, it } from "vitest";

import { sidelineHttpOutcome } from "./bridge";

describe("Sideline send outcome classification", () => {
  it("distinguishes stable pre-admission refusals from uncertain outcomes", () => {
    expect(sidelineHttpOutcome(400)).toBe("rejected");
    expect(sidelineHttpOutcome(403)).toBe("rejected");
    expect(sidelineHttpOutcome(409)).toBe("rejected");
    expect(sidelineHttpOutcome(408)).toBe("unknown");
    expect(sidelineHttpOutcome(500)).toBe("unknown");
    expect(sidelineHttpOutcome(503)).toBe("unknown");
  });
});
