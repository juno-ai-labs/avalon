import { describe, expect, it } from "vitest";

import { sourceConnectorName } from "./sidekick-source-words";

describe("what a source's connector is called", () => {
  it("names the Google product a source's events belong to, and Google for a mix", () => {
    expect(sourceConnectorName("google", ["email.received", "email.updated"], "Google")).toBe("Gmail");
    expect(sourceConnectorName("google", ["calendar.event_changed"], "Google")).toBe("Google Calendar");
    expect(sourceConnectorName("google", ["drive.file_changed", "docs.document_changed", "sheets.spreadsheet_changed"], "Google")).toBe("Google Drive");
    expect(sourceConnectorName("google", ["email.received", "calendar.event_changed"], "Google")).toBe("Google");
    expect(sourceConnectorName("google", [], "Google")).toBe("Google");
  });

  it("calls every other connector by the name it was given", () => {
    expect(sourceConnectorName("github", ["email.received"], "GitHub")).toBe("GitHub");
  });
});
