import { describe, expect, it } from "vitest";

import { truncateUtf16Safe } from "../src/lib/text";

describe("truncateUtf16Safe", () => {
  it("returns the value unchanged when it already fits", () => {
    expect(truncateUtf16Safe("short", 300)).toBe("short");
  });

  it("truncates a plain-ASCII value at the exact boundary", () => {
    expect(truncateUtf16Safe("x".repeat(10), 5)).toBe("xxxxx");
  });

  it("backs off one code unit when the boundary would split a surrogate pair", () => {
    // U+1F600 (😀) is a surrogate pair: two UTF-16 code units. Landing the cut
    // exactly between them (after the first four plain characters) must drop
    // the whole emoji rather than emit a lone leading surrogate.
    const value = `abcd\u{1F600}efgh`;
    const truncated = truncateUtf16Safe(value, 5);
    expect(truncated).toBe("abcd");
    expect(truncated.length).toBeLessThanOrEqual(5);
    // A lone surrogate would still pass this length check but be invalid
    // UTF-16 on its own; confirm no lone surrogate survived instead.
    const lastCode = truncated.charCodeAt(truncated.length - 1);
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
  });

  it("keeps a complete surrogate pair when the boundary lands after it", () => {
    const value = `abcd\u{1F600}efgh`;
    const truncated = truncateUtf16Safe(value, 6);
    expect(truncated).toBe(`abcd\u{1F600}`);
  });
});
