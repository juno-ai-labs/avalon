import { describe, expect, it } from "vitest";
import {
  ActivityQueueMessageSchema,
  AnswerElicitationRequestSchema,
  AppendNoteTranscriptSegmentRequestSchema,
  AutomationDraftSchema,
  AutomationDraftStreamEventSchema,
  ClientSocketEventSchema,
  CompileAutomationRequestSchema,
  CreateAutomationRequestSchema,
  CreateWorkstreamRequestSchema,
  CreateWorkspaceInvitationRequestSchema,
  GenerateNoteNotesRequestSchema,
  GenerateMeetingNotesRequestSchema,
  BackgroundTaskSchema,
  ConnectorManifestSchema,
  HarnessFailureCodeSchema,
  HarnessRunMetadataSchema,
  HyperSightPreferenceSchema,
  MessageSchema,
  MentionSchema,
  NoteDetailSchema,
  RefreshRequestSchema,
  PersonalSocketEventSchema,
  ServerSocketEventSchema,
  UpdateHyperSightPreferenceRequestSchema,
  UpdateHyperSightRequestSchema,
  UpdateWorkspaceRequestSchema,
  WorkspaceSchema,
  WorkstreamArtifactSchema,
  WorkstreamWorkflowInputSchema
} from "./index";

const id = "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d0";

describe("boundary contracts", () => {
  it("keeps timestamped transcript segments separate from editable note text", () => {
    const segment = AppendNoteTranscriptSegmentRequestSchema.parse({
      clientSegmentId: id,
      startOffsetMs: 1_250,
      endOffsetMs: 4_750,
      capturedAt: "2026-08-07T18:00:04.750Z",
      text: "  A finalized transcript segment.  ",
    });
    expect(segment).toMatchObject({
      startOffsetMs: 1_250,
      endOffsetMs: 4_750,
      speakerLabel: null,
      text: "A finalized transcript segment.",
    });
    expect(AppendNoteTranscriptSegmentRequestSchema.safeParse({
      ...segment,
      startOffsetMs: 5_000,
      endOffsetMs: 4_000,
    }).success).toBe(false);
    expect(NoteDetailSchema.parse({
      id,
      workspaceId: id,
      resourceId: id,
      ownerUserId: id,
      scope: "personal",
      title: "Typed notes",
      recordingStatus: "idle",
      manualNotes: "Pasted text",
      liveNotes: "",
      notesThroughSequence: 0,
      segments: [],
      recordedMs: 0,
      startedAt: null,
      endedAt: null,
      generatedAt: null,
      lastActivityAt: "2026-08-07T18:00:00.000Z",
      createdAt: "2026-08-07T18:00:00.000Z",
      updatedAt: "2026-08-07T18:00:00.000Z",
      archivedAt: null,
    }).manualNotes).toBe("Pasted text");
  });

  it("bounds and normalizes live meeting-note refreshes", () => {
    expect(GenerateMeetingNotesRequestSchema.parse({ transcript: "  New decision  " })).toEqual({
      mode: "live",
      meetingTitle: "Meeting notes",
      transcript: "New decision",
      recentTranscript: "",
      previousNotes: "",
      userNotes: "",
      startedAt: null,
      endedAt: null,
      transcriptStatus: "partial",
    });
    expect(GenerateNoteNotesRequestSchema.parse({})).toEqual({ mode: "live", transcriptStatus: "partial" });
    expect(GenerateNoteNotesRequestSchema.parse({ mode: "final", transcriptStatus: "complete" })).toEqual({
      mode: "final",
      transcriptStatus: "complete",
    });
    expect(GenerateMeetingNotesRequestSchema.safeParse({ transcript: "   " }).success).toBe(false);
    expect(GenerateMeetingNotesRequestSchema.safeParse({
      transcript: "valid",
      previousNotes: "x".repeat(50_001),
    }).success).toBe(false);
  });

  it("represents provider members as external actors without manufacturing Avalon users", () => {
    const message = MessageSchema.parse({
      id,
      clientMessageId: "slack:event:1",
      workspaceId: id,
      workstreamId: id,
      author: {
        type: "external",
        actor: {
          provider: "slack",
          providerAccountId: "T123",
          providerUserId: "U456",
          displayName: "Taylor",
          avatarUrl: null,
        },
      },
      messageType: "text",
      textContent: "Investigate this",
      structuredContent: null,
      mentions: [],
      attachments: [],
      sequenceNumber: 1,
      createdAt: "2026-08-06T00:00:00.000Z",
      editedAt: null,
    });

    expect(message.author).toMatchObject({
      type: "external",
      actor: { provider: "slack", providerUserId: "U456" },
    });
  });

  it("allows a new work stream to start with text, attachments, or both", () => {
    const base = {
      clientMessageId: id,
      participantUserIds: [],
    };
    expect(CreateWorkstreamRequestSchema.parse({
      ...base,
      openingMessage: "",
      attachmentIds: [id],
    }).attachmentIds).toEqual([id]);
    expect(CreateWorkstreamRequestSchema.safeParse({
      ...base,
      openingMessage: "",
      attachmentIds: [],
    }).success).toBe(false);
    expect(CreateWorkstreamRequestSchema.parse({
      ...base,
      openingMessage: "",
      attachmentIds: [id],
    }).objective).toBeUndefined();
  });

  it("defaults inference logging off and accepts only explicit workspace preference updates", () => {
    expect(WorkspaceSchema.parse({
      id,
      name: "Avalon",
      slug: "avalon",
      region: "global",
      role: "owner",
      timezone: "America/Los_Angeles",
      createdAt: "2026-08-05T00:00:00.000Z",
    }).logAgentInference).toBe(false);
    expect(UpdateWorkspaceRequestSchema.parse({ logAgentInference: true }))
      .toEqual({ logAgentInference: true });
    expect(UpdateWorkspaceRequestSchema.safeParse({}).success).toBe(false);
  });

  it("accepts selected, custom, and skipped elicitation responses", () => {
    expect(AnswerElicitationRequestSchema.parse({ answer: "first" })).toEqual({ answer: "first" });
    expect(AnswerElicitationRequestSchema.parse({
      answer: ["first", "A custom response"],
      customResponse: "A custom response",
    })).toEqual({
      answer: ["first", "A custom response"],
      customResponse: "A custom response",
    });
    expect(AnswerElicitationRequestSchema.parse({ skipped: true })).toEqual({ skipped: true });
    expect(AnswerElicitationRequestSchema.safeParse({ skipped: true, answer: "hidden" }).success).toBe(false);
  });

  it("carries a stable draft ID while accepting legacy automation compile requests", () => {
    expect(CompileAutomationRequestSchema.parse({
      draftId: id,
      messages: [{ role: "user", content: "Check the blog every day." }],
    })).toMatchObject({
      draftId: id,
      currentDraft: null,
      attachmentIds: [],
    });
    expect(CompileAutomationRequestSchema.parse({
      messages: [{ role: "user", content: "Check the blog every day." }],
      attachmentIds: [id],
    })).toMatchObject({ currentDraft: null, attachmentIds: [id] });
  });

  it("exposes stable member-safe harness failure codes", () => {
    expect(HarnessFailureCodeSchema.options).toEqual(expect.arrayContaining([
      "run_wall_time_limit_exceeded",
      "run_iteration_limit_exceeded",
      "run_tool_call_limit_exceeded",
      "run_cost_limit_exceeded",
      "context_limit_exceeded",
    ]));
    expect(() => HarnessFailureCodeSchema.parse("generic_limit")).toThrow();
  });

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

  it("does not cap automation plugin recommendations, defaults, or activity", () => {
    const recommendations = Array.from({ length: 25 }, (_, index) => ({
      pluginId: `plugin_service${index}`,
      recommendedTools: [`service${index}_read`],
      reason: `Use service ${index}`,
    }));
    const draft = AutomationDraftSchema.parse({
      name: "Broad automation",
      description: "Use every authorized service required by the workflow.",
      overview: "Runs the complete workflow across all required services.",
      instructions: "Use each recommended plugin to complete the workflow.",
      triggers: [{ type: "manual" }],
      requiredCapabilities: [],
      expectedOutputs: ["Completed workflow"],
      defaultBehavior: {},
      recommendedPlugins: recommendations,
      suggestedScope: "workspace",
      followUpQuestion: null,
      elicitation: null,
      ready: true,
    });

    expect(draft.recommendedPlugins).toHaveLength(25);
    const request = CreateAutomationRequestSchema.parse({
      draft,
      scope: "workspace",
      defaultPluginIds: recommendations.map((plugin) => plugin.pluginId),
    });
    expect(request.defaultPluginIds).toHaveLength(25);
    expect(request.resourceIds).toEqual([]);
    const activity = AutomationDraftStreamEventSchema.parse({
      type: "tool",
      toolCallId: "tool-1",
      name: "automation_plugins_list",
      summary: "Loaded plugins",
      status: "completed",
      plugins: recommendations.map((plugin, index) => ({
        pluginId: plugin.pluginId,
        displayName: `Service ${index}`,
        icon: "plug",
      })),
    });
    expect(activity.type).toBe("tool");
    if (activity.type !== "tool") throw new Error("Expected tool activity");
    expect(activity.plugins).toHaveLength(25);
  });

  it("validates automation-scoped durable table declarations and natural keys", () => {
    const base = {
      name: "Blog watch",
      description: "Report newly published blog entries.",
      overview: "Checks the feed and reports only entries not seen by prior runs.",
      instructions: "Query Seen entries, insert fetched entries by URL, and report only newly inserted rows.",
      triggers: [{ type: "interval" as const, intervalSeconds: 86_400, summary: "Daily" }],
      requiredCapabilities: [],
      expectedOutputs: ["New-entry report"],
      defaultBehavior: {},
      recommendedPlugins: [],
      suggestedScope: "personal" as const,
      followUpQuestion: null,
      elicitation: null,
      ready: true,
    };
    const draft = AutomationDraftSchema.parse({
      ...base,
      memoryTables: [{
        name: "Seen entries",
        description: "One row per discovered entry.",
        usageInstructions: "Seed the first run without reporting; later insert by URL and report newly inserted rows.",
        columns: [
          { name: "url", description: "Canonical entry URL", type: "url", required: true, searchable: false },
          { name: "title", description: "Entry title", type: "string", required: true, searchable: true },
        ],
        keyColumns: ["url"],
      }],
    });
    expect(draft.memoryTables[0]?.keyColumns).toEqual(["url"]);
    expect(AutomationDraftSchema.safeParse({
      ...base,
      memoryTables: [{
        name: "Broken",
        description: "Invalid key declaration.",
        usageInstructions: "Cannot be materialized.",
        columns: [{ name: "url", description: "URL", type: "url", required: true, searchable: false }],
        keyColumns: ["missing"],
      }],
    }).success).toBe(false);
  });

  it("validates ordered socket mutations", () => {
    expect(
      ClientSocketEventSchema.parse({
        type: "subscribe",
        afterSequence: 42
      })
    ).toEqual({ type: "subscribe", afterSequence: 42 });
  });

  it("bounds HyperSight configuration and preserves unique block identities", () => {
    expect(UpdateHyperSightRequestSchema.parse({
      expectedVersionNumber: 3,
      blocks: [{ id, prompt: "Give me the last five to-do items" }],
    })).toEqual({
      expectedVersionNumber: 3,
      blocks: [{ id, prompt: "Give me the last five to-do items" }],
    });
    expect(UpdateHyperSightRequestSchema.safeParse({
      expectedVersionNumber: 3,
      blocks: [{ id, prompt: "First" }, { id, prompt: "Duplicate" }],
    }).success).toBe(false);
    expect(UpdateHyperSightRequestSchema.safeParse({
      expectedVersionNumber: 3,
      blocks: Array.from({ length: 25 }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        prompt: "Too many",
      })),
    }).success).toBe(false);
  });

  it("validates personal HyperSight visibility preferences and their realtime updates", () => {
    expect(UpdateHyperSightPreferenceRequestSchema.parse({ visible: true })).toEqual({ visible: true });
    expect(UpdateHyperSightPreferenceRequestSchema.safeParse({ visible: true, shared: true }).success).toBe(false);
    const preference = HyperSightPreferenceSchema.parse({
      visible: true,
      updatedAt: "2026-08-07T20:00:00.000Z",
    });
    expect(PersonalSocketEventSchema.parse({
      type: "hypersight_preference_updated",
      occurredAt: "2026-08-07T20:00:00.000Z",
      preference,
    })).toMatchObject({ type: "hypersight_preference_updated", preference });
    expect(ServerSocketEventSchema.safeParse({
      type: "hypersight_preference_updated",
      sequence: 44,
      occurredAt: "2026-08-07T20:00:00.000Z",
      preference,
    }).success).toBe(false);
  });

  it("keeps room replay sequence separate from Bind stream epochs", () => {
    expect(ServerSocketEventSchema.parse({
      type: "stream_delta",
      sequence: 42,
      occurredAt: "2026-07-31T20:00:00.000Z",
      messageId: id,
      turnId: "turn-1",
      epoch: 2,
      streamSeq: 7,
      reset: true,
      delta: ""
    })).toMatchObject({ sequence: 42, epoch: 2, streamSeq: 7, reset: true });
    expect(ServerSocketEventSchema.safeParse({
      type: "stream_started",
      sequence: 43,
      occurredAt: "2026-07-31T20:00:00.000Z",
      messageId: id,
      harnessRunId: id,
      turnId: "turn-1",
      epoch: 2,
      streamSeq: 0,
      reset: true
    }).success).toBe(false);
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
      status: "failed",
      model: "google/gemini-2.5-flash-lite",
      error: {
        code: "context_limit_exceeded",
        message: "The run exceeded the selected model context window."
      },
      requestId: id,
      startedAt: "2026-07-31T20:00:00.000Z",
      completedAt: "2026-07-31T20:00:12.000Z",
      createdAt: "2026-07-31T20:00:00.000Z"
    })).toMatchObject({
      id,
      origin: "human_message",
      status: "failed",
      error: { code: "context_limit_exceeded" },
      requestId: id
    });
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
