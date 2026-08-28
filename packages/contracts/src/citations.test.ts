import { describe, expect, it } from "vitest";
import {
  citationFootnotes,
  citationScheme,
  parseCitationHref,
  rewriteCitationsAsPlainText,
} from "./citations";

describe("parseCitationHref", () => {
  it("reads the URL-style resource scheme the guidance teaches", () => {
    expect(parseCitationHref("resource://0192f3ac-1b2c-7000-8000-abcdefabcdef")).toEqual({
      scheme: "resource",
      resourceId: "0192f3ac-1b2c-7000-8000-abcdefabcdef",
    });
  });

  it("reads the legacy bare spelling too, so nothing already emitted breaks", () => {
    expect(parseCitationHref("resource:board-deck-q3")).toEqual({
      scheme: "resource",
      resourceId: "board-deck-q3",
    });
  });

  it("accepts a slug as readily as a UUID — the id's shape is the resource system's", () => {
    expect(parseCitationHref("resource://mute-windows-prd")).toEqual({
      scheme: "resource",
      resourceId: "mute-windows-prd",
    });
  });

  it("drops a reserved version parameter rather than pretending to honour it", () => {
    // Key design decision 7: a citation opens the current version. `?v=` is
    // reserved syntax, so it must not become part of the id it would otherwise
    // fail to resolve against.
    expect(parseCitationHref("resource://board-deck?v=3")).toEqual({
      scheme: "resource",
      resourceId: "board-deck",
    });
  });

  it("refuses an identifier outside the safe alphabet", () => {
    expect(parseCitationHref("resource://../../etc/passwd").scheme).toBe("unknown");
    expect(parseCitationHref("resource://has space").scheme).toBe("unknown");
    expect(parseCitationHref("resource://").scheme).toBe("unknown");
  });

  it("names the schemes that navigate outward and the identities that never do", () => {
    expect(parseCitationHref("https://example.com/report")).toEqual({
      scheme: "external",
      url: "https://example.com/report",
    });
    expect(parseCitationHref("http://example.com")).toEqual({
      scheme: "external",
      url: "http://example.com",
    });
    expect(parseCitationHref("person:0192f3ac-1b2c-7000-8000-abcdefabcdef").scheme).toBe("person");
    expect(parseCitationHref("connector:abc123:slack").scheme).toBe("connector");
  });

  it("treats every other scheme as text, so message content reaches no protocol handler", () => {
    for (const href of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,<b>", "mailto:a@b.c", undefined]) {
      expect(parseCitationHref(href).scheme).toBe("unknown");
    }
  });
});

describe("citationFootnotes", () => {
  it("lifts a definition whose content is one paragraph carrying exactly one link", () => {
    const { citations } = citationFootnotes([
      "Revenue grew 40%.[^1]",
      "",
      "[^1]: [Q3 board deck](resource://board-deck)",
    ].join("\n"));

    expect(citations.get("1")).toEqual({
      label: "Q3 board deck",
      target: { scheme: "resource", resourceId: "board-deck" },
      text: "",
    });
  });

  it("carries the plain text around the link into the popover", () => {
    const { citations } = citationFootnotes("A.[^src]\n\n[^src]: [Deck](resource://d), page 4");
    // Without the leading comma: it joined the words to the link, and in a
    // popover that puts the source on its own line it reads as a fragment.
    expect(citations.get("src")?.text).toBe("page 4");
    expect(citationFootnotes("A.[^s]\n\n[^s]: [Deck](resource://d) — appendix B").citations.get("s")?.text)
      .toBe("appendix B");
    expect(citationFootnotes("A.[^s]\n\n[^s]: See [Deck](resource://d) for the split").citations.get("s")?.text)
      .toBe("See for the split");
  });

  it("qualifies an external source, which opens in the browser rather than the rail", () => {
    const { citations } = citationFootnotes("A.[^2]\n\n[^2]: [Docs](https://example.com/docs)");
    expect(citations.get("2")?.target).toEqual({ scheme: "external", url: "https://example.com/docs" });
  });

  it("refuses a definition with no link, two links, or more than one block", () => {
    const two = citationFootnotes("A.[^a]\n\n[^a]: [One](resource://x) and [Two](resource://y)");
    expect(two.citations.size).toBe(0);
    expect(two.plain).toEqual(["a"]);

    expect(citationFootnotes("A.[^b]\n\n[^b]: Just a note").citations.size).toBe(0);
    expect(citationFootnotes("A.[^c]\n\n[^c]: [One](resource://x)\n\n    A second paragraph.").citations.size).toBe(0);
  });

  it("ignores a reference whose definition never arrives", () => {
    const { citations, plain } = citationFootnotes("A claim.[^missing]");
    expect(citations.size).toBe(0);
    expect(plain).toEqual([]);
  });

  it("reads nothing out of a fenced block, where footnote syntax is sample text", () => {
    const { citations } = citationFootnotes([
      "```md",
      "[^1]: [Not a citation](resource://x)",
      "```",
      "",
      "Real prose.[^1]",
    ].join("\n"));
    expect(citations.size).toBe(0);
  });
});

describe("rewriteCitationsAsPlainText", () => {
  it("reduces a chip to the words the model wrote", () => {
    expect(rewriteCitationsAsPlainText("See [the Q3 deck](resource://board-deck) for detail."))
      .toBe("See the Q3 deck for detail.");
  });

  it("reduces an embed card to its label rather than a broken image", () => {
    expect(rewriteCitationsAsPlainText("Published:\n\n![Mute windows PRD](resource://prd-mute)\n"))
      .toBe("Published:\n\nMute windows PRD\n");
  });

  it("leaves an external link and a real image alone", () => {
    const source = "Read [the docs](https://example.com) and see ![a chart](https://example.com/c.png).";
    expect(rewriteCitationsAsPlainText(source)).toBe(source);
  });

  it("turns footnotes into numbered markers and one trailing source list", () => {
    expect(rewriteCitationsAsPlainText([
      "Revenue grew 40%.[^rev] Margin held.[^mar]",
      "",
      "[^rev]: [Q3 board deck](resource://board-deck)",
      "[^mar]: [Margin memo](https://example.com/memo)",
    ].join("\n"))).toBe([
      "Revenue grew 40%.[1] Margin held.[2]",
      "",
      "**Sources**",
      "",
      "1. Q3 board deck",
      "2. [Margin memo](https://example.com/memo)",
    ].join("\n"));
  });

  it("numbers by first reference, not by the order the definitions were written", () => {
    const rewritten = rewriteCitationsAsPlainText([
      "Second claim.[^b] First claim.[^a]",
      "",
      "[^a]: [Alpha](resource://a)",
      "[^b]: [Beta](resource://b)",
    ].join("\n"));
    expect(rewritten).toContain("Second claim.[1] First claim.[2]");
    expect(rewritten).toContain("1. Beta");
    expect(rewritten).toContain("2. Alpha");
  });

  it("carries a non-qualifying footnote into the same list as its own text", () => {
    expect(rewriteCitationsAsPlainText("A claim.[^n]\n\n[^n]: Measured by hand, twice."))
      .toBe("A claim.[1]\n\n**Sources**\n\n1. Measured by hand, twice.");
  });

  it("leaves a reference with no definition as the model wrote it", () => {
    expect(rewriteCitationsAsPlainText("A claim.[^gone]")).toBe("A claim.[^gone]");
  });

  it("leaves text with no citations untouched, including its trailing whitespace", () => {
    expect(rewriteCitationsAsPlainText("# Heading\n\nA plain paragraph.\n"))
      .toBe("# Heading\n\nA plain paragraph.\n");
  });

  it("never rewrites inside a fenced block, where the syntax is what is being shown", () => {
    const source = [
      "Cite like this:",
      "",
      "```md",
      "[Title](resource://the-id)",
      "```",
    ].join("\n");
    expect(rewriteCitationsAsPlainText(source)).toBe(source);
  });

  it("leaves an inline code span showing the syntax alone", () => {
    expect(rewriteCitationsAsPlainText("Write `[Title](resource://id)` to cite."))
      .toBe("Write `[Title](resource://id)` to cite.");
  });
});

describe("citationScheme", () => {
  it("routes a malformed resource target to the cell that knows how to degrade it", () => {
    // The parser says unknown; the cell must still be the resource one, or the
    // default renderer carries a raw `resource://` target into the DOM.
    expect(parseCitationHref("resource://has space").scheme).toBe("unknown");
    expect(citationScheme("resource://has space")).toBe("resource");
  });

  it("leaves every target the default transform already handles in the unknown cell", () => {
    expect(citationScheme("mailto:a@b.c")).toBe("unknown");
    expect(citationScheme("tel:+15551234")).toBe("unknown");
    expect(citationScheme(undefined)).toBe("unknown");
  });

  it("agrees with the parser on every well-formed target", () => {
    for (const href of [
      "resource://ok",
      "https://example.com",
      "person:0192f3ac-1b2c-7000-8000-abcdefabcdef",
      "connector:token:slack",
    ]) {
      expect(citationScheme(href)).toBe(parseCitationHref(href).scheme);
    }
  });

  it("keeps an unresolvable identity in its own cell, which never navigates", () => {
    // A `person:` href that is not an id is text a model wrote. It has to reach
    // the identity cell so it renders as the mention fallback rather than as an
    // anchor with a model-chosen destination.
    expect(parseCitationHref("person:someone").scheme).toBe("unknown");
    expect(citationScheme("person:someone")).toBe("person");
  });
});
