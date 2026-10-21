import { describe, expect, it } from "vitest";
import { asUserId } from "@rally/contracts";
import { createGoogleConnector, authorizedConnection } from "./index";
import { neverAborts } from "./test-signals";

const userId = asUserId("00000000-0000-4000-8000-000000000041");
const context = () => ({ principal: { type: "user" as const, userId }, signal: neverAborts(), connection: authorizedConnection({ id: "00000000-0000-4000-8000-000000000042", workspaceId: "00000000-0000-4000-8000-000000000043", scope: "personal", ownerUserId: userId, grantedScopes: ["calendar.read", "calendar.write", "gmail.read", "gmail.modify", "gmail.send"], credentials: { accessToken: "test-only" }, cursor: {}, config: {} }) });
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
const connector = (fetcher: typeof fetch) => createGoogleConnector({ clientId: "test", clientSecret: "test", redirectUri: "https://example.test/oauth", fetch: fetcher });
const urlOf = (input: RequestInfo | URL) => new URL(input instanceof Request ? input.url : input.toString());

describe("Google action target resolution", () => {
  it("cancels the named meeting with no model-supplied event or calendar IDs", async () => {
    const requests: Array<{ path: string; method: string; from: string | null; until: string | null }> = [];
    const adapter = connector(async (input, init) => {
      const url = urlOf(input);
      requests.push({ path: url.pathname, method: init?.method ?? "GET", from: url.searchParams.get("timeMin"), until: url.searchParams.get("timeMax") });
      if (url.pathname.endsWith("/primary")) return json({ timeZone: "America/Los_Angeles" });
      if (url.pathname.endsWith("/events")) return json({ items: [{ id: "opaque-occurrence", summary: "Standup", start: { dateTime: "2026-11-02T09:00:00-08:00" } }] });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return json({ id: "opaque-occurrence", organizer: { self: true } });
    });
    expect((await adapter.executeTool("calendar.cancel_event", { date: "2026-11-02", title: "Standup", startTime: "09:00" }, context())).output).toMatchObject({ id: "opaque-occurrence", status: "cancelled" });
    expect(requests[1]).toEqual({ path: "/calendar/v3/calendars/primary/events", method: "GET", from: "2026-11-02T08:00:00.000Z", until: "2026-11-03T08:00:00.000Z" });
    expect(requests.at(-1)?.path).toBe("/calendar/v3/calendars/primary/events/opaque-occurrence");
    expect(requests.at(-1)?.method).toBe("DELETE");
  });

  it("refuses ambiguous calendar matches before any write", async () => {
    const methods: string[] = [];
    const adapter = connector(async (input, init) => {
      methods.push(init?.method ?? "GET");
      return urlOf(input).pathname.endsWith("/primary") ? json({ timeZone: "UTC" }) : json({ items: [{ id: "one", summary: "Standup", start: { dateTime: "2026-10-21T09:00:00Z" } }, { id: "two", summary: "Standup", start: { dateTime: "2026-10-21T09:00:00Z" } }] });
    });
    await expect(adapter.executeTool("calendar.cancel_event", { date: "2026-10-21", title: "Standup" }, context())).rejects.toMatchObject({ details: { field: "date", reason: "ambiguous_event_selection" } });
    expect(methods).toEqual(["GET", "GET"]);
  });

  it("refuses ambiguous mail queries before any mailbox write", async () => {
    const methods: string[] = [];
    const adapter = connector(async (_input, init) => { methods.push(init?.method ?? "GET"); return json({ threads: [{ id: "one" }, { id: "two" }] }); });
    await expect(adapter.executeTool("gmail.trash", { query: "subject:Invoice" }, context())).rejects.toMatchObject({ details: { field: "query", reason: "ambiguous_mail_selection" } });
    expect(methods).toEqual(["GET"]);
  });

  it("resolves reply recipient and threading from a query in one action", async () => {
    let sent: { raw: string; threadId: string } | undefined;
    const adapter = connector(async (input, init) => {
      const url = urlOf(input);
      if (url.pathname.endsWith("/messages")) return json({ messages: [{ id: "opaque-message" }] });
      if (url.pathname.endsWith("/opaque-message")) return json({ threadId: "opaque-thread", payload: { headers: [{ name: "Subject", value: "Design review" }, { name: "Message-ID", value: "<original@example.com>" }, { name: "From", value: "Sender <sender@example.com>" }, { name: "Reply-To", value: "Replies <replies@example.com>" }] } });
      sent = JSON.parse(String(init?.body)) as typeof sent;
      return json({ id: "sent", threadId: "opaque-thread" });
    });
    await adapter.executeTool("gmail.reply", { query: "from:sender@example.com subject:Design-review after:2026/10/20", body: "Agreed." }, context());
    expect(sent?.threadId).toBe("opaque-thread");
    expect(Buffer.from(sent!.raw, "base64url").toString("utf8")).toBe(["To: replies@example.com", "Subject: Design review", "In-Reply-To: <original@example.com>", "References: <original@example.com>", "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: 8bit", "", "Agreed."].join("\r\n"));
  });

  it("searches Trash internally when restoring a named email", async () => {
    const queries: Array<string | null> = [];
    const adapter = connector(async (input) => { const url = urlOf(input); queries.push(url.searchParams.get("q")); return url.pathname.endsWith("/threads") ? json({ threads: [{ id: "trashed" }] }) : json({ id: "trashed", threadId: "thread" }); });
    await adapter.executeTool("gmail.restore_from_trash", { query: "subject:Invoice" }, context());
    expect(queries).toEqual(["in:trash (subject:Invoice)", null]);
  });

  it("uses an exact event ID without calendar or event searches and conditions the cancellation", async () => {
    const requests: Array<{ path: string; method: string; etag: string | null }> = [];
    const adapter = connector(async (input, init) => {
      requests.push({ path: urlOf(input).pathname, method: init?.method ?? "GET", etag: new Headers(init?.headers).get("If-Match") });
      return init?.method === "DELETE" ? new Response(null, { status: 204 }) : json({ id: "known-occurrence", organizer: { self: true }, etag: '"revision-7"' });
    });
    await adapter.executeTool("calendar.cancel_event", { calendarId: "primary", eventId: "known-occurrence" }, context());
    expect(requests).toEqual([
      { path: "/calendar/v3/calendars/primary/events/known-occurrence", method: "GET", etag: null },
      { path: "/calendar/v3/calendars/primary/events/known-occurrence", method: "DELETE", etag: '"revision-7"' },
    ]);
  });

  it("reports a concurrent calendar edit without retrying the mutation", async () => {
    let writes = 0;
    const adapter = connector(async (_input, init) => {
      if (init?.method === "DELETE") { writes++; return new Response(null, { status: 412 }); }
      return json({ id: "known-occurrence", organizer: { self: true }, etag: '"revision-7"' });
    });
    await expect(adapter.executeTool("calendar.cancel_event", { eventId: "known-occurrence" }, context())).rejects.toMatchObject({ details: { field: "eventId", reason: "event_changed" } });
    expect(writes).toBe(1);
  });

  it.each([
    ["gmail.archive", [], ["INBOX"]],
    ["gmail.mark_read", [], ["UNREAD"]],
    ["gmail.star", ["STARRED"], []],
    ["gmail.mark_spam", ["SPAM"], ["INBOX"]],
  ])("applies %s directly to an exact thread ID", async (name, addLabelIds, removeLabelIds) => {
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    const adapter = connector(async (input, init) => {
      requests.push({ path: urlOf(input).pathname, method: init?.method ?? "GET", body: JSON.parse(String(init?.body)) });
      return json({ id: "known-thread" });
    });
    await adapter.executeTool(String(name), { threadId: "known-thread" }, context());
    expect(requests).toEqual([{ path: "/gmail/v1/users/me/threads/known-thread/modify", method: "POST", body: { addLabelIds, removeLabelIds } }]);
  });

  it("does not treat a one-row partial query page as a unique match", async () => {
    let calls = 0;
    const adapter = connector(async () => { calls++; return json({ threads: [{ id: "first" }], nextPageToken: "more" }); });
    await expect(adapter.executeTool("gmail.archive", { query: "subject:Invoice" }, context())).rejects.toMatchObject({ details: { field: "query", reason: "ambiguous_mail_selection" } });
    expect(calls).toBe(1);
  });


  it("replies to an exact sent message's original recipient without searching or replying to self", async () => {
    const paths: string[] = [];
    let mime = "";
    const adapter = connector(async (input, init) => {
      paths.push(urlOf(input).pathname);
      if (init?.method === "POST") {
        mime = Buffer.from((JSON.parse(String(init.body)) as { raw: string }).raw, "base64url").toString("utf8");
        return json({ id: "sent-reply", threadId: "known-thread" });
      }
      return json({ threadId: "known-thread", labelIds: ["SENT"], payload: { headers: [{ name: "To", value: "Recipient <recipient@example.com>" }, { name: "From", value: "me@example.com" }, { name: "Subject", value: "Follow up" }, { name: "Message-ID", value: "<sent@example.com>" }] } });
    });
    await adapter.executeTool("gmail.reply", { messageId: "known-sent-message", body: "Following up." }, context());
    expect(paths).toEqual(["/gmail/v1/users/me/messages/known-sent-message", "/gmail/v1/users/me/messages/send"]);
    expect(mime).toContain("To: recipient@example.com\r\n");
    expect(mime).toContain("In-Reply-To: <sent@example.com>\r\n");
  });

});
