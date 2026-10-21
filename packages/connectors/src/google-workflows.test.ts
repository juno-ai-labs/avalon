import { describe, expect, it } from "vitest";
import { asUserId } from "@rally/contracts";
import { authorizedConnection, createGoogleConnector, type ConnectorToolContext } from "./index";
import { neverAborts } from "./test-signals";

const userId = asUserId("00000000-0000-4000-8000-000000000031");
function context(scopes = ["calendar.read", "calendar.write", "gmail.read", "gmail.modify", "gmail.draft", "gmail.send"]): ConnectorToolContext {
  return { principal: { type: "user", userId }, signal: neverAborts(), connection: authorizedConnection({ id: "00000000-0000-4000-8000-000000000032", workspaceId: "00000000-0000-4000-8000-000000000033", scope: "personal", ownerUserId: userId, grantedScopes: scopes, credentials: { accessToken: "test-only" }, cursor: {}, config: {} }) };
}
function adapter(fetcher: typeof fetch) {
  return createGoogleConnector({ clientId: "test-client", clientSecret: "test-secret", redirectUri: "https://example.test/oauth", fetch: async (input, init) => {
    const endpoint = url(input);
    // Provider fixtures for target resolution; selector behavior itself is
    // exercised without these fixtures in google-selectors.test.ts.
    if (endpoint.searchParams.get("maxResults") === "2") {
      const collection = endpoint.pathname.split("/").at(-1)!;
      return json({ [collection]: [{ id: collection === "drafts" ? "draft-1" : "123abc" }] });
    }
    if (endpoint.pathname.endsWith("/events") && endpoint.searchParams.get("singleEvents") === "true") return json({ items: [{ id: "weekly_20261021T160000Z", summary: "Standup", start: { dateTime: "2026-10-21T09:00:00-07:00" } }] });
    if (endpoint.pathname.endsWith("/primary") && !init?.body) return json({ id: "me@example.com", timeZone: "America/Los_Angeles" });
    return fetcher(input, init);
  } });
}
function json(value: unknown) { return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }); }
function url(input: RequestInfo | URL) { return new URL(input instanceof Request ? input.url : input.toString()); }
const occurrence = { id: "weekly_20261021T160000Z", recurringEventId: "weekly", organizer: { self: true }, attendees: [{ email: "me@example.com", self: true, responseStatus: "accepted" }, { email: "other@example.com", responseStatus: "tentative", optional: true }] };

describe("Google calendar workflows", () => {
  it.each(["occurrence", "series"] as const)("cancels exactly the requested %s and notifies guests", async (scope) => {
    const requests: Array<{ path: string; method: string; notifications: string | null }> = [];
    const connector = adapter(async (input, init) => {
      const endpoint = url(input);
      const method = init?.method ?? "GET";
      requests.push({ path: endpoint.pathname, method, notifications: endpoint.searchParams.get("sendUpdates") });
      if (method === "DELETE") return new Response(null, { status: 204 });
      return json(endpoint.pathname.endsWith("/weekly") ? { ...occurrence, id: "weekly", recurringEventId: undefined, recurrence: ["RRULE:FREQ=WEEKLY"] } : occurrence);
    });
    const result = await connector.executeTool(scope === "series" ? "calendar.cancel_recurring_series" : "calendar.cancel_event", { date: "2026-10-21", title: "Standup", startTime: "09:00" }, context());
    expect(requests.filter((request) => request.method === "DELETE")).toEqual([{ path: `/calendar/v3/calendars/primary/events/${scope === "series" ? "weekly" : occurrence.id}`, method: "DELETE", notifications: "all" }]);
    expect(result.output).toMatchObject({ id: scope === "series" ? "weekly" : occurrence.id, status: "cancelled", scope });
  });

  it("refuses a series master for occurrence scope without deleting anything", async () => {
    const methods: string[] = [];
    const connector = adapter(async (_input, init) => { methods.push(init?.method ?? "GET"); return json({ id: "weekly", recurrence: ["RRULE:FREQ=WEEKLY"], organizer: { self: true } }); });
    await expect(connector.executeTool("calendar.cancel_event", { date: "2026-10-21", title: "Standup" }, context())).rejects.toMatchObject({ details: { field: "date", reason: "occurrence_id_required" } });
    expect(methods).toEqual(["GET"]);
  });

  it("declines only the connected attendee and preserves every other guest", async () => {
    let body: unknown;
    const connector = adapter(async (_input, init) => {
      if (init?.method === "PATCH") { body = JSON.parse(String(init.body)); return json({ ...occurrence, ...body as object }); }
      return json(occurrence);
    });
    await connector.executeTool("calendar.respond_to_event", { date: "2026-10-21", title: "Standup", responseStatus: "declined", responseComment: "Away today" }, context());
    expect(body).toEqual({ attendees: [{ email: "me@example.com", self: true, responseStatus: "declined", comment: "Away today" }, { email: "other@example.com", responseStatus: "tentative", optional: true }] });
  });

  it("does not treat declining as organizer-wide cancellation", async () => {
    const methods: string[] = [];
    const connector = adapter(async (_input, init) => { methods.push(init?.method ?? "GET"); return json({ ...occurrence, organizer: { self: false } }); });
    await expect(connector.executeTool("calendar.cancel_event", { date: "2026-10-21", title: "Standup" }, context())).rejects.toMatchObject({ details: { reason: "organizer_required" } });
    expect(methods).toEqual(["GET"]);
  });

  it("creates an all-day recurring event with a generated Meet conference", async () => {
    let body: Record<string, unknown> = {};
    let endpoint: URL | undefined;
    const connector = adapter(async (input, init) => {
      endpoint = url(input); body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({ id: "new-series", ...body, hangoutLink: "https://meet.google.com/abc-defg-hij" });
    });
    const result = await connector.executeTool("calendar.create_recurring_event", { summary: "Office day", start: "2026-10-21", end: "2026-10-22", repeat: { frequency: "weekly" }, timeZone: "America/Los_Angeles", addGoogleMeetUrl: true }, context());
    expect(body).toMatchObject({ start: { date: "2026-10-21" }, end: { date: "2026-10-22" }, recurrence: ["RRULE:FREQ=WEEKLY"], conferenceData: { createRequest: { conferenceSolutionKey: { type: "hangoutsMeet" } } } });
    expect(endpoint?.searchParams.get("conferenceDataVersion")).toBe("1");
    expect(result.output).toMatchObject({ conferenceUrl: "https://meet.google.com/abc-defg-hij" });
  });

  it("does not notify guests for an omitted conference change and empty guest additions", async () => {
    const writes: Array<{ body: unknown; notifications: string | null }> = [];
    const connector = adapter(async (input, init) => {
      writes.push({ body: JSON.parse(String(init?.body)), notifications: url(input).searchParams.get("sendUpdates") });
      return json({ id: "known-event" });
    });
    await connector.executeTool("calendar.update_event", { eventId: "known-event", addGoogleMeetUrl: false, addAttendeeEmails: [] }, context());
    expect(writes).toEqual([{ body: {}, notifications: null }]);
  });

  it("finds free time using every attendee and preferred hours", async () => {
    let query: unknown;
    const connector = adapter(async (input, init) => {
      if (url(input).pathname.endsWith("/primary")) return json({ id: "me@example.com", timeZone: "America/Los_Angeles" });
      query = JSON.parse(String(init?.body));
      return json({ calendars: { "me@example.com": { busy: [{ start: "2026-10-21T16:00:00Z", end: "2026-10-21T16:30:00Z" }] }, "other@example.com": { busy: [{ start: "2026-10-21T17:00:00Z", end: "2026-10-21T18:00:00Z" }] } } });
    });
    const result = await connector.executeTool("calendar.suggest_time", { attendeeEmails: ["other@example.com"], startTime: "2026-10-21T00:00:00-07:00", endTime: "2026-10-22T00:00:00-07:00", durationMinutes: 30, preferences: { startHour: "09:00", endHour: "12:00" } }, context());
    expect(query).toMatchObject({ items: [{ id: "me@example.com" }, { id: "other@example.com" }] });
    expect(result.output).toMatchObject({ timeSlots: [{ start: "2026-10-21T16:30:00.000Z", end: "2026-10-21T17:00:00.000Z", availableUntil: "2026-10-21T17:00:00.000Z" }, { start: "2026-10-21T18:00:00.000Z", end: "2026-10-21T18:30:00.000Z", availableUntil: "2026-10-21T19:00:00.000Z" }] });
  });

  it("refuses to suggest availability when one attendee's calendar is inaccessible", async () => {
    const connector = adapter(async (input) => url(input).pathname.endsWith("/primary") ? json({ id: "me@example.com", timeZone: "UTC" }) : json({ calendars: { "me@example.com": { busy: [] }, "other@example.com": { errors: [{ reason: "notFound" }] } } }));
    await expect(connector.executeTool("calendar.suggest_time", { attendeeEmails: ["other@example.com"], startTime: "2026-10-21T09:00:00Z", endTime: "2026-10-21T12:00:00Z", durationMinutes: 30 }, context())).rejects.toMatchObject({ details: { field: "attendeeEmails", reason: "availability_unavailable" } });
  });
});

describe("Google inbox and draft workflows", () => {
  it("requires inbox-write authority even when the provider token can modify mail", async () => {
    let calls = 0;
    const connector = adapter(async () => { calls++; return json({}); });
    await expect(connector.executeTool("gmail.trash", { query: "subject:Proposal" }, context(["gmail.read"]))).rejects.toMatchObject({ code: "unsupported_capability" });
    expect(calls).toBe(0);
  });

  it("resolves a custom label by name without model-supplied IDs", async () => {
    const writes: unknown[] = [];
    const connector = adapter(async (input, init) => {
      if (url(input).pathname.endsWith("/labels")) return json({ labels: [{ id: "INBOX", name: "INBOX", type: "system" }, { id: "UNREAD", name: "UNREAD", type: "system" }, { id: "Label_7", name: "Projects/Alpha", type: "user" }] });
      writes.push(JSON.parse(String(init?.body)));
      return json({ id: "123abc", threadId: "789def", labelIds: ["Label_7"] });
    });
    const result = await connector.executeTool("gmail.label", { query: "subject:Proposal", labels: ["Projects/Alpha"] }, context());
    expect(writes).toEqual([{ addLabelIds: ["Label_7"], removeLabelIds: [] }]);
    expect(result.output).toMatchObject({ id: "123abc", threadId: "789def", labelIds: ["Label_7"] });
  });

  it("trashes and restores a conversation through reversible endpoints", async () => {
    const paths: string[] = [];
    const connector = adapter(async (input) => { paths.push(url(input).pathname); return json({ id: "123abc", threadId: "123abc" }); });
    await connector.executeTool("gmail.trash", { query: "subject:Proposal" }, context());
    const restored = await connector.executeTool("gmail.restore_from_trash", { query: "subject:Proposal" }, context());
    expect(paths).toEqual(["/gmail/v1/users/me/threads/123abc/trash", "/gmail/v1/users/me/threads/123abc/untrash"]);
    expect(restored.output).toMatchObject({ id: "123abc", trashed: false });
  });

  it("lists drafts with their draft and message identities, then reads the draft body", async () => {
    const connector = adapter(async (input) => {
      const endpoint = url(input);
      if (endpoint.pathname.endsWith("/drafts")) return json({ drafts: [{ id: "draft-1", message: { id: "123abc", threadId: "789def" } }], nextPageToken: "opaque" });
      return json({ id: "draft-1", message: { id: "123abc", threadId: "789def", payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: "Proposal" }], body: { data: "SGVsbG8=" } } } });
    });
    const listed = await connector.executeTool("gmail.list_drafts", { query: "subject:Proposal" }, context());
    expect(listed.output).toMatchObject({ items: [{ id: "draft-1", messageId: "123abc", threadId: "789def", subject: "Proposal" }], appliedFilters: { query: "subject:Proposal" } });
    expect(listed.pagination).toMatchObject({ continuations: [{ input: { query: "subject:Proposal", pageToken: "opaque" } }] });
    expect((await connector.executeTool("gmail.read_draft", { query: "subject:Proposal" }, context())).output).toMatchObject({ id: "draft-1", message: { textContent: "Hello" } });
  });

  it.each(["gmail.create_draft", "gmail.send"])("composes HTML, BCC and signature in %s", async (name) => {
    let mime = "";
    const connector = adapter(async (input, init) => {
      if (url(input).pathname.endsWith("/settings/sendAs")) return json({ sendAs: [{ isDefault: true, signature: "<b>Adam</b>" }] });
      const value = JSON.parse(String(init?.body)) as { raw?: string; message?: { raw: string } };
      mime = Buffer.from(value.raw ?? value.message!.raw, "base64url").toString("utf8");
      return json({ id: "draft-1", message: { id: "123abc", threadId: "789def" } });
    });
    await connector.executeTool(name, { to: ["recipient@example.com"], bcc: ["hidden@example.com"], subject: "Invoice", body: "Attached.", htmlBody: "<p>Attached.</p>", includeSignature: true }, context());
    expect(mime).toContain("Bcc: hidden@example.com\r\n");
    expect(mime).toContain("multipart/alternative");
    expect(mime).toContain(Buffer.from("<p>Attached.</p><br><br><b>Adam</b>").toString("base64"));
  });
});
