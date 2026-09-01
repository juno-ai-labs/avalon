import { describe, expect, it } from "vitest";
import { z as z4 } from "zod";
import { z as z3 } from "zod/v3";

describe("schema runtime compatibility", () => {
  it.each([
    [42, true],
    ["42", true],
    [1.5, false],
    ["not-a-number", false],
    [Number.MAX_SAFE_INTEGER, true],
    [Number.MAX_SAFE_INTEGER + 1, false],
  ])("keeps coerced positive integers aligned with Zod v4 for %j", (value, accepted) => {
    const v4 = z4.coerce.number().int().positive().safeParse(value).success;
    const compatible = z3.coerce.number().int().safe().positive().safeParse(value).success;

    expect(v4).toBe(accepted);
    expect(compatible).toBe(v4);
  });
});
