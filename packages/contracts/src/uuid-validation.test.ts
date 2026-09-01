import { describe, expect, it } from "vitest";
import { z as z4 } from "zod";
import { z as z3 } from "zod/v3";
import { STRICT_UUID_JSON_SCHEMA_PATTERN, STRICT_UUID_PATTERN } from "./uuid-validation";

describe("STRICT_UUID_PATTERN", () => {
  it.each([
    "00000000-0000-0000-0000-000000000000",
    "ffffffff-ffff-ffff-ffff-ffffffffffff",
    "00000000-0000-7000-8000-000000000000",
    "00000000-0000-7000-c000-000000000000",
    "00000000-0000-9000-8000-000000000000",
    "not-a-uuid",
  ])("keeps the v3-compatible validator aligned with Zod v4 for %s", (value) => {
    const v4 = z4.string().uuid().safeParse(value).success;
    const compatible = z3.string().regex(STRICT_UUID_PATTERN, "Invalid UUID").safeParse(value).success;
    expect(compatible).toBe(v4);
    expect(new RegExp(STRICT_UUID_JSON_SCHEMA_PATTERN, "u").test(value)).toBe(v4);
  });
});
