import { describe, expect, it } from "vitest";

import { uuidV7 } from "../src/lib/uuid-v7";

describe("uuidV7", () => {
  it("emits valid version-7 variant-2 UUIDs", () => {
    const id = uuidV7(1_797_595_200_123);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  it("sorts distinct milliseconds in chronological order", () => {
    const earlier = uuidV7(1_797_595_200_123);
    const later = uuidV7(1_797_595_200_124);
    expect(earlier < later).toBe(true);
  });

  it("rejects timestamps outside the UUIDv7 field", () => {
    expect(() => uuidV7(-1)).toThrow(RangeError);
    expect(() => uuidV7(0x1_0000_0000_0000)).toThrow(RangeError);
  });
});
