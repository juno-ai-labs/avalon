import { describe, expect, it } from "vitest";
import {
  ActivityQueueMessageSchema,
  AutomationDraftSchema,
  ClientSocketEventSchema,
  CreateWorkspaceInvitationRequestSchema,
  BackgroundTaskSchema,
  ConnectorManifestSchema,
  HarnessRunMetadataSchema,
  MentionSchema,
  RefreshRequestSchema,
  WorkstreamArtifactSchema,
  WorkstreamWorkflowInputSchema
} from "./index";

const id = "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d0";

describe("boundary contracts", () => {
  it("carries authoritative person presentation metadata with a mention", () => {
    expect(MentionSchema.parse({
      type: "person",
      userId: id,
      connectorType: null,
      displayName: "Ada Lovelace",
      avatarUrl: "https://example.com/ada.png",
      startOffset: 4,
      endOffset: 17
    })).toMatchObject({
      type: "person",
      displayName: "Ada Lovelace",
      avatarUrl: "https://example.com/ada.png"
    });
  });

  it("keeps Queue payloads opaque", () => {
    const value = ActivityQueueMessageSchema.parse({
      region: "eu",
      workspaceId: id,
      activityId: id
    });
    expect(Object.keys(value).sort()).toEqual(["activityId", "attempt", "region", "workspaceId"]);
  });

  it("rejects unsafe interval schedules", () => {
    const result = AutomationDraftSchema.safeParse({
      name: "Too often",
      description: "An invalid tight loop",
      instructions: "Poll continuously",
      triggers: [{ type: "interval", intervalSeconds: 5, summary: "Every five seconds" }],
      requiredCapabilities: [],
      expectedOutputs: [],
      defaultBehavior: {},
      suggestedScope: "personal",
      followUpQuestion: null,
      ready: true
    });
    expect(result.success).toBe(false);
  });

  it("validates ordered socket mutations", () => {
    expect(
      ClientSocketEventSchema.parse({
        type: "subscribe",
        afterSequence: 42
      })
    ).toEqual({ type: "subscribe", afterSequence: 42 });
  });

  it("requires an explicit execution principal", () => {
    const result = WorkstreamWorkflowInputSchema.safeParse({
      region: "global",
      workspaceId: id,
      workstreamId: id,
      harnessRunId: id,
      triggerMessageId: null,
      automationSubscriptionId: null,
      activityId: null,
      reason: "message"
    });
    expect(result.success).toBe(false);
  });

  it("exposes bounded harness-run metadata for the contextual rail", () => {
    expect(HarnessRunMetadataSchema.parse({
      id,
      origin: "human_message",
      status: "completed",
      model: "google/gemini-2.5-flash-lite",
      startedAt: "2026-07-31T20:00:00.000Z",
      completedAt: "2026-07-31T20:00:12.000Z",
      createdAt: "2026-07-31T20:00:00.000Z"
    })).toMatchObject({ id, origin: "human_message", status: "completed" });
  });

  it("carries durable work-stream outputs and task records across reloads", () => {
    expect(WorkstreamArtifactSchema.parse({
      id,
      workspaceId: id,
      workstreamId: id,
      harnessRunId: id,
      artifactType: "markdown",
      title: "Launch brief",
      previewText: "First persisted lines",
      status: "complete",
      mimeType: "text/markdown; charset=utf-8",
      createdAt: "2026-07-31T20:00:00.000Z",
      updatedAt: "2026-07-31T20:00:01.000Z"
    })).toMatchObject({ title: "Launch brief", status: "complete" });
    expect(BackgroundTaskSchema.parse({
      id,
      harnessRunId: id,
      title: "Respond to message",
      taskType: "agent",
      status: "completed",
      startedAt: "2026-07-31T20:00:00.000Z",
      completedAt: "2026-07-31T20:00:12.000Z",
      tokenCount: 1250,
      toolUses: 3,
      transcriptMessageId: id
    })).toMatchObject({ taskType: "agent", tokenCount: 1250, toolUses: 3 });
  });

  it("defaults invitations to members and never permits owner grants", () => {
    expect(CreateWorkspaceInvitationRequestSchema.parse({ email: " Teammate@Example.com " }))
      .toEqual({ email: "Teammate@Example.com", role: "member" });
    expect(CreateWorkspaceInvitationRequestSchema.safeParse({
      email: "teammate@example.com",
      role: "owner",
    }).success).toBe(false);
  });

  it("bounds refresh-token inputs before the API hashes them", () => {
    expect(RefreshRequestSchema.safeParse({ refreshToken: "a".repeat(64) }).success).toBe(true);
    expect(RefreshRequestSchema.safeParse({ refreshToken: "a".repeat(501) }).success).toBe(false);
    expect(RefreshRequestSchema.safeParse({ refreshToken: `${"a".repeat(63)}!` }).success).toBe(false);
  });

  it("normalizes legacy connectors to the resource surface", () => {
    const manifest = ConnectorManifestSchema.parse({
      type: "legacy",
      displayName: "Legacy connector",
      supportedScopes: ["workspace"],
      oauthRequired: false,
      activityTypes: [],
      resourceTypes: ["legacy_resource"],
      tools: [],
      supportsWatches: false,
      supportsPolling: false,
      supportsWebhooks: false
    });
    expect(manifest.surfaces).toEqual(["resource"]);
    expect(manifest.capabilities).toEqual([]);
    expect(manifest.nativeAgent).toBeUndefined();
  });

  it("requires native-agent declarations to be complete and explicit", () => {
    const base = {
      type: "agent-provider",
      displayName: "Agent provider",
      supportedScopes: ["workspace"] as const,
      oauthRequired: true,
      activityTypes: [],
      resourceTypes: [],
      tools: [],
      supportsWatches: false,
      supportsPolling: false,
      supportsWebhooks: true
    };
    expect(ConnectorManifestSchema.safeParse({
      ...base,
      surfaces: ["resource", "native_agent"],
      capabilities: [{ id: "provider.agent", kind: "native_agent" }]
    }).success).toBe(false);
    expect(ConnectorManifestSchema.safeParse({
      ...base,
      capabilities: [{ id: "provider.agent", kind: "native_agent" }],
      nativeAgent: {
        capability: "provider.agent",
        invocationModes: ["delegation"],
        activityKinds: ["response", "error"],
        supportsCancellation: true,
        supportsExternalLinks: true,
        supportsPlans: false,
        runtimeStatus: "protocol_only",
        sessionOwnership: "single_connection_per_provider_account"
      }
    }).success).toBe(false);
    expect(ConnectorManifestSchema.parse({
      ...base,
      surfaces: ["resource", "native_agent"],
      capabilities: [{ id: "provider.agent", kind: "native_agent" }],
      nativeAgent: {
        capability: "provider.agent",
        invocationModes: ["delegation", "mention", "follow_up"],
        activityKinds: ["thought", "action", "elicitation", "response", "error"],
        supportsCancellation: true,
        supportsExternalLinks: true,
        supportsPlans: true,
        supportsProactiveSessions: true,
        maturity: "preview",
        runtimeStatus: "protocol_only",
        sessionOwnership: "single_connection_per_provider_account",
        webhookResponseDeadlineMs: 5_000,
        sessionAcknowledgementDeadlineMs: 10_000
      }
    })).toMatchObject({
      surfaces: ["resource", "native_agent"],
      nativeAgent: {
        maturity: "preview",
        runtimeStatus: "protocol_only",
        sessionOwnership: "single_connection_per_provider_account",
        supportsProactiveSessions: true,
        webhookResponseDeadlineMs: 5_000,
        sessionAcknowledgementDeadlineMs: 10_000
      }
    });
    expect(ConnectorManifestSchema.safeParse({
      ...base,
      surfaces: ["resource", "native_agent"],
      capabilities: [{ id: "provider.other_agent", kind: "native_agent" }],
      nativeAgent: {
        capability: "provider.agent",
        invocationModes: ["delegation"],
        activityKinds: ["response", "error"],
        supportsCancellation: true,
        supportsExternalLinks: true,
        supportsPlans: false,
        runtimeStatus: "protocol_only",
        sessionOwnership: "single_connection_per_provider_account"
      }
    }).success).toBe(false);
  });

  it("promotes legacy tool grants into manifest-level capability descriptors", () => {
    const manifest = ConnectorManifestSchema.parse({
      type: "tool-provider",
      displayName: "Tool provider",
      supportedScopes: ["workspace"],
      oauthRequired: true,
      activityTypes: [],
      resourceTypes: [],
      tools: [{
        name: "provider.search",
        description: "Search provider resources.",
        inputSchema: { type: "object" },
        capability: "provider.read",
        mode: "read",
        idempotency: "safe"
      }],
      supportsWatches: false,
      supportsPolling: false,
      supportsWebhooks: false
    });
    expect(manifest.capabilities).toEqual([{ id: "provider.read", kind: "tool" }]);
  });
});
