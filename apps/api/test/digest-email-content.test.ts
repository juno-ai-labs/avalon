import { describe, expect, it } from "vitest";

import { digestEmailHtml, digestMarkdownToHtml, digestMarkdownToText } from "../src/services/digest-email-content";
import { occurrenceLabel } from "../src/services/digest-delivery-service";

describe("digest markdown rendering", () => {
  it("renders the structure a digest actually uses", () => {
    const html = digestMarkdownToHtml([
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

  it("numbers an ordered list instead of bulleting it", () => {
    const html = digestMarkdownToHtml("1. First\n2. Second\n3. Third");

    expect(html).toContain("<ol");
    expect(html).toContain("list-style:decimal");
    expect(html).not.toContain("<ul");
  });

  it("keeps a bulleted sublist bulleted under a numbered step", () => {
    // The parent's marker is not the child's: inheriting it renumbered a list
    // of notes under step 2 as steps of its own.
    const html = digestMarkdownToHtml("1. Freeze writes\n2. Backfill\n   - one pass\n   - then verify\n3. Cut over");

    expect(html).toMatch(/<ul[^>]*list-style:circle/u);
    expect(html).toContain("one pass");
    expect((html.match(/<ol/gu) ?? []).length).toBe(1);
  });

  it("nests a sublist inside the item it belongs to", () => {
    const html = digestMarkdownToHtml("- Parent\n  - Child\n- Sibling");

    expect(html).toMatch(/<li[^>]*>Parent<ul[^>]*><li[^>]*>Child<\/li><\/ul><\/li>/u);
    expect(html).toContain("Sibling");
  });

  it("renders a table as a table rather than as a row of pipes", () => {
    const html = digestMarkdownToHtml("| Name | Count |\n| --- | --- |\n| Alpha | 3 |");

    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).toMatch(/<td[^>]*>Alpha<\/td>/u);
    expect(html).not.toContain("| Alpha |");
  });

  it("keeps a fenced block intact, newlines and markup characters included", () => {
    const html = digestMarkdownToHtml("```ts\nconst a = 1;\nif (a && b) return;\n```");

    expect(html).toContain("<pre");
    expect(html).toContain("const a = 1;\nif (a &amp;&amp; b) return;");
    // The fence itself is syntax, not content, and never reaches the reader.
    expect(html).not.toContain("```");
  });

  it("does not style the inside of a code span", () => {
    // A command with asterisks in it is a command; bolding part of it makes it
    // one nobody can copy.
    const html = digestMarkdownToHtml("Run `npm run **build**` now");

    expect(html).toContain("npm run **build**");
    expect(html).not.toContain("<strong");
  });

  it("shows a mention as its label, having nowhere outside Avalon to link it", () => {
    const source = "Assigned to [@Ada Lovelace](person:0199-abc) in [#launch](connector:slack:launch).";

    expect(digestMarkdownToHtml(source)).toContain("Assigned to @Ada Lovelace in #launch.");
    expect(digestMarkdownToHtml(source)).not.toContain("person:");
    expect(digestMarkdownToText(source)).toBe("Assigned to @Ada Lovelace in #launch.");
  });

  it("decodes a character reference instead of showing its source", () => {
    const html = digestMarkdownToHtml("A &amp; B, &rarr; C, &#8212; D");

    expect(html).toContain("A &amp; B, → C, — D");
    expect(html).not.toContain("&amp;amp;");
  });

  it("escapes a decoded reference rather than letting it become markup", () => {
    // Decoding runs before escaping precisely so this cannot open a tag.
    const html = digestMarkdownToHtml("&lt;script&gt;alert(1)&lt;/script&gt;");

    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });

  it("marks a task list with a character no client can break", () => {
    const html = digestMarkdownToHtml("- [x] Done\n- [ ] Pending");

    expect(html).toContain("☑ Done");
    expect(html).toContain("☐ Pending");
    expect(html).not.toContain("[x]");
  });

  it("renders single-asterisk emphasis and strikethrough", () => {
    expect(digestMarkdownToHtml("This is *urgent* work")).toContain("<em");
    expect(digestMarkdownToHtml("~~dropped~~ and kept")).toContain("<del");
  });

  it("links a bare URL without linking an underscore into emphasis", () => {
    const html = digestMarkdownToHtml("See https://example.com/a_b_c/page for more");

    expect(html).toContain('<a href="https://example.com/a_b_c/page"');
    expect(html).not.toContain("<em");
  });

  it("shows the character a model meant instead of the TeX it wrote", () => {
    expect(digestMarkdownToHtml("Backlog $\\rightarrow$ Done")).toContain("Backlog → Done");
    expect(digestMarkdownToText("Backlog $\\rightarrow$ Done")).toBe("Backlog → Done");
    // And leaves a price alone, which is the reason that rule is written the
    // way it is.
    expect(digestMarkdownToHtml("Seats cost $50 and $70")).toContain("Seats cost $50 and $70");
  });

  it("never lets model output become markup", () => {
    const html = digestMarkdownToHtml('<img src=x onerror="alert(1)"> and <script>alert(2)</script>');

    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script");
  });

  it("refuses a link target that is not http", () => {
    // The label survives as text; only the anchor is withheld, so nothing is
    // silently swallowed and nothing dangerous is emitted.
    const html = digestMarkdownToHtml("[click](javascript:alert(1))");

    expect(html).not.toContain("<a href");
    expect(html).toContain("click");
  });

  it("keeps every style inline, because mail clients drop stylesheets", () => {
    const html = digestEmailHtml({
      recipientName: "Ada",
      workspaceName: "Avalon Studio",
      occurrenceLabel: "Tuesday 11 August · 9:00 AM",
      bodyMarkdown: "## Launch\n\n- One thing happened",
      itemCount: 4,
      highlightCount: 1,
      appUrl: "https://with-avalon.com",
      settingsUrl: "https://with-avalon.com/app/settings/digest",
    });

    expect(html).not.toContain("<style");
    expect(html).toContain("Tuesday 11 August · 9:00 AM");
    expect(html).toContain("1 for you");
    expect(html).toContain("4 updates");
    expect(html).toContain("Hi Ada — here");
    // The preheader is what a phone shows beside the subject, so it leads with
    // the number that decides whether this is opened now.
    expect(html).toContain("1 needs you · 4 updates in Avalon Studio");
  });

  it("declares itself dark so no client repaints it", () => {
    const html = digestEmailHtml({
      recipientName: "Ada",
      workspaceName: "Avalon Studio",
      occurrenceLabel: "Tuesday",
      bodyMarkdown: "Something happened",
      itemCount: 1,
      highlightCount: 0,
      appUrl: "https://with-avalon.com",
      settingsUrl: "https://with-avalon.com/app/settings/digest",
    });

    expect(html).toContain('name="color-scheme" content="dark"');
    expect(html).toContain("color-scheme:dark");
    // The app's own canvas token, so the email and the product are one surface.
    expect(html).toContain("background:#111210");
    // A full-height body paints the pane itself, for the client that paints its
    // own background onto `html` and so stops the body's from propagating.
    expect(html).toMatch(/<html[^>]*style="[^"]*height:100%/u);
    expect(html).toMatch(/<body style="[^"]*height:100%;background:#111210/u);
    // That height is a percentage and never a viewport unit, and no table
    // carries one at all. Both would grow the message past its pane in a client
    // that measures them against something else — the browser window in webmail
    // that injects this markup into its own page, the page box in Word — and
    // hang a dark tail off the bottom of it.
    expect(html).not.toMatch(/\d(?:vh|vmin|vmax)/u);
    expect(html).not.toMatch(/<table[^>]*height/u);
  });

  it("singularizes the update count", () => {
    const html = digestEmailHtml({
      recipientName: "",
      workspaceName: "Avalon Studio",
      occurrenceLabel: "Tuesday",
      bodyMarkdown: "Something happened",
      itemCount: 1,
      highlightCount: 0,
      appUrl: "https://with-avalon.com",
      settingsUrl: "https://with-avalon.com/app/settings/digest",
    });

    expect(html).toContain("1 update<");
    expect(html).not.toContain("for you");
    expect(html).toContain("Here is what moved");
  });
});

describe("digest occurrence label", () => {
  it("reads the instant in the recipient's own timezone", () => {
    const at = "2026-08-11T16:00:00.000Z";

    expect(occurrenceLabel(at, "America/Los_Angeles")).toBe("Tuesday 11 August · 9:00 AM");
    expect(occurrenceLabel(at, "Europe/London")).toBe("Tuesday 11 August · 5:00 PM");
  });

  it("degrades rather than throwing on a timezone the runtime cannot resolve", () => {
    expect(occurrenceLabel("2026-08-11T16:00:00.000Z", "Mars/Olympus_Mons")).toBe("Your digest");
    expect(occurrenceLabel("not-a-date", "Europe/London")).toBe("Your digest");
  });
});
