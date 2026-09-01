import { describe, expect, it } from "vitest";
import { z as z4 } from "zod";
import { z as z3 } from "zod/v3";
import { OffsetDateTimeSchema, RequiredUnknownSchema } from "./schema-runtime";

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

  it.each([
    [0, true],
    [1.5, true],
    [Number.POSITIVE_INFINITY, false],
    [Number.NEGATIVE_INFINITY, false],
    [Number.NaN, false],
  ])("keeps finite number validation aligned with Zod v4 for %j", (value, accepted) => {
    const v4 = z4.number().safeParse(value).success;
    const compatible = z3.number().finite().safeParse(value).success;

    expect(v4).toBe(accepted);
    expect(compatible).toBe(v4);
  });

  it.each([
    ["2026-09-01T12:00Z", true],
    ["2026-09-01T12:00:00.123Z", true],
    ["2026-09-01T12:00:00+01:30", true],
    ["2026-09-01T12:00:00+0100", false],
    ["2026-09-01T12:00:00+99:99", false],
    ["2026-02-29T12:00:00Z", false],
  ])("keeps offset datetime validation aligned with Zod v4 for %s", (value, accepted) => {
    const v4 = z4.string().datetime({ offset: true }).safeParse(value).success;
    const compatible = OffsetDateTimeSchema.safeParse(value).success;

    expect(v4).toBe(accepted);
    expect(compatible).toBe(v4);
  });

  it("keeps opaque object fields required as they were under Zod v4", () => {
    const v4 = z4.object({ value: z4.unknown() });
    const compatible = z3.object({ value: RequiredUnknownSchema });

    expect(compatible.safeParse({}).success).toBe(v4.safeParse({}).success);
    expect(compatible.safeParse({ value: null }).success).toBe(v4.safeParse({ value: null }).success);
    expect(compatible.safeParse({ value: "opaque" }).success).toBe(v4.safeParse({ value: "opaque" }).success);
    expect(compatible.safeParse({ value: undefined }).success).toBe(false);
  });
});
