import { asWorkspaceId } from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  authorizedConnection,
  ConnectorError,
  connectorObservationErrorCode,
  createConnectorRegistry,
  createGenericWebhookConnector,
  instrumentConnectorAdapter,
  instrumentConnectorFetch,
  withProviderReauthorization,
  type ConnectorObserver,
} from "./index";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000201");

function connection() {
  return authorizedConnection({
    id: "connection-201",
    workspaceId: WORKSPACE_ID,
    scope: "workspace" as const,
    ownerUserId: null,
    grantedScopes: [],
    credentials: {},
    cursor: {},
    config: {},
  });
}

describe("connector observability", () => {
  it("names the failing field when a provider's response does not match the adapter's schema", () => {
    // The real failure this exists for: Fireflies answered `get_meeting_summary`
    // with HTTP 200 and a body whose shape had drifted. A `ZodError` is not a
    // `ConnectorError`, so it landed as `unexpected_error` — twice, identically,
    // naming nothing. The Sidekick had no summary to write and sent no email.
    const rejection = z.looseObject({
      summary: z.looseObject({ topics_discussed: z.array(z.string()).nullish() }).nullish(),
    }).safeParse({ summary: { topics_discussed: [{ name: "pricing" }] } });
    if (rejection.success) throw new Error("expected a rejection");

    const code = connectorObservationErrorCode(rejection.error);
    expect(code).not.toBe("unexpected_error");
    expect(code).toContain("summary.topics_discussed.0");
    // Not `response_invalid`. This classifies every adapter operation, and
    // `executeTool` parses the model's own arguments through the same `.parse`,
    // so naming the provider would pin a model's malformed input on it.
    expect(code).not.toContain("response");
    expect(code).toContain("schema_invalid");
  });

  it("never logs a health-check message, which an adapter may fill from a provider's own error", async () => {
    const observations: Parameters<ConnectorObserver>[] = [];
    const observer: ConnectorObserver = (...entry) => observations.push(entry);
    const adapter = instrumentConnectorAdapter({
      ...createGenericWebhookConnector(),
      healthCheck: () => Promise.resolve({
        ok: false,
        // What `x.ts` does: return a caught provider error's own text, which is
        // the provider's body and may carry anything it chose to put there.
        message: "Upstream rejected token sk-live-4f9a for alex@juno-labs.com",
        reasonCode: "provider_refused",
      }),
    }, observer);

    await adapter.healthCheck(connection());

    const recorded = JSON.stringify(observations);
    expect(recorded).toContain("provider_refused");
    expect(recorded).not.toContain("sk-live-4f9a");
    expect(recorded).not.toContain("alex@juno-labs.com");
  });

  it("keeps its own vocabulary for the errors that already had one", () => {
    expect(connectorObservationErrorCode(new ConnectorError("unauthorized", "no"))).toBe("unauthorized");
    expect(connectorObservationErrorCode(new Error("something else"))).toBe("unexpected_error");
  });


  it("logs provider request starts and terminal outcomes at useful levels without URL content", async () => {
    const observations: Parameters<ConnectorObserver>[] = [];
    const observer: ConnectorObserver = (...entry) => observations.push(entry);
    const fetcher = instrumentConnectorFetch(
      "slack",
      vi.fn(async () => new Response("{}", { status: 200 })),
      observer,
    );

    await expect(fetcher("https://slack.com/api/chat.postMessage?channel=CSECRET", {
      method: "POST",
    })).resolves.toMatchObject({ status: 200 });

    expect(observations).toEqual([
      ["debug", "connector_provider_request_started", expect.objectContaining({
        connector_type: "slack",
        method: "POST",
        provider_origin: "https://slack.com",
      })],
      ["info", "connector_provider_request_finished", expect.objectContaining({
        connector_type: "slack",
        outcome: "succeeded",
        status: 200,
      })],
    ]);
    expect(JSON.stringify(observations)).not.toContain("chat.postMessage");
    expect(JSON.stringify(observations)).not.toContain("CSECRET");
  });

  it("uses warning and error levels for provider rejections and transport failures", async () => {
    const observations: Parameters<ConnectorObserver>[] = [];
    const observer: ConnectorObserver = (...entry) => observations.push(entry);
    const refused = instrumentConnectorFetch(
      "google",
      async () => new Response("{}", { status: 429 }),
      observer,
    );
    const unavailable = instrumentConnectorFetch(
      "google",
      async () => { throw new Error("socket disclosed a sensitive detail"); },
      observer,
    );

    await expect(refused("https://www.googleapis.com/gmail/v1/users/me/messages")).resolves
      .toMatchObject({ status: 429 });
    await expect(unavailable("https://www.googleapis.com/drive/v3/files")).rejects
      .toThrow("socket disclosed a sensitive detail");

    expect(observations).toContainEqual([
      "warn",
      "connector_provider_request_finished",
      expect.objectContaining({ status: 429, outcome: "provider_rejected" }),
    ]);
    expect(observations).toContainEqual([
      "error",
      "connector_provider_request_finished",
      expect.objectContaining({ code: "unexpected_error", outcome: "failed" }),
    ]);
    expect(JSON.stringify(observations)).not.toContain("socket disclosed");
  });

  it("logs adapter starts, successes, expected failures, IDs, and provider operation IDs", async () => {
    const observations: Parameters<ConnectorObserver>[] = [];
    const observer: ConnectorObserver = (...entry) => observations.push(entry);
    const base = createGenericWebhookConnector();
    const adapter = instrumentConnectorAdapter({
      ...base,
      manifest: { ...base.manifest, type: "slack" },
      async executeTool(name) {
        if (name === "fail") {
          throw new ConnectorError("provider_error", "provider content must not be logged");
        }
        return { output: {}, summary: "done", providerOperationId: "provider-operation-201" };
      },
    }, observer);
    const context = {
      connection: connection(),
      principal: { type: "workspace" as const, workspaceId: WORKSPACE_ID },
      signal: new AbortController().signal,
    };

    await expect(adapter.executeTool("succeed", {
      channel_id: "CCHANNEL201",
      userId: "UUSER201",
      thread_ts: "1712345678.000201",
      text: "connector content must remain absent",
    }, context)).resolves.toMatchObject({ summary: "done" });
    await expect(adapter.executeTool("fail", {}, context)).rejects.toMatchObject({ code: "provider_error" });

    expect(observations).toContainEqual([
      "debug",
      "connector_operation_started",
      expect.objectContaining({
        connector_type: "slack",
        operation: "tool_execute",
        connection_id: "connection-201",
        workspace_id: WORKSPACE_ID,
        tool_name: "succeed",
        provider_channel_id: "CCHANNEL201",
        provider_user_id: "UUSER201",
        provider_thread_ts: "1712345678.000201",
      }),
    ]);
    expect(observations).toContainEqual([
      "info",
      "connector_operation_finished",
      expect.objectContaining({
        outcome: "succeeded",
        provider_operation_id: "provider-operation-201",
      }),
    ]);
    expect(observations).toContainEqual([
      "warn",
      "connector_operation_finished",
      expect.objectContaining({ outcome: "failed", code: "provider_error", tool_name: "fail" }),
    ]);
    expect(JSON.stringify(observations)).not.toContain("provider content must not be logged");
    expect(JSON.stringify(observations)).not.toContain("connector content must remain absent");
  });

  it("retains identifiers from real Google and Linear tool shapes without adjacent content", async () => {
    const observations: Parameters<ConnectorObserver>[] = [];
    const adapter = instrumentConnectorAdapter({
      ...createGenericWebhookConnector(),
      async executeTool() {
        return { output: {}, summary: "done" };
      },
    }, (...entry) => {
      observations.push(entry);
    });
    const context = {
      connection: connection(),
      principal: { type: "workspace" as const, workspaceId: WORKSPACE_ID },
      signal: new AbortController().signal,
    };

    await adapter.executeTool("calendar.read_event", {
      calendarId: "google-calendar-201",
      eventId: "google-event-201",
      timeMin: "2026-08-25T09:00:00-07:00",
      query: "customer content must remain absent",
    }, context);
    await adapter.executeTool("update_issue", {
      issueId: "linear-issue-201",
      stateId: "linear-state-201",
      assigneeId: "linear-user-201",
      description: "linear content must remain absent",
      createdTs: "generic timestamp must remain absent",
    }, context);

    expect(observations).toContainEqual([
      "debug",
      "connector_operation_started",
      expect.objectContaining({
        tool_name: "calendar.read_event",
        provider_calendar_id: "google-calendar-201",
        provider_event_id: "google-event-201",
      }),
    ]);
    expect(observations).toContainEqual([
      "debug",
      "connector_operation_started",
      expect.objectContaining({
        tool_name: "update_issue",
        provider_issue_id: "linear-issue-201",
        provider_state_id: "linear-state-201",
        provider_assignee_id: "linear-user-201",
      }),
    ]);
    expect(JSON.stringify(observations)).not.toContain("customer content must remain absent");
    expect(JSON.stringify(observations)).not.toContain("linear content must remain absent");
    expect(JSON.stringify(observations)).not.toContain("generic timestamp must remain absent");
    expect(JSON.stringify(observations)).not.toContain("2026-08-25T09:00:00-07:00");
  });

  it("classifies runtime AbortError failures without a DOMException-only branch", () => {
    const error = new Error("request content must remain absent");
    error.name = "AbortError";

    expect(connectorObservationErrorCode(error)).toBe("request_aborted");
  });

  it("logs healthy, degraded, and unhealthy health-check terminal conditions", async () => {
    const observations: Parameters<ConnectorObserver>[] = [];
    const observer: ConnectorObserver = (...entry) => observations.push(entry);
    const base = createGenericWebhookConnector();
    const healthy = instrumentConnectorAdapter(base, observer);
    const degraded = instrumentConnectorAdapter({
      ...base,
      async healthCheck() {
        return { ok: true, message: "usable", warning: "provider content omitted" };
      },
    }, observer);
    const unhealthy = instrumentConnectorAdapter({
      ...base,
      async healthCheck() {
        return { ok: false, message: "reconnect", reconnectRequired: true };
      },
    }, observer);

    await healthy.healthCheck(connection());
    await degraded.healthCheck(connection());
    await unhealthy.healthCheck(connection());

    expect(observations).toContainEqual([
      "info",
      "connector_operation_finished",
      expect.objectContaining({ operation: "health_check", outcome: "healthy" }),
    ]);
    expect(observations).toContainEqual([
      "warn",
      "connector_operation_finished",
      expect.objectContaining({
        operation: "health_check",
        outcome: "degraded",
        warning_present: true,
      }),
    ]);
    expect(observations).toContainEqual([
      "warn",
      "connector_operation_finished",
      expect.objectContaining({
        operation: "health_check",
        outcome: "unhealthy",
        reconnect_required: true,
      }),
    ]);
    expect(JSON.stringify(observations)).not.toContain("provider content omitted");
  });

  it("names each failed stream's code on a poll, and never a stream's message", async () => {
    // A poll whose every stream failed logged as `succeeded` with a count. The
    // codes are the adapter's own or a schema rejection's paths; the messages
    // can carry provider text and already reach the connection row.
    const observations: Parameters<ConnectorObserver>[] = [];
    const observer: ConnectorObserver = (...entry) => observations.push(entry);
    const adapter = instrumentConnectorAdapter({
      ...createGenericWebhookConnector(),
      async poll() {
        return {
          activities: [],
          cursor: {},
          streamErrors: [
            { streamId: "calendar", code: "response_invalid:items.0.start:invalid_type", message: "provider content must remain absent" },
            { streamId: "mail", code: "unauthorized", message: "provider content must remain absent" },
            { streamId: "drive", code: "unauthorized", message: "provider content must remain absent" },
          ],
        };
      },
    }, observer);

    await adapter.poll!(connection(), new AbortController().signal);

    expect(observations).toContainEqual([
      "info",
      "connector_operation_finished",
      expect.objectContaining({
        operation: "poll",
        stream_error_count: 3,
        stream_error_codes: ["response_invalid:items.0.start:invalid_type", "unauthorized"],
      }),
    ]);
    expect(JSON.stringify(observations)).not.toContain("provider content must remain absent");
  });

  it("names the field a returned tool-input rejection rejected, and not the value", () => {
    // A returned `ZodError` had its paths in hand and logged the word
    // `invalid`; the same rejection thrown would have been named.
    const observations: Parameters<ConnectorObserver>[] = [];
    const observer: ConnectorObserver = (...entry) => observations.push(entry);
    const adapter = instrumentConnectorAdapter({
      ...createGenericWebhookConnector(),
      validateToolInput(_name, args) {
        const result = z.strictObject({ filters: z.array(z.strictObject({ status: z.enum(["open", "closed"]) })) }).safeParse(args);
        return result.success ? null : result.error;
      },
    }, observer);

    adapter.validateToolInput!("list_issues", { filters: [{ status: "member content must remain absent" }] });

    expect(observations).toContainEqual([
      "info",
      "connector_operation_finished",
      expect.objectContaining({
        operation: "tool_input_validate",
        outcome: "invalid",
        code: "tool_input_invalid:filters.0.status:invalid_value",
      }),
    ]);
    expect(JSON.stringify(observations)).not.toContain("member content must remain absent");
  });

  it("keeps connector behavior independent from observer failures", async () => {
    const throws: ConnectorObserver = () => { throw new Error("logging unavailable"); };
    const fetcher = instrumentConnectorFetch("x", async () => new Response("ok"), throws);
    const adapter = instrumentConnectorAdapter(createGenericWebhookConnector(), throws);

    await expect(fetcher("https://api.twitterapi.io/test")).resolves.toMatchObject({ status: 200 });
    await expect(adapter.healthCheck()).resolves.toMatchObject({ ok: true });
  });

  it("adds shared credential refresh and retry decisions beneath adapter logs", async () => {
    const observations: Parameters<ConnectorObserver>[] = [];
    const observer: ConnectorObserver = (...entry) => observations.push(entry);
    const base = createGenericWebhookConnector();
    let attempts = 0;
    const adapter = instrumentConnectorAdapter({
      ...base,
      async executeTool(_name, _args, context) {
        const output = await withProviderReauthorization(context.connection, {
          refresh: async () => ({ accessToken: "replacement-not-logged" }),
          isRejection: (error) => error instanceof ConnectorError && error.code === "unauthorized",
          signal: context.signal,
        }, async () => {
          attempts += 1;
          if (attempts === 1) throw new ConnectorError("unauthorized", "expired token");
          return "recovered";
        });
        return { output, summary: "done" };
      },
    }, observer);

    await adapter.executeTool("recover", {}, {
      connection: connection(),
      principal: { type: "workspace", workspaceId: WORKSPACE_ID },
      signal: new AbortController().signal,
    });

    expect(observations).toContainEqual([
      "warn",
      "connector_credential_reauthorization_started",
      expect.objectContaining({ connection_id: "connection-201", reason: "provider_credential_rejected" }),
    ]);
    expect(observations).toContainEqual([
      "debug",
      "connector_credential_refresh_started",
      expect.objectContaining({ rotation_source: "adapter" }),
    ]);
    expect(observations).toContainEqual([
      "info",
      "connector_credential_refresh_finished",
      expect.objectContaining({ outcome: "succeeded" }),
    ]);
    expect(observations).toContainEqual([
      "debug",
      "connector_provider_retry_started",
      expect.objectContaining({ reason: "credential_refreshed" }),
    ]);
    expect(observations).toContainEqual([
      "info",
      "connector_credential_reauthorization_finished",
      expect.objectContaining({ outcome: "recovered" }),
    ]);
    expect(JSON.stringify(observations)).not.toContain("replacement-not-logged");
  });

  it("wires shared request and adapter instrumentation through the connector registry", async () => {
    const observations: Parameters<ConnectorObserver>[] = [];
    const registry = createConnectorRegistry({
      observer: (...entry) => observations.push(entry),
      x: {
        apiKey: "test-key",
        fetch: async () => Response.json({ status: "success", data: { tweets: [] } }),
      },
    });
    const adapter = registry.get("x");

    await adapter.executeTool("get_user_timeline", { userId: "600" }, {
      connection: authorizedConnection({
        ...connection(),
        grantedScopes: ["x.read"],
        credentials: { apiKey: "test-key" },
      }),
      principal: { type: "workspace", workspaceId: WORKSPACE_ID },
      signal: new AbortController().signal,
    });

    expect(observations).toContainEqual([
      "debug",
      "connector_provider_request_started",
      expect.objectContaining({ connector_type: "x" }),
    ]);
    expect(observations).toContainEqual([
      "info",
      "connector_operation_finished",
      expect.objectContaining({ connector_type: "x", operation: "tool_execute" }),
    ]);
  });

  it("enrolls every registered connector in adapter terminal logging", async () => {
    const observations: Parameters<ConnectorObserver>[] = [];
    const fetch = async () => Response.json({ status: "success", data: {} });
    const registry = createConnectorRegistry({
      observer: (...entry) => observations.push(entry),
      granola: { redirectUri: "https://api.rallywith.ai/connections/granola/callback", fetch },
      google: {
        clientId: "google-client",
        clientSecret: "google-secret",
        redirectUri: "https://api.rallywith.ai/connections/google/callback",
        fetch,
      },
      github: {
        appId: "1",
        clientId: "github-client",
        clientSecret: "github-secret",
        privateKey: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
        redirectUri: "https://api.rallywith.ai/connections/github/callback",
        webhookSecret: "github-webhook-secret",
        fetch,
      },
      linear: {
        clientId: "linear-client",
        clientSecret: "linear-secret",
        redirectUri: "https://api.rallywith.ai/connections/linear/callback",
        fetch,
      },
      notion: { redirectUri: "https://api.rallywith.ai/connections/notion/callback", fetch },
      slack: {
        clientId: "slack-client",
        clientSecret: "slack-secret",
        signingSecret: "slack-signing-secret",
        redirectUri: "https://api.rallywith.ai/connections/slack/callback",
        fetch,
      },
      x: { apiKey: "x-key", fetch },
    });

    await Promise.allSettled(registry.list().map((manifest) => registry.get(manifest.type).healthCheck()));

    const observedTypes = new Set(observations.flatMap(([, event, fields]) => (
      event === "connector_operation_finished"
      && fields.operation === "health_check"
      && typeof fields.connector_type === "string"
        ? [fields.connector_type]
        : []
    )));
    expect(observedTypes).toEqual(new Set(registry.list().map((manifest) => manifest.type)));
  });
});
