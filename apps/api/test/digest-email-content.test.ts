import { describe, expect, it } from "vitest";

import { digestEmailHtml } from "../src/services/digest-email-content";
import { occurrenceLabel } from "../src/services/digest-delivery-service";

describe("digest email", () => {
  it("renders the body's markdown rather than escaping it into the shell", () => {
    const html = digestEmailHtml({
      recipientName: "Ada",
      workspaceName: "Avalon Studio",
      occurrenceLabel: "Tuesday 11 August · 9:00 AM",
      bodyMarkdown: "## Launch\n\n- One **thing** happened",
      itemCount: 1,
      highlightCount: 0,
      appUrl: "https://with-avalon.com",
      settingsUrl: "https://with-avalon.com/app/settings/digest",
    });

    // The renderer moved out of this module. Swapping the call back for an
    // escape would leave the whole digest suite green while handing readers the
    // `##` and `**` this change exists to remove.
    expect(html).toContain("<h2");
    expect(html).toContain("<ul");
    expect(html).toContain("<strong");
    expect(html).not.toContain("## Launch");
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

  it("declares itself light only so no dark-mode client repaints it", () => {
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

    expect(html).toContain('name="color-scheme" content="light only"');
    expect(html).toContain("color-scheme:light only");
    // The app's own canvas token, so the email and the product are one surface.
    expect(html).toContain("background:#f3f3f3");
    // A full-height body paints the pane itself, for the client that paints its
    // own background onto `html` and so stops the body's from propagating.
    expect(html).toMatch(/<html[^>]*style="[^"]*height:100%/u);
    expect(html).toMatch(/<body style="[^"]*height:100%;background:#f3f3f3/u);
    // That height is a percentage and never a viewport unit, and no table
    // carries one at all. Both would grow the message past its pane in a client
    // that measures them against something else — the browser window in webmail
    // that injects this markup into its own page, the page box in Word — and
    // hang a tail off the bottom of it.
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
