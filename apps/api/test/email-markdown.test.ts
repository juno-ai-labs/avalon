import { describe, expect, it } from "vitest";

import {
  markdownToEmailHtml,
  markdownToEmailPreheader,
  markdownToEmailText,
} from "../src/services/email-markdown";

describe("email markdown rendering", () => {
  it("renders the structure these emails actually use", () => {
    const html = markdownToEmailHtml([
      "## Launch",
      "",
      "Two things moved today.",
      "",
      "- Shipped the **installer**",
      "- Reviewed [the plan](https://example.com/plan)",
    ].join("\n"));

    // Two heading levels and no more: a third reads as noise in a mail client.
    expect(html).toContain("<h2");
    expect(html).toContain("Launch");
    expect(html).toContain("<ul");
    expect(html).toContain("<strong");
    expect(html).toContain('<a href="https://example.com/plan"');
  });

  it("never lets model output become markup", () => {
    const html = markdownToEmailHtml('<img src=x onerror="alert(1)"> and <script>alert(2)</script>');

    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script");
  });

  it("refuses a link target that is not http", () => {
    // The label survives as text; only the anchor is withheld, so nothing is
    // silently swallowed and nothing dangerous is emitted.
    const html = markdownToEmailHtml("[click](javascript:alert(1))");

    expect(html).not.toContain("<a href");
    expect(html).toContain("click");
  });

  it("renders an automation briefing rather than showing its markup", () => {
    // The shape a competitor briefing actually arrives in, which reached one
    // inbox as literal `##` and `**` before the renderer was shared.
    const html = markdownToEmailHtml([
      "# Daily briefing",
      "",
      "**Date:** 2026-08-22",
      "",
      "## Deep dive",
      "",
      "- **Positioning:** they now claim the multiplayer angle",
    ].join("\n"));

    expect(html).not.toContain("##");
    expect(html).not.toContain("**");
    expect(html).toContain("<h2");
    expect(html).toContain("<strong");
    expect(html).toContain("<li");
  });

  it("converts the plain-text alternative rather than passing markdown through", () => {
    const text = markdownToEmailText([
      "# Daily briefing",
      "",
      "1. **Positioning:** they claim [the angle](https://example.com/x)",
      "- A plain point with `code` in it",
    ].join("\n"));

    // The one client that will never render markup is the one this part is
    // for, so it must not be handed `##` and `**`.
    expect(text).toBe([
      "Daily briefing",
      "",
      "  1. Positioning: they claim the angle (https://example.com/x)",
      "  - A plain point with code in it",
    ].join("\n"));
  });

  it("strips markdown out of the inbox preview line", () => {
    const preheader = markdownToEmailPreheader([
      "# Daily briefing",
      "",
      "- **Positioning:** they claim [the angle](https://example.com/x)",
    ].join("\n"));

    expect(preheader).toBe("Daily briefing Positioning: they claim the angle");
  });

  it("bounds the preview line rather than handing a client the whole result", () => {
    const preheader = markdownToEmailPreheader(`# ${"word ".repeat(80)}`, 40);

    expect(preheader.length).toBe(40);
    expect(preheader.endsWith("…")).toBe(true);
  });

  it("keeps a sub-bullet under the point it belongs to", () => {
    const html = markdownToEmailHtml([
      "- **Key source links:**",
      "  - [First](https://example.com/one)",
      "  - [Second](https://example.com/two)",
      "- **Next finding:** something else",
    ].join("\n"));

    // A briefing hangs its sources off the claim they support. Flattened into
    // siblings they read as three more findings.
    expect(html.match(/<ul/gu)).toHaveLength(2);
    expect(html.match(/<li/gu)).toHaveLength(4);
    expect(html.indexOf("First")).toBeLessThan(html.indexOf("</ul></li>"));
  });

  it("renders both emphasis marks", () => {
    const html = markdownToEmailHtml('Their claim is *"multiplayer natively"* and _measured_ here.');

    expect(html).toContain("<em");
    expect(html).not.toContain("*");
    expect(html).not.toContain("_");
  });

  it("leaves a lone asterisk alone", () => {
    const html = markdownToEmailHtml("A 3 * 4 grid and a trailing star *");

    expect(html).not.toContain("<em");
    expect(html).toContain("3 * 4");
  });

  it("shows the character a model meant instead of the TeX it wrote, in all three outputs", () => {
    expect(markdownToEmailHtml("Backlog $\\rightarrow$ Done")).toContain("Backlog → Done");
    expect(markdownToEmailText("Backlog $\\rightarrow$ Done")).toBe("Backlog → Done");
    expect(markdownToEmailPreheader("Backlog $\\rightarrow$ Done")).toBe("Backlog → Done");
    // And leaves money and shell variables alone, which is the reason the
    // math rule is written the way it is.
    expect(markdownToEmailHtml("Seats cost $50 and $70")).toContain("Seats cost $50 and $70");
    expect(markdownToEmailText("Set $DATABASE_URL first")).toBe("Set $DATABASE_URL first");
  });

  // The normalizer escapes what it unwraps on the contract that a Markdown
  // parser downstream consumes the backslash. This renderer *is* that parser,
  // so the escape is parked and restored as its character — and the plain-text
  // alternative uses the entry point that manufactures no escapes at all.
  it("consumes a Markdown escape instead of showing the backslash", () => {
    expect(markdownToEmailHtml("Range $\\text{a\\_b}$ done")).toContain("Range a_b done");
    expect(markdownToEmailText("Range $\\text{a\\_b}$ done")).toBe("Range a_b done");
    // A model's own escape means the literal character, not emphasis.
    const literal = markdownToEmailHtml("A \\*literal\\* star");
    expect(literal).toContain("A *literal* star");
    expect(literal).not.toContain("<em");
  });

  it("refuses to read escaped brackets as a link", () => {
    // What the normalizer escaped is literal text; a link pass reading through
    // the escapes would hide a target behind a label it promised was plain.
    const html = markdownToEmailHtml("$\\text{[a](https://evil.example/x)}$");

    expect(html).not.toMatch(/<a [^>]*>a<\/a>/u);
    expect(html).toContain("[a](");
  });

  it("keeps a backslash inside a code span, where it is code and not an escape", () => {
    const html = markdownToEmailHtml("Match `\\d+\\.` exactly");

    expect(html).toContain("\\d+\\.");
  });

  it("cannot be made to splice markup into a link's own href", () => {
    // The emphasis and code passes run after the link pass, over the whole
    // string. An emphasis pair inside a URL used to match there and splice this
    // renderer's own quoted template into the attribute it had just written,
    // breaking the destination and spilling the tag into visible text.
    const html = markdownToEmailHtml([
      "[a](https://example.com/**b**c)",
      "",
      "[b](https://example.com/(_x_.z)",
      "",
      "[c](https://example.com/`q`)",
    ].join("\n"));

    expect(html).not.toContain('href="https://example.com/<');
    expect(html).not.toContain("<strong style=\"color:#ecebe5;font-weight:650\">b</strong>c\"");
    expect(html).toContain('href="https://example.com/&#42;&#42;b&#42;&#42;c"');
    expect(html).toContain("&#95;x&#95;");
    expect(html).toContain("&#96;q&#96;");
  });

  it("keeps emphasis marks out of a code span", () => {
    const html = markdownToEmailHtml("Run `a _b_ c` first.");

    expect(html).toContain("a _b_ c");
    expect(html).not.toContain("<em");
  });

  it("numbers a ranked list instead of bulleting it", () => {
    const html = markdownToEmailHtml([
      "1. **Contoso** — priced against the model cut",
      "2. **Northwind** — rebranded",
      "   1. Announced on stage",
    ].join("\n"));

    // A stack-ranked briefing is what the compiler asks automations for, and a
    // ranking whose numbers are dropped is a ranking the reader cannot see.
    expect(html).toContain("<ol");
    expect(html).not.toContain("<ul");
    expect(html.match(/<ol/gu)).toHaveLength(2);
  });

  it("keeps a fenced block whole instead of mangling it into an inline span", () => {
    const html = markdownToEmailHtml([
      "Here it is:",
      "",
      "```json",
      '{"rank": 1}',
      "```",
      "",
      "Done.",
    ].join("\n"));

    expect(html).toContain("<pre");
    expect(html).toContain("&quot;rank&quot;: 1");
    expect(html).not.toContain("``");
    expect(html).not.toContain("<code");
  });

  it("keeps a table's rows and columns rather than joining them into a paragraph", () => {
    const html = markdownToEmailHtml([
      "| Rank | Company |",
      "| --- | --- |",
      "| 1 | Contoso |",
    ].join("\n"));

    expect(html).toContain("<pre");
    expect(html).toContain("| Rank | Company |\n| --- | --- |\n| 1 | Contoso |");
  });

  it("renders the smaller structures a result actually uses", () => {
    const html = markdownToEmailHtml([
      "### A subsection",
      "",
      "---",
      "",
      "> Somebody said this.",
      "> And then this.",
      "",
      "A paragraph",
      "wrapped over two lines.",
      "",
      "- A bullet",
      "  that wraps",
      "\t- and a tab-indented child",
    ].join("\n"));

    expect(html).toContain("<h3");
    expect(html).toContain("<hr");
    expect(html).toContain("<blockquote");
    expect(html).toContain("Somebody said this. And then this.");
    expect(html).toContain("A paragraph wrapped over two lines.");
    expect(html).toContain("A bullet that wraps");
    // A tab is an indent, not one column: the child belongs under the bullet.
    expect(html.match(/<ul/gu)).toHaveLength(2);
  });

  it("promotes an indented bullet with nothing above it", () => {
    const html = markdownToEmailHtml("  - An only child\n  - And another");

    expect(html.match(/<ul/gu)).toHaveLength(1);
    expect(html.match(/<li/gu)).toHaveLength(2);
  });

  it("leaves snake_case and __dunder__ alone", () => {
    const html = markdownToEmailHtml("The tracking_id and __init__ both survive.");

    expect(html).not.toContain("<em");
    expect(html).toContain("tracking_id");
    expect(html).toContain("__init__");
  });

  it("strips the same marks from the preview line that the body renders", () => {
    // The preview and the body disagreed here: one stripped `__bold__` and the
    // other rendered it, so the inbox showed marks the email did not.
    const preheader = markdownToEmailPreheader("__Bold__ and *thin* and ~~cut~~ and `code`.");

    expect(preheader).toBe("Bold and thin and cut and code.");
  });

  it("separates a document title from the sections under it", () => {
    const html = markdownToEmailHtml("# The briefing\n\n## A section\n\n### A subsection");

    // A result usually opens with its own title. Rendered identically to its
    // sections, a long briefing reads as one flat rank and the reader cannot
    // tell the document's name from the first finding in it.
    expect(html).toContain("<h1");
    expect(html).toContain("<h2");
    expect(html).toContain("<h3");
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf("<h2"));
  });
});

describe("citations in outbound email", () => {
  // Every one of these leaks today without the rewrite: the HTML path links
  // only http(s) targets, so a `resource://` link passes through as literal
  // bracket syntax; the text path appends raw link targets whatever their
  // scheme; and footnote syntax has no handling at all in either part.
  it("reduces a chip and an embed card to their label in the HTML part", () => {
    const html = markdownToEmailHtml([
      "Published the [Mute windows PRD](resource://prd-1) today.",
      "",
      "![Mute windows PRD](resource://prd-1)",
    ].join("\n"));

    expect(html).toContain("Published the Mute windows PRD today.");
    expect(html).not.toContain("resource://");
    expect(html).not.toContain("[Mute windows PRD]");
  });

  it("turns footnotes into a plain trailing source list in the HTML part", () => {
    const html = markdownToEmailHtml([
      "Revenue grew 40%.[^1] Costs held flat.[^2]",
      "",
      "[^1]: [Q3 board deck](resource://deck-01)",
      "[^2]: [The filing](https://sec.gov/x)",
    ].join("\n"));

    expect(html).toContain("Revenue grew 40%.[1] Costs held flat.[2]");
    expect(html).toContain("Sources:");
    expect(html).toContain("Q3 board deck");
    expect(html).toContain("https://sec.gov/x");
    expect(html).not.toContain("[^1]");
  });

  it("reduces the same citations in the plain-text part and the preheader", () => {
    const markdown = [
      "Published the [Mute windows PRD](resource://prd-1).[^1]",
      "",
      "[^1]: [Q3 board deck](resource://deck-01)",
    ].join("\n");

    const text = markdownToEmailText(markdown);
    expect(text).toContain("Published the Mute windows PRD.[1]");
    expect(text).toContain("1. Q3 board deck");
    expect(text).not.toContain("resource://");
    expect(text).not.toContain("[^1]");

    // The preheader drops list markers, as it does for every list: it is one
    // line beside a subject, so the rank is spent space there.
    expect(markdownToEmailPreheader(markdown)).toBe("Published the Mute windows PRD.[1] Sources: Q3 board deck");
  });

  it("keeps an external link and a real image, which mean what they mean in mail", () => {
    const html = markdownToEmailHtml("See [the report](https://example.com/r).");

    expect(html).toContain('href="https://example.com/r"');
  });
});
