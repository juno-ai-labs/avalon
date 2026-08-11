import { describe, expect, it } from "vitest";

import { digestEmailHtml, digestMarkdownToHtml } from "../src/services/digest-email-content";
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

    expect(html).toContain("<h3");
    expect(html).toContain("Launch");
    expect(html).toContain("<ul");
    expect(html).toContain("<strong");
    expect(html).toContain('<a href="https://example.com/plan"');
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

  it("keeps every inline style inline, because mail clients drop stylesheets", () => {
    const html = digestEmailHtml({
      recipientName: "Ada",
      workspaceName: "Avalon Studio",
      occurrenceLabel: "Tuesday 11 August · 9:00 AM",
      bodyMarkdown: "## Launch\n\n- One thing happened",
      itemCount: 4,
      highlightCount: 1,
      settingsUrl: "https://with-avalon.com/app/settings/digest",
    });

    expect(html).not.toContain("<style");
    expect(html).toContain("Tuesday 11 August · 9:00 AM");
    expect(html).toContain("1 for you");
    expect(html).toContain("4 updates");
    expect(html).toContain("Hi Ada,");
  });

  it("singularizes the update count", () => {
    const html = digestEmailHtml({
      recipientName: "",
      workspaceName: "Avalon Studio",
      occurrenceLabel: "Tuesday",
      bodyMarkdown: "Something happened",
      itemCount: 1,
      highlightCount: 0,
      settingsUrl: "https://with-avalon.com/app/settings/digest",
    });

    expect(html).toContain("1 update<");
    expect(html).not.toContain("for you");
    expect(html).toContain("Here is your Avalon digest.");
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
