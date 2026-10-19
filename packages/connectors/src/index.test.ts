import { asUserId, asWorkspaceId } from "@rally/contracts";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { alreadyAborted, neverAborts } from "./test-signals";
import { NormalizedActivitySchema } from "@rally/contracts";
import { createAshbyConnector } from "./ashby";
import { createFirefliesConnector } from "./fireflies";
import { createGranolaConnector } from "./granola";
import {
  __testing,
  assertPrincipalAccess,
  connectorActivitySupportsScope,
  connectorSupportsSurface,
  ConnectorRegistry,
  createGenericWebhookConnector,
  createGoogleConnector,
  CredentialCipher,
  defineConnectorActivityTriggers,
  googleDriveFileIdFromReference,
  googleTools,
  isConnectorResourceAccessRefusal,
  pollCheckpointedActivityStreams,
  verifyGenericWebhook,
  authorizedConnection,
  type AuthorizedConnectorConnection
} from "./index";

describe("connectors", () => {
  it("normalizes legacy manifests before exposing connector surfaces", () => {
    const registry = new ConnectorRegistry([createGenericWebhookConnector()]);
    const manifest = registry.get("generic_webhook").manifest;
    expect(manifest.surfaces).toEqual(["resource"]);
    expect(connectorSupportsSurface(manifest, "resource")).toBe(true);
    expect(connectorSupportsSurface(manifest, "native_agent")).toBe(false);
  });

  it("requires a native-agent manifest surface to have a matching protocol facet", () => {
    expect(() => new ConnectorRegistry([{
      agentPlugin: {
        providerType: "missing-native-protocol",
        wireNamePrefix: "missing_native",
        description: "Test-only native protocol connector.",
        systemMessage: "Use only the tools exposed by this test connector.",
        tools: [],
      },
      manifest: {
        type: "missing-native-protocol",
        displayName: "Missing native protocol",
        surfaces: ["resource", "native_agent"],
        capabilities: [{ id: "provider.agent", kind: "native_agent" }],
        nativeAgent: {
          capability: "provider.agent",
          invocationModes: ["delegation"],
          activityKinds: ["response", "error"],
          supportsCancellation: true,
          supportsExternalLinks: true,
          supportsPlans: false,
          supportsProactiveSessions: false,
          maturity: "preview",
          runtimeStatus: "protocol_only",
          sessionOwnership: "single_connection_per_provider_account",
        },
        supportedScopes: ["workspace"],
        oauthRequired: true,
        activityTriggers: [],
        resourceTypes: [],
        tools: [],
        supportsWatches: false,
        supportsPolling: false,
        supportsWebhooks: true,
      },
      async executeTool(name) {
        throw new Error(`Unexpected tool ${name}`);
      },
      async healthCheck() {
        return { ok: true, message: "Configured" };
      },
    }])).toThrow(/without a protocol adapter/u);
  });

  it("carries no events to a personal connection of a connector whose webhook is the workspace install's", () => {
    // Each of these three refuses a personal connection from `normalize`, so
    // a trigger advertised on one is an event that can never arrive. Declared
    // here rather than inferred, because nothing about a manifest says which
    // side of the install a provider's webhook lives on.
    const workspaceOnly = [
      createGranolaConnector({ redirectUri: "https://api.example.test/connections/granola/callback" }),
      createFirefliesConnector({ redirectUri: "https://api.example.test/connections/fireflies/callback" }),
      createAshbyConnector({ redirectUri: "https://api.example.test/connections/ashby/callback" }),
    ];

    for (const adapter of workspaceOnly) {
      expect(connectorActivitySupportsScope(adapter, "workspace")).toBe(true);
      expect(connectorActivitySupportsScope(adapter, "personal")).toBe(false);
    }
    // Narrowed per connector: a webhook a personal connection owns is still
    // delivered to it.
    expect(connectorActivitySupportsScope(createGenericWebhookConnector(), "personal")).toBe(true);
  });

  it("refuses an adapter that narrows the scopes of activity it does not produce", () => {
    // The narrowing is a claim about events, so an adapter with none is a
    // declaration nothing reads — and the next reader would take its silence
    // for "activity works everywhere" rather than "there is no activity".
    expect(() => new ConnectorRegistry([{
      agentPlugin: {
        providerType: "eventless",
        wireNamePrefix: "eventless",
        description: "Test-only connector with no events.",
        systemMessage: "Use only the tools exposed by this test connector.",
        tools: [],
      },
      activityConnectionScopes: ["workspace"],
      manifest: {
        type: "eventless",
        displayName: "Eventless",
        supportedScopes: ["personal", "workspace"],
        oauthRequired: true,
        capabilities: [],
        activityTriggers: [],
        resourceTypes: [],
        tools: [],
        supportsWatches: false,
        supportsPolling: false,
        supportsWebhooks: false,
      },
      async executeTool(name) {
        throw new Error(`Unexpected tool ${name}`);
      },
      async healthCheck() {
        return { ok: true, message: "Configured" };
      },
    }])).toThrow(/narrows the scopes of activity it does not produce/u);
  });

  // The declaration only ever narrows: an empty one closes a connector nothing
  // could then connect at all, and one naming a scope outside
  // `supportedScopes` reads as opening a scope this adapter cannot serve. Both
  // are a mistake in the adapter, and the registry is where a mistake in an
  // adapter is caught.
  function narrowingConnector(
    connectableScopes: ("personal" | "workspace")[],
    supportedScopes: ("personal" | "workspace")[],
  ) {
    return {
      agentPlugin: {
        providerType: "narrowing",
        wireNamePrefix: "narrowing",
        description: "Test-only connector that narrows its connectable scopes.",
        systemMessage: "Use only the tools exposed by this test connector.",
        tools: [],
      },
      connectableScopes,
      manifest: {
        type: "narrowing",
        displayName: "Narrowing",
        supportedScopes,
        oauthRequired: true,
        capabilities: [],
        activityTriggers: [],
        resourceTypes: [],
        tools: [],
        supportsWatches: false,
        supportsPolling: false,
        supportsWebhooks: false,
      },
      async executeTool(name: string): Promise<never> {
        throw new Error(`Unexpected tool ${name}`);
      },
      async healthCheck() {
        return { ok: true, message: "Configured" };
      },
    };
  }

  it("refuses an empty declaration of connectable scopes", () => {
    expect(() => new ConnectorRegistry([narrowingConnector([], ["personal", "workspace"])]))
      .toThrow(/invalid connectable connection scopes/u);
  });

  it("refuses a connectable scope the connector does not support", () => {
    expect(() => new ConnectorRegistry([narrowingConnector(["personal"], ["workspace"])]))
      .toThrow(/invalid connectable connection scopes/u);
  });

  it("does not let another user borrow a personal connection", () => {
    expect(() =>
      assertPrincipalAccess(
        {
          id: "connection",
          workspaceId: asWorkspaceId("1629dee4-8cc4-4531-81f9-b2be8614e062"),
          scope: "personal",
          ownerUserId: "alice",
          grantedScopes: [],
          credentials: {},
          cursor: {},
          config: {}
        },
        { type: "user", userId: asUserId("9f9d51bc-70ef-41ca-8c14-f307980a29d8") }
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

  it("verifies generic webhook HMACs over the exact received bytes", async () => {
    const secret = "test-secret";
    const timestamp = 1_700_000_000;
    const json = new TextEncoder().encode(JSON.stringify({ event_type: "transcript.completed" }));
    const body = new Uint8Array(3 + json.byteLength);
    body.set([0xef, 0xbb, 0xbf]);
    body.set(json, 3);
    const prefix = new TextEncoder().encode(`${timestamp}.`);
    const signed = new Uint8Array(prefix.byteLength + body.byteLength);
    signed.set(prefix);
    signed.set(body, prefix.byteLength);
    const signature = await __testing.hmacHex(secret, signed);

    await expect(verifyGenericWebhook({
      secret,
      signatureHeader: `t=${timestamp},v1=${signature.toUpperCase()}`,
      body,
      now: timestamp,
    })).resolves.toMatchObject({
      timestamp,
      event: { event_type: "transcript.completed" },
    });
  });

  it("classifies signed malformed generic webhook payloads as invalid payloads", async () => {
    const secret = "test-secret";
    const timestamp = 1_700_000_000;
    const body = "[]";
    const signature = await __testing.hmacHex(secret, `${timestamp}.${body}`);

    await expect(verifyGenericWebhook({
      secret,
      signatureHeader: `t=${timestamp},v1=${signature}`,
      body,
      now: timestamp,
    })).rejects.toMatchObject({ code: "invalid_payload" });
  });

  it("bounds generic webhook person evidence without dropping the activity", () => {
    const source = createGenericWebhookConnector().webhookActivity!;
    const activity = source.normalize({
      id: TEST_CONNECTION_ID,
      workspaceId: TEST_WORKSPACE_ID,
      scope: "workspace",
      ownerUserId: null,
      grantedScopes: [],
      credentials: {},
      cursor: {},
      config: {},
    }, {
      deliveryId: "generic-event-1",
      eventType: "ticket.updated",
      providerAccountId: null,
      bodyHash: "body-hash",
      event: {
        title: "Ticket updated",
        external_people: [
          {
            provider: "p".repeat(100),
            providerTenantId: "t".repeat(250),
            providerUserId: "person-1",
            handle: "h".repeat(250),
            email: "not-an-email",
            displayName: "D".repeat(250),
            role: "mentioned",
            sourceText: "S".repeat(1_200),
            ignored: "untrusted extra field",
          },
          { displayName: "Missing required evidence" },
        ],
      },
    }, null);

    expect(activity?.externalPeople).toEqual([expect.objectContaining({
      provider: "p".repeat(80),
      providerTenantId: "t".repeat(200),
      handle: "h".repeat(200),
      email: null,
      displayName: "D".repeat(180),
      sourceText: "S".repeat(1_000),
    })]);
    expect(() => NormalizedActivitySchema.parse({
      id: "00000000-0000-7000-8000-000000000099",
      ...activity,
    })).not.toThrow();
  });

  it("marks every activity a non-digestible stream produced, and nothing else", async () => {
    const connection = googleConnection([]);
    const result = await pollCheckpointedActivityStreams({
      streams: () => [
        { id: "gmail", idlePollIntervalSeconds: 300, digestible: true },
        { id: "drive", idlePollIntervalSeconds: 300, digestible: false },
      ],
      normalizeHighWatermark: () => ({}),
      async pollStream(_connection, stream) {
        return {
          activities: [activityFrom(stream.id)],
          highWatermark: {},
          hasMore: false,
        };
      },
    }, connection, neverAborts());

    const byEventType = new Map(result.activities.map((activity) => [activity.eventType, activity.metadata]));
    // The stamp travels with the activity through the queue and the ingest
    // row, because the decision is made here and read when the activity log is
    // written — long after the stream object is gone.
    expect(byEventType.get("drive.file_changed")).toMatchObject({ _streamNotDigestible: true });
    expect(byEventType.get("gmail.email.received")).not.toHaveProperty("_streamNotDigestible");
  });

  it("refuses an activity type declared both digestible and operational", () => {
    // Two lists are what force the decision; an event type in both is the
    // decision not being made, and the manifest's duplicate check would see
    // only a duplicate descriptor rather than an unanswered question.
    expect(() => defineConnectorActivityTriggers("Test", {
      digestible: ["test.thing.happened"],
      operational: ["test.thing.happened"],
    })).toThrow(/both digestible and operational/);
  });

  it("carries digestibility from the partition onto every descriptor", () => {
    const triggers = defineConnectorActivityTriggers("Test", {
      digestible: ["test.review.submitted"],
      operational: ["test.check.completed"],
    });

    expect(triggers.map((trigger) => [trigger.eventType, trigger.digestible])).toEqual([
      ["test.review.submitted", true],
      ["test.check.completed", false],
    ]);
  });

  it("checkpoints polling streams independently and isolates transient failures", async () => {
    const connection = googleConnection([]);
    connection.cursor = {
      activityStreams: {
        calendar: { highWatermark: { syncToken: "calendar-old" } },
      },
    };
    const result = await pollCheckpointedActivityStreams({
      streams: () => [
        { id: "gmail", idlePollIntervalSeconds: 300, backlogPollIntervalSeconds: 5, digestible: true },
        { id: "calendar", idlePollIntervalSeconds: 300, failurePollIntervalSeconds: 60, digestible: true },
      ],
      normalizeHighWatermark(_connection, _stream, value) {
        return value && typeof value === "object" && !Array.isArray(value)
          ? value as Record<string, unknown>
          : {};
      },
      async pollStream(_connection, stream, highWatermark) {
        if (stream.id === "calendar") {
          expect(highWatermark).toEqual({ syncToken: "calendar-old" });
          throw new Error("temporary calendar outage");
        }
        return { activities: [], highWatermark: { historyId: "gmail-new" }, hasMore: true };
      },
    }, connection, neverAborts());

    expect(result.cursor).toMatchObject({
      activityStreams: {
        gmail: { highWatermark: { historyId: "gmail-new" } },
        calendar: { highWatermark: { syncToken: "calendar-old" } },
      },
    });
    expect(result.streamErrors).toEqual([expect.objectContaining({ streamId: "calendar" })]);
    expect(Date.parse(result.nextPollAt!)).toBeLessThanOrEqual(Date.now() + 6_000);
  });

  it("names the field a stream's provider answered without, where a network fault says poll_failed", async () => {
    // A provider answering a poll with a body the stream's schema does not
    // model is not an outage, and `poll_failed` is what an outage also says.
    // The code reaches the connection row as the stream's degradation reason.
    const connection = googleConnection([]);
    const result = await pollCheckpointedActivityStreams({
      streams: () => [
        { id: "calendar", idlePollIntervalSeconds: 300, digestible: true },
        { id: "mail", idlePollIntervalSeconds: 300, digestible: true },
      ],
      normalizeHighWatermark: () => ({}),
      async pollStream(_connection, stream) {
        if (stream.id === "calendar") {
          const parsed = z.strictObject({ items: z.array(z.strictObject({ start: z.string() })) })
            .safeParse({ items: [{ start: { dateTime: "member content must remain absent" } }] });
          if (!parsed.success) throw parsed.error;
        }
        throw new Error("temporary mail outage");
      },
    }, connection, neverAborts());

    expect(result.streamErrors).toEqual([
      expect.objectContaining({ streamId: "calendar", code: "schema_invalid:items.0.start:invalid_type" }),
      expect.objectContaining({ streamId: "mail", code: "poll_failed" }),
    ]);
    expect(result.streamErrors![0]!.message).not.toContain("member content must remain absent");
  });

  it("normalizes provider-native sequence, date, and cursor watermarks on load and commit", async () => {
    const connection = googleConnection([]);
    connection.cursor = {
      sequenceLegacy: 41,
      activityStreams: {
        date: { highWatermark: "2026-08-10T10:00:00-07:00" },
        cursor: { highWatermark: "cursor-old" },
      },
    };
    const seen = new Map<string, Record<string, unknown>>();
    const result = await pollCheckpointedActivityStreams({
      streams: () => [
        { id: "sequence", legacyCursorKey: "sequenceLegacy", idlePollIntervalSeconds: 300, digestible: true },
        { id: "date", idlePollIntervalSeconds: 300, digestible: true },
        { id: "cursor", idlePollIntervalSeconds: 300, digestible: true },
      ],
      normalizeHighWatermark(_connection, stream, value) {
        if (value == null) return {};
        if (stream.id === "sequence") {
          const sequence = typeof value === "object" && value
            ? (value as Record<string, unknown>).sequence
            : value;
          return { sequence: Number(sequence) };
        }
        if (stream.id === "date") {
          const date = typeof value === "object" && value
            ? (value as Record<string, unknown>).occurredAfter
            : value;
          return { occurredAfter: new Date(String(date)).toISOString() };
        }
        const cursor = typeof value === "object" && value
          ? (value as Record<string, unknown>).cursor
          : value;
        return { cursor: String(cursor) };
      },
      async pollStream(_connection, stream, highWatermark) {
        seen.set(stream.id, highWatermark);
        return {
          activities: [],
          highWatermark: stream.id === "sequence"
            ? 42
            : stream.id === "date"
              ? "2026-08-10T18:00:00Z"
              : "cursor-new",
          hasMore: false,
        };
      },
    }, connection, neverAborts());

    expect(Object.fromEntries(seen)).toEqual({
      sequence: { sequence: 41 },
      date: { occurredAfter: "2026-08-10T17:00:00.000Z" },
      cursor: { cursor: "cursor-old" },
    });
    expect(result.cursor.activityStreams).toMatchObject({
      sequence: { highWatermark: { sequence: 42 } },
      date: { highWatermark: { occurredAfter: "2026-08-10T18:00:00.000Z" } },
      cursor: { highWatermark: { cursor: "cursor-new" } },
    });
  });

  it("encrypts credentials with authenticated context", async () => {
    const cipher = new CredentialCipher(new Uint8Array(32).fill(7), 3);
    const encrypted = await cipher.encrypt({ refreshToken: "private" }, "connection-1");
    await expect(cipher.decrypt(encrypted.ciphertext, encrypted.iv, "connection-1")).resolves.toEqual({
      refreshToken: "private"
    });
    await expect(cipher.decrypt(encrypted.ciphertext, encrypted.iv, "connection-2")).rejects.toThrow();
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
    const baseline = await adapter.poll!(googleConnection(["gmail.read"]), neverAborts());
    expect(baseline.activities).toEqual([]);
    expect(baseline.cursor).toMatchObject({ gmail: { historyId: "100" } });

    const incremental = await adapter.poll!(
      googleConnection(["gmail.read"], baseline.cursor),
      neverAborts()
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
      neverAborts()
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
      neverAborts()
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
      neverAborts()
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

  /** The series master Google holds for `standup`, as `events.get` returns it. */
  function standupMaster(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "standup",
      etag: "master-etag",
      status: "confirmed",
      updated: "2026-09-02T09:15:00Z",
      summary: "Weekly standup",
      location: "Room 4",
      htmlLink: "https://calendar.google.com/event?eid=standup",
      organizer: { displayName: "Samantha", email: "samantha@example.com" },
      attendees: [{ email: "dana@example.com", displayName: "Dana", responseStatus: "accepted" }],
      start: { dateTime: "2026-08-24T10:00:00-07:00", timeZone: "America/Los_Angeles" },
      end: { dateTime: "2026-08-24T10:30:00-07:00", timeZone: "America/Los_Angeles" },
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
      ...overrides
    };
  }

  /** Routes the one master read a changed series costs; everything else is the sync page. */
  function calendarFetcher(
    pages: (url: URL) => Response | Promise<Response>,
    masters: Record<string, Record<string, unknown> | number>,
    masterReads: URL[] = []
  ): typeof fetch {
    return async (input) => {
      const url = requestUrl(input);
      const master = /\/calendars\/primary\/events\/([^/?]+)$/u.exec(url.pathname)?.[1];
      if (master !== undefined) {
        masterReads.push(url);
        const body = masters[decodeURIComponent(master)];
        if (body === undefined) throw new Error(`Unexpected Calendar master read: ${url}`);
        return typeof body === "number"
          ? googleJson({ error: { code: body, message: "Not Found" } }, body)
          : googleJson(body);
      }
      return pages(url);
    };
  }

  it("collapses one recurring-series edit into a single Calendar activity built from the master", async () => {
    const instances = Array.from({ length: 40 }, (_, index) => ({
      ...calendarEvent(`standup_2026090${index % 10}T170000Z`, "Weekly standup", `etag-${index}`),
      updated: "2026-09-02T09:15:00Z",
      recurringEventId: "standup",
      htmlLink: `https://calendar.google.com/event?eid=instance-${index}`,
      start: { dateTime: `2026-09-0${index % 10}T10:00:00-07:00` },
      end: { dateTime: `2026-09-0${index % 10}T10:30:00-07:00` }
    }));
    const masterReads: URL[] = [];
    const fetcher = calendarFetcher((url) => {
      if (url.searchParams.get("pageToken") === "calendar-page-2") {
        return googleJson({ items: instances.slice(20), nextSyncToken: "calendar-sync-new" });
      }
      return googleJson({ items: instances.slice(0, 20), nextPageToken: "calendar-page-2" });
    }, { standup: standupMaster() }, masterReads);
    const adapter = googleAdapter(fetcher);
    const result = await adapter.poll!(
      googleConnection(["calendar.read"], { calendar: { syncToken: "calendar-sync-old" } }),
      neverAborts()
    );
    expect(result.activities).toHaveLength(1);
    expect(result.activities[0]).toMatchObject({
      eventType: "calendar.event_changed",
      providerResourceId: "standup",
      title: "Recurring event changed: Weekly standup",
      summary: "Every occurrence of this recurring event changed · first occurrence 2026-08-24T10:00:00-07:00",
      textSnippet: "Weekly standup · Room 4",
      occurredAt: "2026-09-02T09:15:00.000Z",
      subject: {
        start: { dateTime: "2026-08-24T10:00:00-07:00", timeZone: "America/Los_Angeles" },
        end: { dateTime: "2026-08-24T10:30:00-07:00", timeZone: "America/Los_Angeles" }
      },
      entityKeys: ["google:calendar:primary:event:standup"],
      metadata: {
        seriesChange: true,
        recurringEventId: "standup",
        htmlLink: "https://calendar.google.com/event?eid=standup",
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"]
      }
    });
    // Keyed on the master and its own `updated` rather than on an instance's
    // etag, so the pages and later polls the same burst spreads over repeat one
    // identity the workspace already holds.
    expect(result.activities[0]?.dedupeKey).toBe("calendar:primary:standup:series:2026-09-02T09:15:00.000Z");
    // The guest's RSVP is the series-level one from the master, not an
    // occurrence's, so it can travel.
    expect(result.activities[0]?.externalPeople).toContainEqual(
      expect.objectContaining({ email: "dana@example.com", role: "attendee" })
    );
    expect(
      result.activities[0]?.externalPeople?.find((person) => person.role === "attendee")?.sourceText
    ).toContain('"responseStatus":"accepted"');
    // One master read for the whole poll, however many pages the burst spans.
    expect(masterReads).toHaveLength(1);
    expect(masterReads[0]?.searchParams.get("fields")).toContain("recurrence");
    expectNormalized(result.activities);
  });

  it("collapses a cancelled recurring series that arrives as stripped instances", async () => {
    const stripped = Array.from({ length: 12 }, (_, index) => ({
      id: `offsite_2026100${index % 10}T160000Z`,
      etag: `cancel-etag-${index}`,
      status: "cancelled",
      updated: "2026-09-02T11:00:00Z"
    }));
    const fetcher = calendarFetcher(
      () => googleJson({ items: stripped, nextSyncToken: "calendar-sync-new" }),
      { offsite: standupMaster({ id: "offsite", status: "cancelled", updated: "2026-09-02T11:00:00Z", summary: "Offsite" }) }
    );
    const adapter = googleAdapter(fetcher);
    const result = await adapter.poll!(
      googleConnection(["calendar.read"], { calendar: { syncToken: "calendar-sync-old" } }),
      neverAborts()
    );
    expect(result.activities).toHaveLength(1);
    // The instances arrive without a title; the master still has one.
    expect(result.activities[0]).toMatchObject({
      providerResourceId: "offsite",
      title: "Recurring event cancelled: Offsite",
      summary: "Every occurrence of this recurring event was cancelled · first occurrence 2026-08-24T10:00:00-07:00",
      metadata: { seriesChange: true, recurringEventId: "offsite", status: "cancelled" }
    });
    expect(result.activities[0]?.dedupeKey).toBe("calendar:primary:offsite:series:2026-09-02T11:00:00.000Z");
    expectNormalized(result.activities);
  });

  it("falls back to what every instance agrees on when the master cannot be read", async () => {
    const stripped = Array.from({ length: 12 }, (_, index) => ({
      id: `offsite_2026100${index % 10}T160000Z`,
      etag: `cancel-etag-${index}`,
      status: "cancelled",
      updated: "2026-09-02T11:00:00Z"
    }));
    const fetcher = calendarFetcher(
      () => googleJson({ items: stripped, nextSyncToken: "calendar-sync-new" }),
      { offsite: 404 }
    );
    const adapter = googleAdapter(fetcher);
    const result = await adapter.poll!(
      googleConnection(["calendar.read"], { calendar: { syncToken: "calendar-sync-old" } }),
      neverAborts()
    );
    // Still one activity, keyed on the edit the instances record, and carrying
    // nothing that varies between them: the same payload from any chunk.
    expect(result.activities).toHaveLength(1);
    expect(result.activities[0]).toMatchObject({
      providerResourceId: "offsite",
      title: "Recurring event cancelled: Untitled event",
      summary: "Every occurrence of this recurring event was cancelled",
      subject: { start: {}, end: {} },
      metadata: { seriesChange: true, recurringEventId: "offsite", status: "cancelled", htmlLink: null }
    });
    expect(result.activities[0]?.dedupeKey).toBe("calendar:primary:offsite:series:2026-09-02T11:00:00.000Z");
    expect(result.activities[0]?.metadata).not.toHaveProperty("recurrence");
    expectNormalized(result.activities);
  });

  it("keeps an occurrence edited on its own apart from the series-wide edit", async () => {
    const fetcher = calendarFetcher(
      () => googleJson({
        items: [
          {
            ...calendarEvent("standup_20260904T170000Z", "Weekly standup", "exception-etag"),
            updated: "2026-09-02T09:20:00Z",
            recurringEventId: "standup",
            start: { dateTime: "2026-09-04T11:00:00-07:00" },
            end: { dateTime: "2026-09-04T11:30:00-07:00" }
          },
          {
            ...calendarEvent("standup_20260905T170000Z", "Weekly standup", "series-etag-1"),
            updated: "2026-09-02T09:15:00Z",
            recurringEventId: "standup"
          },
          {
            ...calendarEvent("standup_20260906T170000Z", "Weekly standup", "series-etag-2"),
            updated: "2026-09-02T09:15:00Z",
            recurringEventId: "standup"
          }
        ],
        nextSyncToken: "calendar-sync-new"
      }),
      { standup: standupMaster() }
    );
    const adapter = googleAdapter(fetcher);
    const result = await adapter.poll!(
      googleConnection(["calendar.read"], { calendar: { syncToken: "calendar-sync-old" } }),
      neverAborts()
    );
    // The occurrence's `updated` is after the master's, so it was edited on its
    // own: reported as that occurrence, with its real times, on its own etag.
    // The other two belong to the edit the master records.
    expect(result.activities.map((activity) => activity.dedupeKey)).toEqual([
      "calendar:primary:standup_20260904T170000Z:exception-etag",
      "calendar:primary:standup:series:2026-09-02T09:15:00.000Z"
    ]);
    expect(result.activities[0]).toMatchObject({
      title: "Calendar event changed: Weekly standup",
      summary: "Starts 2026-09-04T11:00:00-07:00",
      metadata: { seriesChange: false, recurringEventId: "standup" }
    });
    expectNormalized(result.activities);
  });

  it("reports a lone instance of a series exactly as a full chunk of it", async () => {
    const instance = (id: string, responseStatus: string): Record<string, unknown> => ({
      ...calendarEvent(id, "Weekly standup", `etag-${id}`),
      updated: "2026-09-02T09:15:00Z",
      recurringEventId: "standup",
      location: "Room 9",
      attendees: [{ email: "dana@example.com", displayName: "Dana", responseStatus }]
    });
    const pollOnce = async (items: Record<string, unknown>[]) => {
      const adapter = googleAdapter(calendarFetcher(
        () => googleJson({ items, nextSyncToken: "calendar-sync-new" }),
        { standup: standupMaster() }
      ));
      const result = await adapter.poll!(
        googleConnection(["calendar.read"], { calendar: { syncToken: "calendar-sync-old" } }),
        neverAborts()
      );
      return result.activities;
    };

    // A burst outruns the 150 items one poll fetches, so the same series edit
    // arrives again in later chunks — here three occurrences, then a single
    // trailing one whose guest has since declined that Tuesday.
    const chunk = await pollOnce([
      instance("standup_20260905T170000Z", "accepted"),
      instance("standup_20260906T170000Z", "accepted"),
      instance("standup_20260907T170000Z", "accepted")
    ]);
    const tail = await pollOnce([instance("standup_20260908T170000Z", "declined")]);

    expect(chunk).toHaveLength(1);
    expect(tail).toHaveLength(1);
    // Identical but for delivery time: the workspace refuses a repeated identity
    // whose payload changed, so the content comes from the master, never from
    // whichever instances a chunk held. Room 9 and the declined Tuesday are
    // the instances'; Room 4 and the accepted RSVP are the series'.
    expect({ ...tail[0], receivedAt: "" }).toEqual({ ...chunk[0], receivedAt: "" });
    expect(tail[0]?.dedupeKey).toBe("calendar:primary:standup:series:2026-09-02T09:15:00.000Z");
    expect(tail[0]?.textSnippet).toBe("Weekly standup · Room 4");
    const guest = tail[0]?.externalPeople?.find((person) => person.role === "attendee")?.sourceText;
    expect(guest).toContain('"responseStatus":"accepted"');
    expect(guest).not.toContain("declined");
    expectNormalized(tail);
  });

  it("reports a stale chunk of an older edit against the master as it now stands", async () => {
    // The series was edited again at 09:30 while the 09:15 burst was still
    // arriving. This trailing chunk of the 09:15 edit is reported under the
    // 09:30 identity with the 09:30 content — the same activity the 09:30
    // burst's own chunks produce, so the workspace holds one of them.
    const fetcher = calendarFetcher(
      () => googleJson({
        items: [{
          ...calendarEvent("standup_20260908T170000Z", "Weekly standup", "old-etag"),
          updated: "2026-09-02T09:15:00Z",
          recurringEventId: "standup"
        }],
        nextSyncToken: "calendar-sync-new"
      }),
      { standup: standupMaster({ updated: "2026-09-02T09:30:00Z", summary: "Weekly standup (moved)" }) }
    );
    const adapter = googleAdapter(fetcher);
    const result = await adapter.poll!(
      googleConnection(["calendar.read"], { calendar: { syncToken: "calendar-sync-old" } }),
      neverAborts()
    );
    expect(result.activities).toHaveLength(1);
    expect(result.activities[0]).toMatchObject({
      title: "Recurring event changed: Weekly standup (moved)",
      occurredAt: "2026-09-02T09:30:00.000Z",
      dedupeKey: "calendar:primary:standup:series:2026-09-02T09:30:00.000Z"
    });
    expectNormalized(result.activities);
  });

  it("does not invent a series for a one-off event whose id looks like an instance", async () => {
    const fetcher: typeof fetch = async () =>
      googleJson({
        items: [
          {
            ...calendarEvent("budget_20260910", "Budget review", "budget-etag"),
            updated: "2026-09-02T12:00:00Z"
          }
        ],
        nextSyncToken: "calendar-sync-new"
      });
    const adapter = googleAdapter(fetcher);
    const result = await adapter.poll!(
      googleConnection(["calendar.read"], { calendar: { syncToken: "calendar-sync-old" } }),
      neverAborts()
    );
    expect(result.activities).toHaveLength(1);
    expect(result.activities[0]).toMatchObject({
      providerResourceId: "budget_20260910",
      title: "Calendar event changed: Budget review",
      dedupeKey: "calendar:primary:budget_20260910:budget-etag",
      metadata: { seriesChange: false, recurringEventId: null }
    });
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
      neverAborts()
    );
    expect(calls).toBe(2);
    expect(result.activities).toEqual([]);
    expect(result.cursor).toMatchObject({ calendar: { syncToken: "calendar-baseline-new" } });
  });

  it("emits a deduplicated Calendar completion when an event end crosses the poll window", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.pathname.includes("/users/me/calendarList/")) {
        return googleJson({ timeZone: "UTC" });
      }
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
      neverAborts()
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
            },
            {
              fileId: "file-3",
              time: "2026-07-31T12:00:30Z",
              file: {
                id: "file-3",
                name: "Budget.pdf",
                mimeType: "application/pdf",
                modifiedTime: "2026-07-31T12:00:30Z",
                md5Checksum: "0123456789abcdef0123456789abcdef"
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
    const baseline = await adapter.poll!(googleConnection(["drive.read"]), neverAborts());
    expect(baseline.activities).toEqual([]);
    expect(baseline.cursor).toMatchObject({ drive: { pageToken: "10" } });

    const incremental = await adapter.poll!(
      googleConnection(["drive.read"], baseline.cursor),
      neverAborts()
    );
    expect(incremental.cursor).toMatchObject({ drive: { pageToken: "20" } });
    expect(incremental.activities).toHaveLength(3);
    // The edit is in the content, not only the identity: ingest drops an event
    // whose content repeats its file's last one, and a Google-native file has
    // no checksum, so its modified time is the only thing telling edits apart.
    expect(incremental.activities[0]).toMatchObject({
      eventType: "docs.document_changed",
      resourceType: "google_doc",
      providerResourceId: "file-1",
      metadata: {
        mimeType: "application/vnd.google-apps.document",
        modifiedTime: "2026-07-31T12:00:00Z",
        md5Checksum: null
      }
    });
    expect(incremental.activities[1]).toMatchObject({
      eventType: "drive.file_changed",
      providerResourceId: "file-3",
      metadata: {
        modifiedTime: "2026-07-31T12:00:30Z",
        md5Checksum: "0123456789abcdef0123456789abcdef"
      }
    });
    expect(incremental.activities[2]).toMatchObject({
      eventType: "drive.file_changed",
      providerResourceId: "file-2",
      title: "Drive file removed: Drive file file-2"
    });
    expectNormalized(incremental.activities);
    expect(requested.filter((url) => url.pathname.endsWith("/changes"))).toHaveLength(2);
  });

  it("hydrates Google resources into bounded, provider-specific context", async () => {
    let driveMetadataFields: string | null = null;
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
        driveMetadataFields = url.searchParams.get("fields");
        return googleJson({
          id: "file-1",
          name: "notes.txt",
          mimeType: "text/plain",
          size: "11",
          modifiedTime: "2026-07-31T12:00:00Z",
          isAppAuthorized: true,
          capabilities: { canEdit: true }
        });
      }
      throw new Error(`Unexpected Google URL: ${url}`);
    };
    const adapter = googleAdapter(fetcher);
    const connection = googleConnection(["gmail.read", "calendar.read", "drive.read"]);
    const signal = neverAborts();
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
      writableByRally: true,
      textContent: "Avalon text",
      contentTruncated: false
    });
    expect(driveMetadataFields).toContain("isAppAuthorized");
    expect(driveMetadataFields).toContain("capabilities(canEdit)");
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
      "gmail.read_message",
      "calendar.read_event",
      "drive.get_metadata",
      "drive.download"
    ]));
    const connection = googleConnection(["gmail.read", "drive.read"]);
    const context = {
      connection,
      principal: { type: "user" as const, userId: TEST_USER_ID },
      signal: neverAborts()
    };
    const message = await adapter.executeTool("gmail.read_message", { messageId: "message-1" }, context);
    expect(message.output).toMatchObject({
      id: "message-1",
      textContent: "Useful message body",
      attachments: [{ filename: "private.pdf", contentIncluded: false }]
    });
    expect(JSON.stringify(message.output)).not.toContain("body\":{");

    const callsBeforePdf = requested.length;
    const pdf = await adapter.executeTool(
      "drive.export",
      { fileId: "file-1", mimeType: "application/pdf" },
      context
    );
    expect(pdf.output).toMatchObject({ contentIncluded: false, mimeType: "application/pdf" });
    expect(pdf.output).not.toHaveProperty("base64");
    expect(requested).toHaveLength(callsBeforePdf);
  });

  it("reads the connected Gmail account's own address rather than leaving it to be inferred", async () => {
    const requests: URL[] = [];
    const fetcher: typeof fetch = async (input) => {
      requests.push(requestUrl(input));
      return googleJson({
        emailAddress: "adam@example.com",
        messagesTotal: 42_000,
        threadsTotal: 9_000,
        historyId: "998877"
      });
    };
    const result = await googleAdapter(fetcher).executeTool(
      "gmail.read_profile",
      {},
      {
        connection: googleConnection(["gmail.read"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    );
    expect(requests[0]?.pathname).toBe("/gmail/v1/users/me/profile");
    expect(result.output).toMatchObject({
      resourceType: "gmail_profile",
      emailAddress: "adam@example.com",
      messagesTotal: 42_000,
      threadsTotal: 9_000,
      historyId: "998877"
    });
    expect(result.summary).toContain("adam@example.com");
  });

  it("refuses the account profile to a connection that was not granted Gmail read", async () => {
    const fetcher: typeof fetch = async () => googleJson({ emailAddress: "adam@example.com" });
    await expect(googleAdapter(fetcher).executeTool(
      "gmail.read_profile",
      {},
      {
        connection: googleConnection(["calendar.read"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    )).rejects.toMatchObject({ code: "unsupported_capability" });
  });

  it("returns sender, recipients, subject, and snippet with every Gmail search hit", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/users/me/messages")) {
        return googleJson({
          messages: [{ id: "message-1", threadId: "thread-1" }, { id: "message-2", threadId: "thread-2" }],
          resultSizeEstimate: 2
        });
      }
      if (url.pathname.endsWith("/messages/message-1")) {
        return googleJson({
          id: "message-1",
          threadId: "thread-1",
          labelIds: ["INBOX"],
          snippet: "Tuesday call agenda",
          internalDate: "1786000000000",
          payload: {
            headers: [
              { name: "From", value: "Alex Rivera <alex.rivera@mucker.example>" },
              { name: "To", value: "Adam <adam@example.com>" },
              { name: "Subject", value: "Tuesday sync" },
              { name: "Date", value: "Mon, 10 Aug 2026 09:00:00 -0700" },
              { name: "Message-ID", value: "<abc123@mail.example>" }
            ]
          }
        });
      }
      // A hit that has been deleted since it was indexed must not cost the
      // caller the rest of the result set.
      if (url.pathname.endsWith("/messages/message-2")) return googleJson({ error: { code: 404 } }, 404);
      throw new Error(`Unexpected Google fetch: ${url}`);
    };
    const result = await googleAdapter(fetcher).executeTool(
      "gmail.search",
      { query: "subject:sync newer_than:30d" },
      {
        connection: googleConnection(["gmail.read"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    );
    expect(result.output).toMatchObject({
      items: [
        {
          id: "message-1",
          threadId: "thread-1",
          from: "Alex Rivera <alex.rivera@mucker.example>",
          to: "Adam <adam@example.com>",
          subject: "Tuesday sync",
          messageIdHeader: "<abc123@mail.example>",
          snippet: "Tuesday call agenda"
        },
        { id: "message-2", threadId: "thread-2", from: null, subject: null, snippet: "" }
      ]
    });
  });

  it("resolves a name to ranked addresses drawn from prior Gmail correspondence", async () => {
    const queries: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/users/me/messages")) {
        queries.push(url.searchParams.get("q") ?? "");
        return googleJson({ messages: [{ id: "message-1", threadId: "thread-1" }, { id: "message-2", threadId: "thread-2" }] });
      }
      if (url.pathname.endsWith("/messages/message-1")) {
        return googleJson({
          id: "message-1",
          threadId: "thread-1",
          internalDate: "1785000000000",
          snippet: "Older note",
          payload: {
            headers: [
              { name: "From", value: "Alex Rivera <alex.rivera@mucker.example>" },
              { name: "To", value: "Adam <adam@example.com>" },
              { name: "Subject", value: "Intro" }
            ]
          }
        });
      }
      if (url.pathname.endsWith("/messages/message-2")) {
        return googleJson({
          id: "message-2",
          threadId: "thread-2",
          internalDate: "1786000000000",
          snippet: "Newer note",
          payload: {
            headers: [
              { name: "From", value: "Adam <adam@example.com>" },
              { name: "To", value: "\"Rivera, Alex\" <alex.rivera@mucker.example>, Katherine Wu <kwu@mucker.example>" },
              { name: "Subject", value: "Tuesday call" }
            ]
          }
        });
      }
      throw new Error(`Unexpected Google fetch: ${url}`);
    };
    const result = await googleAdapter(fetcher).executeTool(
      "gmail.find_contacts",
      { name: "Alex" },
      {
        connection: {
          ...googleConnection(["gmail.read"]),
          credentials: { accessToken: "google-access-token", providerAccountEmail: "adam@example.com" }
        },
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    );
    // Scoped to the address headers: a bare keyword query would also match
    // every message that merely mentions the name in its body.
    expect(queries[0]).toContain("from:(\"Alex\")");
    expect(queries[0]).toContain("to:(\"Alex\")");
    expect(result.output).toMatchObject({
      scannedMessages: 2,
      items: [{
        email: "alex.rivera@mucker.example",
        occurrences: 2,
        matchedHeaders: ["from", "to"],
        // Ranked to the newer of the two messages it appeared in.
        lastMessageId: "message-2",
        lastSeen: "2026-08-06T07:06:40.000Z",
        lastSubject: "Tuesday call"
      }]
    });
    const contacts = (result.output as { items: Array<{ email: string; displayNames: string[] }> }).items;
    expect(contacts[0]?.displayNames).toEqual(expect.arrayContaining(["Alex Rivera", "Rivera Alex"]));
    // The mailbox owner and an unrelated correspondent are both left out.
    expect(contacts.map((contact) => contact.email)).not.toContain("adam@example.com");
    expect(contacts.map((contact) => contact.email)).not.toContain("kwu@mucker.example");
  });

  it("reports no candidate address rather than guessing when correspondence has none", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/users/me/messages")) return googleJson({ messages: [] });
      throw new Error(`Unexpected Google fetch: ${url}`);
    };
    const result = await googleAdapter(fetcher).executeTool(
      "gmail.find_contacts",
      { name: "Danny" },
      {
        connection: googleConnection(["gmail.read"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    );
    // The remedy has to be in `output`; `summary` never reaches the model.
    expect(result.output).toMatchObject({
      query: "Danny",
      scannedMessages: 0,
      items: [],
      reason: "no_messages_matched"
    });
    expect((result.output as { hint: string }).hint).toContain("differently spelled name");
    expect(result.summary).toContain("No address");
  });

  it("distinguishes correspondence that named nobody from no correspondence at all", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/users/me/messages")) {
        return googleJson({ messages: [{ id: "message-1", threadId: "thread-1" }] });
      }
      return googleJson({
        id: "message-1",
        threadId: "thread-1",
        payload: { headers: [{ name: "From", value: "Priya <priya@example.com>" }] }
      });
    };
    const result = await googleAdapter(fetcher).executeTool(
      "gmail.find_contacts",
      { name: "Danny" },
      {
        connection: googleConnection(["gmail.read"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    );
    expect(result.output).toMatchObject({
      scannedMessages: 1,
      items: [],
      reason: "no_address_matched_name"
    });
  });

  it("caps returned contacts with the same maxResults name the other Google tools use", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/users/me/messages")) {
        return googleJson({ messages: [{ id: "message-1", threadId: "thread-1" }] });
      }
      return googleJson({
        id: "message-1",
        threadId: "thread-1",
        payload: {
          headers: [{
            name: "To",
            value: "Dana One <dana.one@example.com>, Dana Two <dana.two@example.com>"
          }]
        }
      });
    };
    const result = await googleAdapter(fetcher).executeTool(
      "gmail.find_contacts",
      { name: "Dana", maxResults: 1 },
      {
        connection: googleConnection(["gmail.read"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    );
    expect((result.output as { items: unknown[] }).items).toHaveLength(1);
  });

  // Google is the external capability double; no local runtime implements its API.
  it("queries availability directly for unlisted calendars and preserves per-calendar failures", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({ url: requestUrl(input).toString(), method: init?.method ?? "GET", body: JSON.parse(String(init?.body)) });
      return googleJson({ calendars: {
        "adam@example.com": { busy: [{ start: "2026-10-20T10:00:00-07:00", end: "2026-10-20T10:15:00-07:00", summary: "private" }] },
        "alex@example.com": { busy: [] },
        "private@example.com": { errors: [{ domain: "global", reason: "notFound", message: "private provider text" }], busy: [] },
        "refused@example.com": { errors: [{ reason: "forbidden" }], busy: [] },
        "new-error@example.com": { errors: [{ reason: "private unknown reason", message: "private" }] },
      } });
    };
    const result = await googleAdapter(fetcher).executeTool("calendar.query_availability", {
      calendarIds: ["adam@example.com", "alex@example.com", "private@example.com", "refused@example.com", "new-error@example.com", "missing@example.com", "adam@example.com"],
      timeMin: "2026-10-20T10:00:00-07:00", timeMax: "2026-10-20T10:30:00-07:00", timeZone: "America/Los_Angeles",
    }, {
      connection: googleConnection(["calendar.read"]),
      principal: { type: "user", userId: TEST_USER_ID }, signal: neverAborts(),
    });
    expect(requests).toEqual([{
      url: "https://www.googleapis.com/calendar/v3/freeBusy", method: "POST",
      body: { timeMin: "2026-10-20T10:00:00-07:00", timeMax: "2026-10-20T10:30:00-07:00", timeZone: "America/Los_Angeles", items: [
        { id: "adam@example.com" }, { id: "alex@example.com" }, { id: "private@example.com" }, { id: "refused@example.com" }, { id: "new-error@example.com" }, { id: "missing@example.com" },
      ] },
    }]);
    expect(result.output).toEqual({
      timeMin: "2026-10-20T10:00:00-07:00", timeMax: "2026-10-20T10:30:00-07:00", timeZone: "America/Los_Angeles",
      items: [
        { calendarId: "adam@example.com", status: "busy", busy: [{ start: "2026-10-20T10:00:00-07:00", end: "2026-10-20T10:15:00-07:00" }], errors: [] },
        { calendarId: "alex@example.com", status: "free", busy: [], errors: [] },
        { calendarId: "private@example.com", status: "unknown", busy: null, errors: [expect.objectContaining({ reason: "notFound" })] },
        { calendarId: "refused@example.com", status: "unknown", busy: null, errors: [expect.objectContaining({ reason: "forbidden" })] },
        { calendarId: "new-error@example.com", status: "unknown", busy: null, errors: [expect.objectContaining({ reason: "unrecognized_provider_error" })] },
        { calendarId: "missing@example.com", status: "unknown", busy: null, errors: [expect.objectContaining({ reason: "missing_calendar_result" })] },
      ],
    });
  });

  it.each([
    {
      calendar: { errors: [{ reason: "notFound", message: "private provider text" }] },
      reason: "notFound",
      message: "Google could not find this calendar or expose it to the connected account.",
      nextStep: "Verify the calendar ID and its sharing permissions. Keep availability unknown until a query succeeds.",
    },
    {
      calendar: { errors: [{ reason: "forbidden" }] },
      reason: "forbidden",
      message: "The connected account does not have permission to query this calendar's availability.",
      nextStep: "Ask the calendar owner to share free/busy access with the connected account, or use an account that already has access.",
    },
    {
      calendar: { errors: [{ reason: "internalError" }] },
      reason: "internalError",
      message: "Google encountered an internal error while checking this calendar's availability.",
      nextStep: "Retry the availability query. If it continues to fail, check availability directly in Google Calendar.",
    },
    {
      calendar: { errors: [{ reason: "groupTooBig" }] },
      reason: "groupTooBig",
      message: "Google could not expand the requested group because it contains too many members.",
      nextStep: "Query individual calendar IDs or verified email addresses instead of a group address.",
    },
    {
      calendar: { errors: [{ reason: "tooManyCalendarsRequested" }] },
      reason: "tooManyCalendarsRequested",
      message: "Google could not process all calendars included in this request.",
      nextStep: "Split the request into smaller batches of individual calendar IDs and query each batch separately.",
    },
    {
      calendar: { errors: [{ reason: "private unknown reason", message: "private provider text" }] },
      reason: "unrecognized_provider_error",
      message: "Google returned an error that Rally does not recognize, so this calendar's availability is unknown.",
      nextStep: "Retry the availability query. If it continues to fail, check the calendar ID and access directly in Google Calendar.",
    },
    {
      calendar: null,
      reason: "missing_calendar_result",
      message: "Google did not return an availability result for this calendar.",
      nextStep: "Retry using this calendar's ID alone. If no result is returned, verify the ID and sharing permissions directly in Google Calendar.",
    },
    {
      calendar: { busy: [], errors: "private malformed errors" },
      reason: "invalid_errors_field",
      message: "Google returned an unreadable errors field for this calendar, so its availability cannot be determined.",
      nextStep: "Retry the availability query. If the response remains unreadable, report the diagnostic code to Rally support and check availability directly in Google Calendar.",
    },
    {
      calendar: { busy: [{ start: "2026-10-20T18:00:00Z", end: "2026-10-20T17:00:00Z" }] },
      reason: "calendar_availability_invalid:busy.0.end:custom",
      message: "Google returned missing or invalid busy intervals, so this calendar's availability cannot be determined.",
      nextStep: "Retry the availability query. If the response remains invalid, report the diagnostic code to Rally support and check availability directly in Google Calendar.",
    },
  ])("explains availability error $reason and gives a next step", async ({ calendar, reason, message, nextStep }) => {
    const result = await googleAdapter(async () => googleJson({ calendars: { "alex@example.com": calendar } })).executeTool("calendar.query_availability", {
      calendarIds: ["alex@example.com"], timeMin: "2026-10-20T17:00:00Z", timeMax: "2026-10-20T18:00:00Z",
    }, {
      connection: googleConnection(["calendar.read"]), principal: { type: "user", userId: TEST_USER_ID }, signal: neverAborts(),
    });
    expect(result.output).toEqual({
      timeMin: "2026-10-20T17:00:00Z", timeMax: "2026-10-20T18:00:00Z", timeZone: "UTC",
      items: [{ calendarId: "alex@example.com", status: "unknown", busy: null, errors: [{ reason, message, nextStep }] }],
    });
  });

  it("defaults availability to UTC and returns an empty successful busy list as free", async () => {
    const result = await googleAdapter(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        timeMin: "2026-10-20T17:00:00Z", timeMax: "2026-10-20T18:00:00Z", items: [{ id: "alex@example.com" }],
      });
      return googleJson({ calendars: { "alex@example.com": { busy: [], errors: [] } } });
    }).executeTool("calendar.query_availability", {
      calendarIds: ["alex@example.com"], timeMin: "2026-10-20T17:00:00Z", timeMax: "2026-10-20T18:00:00Z",
    }, {
      connection: googleConnection(["calendar.read"]), principal: { type: "user", userId: TEST_USER_ID }, signal: neverAborts(),
    });
    expect(result.output).toEqual({
      timeMin: "2026-10-20T17:00:00Z", timeMax: "2026-10-20T18:00:00Z", timeZone: "UTC",
      items: [{ calendarId: "alex@example.com", status: "free", busy: [], errors: [] }],
    });
  });

  it("names the availability argument Google rejects on a failed request", async () => {
    await expect(googleAdapter(async () => googleJson({ error: {
      code: 400, message: "private provider text", errors: [{ reason: "invalid", locationType: "parameter", location: "timeZone" }],
    } }, 400)).executeTool("calendar.query_availability", {
      calendarIds: ["alex@example.com"], timeMin: "2026-10-20T17:00:00Z", timeMax: "2026-10-20T18:00:00Z", timeZone: "invalid",
    }, {
      connection: googleConnection(["calendar.read"]), principal: { type: "user", userId: TEST_USER_ID }, signal: neverAborts(),
    })).rejects.toMatchObject({
      code: "provider_error", message: "Google API failed (400); it rejected the `timeZone` argument",
      details: { reason: "invalid_parameter", field: "timeZone" },
    });
  });

  it.each([
    [{}, "calendar_availability_invalid:busy:invalid_type"],
    [{ busy: [null] }, "calendar_availability_invalid:busy.0:invalid_type"],
    [{ busy: [{ start: "bad", end: "2026-10-20T18:00:00Z" }] }, "calendar_availability_invalid:busy.0.start:invalid_format:busy.0.end:custom"],
    [{ busy: [{ start: "2026-10-20T18:00:00Z", end: "2026-10-20T17:00:00Z" }] }, "calendar_availability_invalid:busy.0.end:custom"],
    [{ busy: [], errors: "notFound" }, "invalid_errors_field"],
    [{ busy: [], errors: [null] }, "unrecognized_provider_error"],
  ])("reports malformed calendar availability as unknown: %j", async (calendar, reason) => {
    const result = await googleAdapter(async () => googleJson({ calendars: { "alex@example.com": calendar } })).executeTool("calendar.query_availability", {
      calendarIds: ["alex@example.com"], timeMin: "2026-10-20T17:00:00Z", timeMax: "2026-10-20T18:00:00Z",
    }, {
      connection: googleConnection(["calendar.read"]), principal: { type: "user", userId: TEST_USER_ID }, signal: neverAborts(),
    });
    expect(result.output).toMatchObject({
      timeMin: "2026-10-20T17:00:00Z", timeMax: "2026-10-20T18:00:00Z", timeZone: "UTC",
      items: [{ calendarId: "alex@example.com", status: "unknown", busy: null, errors: [{ reason }] }],
    });
  });

  it.each([
    { calendarIds: [] },
    { calendarIds: Array.from({ length: 51 }, (_, i) => `calendar${i}@example.com`) },
    { timeMin: "2026-10-20" },
    { timeMax: "2026-10-20T16:00:00Z" },
    { invented: true },
  ])("rejects invalid availability arguments before calling Google: %j", async (overrides) => {
    let calls = 0;
    const adapter = googleAdapter(async () => { calls++; return googleJson({}); });
    await expect(adapter.executeTool("calendar.query_availability", {
      calendarIds: ["alex@example.com"], timeMin: "2026-10-20T17:00:00Z", timeMax: "2026-10-20T18:00:00Z", ...overrides,
    }, {
      connection: googleConnection(["calendar.read"]), principal: { type: "user", userId: TEST_USER_ID }, signal: neverAborts(),
    })).rejects.toBeInstanceOf(z.ZodError);
    expect(calls).toBe(0);
  });

  it("requires calendar read permission to query availability", async () => {
    let calls = 0;
    await expect(googleAdapter(async () => { calls++; return googleJson({}); }).executeTool("calendar.query_availability", {
      calendarIds: ["alex@example.com"], timeMin: "2026-10-20T17:00:00Z", timeMax: "2026-10-20T18:00:00Z",
    }, {
      connection: googleConnection(["gmail.read"]), principal: { type: "user", userId: TEST_USER_ID }, signal: neverAborts(),
    })).rejects.toMatchObject({ code: "unsupported_capability" });
    expect(calls).toBe(0);
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
      signal: neverAborts()
    };

    const calendars = await adapter.executeTool("calendar.list_calendars", {}, {
      ...context,
      connection: googleConnection(["calendar.read"])
    });
    expect(calendars.output).toMatchObject({
      items: [{ id: "primary", primary: true }, { id: "team@example.com", accessRole: "writer" }]
    });

    const created = await adapter.executeTool("calendar.create_event", {
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

    const updated = await adapter.executeTool("calendar.update_event", {
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

  it.each([
    { addAttendeeEmails: ["new@example.com"] },
    { addAttendeeEmails: ["new@example.com"], removeAttendeeEmails: [], replaceAllAttendeeEmails: [] }
  ])("adds an attendee without dropping the ones the event already has: %j", async (attendeeChange) => {
    const requests: Array<{ method: string; url: URL; body: Record<string, unknown> }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = requestUrl(input);
      const method = init?.method ?? "GET";
      requests.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} });
      if (method === "GET") {
        return googleJson({
          attendees: [{ email: "existing@example.com" }, { email: "Second@example.com" }]
        });
      }
      return googleJson({ id: "event-existing", summary: "Tuesday call" });
    };
    await googleAdapter(fetcher).executeTool(
      "calendar.update_event",
      { eventId: "event-existing", ...attendeeChange },
      {
        connection: googleConnection(["calendar.read", "calendar.write"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    );
    const patch = requests.find((request) => request.method === "PATCH");
    expect(patch?.body).toMatchObject({
      attendees: [
        { email: "existing@example.com" },
        { email: "Second@example.com" },
        { email: "new@example.com" }
      ]
    });
    expect(patch?.url.searchParams.get("sendUpdates")).toBe("all");
  });

  it("keeps a retained guest's state when the whole list is replaced", async () => {
    let patched: Record<string, unknown> = {};
    const fetcher: typeof fetch = async (input, init) => {
      if ((init?.method ?? "GET") === "GET") {
        return googleJson({
          attendees: [
            { email: "kept@example.com", responseStatus: "accepted" },
            { email: "dropped@example.com", responseStatus: "accepted" }
          ]
        });
      }
      patched = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return googleJson({ id: "event-existing" });
    };
    await googleAdapter(fetcher).executeTool(
      "calendar.update_event",
      {
        eventId: "event-existing",
        addAttendeeEmails: [],
        removeAttendeeEmails: [],
        replaceAllAttendeeEmails: ["kept@example.com", "added@example.com"]
      },
      {
        connection: googleConnection(["calendar.read", "calendar.write"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    );
    expect(patched.attendees).toEqual([
      { email: "kept@example.com", responseStatus: "accepted" },
      { email: "added@example.com" }
    ]);
  });

  it("removes an attendee when the unused attendee changes are empty", async () => {
    let patched: Record<string, unknown> = {};
    const fetcher: typeof fetch = async (input, init) => {
      if ((init?.method ?? "GET") === "GET") {
        return googleJson({ attendees: [{ email: "kept@example.com" }, { email: "removed@example.com" }] });
      }
      patched = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return googleJson({ id: "event-existing" });
    };
    await googleAdapter(fetcher).executeTool(
      "calendar.update_event",
      {
        eventId: "event-existing",
        addAttendeeEmails: [],
        removeAttendeeEmails: ["removed@example.com"],
        replaceAllAttendeeEmails: []
      },
      {
        connection: googleConnection(["calendar.read", "calendar.write"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    );
    expect(patched.attendees).toEqual([{ email: "kept@example.com" }]);
  });

  it("rejects an update with only empty attendee changes before contacting Google", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(googleAdapter(fetcher).executeTool(
      "calendar.update_event",
      { eventId: "event-existing", addAttendeeEmails: [], removeAttendeeEmails: [], replaceAllAttendeeEmails: [] },
      {
        connection: googleConnection(["calendar.write"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    )).rejects.toThrow(/Choose at least one event field to update/u);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects nonempty replacement and relative attendee changes together", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(googleAdapter(fetcher).executeTool(
      "calendar.update_event",
      { eventId: "event-existing", addAttendeeEmails: ["new@example.com"], replaceAllAttendeeEmails: ["kept@example.com"] },
      {
        connection: googleConnection(["calendar.write"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    )).rejects.toThrow(/Use replaceAllAttendeeEmails alone/u);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not mail the guest list when the requested change leaves it identical", async () => {
    const requests: URL[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push(requestUrl(input));
      if ((init?.method ?? "GET") === "GET") return googleJson({ attendees: [{ email: "only@example.com" }] });
      return googleJson({ id: "event-existing" });
    };
    await googleAdapter(fetcher).executeTool(
      "calendar.update_event",
      { eventId: "event-existing", removeAttendeeEmails: ["never-invited@example.com"] },
      {
        connection: googleConnection(["calendar.read", "calendar.write"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    );
    expect(requests.at(-1)?.searchParams.get("sendUpdates")).toBeNull();
  });

  it("surfaces a revoked grant during hydration instead of reporting an empty mailbox", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.hostname === "oauth2.googleapis.com") {
        return googleJson({ error: "invalid_grant", error_description: "revoked" }, 400);
      }
      if (url.pathname.endsWith("/users/me/messages")) {
        return googleJson({ messages: [{ id: "message-1", threadId: "thread-1" }] });
      }
      return googleJson({ error: { code: 401 } }, 401);
    };
    await expect(googleAdapter(fetcher).executeTool(
      "gmail.find_contacts",
      { name: "Dana" },
      {
        connection: {
          ...googleConnection(["gmail.read"]),
          credentials: { accessToken: "expired", refreshToken: "revoked" }
        },
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    )).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("abandons a cancelled call before spending the refresh token on it", async () => {
    let refreshAttempts = 0;
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.hostname === "oauth2.googleapis.com") {
        refreshAttempts += 1;
        return googleJson({ access_token: "fresh", expires_in: 3600 });
      }
      return googleJson({ error: { code: 401 } }, 401);
    };
    await expect(googleAdapter(fetcher).executeTool(
      "gmail.find_contacts",
      { name: "Dana" },
      {
        connection: {
          ...googleConnection(["gmail.read"]),
          credentials: { accessToken: "expired", refreshToken: "still-valid" }
        },
        principal: { type: "user", userId: TEST_USER_ID },
        signal: alreadyAborted()
      }
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(refreshAttempts).toBe(0);
  });

  it("keeps Spam and Trash out of a contact search", async () => {
    let query = "";
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/users/me/messages")) {
        query = url.searchParams.get("q") ?? "";
        return googleJson({ messages: [] });
      }
      return googleJson({});
    };
    await googleAdapter(fetcher).executeTool(
      "gmail.find_contacts",
      { name: "Dana" },
      {
        connection: googleConnection(["gmail.read"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    );
    // One spoofed message in Spam would otherwise become a sourced address.
    expect(query).toContain("-in:spam");
    expect(query).toContain("-in:trash");
    expect(query).not.toContain("in:anywhere");
  });

  it("finds a correspondent buried late in a large recipient list", async () => {
    const many = [
      ...Array.from({ length: 60 }, (_, index) => `filler${index}@a-fairly-long-domain.example.com`),
      "Dana Whitfield <dana.whitfield@example.com>"
    ].join(", ");
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/users/me/messages")) {
        return googleJson({ messages: [{ id: "message-1", threadId: "thread-1" }] });
      }
      return googleJson({
        id: "message-1",
        threadId: "thread-1",
        payload: { headers: [{ name: "Cc", value: many }] }
      });
    };
    const result = await googleAdapter(fetcher).executeTool(
      "gmail.find_contacts",
      { name: "Dana" },
      {
        connection: googleConnection(["gmail.read"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    );
    expect((result.output as { items: Array<{ email: string }> }).items.map((item) => item.email))
      .toEqual(["dana.whitfield@example.com"]);
  });

  it("preserves each guest's RSVP state and role when one attendee is added", async () => {
    let patched: Record<string, unknown> = {};
    const fetcher: typeof fetch = async (input, init) => {
      if ((init?.method ?? "GET") === "GET") {
        return googleJson({
          attendees: [
            { email: "yes@example.com", responseStatus: "accepted", displayName: "Yes Person" },
            { email: "room@example.com", resource: true, responseStatus: "accepted" },
            { email: "maybe@example.com", optional: true, responseStatus: "tentative" }
          ]
        });
      }
      patched = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return googleJson({ id: "event-existing" });
    };
    await googleAdapter(fetcher).executeTool(
      "calendar.update_event",
      { eventId: "event-existing", addAttendeeEmails: ["new@example.com"] },
      {
        connection: googleConnection(["calendar.read", "calendar.write"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    );
    expect(patched.attendees).toEqual([
      { email: "yes@example.com", responseStatus: "accepted", displayName: "Yes Person" },
      { email: "room@example.com", resource: true, responseStatus: "accepted" },
      { email: "maybe@example.com", optional: true, responseStatus: "tentative" },
      { email: "new@example.com" }
    ]);
  });

  it("does not mail the guest list for an attendee change that changes nobody", async () => {
    const methods: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      methods.push(init?.method ?? "GET");
      return googleJson({ id: "event-existing", summary: "Renamed" });
    };
    const requests: URL[] = [];
    const recording: typeof fetch = async (input, init) => {
      requests.push(requestUrl(input));
      return fetcher(input, init);
    };
    await googleAdapter(recording).executeTool(
      "calendar.update_event",
      { eventId: "event-existing", summary: "Renamed", addAttendeeEmails: [], removeAttendeeEmails: [], replaceAllAttendeeEmails: [] },
      {
        connection: googleConnection(["calendar.read", "calendar.write"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    );
    expect(methods).toEqual(["PATCH"]);
    expect(requests[0]?.searchParams.get("sendUpdates")).toBeNull();
  });

  it("keeps the other hits when one message cannot be hydrated", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/users/me/messages")) {
        return googleJson({ messages: [{ id: "message-1", threadId: "thread-1" }, { id: "message-2", threadId: "thread-2" }] });
      }
      if (url.pathname.endsWith("/messages/message-2")) return googleJson({ error: { code: 429 } }, 429);
      return googleJson({
        id: "message-1",
        threadId: "thread-1",
        payload: { headers: [{ name: "Subject", value: "Survived" }] }
      });
    };
    const result = await googleAdapter(fetcher).executeTool(
      "gmail.search",
      { query: "is:unread" },
      {
        connection: googleConnection(["gmail.read"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    );
    expect(result.output).toMatchObject({
      items: [
        { id: "message-1", subject: "Survived" },
        { id: "message-2", subject: null, headersUnavailable: true }
      ]
    });
  });

  it("reports a hydration failure rather than a thin row once the search is cancelled", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/users/me/messages")) {
        return googleJson({ messages: [{ id: "message-1", threadId: "thread-1" }, { id: "message-2", threadId: "thread-2" }] });
      }
      if (url.pathname.endsWith("/messages/message-2")) return googleJson({ error: { code: 429 } }, 429);
      return googleJson({
        id: "message-1",
        threadId: "thread-1",
        payload: { headers: [{ name: "Subject", value: "Survived" }] }
      });
    };
    await expect(googleAdapter(fetcher).executeTool(
      "gmail.search",
      { query: "is:unread" },
      {
        connection: googleConnection(["gmail.read"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: alreadyAborted()
      }
    )).rejects.toMatchObject({ code: "provider_error" });
  });

  it("never leaves a partial address behind when truncating a long recipient list", async () => {
    const many = Array.from({ length: 40 }, (_, index) => `person${index}@a-fairly-long-domain.example.com`).join(", ");
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/users/me/messages")) {
        return googleJson({ messages: [{ id: "message-1", threadId: "thread-1" }] });
      }
      return googleJson({
        id: "message-1",
        threadId: "thread-1",
        payload: { headers: [{ name: "To", value: many }] }
      });
    };
    const result = await googleAdapter(fetcher).executeTool(
      "gmail.find_contacts",
      { name: "person" },
      {
        connection: googleConnection(["gmail.read"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    );
    // Every returned address has to be one that was actually in the header; a
    // cut inside a domain would yield a plausible address nobody has.
    const returned = (result.output as { items: Array<{ email: string }> }).items.map((item) => item.email);
    expect(returned.length).toBeGreaterThan(0);
    for (const email of returned) expect(many.toLowerCase()).toContain(email);
  });

  it("refuses to resolve a calendar name without the read capability that lists calendars", async () => {
    const fetcher: typeof fetch = async () => googleJson({ items: [] });
    await expect(googleAdapter(fetcher).executeTool(
      "calendar.update_event",
      { calendarId: "Work", eventId: "event-1", summary: "Renamed" },
      {
        connection: googleConnection(["calendar.write"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    )).rejects.toMatchObject({
      code: "unsupported_capability",
      details: { reason: "calendar_name_needs_read_capability" }
    });
  });

  it("refuses a relative attendee change when the guest list came back incomplete", async () => {
    const requests: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push(init?.method ?? "GET");
      if ((init?.method ?? "GET") === "GET") {
        // Calendar truncates a large guest list and says so. Patching the
        // prefix back would delete everyone past the cut.
        return googleJson({ attendees: [{ email: "kept@example.com" }], attendeesOmitted: true });
      }
      return googleJson({ id: "event-existing" });
    };
    await expect(googleAdapter(fetcher).executeTool(
      "calendar.update_event",
      { eventId: "event-existing", addAttendeeEmails: ["new@example.com"] },
      {
        connection: googleConnection(["calendar.read", "calendar.write"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    )).rejects.toMatchObject({
      code: "invalid_payload",
      message: expect.stringContaining("To clear every guest when the list is incomplete, use Google Calendar"),
      details: { reason: "attendee_snapshot_incomplete" }
    });
    expect(requests).not.toContain("PATCH");
  });

  it("reads the whole guest list rather than a capped prefix of it", async () => {
    let attendeeQuery: string | null = null;
    const fetcher: typeof fetch = async (input, init) => {
      const url = requestUrl(input);
      if ((init?.method ?? "GET") === "GET") {
        attendeeQuery = url.searchParams.get("maxAttendees");
        return googleJson({ attendees: [{ email: "existing@example.com" }] });
      }
      return googleJson({ id: "event-existing" });
    };
    await googleAdapter(fetcher).executeTool(
      "calendar.update_event",
      { eventId: "event-existing", addAttendeeEmails: ["new@example.com"] },
      {
        connection: googleConnection(["calendar.read", "calendar.write"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    );
    expect(attendeeQuery).toBeNull();
  });

  it("matches a non-Latin name instead of returning every address in the thread", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/users/me/messages")) {
        return googleJson({ messages: [{ id: "message-1", threadId: "thread-1" }] });
      }
      return googleJson({
        id: "message-1",
        threadId: "thread-1",
        payload: {
          headers: [
            { name: "From", value: "张伟 <wei.zhang@example.com>" },
            { name: "To", value: "Unrelated Person <unrelated@example.com>" }
          ]
        }
      });
    };
    const context = {
      connection: googleConnection(["gmail.read"]),
      principal: { type: "user" as const, userId: TEST_USER_ID },
      signal: neverAborts()
    };
    const matched = await googleAdapter(fetcher).executeTool("gmail.find_contacts", { name: "张伟" }, context);
    expect((matched.output as { items: Array<{ email: string }> }).items.map((item) => item.email))
      .toEqual(["wei.zhang@example.com"]);

    // A name that yields no usable token returns nobody rather than everybody.
    const degenerate = await googleAdapter(fetcher).executeTool("gmail.find_contacts", { name: "!!" }, context);
    expect(degenerate.output).toMatchObject({ items: [], reason: "no_address_matched_name" });
  });

  it("refuses the create-shaped attendee parameter on an update instead of wiping the guest list", async () => {
    const fetcher: typeof fetch = async () => googleJson({ id: "event-existing" });
    await expect(googleAdapter(fetcher).executeTool(
      "calendar.update_event",
      { eventId: "event-existing", attendeeEmails: ["new@example.com"] },
      {
        connection: googleConnection(["calendar.read", "calendar.write"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    )).rejects.toThrow(/attendeeEmails/u);
  });

  it("rejects an undeclared argument rather than silently dropping it", async () => {
    const fetcher: typeof fetch = async () => googleJson({ messages: [] });
    await expect(googleAdapter(fetcher).executeTool(
      "gmail.search",
      { query: "is:unread", limit: 5 },
      {
        connection: googleConnection(["gmail.read"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    )).rejects.toThrow(/limit/u);
  });

  it("resolves a calendar by name and refuses an ambiguous one by naming the candidates", async () => {
    const calendarList = {
      items: [
        { id: "work@example.com", summary: "Work" },
        { id: "personal@example.com", summary: "Personal" }
      ]
    };
    const byName: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/users/me/calendarList")) return googleJson(calendarList);
      return googleJson({ items: [] });
    };
    const context = {
      connection: googleConnection(["calendar.read"]),
      principal: { type: "user" as const, userId: TEST_USER_ID },
      signal: neverAborts()
    };
    const listed = await googleAdapter(byName).executeTool(
      "calendar.list_events",
      { calendarId: "Work", timeMin: "2026-08-01T00:00:00Z", timeMax: "2026-08-02T00:00:00Z" },
      context
    );
    expect(listed.summary).toContain("0 calendar events");

    const ambiguous: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/users/me/calendarList")) {
        return googleJson({ items: [{ id: "a@example.com", summary: "Work" }, { id: "b@example.com", summary: "work" }] });
      }
      return googleJson({ items: [] });
    };
    await expect(googleAdapter(ambiguous).executeTool(
      "calendar.list_events",
      { calendarId: "Work", timeMin: "2026-08-01T00:00:00Z", timeMax: "2026-08-02T00:00:00Z" },
      context
    )).rejects.toMatchObject({
      code: "invalid_payload",
      details: { reason: "ambiguous_calendar_name" }
    });
  });

  it("names both causes of a Gmail 404 so the two readers cannot bounce a caller between them", async () => {
    const fetcher: typeof fetch = async () => googleJson({ error: { code: 404 } }, 404);
    const context = {
      connection: googleConnection(["calendar.read", "calendar.write", "gmail.read"]),
      principal: { type: "user" as const, userId: TEST_USER_ID },
      signal: neverAborts()
    };
    await expect(googleAdapter(fetcher).executeTool(
      "gmail.read_message",
      { messageId: "thread-1" },
      context
    )).rejects.toMatchObject({
      code: "invalid_payload",
      details: { reason: "message_or_thread_not_found", field: "messageId" }
    });
    // Deletion is named first and the other reader is not presented as the fix,
    // or a caller holding a deleted id ping-pongs until the iteration ceiling.
    await expect(googleAdapter(fetcher).executeTool("gmail.read_message", { messageId: "gone" }, context))
      .rejects.toThrow(/Either it was deleted/u);
    await expect(googleAdapter(async () => googleJson({ items: [] })).executeTool(
      "calendar.read_event",
      { calendarId: "primary", eventId: "team@example.com" },
      context
    )).rejects.toMatchObject({ details: { reason: "wrong_id_family", expected: "eventId" } });
  });

  // Gmail itself cannot run in this suite. Double only its HTTP boundary and
  // inspect the actual request bodies and MIME produced by the adapter.
  it.each(["gmail.create_draft", "gmail.send"])("%s resolves a reply from one message and preserves explicit recipients", async (name) => {
    const requests: Array<{ url: URL; method: string; body: Record<string, unknown> }> = [];
    const isDraft = name === "gmail.create_draft";
    const fetcher: typeof fetch = async (input, init) => {
      const url = requestUrl(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} });
      if (method === "GET") return googleJson({
        threadId: "thread-original",
        payload: { headers: [
          { name: "subject", value: "Design review" },
          { name: "message-id", value: "<original@example.com>" },
          { name: "References", value: "<earlier@example.com>\r\n <original@example.com> invalid-token" },
          { name: "To", value: "other@example.com" },
          { name: "Cc", value: "unselected@example.com" },
        ] },
      });
      return googleJson(isDraft
        ? { id: "draft-1", message: { id: "message-created", threadId: "thread-original" } }
        : { id: "message-created", threadId: "thread-original" });
    };
    const result = await googleAdapter(fetcher).executeTool(name, {
      message: {
        kind: "reply", messageId: "message-original", to: ["recipient@example.com"],
        cc: ["chosen@example.com"], body: "Looks good.",
      },
    }, {
      connection: googleConnection([isDraft ? "gmail.draft" : "gmail.send", "gmail.read"]),
      principal: { type: "user", userId: TEST_USER_ID },
      signal: neverAborts(),
    });
    expect(requests.map(({ url, method }) => [method, url.pathname])).toEqual([
      ["GET", "/gmail/v1/users/me/messages/message-original"],
      ["POST", `/gmail/v1/users/me/${isDraft ? "drafts" : "messages/send"}`],
    ]);
    expect(requests[0]?.url.searchParams.get("format")).toBe("metadata");
    expect(requests[0]?.url.searchParams.getAll("metadataHeaders")).toEqual(["Subject", "Message-ID", "References"]);
    const posted = requests[1]?.body ?? {};
    const message = isDraft ? posted.message as Record<string, unknown> : posted;
    expect(message.threadId).toBe("thread-original");
    const mime = atob(String(message.raw).replace(/-/gu, "+").replace(/_/gu, "/"));
    expect(mime).toBe([
      "To: recipient@example.com", "Cc: chosen@example.com", "Subject: Design review",
      "In-Reply-To: <original@example.com>", "References: <earlier@example.com> <original@example.com>",
      "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: 8bit",
      "", "Looks good.",
    ].join("\r\n"));
    expect(result.providerOperationId).toBe(isDraft ? "draft-1" : "message-created");
    expect(result.output).toMatchObject({
      id: isDraft ? "draft-1" : "message-created",
      message: { id: "message-created", threadId: "thread-original" },
      webUrl: "https://mail.google.com/mail/u/0/#all/thread-original",
    });
  });

  it.each(["gmail.create_draft", "gmail.send"])("%s starts a new conversation without reading or adding reply headers", async (name) => {
    const requests: Array<{ url: URL; method: string; body: Record<string, unknown> }> = [];
    const isDraft = name === "gmail.create_draft";
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({ url: requestUrl(input), method: init?.method ?? "GET", body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return googleJson(isDraft
        ? { id: "draft-1", message: { id: "message-sent", threadId: "thread-sent" } }
        : { id: "message-sent", threadId: "thread-sent" });
    };
    const result = await googleAdapter(fetcher).executeTool(name, {
      message: { kind: "new", to: ["recipient@example.com"], cc: null, subject: "Shipped", body: "Done." },
    }, {
      connection: googleConnection([isDraft ? "gmail.draft" : "gmail.send"]),
      principal: { type: "user", userId: TEST_USER_ID },
      signal: neverAborts(),
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url.pathname).toBe(`/gmail/v1/users/me/${isDraft ? "drafts" : "messages/send"}`);
    const posted = requests[0]?.body ?? {};
    const message = isDraft ? posted.message as Record<string, unknown> : posted;
    expect(Object.keys(message)).toEqual(["raw"]);
    expect(atob(String(message.raw).replace(/-/gu, "+").replace(/_/gu, "/"))).toBe([
      "To: recipient@example.com", "Subject: Shipped", "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: 8bit", "", "Done.",
    ].join("\r\n"));
    expect(result.output).toMatchObject({
      message: { id: "message-sent", threadId: "thread-sent" },
      webUrl: "https://mail.google.com/mail/u/0/#all/thread-sent",
    });
  });

  it.each(["gmail.create_draft", "gmail.send"])("%s rejects undeclared write options before any provider request", async (name) => {
    let requests = 0;
    const adapter = googleAdapter(async () => {
      requests++;
      return googleJson({ id: "unexpected-write" });
    });
    const context = {
      connection: googleConnection([name === "gmail.send" ? "gmail.send" : "gmail.draft", "gmail.read"]),
      principal: { type: "user" as const, userId: TEST_USER_ID }, signal: neverAborts(),
    };
    for (const message of [
      { kind: "new", to: ["recipient@example.com"], subject: "Hello", body: "Body." },
      { kind: "reply", to: ["recipient@example.com"], messageId: "message-original", body: "Body." },
    ]) {
      for (const extra of [{ preview: true }, { threadId: ".", inReplyTo: ".", references: [] }]) {
        await expect(adapter.executeTool(name, { message, ...extra }, context)).rejects.toThrow();
        await expect(adapter.executeTool(name, { message: { ...message, ...extra } }, context)).rejects.toThrow();
      }
    }
    expect(requests).toBe(0);
  });

  it.each([
    { label: "long ASCII", subject: "a".repeat(998) },
    { label: "long accented text", subject: "é".repeat(400) },
    { label: "multibyte chunk boundaries", subject: `${"a".repeat(38)}😀${"€".repeat(15)}😀` },
    { label: "original whitespace", subject: " A  subject\twith whitespace ".repeat(8) },
  ])("folds a $label Subject into independently decodable encoded words", ({ subject }) => {
    const mime = __testing.serializeEmail({ to: ["recipient@example.com"], cc: [], subject, body: "Body.", references: [] });
    const subjectHeader = mime.match(/^Subject:[^\r\n]*(?:\r\n[ \t][^\r\n]*)*/mu)?.[0];
    expect(subjectHeader).toBeDefined();
    expect(subjectHeader!.split("\r\n").every((line) => Buffer.byteLength(line, "utf8") <= 76)).toBe(true);
    const words = [...subjectHeader!.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/gu)];
    expect(words.length).toBeGreaterThan(1);
    expect(words.every(([word]) => word.length <= 75)).toBe(true);
    // Decode each word independently: slicing the UTF-8 bytes or a surrogate
    // pair across words must fail even if concatenating all payloads would work.
    const decoded = words.map(([, payload]) => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(payload!, "base64"))).join("");
    expect(decoded).toBe(subject);
    expect(mime.endsWith("\r\n\r\nBody.")).toBe(true);
  });

  it("keeps short Unicode subjects readable and neutralizes subject header injection", () => {
    const mime = __testing.serializeEmail({
      to: ["recipient@example.com"], cc: [], subject: "Café\r\nBcc: hidden@example.com", body: "Body.", references: [],
    });
    expect(mime).toContain("Subject: =?UTF-8?B?Q2Fmw6kgIEJjYzogaGlkZGVuQGV4YW1wbGUuY29t?=\r\n");
    expect(mime).not.toContain("\r\nBcc:");
  });

  it.each(["gmail.create_draft", "gmail.send"])("%s folds an inherited reply Subject beyond the new-message input limit", async (name) => {
    const subject = "Réunion 😀 ".repeat(200);
    const writes: Record<string, unknown>[] = [];
    const isDraft = name === "gmail.create_draft";
    const fetcher: typeof fetch = async (_input, init) => {
      if (init?.method !== "POST") return googleJson({
        threadId: "thread-original",
        payload: { headers: [{ name: "Subject", value: subject }, { name: "Message-ID", value: "<parent@example.com>" }] },
      });
      writes.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return googleJson(isDraft
        ? { id: "draft-1", message: { id: "reply", threadId: "thread-original" } }
        : { id: "reply", threadId: "thread-original" });
    };
    await googleAdapter(fetcher).executeTool(name, {
      message: { kind: "reply", messageId: "message-original", to: ["recipient@example.com"], body: "Reply body." },
    }, {
      connection: googleConnection([isDraft ? "gmail.draft" : "gmail.send", "gmail.read"]),
      principal: { type: "user", userId: TEST_USER_ID }, signal: neverAborts(),
    });
    expect(writes).toHaveLength(1);
    const message = isDraft ? writes[0]?.message as Record<string, unknown> : writes[0];
    const mime = Buffer.from(String(message?.raw), "base64url").toString("utf8");
    const subjectHeader = mime.match(/^Subject:[^\r\n]*(?:\r\n[ \t][^\r\n]*)*/mu)?.[0];
    expect(subjectHeader!.split("\r\n").every((line) => line.length <= 76)).toBe(true);
    expect([...subjectHeader!.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/gu)]
      .map(([, payload]) => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(payload!, "base64"))).join(""))
      .toBe(subject);
    expect(message?.threadId).toBe("thread-original");
    expect(mime).toContain("In-Reply-To: <parent@example.com>\r\n");
    expect(mime.endsWith("\r\n\r\nReply body.")).toBe(true);
  });

  it.each(["gmail.create_draft", "gmail.send"])("%s folds a long References chain without losing or duplicating ancestors", async (name) => {
    const ancestors = Array.from({ length: 2_000 }, (_, index) => `<message-${index}@example.com>`);
    const parent = "<parent@example.com>";
    const oversizedAncestor = `<${"é".repeat(492)}@example.com>`; // 998 UTF-8 bytes, before continuation whitespace.
    const writes: Record<string, unknown>[] = [];
    const isDraft = name === "gmail.create_draft";
    const fetcher: typeof fetch = async (_input, init) => {
      if (init?.method !== "POST") return googleJson({
        threadId: "thread-original",
        payload: { headers: [
          { name: "Subject", value: "Long conversation" },
          { name: "Message-ID", value: parent },
          { name: "References", value: [parent, ...ancestors, ...ancestors, oversizedAncestor, "invalid-token"].join("\r\n ") },
        ] },
      });
      writes.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return googleJson(isDraft
        ? { id: "draft-1", message: { id: "reply", threadId: "thread-original" } }
        : { id: "reply", threadId: "thread-original" });
    };
    await googleAdapter(fetcher).executeTool(name, {
      message: { kind: "reply", messageId: "message-original", to: ["recipient@example.com"], body: "Reply body." },
    }, {
      connection: googleConnection([isDraft ? "gmail.draft" : "gmail.send", "gmail.read"]),
      principal: { type: "user", userId: TEST_USER_ID },
      signal: neverAborts(),
    });
    expect(writes).toHaveLength(1);
    const message = isDraft ? writes[0]?.message as Record<string, unknown> : writes[0];
    const mime = Buffer.from(String(message?.raw), "base64url").toString("utf8");
    const [header, body] = mime.split("\r\n\r\n");
    const lines = (header ?? "").split("\r\n");
    // Each of these IDs fits under the recommended line length. This also
    // proves the hard 998-byte limit, without a timing assertion about CPU.
    expect(Math.max(...lines.map((line) => Buffer.byteLength(line, "utf8")))).toBeLessThanOrEqual(78);
    const unfolded = (header ?? "").replace(/\r\n(?=[ \t])/gu, "").split("\r\n");
    expect(unfolded.find((line) => line.startsWith("References:")))
      .toBe(`References: ${ancestors.join(" ")} ${parent}`);
    expect(unfolded.find((line) => line.startsWith("In-Reply-To:"))).toBe(`In-Reply-To: ${parent}`);
    expect(body).toBe("Reply body.");
    expect(message?.threadId).toBe("thread-original");
  });

  it.each([
    { label: "ASCII", parent: `<${"a".repeat(983)}@example.com>` },
    { label: "UTF-8", parent: `<${"é".repeat(491)}a@example.com>` },
  ])("folds a $label parent Message-ID at the 998-byte physical-line boundary", async ({ parent }) => {
    const writes: Record<string, unknown>[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      if (init?.method !== "POST") return googleJson({
        threadId: "thread-original",
        payload: { headers: [{ name: "Subject", value: "Boundary" }, { name: "Message-ID", value: parent }] },
      });
      writes.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return googleJson({ id: "reply", threadId: "thread-original" });
    };
    await googleAdapter(fetcher).executeTool("gmail.send", {
      message: { kind: "reply", messageId: "message-original", to: ["recipient@example.com"], body: "Reply body." },
    }, {
      connection: googleConnection(["gmail.send", "gmail.read"]),
      principal: { type: "user", userId: TEST_USER_ID },
      signal: neverAborts(),
    });
    expect(writes).toHaveLength(1);
    const mime = Buffer.from(String(writes[0]?.raw), "base64url").toString("utf8");
    expect(mime).toContain(`In-Reply-To:\r\n ${parent}\r\nReferences:\r\n ${parent}\r\n`);
    const lines = (mime.split("\r\n\r\n")[0] ?? "").split("\r\n");
    expect(Math.max(...lines.map((line) => Buffer.byteLength(line, "utf8")))).toBe(998);
  });

  it.each(["gmail.create_draft", "gmail.send"])("%s refuses a reply without read permission before contacting Gmail", async (name) => {
    const requests: string[] = [];
    const adapter = googleAdapter(async (input) => {
      requests.push(requestUrl(input).pathname);
      return googleJson({});
    });
    await expect(adapter.executeTool(name, {
      message: { kind: "reply", messageId: "message-original", to: ["recipient@example.com"], body: "Hello." },
    }, {
      connection: googleConnection([name === "gmail.send" ? "gmail.send" : "gmail.draft"]),
      principal: { type: "user", userId: TEST_USER_ID },
      signal: neverAborts(),
    })).rejects.toMatchObject({ code: "unsupported_capability" });
    expect(requests).toEqual([]);
  });

  it.each([
    { label: "missing message", status: 404, payload: {}, reason: "message_or_thread_not_found" },
    { label: "malformed message id", status: 400, payload: {}, reason: "message_or_thread_not_found" },
    { label: "missing thread", status: 200, payload: { payload: { headers: [{ name: "Message-ID", value: "<parent@example.com>" }] } }, reason: "reply_headers_unavailable" },
    { label: "missing Message-ID", status: 200, payload: { threadId: "thread-original" }, reason: "reply_headers_unavailable" },
    { label: "invalid Message-ID", status: 200, payload: { threadId: "thread-original", payload: { headers: [{ name: "Message-ID", value: "." }] } }, reason: "reply_headers_unavailable" },
    { label: "oversized ASCII Message-ID", status: 200, payload: { threadId: "thread-original", payload: { headers: [{ name: "Message-ID", value: `<${"a".repeat(984)}@example.com>` }] } }, reason: "reply_headers_unavailable" },
    { label: "oversized UTF-8 Message-ID", status: 200, payload: { threadId: "thread-original", payload: { headers: [{ name: "Message-ID", value: `<${"é".repeat(492)}@example.com>` }] } }, reason: "reply_headers_unavailable" },
  ])("refuses a reply with $label before any Gmail write", async ({ status, payload, reason }) => {
    const methods: string[] = [];
    const adapter = googleAdapter(async (_input, init) => {
      methods.push(init?.method ?? "GET");
      return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
    });
    await expect(adapter.executeTool("gmail.send", {
      message: { kind: "reply", messageId: "message-original", to: ["recipient@example.com"], body: "Hello." },
    }, {
      connection: googleConnection(["gmail.send", "gmail.read"]),
      principal: { type: "user", userId: TEST_USER_ID },
      signal: neverAborts(),
    })).rejects.toMatchObject({ code: "invalid_payload", details: { reason, field: "message.messageId" } });
    expect(methods).toEqual(["GET"]);
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
      if (url.hostname === "www.googleapis.com" && url.pathname.startsWith("/drive/v3/files/")) {
        return googleJson({
          id: url.pathname.split("/").at(-1),
          isAppAuthorized: true,
          capabilities: { canEdit: true }
        });
      }
      throw new Error(`Unexpected Google Workspace fetch: ${url}`);
    };
    const adapter = googleAdapter(fetcher);
    const context = {
      connection: googleConnection(["docs.read", "docs.write", "sheets.read", "sheets.write"]),
      principal: { type: "user" as const, userId: TEST_USER_ID },
      signal: neverAborts()
    };

    const document = await adapter.executeTool("docs.read_document", { documentId: "doc-1" }, context);
    expect(document.output).toMatchObject({
      resourceType: "google_doc",
      documentId: "doc-1",
      title: "Launch brief",
      textContent: "Launch plan\n",
      tabs: [{ tabId: "tab-1", title: "Overview" }]
    });
    const createdDocument = await adapter.executeTool("docs.create_document", {
      title: "Decision log",
      text: "First decision\n"
    }, context);
    expect(createdDocument).toMatchObject({
      providerOperationId: "doc-created",
      output: { writableByRally: true }
    });
    const replaced = await adapter.executeTool("docs.replace_text", {
      documentId: "doc-1",
      find: "draft",
      replace: "final"
    }, context);
    expect(replaced.output).toMatchObject({ documentId: "doc-1", occurrencesChanged: 2 });

    const spreadsheet = await adapter.executeTool("sheets.read_spreadsheet", { spreadsheetId: "sheet-1" }, context);
    expect(spreadsheet.output).toMatchObject({
      resourceType: "google_sheet",
      spreadsheetId: "sheet-1",
      title: "Metrics",
      sheets: [{ title: "Summary", rowCount: 100, columnCount: 10 }]
    });
    const values = await adapter.executeTool("sheets.read_values", {
      spreadsheetId: "sheet-1",
      range: "Summary!A1:B2"
    }, context);
    expect(values.output).toMatchObject({ values: [["Metric", "Value"], ["Users", 42]], cellCount: 4, truncated: false });
    const createdSheet = await adapter.executeTool("sheets.create_spreadsheet", {
      title: "Metrics",
      sheetTitles: ["Weekly"]
    }, context);
    expect(createdSheet).toMatchObject({
      providerOperationId: "sheet-created",
      output: { writableByRally: true }
    });
    const updated = await adapter.executeTool("sheets.update_values", {
      spreadsheetId: "sheet-1",
      range: "Summary!A1:B2",
      values: [["Metric", "Value"], ["Users", 43]]
    }, context);
    expect(updated.output).toMatchObject({ updatedRange: "Summary!A1:B2", updatedCells: 4 });
    const appended = await adapter.executeTool("sheets.append_values", {
      spreadsheetId: "sheet-1",
      range: "Summary!A:B",
      values: [["Revenue", 100]]
    }, context);
    expect(appended.output).toMatchObject({ updatedRange: "Summary!A3:B3", updatedCells: 2 });

    expect(requests.find((request) => request.url.pathname.endsWith(":update"))?.method).toBe("PUT");
    expect(requests.find((request) => request.url.pathname.endsWith(":append"))?.method).toBe("POST");
    expect(requests.some((request) => request.url.searchParams.get("includeTabsContent") === "true")).toBe(true);
    expect(requests.filter((request) => request.url.pathname.startsWith("/drive/v3/files/"))).toHaveLength(3);
  });

  it("searches Drive file contents, not only names, and narrows with its own parameters", async () => {
    let query = "";
    let orderBy: string | null = null;
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      query = url.searchParams.get("q") ?? "";
      orderBy = url.searchParams.get("orderBy");
      return googleJson({ files: [{ id: "file-1", name: "Q3 pricing", webViewLink: "https://drive.example/1" }] });
    };
    const result = await googleAdapter(fetcher).executeTool(
      "drive.search",
      {
        query: "Q3 pricing",
        fileType: "spreadsheet",
        modifiedAfter: "2026-08-01T00:00:00Z",
        orderBy: "modified"
      },
      {
        connection: googleConnection(["drive.read"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    );
    // Contents as well as names: a search for what a document says used to come
    // back empty, which the plugin message then licensed reporting as absent.
    expect(query).toContain("fullText contains 'Q3 pricing'");
    expect(query).toContain("name contains 'Q3 pricing'");
    expect(query).toContain("mimeType = 'application/vnd.google-apps.spreadsheet'");
    expect(query).toContain("modifiedTime > '2026-08-01T00:00:00Z'");
    expect(query).toContain("trashed = false");
    expect(orderBy).toBe("modifiedTime desc");
    // One name for the address a person opens, across every Google tool.
    expect(result.output).toMatchObject({ items: [{ id: "file-1", webUrl: "https://drive.example/1" }] });
  });

  it("returns computable values from Sheets when asked for them", async () => {
    const requests: URL[] = [];
    const fetcher: typeof fetch = async (input) => {
      requests.push(requestUrl(input));
      return googleJson({ range: "Sheet1!A1:B2", majorDimension: "ROWS", values: [[1234.5, 0.45]] });
    };
    const context = {
      connection: googleConnection(["sheets.read"]),
      principal: { type: "user" as const, userId: TEST_USER_ID },
      signal: neverAborts()
    };
    await googleAdapter(fetcher).executeTool(
      "sheets.read_values",
      { spreadsheetId: "sheet-1", range: "Sheet1!A1:B2", valueRenderOption: "UNFORMATTED_VALUE" },
      context
    );
    expect(requests[0]?.searchParams.get("valueRenderOption")).toBe("UNFORMATTED_VALUE");
    // Serial dates belong with unformatted numbers; pairing them with display
    // strings would return two spellings of the same date.
    expect(requests[0]?.searchParams.get("dateTimeRenderOption")).toBe("SERIAL_NUMBER");

    await googleAdapter(fetcher).executeTool(
      "sheets.read_values",
      { spreadsheetId: "sheet-1", range: "Sheet1!A1:B2" },
      context
    );
    expect(requests[1]?.searchParams.get("valueRenderOption")).toBe("FORMATTED_VALUE");
    expect(requests[1]?.searchParams.get("dateTimeRenderOption")).toBe("FORMATTED_STRING");
  });

  it("names the tool that reads an id rather than passing a Workspace mismatch through", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.hostname === "www.googleapis.com") {
        return googleJson({ mimeType: "application/vnd.google-apps.spreadsheet" });
      }
      return googleJson({ error: { code: 404, message: "Requested entity was not found." } }, 404);
    };
    const context = {
      connection: googleConnection(["docs.read", "drive.read", "sheets.read"]),
      principal: { type: "user" as const, userId: TEST_USER_ID },
      signal: neverAborts()
    };
    await expect(googleAdapter(fetcher).executeTool(
      "docs.read_document",
      { documentId: "actually-a-sheet" },
      context
    )).rejects.toMatchObject({
      code: "invalid_payload",
      details: { reason: "wrong_id_family", field: "documentId", expected: "document", actual: "spreadsheet" }
    });
    // The remedy names the tool to call, not a description of it: the caller
    // can match `sheets.read_spreadsheet` against its own prefixed wire name.
    await expect(googleAdapter(fetcher).executeTool(
      "docs.read_document",
      { documentId: "actually-a-sheet" },
      context
    )).rejects.toThrow(/sheets\.read_spreadsheet/u);
  });

  it("names the family from every Docs and Sheets tool that takes an id, not just the two readers", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      // Drive answers what the id really is; every other host refuses it.
      if (url.hostname === "www.googleapis.com") {
        return googleJson({
          mimeType: "application/vnd.google-apps.document",
          isAppAuthorized: true,
          capabilities: { canEdit: true }
        });
      }
      return googleJson({ error: { code: 400, message: "Invalid" } }, 400);
    };
    const context = {
      connection: googleConnection(["drive.read", "docs.read", "docs.write", "sheets.read", "sheets.write"]),
      principal: { type: "user" as const, userId: TEST_USER_ID },
      signal: neverAborts()
    };
    const calls: Array<[string, Record<string, unknown>]> = [
      ["sheets.read_values", { spreadsheetId: "a-doc", range: "A1:B2" }],
      ["sheets.update_values", { spreadsheetId: "a-doc", range: "A1:B2", values: [["x"]] }],
      ["sheets.append_values", { spreadsheetId: "a-doc", range: "A1:B2", values: [["x"]] }]
    ];
    for (const [tool, args] of calls) {
      await expect(googleAdapter(fetcher).executeTool(tool, args, context))
        .rejects.toMatchObject({
          details: { reason: "wrong_id_family", expected: "spreadsheet", actual: "document" }
        });
    }
  });

  it("points a Sheets read of a stored Excel file at drive.download instead of relaying the bare 400", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.hostname === "www.googleapis.com") {
        return googleJson({ mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      }
      return googleJson({ error: { code: 400, message: "This operation is not supported for this document" } }, 400);
    };
    await expect(googleAdapter(fetcher).executeTool(
      "sheets.read_spreadsheet",
      { spreadsheetId: "an-xlsx" },
      {
        connection: googleConnection(["drive.read", "sheets.read"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    )).rejects.toMatchObject({
      code: "invalid_payload",
      message: "That id is an excel, not a spreadsheet. Read it with drive.download, which returns every sheet's cells.",
      details: { reason: "wrong_id_family", expected: "spreadsheet", actual: "excel" }
    });
  });

  it("names the family on a write before the writability verdict hides it", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      // The realistic case: an arbitrary Drive result is not app-authorized, so
      // the writability preflight would otherwise refuse it as read-only and
      // never say it is the wrong kind of file.
      if (url.hostname === "www.googleapis.com") {
        return googleJson({
          mimeType: "application/vnd.google-apps.spreadsheet",
          isAppAuthorized: false,
          capabilities: { canEdit: false }
        });
      }
      return googleJson({ documentId: "doc" });
    };
    await expect(googleAdapter(fetcher).executeTool(
      "docs.append_text",
      { documentId: "actually-a-sheet", text: "hello" },
      {
        connection: googleConnection(["drive.read", "docs.write", "sheets.read"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    )).rejects.toMatchObject({
      code: "invalid_payload",
      details: { reason: "wrong_id_family", expected: "document", actual: "spreadsheet" }
    });
  });

  it("does not point a connection at a tool it was never granted", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.hostname === "www.googleapis.com") {
        return googleJson({ mimeType: "application/vnd.google-apps.spreadsheet" });
      }
      return googleJson({ error: { code: 404 } }, 404);
    };
    // No sheets.read, so naming the Sheets reader would be advice this
    // connection cannot follow.
    await expect(googleAdapter(fetcher).executeTool(
      "docs.read_document",
      { documentId: "actually-a-sheet" },
      {
        connection: googleConnection(["docs.read", "drive.read"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    )).rejects.toThrow(/^That id is a spreadsheet, not a document\.$/u);
  });

  it("browses Drive by type and recency without a search term", async () => {
    let query = "";
    const fetcher: typeof fetch = async (input) => {
      query = requestUrl(input).searchParams.get("q") ?? "";
      return googleJson({ files: [] });
    };
    await googleAdapter(fetcher).executeTool(
      "drive.search",
      { fileType: "spreadsheet", orderBy: "modified" },
      {
        connection: googleConnection(["drive.read"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    );
    // "The most recently modified spreadsheet" has no search term, and an empty
    // one would have built `contains ''`.
    expect(query).not.toContain("contains ''");
    expect(query).toContain("mimeType = 'application/vnd.google-apps.spreadsheet'");
    expect(query).toContain("trashed = false");
  });

  it("declares the same Drive file types it parses", () => {
    const search = createGoogleConnector({
      clientId: "google-client",
      clientSecret: "google-secret",
      redirectUri: "https://avalon.example/oauth/google/callback"
    }).manifest.tools.find((tool) => tool.name === "drive.search");
    const schema = search?.inputSchema as { properties: { fileType: { enum: string[] } } };
    // The advertised vocabulary and the one the executor enforces are the same
    // list, so a type added to one cannot be missing from the other.
    expect(schema.properties.fileType.enum).toEqual([
      "document",
      "spreadsheet",
      "presentation",
      "form",
      "drawing",
      "folder",
      "pdf",
      "word",
      "excel",
      "powerpoint"
    ]);
  });

  it("does not carry prior Google grants into a preset authorization", async () => {
    const authorization = await googleAdapter(async () => googleJson({})).beginAuthorization!({
      state: "state-for-google-oauth-attempt",
      codeChallenge: "challenge-for-google-oauth-attempt",
      scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.modify"],
    });
    const url = new URL(authorization.url);

    expect(url.searchParams.get("include_granted_scopes")).toBe("false");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      "openid",
      "email",
      "https://www.googleapis.com/auth/gmail.modify",
    ]);
  });

  it("authorizes exactly one existing Drive file without replacing connector credentials", async () => {
    const requests: URL[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      requests.push(url);
      if (url.hostname === "oauth2.googleapis.com") {
        return googleJson({ access_token: "one-pick-access", expires_in: 3600, token_type: "Bearer" });
      }
      return googleJson({
        id: "sheet-1",
        name: "Ellen Buckley Assessment",
        mimeType: "application/vnd.google-apps.spreadsheet",
        isAppAuthorized: true,
        capabilities: { canEdit: true },
      });
    };
    const adapter = googleAdapter(fetcher);
    const request = {
      capability: "sheets.write",
      operation: "edit" as const,
      resource: { id: "sheet-1", type: "document", name: "Existing sheet" },
    };
    const started = await adapter.resourceAuthorization!.begin({
      ...request,
      state: "state-for-google-resource-authorization",
      codeChallenge: "challenge-for-google-resource-authorization",
    });
    const url = new URL(started.url);
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(url.searchParams.get("include_granted_scopes")).toBe("false");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("trigger_onepick")).toBe("true");
    expect(url.searchParams.get("file_ids")).toBe("sheet-1");

    const connection = googleConnection(["sheets.write"]);
    await expect(adapter.resourceAuthorization!.complete({
      ...request,
      code: "picker-code",
      codeVerifier: "v".repeat(32),
      pickedResourceIds: ["sheet-1"],
      connection,
      signal: neverAborts(),
    })).resolves.toEqual({ id: "sheet-1", type: "document", name: "Ellen Buckley Assessment" });
    expect(connection.credentials).toEqual({ accessToken: "google-access-token" });
    expect(requests.map((candidate) => candidate.hostname)).toEqual([
      "oauth2.googleapis.com",
      "www.googleapis.com",
    ]);
  });

  it("rejects a Google resource authorization that picked another file", async () => {
    const adapter = googleAdapter(async () => { throw new Error("provider must not be called"); });
    await expect(adapter.resourceAuthorization!.complete({
      code: "picker-code",
      codeVerifier: "v".repeat(32),
      pickedResourceIds: ["sheet-2"],
      capability: "sheets.write",
      operation: "edit",
      resource: { id: "sheet-1", type: "document", name: "Existing sheet" },
      connection: googleConnection(["sheets.write"]),
      signal: neverAborts(),
    })).rejects.toMatchObject({ code: "invalid_payload" });
  });

  it("refuses a resource grant when the connected Google account cannot edit the file", async () => {
    const adapter = googleAdapter(async () => googleJson({
      id: "sheet-1",
      name: "Read-only sheet",
      mimeType: "application/vnd.google-apps.spreadsheet",
      isAppAuthorized: false,
      capabilities: { canEdit: false },
    }));
    await expect(adapter.resourceAuthorization!.inspect({
      capability: "sheets.write",
      operation: "edit",
      resource: { id: "sheet-1", type: "document", name: "Read-only sheet" },
      connection: googleConnection(["sheets.write"]),
      signal: neverAborts(),

    })).rejects.toMatchObject({ code: "unsupported_capability" });
  });
  it("reads a Drive file id out of the links people paste, and nothing else", () => {
    const id = "1irpjLvtBj5qZCrBJzEuuwJ2M-yj7rUDWhk8f1TfyGuI";
    expect(googleDriveFileIdFromReference(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`)).toBe(id);
    expect(googleDriveFileIdFromReference(`https://docs.google.com/document/d/${id}`)).toBe(id);
    expect(googleDriveFileIdFromReference(`https://drive.google.com/file/d/${id}/view?usp=sharing`)).toBe(id);
    expect(googleDriveFileIdFromReference(`https://drive.google.com/open?id=${id}`)).toBe(id);
    expect(googleDriveFileIdFromReference(` ${id} `)).toBe(id);
    expect(googleDriveFileIdFromReference(`http://docs.google.com/document/d/${id}`)).toBeNull();
    expect(googleDriveFileIdFromReference(`https://docs.google.com.evil.example/document/d/${id}`)).toBeNull();
    expect(googleDriveFileIdFromReference("https://x.com/masonwarner/status/2110403718604853440")).toBeNull();
    expect(googleDriveFileIdFromReference("Creator")).toBeNull();
  });

  it("reports how far a connection reaches a file without writing to it", async () => {
    const requests: string[] = [];
    const metadata = (file: Record<string, unknown>): typeof fetch => async (input, init) => {
      requests.push(`${init?.method ?? "GET"} ${requestUrl(input).hostname}`);
      return googleJson(file);
    };
    const sheet = { id: "sheet-file-id-01", name: "Creator Content Intake",
      mimeType: "application/vnd.google-apps.spreadsheet" };
    const link = "https://docs.google.com/spreadsheets/d/sheet-file-id-01/edit";

    await expect(googleAdapter(metadata({ ...sheet, isAppAuthorized: true, capabilities: { canEdit: true } }))
      .probeResourceAccess!(googleConnection(["drive.read", "sheets.write"]), link, neverAborts()))
      .resolves.toEqual({ access: "edit", resourceId: "sheet-file-id-01", name: "Creator Content Intake" });
    await expect(googleAdapter(metadata({ ...sheet, isAppAuthorized: false, capabilities: { canEdit: true } }))
      .probeResourceAccess!(googleConnection(["drive.read", "sheets.write"]), link, neverAborts()))
      .resolves.toEqual({ access: "read", resourceId: "sheet-file-id-01", name: "Creator Content Intake", editNeedsGrant: true });
    // Editable by the account, but this connection holds no Sheets write.
    await expect(googleAdapter(metadata({ ...sheet, isAppAuthorized: true, capabilities: { canEdit: true } }))
      .probeResourceAccess!(googleConnection(["drive.read"]), link, neverAborts()))
      .resolves.toEqual({ access: "read", resourceId: "sheet-file-id-01", name: "Creator Content Intake" });
    await expect(googleAdapter(async () => googleJson({ error: { code: 404 } }, 404))
      .probeResourceAccess!(googleConnection(["drive.read"]), link, neverAborts()))
      .resolves.toEqual({ access: "none", resourceId: "sheet-file-id-01", reason: "not_found_or_not_shared" });
    expect(requests.every((request) => request.startsWith("GET "))).toBe(true);

    // Seeing a Doc's details through a Sheets-only grant is not being able to read it.
    await expect(googleAdapter(metadata({ id: "doc-file-id-0001", name: "Notes",
      mimeType: "application/vnd.google-apps.document", isAppAuthorized: false, capabilities: { canEdit: true } }))
      .probeResourceAccess!(googleConnection(["sheets.read"]), "doc-file-id-0001", neverAborts()))
      .resolves.toEqual({ access: "none", resourceId: "doc-file-id-0001", reason: "capability_not_granted" });

    const unused = googleAdapter(async () => { throw new Error("provider must not be called"); });
    await expect(unused.probeResourceAccess!(googleConnection(["gmail.read", "calendar.read"]), link, neverAborts()))
      .resolves.toEqual({ access: "none", resourceId: "sheet-file-id-01", reason: "capability_not_granted" });
    await expect(unused.probeResourceAccess!(googleConnection(["drive.read"]), "https://x.com/a/status/1", neverAborts()))
      .resolves.toEqual({ access: "unrecognized" });
  });

  it("marks only refusals that came before any write as safe to try on another connection", async () => {
    const context = {
      connection: googleConnection(["drive.read", "sheets.read", "sheets.write"]),
      principal: { type: "user" as const, userId: TEST_USER_ID },
      signal: neverAborts()
    };
    const write = { spreadsheetId: "sheet-file-id-01", range: "A1:B1", values: [["a", "b"]], valueInputOption: "RAW" };

    // The writability check refuses; the write request is never sent.
    const sent: string[] = [];
    const notShared: typeof fetch = async (input, init) => {
      const url = requestUrl(input);
      if (url.hostname === "sheets.googleapis.com") sent.push(init?.method ?? "GET");
      return googleJson({ error: { code: 404 } }, 404);
    };
    const preflight = await googleAdapter(notShared).executeTool("sheets.update_values", write, context)
      .catch((error: unknown) => error);
    expect(isConnectorResourceAccessRefusal(preflight)).toBe(true);
    // A 403 on the same check is a refusal before any write too.
    const forbidden: typeof fetch = async (input, init) => {
      if (requestUrl(input).hostname === "sheets.googleapis.com") sent.push(init?.method ?? "GET");
      return googleJson({ error: { code: 403 } }, 403);
    };
    const preflightForbidden = await googleAdapter(forbidden).executeTool("sheets.update_values", write, context)
      .catch((error: unknown) => error);
    expect(isConnectorResourceAccessRefusal(preflightForbidden)).toBe(true);
    expect(sent).toEqual([]);

    // A read Google refuses for access.
    const read = await googleAdapter(async () => googleJson({ error: { code: 403 } }, 403))
      .executeTool("sheets.read_values", { spreadsheetId: "sheet-file-id-01", range: "A1:B1" }, context)
      .catch((error: unknown) => error);
    expect(isConnectorResourceAccessRefusal(read)).toBe(true);
    expect(read).toMatchObject({ code: "provider_error", message: "Google API failed (403)" });
    for (const [tool, args] of [
      ["drive.get_metadata", { fileId: "sheet-file-id-01" }],
      ["drive.download", { fileId: "sheet-file-id-01" }],
      ["drive.export", { fileId: "sheet-file-id-01", mimeType: "text/plain" }],
    ] as const) {
      const driveRead = await googleAdapter(async () => googleJson({ error: { code: 404 } }, 404))
        .executeTool(tool, args, context)
        .catch((error: unknown) => error);
      expect(isConnectorResourceAccessRefusal(driveRead), tool).toBe(true);
    }

    // The check passes and the write request itself is refused: not marked,
    // because a refusal after a write was sent is not one Rally may retry.
    const refusedWrite = await googleAdapter(async (input) => requestUrl(input).hostname === "www.googleapis.com"
      ? googleJson({ id: "sheet-file-id-01", name: "Sheet", mimeType: "application/vnd.google-apps.spreadsheet",
        isAppAuthorized: true, capabilities: { canEdit: true } })
      : googleJson({ error: { code: 403 } }, 403))
      .executeTool("sheets.update_values", write, context)
      .catch((error: unknown) => error);
    expect(refusedWrite).toMatchObject({ code: "provider_error" });
    expect(isConnectorResourceAccessRefusal(refusedWrite)).toBe(false);
  });

  it("leaves the provider failure alone when Drive cannot say what the id is", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.hostname === "www.googleapis.com") return googleJson({ error: { code: 404 } }, 404);
      return googleJson({ error: { code: 404, message: "Requested entity was not found." } }, 404);
    };
    // Without drive.read there is nothing to diagnose with, and diagnosing must
    // never replace the original failure with a different one.
    await expect(googleAdapter(fetcher).executeTool(
      "docs.read_document",
      { documentId: "missing" },
      {
        connection: googleConnection(["docs.read"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    )).rejects.toMatchObject({ code: "provider_error" });
  });

  it("hands back an openable address from every Google create", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.hostname === "sheets.googleapis.com") {
        return googleJson({
          spreadsheetId: "sheet-created",
          spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-created/edit",
          properties: { title: "Budget" },
          sheets: []
        });
      }
      return googleJson({ documentId: "doc-created", title: "Notes" });
    };
    const context = {
      connection: googleConnection(["docs.write", "sheets.write"]),
      principal: { type: "user" as const, userId: TEST_USER_ID },
      signal: neverAborts()
    };
    const doc = await googleAdapter(fetcher).executeTool("docs.create_document", { title: "Notes" }, context);
    expect(doc.output).toMatchObject({ webUrl: "https://docs.google.com/document/d/doc-created/edit" });
    const sheet = await googleAdapter(fetcher).executeTool("sheets.create_spreadsheet", { title: "Budget" }, context);
    expect(sheet.output).toMatchObject({ webUrl: "https://docs.google.com/spreadsheets/d/sheet-created/edit" });
  });

  it("reports per-file Drive writability and blocks unauthorized Docs and Sheets writes", async () => {
    const mutationUrls: URL[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = requestUrl(input);
      if (url.pathname === "/drive/v3/files") {
        return googleJson({
          files: [
            {
              id: "doc-writable",
              name: "Writable doc",
              mimeType: "application/vnd.google-apps.document",
              isAppAuthorized: true,
              capabilities: { canEdit: true }
            },
            {
              id: "sheet-not-authorized",
              name: "Existing sheet",
              mimeType: "application/vnd.google-apps.spreadsheet",
              isAppAuthorized: false,
              capabilities: { canEdit: true }
            }
          ]
        });
      }
      if (url.pathname.endsWith("/files/doc-not-authorized")) {
        return googleJson({
          id: "doc-not-authorized",
          name: "Existing doc",
          mimeType: "application/vnd.google-apps.document",
          isAppAuthorized: false,
          capabilities: { canEdit: true }
        });
      }
      if (url.pathname.endsWith("/files/sheet-user-read-only")) {
        return googleJson({
          id: "sheet-user-read-only",
          isAppAuthorized: true,
          capabilities: { canEdit: false }
        });
      }
      if (url.pathname.endsWith("/files/doc-unsupported-mime")) {
        return googleJson({
          id: "doc-unsupported-mime",
          name: "A PDF",
          mimeType: "application/pdf",
          isAppAuthorized: false,
          capabilities: { canEdit: true }
        });
      }
      if (url.pathname.endsWith("/files/doc-hidden-from-app")) {
        return googleJson({ error: { code: 404, message: "File not found" } }, 404);
      }
      if ((init?.method ?? "GET") !== "GET") mutationUrls.push(url);
      throw new Error(`Unexpected Google mutation: ${url}`);
    };
    const adapter = googleAdapter(fetcher);
    const principal = { type: "user" as const, userId: TEST_USER_ID };
    const signal = neverAborts();

    const search = await adapter.executeTool("drive.search", { query: "doc" }, {
      connection: googleConnection(["drive.read"]),
      principal,
      signal
    });
    // `items`, like every other list-shaped Google result.
    expect(search.output).toMatchObject({
      items: [
        { id: "doc-writable", isAppAuthorized: true, canEdit: true, writableByRally: true },
        { id: "sheet-not-authorized", isAppAuthorized: false, canEdit: true, writableByRally: false }
      ]
    });

    await expect(adapter.executeTool("docs.append_text", {
      documentId: "doc-not-authorized",
      text: "Do not write"
    }, {
      connection: googleConnection(["docs.write"]),
      principal,
      signal
    })).rejects.toMatchObject({
      code: "unsupported_capability",
      details: {
        reason: "drive_file_not_writable",
        isAppAuthorized: false,
        canEdit: true,
        resourceAuthorization: {
          kind: "connector_resource_authorization",
          provider: "google",
          capability: "docs.write",
          operation: "edit",
          resource: { id: "doc-not-authorized", type: "document", name: "Existing doc" },
        },
      }
    });
    await expect(adapter.executeTool("sheets.update_values", {
      spreadsheetId: "sheet-user-read-only",
      range: "A1",
      values: [["Do not write"]]
    }, {
      connection: googleConnection(["sheets.write"]),
      principal,
      signal
    })).rejects.toMatchObject({
      code: "unsupported_capability",
      details: { reason: "drive_file_not_writable", isAppAuthorized: true, canEdit: false }
    });
    await expect(adapter.executeTool("docs.append_text", {
      documentId: "doc-unsupported-mime",
      text: "Do not write"
    }, {
      connection: googleConnection(["docs.write"]),
      principal,
      signal
    })).rejects.toMatchObject({
      code: "invalid_payload",
      details: { reason: "wrong_id_family" }
    });
    await expect(adapter.executeTool("docs.append_text", {
      documentId: "doc-hidden-from-app",
      text: "Do not write"
    }, {
      connection: googleConnection(["docs.write"]),
      principal,
      signal
    })).rejects.toMatchObject({
      code: "unsupported_capability",
      details: { reason: "drive_file_not_writable", isAppAuthorized: false, canEdit: false }
    });
    expect(mutationUrls).toEqual([]);
  });

  it("tells a caller where every Google cursor comes from, and what the last page looks like", () => {
    const paginated = googleTools.filter((tool) => {
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      return Object.hasOwn(properties, "pageToken");
    });
    // The four that page today. A fifth added without a description fails here
    // rather than in somebody's run: the value of an opaque cursor is the one
    // argument that cannot be reasoned out from its name and its bounds.
    expect(paginated.map((tool) => tool.name)).toEqual([
      "gmail.search",
      "calendar.list_calendars",
      "calendar.list_events",
      "drive.search",
    ]);
    for (const tool of paginated) {
      const properties = (tool.inputSchema as {
        properties: Record<string, { description?: string; anyOf?: Array<{ type?: string; minLength?: number }> }>;
      }).properties;
      const pageToken = properties.pageToken!;
      // Declared as a union with `null`, because omitting the key is not a move
      // these callers reliably make and a value is. A bare optional string sent
      // one run hunting through `"x"`, `" "`, `"undefined"` and `"/"` for
      // something that would satisfy `minLength: 1`.
      expect(pageToken.anyOf?.map((branch) => branch.type), `${tool.name} pageToken`)
        .toEqual(["string", "null"]);
      // On the string branch, not the top: it is what makes the harness drop a
      // blanked argument instead of forwarding `""` to the provider.
      expect(pageToken.anyOf?.[0]?.minLength, `${tool.name} pageToken`).toBe(1);
      const description = pageToken.description ?? "";
      // Matched case-insensitively: the wording is edited for tone, and an
      // assertion pinned to a capital letter fails a rewrite that kept every
      // word. What has to survive an edit is the instruction, not its casing.
      expect(description, `${tool.name} pageToken`).toContain("nextPageToken");
      expect(description.toLowerCase(), `${tool.name} pageToken`).toContain("never construct");
      // Stated as the `null` these tools actually emit. A description of an
      // absent key would contradict what the caller sees on every last page.
      expect(description, `${tool.name} pageToken`).toContain("`nextPageToken` is `null`");
    }
  });

  it("names the argument Google refused instead of only its status code", async () => {
    const fetcher: typeof fetch = async () => googleJson({
      error: {
        code: 400,
        message: "Invalid Value",
        errors: [{
          domain: "global",
          reason: "invalid",
          message: "Invalid Value",
          locationType: "parameter",
          location: "pageToken",
        }],
      },
    }, 400);
    await expect(googleAdapter(fetcher).executeTool(
      "drive.search",
      { query: "portfolio", pageToken: "1" },
      {
        connection: googleConnection(["drive.read"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts(),
      }
    )).rejects.toMatchObject({
      code: "provider_error",
      // `field` is on the structured-failure allowlist, so this is what the
      // model is given to correct. Without it a rejected argument is
      // indistinguishable from any other 400, and the run varies everything
      // except the one value Google is refusing.
      message: "Google API failed (400); it rejected the `pageToken` argument",
      details: { reason: "invalid_parameter", field: "pageToken" },
    });
  });

  it("holds the executor's cursor bound to the one the schema advertises", async () => {
    // The schema promises a ceiling and the parse enforces one; nothing made
    // them the same number until they shared a declaration. A caller told 2000
    // and refused at 500 would be refused by Rally for obeying us.
    const declared = googleTools.find((tool) => tool.name === "drive.search")!;
    const properties = (declared.inputSchema as {
      properties: Record<string, { anyOf?: Array<{ maxLength?: number }> }>;
    }).properties;
    const maxLength = properties.pageToken?.anyOf?.[0]?.maxLength;
    expect(maxLength).toBe(2_000);

    const fetcher: typeof fetch = async () => googleJson({ files: [] });
    const context = {
      connection: googleConnection(["drive.read"]),
      principal: { type: "user" as const, userId: TEST_USER_ID },
      signal: neverAborts(),
    };
    // One under the ceiling is accepted, one over is refused, so the assertion
    // pins the boundary rather than merely that some bound exists.
    await expect(googleAdapter(fetcher).executeTool(
      "drive.search",
      { query: "portfolio", pageToken: "t".repeat(maxLength!) },
      context,
    )).resolves.toBeDefined();
    await expect(googleAdapter(fetcher).executeTool(
      "drive.search",
      { query: "portfolio", pageToken: "t".repeat(maxLength! + 1) },
      context,
    )).rejects.toThrow(/pageToken/u);
  });

  // Every one of the four, because the parse that turns `null` into absence is
  // written out per tool rather than shared: covering `drive.search` alone
  // proves one copy of four.
  it.each([
    ["gmail.search", { query: "unread" }, ["gmail.read"], { messages: [] }],
    ["calendar.list_calendars", {}, ["calendar.read"], { items: [] }],
    [
      "calendar.list_events",
      { calendarId: "primary", timeMin: "2026-01-01T00:00:00Z", timeMax: "2026-01-02T00:00:00Z" },
      ["calendar.read"],
      { items: [] },
    ],
    ["drive.search", { query: "portfolio" }, ["drive.read"], { files: [] }],
  ] as const)("reads a null cursor as the first page for %s", async (tool, args, scopes, body) => {
    const requested: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      requested.push(requestUrl(input).toString());
      return googleJson(body);
    };
    await googleAdapter(fetcher).executeTool(
      tool,
      { ...args, pageToken: null },
      {
        connection: googleConnection([...scopes]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts(),
      }
    );
    // The call runs, and Google is never handed the caller's `null`. Asserted
    // over every request rather than a single one, because a tool may resolve
    // a calendar or hydrate a hit before it gets to the listing.
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.filter((url) => url.includes("pageToken"))).toEqual([]);
  });

  it("refuses to name an argument the tool would itself reject", async () => {
    // Drive sends `query`, `fileType` and `modifiedAfter` as one `q`, so a
    // rejection of `q` names no single argument to change — and `q` is not an
    // argument `drive.search` accepts, so relaying it would send a caller after
    // a key its own strict schema refuses.
    const fetcher: typeof fetch = async () => googleJson({
      error: {
        code: 400,
        message: "Invalid Value",
        errors: [{ domain: "global", reason: "invalid", locationType: "parameter", location: "q" }],
      },
    }, 400);
    await expect(googleAdapter(fetcher).executeTool(
      "drive.search",
      { query: "portfolio" },
      {
        connection: googleConnection(["drive.read"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts(),
      }
    )).rejects.toMatchObject({ code: "provider_error", message: "Google API failed (400)" });
  });

  it("maps a refused Google parameter back to the argument the caller passed", async () => {
    // Drive's `pageSize` is Rally's `maxResults`; naming Google's spelling
    // would be naming a key `drive.search` does not accept.
    const fetcher: typeof fetch = async () => googleJson({
      error: {
        code: 400,
        message: "Invalid Value",
        errors: [{ domain: "global", reason: "invalid", locationType: "parameter", location: "pageSize" }],
      },
    }, 400);
    await expect(googleAdapter(fetcher).executeTool(
      "drive.search",
      { query: "portfolio", maxResults: 100 },
      {
        connection: googleConnection(["drive.read"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts(),
      }
    )).rejects.toMatchObject({
      code: "provider_error",
      message: "Google API failed (400); it rejected the `maxResults` argument",
      details: { reason: "invalid_parameter", field: "maxResults" },
    });
  });

  it("reads a status other than 400 as something other than a bad argument", async () => {
    // Drive reports a deleted, trashed, or unshared file with the same
    // `errors[]` shape a bad argument uses, so status is what separates "you
    // sent the wrong thing" from "it is not there". The location below is a
    // mapped one deliberately: `drive.get_metadata` passes no argument mapping
    // at all, so it could not reach the naming path whatever the status, and a
    // test written against it would pass with this rule deleted.
    const fetcher: typeof fetch = async () => googleJson({
      error: {
        code: 404,
        message: "File not found",
        errors: [{ domain: "global", reason: "notFound", locationType: "parameter", location: "pageToken" }],
      },
    }, 404);
    await expect(googleAdapter(fetcher).executeTool(
      "drive.search",
      { query: "portfolio" },
      {
        connection: googleConnection(["drive.read"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts(),
      }
    )).rejects.toMatchObject({ code: "provider_error", message: "Google API failed (404)" });
  });

  it("does not relay a rejection whose location is not an argument name", async () => {
    const fetcher: typeof fetch = async () => googleJson({
      error: {
        code: 400,
        message: "Invalid Value",
        errors: [{
          domain: "global",
          reason: "invalid",
          locationType: "parameter",
          // Google puts a query fragment here for some error classes, and a
          // search term is the caller's own content. Only an identifier-shaped
          // name leaves the adapter.
          location: "name contains 'Q3 board deck' and trashed = false",
        }],
      },
    }, 400);
    await expect(googleAdapter(fetcher).executeTool(
      "drive.search",
      { query: "Q3 board deck" },
      {
        connection: googleConnection(["drive.read"]),
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts(),
      }
    )).rejects.toMatchObject({ code: "provider_error", message: "Google API failed (400)" });
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
      "gmail.search",
      { query: "is:unread" },
      {
        connection,
        principal: { type: "user", userId: TEST_USER_ID },
        signal: neverAborts()
      }
    );
    expect(result.output).toMatchObject({ items: [{ id: "message-1" }] });
    // The list call is refused, refreshed, and retried; the third authorization
    // is the header hydration for the single hit it returned.
    expect(authorizations).toEqual(["Bearer access-old", "Bearer access-new", "Bearer access-new"]);
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
        "gmail.search",
        { query: "is:unread" },
        {
          connection,
          principal: { type: "user", userId: TEST_USER_ID },
          signal: neverAborts()
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
    const result = await adapter.poll!(
      googleConnection(["drive.read"], { drive: { pageToken: "1" } }),
      neverAborts()
    );
    // nextPollAt is stamped from a clock read inside the poll, so measuring from
    // a mark taken before it would silently budget the three Drive round trips
    // on top of the interval being asserted.
    const finished = Date.now();
    expect(result.cursor).toMatchObject({ drive: { pageToken: "4", continuing: true } });
    const delay = Date.parse(result.nextPollAt!) - finished;
    expect(delay).toBeGreaterThan(4_000);
    expect(delay).toBeLessThanOrEqual(5_000);
  });
});

const TEST_USER_ID = asUserId("00000000-0000-7000-8000-000000000001");
const TEST_WORKSPACE_ID = "00000000-0000-7000-8000-000000000002";
const TEST_CONNECTION_ID = "00000000-0000-7000-8000-000000000003";

/** A minimal polled activity, named after the stream that produced it. */
function activityFrom(streamId: string) {
  const eventType = streamId === "gmail" ? "gmail.email.received" : "drive.file_changed";
  return {
    workspaceId: TEST_WORKSPACE_ID,
    region: "global" as const,
    connectionId: TEST_CONNECTION_ID,
    connectionScope: "personal" as const,
    connectionOwnerUserId: TEST_USER_ID,
    provider: "google",
    providerEventId: `${streamId}-1`,
    eventType,
    resourceType: null,
    providerResourceId: null,
    actor: {},
    subject: {},
    occurredAt: "2026-08-11T09:00:00.000Z",
    receivedAt: "2026-08-11T09:00:01.000Z",
    title: `Something happened in ${streamId}`,
    summary: "",
    textSnippet: "",
    payloadRef: null,
    visibility: {},
    targetUserIds: [],
    entityKeys: [],
    dedupeKey: `${streamId}-1`,
    rawContentHash: null,
    metadata: { source: streamId },
    externalPeople: [],
  };
}

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
): AuthorizedConnectorConnection {
  return authorizedConnection({
    id: TEST_CONNECTION_ID,
    workspaceId: TEST_WORKSPACE_ID,
    scope: "personal",
    ownerUserId: TEST_USER_ID,
    grantedScopes,
    credentials: { accessToken: "google-access-token" },
    cursor,
    config: { region: "global", pollIntervalSeconds: 300 }
  });
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

describe("Google watch relationships", () => {
  /**
   * Registry construction is where a missing relationship value fails, and it
   * fails for every connector at once — so this asserts the descriptors are
   * accepted, not merely that the manifest object contains them.
   */
  // Through the registry, not the manifest object: registry construction is
  // where a relationship value the enum does not allow is rejected, and it is
  // rejected for every connector at once.
  const registry = new ConnectorRegistry([createGoogleConnector({
    clientId: "google-client",
    clientSecret: "google-secret",
    redirectUri: "https://avalon.example/oauth/google/callback",
  })]);
  const triggers = registry.get("google").manifest.activityTriggers ?? [];
  const relationshipsFor = (eventType: string): ReadonlyArray<{ relationship: string; resourceType: string }> =>
    triggers.find((trigger) => trigger.eventType === eventType)?.resourceRelationships ?? [];

  it("declares the watched file for each Drive event family", () => {
    expect(relationshipsFor("sheets.spreadsheet_changed"))
      .toEqual([{ relationship: "file", resourceType: "google_sheet" }]);
    expect(relationshipsFor("docs.document_changed"))
      .toEqual([{ relationship: "file", resourceType: "google_doc" }]);
    expect(relationshipsFor("drive.file_changed"))
      .toEqual([{ relationship: "file", resourceType: "drive_file" }]);
  });

  it("declares the watched thread on both mail events", () => {
    expect(relationshipsFor("email.received"))
      .toEqual([{ relationship: "thread", resourceType: "gmail_thread" }]);
    expect(relationshipsFor("email.updated"))
      .toEqual([{ relationship: "thread", resourceType: "gmail_thread" }]);
  });

  it("leaves calendar events unrelated to any attached resource", () => {
    expect(relationshipsFor("calendar.event_changed")).toEqual([]);
    expect(relationshipsFor("calendar.event_completed")).toEqual([]);
  });
});
