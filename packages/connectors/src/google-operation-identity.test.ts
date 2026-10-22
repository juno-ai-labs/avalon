import { describe, expect, it } from "vitest";
import { googleOperationIdentity, googleOperationResultKeys } from "./google-operation-identity";

describe("authored Google operation identity", () => {
  it.each([
    ["drive.get_metadata", { fileId: "file-1" }], ["drive.download", { fileId: "file-1" }],
    ["docs.read_document", { documentId: "file-1" }], ["docs.append_text", { documentId: "file-1", text: "hello" }],
    ["sheets.read_values", { spreadsheetId: "file-1", range: "A1" }],
    ["sheets.update_values", { spreadsheetId: "file-1", range: "A1", values: [[1]] }],
  ])("recognizes the same globally addressed file for %s", (operation, input) => {
    expect(googleOperationIdentity(operation, input)).toEqual({ kind: "resource", resourceKeys: ["google:file:file-1"] });
  });

  it("starts a new search in the task account and binds its references for follow-up work", () => {
    expect(googleOperationIdentity("gmail.search", { query: "from:maya" })).toEqual({ kind: "account", resourceKeys: [] });
    expect(googleOperationResultKeys("gmail.search", { query: "from:maya" }, {
      output: { messages: [{ id: "message-1", threadId: "thread-1" }] }, summary: "Found mail",
    })).toEqual(["google:mail_query:from:maya", "google:message:message-1", "google:thread:thread-1"]);
    expect(googleOperationIdentity("gmail.reply", { messageId: "message-1" })).toEqual({ kind: "account", resourceKeys: ["google:message:message-1"] });
    expect(googleOperationIdentity("gmail.reply", { query: "from:maya" })).toEqual({ kind: "account", resourceKeys: ["google:mail_query:from:maya"] });
  });

  it("retains created file and draft identities without exposing cursors as resource identities", () => {
    expect(googleOperationResultKeys("docs.create_document", {}, { output: { documentId: "doc-1" }, summary: "Created" }))
      .toEqual(["google:file:doc-1"]);
    expect(googleOperationResultKeys("gmail.create_draft", {}, {
      output: { id: "draft-1", message: { id: "message-1", threadId: "thread-1" }, nextPageToken: "private-cursor" }, summary: "Drafted",
    })).toEqual(["google:draft:draft-1", "google:message:message-1", "google:thread:thread-1"]);
  });

  it("binds event IDs from the actual calendar-list projection", () => {
    expect(googleOperationResultKeys("calendar.list_events", {}, {
      output: { items: [{ id: "event-1", calendarId: "calendar-1" }] }, summary: "Found event",
    })).toEqual(["google:event:calendar-1:event-1", "google:calendar:calendar-1"]);
    expect(googleOperationIdentity("calendar.update_event", { calendarId: "calendar-1", eventId: "event-1" }))
      .toEqual({ kind: "account", resourceKeys: ["google:event:calendar-1:event-1", "google:calendar:calendar-1"] });
  });
});
