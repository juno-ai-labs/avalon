import { describe, expect, it } from "vitest";
import {
  readStructuredFailure,
  ActivityQueueMessageSchema,
  ActiveStreamCheckpointSchema,
  AnswerElicitationRequestSchema,
  AppendNoteTranscriptSegmentRequestSchema,
  AutomationDeliveryTargetSetSchema,
  AutomationDraftSchema,
  AutomationDraftStreamEventSchema,
  AGENT_MODEL_FLAG_KEYS,
  AGENT_MODEL_OVERRIDES,
  AGENT_MODEL_ROLES,
  AgentModelRoutingSchema,
  ClientSocketEventSchema,
  CompileAutomationRequestSchema,
  ConnectorOAuthProviderSchema,
  ConnectorOAuthProviders,
  CreateAutomationRequestSchema,
  CreateWorkstreamRequestSchema,
  CreateWorkspaceInvitationRequestSchema,
  GenerateNoteNotesRequestSchema,
  GenerateMeetingNotesRequestSchema,
  BackgroundTaskSchema,
  ConnectorManifestSchema,
  HarnessFailureCodeSchema,
  HarnessRunMetadataSchema,
  BlockDashboardPreferenceSchema,
  BlockDashboardBlockSocketEventSchema,
  MessageSchema,
  MentionSchema,
  NoteDetailSchema,
  RESOURCE_RELATIONSHIP_TYPES,
  RefreshRequestSchema,
  ResourceRelationshipTypeSchema,
  ResourceRevisionSchema,
  ResourceSchema,
  resourceDirectionForRelationship,
  PersonalSocketEventSchema,
  ServerSocketEventSchema,
  StartWorkOpportunityRequestSchema,
  SubstreamDirectSocketEventSchema,
  UpdateBlockDashboardPreferenceRequestSchema,
  UpdateBlockDashboardRequestSchema,
  UpdateWorkspaceRequestSchema,
  WorkspaceSchema,
  WorkstreamContextSchema,
  WorkstreamSocketCommandResultSchema,
  WorkstreamWorkflowInputSchema
} from "./index";

const id = "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d0";

describe("boundary contracts", () => {
  it("derives artifacts only from generated work-stream relationships", () => {
    expect(ResourceRelationshipTypeSchema.options).toEqual(RESOURCE_RELATIONSHIP_TYPES);
    expect(ResourceRelationshipTypeSchema.safeParse("made_up").success).toBe(false);
    expect(resourceDirectionForRelationship("generated")).toBe("artifact");
    expect(resourceDirectionForRelationship("origin")).toBe("source");
    expect(resourceDirectionForRelationship("attachment")).toBe("source");
  });

  it("adds a bounded optional suggested-work surface without breaking older clients", () => {
    const legacy = { version: 3, idempotencyKey: "legacy-attempt" };
    expect(StartWorkOpportunityRequestSchema.safeParse(legacy).success).toBe(true);
    expect(StartWorkOpportunityRequestSchema.parse({
      ...legacy,
      surface: "menu_bar",
    })).toMatchObject({ surface: "menu_bar" });
    expect(StartWorkOpportunityRequestSchema.safeParse({
      ...legacy,
      surface: "private-screen-name",
    }).success).toBe(false);
  });

  it("uses one connector OAuth provider catalog across protocol consumers", () => {
    expect(ConnectorOAuthProviderSchema.options).toEqual(ConnectorOAuthProviders);
    expect(ConnectorOAuthProviders).toContain("granola");
  });

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
      refreshSeconds: null,
    });
    expect(GenerateNoteNotesRequestSchema.parse({})).toEqual({ mode: "live", transcriptStatus: "partial" });
    expect(GenerateNoteNotesRequestSchema.parse({ mode: "final", transcriptStatus: "complete" })).toEqual({
      mode: "final",
      transcriptStatus: "complete",
    });
    // The cadence a client may claim is bounded by what the flag itself could
    // serve, so a request cannot ask the prompt to describe a schedule the
    // service would never hand out.
    expect(GenerateNoteNotesRequestSchema.parse({ refreshSeconds: 15 }).refreshSeconds).toBe(15);
    expect(GenerateNoteNotesRequestSchema.safeParse({ refreshSeconds: 5 }).success).toBe(false);
    expect(GenerateNoteNotesRequestSchema.safeParse({ refreshSeconds: 60_000 }).success).toBe(false);
    expect(GenerateNoteNotesRequestSchema.safeParse({ refreshSeconds: 60.5 }).success).toBe(false);
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
    const attachmentOnly = CreateWorkstreamRequestSchema.parse({
      ...base,
      openingMessage: "",
      attachmentIds: [id],
    });
    expect(attachmentOnly.objective).toBeUndefined();
    expect(attachmentOnly.mentions).toEqual([]);
    expect(CreateWorkstreamRequestSchema.parse({
      ...base,
      openingMessage: "Ask @Adam",
      mentions: [{
        type: "person",
        userId: id,
        connectorType: null,
        startOffset: 4,
        endOffset: 9,
      }],
    }).mentions).toEqual([{
      type: "person",
      userId: id,
      connectorType: null,
      startOffset: 4,
      endOffset: 9,
    }]);
  });

  it("accepts a model override only from the closed list of selectable models", () => {
    const base = {
      clientMessageId: id,
      participantUserIds: [],
      openingMessage: "Prepare the launch brief",
    };
    // Unpinned is the normal shape: absent rather than null, so the flag decides.
    expect(CreateWorkstreamRequestSchema.parse(base).modelOverride).toBeUndefined();
    expect(CreateWorkstreamRequestSchema.parse({ ...base, modelOverride: "deepseek/deepseek-v4-pro" }).modelOverride)
      .toBe("deepseek/deepseek-v4-pro");
    // An override bypasses the rollout, so the reachable set is reviewed here
    // rather than being whatever string a client sends.
    expect(CreateWorkstreamRequestSchema.safeParse({ ...base, modelOverride: "x-ai/grok-9" }).success).toBe(false);
    expect(AGENT_MODEL_OVERRIDES[0]).toBe("x-ai/grok-4.3");
    expect(new Set(AGENT_MODEL_OVERRIDES).size).toBe(AGENT_MODEL_OVERRIDES.length);
  });

  it("owns the complete model-role, Flagship-key, and route-value contract", () => {
    expect(AGENT_MODEL_ROLES).toEqual([
      "workstream",
      "inline_child",
      "automation_compiler",
      "block_dashboard",
      "meeting_notes",
      "addressing_classifier",
      "workstream_naming",
      "activity_structured",
      "work_opportunity_admission",
      "work_opportunity_ranking",
      "workstream_description",
    ]);
    expect(AGENT_MODEL_ROLES.map((role) => AGENT_MODEL_FLAG_KEYS[role])).toEqual([
      "agent-model-workstream",
      "agent-model-inline-child",
      "agent-model-automation-compiler",
      "agent-model-block-dashboard",
      "agent-model-meeting-notes",
      "agent-model-addressing-classifier",
      "agent-model-workstream-naming",
      "agent-model-activity-structured",
      "agent-model-work-opportunity-admission",
      "agent-model-work-opportunity-ranking",
      "agent-model-workstream-description",
    ]);
    expect(AgentModelRoutingSchema.parse({ model: " x-ai/grok-4.3 " })).toEqual({
      model: "x-ai/grok-4.3",
      fallbackModels: [],
    });
  });

  it("accepts only explicit workspace timezone updates", () => {
    expect(WorkspaceSchema.parse({
      id,
      name: "Avalon",
      slug: "avalon",
      region: "global",
      role: "owner",
      timezone: "America/Los_Angeles",
      createdAt: "2026-08-05T00:00:00.000Z",
    }).timezone).toBe("America/Los_Angeles");
    expect(UpdateWorkspaceRequestSchema.parse({ timezone: "Europe/London" }))
      .toEqual({ timezone: "Europe/London" });
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
      "tool_receipt_persistence_failed",
      "run_state_persistence_failed",
      // The two provider arms are separate on purpose: one says Avalon called
      // and got nothing, the other that Avalon declined to call. Neither may
      // collapse back into `harness_execution_failed`, which means Avalon's own
      // defect and tells a member not to bother retrying.
      "provider_unavailable",
      "provider_circuit_open",
      // The platform refusing to carry a subrequest is not the port that asked
      // failing. Collapsing it back would restore the misattribution that cost
      // a work stream on 2026-08-24.
      "platform_limit_exceeded",
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

  it("requires exact source slots on ready activity-triggered drafts", () => {
    const base = {
      name: "Merged PR follow-up",
      description: "Respond when a pull request merges.",
      overview: "Starts work from merged pull requests.",
      instructions: "Review the merged pull request and prepare the follow-up.",
      requiredCapabilities: [],
      expectedOutputs: [],
      defaultBehavior: {},
      recommendedPlugins: [],
      memoryTables: [],
      suggestedScope: "personal",
      followUpQuestion: null,
      elicitation: null,
      ready: true,
    };
    expect(AutomationDraftSchema.safeParse({
      ...base,
      triggers: [{
        type: "connector_activity",
        connectorType: "github",
        eventTypes: ["github.pull_request.merged"],
        deterministicFilters: {},
      }],
    }).success).toBe(false);
    expect(AutomationDraftSchema.safeParse({
      ...base,
      triggers: [{
        type: "connector_activity",
        connectorType: "github",
        sourceBindingKey: "github_source",
        suggestedSourcePluginId: "plugin_github",
        eventTypes: ["github.pull_request.merged"],
        deterministicFilters: {},
      }],
    }).success).toBe(true);
  });

  it("allows incomplete source fields while an activity draft is not ready", () => {
    const result = AutomationDraftSchema.safeParse({
      name: "Draft activity automation",
      description: "Still choosing an activity source.",
      overview: "Waits for the requested connector activity.",
      instructions: "Ask which connector should provide the activity.",
      triggers: [{
        type: "connector_activity",
        connectorType: "github",
        sourceBindingKey: "github_source",
        eventTypes: ["github.issue.opened"],
        deterministicFilters: {},
      }],
      requiredCapabilities: [],
      expectedOutputs: [],
      defaultBehavior: {},
      recommendedPlugins: [],
      memoryTables: [],
      suggestedScope: "personal",
      followUpQuestion: "Which GitHub connection should Avalon use?",
      elicitation: null,
      ready: false,
    });
    expect(result.success).toBe(true);
  });

  // Before `automation_submit_draft` declared a `validateInput`, none of these
  // messages or paths ever reached a model — they were swallowed into the
  // runtime's generic "could not validate its data" sentence. They are now the
  // compiler's entire correction vocabulary, so a path that names a field the
  // model cannot find puts the compile back in the loop that made it a bug.
  it("names the exact field for every readiness refinement", () => {
    const base = {
      name: "Contract watch",
      description: "Escalate changed customer contracts.",
      overview: "Watches the authorized connection and escalates changed contracts.",
      instructions: "1. Read the change.\n2. Escalate a contract.\n3. Record a no-change result.",
      requiredCapabilities: [],
      expectedOutputs: ["Escalation"],
      defaultBehavior: {},
      recommendedPlugins: [],
      memoryTables: [],
      suggestedScope: "personal",
      followUpQuestion: null,
      elicitation: null,
      ready: true,
    };
    const activity = {
      type: "semantic_activity",
      connectorType: "google",
      sourceBindingKey: "drive_source",
      suggestedSourcePluginId: "plugin_google",
      deterministicPrefilter: { eventType: "drive.file_changed" },
      condition: "The changed file is a customer contract.",
    };
    const memoryTable = (name: string) => ({
      name,
      description: "Seen contracts.",
      usageInstructions: "One row per contract.",
      columns: [{ name: "id", description: "Contract id.", type: "string", required: true, searchable: false }],
      keyColumns: ["id"],
    });
    const omit = (trigger: Record<string, unknown>, key: string) =>
      Object.fromEntries(Object.entries(trigger).filter(([entry]) => entry !== key));

    const cases: Array<[string, Record<string, unknown>, Array<string | number>, string]> = [
      ["memory table name", { ...base, triggers: [{ type: "manual" }], memoryTables: [memoryTable("Seen"), memoryTable("seen")] },
        ["memoryTables", 1, "name"], "Memory-table names must be unique within an automation"],
      ["binding key", { ...base, triggers: [omit(activity, "sourceBindingKey")] },
        ["triggers", 0, "sourceBindingKey"], "Ready activity triggers require a source binding key"],
      ["source plugin", { ...base, triggers: [omit(activity, "suggestedSourcePluginId")] },
        ["triggers", 0, "suggestedSourcePluginId"], "Ready activity triggers require an inspected source plugin"],
      ["connector type", { ...base, triggers: [{ ...activity, connectorType: null }] },
        ["triggers", 0, "connectorType"], "Ready semantic activity triggers require a concrete connector type"],
      ["prefilter event type", { ...base, triggers: [{ ...activity, deterministicPrefilter: {} }] },
        ["triggers", 0, "deterministicPrefilter", "eventType"], "Ready semantic activity triggers require one declared event type"],
      ["reused binding key", { ...base, triggers: [activity, { ...activity, connectorType: "slack" }] },
        ["triggers", 1, "sourceBindingKey"], "Reused activity source binding keys must identify the same connector and suggested plugin"],
    ];

    for (const [label, draft, path, message] of cases) {
      const result = AutomationDraftSchema.safeParse(draft);
      expect(result.success, label).toBe(false);
      expect(result.error!.issues, label).toContainEqual(
        expect.objectContaining({ path: [...path], message }),
      );
    }
  });

  it("requires an exact event type for ready semantic activity triggers", () => {
    const result = AutomationDraftSchema.safeParse({
      name: "Important GitHub activity",
      description: "Respond to important GitHub activity.",
      overview: "Evaluates matching GitHub activity semantically.",
      instructions: "Decide whether the activity requires a follow-up.",
      triggers: [{
        type: "semantic_activity",
        connectorType: "github",
        sourceBindingKey: "github_source",
        suggestedSourcePluginId: "plugin_github",
        deterministicPrefilter: {},
        condition: "The issue needs urgent attention.",
      }],
      requiredCapabilities: [],
      expectedOutputs: [],
      defaultBehavior: {},
      recommendedPlugins: [],
      memoryTables: [],
      suggestedScope: "personal",
      followUpQuestion: null,
      elicitation: null,
      ready: true,
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
    // A row is attributed to the one plugin that owns its tool, never to a set.
    const activity = AutomationDraftStreamEventSchema.parse({
      type: "tool",
      toolCallId: "tool-1",
      name: "Reviewed Service 0",
      summary: "Read the authorized service",
      status: "completed",
      plugin: { pluginId: recommendations[0]!.pluginId, displayName: "Service 0", icon: "plug" },
    });
    expect(activity.type).toBe("tool");
    if (activity.type !== "tool") throw new Error("Expected tool activity");
    expect(activity.plugin).toEqual({
      pluginId: recommendations[0]!.pluginId,
      displayName: "Service 0",
      icon: "plug",
    });

    const unattributed = AutomationDraftStreamEventSchema.parse({
      type: "tool",
      toolCallId: "tool-2",
      name: "Searched the public web",
      summary: "Web search completed",
      status: "completed",
    });
    if (unattributed.type !== "tool") throw new Error("Expected tool activity");
    expect(unattributed.plugin).toBeNull();
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

  it("takes a snapshot request with no cursor and rejects one carrying state", () => {
    expect(ClientSocketEventSchema.parse({ type: "request_snapshot" }))
      .toEqual({ type: "request_snapshot" });
    // A viewer asking for canonical state is saying its own may be wrong, so a
    // cursor it supplied is the one input that must not bound the answer.
    expect(ClientSocketEventSchema.safeParse({
      type: "request_snapshot",
      afterSequence: 42,
    }).success).toBe(false);
  });

  it("validates ordered socket mutations", () => {
    expect(
      ClientSocketEventSchema.parse({
        type: "subscribe",
        afterSequence: 42
      })
    ).toEqual({ type: "subscribe", afterSequence: 42, publishPresence: true });
    expect(ClientSocketEventSchema.parse({
      type: "subscribe",
      afterSequence: 42,
      publishPresence: false,
    })).toEqual({ type: "subscribe", afterSequence: 42, publishPresence: false });
    expect(ClientSocketEventSchema.parse({
      type: "create_message",
      operationId: id,
      payload: { text: "Continue", clientMessageId: "client-message-one" },
    })).toMatchObject({
      type: "create_message",
      operationId: id,
      payload: {
        text: "Continue",
        clientMessageId: "client-message-one",
        mentions: [],
        confirmedParticipantUserIds: [],
        attachmentIds: [],
      },
    });
    expect(WorkstreamSocketCommandResultSchema.safeParse({
      type: "client_command_failed",
      command: "create_message",
      clientMessageId: "client-message-one",
      error: { status: 409, code: "conflict", message: "Try again" },
    }).success).toBe(true);
  });

  it("bounds HyperSight configuration and preserves unique block identities", () => {
    expect(UpdateBlockDashboardRequestSchema.parse({
      expectedVersionNumber: 3,
      blocks: [{ id, prompt: "Give me the last five to-do items" }],
    })).toEqual({
      expectedVersionNumber: 3,
      blocks: [{ id, prompt: "Give me the last five to-do items" }],
    });
    expect(UpdateBlockDashboardRequestSchema.safeParse({
      expectedVersionNumber: 3,
      blocks: [{ id, prompt: "First" }, { id, prompt: "Duplicate" }],
    }).success).toBe(false);
    expect(UpdateBlockDashboardRequestSchema.safeParse({
      expectedVersionNumber: 3,
      blocks: Array.from({ length: 25 }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        prompt: "Too many",
      })),
    }).success).toBe(false);
  });

  it("validates personal HyperSight visibility preferences and their realtime updates", () => {
    expect(UpdateBlockDashboardPreferenceRequestSchema.parse({ visible: true })).toEqual({ visible: true });
    expect(UpdateBlockDashboardPreferenceRequestSchema.safeParse({ visible: true, shared: true }).success).toBe(false);
    const preference = BlockDashboardPreferenceSchema.parse({
      visible: true,
      updatedAt: "2026-08-07T20:00:00.000Z",
    });
    expect(PersonalSocketEventSchema.parse({
      type: "block_dashboard_preference_updated",
      occurredAt: "2026-08-07T20:00:00.000Z",
      preference,
    })).toMatchObject({ type: "block_dashboard_preference_updated", preference });
    expect(ServerSocketEventSchema.safeParse({
      type: "block_dashboard_preference_updated",
      sequence: 44,
      occurredAt: "2026-08-07T20:00:00.000Z",
      preference,
    }).success).toBe(false);
  });

  it("carries resumable stream checkpoints on HyperSight block-agent sockets", () => {
    const checkpoint = ActiveStreamCheckpointSchema.parse({
      messageId: id,
      harnessRunId: id,
      turnId: "turn-1",
      epoch: 0,
      streamSeq: 8,
      seenTurnIds: ["turn-1"],
      text: "A partially streamed block",
      turnStartOffset: 0,
      roomSequence: 8,
      createdAt: "2026-08-18T20:00:00.000Z",
    });
    expect(BlockDashboardBlockSocketEventSchema.parse({
      type: "block_dashboard_block_stream_checkpoint",
      occurredAt: "2026-08-18T20:00:01.000Z",
      blockId: id,
      blockRunId: id,
      streamCheckpoint: checkpoint,
    })).toMatchObject({
      type: "block_dashboard_block_stream_checkpoint",
      streamCheckpoint: { roomSequence: 8, text: "A partially streamed block" },
    });
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

  it("carries an explicit reconnect-safe compaction lifecycle", () => {
    const startedAt = "2026-08-18T20:00:00.000Z";
    expect(ServerSocketEventSchema.parse({
      type: "compaction_started",
      sequence: 44,
      occurredAt: startedAt,
      compaction: {
        harnessRunId: id,
        attemptId: id,
        compactionIndex: 1,
        trigger: "auto",
        startedAt,
      },
    })).toMatchObject({
      type: "compaction_started",
      compaction: { compactionIndex: 1, trigger: "auto" },
    });
    expect(ServerSocketEventSchema.parse({
      type: "compaction_finished",
      sequence: 45,
      occurredAt: "2026-08-18T20:00:01.000Z",
      harnessRunId: id,
      attemptId: id,
      compactionIndex: 1,
      outcome: "completed",
    })).toMatchObject({ type: "compaction_finished", outcome: "completed" });
  });

  it("keeps correlated message-page reads outside the shared room sequence", () => {
    expect(ClientSocketEventSchema.parse({
      type: "load_message_page",
      requestId: id,
      cursor: { direction: "before", value: "42" },
    })).toMatchObject({ type: "load_message_page", limit: 200 });
    expect(ClientSocketEventSchema.safeParse({
      type: "load_message_page",
      requestId: id,
      cursor: { direction: "before", value: "0" },
    }).success).toBe(false);
    expect(SubstreamDirectSocketEventSchema.parse({
      type: "message_page",
      requestId: id,
      occurredAt: "2026-08-18T20:00:00.000Z",
      page: { items: [], nextCursor: "12", newerCursor: null },
    })).toMatchObject({
      type: "message_page",
      page: { nextCursor: "12" },
    });
  });

  it("bounds a stream checkpoint's retry prefix to its accumulated text", () => {
    const checkpoint = {
      messageId: id,
      harnessRunId: id,
      turnId: "turn-2",
      epoch: 1,
      streamSeq: 7,
      seenTurnIds: ["turn-1", "turn-2"],
      text: "The answer so far",
      turnStartOffset: 10,
      roomSequence: 42,
      createdAt: "2026-07-31T20:00:00.000Z",
    };
    expect(ActiveStreamCheckpointSchema.parse(checkpoint)).toEqual(checkpoint);
    expect(ActiveStreamCheckpointSchema.safeParse({
      ...checkpoint,
      turnStartOffset: checkpoint.text.length + 1,
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

  it("carries only a bounded server-owned telemetry correlation for a user-started run", () => {
    const parsed = WorkstreamWorkflowInputSchema.parse({
      region: "global",
      workspaceId: id,
      workstreamId: id,
      harnessRunId: id,
      triggerMessageId: id,
      automationSubscriptionId: null,
      activityId: null,
      executionPrincipal: { type: "user", userId: id },
      telemetryOperationId: id,
      telemetrySubjectUserId: id,
      reason: "human_message",
    });
    expect(parsed).toMatchObject({ telemetryOperationId: id, telemetrySubjectUserId: id });
    expect(WorkstreamWorkflowInputSchema.safeParse({
      ...parsed,
      telemetryOperationId: "not-an-id",
    }).success).toBe(false);
  });

  it("bounds Slack-origin context carried into a work-stream run", () => {
    const parsed = WorkstreamWorkflowInputSchema.parse({
      region: "global",
      workspaceId: id,
      workstreamId: id,
      harnessRunId: id,
      triggerMessageId: id,
      automationSubscriptionId: null,
      activityId: null,
      executionPrincipal: { type: "workspace", workspaceId: id },
      slackOrigin: {
        teamId: "TACME",
        channelId: "CIDEAS",
        channelName: "thinking-outloud",
        threadTs: "1786130000.000100",
        invocationType: "app_mention",
        channelType: "public",
        matchedAvalonUserId: id,
        nearbyMessagesStatus: "available",
        nearbyMessages: [{
          timestamp: "1786129999.000100",
          userId: "UALEX",
          text: "Latest business idea",
          attachments: [],
        }],
        attachments: [],
      },
      slackSearchAuthorization: {
        actionToken: "1786130000.abcdef.event-token",
      },
      reason: "slack_workspace_opening_message",
    });

    expect(parsed.slackOrigin).toMatchObject({
      teamId: "TACME",
      channelId: "CIDEAS",
      invocationType: "app_mention",
      matchedAvalonUserId: id,
    });
    expect(parsed.slackSearchAuthorization).toEqual({
      actionToken: "1786130000.abcdef.event-token",
    });
    expect(WorkstreamWorkflowInputSchema.safeParse({
      ...parsed,
      slackOrigin: {
        ...parsed.slackOrigin,
        nearbyMessages: Array.from({ length: 9 }, (_, index) => ({
          timestamp: String(index),
          userId: null,
          text: "message",
          attachments: [],
        })),
      },
    }).success).toBe(false);
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

  it("carries task records across reloads", () => {
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

  it("tolerates artifacts in both directions of a rollout", () => {
    // Old client, new server: the route parses its own response through this
    // schema, so the default is what puts the field on the wire for a client
    // that predates the removal and still requires it.
    expect(WorkstreamContextSchema.parse({ backgroundTasks: [] }))
      .toEqual({ artifacts: [], backgroundTasks: [] });
    // New client, old server: one region runs the previous Worker for part of
    // every rollout, and that Worker still returns real rows here. Rejecting
    // them would fail the whole response — the same breakage this field exists
    // to prevent, one direction over.
    expect(WorkstreamContextSchema.safeParse({
      artifacts: [{ id, title: "Launch brief" }],
      backgroundTasks: [],
    }).success).toBe(true);
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
      activityTriggers: [],
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
      activityTriggers: [],
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
      activityTriggers: [],
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

  it("reads a thrown failure's machine-readable half without knowing its error class", () => {
    class ProviderError extends Error {
      constructor(readonly code: string, message: string, readonly details?: unknown) {
        super(message);
      }
    }
    expect(readStructuredFailure(new ProviderError("invalid_payload", "Wrong id family", {
      reason: "wrong_id_family",
      field: "messageId",
      resourceId: "019ff769-f7a4-70c8-87a7-16722ff2ce43",
    }))).toEqual({
      code: "invalid_payload",
      details: {
        reason: "wrong_id_family",
        field: "messageId",
        resourceId: "019ff769-f7a4-70c8-87a7-16722ff2ce43",
      },
    });
    // Details are an allowlist, not a convention: adapters already attach whole
    // parsed provider error bodies, and forwarding those would put raw provider
    // JSON into the transcript and the lossless inference lakehouse.
    expect(readStructuredFailure(new ProviderError("provider_error", "Google API failed (403)", {
      error: { code: 403, message: "Request had insufficient authentication scopes", errors: [{ reason: "forbidden" }] },
      accessToken: "ya29.secret",
    }))).toEqual({ code: "provider_error" });
    expect(readStructuredFailure(new ProviderError("unauthorized", "Reconnect", {
      reconnectRequired: true,
      retryable: false,
      reason: "invalid_grant",
      payload: { error_description: "Token has been revoked" },
    }))).toEqual({
      code: "unauthorized",
      details: { reason: "invalid_grant", reconnectRequired: true, retryable: false },
    });
    expect(readStructuredFailure(new ProviderError("invalid_payload", "Ambiguous", {
      reason: "ambiguous_calendar_name",
      available: Array.from({ length: 400 }, (_, index) => `calendar-${index}-with-a-long-name`),
    }))).toEqual({ code: "invalid_payload" });
    expect(readStructuredFailure(new ProviderError("resource_tool_mismatch", "Wrong tool", {
      reason: "wrong_attachment_tool",
      actualMimeType: "image/png",
      attachmentKind: "image",
      suggestedCall: {
        tool: "workstream_view_resource",
        arguments: { resourceIds: ["019ff769-f7a4-70c8-87a7-16722ff2ce43"] },
      },
      converterPayload: { prompt: "do not forward me" },
    }))).toEqual({
      code: "resource_tool_mismatch",
      details: {
        reason: "wrong_attachment_tool",
        actualMimeType: "image/png",
        attachmentKind: "image",
        suggestedCall: {
          tool: "workstream_view_resource",
          arguments: { resourceIds: ["019ff769-f7a4-70c8-87a7-16722ff2ce43"] },
        },
      },
    });
    expect(readStructuredFailure(new ProviderError("resource_tool_mismatch", "Wrong tool", {
      actualMimeType: "x".repeat(161),
      attachmentKind: "image",
      suggestedCall: { tool: "shell", arguments: { command: "cat /etc/passwd" } },
    }))).toEqual({ code: "resource_tool_mismatch" });
    // A code with no details is still worth surfacing; anything without a code
    // carries nothing the caller could branch on.
    expect(readStructuredFailure(new ProviderError("unauthorized", "Reconnect"))).toEqual({ code: "unauthorized" });
    expect(readStructuredFailure(new ProviderError("payload_too_large", "Too big", ["not", "a", "record"])))
      .toEqual({ code: "payload_too_large" });
    expect(readStructuredFailure(new Error("plain"))).toBeNull();
    expect(readStructuredFailure("not an error")).toBeNull();
  });
});

describe("automation delivery destinations", () => {
  const slack = { type: "slack_agent_dm" as const, connectionId: "018f3f4e-7b5a-7cc1-9a6f-2aa0324b7910" };

  it("refuses the same destination kind twice", () => {
    // `automation_delivery_targets` is unique on (subscription, target_type), so
    // a set naming a kind twice has no valid persisted form. Stated as a bound
    // alone this reached the database and became a 500; the route and the create
    // request now share this schema so neither can drift from the other again.
    const refused = AutomationDeliveryTargetSetSchema.safeParse([{ type: "email" }, { type: "email" }]);
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.message).toBe("Each delivery destination can be chosen once");
    expect(AutomationDeliveryTargetSetSchema.safeParse([slack, slack]).success).toBe(false);
  });

  it("accepts one of each kind, and nothing beyond the two Avalon offers", () => {
    expect(AutomationDeliveryTargetSetSchema.safeParse([{ type: "email" }, slack]).success).toBe(true);
    expect(AutomationDeliveryTargetSetSchema.safeParse([]).success).toBe(true);
    expect(AutomationDeliveryTargetSetSchema.safeParse([{ type: "sms" }]).success).toBe(false);
  });

  it("reads a draft written before it recorded what was asked for", () => {
    const { requestedDelivery, ...beforeTheField } = {
      ...AutomationDraftSchema.parse({
        name: "Daily briefing",
        description: "Summarizes the day ahead.",
        overview: "Runs every morning.",
        instructions: "Prepare the briefing.",
        triggers: [{ type: "manual", summary: "Run on request" }],
        requiredCapabilities: [],
        expectedOutputs: [],
        defaultBehavior: {},
        recommendedPlugins: [],
        memoryTables: [],
        suggestedScope: "personal",
        followUpQuestion: null,
        elicitation: null,
        ready: true,
      }),
    };
    expect(requestedDelivery).toEqual([]);
    // Drafts persist inside the conversation row, so one saved before this field
    // existed is reparsed on every later turn; without the default that is an
    // `invalid_response` on a draft the person is still editing.
    expect(AutomationDraftSchema.parse(beforeTheField).requestedDelivery).toEqual([]);
    expect(AutomationDraftSchema.safeParse({ ...beforeTheField, requestedDelivery: ["sms"] }).success).toBe(false);
  });
});

describe("resource version provenance", () => {
  const revision = {
    resourceId: "00000000-0000-7000-8000-0000000000a1",
    version: 2,
    title: "Launch plan",
    resourceType: "document",
    provider: "notion",
    providerResourceId: "notion-1",
    mimeType: "text/markdown",
    canonicalUrl: null,
    lastHydratedAt: null,
    createdAt: "2026-08-28T02:00:00.000Z",
    contentAvailable: true,
    modelContentAvailable: true,
    sizeBytes: 12,
    author: { kind: "agent" as const, runId: "00000000-0000-7000-8000-0000000000a2" },
    cause: "published" as const,
    storageKind: "object",
  };

  it("admits one identity per author kind and refuses another kind's", () => {
    // A run, a member and a connection are all UUIDs. The union is what stops
    // one being read as another by the surfaces that resolve them, so it has
    // to refuse the shape that would let it happen.
    expect(ResourceRevisionSchema.parse(revision).author)
      .toEqual({ kind: "agent", runId: "00000000-0000-7000-8000-0000000000a2" });
    expect(ResourceRevisionSchema.safeParse({
      ...revision,
      author: { kind: "agent", userId: "00000000-0000-7000-8000-0000000000a2" },
    }).success).toBe(false);
    expect(ResourceRevisionSchema.safeParse({
      ...revision,
      author: { kind: "system", runId: "00000000-0000-7000-8000-0000000000a2" },
    }).success).toBe(false);
  });

  it("carries history that recorded no author rather than refusing it", () => {
    // Versions captured before provenance existed, and producers that record
    // none. The surfaces say "unattributed"; the contract must let them.
    expect(ResourceRevisionSchema.parse({ ...revision, author: null, cause: null }))
      .toMatchObject({ author: null, cause: null });
  });

  it("defaults rollout-safe resource fields when an older response omits them", () => {
    // A resource row read before the backfill reaches it has no alias, and a
    // response written before the column existed has no key at all — neither
    // may fail the read. The model's listing always says, including with null.
    const resource = ResourceSchema.parse({
      id: "00000000-0000-7000-8000-0000000000a1",
      workspaceId: "00000000-0000-7000-8000-0000000000a3",
      connectionId: null,
      resourceType: "document",
      provider: "notion",
      providerResourceId: null,
      title: "Launch plan",
      mimeType: null,
      canonicalUrl: null,
      watchEnabled: false,
      watchStatus: "unsupported",
      lastHydratedAt: null,
      createdAt: "2026-08-28T02:00:00.000Z",
      updatedAt: "2026-08-28T02:00:00.000Z",
    });
    expect(resource).toMatchObject({ slug: null, refreshSupported: false });
    expect(ResourceSchema.parse({ ...resource, refreshSupported: true }).refreshSupported).toBe(true);
  });
});
