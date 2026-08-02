import { describe, expect, it } from "vitest";
import { NormalizedActivitySchema } from "@avalon/contracts";
import {
  __testing,
  assertPrincipalAccess,
  createGoogleConnector,
  CredentialCipher,
  pollWebMonitor,
  verifyGenericWebhook,
  type ConnectorConnectionContext
} from "./index";

describe("connectors", () => {
  it("does not let another user borrow a personal connection", () => {
    expect(() =>
      assertPrincipalAccess(
        {
          id: "connection",
          workspaceId: "workspace",
          scope: "personal",
          ownerUserId: "alice",
          grantedScopes: [],
          credentials: {},
          cursor: {},
          config: {}
        },
        { type: "user", userId: "bob" }
      )
    ).toThrow(/personal connection/i);
  });

  it("verifies signed webhooks and timestamps", async () => {
    const secret = "test-secret";
    const body = JSON.stringify({ type: "transcript.completed" });
    const timestamp = 1_700_000_000;
    const signature = await __testing.hmacHex(secret, `${timestamp}.${body}`);
    await expect(
      verifyGenericWebhook({
        secret,
        signatureHeader: `t=${timestamp},v1=${signature}`,
        body,
        now: timestamp
      })
    ).resolves.toMatchObject({ timestamp, event: { type: "transcript.completed" } });
  });

  it("encrypts credentials with authenticated context", async () => {
    const cipher = new CredentialCipher(new Uint8Array(32).fill(7), 3);
    const encrypted = await cipher.encrypt({ refreshToken: "private" }, "connection-1");
    await expect(cipher.decrypt(encrypted.ciphertext, encrypted.iv, "connection-1")).resolves.toEqual({
      refreshToken: "private"
    });
    await expect(cipher.decrypt(encrypted.ciphertext, encrypted.iv, "connection-2")).rejects.toThrow();
  });

  it("detects deterministic web changes", async () => {
    const fetcher = async () =>
      new Response("<main><h1>Release</h1><p>Avalon is ready.</p></main>", {
        headers: { "content-type": "text/html", etag: '"v2"' }
      });
    const result = await pollWebMonitor({
      url: "https://example.com/release",
      previous: { contentHash: "old" },
      phrase: "Avalon",
      fetch: fetcher
    });
    expect(result.changed).toBe(true);
    expect(result.snapshot?.phraseMatched).toBe(true);
    expect(result.snapshot?.readableText).toContain("Avalon is ready");
  });

  it("rejects private redirect targets before following them", async () => {
    const requested: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      requested.push(input.toString());
      return new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" }
      });
    };
    await expect(
      pollWebMonitor({ url: "https://example.com/redirect", previous: {}, fetch: fetcher })
    ).rejects.toThrow(/private and local network/i);
    expect(requested).toHaveLength(1);
  });

  it.each([
    "http://[::1]/secret",
    "http://[fd00::1]/secret",
    "http://metadata.google.internal/computeMetadata/v1"
  ])("rejects non-public monitor URL %s", async (url) => {
    await expect(pollWebMonitor({ url, previous: {} })).rejects.toThrow(/not allowed/i);
  });

  it("baselines Gmail without flooding old mail, then advances history with normalized metadata", async () => {
    const requested: URL[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      requested.push(url);
      if (url.pathname.endsWith("/profile")) return googleJson({ historyId: "100" });
      if (url.pathname.endsWith("/history")) {
        return googleJson({
          history: [
            {
              id: "104",
              messagesAdded: [{ message: { id: "message-1", threadId: "thread-1" } }]
            }
          ],
          historyId: "105"
        });
      }
      if (url.pathname.endsWith("/messages/message-1")) {
        return googleJson({
          id: "message-1",
          threadId: "thread-1",
          historyId: "104",
          internalDate: "1722513600000",
          labelIds: ["INBOX", "UNREAD"],
          snippet: "A short, privacy-scoped preview",
          payload: {
            headers: [
              { name: "From", value: "Samantha <samantha@example.com>" },
              { name: "Subject", value: "Quarterly planning" }
            ]
          }
        });
      }
      throw new Error(`Unexpected Google URL: ${url}`);
    };
    const adapter = googleAdapter(fetcher);
    const baseline = await adapter.poll!(googleConnection(["gmail.read"]), AbortSignal.timeout(1_000));
    expect(baseline.activities).toEqual([]);
    expect(baseline.cursor).toMatchObject({ gmail: { historyId: "100" } });

    const incremental = await adapter.poll!(
      googleConnection(["gmail.read"], baseline.cursor),
      AbortSignal.timeout(1_000)
    );
    expect(incremental.cursor).toMatchObject({ gmail: { historyId: "105", pendingChanges: [] } });
    expect(incremental.activities).toHaveLength(1);
    expect(incremental.activities[0]).toMatchObject({
      eventType: "email.received",
      resourceType: "gmail_thread",
      providerResourceId: "thread-1",
      title: "New email: Quarterly planning",
      visibility: { scope: "personal", ownerUserId: TEST_USER_ID },
      targetUserIds: [TEST_USER_ID]
    });
    expect(incremental.activities[0]?.metadata).not.toHaveProperty("body");
    expectNormalized(incremental.activities);
    expect(requested.find((url) => url.pathname.endsWith("/history"))?.searchParams.get("startHistoryId")).toBe("100");
  });

  it("baselines all newly granted Google capabilities atomically without emitting historical activity", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/profile")) return googleJson({ historyId: "gmail-now" });
      if (url.pathname.endsWith("/changes/startPageToken")) return googleJson({ startPageToken: "drive-now" });
      if (url.pathname.endsWith("/calendars/primary/events")) {
        return googleJson({
          items: [calendarEvent("historical-event", "Old event", "old-etag")],
          nextSyncToken: "calendar-now"
        });
      }
      throw new Error(`Unexpected Google baseline URL: ${url}`);
    };
    const adapter = googleAdapter(fetcher);
    const result = await adapter.poll!(
      googleConnection(["gmail.read", "calendar.read", "drive.read"]),
      AbortSignal.timeout(1_000)
    );
    expect(result.activities).toEqual([]);
    expect(result.cursor).toMatchObject({
      gmail: { historyId: "gmail-now" },
      calendar: { syncToken: "calendar-now" },
      drive: { pageToken: "drive-now" }
    });
  });

  it("reconciles current Gmail messages before replacing an expired history cursor", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/history")) {
        return googleJson({ error: { code: 404, message: "History ID not found" } }, 404);
      }
      if (url.pathname.endsWith("/profile")) return googleJson({ historyId: "gmail-rebased" });
      if (url.pathname.endsWith("/messages")) {
        return googleJson({ messages: [{ id: "message-current", threadId: "thread-current" }] });
      }
      if (url.pathname.endsWith("/messages/message-current")) {
        return googleJson({
          id: "message-current",
          threadId: "thread-current",
          historyId: "message-history-current",
          internalDate: "1722513600000",
          labelIds: ["INBOX"],
          snippet: "Reconciled message",
          payload: { headers: [{ name: "Subject", value: "Still present" }] }
        });
      }
      throw new Error(`Unexpected Gmail reconciliation URL: ${url}`);
    };
    const adapter = googleAdapter(fetcher);
    const result = await adapter.poll!(
      googleConnection(["gmail.read"], { gmail: { historyId: "gmail-expired", pendingChanges: [] } }),
      AbortSignal.timeout(1_000)
    );
    expect(result.activities).toHaveLength(1);
    expect(result.activities[0]).toMatchObject({
      eventType: "email.updated",
      providerResourceId: "thread-current",
      metadata: { reconciledAfterHistoryGap: true }
    });
    expect(result.cursor).toMatchObject({ gmail: { historyId: "gmail-rebased", pendingChanges: [] } });
  });

  it("paginates Calendar changes with one sync token and commits the final token", async () => {
    const requested: URL[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      requested.push(url);
      if (url.searchParams.get("pageToken") === "calendar-page-2") {
        return googleJson({
          items: [calendarEvent("event-2", "Roadmap review", "etag-2")],
          nextSyncToken: "calendar-sync-new"
        });
      }
      return googleJson({
        items: [calendarEvent("event-1", "Design critique", "etag-1")],
        nextPageToken: "calendar-page-2"
      });
    };
    const adapter = googleAdapter(fetcher);
    const result = await adapter.poll!(
      googleConnection(["calendar.read"], { calendar: { syncToken: "calendar-sync-old" } }),
      AbortSignal.timeout(1_000)
    );
    expect(result.cursor).toMatchObject({ calendar: { syncToken: "calendar-sync-new" } });
    expect(result.activities.map((activity) => activity.providerResourceId)).toEqual(["event-1", "event-2"]);
    expect(result.activities.every((activity) => activity.eventType === "calendar.event_changed")).toBe(true);
    expect(requested).toHaveLength(2);
    expect(requested[0]?.searchParams.get("syncToken")).toBe("calendar-sync-old");
    expect(requested[1]?.searchParams.get("syncToken")).toBe("calendar-sync-old");
    expect(requested[1]?.searchParams.get("pageToken")).toBe("calendar-page-2");
    expectNormalized(result.activities);
  });

  it("resets an expired Calendar token through a silent bounded baseline", async () => {
    let calls = 0;
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      calls += 1;
      if (url.searchParams.has("syncToken")) {
        return googleJson({ error: { code: 410, message: "Sync token expired" } }, 410);
      }
      return googleJson({
        items: [calendarEvent("old-event", "Existing event", "old-etag")],
        nextSyncToken: "calendar-baseline-new"
      });
    };
    const adapter = googleAdapter(fetcher);
    const result = await adapter.poll!(
      googleConnection(["calendar.read"], { calendar: { syncToken: "expired" } }),
      AbortSignal.timeout(1_000)
    );
    expect(calls).toBe(2);
    expect(result.activities).toEqual([]);
    expect(result.cursor).toMatchObject({ calendar: { syncToken: "calendar-baseline-new" } });
  });

  it("emits a deduplicated Calendar completion when an event end crosses the poll window", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.searchParams.has("syncToken")) {
        return googleJson({ items: [], nextSyncToken: "calendar-sync-new" });
      }
      return googleJson({
        items: [
          {
            id: "event-complete",
            status: "confirmed",
            summary: "Customer interview",
            organizer: { displayName: "Samantha", email: "samantha@example.com" },
            start: { dateTime: "2026-08-01T04:00:00.000Z" },
            end: { dateTime: "2026-08-01T04:30:00.000Z" }
          }
        ]
      });
    };
    const adapter = googleAdapter(fetcher);
    const result = await adapter.poll!(
      googleConnection(["calendar.read"], {
        calendar: {
          syncToken: "calendar-sync-old",
          completionCheckedAt: "2026-08-01T04:00:00.000Z"
        }
      }),
      AbortSignal.timeout(1_000)
    );
    expect(result.activities).toHaveLength(1);
    expect(result.activities[0]).toMatchObject({
      eventType: "calendar.event_completed",
      providerResourceId: "event-complete",
      occurredAt: "2026-08-01T04:30:00.000Z",
      title: "Calendar event completed: Customer interview"
    });
    expect(result.activities[0]?.dedupeKey).toContain("completed:2026-08-01T04:30:00.000Z");
    expect(result.cursor).toMatchObject({ calendar: { syncToken: "calendar-sync-new" } });
    expectNormalized(result.activities);
  });

  it("baselines Drive at the current change token and paginates future changes", async () => {
    const requested: URL[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      requested.push(url);
      if (url.pathname.endsWith("/changes/startPageToken")) return googleJson({ startPageToken: "10" });
      if (url.searchParams.get("pageToken") === "10") {
        return googleJson({
          changes: [
            {
              fileId: "file-1",
              time: "2026-07-31T12:00:00Z",
              file: {
                id: "file-1",
                name: "Launch brief",
                mimeType: "application/vnd.google-apps.document",
                modifiedTime: "2026-07-31T12:00:00Z",
                lastModifyingUser: { displayName: "Samantha", emailAddress: "samantha@example.com" }
              }
            }
          ],
          nextPageToken: "11"
        });
      }
      if (url.searchParams.get("pageToken") === "11") {
        return googleJson({
          changes: [{ fileId: "file-2", removed: true, time: "2026-07-31T12:01:00Z" }],
          newStartPageToken: "20"
        });
      }
      throw new Error(`Unexpected Google URL: ${url}`);
    };
    const adapter = googleAdapter(fetcher);
    const baseline = await adapter.poll!(googleConnection(["drive.read"]), AbortSignal.timeout(1_000));
    expect(baseline.activities).toEqual([]);
    expect(baseline.cursor).toMatchObject({ drive: { pageToken: "10" } });

    const incremental = await adapter.poll!(
      googleConnection(["drive.read"], baseline.cursor),
      AbortSignal.timeout(1_000)
    );
    expect(incremental.cursor).toMatchObject({ drive: { pageToken: "20" } });
    expect(incremental.activities).toHaveLength(2);
    expect(incremental.activities[0]).toMatchObject({
      eventType: "docs.document_changed",
      resourceType: "google_doc",
      providerResourceId: "file-1",
      metadata: { mimeType: "application/vnd.google-apps.document" }
    });
    expect(incremental.activities[1]).toMatchObject({
      eventType: "drive.file_changed",
      providerResourceId: "file-2",
      title: "Drive file removed: Drive file file-2"
    });
    expectNormalized(incremental.activities);
    expect(requested.filter((url) => url.pathname.endsWith("/changes"))).toHaveLength(2);
  });

  it("hydrates Google resources into bounded, provider-specific context", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/threads/thread-1")) {
        return googleJson({
          id: "thread-1",
          historyId: "90",
          messages: Array.from({ length: 51 }, (_, index) => ({
            id: `message-${index}`,
            threadId: "thread-1",
            snippet: `Message ${index}`,
            payload: { headers: [{ name: "Subject", value: `Subject ${index}` }] }
          }))
        });
      }
      if (url.pathname.endsWith("/events/event-1")) {
        return googleJson({
          id: "event-1",
          summary: "Design critique",
          description: "Review the new interaction model",
          start: { dateTime: "2026-08-01T10:00:00-07:00" },
          end: { dateTime: "2026-08-01T11:00:00-07:00" },
          attendees: [{ displayName: "Samantha", email: "samantha@example.com", responseStatus: "accepted" }]
        });
      }
      if (url.pathname.endsWith("/files/file-1") && url.searchParams.get("alt") === "media") {
        return new Response("Avalon text", { headers: { "content-type": "text/plain" } });
      }
      if (url.pathname.endsWith("/files/file-1")) {
        return googleJson({
          id: "file-1",
          name: "notes.txt",
          mimeType: "text/plain",
          size: "11",
          modifiedTime: "2026-07-31T12:00:00Z"
        });
      }
      throw new Error(`Unexpected Google URL: ${url}`);
    };
    const adapter = googleAdapter(fetcher);
    const connection = googleConnection(["gmail.read", "calendar.read", "drive.read"]);
    const signal = AbortSignal.timeout(1_000);
    const gmail = await adapter.hydrateResource!(
      connection,
      { resource_type: "gmail_thread", provider_resource_id: "thread-1" },
      signal
    );
    const calendar = await adapter.hydrateResource!(
      connection,
      { resource_type: "calendar_event", provider_resource_id: "event-1" },
      signal
    );
    const drive = await adapter.hydrateResource!(
      connection,
      { resource_type: "drive_file", provider_resource_id: "file-1" },
      signal
    );

    expect(gmail).toMatchObject({ resourceType: "gmail_thread", messagesTruncated: true, totalMessages: 51 });
    expect((gmail as { messages: unknown[] }).messages).toHaveLength(50);
    expect(calendar).toMatchObject({
      resourceType: "calendar_event",
      id: "event-1",
      attendees: [{ displayName: "Samantha", responseStatus: "accepted" }]
    });
    expect(drive).toMatchObject({
      resourceType: "drive_file",
      id: "file-1",
      textContent: "Avalon text",
      contentTruncated: false
    });
  });

  it("exposes bounded scoped read tools without raw Gmail parts or PDF base64", async () => {
    const requested: URL[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      requested.push(url);
      if (url.pathname.endsWith("/messages/message-1")) {
        return googleJson({
          id: "message-1",
          threadId: "thread-1",
          labelIds: ["INBOX"],
          snippet: "Preview",
          payload: {
            mimeType: "multipart/mixed",
            headers: [
              { name: "From", value: "Samantha <samantha@example.com>" },
              { name: "To", value: "Adam <adam@example.com>" },
              { name: "Subject", value: "Bounded message" }
            ],
            parts: [
              {
                mimeType: "text/plain",
                body: { data: base64UrlText("Useful message body") }
              },
              {
                mimeType: "application/pdf",
                filename: "private.pdf",
                body: { attachmentId: "attachment-1", size: 2_000_000 }
              }
            ]
          }
        });
      }
      throw new Error(`Unexpected Google fetch: ${url}`);
    };
    const adapter = googleAdapter(fetcher);
    expect(adapter.manifest.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "google.gmail.read_message",
      "google.calendar.read_event",
      "google.drive.get_metadata",
      "google.drive.download"
    ]));
    const connection = googleConnection(["gmail.read", "drive.read"]);
    const context = {
      connection,
      principal: { type: "user" as const, userId: TEST_USER_ID },
      signal: AbortSignal.timeout(1_000)
    };
    const message = await adapter.executeTool("google.gmail.read_message", { messageId: "message-1" }, context);
    expect(message.output).toMatchObject({
      id: "message-1",
      textContent: "Useful message body",
      attachments: [{ filename: "private.pdf", contentIncluded: false }]
    });
    expect(JSON.stringify(message.output)).not.toContain("body\":{");

    const callsBeforePdf = requested.length;
    const pdf = await adapter.executeTool(
      "google.drive.export",
      { fileId: "file-1", mimeType: "application/pdf" },
      context
    );
    expect(pdf.output).toMatchObject({ contentIncluded: false, mimeType: "application/pdf" });
    expect(pdf.output).not.toHaveProperty("base64");
    expect(requested).toHaveLength(callsBeforePdf);
  });

  it("creates and updates Google Calendar events with bounded event fields", async () => {
    const requests: Array<{ url: URL; method: string; body: Record<string, unknown> }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = requestUrl(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      requests.push({ url, method: init?.method ?? "GET", body });
      if (url.pathname.endsWith("/users/me/calendarList")) {
        return googleJson({
          items: [
            { id: "primary", summary: "Personal", primary: true, selected: true, accessRole: "owner" },
            { id: "team@example.com", summary: "Team", selected: true, accessRole: "writer" }
          ]
        });
      }
      const eventId = init?.method === "PATCH" ? "event-existing" : "event-created";
      return googleJson({
        id: eventId,
        summary: body.summary,
        description: body.description,
        location: body.location,
        status: "confirmed",
        htmlLink: `https://calendar.google.com/event?eid=${eventId}`,
        start: body.start,
        end: body.end,
        attendees: body.attendees
      });
    };
    const adapter = googleAdapter(fetcher);
    const context = {
      connection: googleConnection(["calendar.write"]),
      principal: { type: "user" as const, userId: TEST_USER_ID },
      signal: AbortSignal.timeout(1_000)
    };

    const calendars = await adapter.executeTool("google.calendar.list_calendars", {}, {
      ...context,
      connection: googleConnection(["calendar.read"])
    });
    expect(calendars.output).toMatchObject({
      calendars: [{ id: "primary", primary: true }, { id: "team@example.com", accessRole: "writer" }]
    });

    const created = await adapter.executeTool("google.calendar.create_event", {
      calendarId: "team@example.com",
      summary: "Design review",
      start: "2026-08-03T10:00:00-07:00",
      end: "2026-08-03T11:00:00-07:00",
      timeZone: "America/Los_Angeles",
      attendeeEmails: ["reviewer@example.com"]
    }, context);
    expect(created).toMatchObject({
      providerOperationId: "event-created",
      output: { id: "event-created", summary: "Design review" }
    });
    const createRequest = requests.find((request) => request.method === "POST");
    expect(createRequest?.url.pathname).toContain("/calendars/team%40example.com/events");
    expect(createRequest?.url.searchParams.get("sendUpdates")).toBe("all");
    expect(createRequest?.body).toMatchObject({
      start: { dateTime: "2026-08-03T10:00:00-07:00", timeZone: "America/Los_Angeles" },
      attendees: [{ email: "reviewer@example.com" }]
    });

    const updated = await adapter.executeTool("google.calendar.update_event", {
      eventId: "event-existing",
      summary: "Updated design review",
      location: "Meet"
    }, context);
    expect(updated.providerOperationId).toBe("event-existing");
    expect(requests.find((request) => request.method === "PATCH")).toMatchObject({
      method: "PATCH",
      body: { summary: "Updated design review", location: "Meet" }
    });
  });

  it("requires RFC reply headers when creating a Gmail draft in an existing thread", async () => {
    let requestBody: Record<string, unknown> | null = null;
    const fetcher: typeof fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return googleJson({ id: "draft-1", message: { id: "message-draft", threadId: "thread-1" } });
    };
    const adapter = googleAdapter(fetcher);
    const context = {
      connection: googleConnection(["gmail.draft"]),
      principal: { type: "user" as const, userId: TEST_USER_ID },
      signal: AbortSignal.timeout(1_000)
    };
    await expect(adapter.executeTool("google.gmail.create_draft", {
      to: ["recipient@example.com"],
      subject: "Re: Design review",
      body: "Looks good.",
      threadId: "thread-1"
    }, context)).rejects.toThrow(/RFC Message-ID/u);

    const result = await adapter.executeTool("google.gmail.create_draft", {
      to: ["recipient@example.com"],
      subject: "Re: Design review",
      body: "Looks good.",
      threadId: "thread-1",
      inReplyTo: "<original@example.com>",
      references: ["<earlier@example.com>"]
    }, context);
    expect(result.providerOperationId).toBe("draft-1");
    expect(requestBody).not.toBeNull();
    const message = ((requestBody as unknown as Record<string, unknown>).message ?? {}) as Record<string, unknown>;
    const raw = String(message.raw ?? "");
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(raw.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(raw.length / 4) * 4, "=")), (character) => character.charCodeAt(0))
    );
    expect(decoded).toContain("In-Reply-To: <original@example.com>\r\n");
    expect(decoded).toContain("References: <earlier@example.com> <original@example.com>\r\n");
  });

  it("uses native bounded Google Docs and Sheets read/write APIs", async () => {
    const requests: Array<{ url: URL; method: string; body: Record<string, unknown> }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = requestUrl(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      requests.push({ url, method, body });
      if (url.hostname === "docs.googleapis.com") {
        if (url.pathname === "/v1/documents" && method === "POST") {
          return googleJson({ documentId: "doc-created", title: body.title });
        }
        if (url.pathname.endsWith(":batchUpdate")) {
          return googleJson({ replies: [{ replaceAllText: { occurrencesChanged: 2 } }] });
        }
        return googleJson({
          documentId: "doc-1",
          title: "Launch brief",
          revisionId: "revision-7",
          body: {
            content: [{ paragraph: { elements: [{ textRun: { content: "Launch plan\n" } }] } }]
          },
          tabs: [{ tabProperties: { tabId: "tab-1", title: "Overview", index: 0 } }]
        });
      }
      if (url.hostname === "sheets.googleapis.com") {
        if (url.pathname === "/v4/spreadsheets" && method === "POST") {
          return googleJson({
            spreadsheetId: "sheet-created",
            spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-created/edit",
            properties: { title: "Metrics" },
            sheets: [{ properties: { sheetId: 0, title: "Weekly", index: 0 } }]
          });
        }
        if (url.pathname.includes("/values/") && method === "GET") {
          return googleJson({ range: "Summary!A1:B2", majorDimension: "ROWS", values: [["Metric", "Value"], ["Users", 42]] });
        }
        if (url.pathname.endsWith(":update")) {
          return googleJson({ spreadsheetId: "sheet-1", updatedRange: "Summary!A1:B2", updatedRows: 2, updatedCells: 4 });
        }
        if (url.pathname.endsWith(":append")) {
          return googleJson({ spreadsheetId: "sheet-1", tableRange: "Summary!A1:B2", updates: { updatedRange: "Summary!A3:B3", updatedRows: 1, updatedCells: 2 } });
        }
        return googleJson({
          spreadsheetId: "sheet-1",
          spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
          properties: { title: "Metrics", locale: "en_US", timeZone: "America/Los_Angeles" },
          sheets: [{ properties: { sheetId: 10, title: "Summary", index: 0, gridProperties: { rowCount: 100, columnCount: 10 } } }]
        });
      }
      throw new Error(`Unexpected Google Workspace fetch: ${url}`);
    };
    const adapter = googleAdapter(fetcher);
    const context = {
      connection: googleConnection(["docs.read", "docs.write", "sheets.read", "sheets.write"]),
      principal: { type: "user" as const, userId: TEST_USER_ID },
      signal: AbortSignal.timeout(1_000)
    };

    const document = await adapter.executeTool("google.docs.read_document", { documentId: "doc-1" }, context);
    expect(document.output).toMatchObject({
      resourceType: "google_doc",
      documentId: "doc-1",
      title: "Launch brief",
      textContent: "Launch plan\n",
      tabs: [{ tabId: "tab-1", title: "Overview" }]
    });
    const createdDocument = await adapter.executeTool("google.docs.create_document", {
      title: "Decision log",
      text: "First decision\n"
    }, context);
    expect(createdDocument.providerOperationId).toBe("doc-created");
    const replaced = await adapter.executeTool("google.docs.replace_text", {
      documentId: "doc-1",
      find: "draft",
      replace: "final"
    }, context);
    expect(replaced.output).toMatchObject({ documentId: "doc-1", occurrencesChanged: 2 });

    const spreadsheet = await adapter.executeTool("google.sheets.read_spreadsheet", { spreadsheetId: "sheet-1" }, context);
    expect(spreadsheet.output).toMatchObject({
      resourceType: "google_sheet",
      spreadsheetId: "sheet-1",
      title: "Metrics",
      sheets: [{ title: "Summary", rowCount: 100, columnCount: 10 }]
    });
    const values = await adapter.executeTool("google.sheets.read_values", {
      spreadsheetId: "sheet-1",
      range: "Summary!A1:B2"
    }, context);
    expect(values.output).toMatchObject({ values: [["Metric", "Value"], ["Users", 42]], cellCount: 4, truncated: false });
    const createdSheet = await adapter.executeTool("google.sheets.create_spreadsheet", {
      title: "Metrics",
      sheetTitles: ["Weekly"]
    }, context);
    expect(createdSheet.providerOperationId).toBe("sheet-created");
    const updated = await adapter.executeTool("google.sheets.update_values", {
      spreadsheetId: "sheet-1",
      range: "Summary!A1:B2",
      values: [["Metric", "Value"], ["Users", 43]]
    }, context);
    expect(updated.output).toMatchObject({ updatedRange: "Summary!A1:B2", updatedCells: 4 });
    const appended = await adapter.executeTool("google.sheets.append_values", {
      spreadsheetId: "sheet-1",
      range: "Summary!A:B",
      values: [["Revenue", 100]]
    }, context);
    expect(appended.output).toMatchObject({ updatedRange: "Summary!A3:B3", updatedCells: 2 });

    expect(requests.find((request) => request.url.pathname.endsWith(":update"))?.method).toBe("PUT");
    expect(requests.find((request) => request.url.pathname.endsWith(":append"))?.method).toBe("POST");
    expect(requests.some((request) => request.url.searchParams.get("includeTabsContent") === "true")).toBe(true);
  });

  it("refreshes once after a Google 401 and retries with the new access token", async () => {
    const authorizations: string[] = [];
    let searchCalls = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = requestUrl(input);
      if (url.hostname === "oauth2.googleapis.com") {
        return googleJson({ access_token: "access-new", expires_in: 3600, token_type: "Bearer" });
      }
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      searchCalls += 1;
      return searchCalls === 1
        ? googleJson({ error: { code: 401, message: "expired" } }, 401)
        : googleJson({ messages: [{ id: "message-1", threadId: "thread-1" }] });
    };
    const adapter = googleAdapter(fetcher);
    const connection = {
      ...googleConnection(["gmail.read"]),
      credentials: { accessToken: "access-old", refreshToken: "refresh-token" }
    };
    const result = await adapter.executeTool(
      "google.gmail.search",
      { query: "is:unread" },
      {
        connection,
        principal: { type: "user", userId: TEST_USER_ID },
        signal: AbortSignal.timeout(1_000)
      }
    );
    expect(result.output).toMatchObject({ messages: [{ id: "message-1" }] });
    expect(authorizations).toEqual(["Bearer access-old", "Bearer access-new"]);
    expect(connection.credentials).toMatchObject({ accessToken: "access-new", refreshToken: "refresh-token" });
  });

  it("records stable Google account identity during OAuth completion", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      return url.hostname === "oauth2.googleapis.com"
        ? googleJson({
            access_token: "access-token",
            refresh_token: "refresh-token",
            expires_in: 3600,
            token_type: "Bearer"
          })
        : googleJson({ sub: "google-account-1", email: "adam@example.com", name: "Adam" });
    };
    const adapter = googleAdapter(fetcher);
    await expect(
      adapter.handleAuthorizationCallback!({ code: "oauth-code", codeVerifier: "v".repeat(32) })
    ).resolves.toMatchObject({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      providerAccountId: "google-account-1",
      providerAccountEmail: "adam@example.com"
    });
  });

  it("signals revoked Google grants as reconnect-required authorization failures", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      return url.hostname === "oauth2.googleapis.com"
        ? googleJson({ error: "invalid_grant", error_description: "Token has been revoked" }, 400)
        : googleJson({ error: { code: 401 } }, 401);
    };
    const adapter = googleAdapter(fetcher);
    const connection = {
      ...googleConnection(["gmail.read"]),
      credentials: { accessToken: "expired", refreshToken: "revoked" }
    };
    await expect(
      adapter.executeTool(
        "google.gmail.search",
        { query: "is:unread" },
        {
          connection,
          principal: { type: "user", userId: TEST_USER_ID },
          signal: AbortSignal.timeout(1_000)
        }
      )
    ).rejects.toMatchObject({
      code: "unauthorized",
      details: { reconnectRequired: true, reason: "invalid_grant" }
    });
  });

  it("requests a prompt follow-up poll when bounded Drive pages remain", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      const current = url.searchParams.get("pageToken") ?? "0";
      return googleJson({ changes: [], nextPageToken: `${Number(current) + 1}` });
    };
    const adapter = googleAdapter(fetcher);
    const started = Date.now();
    const result = await adapter.poll!(
      googleConnection(["drive.read"], { drive: { pageToken: "1" } }),
      AbortSignal.timeout(1_000)
    );
    expect(result.cursor).toMatchObject({ drive: { pageToken: "4", continuing: true } });
    const delay = Date.parse(result.nextPollAt!) - started;
    expect(delay).toBeGreaterThanOrEqual(4_000);
    expect(delay).toBeLessThan(10_000);
  });
});

const TEST_USER_ID = "00000000-0000-7000-8000-000000000001";
const TEST_WORKSPACE_ID = "00000000-0000-7000-8000-000000000002";
const TEST_CONNECTION_ID = "00000000-0000-7000-8000-000000000003";

function googleAdapter(fetcher: typeof fetch) {
  return createGoogleConnector({
    clientId: "google-client",
    clientSecret: "google-secret",
    redirectUri: "https://avalon.example/oauth/google/callback",
    fetch: fetcher
  });
}

function googleConnection(
  grantedScopes: string[],
  cursor: Record<string, unknown> = {}
): ConnectorConnectionContext {
  return {
    id: TEST_CONNECTION_ID,
    workspaceId: TEST_WORKSPACE_ID,
    scope: "personal",
    ownerUserId: TEST_USER_ID,
    grantedScopes,
    credentials: { accessToken: "google-access-token" },
    cursor,
    config: { region: "global", pollIntervalSeconds: 300 }
  };
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(input.toString());
}

function googleJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function calendarEvent(id: string, summary: string, etag: string): Record<string, unknown> {
  return {
    id,
    etag,
    status: "confirmed",
    updated: "2026-07-31T12:00:00Z",
    summary,
    organizer: { displayName: "Samantha", email: "samantha@example.com" },
    start: { dateTime: "2026-08-01T10:00:00-07:00" },
    end: { dateTime: "2026-08-01T11:00:00-07:00" }
  };
}

function base64UrlText(value: string): string {
  return btoa(value).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function expectNormalized(activities: Array<Record<string, unknown>>): void {
  for (const [index, activity] of activities.entries()) {
    expect(() =>
      NormalizedActivitySchema.parse({
        ...activity,
        id: `00000000-0000-7000-8000-${String(index + 10).padStart(12, "0")}`
      })
    ).not.toThrow();
  }
}
