import { describe, expect, it } from "vitest";
import { z as z4 } from "zod";
import { z as z3 } from "zod/v3";
import { isZodValidationError } from "./zod-error";

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
});
