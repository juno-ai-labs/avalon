import { describe, expect, it } from "vitest";
import {
  collectFootnoteCitations,
  footnoteReferenceOrder,
  parseCitationTarget,
  rewriteCitationsForPlainDelivery,
} from "./citations";

describe("parseCitationTarget", () => {
  it("reads the URL-style scheme the guidance teaches", () => {
    expect(parseCitationTarget("resource://0192abcd-7000-7000-8000-00000000004a"))
      .toEqual({ kind: "resource", resourceId: "0192abcd-7000-7000-8000-00000000004a" });
  });

  it("still reads the legacy bare spelling, so nothing already emitted breaks", () => {
    expect(parseCitationTarget("resource:0192abcd"))
      .toEqual({ kind: "resource", resourceId: "0192abcd" });
  });

  it("takes an opaque token, not a UUID: a slug is a resource identifier too", () => {
    expect(parseCitationTarget("resource://mute-windows-prd"))
      .toEqual({ kind: "resource", resourceId: "mute-windows-prd" });
  });

  // `invalid` rather than `unknown`, and the difference carries: the model meant
  // a citation, so the label is shown as text and the raw syntax never survives.
  // A scheme this module does not own answers `unknown`, which leaves whatever
  // the surface already did with it alone.
  it("refuses a target outside the safe alphabet rather than dressing it as a resource", () => {
    expect(parseCitationTarget("resource://../../etc/passwd")).toEqual({ kind: "invalid" });
    expect(parseCitationTarget("resource://")).toEqual({ kind: "invalid" });
    expect(parseCitationTarget("resource://id?v=3")).toEqual({ kind: "invalid" });
  });

  it("classifies the schemes that name openable content and the ones that name identities", () => {
    expect(parseCitationTarget("https://example.com/report"))
      .toEqual({ kind: "external", url: "https://example.com/report" });
    expect(parseCitationTarget("http://localhost:8787/x"))
      .toEqual({ kind: "external", url: "http://localhost:8787/x" });
    expect(parseCitationTarget("person:018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d0"))
      .toEqual({ kind: "identity", scheme: "person" });
    expect(parseCitationTarget("connector:token:gmail")).toEqual({ kind: "identity", scheme: "connector" });
  });

  it("treats every other scheme, and no scheme at all, as text", () => {
    expect(parseCitationTarget("javascript:alert(1)")).toEqual({ kind: "unknown" });
    expect(parseCitationTarget("mention:018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d0")).toEqual({ kind: "unknown" });
    expect(parseCitationTarget("file:///etc/passwd")).toEqual({ kind: "unknown" });
    expect(parseCitationTarget("#section")).toEqual({ kind: "unknown" });
    expect(parseCitationTarget(undefined)).toEqual({ kind: "unknown" });
    expect(parseCitationTarget("")).toEqual({ kind: "unknown" });
  });

  it("reads the scheme case-insensitively, the way a URL scheme is defined", () => {
    expect(parseCitationTarget("RESOURCE://abc")).toEqual({ kind: "resource", resourceId: "abc" });
    expect(parseCitationTarget("HTTPS://example.com"))
      .toEqual({ kind: "external", url: "HTTPS://example.com" });
  });
});

describe("collectFootnoteCitations", () => {
  it("lifts a definition whose content is one paragraph carrying exactly one link", () => {
    const citations = collectFootnoteCitations([
      "Q3 revenue grew 40%.[^1]",
      "",
      "[^1]: [Q3 board deck](resource://deck-01)",
    ].join("\n"));

    expect([...citations.entries()]).toEqual([
      ["1", { identifier: "1", label: "Q3 board deck", href: "resource://deck-01", note: "" }],
    ]);
  });

  it("carries the plain text around the link into the popover", () => {
    const citations = collectFootnoteCitations("A.[^src]\n\n[^src]: See [the filing](https://sec.gov/x), page 12.");

    expect(citations.get("src")).toEqual({
      identifier: "src",
      label: "the filing",
      href: "https://sec.gov/x",
      note: "See , page 12.",
    });
  });

  it("refuses a definition with no link, or more than one", () => {
    expect(collectFootnoteCitations("A.[^1]\n\n[^1]: Just a note.").size).toBe(0);
    expect(collectFootnoteCitations("A.[^1]\n\n[^1]: [a](resource://x) and [b](resource://y)").size).toBe(0);
  });

  it("refuses a definition carrying more than one block, which is a real footnote", () => {
    const source = [
      "A.[^1]",
      "",
      "[^1]: [a](resource://x)",
      "",
      "    A second paragraph makes this a footnote, not a citation.",
    ].join("\n");

    expect(collectFootnoteCitations(source).size).toBe(0);
  });

  it("reads a multi-line definition whose continuation is still one paragraph", () => {
    const source = ["A.[^1]", "", "[^1]: [The plan](resource://plan-7)", "    as published."].join("\n");

    expect(collectFootnoteCitations(source).get("1")?.note).toBe("as published.");
  });

  it("ignores a definition inside a fenced block, which is a syntax example", () => {
    const source = ["```markdown", "[^1]: [a](resource://x)", "```"].join("\n");

    expect(collectFootnoteCitations(source).size).toBe(0);
  });

  it("keys on the identifier as written, so a label footnote resolves as well as a numbered one", () => {
    const citations = collectFootnoteCitations("A.[^deck]\n\n[^deck]: [Deck](resource://d)");

    expect(citations.has("deck")).toBe(true);
  });
});

describe("rewriteCitationsForPlainDelivery", () => {
  it("reduces a chip to the label a reader can read", () => {
    expect(rewriteCitationsForPlainDelivery("See the [Mute windows PRD](resource://prd-1) for detail."))
      .toBe("See the Mute windows PRD for detail.");
  });

  it("reduces an embed card to its label instead of a broken image", () => {
    expect(rewriteCitationsForPlainDelivery("Published:\n\n![Mute windows PRD](resource://prd-1)\n"))
      .toBe("Published:\n\nMute windows PRD\n");
  });

  it("leaves an external link and a real image exactly as written", () => {
    const source = "See [the report](https://example.com/r) and ![a chart](https://example.com/c.png).";

    expect(rewriteCitationsForPlainDelivery(source)).toBe(source);
  });

  it("never rewrites inside code, where the syntax is the subject", () => {
    const source = "Write `[Title](resource://id)`:\n\n```md\n[Title](resource://id)\n```\n";

    expect(rewriteCitationsForPlainDelivery(source)).toBe(source);
  });

  it("cuts the right bytes when a code block contains an astral character", () => {
    // The mask is walked line by line and its offsets are used to slice the
    // original, so a mask one character short per emoji mis-cuts the definition
    // and leaves raw `resource://` syntax in the delivered copy.
    const source = [
      "Here is the fix.",
      "",
      "```js",
      "console.log(\"done 🚀\");",
      "```",
      "",
      "Revenue grew 40%.[^1]",
      "",
      "[^1]: [Q3 board deck](resource://deck-01)",
    ].join("\n");

    expect(rewriteCitationsForPlainDelivery(source)).toBe([
      "Here is the fix.",
      "",
      "```js",
      "console.log(\"done 🚀\");",
      "```",
      "",
      "Revenue grew 40%.[1]",
      "",
      "Sources:",
      "",
      "1. Q3 board deck",
    ].join("\n"));
  });

  it("turns footnotes into a numbered marker and a plain trailing source list", () => {
    const source = [
      "Revenue grew 40%.[^1] Costs held flat.[^2]",
      "",
      "[^1]: [Q3 board deck](resource://deck-01)",
      "[^2]: [The filing](https://sec.gov/x)",
    ].join("\n");

    expect(rewriteCitationsForPlainDelivery(source)).toBe([
      "Revenue grew 40%.[1] Costs held flat.[2]",
      "",
      "Sources:",
      "",
      "1. Q3 board deck",
      "2. The filing (https://sec.gov/x)",
    ].join("\n"));
  });

  it("does not close up blank lines inside a code block while tidying the body", () => {
    // Cutting definition lines leaves blank runs behind, and closing them up is
    // right — in prose. A fenced block's blank lines are part of the code, and
    // this is the copy a reader pastes into an editor.
    const source = [
      "Run this.[^1]",
      "",
      "```python",
      "def a():",
      "    pass",
      "",
      "",
      "def b():",
      "    pass",
      "```",
      "",
      "[^1]: [The runbook](resource://run-1)",
    ].join("\n");

    expect(rewriteCitationsForPlainDelivery(source)).toContain("    pass\n\n\ndef b():");
  });

  it("numbers by first reference, not by the order the definitions were written", () => {
    const source = [
      "Second.[^b] First.[^a]",
      "",
      "[^a]: [A](resource://a)",
      "[^b]: [B](resource://b)",
    ].join("\n");

    expect(rewriteCitationsForPlainDelivery(source)).toBe([
      "Second.[1] First.[2]",
      "",
      "Sources:",
      "",
      "1. B",
      "2. A",
    ].join("\n"));
  });

  it("reduces a resource link inside a classic footnote too, and keeps the footnote", () => {
    const source = ["A.[^1]", "", "[^1]: Compare [a](resource://x) with [b](resource://y)."].join("\n");

    expect(rewriteCitationsForPlainDelivery(source)).toBe([
      "A.[1]",
      "",
      "Sources:",
      "",
      "1. Compare a with b.",
    ].join("\n"));
  });

  it("keeps a source-list entry on one line, however the definition was wrapped", () => {
    // A numbered list item with a raw newline in it is two list items to the
    // next renderer along, and both delivery surfaces render this as Markdown.
    const source = [
      "A claim.[^1] Another.[^2]",
      "",
      "[^1]: A free-form note",
      "    that continues on a second line.",
      "[^2]: [The plan](resource://plan-7)",
      "    as published.",
    ].join("\n");

    expect(rewriteCitationsForPlainDelivery(source)).toBe([
      "A claim.[1] Another.[2]",
      "",
      "Sources:",
      "",
      "1. A free-form note that continues on a second line.",
      "2. as published. The plan",
    ].join("\n"));
  });

  it("drops a definition nothing referenced, exactly as a markdown renderer would", () => {
    expect(rewriteCitationsForPlainDelivery("A plain answer.\n\n[^1]: [Deck](resource://d)"))
      .toBe("A plain answer.");
  });

  it("leaves a reference with no definition as the literal text a renderer would show", () => {
    expect(rewriteCitationsForPlainDelivery("A claim.[^missing]")).toBe("A claim.[^missing]");
  });

  it("reduces a malformed citation too, so no raw scheme syntax can leave Rally", () => {
    expect(rewriteCitationsForPlainDelivery("See [A doc](resource://../../etc/passwd)."))
      .toBe("See A doc.");
  });

  it("reads a definition written with CRLF, which is what a forwarded body carries", () => {
    // Slack normalises line endings before calling this; the email path does
    // not, so the grammar normalises for both rather than trusting a caller.
    expect(rewriteCitationsForPlainDelivery(
      ["A claim.[^1]", "", "[^1]: [Deck](resource://d)", "", "Tail."].join("\r\n"),
    )).toBe("A claim.[1]\n\nTail.\n\nSources:\n\n1. Deck");
  });

  it("reduces the link forms a parser accepts but a naive regex misses", () => {
    // Each of these renders as a chip or a card in the desktop, so each of them
    // leaves Rally as raw `resource://` syntax if the rewrite cannot read it.
    expect(rewriteCitationsForPlainDelivery('Published [Deck](resource://d "The deck").'))
      .toBe("Published Deck.");
    expect(rewriteCitationsForPlainDelivery('![Deck](resource://d "The deck")')).toBe("Deck");
    expect(rewriteCitationsForPlainDelivery("Published [Q3 [draft] deck](resource://d)."))
      .toBe("Published Q3 [draft] deck.");
  });

  it("is a no-op on an answer that cites nothing", () => {
    const source = "# Heading\n\nA plain paragraph with **bold** text.\n";

    expect(rewriteCitationsForPlainDelivery(source)).toBe(source);
  });
});

describe("footnoteReferenceOrder", () => {
  it("numbers by first reference and drops what nothing references", () => {
    expect(footnoteReferenceOrder([
      "Second.[^b] First.[^a] Again.[^b]",
      "",
      "[^a]: [A](resource://a)",
      "[^b]: [B](resource://b)",
      "[^c]: [C](resource://c)",
    ].join("\n"))).toEqual(["b", "a"]);
  });

  it("does not count a definition's own marker as a reference to itself", () => {
    expect(footnoteReferenceOrder("Plain answer.\n\n[^1]: [A](resource://a)")).toEqual([]);
  });

  it("ignores a reference inside code, which is syntax being shown", () => {
    expect(footnoteReferenceOrder("Write `[^1]` like this.\n\n[^1]: [A](resource://a)")).toEqual([]);
  });
});
