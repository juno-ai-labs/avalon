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

  it("keeps the plain-text alternative readable", () => {
    const text = markdownToEmailText("# Heading\n\n\n\nA line.\n");

    expect(text).toBe("# Heading\n\nA line.");
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
});
