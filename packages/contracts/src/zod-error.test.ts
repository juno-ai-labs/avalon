import { describe, expect, it } from "vitest";
import { z as z4 } from "zod";
import { z as z3 } from "zod/v3";
import { isZodValidationError, normalizedZodIssueCode } from "./zod-error";

describe("isZodValidationError", () => {
  it("recognizes validation failures from both Worker schema runtimes", () => {
    const v4 = z4.object({ count: z4.number() }).safeParse({ count: "one" });
    const v3 = z3.object({ count: z3.number() }).safeParse({ count: "one" });
    expect(v4.success).toBe(false);
    expect(v3.success).toBe(false);
    if (v4.success || v3.success) return;
    expect(isZodValidationError(v4.error)).toBe(true);
    expect(isZodValidationError(v3.error)).toBe(true);
  });

  it.each([
    [z4.string().uuid(), z3.string().uuid(), "not-a-uuid"],
    [z4.literal("expected"), z3.literal("expected"), "other"],
    [z4.enum(["one", "two"]), z3.enum(["one", "two"]), "three"],
    [
      z4.discriminatedUnion("type", [z4.object({ type: z4.literal("one") })]),
      z3.discriminatedUnion("type", [z3.object({ type: z3.literal("one") })]),
      { type: "two" },
    ],
    [z4.number(), z3.number().finite(), Number.POSITIVE_INFINITY],
  ])("normalizes v3 issue codes to the prior v4 vocabulary", (v4Schema, v3Schema, value) => {
    const v4 = v4Schema.safeParse(value);
    const v3 = v3Schema.safeParse(value);
    expect(v4.success).toBe(false);
    expect(v3.success).toBe(false);
    if (v4.success || v3.success) return;

    expect(normalizedZodIssueCode(v3.error.issues[0]!.code)).toBe(v4.error.issues[0]!.code);
  });
});
