import { describe, expect, it } from "vitest";

import { generatedAppearance, markImagePath, parseMarkImagePath } from "./marks";

describe("generatedAppearance", () => {
  it("given an id, when derived, then it is the mark the app has always drawn for it", () => {
    // The same two ids `workstream-glyph.test.tsx` pins as ring index and icon index.
    expect(generatedAppearance("00000000-0000-7000-8000-000000000001")).toEqual({ color: "red", icon: "aperture" });
    expect(generatedAppearance("launch-room")).toEqual({ color: "lime", icon: "orbit" });
  });
});

describe("mark image paths", () => {
  it("given a mark, when its path is written and read back, then it names the same mark", () => {
    expect(markImagePath({ shape: "squircle", color: "blue", icon: "rocket" })).toBe("/marks/squircle/blue/rocket.png");
    expect(parseMarkImagePath("/marks/circle/teal/globe-2.png")).toEqual({ shape: "circle", color: "teal", icon: "globe-2" });
  });

  it("given anything outside the vocabulary, when read, then it names nothing", () => {
    expect(parseMarkImagePath("/marks/hexagon/blue/rocket.png")).toBeNull();
    expect(parseMarkImagePath("/marks/circle/magenta/rocket.png")).toBeNull();
    expect(parseMarkImagePath("/marks/circle/blue/not-an-icon.png")).toBeNull();
    expect(parseMarkImagePath("/marks/circle/blue/rocket.svg")).toBeNull();
  });
});
