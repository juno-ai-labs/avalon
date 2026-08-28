import { describe, expect, it } from "vitest";

import { isMarkdownCode, mapMarkdownProse, markdownLineKinds } from "./markdown-code";

/** The kind of every line of `markdown`, in order — the whole of the classifier's answer. */
function kinds(markdown: string): string[] {
  return markdownLineKinds(markdown.split("\n"));
}

describe("markdownLineKinds: fenced blocks", () => {
  it("reads a delimiter as code, not as the prose around it", () => {
    // Reading ``` as prose puts a rewrite inside the one line that proves the
    // block was there.
    expect(kinds("before\n```js\ncode\n```\nafter"))
      .toEqual(["prose", "fence-open", "fence-content", "fence-close", "prose"]);
  });

  it("closes on a longer run of the opener's character, and on trailing text after it", () => {
    // The deliberate looseness, and the reason the rule is shared rather than
    // guessed at each call site: CommonMark wants a closer's rest-of-line bare.
    // Erring loose keeps the delimiter on the code side, so a line wrongly read
    // as code is left alone rather than rewritten.
    expect(kinds("```\ncode\n`````\nafter"))
      .toEqual(["fence-open", "fence-content", "fence-close", "prose"]);
    expect(kinds("```\ncode\n```more\nafter"))
      .toEqual(["fence-open", "fence-content", "fence-close", "prose"]);
  });

  it("refuses a run shorter than the opener, so a nested block stays nested", () => {
    // The length test is what makes ````…``` around a ```-fenced sample work,
    // which is how anything in this repository shows somebody a code block.
    expect(kinds("````md\n```js\nnested\n```\n````\nafter"))
      .toEqual(["fence-open", "fence-content", "fence-content", "fence-content", "fence-close", "prose"]);
  });

  it("refuses the other delimiter character", () => {
    expect(kinds("```\ncode\n~~~\nstill code"))
      .toEqual(["fence-open", "fence-content", "fence-content", "fence-content"]);
  });

  it("needs three characters, and at most three columns of indent", () => {
    expect(kinds("``\nnot a fence")).toEqual(["prose", "prose"]);
    expect(kinds("   ```\nindented three")).toEqual(["fence-open", "fence-content"]);
  });

  it("leaves an unterminated fence open to the end of the document", () => {
    // What the parser downstream does too, and the direction that leaves text
    // alone rather than rewriting it.
    expect(kinds("head\n\n```\ncode\nstill code"))
      .toEqual(["prose", "prose", "fence-open", "fence-content", "fence-content"]);
  });

  it("reopens after a block closes", () => {
    expect(kinds("```\na\n```\nbetween\n```\nb\n```")).toEqual([
      "fence-open", "fence-content", "fence-close",
      "prose",
      "fence-open", "fence-content", "fence-close",
    ]);
  });
});

describe("markdownLineKinds: indented blocks", () => {
  it("reads a four-space or tab block as code", () => {
    // A model showing somebody this syntax uses an indented block as readily as
    // a fence, and rewriting one deletes the example being taught.
    expect(kinds("Cite like this:\n\n    [Deck](resource://id)\n\nAfter."))
      .toEqual(["prose", "prose", "indented-code", "indented-code", "prose"]);
    expect(kinds("Head:\n\n\tcode\n")).toEqual(["prose", "prose", "indented-code", "indented-code"]);
  });

  it("refuses to let an indented chunk interrupt a paragraph", () => {
    // The half that cannot be skipped: without it a lazily-indented
    // continuation reads as code and a real `resource://` target leaves Rally,
    // which is worse than the bug the indented rule fixes.
    expect(kinds("A paragraph\n    continuing lazily\nand ending."))
      .toEqual(["prose", "prose", "prose"]);
  });

  it("ends at the margin, but not at a blank line", () => {
    expect(kinds("Head:\n\n    one\n\n    two\nback at the margin"))
      .toEqual(["prose", "prose", "indented-code", "indented-code", "indented-code", "prose"]);
  });

  it("does not carry a paragraph across a fence", () => {
    // Opening a fence clears the paragraph, so an indented line after the block
    // still opens an indented one.
    expect(kinds("A paragraph\n```\ncode\n```\n    indented"))
      .toEqual(["prose", "fence-open", "fence-content", "fence-close", "indented-code"]);
  });
});

describe("isMarkdownCode", () => {
  it("counts every kind but prose, delimiters included", () => {
    expect((["prose", "fence-open", "fence-content", "fence-close", "indented-code"] as const).map(isMarkdownCode))
      .toEqual([false, true, true, true, true]);
  });
});

describe("mapMarkdownProse", () => {
  it("returns the source byte for byte under an identity transform", () => {
    // `rewriteCitationsAsPlainText` promises a document with no citations in it
    // comes back unchanged, and this is where that promise is actually kept.
    for (const source of [
      "",
      "\n",
      "plain prose\n",
      "head\r\n\r\n```js\r\nconst a = 1;\r\n```\r\n\r\ntail\r\n",
      "```\nunterminated",
      "```\ncode\n```",
      "head\n\n    indented\n\ntail\n",
      "trailing newline matters\n",
    ]) {
      expect(mapMarkdownProse(source, (prose) => prose)).toBe(source);
    }
  });

  it("rewrites prose and hands back code exactly as written", () => {
    expect(mapMarkdownProse("a\n\n```\na\n```\n\na", (prose) => prose.replaceAll("a", "b")))
      .toBe("b\n\n```\na\n```\n\nb");
    expect(mapMarkdownProse("a\n\n    a\n\na", (prose) => prose.replaceAll("a", "b")))
      .toBe("b\n\n    a\n\nb");
  });

  it("hands the transform maximal runs, so a construct spanning lines is whole", () => {
    // A rewrite that reads across a line break — the TeX repair's `\[…\]` — sees
    // one string per run rather than one per line. A rewriter that wants lines
    // splits the run itself.
    const runs: string[] = [];
    mapMarkdownProse("one\ntwo\n```\ncode\n```\nthree\nfour", (prose) => {
      runs.push(prose);
      return prose;
    });
    expect(runs).toEqual(["one\ntwo", "three\nfour"]);
  });

  it("keeps a CRLF document's line endings, which it never normalizes", () => {
    expect(mapMarkdownProse("a\r\nb", (prose) => prose.toUpperCase())).toBe("A\r\nB");
  });
});
