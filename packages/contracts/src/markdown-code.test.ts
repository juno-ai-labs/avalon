import { describe, expect, it } from "vitest";
import { mapMarkdownProse, maskMarkdownCode } from "./markdown-code";

describe("maskMarkdownCode", () => {
  // The whole contract. Two callers slice the *original* string at offsets they
  // found by walking the mask, so a mask that is one character short cuts the
  // wrong bytes — and the visible result is the raw `resource://` syntax the
  // citation rewrite exists to remove, in somebody's inbox.
  it("preserves length for every input, astral code points included", () => {
    for (const source of [
      "plain prose",
      "an inline `span` here",
      "```js\nconsole.log('done 🚀');\n```",
      "a 🚀 rocket outside code",
      "`🚀`",
      "```\n𝔘𝔫𝔦𝔠𝔬𝔡𝔢 and 家族\n```",
      "```\n👩‍👩‍👧‍👦 a family, which is several code points\n```",
      "",
    ]) {
      expect({ source, length: maskMarkdownCode(source).length }).toEqual({ source, length: source.length });
    }
  });

  it("keeps every newline where it was, so a line scan sees the same lines", () => {
    const source = "before\n\n```js\nlet a = '🚀';\n\nlet b = 2;\n```\n\nafter";
    const masked = maskMarkdownCode(source);

    // Indexed, not spread: spreading a string walks code points, which is the
    // very distinction this contract turns on.
    const newlineOffsets = (value: string): number[] => {
      const offsets: number[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (value[index] === "\n") offsets.push(index);
      }
      return offsets;
    };

    expect(masked.split("\n")).toHaveLength(source.split("\n").length);
    expect(newlineOffsets(masked)).toEqual(newlineOffsets(source));
  });

  it("blanks code and leaves prose exactly as written", () => {
    expect(maskMarkdownCode("say `x` now")).toBe("say     now");
    expect(maskMarkdownCode("keep me")).toBe("keep me");
  });
});

describe("mapMarkdownProse", () => {
  it("rewrites prose and never code", () => {
    expect(mapMarkdownProse("a `a` a\n\n```\na\n```\n\na", (prose) => prose.replaceAll("a", "b")))
      .toBe("b `a` b\n\n```\na\n```\n\nb");
  });

  it("reassembles the source unchanged under an identity transform", () => {
    const source = "text `code` more\n\n```js\nconst x = '🚀';\n```\n\ntail";

    expect(mapMarkdownProse(source, (prose) => prose)).toBe(source);
  });
});
