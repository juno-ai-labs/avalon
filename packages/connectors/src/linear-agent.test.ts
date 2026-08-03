import { describe, expect, it, vi } from "vitest";
import {
  createLinearNativeAgentProtocol,
  executeLinearAgentGraphql,
  isLinearAgentStopRequest,
  linearAgentActivity,
  linearAgentInvocation,
  LinearAgentActivityCreateInputSchema,
  LinearNativeAgentProtocolDescriptor,
  parseVerifiedLinearAgentSessionEvent,
  type LinearAgentGraphqlExecutor,
} from "./linear-agent";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const ACTIVITY_ID = "22222222-2222-4222-8222-222222222222";
const DELIVERY_ID = "33333333-3333-4333-8333-333333333333";

describe("Linear native agent protocol", () => {
  it("parses a verified created event into a start command without dropping source context", () => {
    const verified = parseVerifiedLinearAgentSessionEvent({
      deliveryId: DELIVERY_ID,
      eventName: "AgentSessionEvent",
      organizationId: "linear-org-1",
      webhookId: "linear-webhook-1",
      webhookTimestamp: 1_788_000_000_000,
      bodyHash: "a".repeat(64),
      event: createdEvent(),
    });
    const invocation = linearAgentInvocation(verified.event);
    expect(invocation).toMatchObject({
      kind: "start",
      sessionId: SESSION_ID,
      organizationId: "linear-org-1",
      appUserId: "app-user-1",
      prompt: "<issue identifier=\"AVA-42\">Ship native agents</issue>",
      issueId: "issue-1",
    });
    expect(invocation.event.experimentalFutureField).toEqual({ retained: true });
  });

  it("turns a prompted stop signal into an immediate cancellation command", () => {
    const event = promptedEvent("stop");
    expect(linearAgentInvocation(event)).toMatchObject({
      kind: "prompt",
      prompt: "Stop this run",
      promptActivityId: ACTIVITY_ID,
      stopRequested: true,
    });
    expect(isLinearAgentStopRequest(event)).toBe(true);
    expect(linearAgentActivity.stopped(SESSION_ID, undefined, { id: ACTIVITY_ID })).toEqual({
      agentSessionId: SESSION_ID,
      id: ACTIVITY_ID,
      content: { type: "response", body: "Stopped as requested." },
    });
  });

  it("rejects mismatched signed envelope and session identities", () => {
    expect(() => parseVerifiedLinearAgentSessionEvent({
      deliveryId: DELIVERY_ID,
      eventName: "AgentSessionEvent",
      organizationId: "wrong-org",
      webhookId: "linear-webhook-1",
      webhookTimestamp: 1_788_000_000_000,
      bodyHash: "a".repeat(64),
      event: createdEvent(),
    })).toThrow(/organization/i);

    const event = createdEvent();
    event.agentSession.appUserId = "wrong-agent";
    expect(() => linearAgentInvocation(event)).toThrow(/app user/i);
  });

  it("models only valid agent-authored activity, ephemerality, and signals", () => {
    expect(linearAgentActivity.thought(SESSION_ID, "Inspecting the issue", { id: ACTIVITY_ID, ephemeral: true })).toEqual({
      agentSessionId: SESSION_ID,
      id: ACTIVITY_ID,
      content: { type: "thought", body: "Inspecting the issue" },
      ephemeral: true,
    });
    expect(linearAgentActivity.auth(SESSION_ID, "Link GitHub", {
      url: "https://with-avalon.com/connect/github",
      userId: "user-1",
      providerName: "GitHub",
    }, { id: ACTIVITY_ID })).toMatchObject({ signal: "auth" });
    expect(linearAgentActivity.select(SESSION_ID, "Choose a repository", [
      { label: "Avalon", value: "juno-ai-labs/avalon" },
    ], { id: ACTIVITY_ID })).toMatchObject({ signal: "select" });

    expect(() => LinearAgentActivityCreateInputSchema.parse({
      agentSessionId: SESSION_ID,
      content: { type: "response", body: "Done" },
      ephemeral: true,
    })).toThrow(/ephemeral/i);
    expect(() => LinearAgentActivityCreateInputSchema.parse({
      agentSessionId: SESSION_ID,
      content: { type: "thought", body: "Working" },
      signal: "auth",
      signalMetadata: { url: "https://with-avalon.com/connect" },
    })).toThrow(/elicitation/i);
  });

  it("publishes native activities and returns the provider operation ID", async () => {
    const executeGraphql = vi.fn<LinearAgentGraphqlExecutor>().mockResolvedValue({
      agentActivityCreate: { success: true, agentActivity: { id: ACTIVITY_ID } },
    });
    const protocol = createLinearNativeAgentProtocol(executeGraphql);
    const activity = linearAgentActivity.action(SESSION_ID, "Searching", "Avalon issues", {
      id: ACTIVITY_ID,
      result: "Found AVA-42",
    });
    await expect(protocol.execute({ kind: "publish_activity", activity })).resolves.toEqual({
      success: true,
      agentActivityId: ACTIVITY_ID,
    });
    expect(executeGraphql).toHaveBeenCalledWith(
      expect.stringContaining("agentActivityCreate"),
      { input: activity },
      undefined,
    );
    expect(protocol.descriptor).toBe(LinearNativeAgentProtocolDescriptor);
  });

  it("replaces external URLs and full plans through session updates", async () => {
    const executeGraphql = vi.fn<LinearAgentGraphqlExecutor>().mockResolvedValue({
      agentSessionUpdate: { success: true, agentSession: { id: SESSION_ID, status: "active" } },
    });
    const protocol = createLinearNativeAgentProtocol(executeGraphql);
    await protocol.execute({
      kind: "replace_external_urls",
      agentSessionId: SESSION_ID,
      externalUrls: [{ label: "Open in Avalon", url: "https://with-avalon.com/workstreams/abc" }],
    });
    await protocol.execute({
      kind: "replace_plan",
      agentSessionId: SESSION_ID,
      plan: [
        { content: "Inspect the issue", status: "completed" },
        { content: "Implement the change", status: "inProgress" },
      ],
    });
    expect(executeGraphql.mock.calls[0]?.[1]).toEqual({
      id: SESSION_ID,
      input: { externalUrls: [{ label: "Open in Avalon", url: "https://with-avalon.com/workstreams/abc" }] },
    });
    expect(executeGraphql.mock.calls[1]?.[1]).toEqual({
      id: SESSION_ID,
      input: { plan: [
        { content: "Inspect the issue", status: "completed" },
        { content: "Implement the change", status: "inProgress" },
      ] },
    });
  });

  it("creates proactive sessions on issues through the same runtime-only protocol", async () => {
    const executeGraphql = vi.fn<LinearAgentGraphqlExecutor>().mockResolvedValue({
      agentSessionCreateOnIssue: { success: true, agentSession: { id: SESSION_ID, status: "pending" } },
    });
    const protocol = createLinearNativeAgentProtocol(executeGraphql);
    await expect(protocol.execute({
      kind: "create_session_on_issue",
      issueId: "AVA-42",
      externalUrls: [{ label: "Open in Avalon", url: "https://with-avalon.com/workstreams/abc" }],
    })).resolves.toEqual({ success: true, agentSessionId: SESSION_ID, status: "pending" });
    expect(executeGraphql.mock.calls[0]?.[0]).toContain("agentSessionCreateOnIssue");
  });

  it("treats GraphQL errors on HTTP 200 as provider failures", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: { agentActivityCreate: null },
      errors: [{ message: "Agent session not found" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(executeLinearAgentGraphql(
      fetcher,
      "linear-access-token",
      "mutation Test { test }",
      {},
    )).rejects.toThrow(/session not found/i);
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer linear-access-token");
  });
});

function createdEvent() {
  return {
    type: "AgentSessionEvent" as const,
    action: "created" as const,
    appUserId: "app-user-1",
    oauthClientId: "oauth-client-1",
    organizationId: "linear-org-1",
    webhookId: "linear-webhook-1",
    webhookTimestamp: 1_788_000_000_000,
    createdAt: "2026-08-02T12:00:00.000Z",
    promptContext: "<issue identifier=\"AVA-42\">Ship native agents</issue>",
    guidance: [{ body: "Keep updates concise", origin: { type: "team", teamId: "team-1" } }],
    previousComments: [],
    agentActivity: null,
    agentSession: {
      id: SESSION_ID,
      appUserId: "app-user-1",
      organizationId: "linear-org-1",
      status: "pending" as const,
      type: "commentThread",
      createdAt: "2026-08-02T12:00:00.000Z",
      updatedAt: "2026-08-02T12:00:00.000Z",
      issueId: "issue-1",
      issue: {
        id: "issue-1",
        identifier: "AVA-42",
        teamId: "team-1",
        team: { id: "team-1", key: "AVA", name: "Avalon" },
        title: "Ship native agents",
        description: "Build the native protocol",
        url: "https://linear.app/juno/issue/AVA-42/ship-native-agents",
      },
    },
    experimentalFutureField: { retained: true },
  };
}

function promptedEvent(signal: "stop" | "continue" | null = null) {
  const event = createdEvent();
  return {
    ...event,
    action: "prompted" as const,
    promptContext: null,
    agentActivity: {
      id: ACTIVITY_ID,
      agentSessionId: SESSION_ID,
      content: { type: "prompt", body: "Stop this run" },
      createdAt: "2026-08-02T12:01:00.000Z",
      updatedAt: "2026-08-02T12:01:00.000Z",
      signal,
      signalMetadata: null,
      userId: "user-1",
      user: {
        id: "user-1",
        name: "Adam",
        email: "adam@example.com",
        url: "https://linear.app/juno/profiles/user-1",
      },
    },
  };
}
