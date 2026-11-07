import "../../../tests/isolated-region";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  readStructuredFailure,
  ActivityQueueMessageSchema,
  ActiveStreamCheckpointSchema,
  AnswerElicitationRequestSchema,
  AutomationDraftSchema,
  SidekickCustomToolSchema,
  AGENT_MODEL_FLAG_KEYS,
  AGENT_MODEL_OVERRIDES,
  AGENT_MODEL_ROLES,
  AgentModelRoutingSchema,
  ClientSocketEventSchema,
  automationAcceptanceSelections,
  CreateWorkspaceInvitationRequestSchema,
  BackgroundTaskSchema,
  ConnectorManifestSchema,
  HarnessFailureCodeSchema,
  HarnessRunMetadataSchema,
  MessageSchema,
  MentionSchema,
  RESOURCE_RELATIONSHIP_TYPES,
  RefreshRequestSchema,
  ResourceRelationshipTypeSchema,
  ResourceRevisionSchema,
  ResourceSchema,
  resourceDirectionForRelationship,
  ServerSocketEventSchema,
  UpdateWorkspaceRequestSchema,
  WorkspaceSchema,
  WorkspaceSocketClientEventSchema,
  WorkstreamContextSchema,
  WorkstreamSchema,
  WorkstreamResourceSchema,
  TimestampSchema,
  WorkstreamSocketCommandResultSchema,
  WorkstreamWorkflowInputSchema,
  WORKSTREAM_SIDEBAR_FACEPILE_LIMIT,
  workstreamParticipantPreview,
  MemberPreferencesUpdateSchema,
  runRequesterUserId,
  asUserId,
  AutomationRunReferenceV1Schema,
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

  it("parses the retired relationship only at rolling-deploy wire boundaries", () => {
    const legacy = WorkstreamResourceSchema.parse({
      id,
      workspaceId: id,
      connectionId: null,
      resourceType: "document",
      provider: "google_drive",
      providerResourceId: "drive-1",
      title: "Accepted context",
      mimeType: null,
      canonicalUrl: null,
      watchEnabled: false,
      watchStatus: "unsupported",
      lastHydratedAt: null,
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      relationshipType: "suggested_activity",
      direction: "source",
    });
    expect(legacy.relationshipType).toBe("suggested_activity");
    expect(ResourceRelationshipTypeSchema.safeParse(legacy.relationshipType).success).toBe(false);
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

  it("accepts structured assistant turn IDs as message identity", () => {
    const turnId = `${id}:turn:3`;
    const message = MessageSchema.parse({
      id: turnId,
      clientMessageId: null,
      workspaceId: id,
      workstreamId: id,
      author: { type: "agent" },
      messageType: "text",
      textContent: "Saved answer",
      structuredContent: null,
      mentions: [],
      attachments: [],
      sequenceNumber: 3,
      createdAt: "2026-08-29T00:00:00.000Z",
      editedAt: null,
    });

    expect(message.id).toBe(turnId);
  });

  it("orders each vendor's models newest first", () => {
    // The selector groups by vendor, so this ordering is what a reader sees
    // under each heading — and the mistake it exists to catch is a new model
    // appended to the end of the list rather than added to the top of its
    // family. Only a version a machine can compare is checked: the three
    // `gpt-5.6-*` ids share a version, as do the two `deepseek-v4` ids, and
    // ties are ordered by hand rather than by this rule.
    // The *first* numeric run in the model segment, which is the version in
    // every id the list carries: `grok-4.6` and `gemini-3.8-flash` match on the
    // version itself, `deepseek-v4-pro` on the `v`-prefixed form. An id that put
    // a different number first — `foo-v2-3.0-bar` — would yield 2 rather than 3
    // and compare on the wrong field, so a family whose ids are not named this
    // way needs its own handling rather than a looser pattern here.
    const version = (id: string): number[] | null => {
      const match = /-v?(\d+(?:\.\d+)*)(?:-|$)/.exec(id.slice(id.indexOf("/") + 1));
      return match ? match[1]!.split(".").map(Number) : null;
    };
    // Guards the parser itself: a regex that silently stopped matching would
    // otherwise make every comparison below vacuous.
    expect(version("x-ai/grok-4.6")).toEqual([4, 6]);
    expect(version("google/gemini-3-flash-preview")).toEqual([3]);
    expect(version("deepseek/deepseek-v4-pro")).toEqual([4]);
    expect(AGENT_MODEL_OVERRIDES.filter((id) => version(id) === null)).toEqual([]);
    expect(AGENT_MODEL_OVERRIDES.filter((id) => id.startsWith("openai/gpt-5.6-"))).toEqual([
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-luna",
    ]);
    // Takes its two versions in the order the list mentions them, so the call
    // below reads the way the rule is stated: the id listed first must carry
    // the newer version.
    const listedNewestFirst = (earlier: number[], later: number[]): boolean => {
      for (let index = 0; index < Math.max(earlier.length, later.length); index += 1) {
        const earlierPart = earlier[index] ?? 0;
        const laterPart = later[index] ?? 0;
        if (earlierPart !== laterPart) return earlierPart > laterPart;
      }
      return true; // equal versions are a tie this rule does not order
    };
    // Compared against the last id seen *for that vendor*, not the globally
    // preceding one. A vendor's entries are not required to be contiguous —
    // `AGENT_MODEL_GROUPS` merges a vendor mentioned in two places into one
    // section on purpose — so an adjacent-pair walk would skip the comparison
    // for exactly the mistake this exists to catch: `x-ai/grok-9` appended
    // after the DeepSeek block displays under xAI as 4.6 / 4.5 / 4.3 / 9,
    // while its only out-of-order pair never sits adjacent in this list.
    const newestSeen = new Map<string, string>();
    const offenders: string[] = [];
    for (const id of AGENT_MODEL_OVERRIDES) {
      const vendor = id.slice(0, id.indexOf("/"));
      const previous = newestSeen.get(vendor);
      if (previous !== undefined && !listedNewestFirst(version(previous)!, version(id)!)) {
        offenders.push(`${previous} precedes ${id}`);
      }
      newestSeen.set(vendor, id);
    }
    expect(offenders).toEqual([]);
  });

  it("owns the complete model-role, Flagship-key, and route-value contract", () => {
    expect(AGENT_MODEL_ROLES).toEqual([
      "workstream",
      "inline_child",
      "workstream_naming",
      "work_opportunity_admission",
      "work_opportunity_ranking",
      "session_import",
      "memory_sweep",
      "sidekick_authoring",
    ]);
    expect(AGENT_MODEL_ROLES.map((role) => AGENT_MODEL_FLAG_KEYS[role])).toEqual([
      "agent-model-workstream",
      "agent-model-inline-child",
      "agent-model-workstream-naming",
      "agent-model-work-opportunity-admission",
      "agent-model-work-opportunity-ranking",
      "agent-model-session-import",
      "agent-model-memory-sweep",
      "agent-model-sidekick-authoring",
    ]);
    expect(AgentModelRoutingSchema.parse({ model: "openai/gpt-6.1-sol", reasoningEffort: "low" })).toEqual({
      model: "openai/gpt-6.1-sol", fallbackModels: [], reasoningEffort: "low",
    });
    expect(AgentModelRoutingSchema.safeParse({ model: "test/model", reasoningEffort: "unsupported" }).success).toBe(false);
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

  it("accepts a trimmed workspace name on its own and refuses a blank one", () => {
    expect(UpdateWorkspaceRequestSchema.parse({ name: "  Juno Labs  " })).toEqual({ name: "Juno Labs" });
    expect(UpdateWorkspaceRequestSchema.safeParse({ name: "   " }).success).toBe(false);
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

  it("exposes stable member-safe harness failure codes", () => {
    expect(HarnessFailureCodeSchema.options).toEqual(expect.arrayContaining([
      "run_wall_time_limit_exceeded",
      "run_iteration_limit_exceeded",
      "run_tool_call_limit_exceeded",
      "run_cost_limit_exceeded",
      "context_limit_exceeded",
      // Near-namesakes that must not be merged: `context_limit_exceeded` is
      // Rally declining to send a run it cannot make fit, and this one is an
      // endpoint refusing a prompt Rally believed would fit. A member is told
      // something different by each, and an operator learns from this one that
      // the window Rally sized against is wrong.
      "context_length_exceeded",
      // The model cannot read something the request carries; the remedy is
      // the attachment or the model, not a retry and not a support ticket.
      "model_input_unsupported",
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
      region: "enterprise",
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
      customTools: [],
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

  it("still parses a draft stored before delivery was removed", () => {
    // `requestedDelivery` recorded where a person asked the result to go, and
    // acceptance turned it into a destination. Automations no longer have
    // destinations: a run sends its own result with its own connector tools,
    // and the only thing that follows from the automation itself is the room
    // that owns it. The field is gone.
    //
    // Drafts carrying it are already stored, so what has to hold is that they
    // still read. `AutomationDraftSchema` is not strict, so the key is stripped
    // rather than refused — this asserts that, because making the schema strict
    // later would turn every one of those rows into a parse failure at the
    // boundary that reads them.
    const parsed = AutomationDraftSchema.safeParse({
      name: "Shipped this week",
      description: "Post what shipped.",
      overview: "Every Friday, summarize the week.",
      instructions: "Summarize the week.",
      triggers: [{ type: "manual" as const }],
      requiredCapabilities: [],
      expectedOutputs: [],
      defaultBehavior: {},
      recommendedPlugins: [],
      memoryTables: [],
      customTools: [],
      suggestedScope: "workstream",
      requestedDelivery: ["email", "channel"],
      followUpQuestion: null,
      elicitation: null,
      ready: true,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty("requestedDelivery");
    // A room-scoped draft asking for delivery used to be refused outright. It
    // is admissible now because the request means nothing, not because the
    // rule was relaxed; a revision stored with the retired room scope reads
    // as the Organization scope its Sidekick was converted to.
    expect(parsed.data?.suggestedScope).toBe("workspace");
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
      customTools: [],
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
      customTools: [],
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
      customTools: [],
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
    // Every recommendation the draft carries is what acceptance will bind.
    // Derived rather than restated by a caller: the request field that used to
    // carry them had no caller left able to fill it, so it arrived empty and
    // the accepted automation ran with none of its own recommended connectors.
    expect(automationAcceptanceSelections(draft).defaultPluginIds).toHaveLength(25);
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

  it("takes only the empty socket promotion event", () => {
    expect(ClientSocketEventSchema.parse({ type: "mark_opened" }))
      .toEqual({ type: "mark_opened" });
    expect(ClientSocketEventSchema.safeParse({
      type: "mark_opened",
      userId: id,
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
    expect(ClientSocketEventSchema.parse({
      type: "answer_elicitation",
      operationId: id,
      elicitationId: id,
      payload: { answer: "Ship it" },
    })).toEqual({
      type: "answer_elicitation",
      operationId: id,
      elicitationId: id,
      payload: { answer: "Ship it" },
    });
    expect(ClientSocketEventSchema.parse({
      type: "reorder_pending_inputs",
      operationId: id,
      inputIds: [id],
    })).toEqual({ type: "reorder_pending_inputs", operationId: id, inputIds: [id] });
    expect(ClientSocketEventSchema.parse({ type: "stop_harness", operationId: id }))
      .toEqual({ type: "stop_harness", operationId: id });
    expect(ClientSocketEventSchema.parse({ type: "retry_harness", operationId: id }))
      .toEqual({ type: "retry_harness", operationId: id });
    expect(ClientSocketEventSchema.safeParse({
      type: "add_participant",
      userId: id,
    }).success).toBe(false);
    expect(WorkspaceSocketClientEventSchema.safeParse({
      type: "create_message",
      workstreamId: id,
      substreamId: "0",
      operationId: id,
      payload: { text: "Continue", clientMessageId: "client-message-one" },
    }).success).toBe(false);
    expect(WorkstreamSocketCommandResultSchema.safeParse({
      type: "client_command_failed",
      command: "create_message",
      operationId: id,
      clientMessageId: "client-message-one",
      error: { status: 409, code: "conflict", message: "Try again" },
    }).success).toBe(true);
    const accepted = {
      type: "client_command_succeeded" as const,
      command: "create_message" as const,
      operationId: id,
      clientMessageId: "client-message-one",
      turn: {
        turnId: id,
        clientMessageId: "client-message-one",
        createdAt: "2026-08-28T12:00:00.000Z",
      },
      deliveryState: "pending" as const,
    };
    expect(WorkstreamSocketCommandResultSchema.parse(accepted)).toEqual(accepted);
    expect(WorkstreamSocketCommandResultSchema.safeParse({
      ...accepted,
      agentInvoked: true,
    }).success).toBe(false);
    expect(WorkstreamSocketCommandResultSchema.safeParse({
      ...accepted,
      deliveryState: "replayed",
    }).success).toBe(false);
  });

  it("keeps room replay sequence separate from Bind stream epochs", () => {
    expect(ServerSocketEventSchema.parse({
      type: "stream_delta",
      sequence: 42,
      occurredAt: "2026-07-31T20:00:00.000Z",
      streamId: id,
      turnId: "turn-1",
      transcriptSequence: 9,
      epoch: 2,
      streamSeq: 7,
      reset: true,
      delta: ""
    })).toMatchObject({ sequence: 42, epoch: 2, streamSeq: 7, reset: true });
    expect(ServerSocketEventSchema.safeParse({
      type: "stream_started",
      sequence: 43,
      occurredAt: "2026-07-31T20:00:00.000Z",
      streamId: id,
      harnessRunId: id,
      turnId: "turn-1",
      epoch: 2,
      streamSeq: 0,
      reset: true
    }).success).toBe(false);
    expect(ServerSocketEventSchema.safeParse({
      type: "stream_delta",
      sequence: 44,
      occurredAt: "2026-07-31T20:00:00.000Z",
      messageId: id,
      turnId: "turn-1",
      epoch: 2,
      streamSeq: 8,
      reset: false,
      delta: "old ambiguous identity",
    }).success).toBe(false);
    expect(ActiveStreamCheckpointSchema.safeParse({
      messageId: id,
      harnessRunId: id,
      turnId: "turn-1",
      epoch: 0,
      streamSeq: 1,
      seenTurnIds: ["turn-1"],
      text: "old checkpoint",
      turnStartOffset: 0,
      roomSequence: 1,
      createdAt: "2026-07-31T20:00:00.000Z",
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

  it("names the request a socket error refuses, and stays valid without one", () => {
    expect(ServerSocketEventSchema.parse({
      type: "error",
      sequence: 12,
      occurredAt: "2026-09-02T17:00:00.000Z",
      code: "subscription_required",
      message: "Subscribe before loading transcript ranges",
      requestId: id,
    })).toMatchObject({ type: "error", requestId: id });
    // The field is what tells a correlated refusal from an unsolicited one, so
    // a producer that has no request to name must land on null rather than
    // undefined: the client reads `requestId !== null` to decide both who it
    // settles and whether the frame is its snapshot request's answer.
    expect(ServerSocketEventSchema.parse({
      type: "error",
      sequence: 12,
      occurredAt: "2026-09-02T17:00:00.000Z",
      code: "invalid_event",
      message: "The socket event is not valid.",
    })).toMatchObject({ type: "error", requestId: null });
    expect(ServerSocketEventSchema.safeParse({
      type: "error",
      sequence: 12,
      occurredAt: "2026-09-02T17:00:00.000Z",
      code: "subscription_required",
      message: "Subscribe before loading transcript ranges",
      requestId: "not-a-uuid",
    }).success).toBe(false);
  });

  it("rejects the retired compatibility message-page protocol", () => {
    expect(ClientSocketEventSchema.safeParse({
      type: "load_message_page",
      requestId: id,
      cursor: { direction: "before", value: "42" },
    }).success).toBe(false);
    expect(ServerSocketEventSchema.safeParse({
      type: "message_page",
      requestId: id,
      occurredAt: "2026-08-18T20:00:00.000Z",
      page: { items: [], nextCursor: "12", newerCursor: null },
    }).success).toBe(false);
    expect(ServerSocketEventSchema.safeParse({
      type: "message_created",
      sequence: 1,
      occurredAt: "2026-08-18T20:00:00.000Z",
      message: {},
    }).success).toBe(false);
  });

  it("bounds a stream checkpoint's retry prefix to its accumulated text", () => {
    const checkpoint = {
      streamId: id,
      harnessRunId: id,
      turnId: "turn-2",
      transcriptSequence: 10,
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
      parentKind: "canvas",
      parentId: id,
      loopId: `workstream:${id}:substream:0:loop`,
      harnessRunId: id,
      triggerMessageId: null,
      activityId: null,
      reason: "message"
    });
    expect(result.success).toBe(false);
  });

  it("carries only a bounded server-owned telemetry correlation for a user-started run", () => {
    const parsed = WorkstreamWorkflowInputSchema.parse({
      region: "global",
      workspaceId: id,
      parentKind: "canvas",
      parentId: id,
      loopId: `workstream:${id}:substream:0:loop`,
      harnessRunId: id,
      triggerMessageId: id,
      activityId: null,
      executionPrincipal: { type: "user", userId: id },
      telemetryOperationId: id,
      telemetrySubjectUserId: id,
      telemetryRequestReceivedAt: 1_789_680_000_000,
      telemetryJourney: "substream_create",
      reason: "human_message",
    });
    expect(parsed).toMatchObject({
      telemetryOperationId: id,
      telemetrySubjectUserId: id,
      telemetryRequestReceivedAt: 1_789_680_000_000,
      telemetryJourney: "substream_create",
    });
    expect(WorkstreamWorkflowInputSchema.safeParse({
      ...parsed,
      telemetryOperationId: "not-an-id",
    }).success).toBe(false);
    expect(WorkstreamWorkflowInputSchema.safeParse({
      ...parsed,
      telemetryJourney: "provider_ttft",
    }).success).toBe(false);
  });

  it("bounds Slack-origin context carried into a work-stream run", () => {
    const parsed = WorkstreamWorkflowInputSchema.parse({
      region: "global",
      workspaceId: id,
      parentKind: "canvas",
      parentId: id,
      loopId: `workstream:${id}:substream:0:loop`,
      harnessRunId: id,
      triggerMessageId: id,
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

  it("keeps persistent loop identity independent from subordinate execution receipts", () => {
    const loopId = `workstream:${id}:substream:0:loop`;
    const base = {
      region: "global",
      workspaceId: id,
      parentKind: "canvas",
      parentId: id,
      loopId,
      triggerMessageId: id,
      activityId: null,
      executionPrincipal: { type: "user", userId: id },
      reason: "human_message",
    };
    const first = WorkstreamWorkflowInputSchema.parse({ ...base, harnessRunId: id });
    const second = WorkstreamWorkflowInputSchema.parse({
      ...base,
      harnessRunId: "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d1",
    });

    expect(first.loopId).toBe(second.loopId);
    expect(first.harnessRunId).not.toBe(second.harnessRunId);
    expect(WorkstreamWorkflowInputSchema.safeParse({ ...base, harnessRunId: id, loopId: "" }).success)
      .toBe(false);
  });

  it("fences a retry on an assistant turn, whose id is not a UUID", () => {
    const loopId = `workstream:${id}:substream:0:loop`;
    const base = {
      region: "global",
      workspaceId: id,
      parentKind: "canvas",
      parentId: id,
      loopId,
      harnessRunId: id,
      triggerMessageId: id,
      activityId: null,
      executionPrincipal: { type: "user", userId: id },
      reason: "manual_retry",
    };

    // The shape a retry actually resolves: the newest turn after a run that
    // spoke is that run's own assistant turn, and those ids are derived from the
    // loop identity and a turn ordinal rather than minted as UUIDs. Held as a
    // UUID this rejected every such fence, which is every failed run somebody
    // watched fail.
    expect(WorkstreamWorkflowInputSchema.parse({
      ...base,
      transcriptFenceMessageId: `${loopId}:turn:12`,
    }).transcriptFenceMessageId).toBe(`${loopId}:turn:12`);

    // A participant turn reuses the client message UUID, and still parses.
    expect(WorkstreamWorkflowInputSchema.parse({
      ...base,
      transcriptFenceMessageId: id,
    }).transcriptFenceMessageId).toBe(id);

    // Still a fence or nothing: absent and null both mean "bound by the
    // trigger", while an empty string names no turn at all.
    expect(WorkstreamWorkflowInputSchema.parse({
      ...base,
      transcriptFenceMessageId: null,
    }).transcriptFenceMessageId).toBeNull();
    expect(WorkstreamWorkflowInputSchema.parse(base).transcriptFenceMessageId).toBeUndefined();
    expect(WorkstreamWorkflowInputSchema.safeParse({
      ...base,
      transcriptFenceMessageId: "",
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
      transcriptTurnId: id
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
    expect(readStructuredFailure(new ProviderError("unsupported_capability", "Authorize file", {
      reason: "drive_file_not_writable",
      resourceAuthorization: {
        kind: "connector_resource_authorization",
        provider: "google",
        capability: "sheets.write",
        operation: "edit",
        resource: { id: "sheet-1", type: "document", name: "Ellen Buckley Assessment" },
      },
      accessToken: "do-not-forward",
    }))).toEqual({
      code: "unsupported_capability",
      details: {
        reason: "drive_file_not_writable",
        resourceAuthorization: {
          kind: "connector_resource_authorization",
          provider: "google",
          capability: "sheets.write",
          operation: "edit",
          resource: { id: "sheet-1", type: "document", name: "Ellen Buckley Assessment" },
        },
      },
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
        tool: "view_resource",
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
          tool: "view_resource",
          arguments: { resourceIds: ["019ff769-f7a4-70c8-87a7-16722ff2ce43"] },
        },
      },
    });
    // A receipt written before the plugins dropped their wire prefixes stores
    // the retired spelling. This path re-parses stored `errorJson` on every
    // reprojection, and one invalid field discards the whole detail — so the
    // retired name is normalized rather than rejected, or the resource id and
    // attachment kind beside it would be lost with it.
    expect(readStructuredFailure(new ProviderError("resource_tool_mismatch", "Wrong tool", {
      reason: "wrong_attachment_tool",
      attachmentKind: "image",
      suggestedCall: {
        tool: "workstream_view_resource",
        arguments: { resourceIds: ["019ff769-f7a4-70c8-87a7-16722ff2ce43"] },
      },
    }))).toEqual({
      code: "resource_tool_mismatch",
      details: {
        reason: "wrong_attachment_tool",
        attachmentKind: "image",
        suggestedCall: {
          tool: "view_resource",
          arguments: { resourceIds: ["019ff769-f7a4-70c8-87a7-16722ff2ce43"] },
        },
      },
    });
    expect(readStructuredFailure(new ProviderError("resource_tool_mismatch", "Wrong tool", {
      attachmentKind: "site",
      suggestedCall: {
        tool: "terminal_import_resource",
        arguments: { resourceId: "019ff769-f7a4-70c8-87a7-16722ff2ce43" },
      },
    }))).toEqual({
      code: "resource_tool_mismatch",
      details: {
        attachmentKind: "site",
        suggestedCall: {
          tool: "import_resource",
          arguments: { resourceId: "019ff769-f7a4-70c8-87a7-16722ff2ce43" },
        },
      },
    });
    // A retired name is not a licence to widen the shape: the arguments still
    // have to match the tool they normalize to.
    expect(readStructuredFailure(new ProviderError("resource_tool_mismatch", "Wrong tool", {
      attachmentKind: "image",
      suggestedCall: { tool: "workstream_view_resource", arguments: { command: "cat /etc/passwd" } },
    }))).toEqual({ code: "resource_tool_mismatch" });
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

  it("lists a version whose cause this client does not know as one with none", () => {
    expect(ResourceRevisionSchema.parse({ ...revision, cause: "renamed" }).cause).toBe("renamed");
    expect(ResourceRevisionSchema.parse({ ...revision, cause: "merged" }).cause).toBeNull();
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

  it("caps a sidebar facepile preview and defaults an older work-stream payload", () => {
    const ids = [
      "00000000-0000-7000-8000-0000000000b1",
      "00000000-0000-7000-8000-0000000000b2",
      "00000000-0000-7000-8000-0000000000b3",
      "00000000-0000-7000-8000-0000000000b4",
      "00000000-0000-7000-8000-0000000000b5",
    ];
    expect(workstreamParticipantPreview(ids)).toEqual({
      participantUserIds: ids.slice(0, WORKSTREAM_SIDEBAR_FACEPILE_LIMIT),
      participantExtraCount: 2,
    });
    expect(workstreamParticipantPreview(ids.slice(0, 2))).toEqual({
      participantUserIds: ids.slice(0, 2),
      participantExtraCount: 0,
    });

    const at = "2026-08-30T00:00:00.000Z";
    const workstream = WorkstreamSchema.parse({
      id: "00000000-0000-7000-8000-0000000000c1",
      workspaceId: "00000000-0000-7000-8000-0000000000c2",
      title: "Launch",
      titleStatus: "settled",
      objective: "",
      emailAddress: null,
      createdByUserId: null,
      harnessStatus: "completed",
      latestAttentionSequenceNumber: 0,
      readThroughSequenceNumber: 0,
      manualUnreadFromSequenceNumber: null,
      manualUnreadGeneration: 0,
      hasUnread: false,
      firstUnreadSequenceNumber: null,
      lastActivityAt: at,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
    });
    expect(workstream.participantUserIds).toEqual([]);
    expect(workstream.participantExtraCount).toBe(0);
    expect(WorkstreamSchema.safeParse({
      ...workstream,
      participantUserIds: ids,
    }).success).toBe(false);
  });
});

describe("TimestampSchema seconds requirement", () => {
  // zod 4.5 made seconds mandatory in datetime(). Nothing in the tree exercised a
  // second-less timestamp, so the whole suite stayed green through that narrowing
  // and it was found by reading the library's behavior rather than by a failure.
  // TimestampSchema backs 102 fields in this file alone and fifteen connector
  // tool-argument schemas a model writes strings into, so pin both directions:
  // a re-widening is as much a contract change as the narrowing was.
  it("accepts an offset timestamp that carries seconds", () => {
    for (const input of [
      "2026-09-02T12:30:00.000Z",
      "2026-09-02T12:30:00Z",
      "2026-09-02T12:30:00+01:00",
    ]) {
      expect(TimestampSchema.safeParse(input).success).toBe(true);
    }
  });

  it("rejects an offset timestamp that omits seconds", () => {
    for (const input of ["2026-09-02T12:30Z", "2026-09-02T12:30+01:00"]) {
      expect(TimestampSchema.safeParse(input).success).toBe(false);
    }
  });

  it("requires seconds in the JSON Schema pattern it hands a model", () => {
    const { pattern } = z.toJSONSchema(TimestampSchema) as { pattern: string };
    expect(pattern).toContain(":[0-5]\\d(?:\\.\\d+)?");
    expect(pattern).not.toContain("(?::[0-5]\\d(?:\\.\\d+)?)?");
  });
});

describe("member preference saves", () => {
  it("leaves out every kind a save does not name, defaulted kinds included", () => {
    expect(MemberPreferencesUpdateSchema.parse({ notify: { mentions: ["email"] } }))
      .toEqual({ notify: { mentions: ["email"] } });
  });
});

describe("who asked for a run", () => {
  const person = { type: "user" as const, userId: asUserId("00000000-0000-7000-8000-000000000001") };
  const sidekickRun = (trigger: unknown) => AutomationRunReferenceV1Schema.parse({
    schemaVersion: 1,
    automationId: "00000000-0000-7000-8000-000000000002",
    runId: "00000000-0000-7000-8000-000000000003",
    definitionRevision: 1,
    trigger,
  });

  it("is the person a run acts for, whoever started a Sidekick by hand, and nobody for a scheduled Sidekick", () => {
    expect(runRequesterUserId({ executionPrincipal: person, automationRun: undefined, automationContinuation: undefined }))
      .toBe("00000000-0000-7000-8000-000000000001");
    expect(runRequesterUserId({
      executionPrincipal: person,
      automationRun: sidekickRun({ kind: "manual", requestedByUserId: "00000000-0000-7000-8000-000000000004" }),
    })).toBe("00000000-0000-7000-8000-000000000004");
    expect(runRequesterUserId({
      executionPrincipal: person,
      automationRun: sidekickRun({
        kind: "schedule", scheduleId: "00000000-0000-7000-8000-000000000005", scheduleKind: "interval", plannedFor: 0,
      }),
    })).toBeNull();
    // A turn continuing a Sidekick run was asked for by whoever sent it, or nobody.
    const scheduled = sidekickRun({
      kind: "schedule", scheduleId: "00000000-0000-7000-8000-000000000005", scheduleKind: "interval", plannedFor: 0,
    });
    const continuation = { stopGeneration: 0, senderName: "Theo", source: { kind: "run" as const } };
    expect(runRequesterUserId({
      executionPrincipal: person,
      automationRun: scheduled,
      automationContinuation: { ...continuation, senderUserId: asUserId("00000000-0000-7000-8000-000000000006") },
    })).toBe("00000000-0000-7000-8000-000000000006");
    expect(runRequesterUserId({ executionPrincipal: person, automationRun: scheduled, automationContinuation: continuation }))
      .toBeNull();
  });
});

describe("SidekickCustomToolSchema on a draft", () => {
  const baseDraft = {
    name: "Doubler", description: "Doubles days.", overview: "Doubles.", instructions: "Call custom_day_math.",
    triggers: [{ type: "manual" }], requiredCapabilities: [], expectedOutputs: [], defaultBehavior: {},
    recommendedPlugins: [], memoryTables: [], suggestedScope: "personal", followUpQuestion: null, elicitation: null, ready: true,
  };
  const dayMath = {
    name: "day_math", description: "Doubles a day count.",
    inputSchema: { type: "object", properties: { days: { type: "integer", description: "Days to double." } }, required: ["days"] },
    code: "return input.days * 2;", requiredPlugins: ["rally_core"],
  };

  it("accepts a tool over a Rally plugin, closes its input schema, and defaults customTools to none", () => {
    const parsed = AutomationDraftSchema.parse({ ...baseDraft, customTools: [dayMath] });
    expect(parsed.customTools).toHaveLength(1);
    // Closed by default: the schema the wizard tests against is the one a run validates against.
    expect(parsed.customTools[0]!.inputSchema.additionalProperties).toBe(false);
    expect(AutomationDraftSchema.parse(baseDraft).customTools).toEqual([]);
  });

  it("names the field when a tool sits on an instruction-only draft, repeats a name, or calls an unrecommended connector", () => {
    const issues = (draft: unknown) => {
      const parsed = AutomationDraftSchema.safeParse(draft);
      return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join("."));
    };
    expect(issues({ ...baseDraft, triggers: [], customTools: [dayMath] })).toEqual(["customTools.0"]);
    expect(issues({ ...baseDraft, customTools: [dayMath, dayMath] })).toEqual(["customTools.1.name"]);
    expect(issues({ ...baseDraft, customTools: [{ ...dayMath, requiredPlugins: ["plugin_linear"] }] })).toEqual(["customTools.0.requiredPlugins.0"]);
    // Only the allowlisted Rally plugins are callable from a saved tool.
    expect(issues({ ...baseDraft, customTools: [{ ...dayMath, requiredPlugins: ["rally_terminal"] }] })).toEqual(["customTools.0.requiredPlugins.0"]);
    expect(issues({ ...baseDraft, customTools: [{ ...dayMath, requiredPlugins: ["rally_tables", "rally_memory", "rally_web", "plugin_linear"] }], recommendedPlugins: [{ pluginId: "plugin_linear", reason: "Issues." }] })).toEqual([]);
    expect(issues({ ...baseDraft, ready: false, triggers: [], customTools: [dayMath] })).toEqual([]);
  });

  it("refuses an input schema that is not a described plain object", () => {
    const paths = (inputSchema: unknown) => {
      const parsed = SidekickCustomToolSchema.safeParse({ ...dayMath, inputSchema });
      return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join("."));
    };
    expect(paths({ type: "object", properties: { days: { type: "integer" } }, required: ["days"] })).toEqual(["inputSchema.properties.days.description"]);
    expect(paths({ type: "object", properties: { days: { type: "integer", description: "Days." } }, required: ["weeks"] })).toEqual(["inputSchema.required"]);
  });
});
