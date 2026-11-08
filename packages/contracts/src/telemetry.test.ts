import "../../../tests/isolated-region";
import { describe, expect, it } from "vitest";
import {
  AnonymousTelemetryBatchSchema,
  CrashIngestResponseSchema,
  LinkAnonymousTelemetryResponseSchema,
  TelemetryAcceptanceBatchResponseSchema,
  TelemetryBatchSchema,
  TelemetryBreadcrumbSidecarSchema,
  TelemetryEnvelopeSchema,
  TELEMETRY_ENVELOPE_SCHEMA,
  TELEMETRY_EVENTS,
  SUPERSEDED_TELEMETRY_ENVELOPE_SCHEMAS,
  telemetryEventNames,
} from "./telemetry";

const eventId = "018f22f2-4c22-7abc-8def-0123456789ab";
const timestamp = "2026-08-12T20:00:00.000Z";

function envelope(name: string, properties: unknown) {
  return {
    schema: TELEMETRY_ENVELOPE_SCHEMA,
    schemaVersion: 1,
    contextSchemaVersion: 2,
    eventId,
    name,
    source: "desktop-renderer",
    category: "product",
    identityScope: "anonymous-epoch",
    originalTimestamp: timestamp,
    sentAt: timestamp,
    context: {
      environment: "production",
      release: "0.24.0",
      buildId: "build-0123456789",
      deviceId: "018f22f2-4c22-7abc-8def-0123456789aa",
      onboardingJourneyId: eventId,
      operationId: eventId,
    },
    properties,
  };
}

describe("telemetry registry", () => {
  it.each([
    "sunset-sherbet", "ludicrous-speed", "ruby", "holographic", "leather", "blueprint",
    "grass-court", "clay-court", "hard-court", "ball-felt", "night-match",
    "calm", "ludicrous", "homage", "builder", "quiet",
  ])("accepts released and current icon %s in telemetry batches", (icon) => {
    const settings = {
      launchAtLoginEnabled: true, launchAtLoginAvailable: true,
      lockdownModeEnabled: false, lockdownModeAvailable: true,
      applicationIcon: icon, applicationIconAutomatic: false, applicationIconAvailable: true,
    };
    const events = [
      envelope("application_settings_state", settings),
      envelope("application_settings_state_v2", {
        ...settings, menuBarEnabled: true, menuBarAvailable: true, menuBarPresent: true,
      }),
      envelope("application_icon_changed", {
        previousIcon: icon, previousAutomatic: false, selectedIcon: icon, automatic: false,
      }),
    ].map((candidate) => ({ ...candidate, source: "desktop-main" }));
    expect(TelemetryBatchSchema.parse({
      installationId: envelope("x", {}).context.deviceId, events,
    }).events).toHaveLength(3);
  });

  it("defines complete governance and property classification for every event", () => {
    expect(new Set(telemetryEventNames).size).toBe(telemetryEventNames.length);
    expect(telemetryEventNames.length).toBeGreaterThan(10);
    for (const [name, entry] of Object.entries(TELEMETRY_EVENTS)) {
      expect(entry.name).toBe(name);
      expect(entry.definition.length).toBeGreaterThan(20);
      expect(entry.productQuestion.length).toBeGreaterThan(20);
      expect(entry.owner).toMatch(/^[a-z][a-z-]+$/u);
      expect(entry.reviewGroup).toMatch(/^[a-z][a-z-]+$/u);
      expect(entry.sources).toContain(entry.authoritativeSource);
      expect(entry.sources.length).toBeGreaterThan(0);
      expect(entry.identityScopes.length).toBeGreaterThan(0);
      expect(entry.sampleRate).toBeGreaterThan(0);
      expect(entry.sampleRate).toBeLessThanOrEqual(1);
      expect(Object.keys(entry.propertyClassifications).sort()).toEqual(
        Object.keys(entry.properties.unwrap().shape).sort(),
      );
      expect(entry.compatibilityNote.length).toBeGreaterThan(10);
      expect(entry.destination).toMatch(/^(posthog|internal-only)$/u);
    }
  });

  it("accepts the registered anonymous onboarding intent with exact properties", () => {
    expect(TelemetryEnvelopeSchema.parse(envelope("onboarding_region_selected", {
      selectedRegion: "enterprise",
      entrypoint: "first_run",
    }))).toMatchObject({ name: "onboarding_region_selected" });
  });

  it.each([
    ["menu_bar_opened", "desktop-main", {
      signedIn: true, suggestionCount: 4, recentCount: 5, pinnedCount: 2,
    }],
    ["menu_bar_action_selected", "desktop-main", { action: "new_workstream" }],
    ["command_shortcuts_revealed", "desktop-renderer", { availableCount: 9 }],
    ["command_shortcut_used", "desktop-renderer", {
      shortcutNumber: 2, destinationType: "pinned_workstream",
    }],
    ["application_settings_state", "desktop-main", {
      launchAtLoginEnabled: true,
      launchAtLoginAvailable: true,
      lockdownModeEnabled: false,
      lockdownModeAvailable: true,
      applicationIcon: "ludicrous",
      applicationIconAutomatic: false,
      applicationIconAvailable: true,
    }],
    ["application_setting_change_completed", "desktop-main", {
      setting: "launch_at_login",
      previousEnabled: false,
      requestedEnabled: true,
      appliedEnabled: false,
    }],
    ["application_setting_change_completed", "desktop-main", {
      setting: "lockdown_mode",
      previousEnabled: false,
      requestedEnabled: true,
      appliedEnabled: true,
    }],
    ["application_icon_changed", "desktop-main", {
      previousIcon: "dark",
      previousAutomatic: true,
      selectedIcon: "quiet",
      automatic: false,
    }],
    ["application_opened", "desktop-main", {
      entrypoint: "system_start",
      phase: "cold_start",
    }],
    ["application_opened", "desktop-main", {
      entrypoint: "dock",
      phase: "activation",
    }],
    ["application_opened", "desktop-main", {
      entrypoint: "push_notification",
      phase: "activation",
    }],
    ["suggested_work_started", "api", { surface: "menu_bar" }],
    ["suggested_work_started", "api", { surface: "workspace_home" }],
    ["workstream_opened", "desktop-renderer", {
      workstreamId: "00000000-0000-4000-8000-000000000101",
      visibility: "private",
      navigation: "switched",
      origin: "ad_hoc",
      pinned: true,
    }],
    ["workstream_feed_visible", "desktop-renderer", {
      workstreamId: "00000000-0000-4000-8000-000000000101",
      socketLeaseId: "018f22f2-4c22-7abc-8def-012345678901",
      durationMs: 842,
      dataReadyDurationMs: 811,
      sidebarSection: "pinned",
      cacheState: "detail_cached",
      socketPoolState: "control_warmup",
      feedSource: "boot_payload",
      messageCount: "six_to_twenty",
    }],
    ["workstream_feed_visible", "desktop-renderer", {
      workstreamId: "00000000-0000-4000-8000-000000000101",
      socketLeaseId: "018f22f2-4c22-7abc-8def-012345678901",
      durationMs: 120,
      dataReadyDurationMs: 96,
      sidebarSection: "recent",
      cacheState: "cold",
      socketPoolState: "control_warmup",
      feedSource: "local_cache",
      messageCount: "six_to_twenty",
    }],
    ["workstream_send_ready", "desktop-renderer", {
      workstreamId: "00000000-0000-4000-8000-000000000101",
      durationMs: 856,
      workspaceSocketState: "reconnecting",
    }],
    ["workstream_socket_started", "desktop-renderer", {
      workstreamId: "00000000-0000-4000-8000-000000000101",
      socketLeaseId: "018f22f2-4c22-7abc-8def-012345678901",
      openAttemptId: "018f22f2-4c22-7abc-8def-012345678902",
      socket: "workstream_control",
      reason: "hover_warmup",
      attempts: "zero",
    }],
    ["workstream_open_started", "desktop-renderer", {
      workstreamId: "00000000-0000-4000-8000-000000000101",
      sidebarSection: "recent",
      socketPoolState: "retained_pair",
      socketLeaseId: "018f22f2-4c22-7abc-8def-012345678901",
    }],
    ["workstream_open_outcome", "desktop-renderer", {
      workstreamId: "00000000-0000-4000-8000-000000000101",
      outcome: "superseded",
      durationMs: 42,
      socketLeaseId: "018f22f2-4c22-7abc-8def-012345678901",
      supersedingWorkstreamId: "00000000-0000-4000-8000-000000000102",
    }],
    ["workstream_created", "api", {
      workstreamId: "00000000-0000-4000-8000-000000000101",
      visibility: "public",
      creationSource: "composer",
      origin: "ad_hoc",
      connectorType: "none",
      connectorTypes: [],
      connectorTypeCount: 0,
      participantCount: 3,
      attachmentCount: 2,
      modelOverride: true,
    }],
    ["workstream_action_completed", "desktop-renderer", {
      workstreamId: "00000000-0000-4000-8000-000000000101",
      action: "make_private",
      visibility: "private",
      origin: "ad_hoc",
      pinned: false,
    }],
    ["automation_created", "desktop-renderer", {
      automationId: "00000000-0000-4000-8000-000000000102",
      visibility: "public",
      creationMethod: "custom",
      pluginCount: 4,
      activityTriggerEnabled: true,
      deliveryEnabled: true,
    }],
    ["automation_action_completed", "desktop-renderer", {
      automationId: "00000000-0000-4000-8000-000000000102",
      action: "archive_draft",
      visibility: "private",
      status: "draft",
    }],
    ["message_sent", "api", {
      workstreamId: "00000000-0000-4000-8000-000000000101",
      messageId: "00000000-0000-4000-8000-000000000103",
      visibility: "private",
      workstreamOrigin: "automation",
      messageKind: "message",
      attachmentCount: 2,
      mentionCount: 1,
      participantAddedCount: 1,
    }],
    ["content_copied", "desktop-renderer", {
      contentType: "message_response",
      resourceType: "message",
      resourceId: "00000000-0000-4000-8000-000000000103",
      workstreamId: "00000000-0000-4000-8000-000000000101",
    }],
    ["note_opened", "desktop-renderer", {
      noteId: "00000000-0000-4000-8000-000000000104",
      visibility: "public",
      recordingState: "complete",
      navigation: "reopened",
    }],
    ["note_created", "desktop-renderer", {
      noteId: "00000000-0000-4000-8000-000000000104",
      visibility: "private",
      noteType: "meeting_or_voice",
      entrypoint: "sidebar",
    }],
    ["note_action_completed", "desktop-renderer", {
      noteId: "00000000-0000-4000-8000-000000000104",
      action: "make_public",
      visibility: "public",
      recordingState: "recording",
    }],
    ["transcription_state_changed", "desktop-renderer", {
      noteId: "00000000-0000-4000-8000-000000000104",
      state: "paused",
      visibility: "private",
      audioSource: "microphone_and_system",
    }],
    ["agent_tool_started", "api", {
      workstreamId: "00000000-0000-4000-8000-000000000101",
      harnessRunId: "00000000-0000-4000-8000-000000000105",
      automationId: "00000000-0000-4000-8000-000000000102",
      toolName: "google_drive_search",
      pluginId: "google-drive",
      capability: "drive.search",
      mode: "read",
      runKind: "automation",
      executionScope: "workspace",
    }],
  ] as const)("accepts the closed %s product event", (name, source, properties) => {
    expect(TelemetryEnvelopeSchema.safeParse({
      ...envelope(name, properties),
      source,
      identityScope: "workspace-user",
    }).success).toBe(true);
  });

  it("rejects non-v7 opening lineage identifiers and impossible feed durations", () => {
    const v4 = "00000000-0000-4000-8000-000000000111";
    expect(TELEMETRY_EVENTS.workstream_open_started.properties.safeParse({
      workstreamId: "00000000-0000-4000-8000-000000000101",
      sidebarSection: "recent",
      socketPoolState: "cold",
      socketLeaseId: v4,
    }).success).toBe(false);
    expect(TELEMETRY_EVENTS.workstream_socket_started.properties.safeParse({
      workstreamId: "00000000-0000-4000-8000-000000000101",
      socketLeaseId: "018f22f2-4c22-7abc-8def-012345678901",
      openAttemptId: v4,
      socket: "substream_feed",
      reason: "active_workstream",
      attempts: "zero",
    }).success).toBe(false);
    expect(TELEMETRY_EVENTS.workstream_feed_visible.properties.safeParse({
      workstreamId: "00000000-0000-4000-8000-000000000101",
      durationMs: 99,
      dataReadyDurationMs: 100,
      sidebarSection: "recent",
      cacheState: "cold",
      socketPoolState: "cold",
      feedSource: "boot_payload",
      messageCount: "one",
    }).success).toBe(false);
  });

  it("keeps renderer performance diagnostics closed and content-free", () => {
    const properties = {
      flow: "workstream_message_send",
      clientMessageId: "00000000-0000-4000-8000-000000000102",
      workstreamId: "00000000-0000-4000-8000-000000000101",
      outcome: "completed",
      durationMs: 402.7,
      blockedMs: 0,
      longTaskCount: "zero",
      resolveMentionsMs: 2.1,
      commandRoundTripMs: 400.6,
      messageLength: "twenty_one_to_one_hundred",
    };
    expect(TELEMETRY_EVENTS.renderer_perf_flow.properties.safeParse(properties).success).toBe(true);
    expect(TelemetryEnvelopeSchema.safeParse({
      ...envelope("renderer_perf_flow", properties),
      category: "diagnostic",
      identityScope: "workspace-user",
    }).success).toBe(true);
    expect(TELEMETRY_EVENTS.renderer_perf_flow.properties.safeParse({
      ...properties,
      messageText: "must not leave the renderer",
    }).success).toBe(false);
    expect(TELEMETRY_EVENTS.renderer_perf_flow.properties.safeParse({
      ...properties,
      outcome: "message_created",
    }).success).toBe(false);
  });

  it("accepts route abandonment without a superseding work stream", () => {
    const abandoned = {
      workstreamId: "00000000-0000-4000-8000-000000000101",
      outcome: "abandoned",
      durationMs: 42,
    };
    expect(TELEMETRY_EVENTS.workstream_open_outcome.properties.safeParse(abandoned).success).toBe(true);
    expect(TELEMETRY_EVENTS.workstream_open_outcome.properties.safeParse({
      ...abandoned,
      supersedingWorkstreamId: "00000000-0000-4000-8000-000000000102",
    }).success).toBe(false);
  });

  it("rejects shortcut and menu dimensions outside their bounded taxonomies", () => {
    expect(TelemetryEnvelopeSchema.safeParse(envelope("command_shortcut_used", {
      shortcutNumber: 0,
      destinationType: "private/workstream/42",
    })).success).toBe(false);
    expect(TelemetryEnvelopeSchema.safeParse({
      ...envelope("menu_bar_opened", {
        signedIn: true, suggestionCount: 5, recentCount: 5, pinnedCount: 0,
      }),
      source: "desktop-main",
    }).success).toBe(false);
    expect(TelemetryEnvelopeSchema.safeParse({
      ...envelope("menu_bar_action_selected", { action: "private-row-label" }),
      source: "desktop-main",
    }).success).toBe(false);
  });

  it("rejects an ad click identifier's value where only its platform may go", () => {
    expect(TelemetryEnvelopeSchema.safeParse({
      ...envelope("site_page_viewed", {
        page: "landing", pathname: "/", adClickIdSource: "23opevjt88psuo13lu8d020qkn",
      }),
      source: "site",
    }).success).toBe(false);
  });

  it("rejects traffic codes outside the closed lists, so no raw signal can ride along", () => {
    const pageLeft = (properties: Record<string, unknown>) => TelemetryEnvelopeSchema.safeParse({
      ...envelope("site_page_left", { page: "landing", pathname: "/", duration: "1s_5s", ...properties }),
      source: "site",
    }).success;
    expect(pageLeft({ pageSignals: ["America/Los_Angeles"] })).toBe(false);
    expect(pageLeft({ pageSignals: ["webdriver"] })).toBe(false);
    expect(pageLeft({ trafficReasons: ["AS16509"] })).toBe(false);
    expect(pageLeft({ trafficClass: "bot" })).toBe(false);
  });

  it("rejects unknown application settings and icon values", () => {
    expect(TelemetryEnvelopeSchema.safeParse({
      ...envelope("application_settings_state", {
        launchAtLoginEnabled: true,
        launchAtLoginAvailable: true,
        lockdownModeEnabled: false,
        lockdownModeAvailable: true,
        applicationIcon: "../../private-icon",
        applicationIconAutomatic: false,
        applicationIconAvailable: true,
      }),
      source: "desktop-main",
    }).success).toBe(false);
    expect(TelemetryEnvelopeSchema.safeParse({
      ...envelope("application_setting_change_completed", {
        setting: "private_setting",
        previousEnabled: false,
        requestedEnabled: true,
        appliedEnabled: true,
      }),
      source: "desktop-main",
    }).success).toBe(false);
  });

  it("rejects unclassified application-open sources", () => {
    expect(TelemetryEnvelopeSchema.safeParse({
      ...envelope("application_opened", {
        entrypoint: "some-arbitrary-url",
        phase: "activation",
      }),
      source: "desktop-main",
    }).success).toBe(false);
  });

  it("names a copied assistant reply by its turn id, and nothing else by a non-UUID", () => {
    const copied = (resourceType: string, resourceId: string) => TelemetryEnvelopeSchema.safeParse({
      ...envelope("content_copied", {
        contentType: "message_response",
        resourceType,
        resourceId,
        workstreamId: "00000000-0000-4000-8000-000000000101",
      }),
      source: "desktop-renderer",
      identityScope: "workspace-user",
    }).success;
    const turn = "workstream:00000000-0000-4000-8000-000000000101:substream:0:loop:turn:7";
    expect(copied("message", turn)).toBe(true);
    expect(copied("message", "workstream:00000000-0000-4000-8000-000000000101:substream:00000000-0000-4000-8000-000000000105:loop:turn:12")).toBe(true);
    expect(copied("workstream", turn)).toBe(false);
    expect(copied("message", "workstream:00000000-0000-4000-8000-000000000101:substream:0:loop:turn:7 the reply text")).toBe(false);
    expect(copied("message", "the reply text")).toBe(false);
  });

  it("rejects copied content and tool arguments while retaining opaque resource correlations", () => {
    expect(TelemetryEnvelopeSchema.safeParse({
      ...envelope("content_copied", {
        contentType: "message_response",
        resourceType: "message",
        resourceId: "00000000-0000-4000-8000-000000000103",
        workstreamId: "00000000-0000-4000-8000-000000000101",
        content: "private message text",
      }),
      source: "desktop-renderer",
      identityScope: "workspace-user",
    }).success).toBe(false);
    expect(TelemetryEnvelopeSchema.safeParse({
      ...envelope("agent_tool_started", {
        workstreamId: "00000000-0000-4000-8000-000000000101",
        harnessRunId: "00000000-0000-4000-8000-000000000105",
        toolName: "google_drive_search",
        pluginId: "google-drive",
        capability: "drive.search",
        mode: "read",
        runKind: "workstream",
        executionScope: "user",
        arguments: { query: "confidential acquisition" },
      }),
      source: "api",
      identityScope: "workspace-user",
    }).success).toBe(false);
  });

  it.each([
    ["surface_viewed", "desktop-renderer", "workspace-user", {
      surface: "automation_detail", entrypoint: "sidebar_automation",
      resourceType: "automation", resourceId: "00000000-0000-4000-8000-000000000102",
    }],
    ["run_terminal", "api", "workspace", {
      workstreamId: "00000000-0000-4000-8000-000000000101",
      harnessRunId: "00000000-0000-4000-8000-000000000105",
      automationId: "00000000-0000-4000-8000-000000000102",
      runKind: "automation", triggerType: "scheduled", terminalState: "needs_input",
      duration: "2m_10m", timeToFirstOutput: "30s_2m", turnCount: "two_to_five",
      toolCallCount: "six_to_twenty", writeToolCallCount: "one",
      modelRoute: "anthropic/claude-sonnet-4", fallbackUsed: true,
    }],
    ["agent_tool_terminal", "api", "workspace", {
      workstreamId: "00000000-0000-4000-8000-000000000101",
      harnessRunId: "00000000-0000-4000-8000-000000000105",
      automationId: "00000000-0000-4000-8000-000000000102",
      toolName: "linear_issue_create", pluginId: "linear", capability: "linear.issue.create",
      mode: "write", runKind: "automation", executionScope: "workspace",
      result: "provider_error", duration: "5s_30s", replayed: false,
    }],
    ["suggested_work_impression", "api", "workspace-user", {
      opportunityId: "00000000-0000-4000-8000-000000000106", version: 3,
      surface: "workspace_home", position: 2, audienceScope: "personal",
      connectorTypes: ["linear"], freshness: "1h_24h", priorImpressionCount: "two_to_five",
    }],
    ["suggested_work_dismissed", "api", "workspace-user", {
      opportunityId: "00000000-0000-4000-8000-000000000106", version: 3,
      surface: "workspace_home", position: 2, audienceScope: "personal",
      connectorTypes: ["linear"], timeSinceFirstImpression: "2m_10m",
    }],
    ["suggested_work_started_v2", "api", "workspace-user", {
      opportunityId: "00000000-0000-4000-8000-000000000106",
      workstreamId: "00000000-0000-4000-8000-000000000101", version: 3,
      surface: "menu_bar", position: 1, audienceScope: "workspace",
      connectorTypes: ["linear", "slack"], priorImpressionCount: "six_to_twenty",
    }],
    ["automation_builder_started", "desktop-renderer", "workspace-user", {
      entrypoint: "sidebar_automation", resumedDraft: false,
    }],
    ["automation_draft_turn_completed", "api", "workspace-user", {
      draftId: "00000000-0000-4000-8000-000000000107", turnNumber: "two_to_five",
      result: "success", duration: "5s_30s", inputMode: "suggested_prompt",
      attachmentCount: 1, connectorMentionCount: 2, readyToCreate: true,
    }],
    ["automation_draft_ready", "api", "workspace-user", {
      draftId: "00000000-0000-4000-8000-000000000107", turnsToReady: "two_to_five",
      visibility: "private", triggerTypes: ["manual", "calendar"],
      connectorTypes: ["google"], pluginCount: 2, deliveryTargetTypes: ["email"],
    }],
    ["automation_created_v2", "api", "workspace-user", {
      automationId: "00000000-0000-4000-8000-000000000102",
      draftId: "00000000-0000-4000-8000-000000000107", creationMethod: "custom",
      visibility: "private", triggerTypes: ["manual"], connectorTypes: ["google"],
      pluginCount: 2, deliveryTargetTypes: ["email"], modelOverride: true,
    }],
    ["automation_opened", "desktop-renderer", "workspace-user", {
      automationId: "00000000-0000-4000-8000-000000000102", visibility: "private",
      status: "active", entrypoint: "sidebar_automation", runCount: "six_to_twenty",
    }],
    ["automation_action_completed_v2", "api", "workspace-user", {
      automationId: "00000000-0000-4000-8000-000000000102", action: "pause",
      visibility: "public", previousStatus: "active", appliedStatus: "paused", result: "success",
    }],
    ["elicitation_presented", "api", "workspace-user", {
      elicitationId: "00000000-0000-4000-8000-000000000108",
      runId: "00000000-0000-4000-8000-000000000105",
      workstreamId: "00000000-0000-4000-8000-000000000101", responseType: "single_select",
      optionCount: "two_to_five", surface: "workstream",
    }],
    ["elicitation_resolved", "api", "workspace-user", {
      elicitationId: "00000000-0000-4000-8000-000000000108",
      runId: "00000000-0000-4000-8000-000000000105",
      workstreamId: "00000000-0000-4000-8000-000000000101", responseType: "single_select",
      resolution: "answered", customResponseUsed: false, responseLatency: "2m_10m", surface: "workstream",
    }],
    ["workstream_participant_changed", "api", "workspace-user", {
      workstreamId: "00000000-0000-4000-8000-000000000101", action: "added",
      method: "picker", participantCount: "two_to_five", result: "success",
    }],
    ["workstream_resource_action_completed", "api", "workspace-user", {
      workstreamId: "00000000-0000-4000-8000-000000000101",
      resourceId: "00000000-0000-4000-8000-000000000109", resourceType: "document",
      connectorType: "google", relationshipType: "reference", action: "watch", result: "success",
      surface: "resource_inspector",
    }],
    ["run_action_completed", "api", "workspace-user", {
      workstreamId: "00000000-0000-4000-8000-000000000101",
      harnessRunId: "00000000-0000-4000-8000-000000000105", action: "retry", result: "success",
    }],
    ["terminal_workspace_terminal", "api", "workspace-user", {
      workstreamId: "00000000-0000-4000-8000-000000000101", action: "start",
      result: "success", duration: "5s_30s", repositorySelected: true,
      connectorType: "github", localFilesRetained: false,
    }],
    ["attention_consumed", "api", "workspace-user", {
      workstreamId: "00000000-0000-4000-8000-000000000101", unreadCount: "six_to_twenty",
      hadMention: true, neededInput: false, entrypoint: "sidebar_recent", timeToRead: "2m_10m",
    }],
    ["human_message_created", "api", "workspace-user", {
      workstreamId: "00000000-0000-4000-8000-000000000101",
      messageId: "00000000-0000-4000-8000-000000000103", channel: "slack",
      visibility: "public", workstreamOrigin: "ad_hoc", attachmentCount: 1,
      mentionCount: 2, participantAddedCount: 1,
    }],
    ["recording_start_completed", "desktop-renderer", "workspace-user", {
      noteId: "00000000-0000-4000-8000-000000000104", result: "permission_denied",
      permissionClass: "both_blocked", audioSource: "unknown", entrypoint: "sidebar",
    }],
    ["recording_terminal", "desktop-renderer", "workspace-user", {
      noteId: "00000000-0000-4000-8000-000000000104", result: "partial_transcript",
      duration: "2m_10m", segmentCount: "six_to_twenty", pauseCount: "two_to_five",
      finalSummaryResult: "success", audioSource: "microphone_only",
    }],
    ["note_summary_generation_completed", "api", "workspace-user", {
      noteId: "00000000-0000-4000-8000-000000000104", mode: "final", result: "success",
      duration: "5s_30s", transcriptStatus: "partial", segmentCount: "six_to_twenty",
      refreshCadence: "one_minute",
    }],
    ["note_opened_v2", "desktop-renderer", "workspace-user", {
      noteId: "00000000-0000-4000-8000-000000000104", visibility: "private",
      entrypoint: "sidebar_note", navigation: "reopened", recordingState: "complete",
      hasSummary: true, hasTranscript: true,
      duration: "2m_10m", segmentCount: "six_to_twenty",
    }],
    ["connector_setup_requested_v2", "desktop-renderer", "workspace-user", {
      connector: "granola", scope: "workspace", method: "api_key", capabilityCount: "two_to_five",
    }],
    ["connector_setup_completed_v2", "api", "workspace-user", {
      connector: "generic_webhook", scope: "workspace", method: "webhook", result: "success",
      duration: "1s_5s", capabilityCount: "two_to_five", reconnect: false,
    }],
    ["connector_action_completed", "api", "workspace-user", {
      connectorId: "00000000-0000-4000-8000-000000000110", connector: "slack",
      scope: "workspace", action: "test", previousHealth: "healthy", appliedHealth: "healthy",
      result: "success",
    }],
    ["connector_health_changed", "api", "workspace", {
      connectorId: "00000000-0000-4000-8000-000000000110", connector: "slack",
      scope: "workspace", previousHealth: "healthy", appliedHealth: "needs_reconnect", cause: "provider_auth",
    }],
    ["connector_activity_ingested", "api", "workspace", {
      connector: "slack", activityType: "message", result: "accepted", itemCount: "six_to_twenty",
    }],
    ["application_settings_state_v2", "desktop-main", "workspace-user", {
      launchAtLoginEnabled: true, launchAtLoginAvailable: true, lockdownModeEnabled: false,
      lockdownModeAvailable: true, menuBarEnabled: true, menuBarAvailable: true,
      menuBarPresent: true, applicationIcon: "ludicrous", applicationIconAutomatic: false,
      applicationIconAvailable: true,
    }],
    ["application_setting_change_completed_v2", "desktop-main", "workspace-user", {
      setting: "menu_bar", previousEnabled: false, requestedEnabled: true,
      appliedEnabled: true, result: "success",
    }],
    ["digest_schedule_updated", "api", "workspace-user", {
      enabled: true, dayCount: "six_to_twenty", timeCount: "two_to_five",
      cadence: "multiple_weekly", deliveryTargetTypes: ["email", "slack_agent_dm"], result: "success",
    }],
    ["digest_delivery_terminal", "api", "workspace-user", {
      deliveryId: "00000000-0000-4000-8000-000000000111", result: "success",
      activityCount: "twenty_one_to_one_hundred", targetTypes: ["email"], firstDelivery: true,
    }],
    ["workspace_invitation_terminal", "api", "workspace-user", {
      invitationId: "00000000-0000-4000-8000-000000000112", action: "accepted", role: "member",
      deliveryResult: "success", timeToTerminal: "2m_10m",
    }],
    ["terminal_policy_changed", "api", "workspace-user", {
      previousMode: "restricted", appliedMode: "custom", customDomainCount: "two_to_five",
      activeSandboxCount: "one", result: "success",
    }],
    ["site_page_viewed", "site", "anonymous-epoch", {
      page: "landing", pathname: "/", referringDomain: "example.com", campaignSource: "launch",
    }],
    ["site_page_viewed", "site", "anonymous-epoch", {
      page: "landing", pathname: "/", campaignSource: "x", adClickIdSource: "x",
    }],
    ["site_page_viewed", "site", "anonymous-epoch", {
      page: "landing", pathname: "/", trafficClass: "automated",
      trafficReasons: ["engine_mismatch", "hosting_network", "tz_offset_mismatch"],
    }],
    ["site_page_left", "site", "anonymous-epoch", {
      page: "landing", pathname: "/", duration: "1s_5s", pageSignals: ["human_input"],
      trafficClass: "human", trafficReasons: ["human_input"],
    }],
    ["site_page_left", "site", "anonymous-epoch", {
      page: "landing", pathname: "/", duration: "30s_2m",
    }],
    ["desktop_install_opened", "desktop-main", "anonymous-epoch", {
      flowId: "01a0ee73-d366-7fb9-b5c0-3ceb3156f70a", clientPlatform: "desktop",
    }],
    ["site_action_selected", "site", "anonymous-epoch", {
      page: "landing", action: "secondary_cta", placement: "hero",
      flowId: "01a0ee73-d366-7fb9-b5c0-3ceb3156f70a",
    }],
    ["site_action_selected", "site", "anonymous-epoch", {
      page: "landing", action: "download", placement: "hero",
    }],
    ["site_action_selected", "site", "anonymous-epoch", {
      page: "landing", pathname: "/start-fast/", action: "download", placement: "hero",
    }],
    ["site_action_selected", "site", "anonymous-epoch", {
      page: "landing", action: "download", placement: "pricing", plan: "grow",
    }],
    ["site_action_selected", "site", "anonymous-epoch", {
      page: "landing", action: "download", placement: "pricing", plan: "max",
    }],
    ["desktop_handoff_attempted", "site", "anonymous-epoch", {
      handoffType: "auth", method: "automatic", validity: "valid",
    }],
  ] as const)("accepts the new closed %s event", (name, source, identityScope, properties) => {
    expect(TelemetryEnvelopeSchema.safeParse({
      ...envelope(name, properties), source, identityScope,
    }).success).toBe(true);
  });

  it("accepts legacy context v1 while requiring native desktop fields to declare context v2", () => {
    const current = envelope("onboarding_region_selected", {
      selectedRegion: "enterprise",
      entrypoint: "first_run",
    });
    const withoutContextVersion: Record<string, unknown> = { ...current };
    delete withoutContextVersion.contextSchemaVersion;
    const legacyContext: Record<string, unknown> = { ...current.context };
    delete legacyContext.deviceId;
    const legacy = { ...withoutContextVersion, context: legacyContext };

    expect(TelemetryEnvelopeSchema.safeParse(legacy).success).toBe(true);
    expect(TelemetryEnvelopeSchema.safeParse(current).success).toBe(true);
    expect(TelemetryEnvelopeSchema.safeParse({
      ...withoutContextVersion,
      context: current.context,
    }).success).toBe(false);
  });

  it("accepts bounded native desktop SDK context and rejects malformed dimensions", () => {
    const base = envelope("onboarding_region_selected", {
      selectedRegion: "enterprise",
      entrypoint: "first_run",
    });
    const candidate = {
      ...base,
      context: {
        ...base.context,
        osVersion: "15.6.1",
        locale: "en-US",
        timezone: "America/Los_Angeles",
        screenWidth: 2560,
        screenHeight: 1440,
        viewportWidth: 1480,
        viewportHeight: 940,
        windowId: "018f22f2-4c22-7abc-8def-0123456789a9",
      },
    };
    expect(TelemetryEnvelopeSchema.safeParse(candidate).success).toBe(true);
    expect(TelemetryEnvelopeSchema.safeParse({
      ...candidate,
      context: { ...candidate.context, viewportWidth: -1 },
    }).success).toBe(false);
  });

  it.each([
    "Version 15.6.1 (Build 24G1234)",
    "6.1.0-0~bpo11+1",
    "10.0.26100.4770",
  ])("accepts a bounded platform OS version: %s", (osVersion) => {
    const candidate = envelope("onboarding_region_selected", {
      selectedRegion: "enterprise",
      entrypoint: "first_run",
    });
    expect(TelemetryEnvelopeSchema.safeParse({
      ...candidate,
      context: { ...candidate.context, osVersion },
    }).success).toBe(true);
  });

  it("rejects control characters in an OS version", () => {
    const candidate = envelope("onboarding_region_selected", {
      selectedRegion: "enterprise",
      entrypoint: "first_run",
    });
    expect(TelemetryEnvelopeSchema.safeParse({
      ...candidate,
      context: { ...candidate.context, osVersion: "15.6.1\nforged" },
    }).success).toBe(false);
  });

  it("requires both previous build fields only for application updates", () => {
    const candidate = {
      ...envelope("application_version_changed", {
        state: "updated",
        previousVersion: "0.23.0",
      }),
      source: "desktop-main",
      category: "essential",
      identityScope: "installation",
    };
    expect(TelemetryEnvelopeSchema.safeParse(candidate).success).toBe(false);
    expect(TelemetryEnvelopeSchema.safeParse({
      ...candidate,
      properties: { state: "installed", previousVersion: "0.23.0" },
    }).success).toBe(false);
  });

  it("accepts a bounded realtime-socket transition and refuses an unbounded one", () => {
    const socketEnvelope = (properties: unknown) => ({
      ...envelope("realtime_socket_state", properties),
      identityScope: "workspace-user",
    });
    expect(TelemetryEnvelopeSchema.parse(socketEnvelope({
      socket: "substream_feed",
      state: "retrying",
      cause: "ticket_timeout",
      attempts: "two_to_five",
    }))).toMatchObject({ name: "realtime_socket_state" });
    expect(TelemetryEnvelopeSchema.parse(socketEnvelope({
      socket: "substream_feed",
      state: "retrying",
      cause: "resync_required",
      attempts: "one",
    }))).toMatchObject({ name: "realtime_socket_state" });

    // A close code, a URL, a work-stream id, and an unregistered socket are all
    // things this event must not be able to grow into.
    expect(TelemetryEnvelopeSchema.safeParse(socketEnvelope({
      socket: "workspace", state: "retrying", cause: "server_closed", attempts: "one", closeCode: 1006,
    })).success).toBe(false);
    // Dictation's audio socket is deliberately outside this contract: it is an
    // Azure transport with its own lifecycle, not one of the room sockets.
    expect(TelemetryEnvelopeSchema.safeParse(socketEnvelope({
      socket: "dictation", state: "connected", cause: "opened", attempts: "zero",
    })).success).toBe(false);
    expect(TelemetryEnvelopeSchema.safeParse(socketEnvelope({
      socket: "workspace", state: "retrying", cause: "server_closed", attempts: 3,
    })).success).toBe(false);
  });

  it("refuses a socket state and cause that describe different transitions", () => {
    const socketEnvelope = (properties: unknown) => ({
      ...envelope("realtime_socket_state", properties),
      identityScope: "workspace-user",
    });
    // A socket that opened has no failure cause, and a failure cause did not
    // open a socket. Either combination would be counted as both.
    expect(TelemetryEnvelopeSchema.safeParse(socketEnvelope({
      socket: "workspace", state: "connected", cause: "transport_error", attempts: "zero",
    })).success).toBe(false);
    expect(TelemetryEnvelopeSchema.safeParse(socketEnvelope({
      socket: "workspace", state: "retrying", cause: "opened", attempts: "one",
    })).success).toBe(false);
    expect(TelemetryEnvelopeSchema.safeParse(socketEnvelope({
      socket: "workstream_control", state: "stopped", cause: "access_revoked", attempts: "zero",
    })).success).toBe(true);
  });

  it("accepts only bounded bundle-relative generated frames for JavaScript diagnostics", () => {
    const candidate = (errorCode: "react_boundary" | "network_error") => ({
      ...envelope("javascript_exception", {
        process: "renderer",
        errorCode,
        breadcrumbStatus: "available",
        fingerprint: "a".repeat(64),
        generatedFrames: ["index-CX8Z.js:120:4", "vendor.js:88:2"],
      }),
      source: "desktop-main",
      category: "diagnostic",
      identityScope: "platform-user",
    });
    expect(TelemetryEnvelopeSchema.safeParse(candidate("react_boundary")).success).toBe(true);
    expect(TelemetryEnvelopeSchema.safeParse(candidate("network_error")).success).toBe(true);
    expect(TelemetryEnvelopeSchema.safeParse({
      ...candidate("react_boundary"),
      properties: {
        process: "renderer",
        errorCode: "react_boundary",
        breadcrumbStatus: "available",
        fingerprint: "a".repeat(64),
        generatedFrames: ["/Users/person/private.js:1:2"],
      },
    }).success).toBe(false);
  });

  it.each([
    ["unregistered event", envelope("secret_event", {})],
    ["unknown property", envelope("onboarding_region_selected", {
      selectedRegion: "enterprise",
      entrypoint: "first_run",
      customerMessage: "top secret",
    })],
    ["category mismatch", { ...envelope("onboarding_region_selected", {
      selectedRegion: "enterprise",
      entrypoint: "first_run",
    }), category: "essential" }],
    ["source mismatch", { ...envelope("onboarding_region_selected", {
      selectedRegion: "enterprise",
      entrypoint: "first_run",
    }), source: "api" }],
    ["identity mismatch", { ...envelope("onboarding_region_selected", {
      selectedRegion: "enterprise",
      entrypoint: "first_run",
    }), identityScope: "installation" }],
    ["non-v7 event id", { ...envelope("onboarding_region_selected", {
      selectedRegion: "enterprise",
      entrypoint: "first_run",
    }), eventId: "018f22f2-4c22-4abc-8def-0123456789ab" }],
    ["direct identifier context", { ...envelope("onboarding_region_selected", {
      selectedRegion: "enterprise",
      entrypoint: "first_run",
    }), context: { ...envelope("x", {}).context, userId: "raw-user" } }],
  ])("rejects %s", (_label, candidate) => {
    expect(TelemetryEnvelopeSchema.safeParse(candidate).success).toBe(false);
  });

  it("bounds one upload batch", () => {
    const candidate = envelope("onboarding_region_selected", {
      selectedRegion: "global",
      entrypoint: "first_run",
    });
    const installationId = candidate.context.deviceId;
    expect(TelemetryBatchSchema.safeParse({
      installationId,
      events: Array.from({ length: 50 }, () => candidate),
    }).success)
      .toBe(true);
    expect(TelemetryBatchSchema.safeParse({
      installationId,
      events: Array.from({ length: 51 }, () => candidate),
    }).success)
      .toBe(false);
  });

  it("binds desktop device context to the batch installation identity at ingress", () => {
    const candidate = envelope("onboarding_region_selected", {
      selectedRegion: "global",
      entrypoint: "first_run",
    });
    const installationId = candidate.context.deviceId;
    expect(TelemetryBatchSchema.safeParse({ installationId, events: [candidate] }).success).toBe(true);
    expect(TelemetryBatchSchema.safeParse({ events: [candidate] }).success).toBe(false);
    expect(TelemetryBatchSchema.safeParse({ installationId: eventId, events: [candidate] }).success).toBe(false);
    expect(AnonymousTelemetryBatchSchema.safeParse({
      capability: "c".repeat(64),
      installationId,
      events: [candidate],
    }).success).toBe(true);
    expect(AnonymousTelemetryBatchSchema.safeParse({
      capability: "c".repeat(64),
      installationId: eventId,
      events: [candidate],
    }).success).toBe(false);
  });

  it("validates narrow telemetry responses without exposing destination identities", () => {
    expect(TelemetryAcceptanceBatchResponseSchema.parse({
      results: [{ result: "accepted", eventId }],
    })).toEqual({ results: [{ result: "accepted", eventId }] });
    expect(CrashIngestResponseSchema.parse({
      result: "accepted", uploadId: eventId, crashId: eventId,
    })).toMatchObject({ result: "accepted", crashId: eventId });
    expect(LinkAnonymousTelemetryResponseSchema.safeParse({
      result: "linked", analyticsPersonId: eventId,
    }).success).toBe(false);
  });

  it("allows only bounded typed crash breadcrumbs without arbitrary strings", () => {
    const sidecar = {
      version: 1,
      launchId: eventId,
      updatedAt: timestamp,
      entries: [{ sequence: 1, at: timestamp, kind: "screen_changed", screen: "workspace_home" }],
    };
    expect(TelemetryBreadcrumbSidecarSchema.safeParse(sidecar).success).toBe(true);
    expect(TelemetryBreadcrumbSidecarSchema.safeParse({
      ...sidecar,
      entries: [{ ...sidecar.entries[0], customerText: "private objective" }],
    }).success).toBe(false);
    expect(TelemetryBreadcrumbSidecarSchema.safeParse({
      ...sidecar,
      entries: Array.from({ length: 33 }, (_, index) => ({
        sequence: index + 1, at: timestamp, kind: "lifecycle", phase: "ready",
      })),
    }).success).toBe(false);
  });
});

describe("the envelope schema identifier", () => {
  const base = envelope("onboarding_region_selected", { selectedRegion: "enterprise", entrypoint: "first_run" });

  it("mints the current identifier", () => {
    expect(TELEMETRY_ENVELOPE_SCHEMA).toBe("ai.rallywith.telemetry.event");
    expect(TelemetryEnvelopeSchema.safeParse(base).success).toBe(true);
  });

  it("parses an envelope a build shipped before the rename still spools", () => {
    // A desktop build writes envelopes to disk before sending, so a spool
    // written by the previous build is drained by the next one. Rejecting the
    // superseded identifier would discard it silently.
    // Spelled out rather than looped over the constant: a rename that collapses
    // a superseded entry into the canonical one leaves a loop asserting only
    // that the current identifier parses, which it always does.
    for (const superseded of ["com.rally.telemetry.event", "com.avalon.telemetry.event"]) {
      expect(SUPERSEDED_TELEMETRY_ENVELOPE_SCHEMAS).toContain(superseded);
      expect(TelemetryEnvelopeSchema.safeParse({ ...base, schema: superseded }).success).toBe(true);
    }
    expect(SUPERSEDED_TELEMETRY_ENVELOPE_SCHEMAS).not.toContain(TELEMETRY_ENVELOPE_SCHEMA);
  });

  it("rejects an identifier that is neither current nor superseded", () => {
    expect(TelemetryEnvelopeSchema.safeParse({ ...base, schema: "com.example.telemetry.event" }).success)
      .toBe(false);
  });
});
