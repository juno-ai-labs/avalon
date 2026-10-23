import { describe, expect, it } from "vitest";
import { asUserId } from "@rally/contracts";
import { authorizedConnection, createGoogleConnector, type ConnectorToolContext } from "./index";

const eventId = "637e7ded325d22be7ba6058201ba155e68316e3d19fc36cac654558b5cda1644";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function context(): ConnectorToolContext {
  const userId = asUserId("00000000-0000-7000-8000-000000000001");
  return { principal: { type: "user", userId }, providerIdempotencyKey: "calendar-effect-1", signal: new AbortController().signal,
    connection: authorizedConnection({ id: "00000000-0000-7000-8000-000000000002", workspaceId: "00000000-0000-7000-8000-000000000003",
      scope: "personal", ownerUserId: userId, grantedScopes: ["calendar.read", "calendar.write"],
      credentials: { accessToken: "test-only" }, cursor: {}, config: {} }) };
}

describe("Google Calendar receipt-key creation", () => {
  it.each([
    { tool: "calendar.create_event", args: { summary: "Review", start: "2026-10-23T09:00:00Z", end: "2026-10-23T10:00:00Z" } },
    { tool: "calendar.create_all_day_event", args: { summary: "Review", start: "2026-10-23", end: "2026-10-24" } },
    { tool: "calendar.create_recurring_event", args: { summary: "Review", start: "2026-10-23T09:00:00Z", end: "2026-10-23T10:00:00Z",
      timeZone: "UTC", repeat: { frequency: "weekly" } } },
  ])("recovers a lost $tool response with one event identity and no overwrite", async ({ tool, args }) => {
    const sent: unknown[] = [], reads: string[] = [];
    const connector = createGoogleConnector({ clientId: "test", clientSecret: "test", redirectUri: "https://example.test/oauth",
      fetch: async (input, init) => {
        const url = String(input);
        if (init?.method === "POST") {
          sent.push(JSON.parse(String(init.body)));
          if (sent.length === 1) throw new TypeError("Response lost after provider acceptance");
          return json({ error: { code: 409, errors: [{ reason: "duplicate" }] } }, 409);
        }
        reads.push(url);
        return json({ id: eventId, summary: "Organizer changed the title", status: "confirmed" });
      },
    });
    await expect(connector.executeTool(tool, { ...args, calendarId: "primary" }, context())).rejects.toThrow("Response lost");
    expect(reads).toEqual([]); // No healthy-path preflight.
    const recovered = await connector.executeTool(tool, { ...args, calendarId: "primary" }, { ...context(), replaying: true });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ id: eventId, summary: "Review" });
    expect(sent[1]).toEqual(sent[0]);
    expect(reads).toEqual([`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`]);
    expect(recovered).toMatchObject({ providerOperationId: eventId,
      output: { id: eventId, summary: "Organizer changed the title" }, summary: "Recovered calendar event “Review”" });
  });

  it("leaves an unrelated conflict unresolved instead of claiming recovery", async () => {
    const methods: string[] = [];
    const connector = createGoogleConnector({ clientId: "test", clientSecret: "test", redirectUri: "https://example.test/oauth",
      fetch: async (_input, init) => { methods.push(init?.method ?? "GET"); return json({ error: { errors: [{ reason: "conflict" }] } }, 409); } });
    await expect(connector.executeTool("calendar.create_event", { summary: "Review", start: "2026-10-23T09:00:00Z", end: "2026-10-23T10:00:00Z" }, context()))
      .rejects.toThrow("without confirming the original event");
    expect(methods).toEqual(["POST"]);
  });

  it.each([undefined, "Team calendar"])("does not retry creation with an unstable original calendar: %s", async (calendarId) => {
    const requests: string[] = [];
    const connector = createGoogleConnector({ clientId: "test", clientSecret: "test", redirectUri: "https://example.test/oauth",
      fetch: async (input) => { requests.push(String(input)); return json({ id: eventId }); } });
    const replay = { ...context(), replaying: true };
    replay.connection.config.calendarId = "changed-default@group.calendar.google.com";
    await expect(connector.executeTool("calendar.create_event", { calendarId, summary: "Review", start: "2026-10-23T09:00:00Z", end: "2026-10-23T10:00:00Z" }, replay))
      .rejects.toThrow("original explicit calendar ID is required");
    expect(requests).toEqual([]);
  });

  it("does not read back a duplicate through a write-only grant", async () => {
    const methods: string[] = [];
    const connector = createGoogleConnector({ clientId: "test", clientSecret: "test", redirectUri: "https://example.test/oauth",
      fetch: async (_input, init) => { methods.push(init?.method ?? "GET");
        return json({ error: { errors: [{ reason: "duplicate" }] } }, 409); } });
    const writeOnly = context();
    writeOnly.connection.grantedScopes = ["calendar.write"];
    await expect(connector.executeTool("calendar.create_event", { summary: "Review", start: "2026-10-23T09:00:00Z", end: "2026-10-23T10:00:00Z" }, writeOnly))
      .rejects.toMatchObject({ code: "unsupported_capability" });
    expect(methods).toEqual(["POST"]);
  });
});
