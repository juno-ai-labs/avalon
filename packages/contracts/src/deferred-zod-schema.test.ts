import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { deferredZodSchema, memoizedValue } from "./deferred-zod-schema";

describe("memoizedValue", () => {
  it("does not evaluate until first use and returns the same value thereafter", () => {
    const factory = vi.fn(() => ({ value: 42 }));
    const read = memoizedValue(factory);

    expect(factory).not.toHaveBeenCalled();
    expect(read()).toBe(read());
    expect(factory).toHaveBeenCalledOnce();
  });
});

describe("deferredZodSchema", () => {
  it("constructs once on first parse and preserves detailed Zod issues", () => {
    const factory = vi.fn(() => z.strictObject({
      name: z.string().min(2),
    }));
    const schema = deferredZodSchema(factory);

    expect(factory).not.toHaveBeenCalled();
    const result = schema.safeParse({ name: "x" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({
          code: "too_small",
          path: ["name"],
          message: "Too small: expected string to have >=2 characters",
        }),
      ]);
    }
    expect(schema.parse({ name: "valid" })).toEqual({ name: "valid" });
    expect(factory).toHaveBeenCalledOnce();
  });

  it("supports JSON Schema conversion without eager construction", () => {
    const factory = vi.fn(() => z.strictObject({ name: z.string() }));
    const schema = deferredZodSchema(factory);

    expect(factory).not.toHaveBeenCalled();
    expect(z.toJSONSchema(schema)).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect(factory).toHaveBeenCalledOnce();
  });
});
