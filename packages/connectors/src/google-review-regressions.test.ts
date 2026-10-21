import { describe, expect, it, vi } from "vitest";
import { asUserId } from "@rally/contracts";
import { authorizedConnection, createGoogleConnector, type ConnectorToolContext } from "./index";
import { calendarDayBoundary } from "./google-time";
import { googleRecurrenceRule } from "./google-recurrence";
import { suggestCalendarTimes } from "./google-availability";
import { neverAborts } from "./test-signals";

const resourceId = "00000000-0000-4000-8000-000000000033";
function context(): ConnectorToolContext {
  const userId = asUserId("00000000-0000-4000-8000-000000000031");
  return { principal: { type: "user", userId }, signal: neverAborts(), connection: authorizedConnection({ id: "00000000-0000-4000-8000-000000000032", workspaceId: resourceId, scope: "personal", ownerUserId: userId, grantedScopes: ["calendar.read", "calendar.write", "gmail.read", "gmail.modify", "gmail.draft", "gmail.send"], credentials: { accessToken: "test-only" }, cursor: {}, config: {} }) };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const endpoint = (input: RequestInfo | URL) => new URL(input instanceof Request ? input.url : input.toString());
const adapter = (fetch: typeof globalThis.fetch) => createGoogleConnector({ clientId: "test", clientSecret: "test", redirectUri: "https://example.test/oauth", fetch });
const mimeBody = (init?: RequestInit) => {
  const data = JSON.parse(String(init?.body)) as { raw?: string; message?: { raw: string } };
  return Buffer.from(data.raw ?? data.message!.raw, "base64url").toString("utf8");
};

describe("Google review regressions", () => {
  it.each([
    ['"copy@attacker.example" <reply@vendor.example>', "reply@vendor.example"],
    ["o'connor@example.com", "o'connor@example.com"],
    ["Vendor (copy@attacker.example) <reply@vendor.example>", "reply@vendor.example"],
    ['"Vendor, Inc" <reply@vendor.example>, other@example.com', "reply@vendor.example, other@example.com"],
  ])("parses reply mailboxes without extracting display-name addresses: %s", async (header, expected) => {
    let mime = "";
    const connector = adapter(async (_input, init) => {
      if (init?.method === "POST") { mime = mimeBody(init); return json({ id: "sent" }); }
      return json({ threadId: "thread", payload: { headers: [{ name: "Reply-To", value: header }, { name: "Subject", value: "Invoice" }, { name: "Message-ID", value: "<original@vendor.example>" }] } });
    });
    await connector.executeTool("gmail.reply", { messageId: "abc123", body: "Confidential reply" }, context());
    expect(mime.split("\r\n")[0]).toBe(`To: ${expected}`);
  });

  it("refuses unsupported reply mailbox syntax before any send", async () => {
    const writes: string[] = [];
    const connector = adapter(async (_input, init) => {
      if (init?.method === "POST") writes.push(String(init.body));
      return json({ threadId: "thread", payload: { headers: [{ name: "From", value: '"broken <wrong@example.com>' }, { name: "Message-ID", value: "<original@example.com>" }] } });
    });
    await expect(connector.executeTool("gmail.reply", { messageId: "abc123", body: "Private" }, context())).rejects.toMatchObject({ details: { reason: "reply_address_unavailable" } });
    expect(writes).toEqual([]);
  });

  it.each(["gmail.restore_from_trash", "gmail.unmark_spam"])("includes recovery folders explicitly for %s queries", async (name) => {
    const searches: Array<{ folder: string | null; query: string | null }> = [];
    const connector = adapter(async (input) => {
      const url = endpoint(input);
      if (url.pathname.endsWith("/threads")) { searches.push({ folder: url.searchParams.get("includeSpamTrash"), query: url.searchParams.get("q") }); return json({ threads: [{ id: "abc123" }] }); }
      return json({ id: "abc123" });
    });
    await connector.executeTool(name, { query: "subject:Invoice" }, context());
    expect(searches).toEqual([{ folder: "true", query: `${name === "gmail.unmark_spam" ? "in:spam" : "in:trash"} (subject:Invoice)` }]);
    searches.length = 0;
    await connector.executeTool("gmail.archive", { query: "subject:Invoice" }, context());
    expect(searches).toEqual([{ folder: null, query: "subject:Invoice" }]);
  });

  it("keeps the rest of a draft page when one draft disappears", async () => {
    const connector = adapter(async (input) => {
      const url = endpoint(input);
      if (url.pathname.endsWith("/drafts")) return json({ drafts: [{ id: "gone" }, { id: "kept" }], nextPageToken: "next" });
      if (url.pathname.endsWith("/gone")) return json({}, 404);
      return json({ id: "kept", message: { id: "abc", threadId: "def", payload: { headers: [{ name: "Bcc", value: "hidden@example.com" }] } } });
    });
    const result = await connector.executeTool("gmail.list_drafts", {}, context());
    expect(result.output).toMatchObject({ items: [{ id: "gone", unavailable: true }, { id: "kept", bcc: "hidden@example.com" }] });
    expect(result.pagination).toMatchObject({ continuations: [{ input: { pageToken: "next" } }] });
    expect((await connector.executeTool("gmail.read_draft", { draftId: "kept" }, context())).output).toMatchObject({ message: { bcc: "hidden@example.com" } });
  });

  it("propagates a revoked draft permission instead of returning a partial success", async () => {
    const connector = adapter(async (input) => endpoint(input).pathname.endsWith("/drafts") ? json({ drafts: [{ id: "draft" }] }) : json({ error: { code: 401, status: "UNAUTHENTICATED" } }, 401));
    await expect(connector.executeTool("gmail.list_drafts", {}, context())).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("reuses the existing Gmail detail-request concurrency policy for draft pages", async () => {
    let active = 0;
    let maximum = 0;
    const connector = adapter(async (input) => {
      if (endpoint(input).pathname.endsWith("/drafts")) return json({ drafts: Array.from({ length: 11 }, (_, id) => ({ id: String(id) })) });
      maximum = Math.max(maximum, ++active);
      await Promise.resolve();
      active--;
      return json({ message: { id: "message" } });
    });
    const result = await connector.executeTool("gmail.list_drafts", { maxResults: 500 }, context());
    expect(maximum).toBe(5);
    expect(result.output).toHaveProperty("items.length", 11);
  });

  it("does not process an excluded midnight endpoint's DST gap", () => {
    expect(suggestCalendarTimes({ attendeeEmails: [], startTime: "2026-03-07T00:00:00-08:00", endTime: "2026-03-08T00:00:00-08:00", durationMinutes: 60, preferences: { startHour: "02:30", endHour: "03:30" } }, "America/Los_Angeles", [])).toMatchObject({ timeSlots: [{ start: "2026-03-07T10:30:00.000Z", end: "2026-03-07T11:30:00.000Z" }] });
  });

  it("keeps continuous weekday overnight slots without crossing excluded weekends or hours", () => {
    const args = { attendeeEmails: [], startTime: "2026-10-19T23:00:00Z", endTime: "2026-10-20T02:00:00Z", durationMinutes: 120, preferences: { excludeWeekends: true } };
    expect(suggestCalendarTimes(args, "UTC", [])).toMatchObject({ timeSlots: [{ start: "2026-10-19T23:00:00.000Z", end: "2026-10-20T01:00:00.000Z" }] });
    expect(suggestCalendarTimes({ ...args, startTime: "2026-10-23T23:00:00Z", endTime: "2026-10-24T02:00:00Z" }, "UTC", [])).toMatchObject({ timeSlots: [] });
    expect(suggestCalendarTimes({ ...args, preferences: { startHour: "09:00", endHour: "17:00" } }, "UTC", [])).toMatchObject({ timeSlots: [] });
  });

  it("resolves a missing midnight to the first instant of the requested date", () => {
    expect(calendarDayBoundary("2026-09-06", "America/Santiago")).toBe("2026-09-06T04:00:00.000Z");
    expect(googleRecurrenceRule({ frequency: "daily", until: "2026-09-05" }, false, "America/Santiago")).toBe("RRULE:FREQ=DAILY;UNTIL=20260906T035959Z");
  });

  it("attaches existing Meet URLs as links and preserves current event notes", async () => {
    const writes: unknown[] = [];
    const connector = adapter(async (_input, init) => {
      if (init?.method === "POST" || init?.method === "PATCH") { writes.push(JSON.parse(String(init.body))); return json({ id: "event" }); }
      return json({ description: "Existing agenda" });
    });
    await connector.executeTool("calendar.create_event", { summary: "Review", start: "2026-10-21T09:00:00Z", end: "2026-10-21T10:00:00Z", description: "New agenda", googleMeetUrl: "https://meet.google.com/abc-defg-hij" }, context());
    await connector.executeTool("calendar.update_event", { eventId: "event", googleMeetUrl: "https://meet.google.com/abc-defg-hij" }, context());
    expect(writes).toEqual([{ summary: "Review", description: "New agenda\n\nhttps://meet.google.com/abc-defg-hij", start: { dateTime: "2026-10-21T09:00:00Z" }, end: { dateTime: "2026-10-21T10:00:00Z" }, attendees: [] }, { description: "Existing agenda\n\nhttps://meet.google.com/abc-defg-hij" }]);
  });

  it("merges availability returned by multiple published-limit chunks", async () => {
    const chunks: number[] = [];
    const connector = adapter(async (_input, init) => {
      if (!init?.body) return json({ id: "me@example.com", timeZone: "UTC" });
      const data = JSON.parse(String(init.body)) as { items: Array<{ id: string }> };
      chunks.push(data.items.length);
      return json({ calendars: Object.fromEntries(data.items.map(({ id }) => [id, { busy: id === "guest50@example.com" ? [{ start: "2026-10-21T09:00:00Z", end: "2026-10-21T10:00:00Z" }] : [] }])) });
    });
    const result = await connector.executeTool("calendar.suggest_time", { attendeeEmails: Array.from({ length: 51 }, (_, id) => `guest${id}@example.com`), startTime: "2026-10-21T09:00:00Z", endTime: "2026-10-21T12:00:00Z", durationMinutes: 60 }, context());
    expect(chunks).toEqual([50, 2]);
    expect(result.output).toMatchObject({ timeSlots: [{ start: "2026-10-21T10:00:00.000Z" }] });
  });

  it.each(["gmail.create_draft", "gmail.create_reply_draft"])("attaches authorized resources with HTML in %s", async (name) => {
    let mime = "";
    const connector = adapter(async (_input, init) => {
      if (init?.method === "POST") { mime = mimeBody(init); return json({ id: "draft" }); }
      return json({ threadId: "thread", payload: { headers: [{ name: "From", value: "sender@example.com" }, { name: "Subject", value: "Review" }, { name: "Message-ID", value: "<original@example.com>" }] } });
    });
    const readAttachment = vi.fn(async () => ({ fileName: "résumé.pdf", mimeType: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.7\noriginal") }));
    await connector.executeTool(name, { ...(name === "gmail.create_draft" ? { to: ["recipient@example.com"], subject: "Review" } : { messageId: "abc123" }), body: "Attached", htmlBody: "<b>Attached</b>", attachmentResourceIds: [resourceId, resourceId] }, { ...context(), readAttachment });
    expect(readAttachment).toHaveBeenCalledExactlyOnceWith(resourceId);
    expect(mime).toContain("multipart/alternative");
    expect(mime).toContain("multipart/mixed");
    expect(mime).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
    expect(mime).toContain("JVBERi0xLjcKb3JpZ2luYWw=");
  });
});
