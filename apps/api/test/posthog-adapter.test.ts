import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelemetryEnvelope } from "@rally/contracts/telemetry";
import {
  mapPostHogCapture,
  mapPostHogProfileCapture,
  sendPostHogBatch,
  sendPostHogCrashBatch,
  sendPostHogJavascriptExceptionBatch,
  type GlobalTelemetryDeliveryRow,
  type GlobalCrashDeliveryRow,
  type GlobalProfileDeliveryRow,
} from "../src/telemetry/posthog-adapter";

/** The deployment's canonical public site, as the Worker's own var carries it. */
const WEB_BASE = { webBaseUrl: "https://rallywith.ai" };

const event: TelemetryEnvelope = {
  schema: "ai.rallywith.telemetry.event",
  schemaVersion: 1,
  eventId: "018f22f2-4c22-7abc-8def-0123456789ab",
  name: "workspace_create_completed",
  source: "api",
  category: "product",
  identityScope: "platform-user",
  originalTimestamp: "2026-08-12T20:00:00.000Z",
  sentAt: "2026-08-12T20:00:01.000Z",
  context: {
    environment: "production",
    region: "global",
    release: "0.24.0",
    buildId: "build-0123456789",
    operationId: "018f22f2-4c22-7abc-8def-0123456789ac",
  },
  properties: { selectedRegion: "global", result: "success" },
};

function row(overrides: Partial<GlobalTelemetryDeliveryRow> = {}): GlobalTelemetryDeliveryRow {
  return {
    eventId: event.eventId,
    envelope: event,
    analyticsSubjectId: "018f22f2-4c22-7abc-8def-0123456789ad",
    workspaceAnalyticsId: null,
    normalizedTimestamp: "2026-08-12T20:00:02.000Z",
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("PostHog adapter", () => {
  it("uses PostHog's exception SDK path for a full sanitized native report", async () => {
    const crash: GlobalCrashDeliveryRow = {
      crashId: "018f22f2-4c22-7abc-8def-0123456789af",
      deviceId: "018f22f2-4c22-7abc-8def-0123456789a4",
      analyticsSubjectId: "018f22f2-4c22-7abc-8def-0123456789ad",
      workspaceAnalyticsId: "018f22f2-4c22-7abc-8def-0123456789ae",
      processPersonProfile: true,
      receivedAt: "2026-08-12T20:00:02.000Z",
      release: "1.96.0",
      buildId: "build-123",
      platform: "darwin",
      architecture: "arm64",
      processRole: "renderer",
      launchId: "018f22f2-4c22-7abc-8def-0123456789a0",
      channel: "stable",
      parserState: "symbolicated",
      fingerprint: "a".repeat(64),
      report: { status: "ok", crash_info: { type: "EXC_BAD_ACCESS" }, threads: [{ frames: [{ function: "main" }] }] },
    };
    const captureException = vi.fn();
    const flush = vi.fn(async () => undefined);
    await expect(sendPostHogCrashBatch({
      host: "https://us.i.posthog.com",
      projectToken: "phc_test_project_token",
      rows: [crash],
      clientFactory: () => ({ captureException, flush }),
    })).resolves.toEqual({ result: "delivered", requestId: null, retryAfterMs: null });
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "NativeRendererCrash",
        message: "Native renderer crash",
        stack: expect.stringContaining("at main"),
      }),
      crash.analyticsSubjectId,
      expect.objectContaining({
        $process_person_profile: true,
        $groups: { workspace: crash.workspaceAnalyticsId },
        $app_name: "Rally",
        $app_namespace: "app.rally.desktop",
        $app_version: crash.release,
        $app_build: crash.buildId,
        $device_type: "Desktop",
        $device_id: crash.deviceId,
        $is_identified: true,
        $os_name: "macOS",
        $exception_fingerprint: crash.fingerprint,
        $exception_source: "rally_native",
        $session_id: crash.launchId,
        launch_id: crash.launchId,
        channel: "stable",
        native_crash_report: crash.report,
      }),
      crash.crashId,
    );
    expect(captureException.mock.calls[0]?.[2]).not.toHaveProperty("$lib");
    expect(captureException.mock.calls[0]?.[2]).not.toHaveProperty("$lib_version");
    expect(flush).toHaveBeenCalledOnce();
  });

  it.each([
    ["react_boundary", "ReactBoundary"],
    ["network_error", "NetworkError"],
  ] as const)("uses PostHog's exception SDK path for %s diagnostics", async (errorCode, expectedName) => {
    const exceptionEnvelope: TelemetryEnvelope = {
      ...event,
      contextSchemaVersion: 2,
      name: "javascript_exception",
      source: "desktop-main",
      category: "diagnostic",
      identityScope: "platform-user",
      context: {
        ...event.context,
        launchId: "018f22f2-4c22-7abc-8def-0123456789a0",
      },
      properties: {
        process: "renderer",
        errorCode,
        breadcrumbStatus: "available",
        fingerprint: "b".repeat(64),
        generatedFrames: ["index-CX8Z.js:120:4", "vendor.js:88:2"],
      },
    };
    const captureException = vi.fn();
    const flush = vi.fn(async () => undefined);
    await expect(sendPostHogJavascriptExceptionBatch({
      host: "https://us.i.posthog.com",
      projectToken: "phc_test_project_token",
      rows: [row({
        envelope: exceptionEnvelope,
        symbolicatedFrames: ["private-source.ts:41:7", "library.ts:9:2"],
      })],
      clientFactory: () => ({ captureException, flush }),
    })).resolves.toEqual({ result: "delivered", requestId: null, retryAfterMs: null });

    const capturedError = captureException.mock.calls[0]?.[0] as Error;
    expect(capturedError).toMatchObject({ name: expectedName, message: "Avalon renderer exception" });
    expect(capturedError.stack).toContain("at private-source.ts:41:7");
    expect(capturedError.stack).not.toContain("index-CX8Z.js");
    expect(captureException).toHaveBeenCalledWith(
      capturedError,
      row().analyticsSubjectId,
      expect.objectContaining({
        $app_name: "Rally",
        $app_namespace: "app.rally.desktop",
        $app_version: exceptionEnvelope.context.release,
        $app_build: exceptionEnvelope.context.buildId,
        $device_type: "Desktop",
        rally_event_name: "javascript_exception",
        $exception_fingerprint: "b".repeat(64),
        $session_id: exceptionEnvelope.context.launchId,
        launch_id: exceptionEnvelope.context.launchId,
        breadcrumb_status: "available",
      }),
      exceptionEnvelope.eventId,
    );
    expect(captureException.mock.calls[0]?.[2]).not.toHaveProperty("$lib");
    expect(captureException.mock.calls[0]?.[2]).not.toHaveProperty("$lib_version");
  });

  it("uses PostHog's identify direction for the one anonymous-to-person transition", () => {
    const transition: GlobalProfileDeliveryRow = {
      jobId: "018f22f2-4c22-7abc-8def-0123456789a1",
      kind: "epoch_transition",
      destinationAnalyticsId: "018f22f2-4c22-7abc-8def-0123456789a2",
      anonymousEpochId: "018f22f2-4c22-7abc-8def-0123456789a3",
      properties: { email: "ada@example.com", name: "Ada" },
      createdAt: "2026-08-12T20:00:00.000Z",
    };
    expect(mapPostHogProfileCapture(transition)).toEqual({
      event: "$identify",
      uuid: transition.jobId,
      timestamp: transition.createdAt,
      properties: {
        distinct_id: transition.destinationAnalyticsId,
        $anon_distinct_id: transition.anonymousEpochId,
        $set: { email: "ada@example.com", name: "Ada" },
        $insert_id: transition.jobId,
        $geoip_disable: true,
        $lib: "rally-regional-telemetry",
        $lib_version: "1",
        $is_server: true,
      },
    });
  });

  it("maps authenticated captures idiomatically without corrupting semantic properties", () => {
    expect(mapPostHogCapture(row({
      workspaceAnalyticsId: "018f22f2-4c22-7abc-8def-0123456789ae",
      envelope: { ...event, identityScope: "workspace-user" },
    }), WEB_BASE)).toEqual({
      event: "workspace_create_completed",
      uuid: event.eventId,
      timestamp: "2026-08-12T20:00:02.000Z",
      properties: {
        distinct_id: "018f22f2-4c22-7abc-8def-0123456789ad",
        $insert_id: event.eventId,
        $geoip_disable: true,
        $groups: { workspace: "018f22f2-4c22-7abc-8def-0123456789ae" },
        $lib: "rally-regional-telemetry",
        $lib_version: "1",
        $is_server: true,
        $process_person_profile: true,
        $is_identified: true,
        $set_once: { first_rally_release: "0.24.0" },
        rally_event_name: "workspace_create_completed",
        schema_version: 1,
        source: "api",
        category: "product",
        environment: "production",
        release: "0.24.0",
        build_id: "build-0123456789",
        region: "global",
        operation_id: "018f22f2-4c22-7abc-8def-0123456789ac",
        selectedRegion: "global",
        result: "success",
      },
    });
  });

  it("preserves server-authoritative connector attribution for work-stream creation", () => {
    const workstreamEnvelope: TelemetryEnvelope = {
      ...event,
      name: "workstream_created",
      identityScope: "workspace-user",
      properties: {
        workstreamId: "018f22f2-4c22-7abc-8def-0123456789a1",
        visibility: "public",
        creationSource: "suggested_work",
        origin: "ad_hoc",
        connectorType: "multiple",
        connectorTypes: ["linear", "slack"],
        connectorTypeCount: 2,
        participantCount: 1,
        attachmentCount: 0,
        modelOverride: false,
      },
    };

    expect(mapPostHogCapture(row({ envelope: workstreamEnvelope }), WEB_BASE).properties).toMatchObject({
      $is_server: true,
      rally_event_name: "workstream_created",
      creationSource: "suggested_work",
      connectorType: "multiple",
      connectorTypes: ["linear", "slack"],
      connectorTypeCount: 2,
    });
  });

  it("updates current person properties from application-settings state", () => {
    const settingsEnvelope: TelemetryEnvelope = {
      ...event,
      contextSchemaVersion: 2,
      name: "application_settings_state",
      source: "desktop-main",
      identityScope: "workspace-user",
      context: { ...event.context, platform: "darwin" },
      properties: {
        launchAtLoginEnabled: true,
        launchAtLoginAvailable: true,
        lockdownModeEnabled: false,
        lockdownModeAvailable: true,
        applicationIcon: "ludicrous",
        applicationIconAutomatic: false,
        applicationIconAvailable: true,
      },
    };

    expect(mapPostHogCapture(row({ envelope: settingsEnvelope }), WEB_BASE).properties).toMatchObject({
      $set: {
        rally_launch_at_login_enabled: true,
        rally_launch_at_login_available: true,
        rally_lockdown_mode_enabled: false,
        rally_lockdown_mode_available: true,
        rally_application_icon: "ludicrous",
        rally_application_icon_automatic: false,
        rally_application_icon_available: true,
      },
    });
  });

  it.each([
    [
      "application_setting_change_completed",
      {
        setting: "launch_at_login",
        previousEnabled: false,
        requestedEnabled: true,
        appliedEnabled: false,
      },
      { rally_launch_at_login_enabled: false },
    ],
    [
      "application_setting_change_completed",
      {
        setting: "lockdown_mode",
        previousEnabled: false,
        requestedEnabled: true,
        appliedEnabled: true,
      },
      { rally_lockdown_mode_enabled: true },
    ],
    [
      "application_icon_changed",
      {
        previousIcon: "dark",
        previousAutomatic: true,
        selectedIcon: "quiet",
        automatic: false,
      },
      {
        rally_application_icon: "quiet",
        rally_application_icon_automatic: false,
      },
    ],
  ] as const)("updates the relevant person property for %s", (name, properties, expectedSet) => {
    const settingsEnvelope: TelemetryEnvelope = {
      ...event,
      contextSchemaVersion: 2,
      name,
      source: "desktop-main",
      identityScope: "workspace-user",
      context: { ...event.context, platform: "darwin" },
      properties,
    };

    expect(mapPostHogCapture(row({ envelope: settingsEnvelope }), WEB_BASE).properties)
      .toMatchObject({ $set: expectedSet });
  });

  it("maps registered desktop screens to PostHog's canonical screen event", () => {
    const screenEnvelope: TelemetryEnvelope = {
      ...event,
      contextSchemaVersion: 2,
      name: "screen_viewed",
      source: "desktop-renderer",
      identityScope: "workspace-user",
      context: {
        ...event.context,
        platform: "darwin",
        arch: "arm64",
        channel: "stable",
        launchId: "018f22f2-4c22-7abc-8def-0123456789a0",
        deviceId: "018f22f2-4c22-7abc-8def-0123456789a4",
        osVersion: "15.6.1",
        locale: "en-US",
        timezone: "America/Los_Angeles",
        screenWidth: 3024,
        screenHeight: 1964,
        viewportWidth: 1480,
        viewportHeight: 940,
        windowId: "018f22f2-4c22-7abc-8def-0123456789a5",
      },
      properties: { screen: "workspace_home" },
    };

    expect(mapPostHogCapture(row({ envelope: screenEnvelope }), WEB_BASE)).toMatchObject({
      event: "$screen",
      properties: {
        rally_event_name: "screen_viewed",
        $screen_name: "workspace_home",
        screen: "workspace_home",
        $app_name: "Rally",
        $app_namespace: "app.rally.desktop",
        $app_version: "0.24.0",
        $app_build: "build-0123456789",
        $device_type: "Desktop",
        $os_name: "macOS",
        $os: "Mac OS X",
        $os_version: "15.6.1",
        $locale: "en-US",
        $timezone: "America/Los_Angeles",
        $screen_width: 3024,
        $screen_height: 1964,
        $viewport_width: 1480,
        $viewport_height: 940,
        $window_id: "018f22f2-4c22-7abc-8def-0123456789a5",
        $device_id: "018f22f2-4c22-7abc-8def-0123456789a4",
        $is_identified: true,
      },
    });
  });

  it("maps detailed desktop surfaces to PostHog's canonical screen event", () => {
    const capture = mapPostHogCapture(row({
      envelope: {
        ...event,
        name: "surface_viewed",
        source: "desktop-renderer",
        identityScope: "workspace-user",
        properties: {
          surface: "note_detail",
          entrypoint: "sidebar_note",
          resourceType: "note",
          resourceId: "018f22f2-4c22-7abc-8def-0123456789a1",
        },
      },
    }), WEB_BASE);

    expect(capture).toMatchObject({
      event: "$screen",
      properties: { $screen_name: "note_detail", rally_event_name: "surface_viewed" },
    });
  });

  it("maps public-site visits to canonical PostHog web events without desktop metadata", () => {
    const siteEnvelope: TelemetryEnvelope = {
      ...event,
      name: "site_page_viewed",
      source: "site",
      identityScope: "anonymous-epoch",
      context: {
        environment: "production",
        region: "global",
        release: "site-1",
        buildId: "site-1",
        sessionId: "018f22f2-4c22-7abc-8def-0123456789a0",
        onboardingJourneyId: "018f22f2-4c22-7abc-8def-0123456789a1",
      },
      properties: {
        page: "landing",
        pathname: "/",
        referringDomain: "example.com",
        campaignSource: "launch",
        campaignMedium: "email",
        campaignName: "august",
        adClickIdSource: "x",
      },
    };

    const capture = mapPostHogCapture(row({ envelope: siteEnvelope }), WEB_BASE);
    expect(capture).toMatchObject({
      event: "$pageview",
      properties: {
        $current_url: "https://rallywith.ai/",
        $pathname: "/",
        $host: "rallywith.ai",
        $referrer: "https://example.com/",
        $referring_domain: "example.com",
        $utm_source: "launch",
        $utm_medium: "email",
        $utm_campaign: "august",
        adClickIdSource: "x",
        $session_id: "018f22f2-4c22-7abc-8def-0123456789a0",
        $process_person_profile: false,
      },
    });
    expect(capture.properties).not.toHaveProperty("$app_name");
    expect(capture.properties).not.toHaveProperty("$device_type");
  });

  it.each([
    [
      { state: "installed" },
      "Application Installed",
      { version: "0.24.0", build: "build-0123456789" },
    ],
    [
      { state: "updated", previousVersion: "0.23.0", previousBuild: "2300" },
      "Application Updated",
      {
        version: "0.24.0",
        build: "build-0123456789",
        previous_version: "0.23.0",
        previous_build: "2300",
      },
    ],
  ] as const)("maps application version transition %s to %s", (properties, destinationEvent, destinationProperties) => {
    const versionEnvelope: TelemetryEnvelope = {
      ...event,
      contextSchemaVersion: 2,
      name: "application_version_changed",
      source: "desktop-main",
      category: "essential",
      identityScope: "installation",
      context: {
        ...event.context,
        platform: "darwin",
        deviceId: "018f22f2-4c22-7abc-8def-0123456789a4",
      },
      properties,
    };

    expect(mapPostHogCapture(row({ envelope: versionEnvelope }), WEB_BASE)).toMatchObject({
      event: destinationEvent,
      properties: {
        rally_event_name: "application_version_changed",
        $device_id: "018f22f2-4c22-7abc-8def-0123456789a4",
        $is_identified: false,
        ...destinationProperties,
      },
    });
  });

  it.each([
    ["system_start", "cold_start", false],
    ["dock", "activation", true],
    ["push_notification", "activation", true],
  ] as const)("maps %s application opens to the canonical PostHog event", (entrypoint, phase, fromBackground) => {
    const openedEnvelope: TelemetryEnvelope = {
      ...event,
      contextSchemaVersion: 2,
      name: "application_opened",
      source: "desktop-main",
      identityScope: "workspace-user",
      context: { ...event.context, platform: "darwin" },
      properties: { entrypoint, phase },
    };

    expect(mapPostHogCapture(row({ envelope: openedEnvelope }), WEB_BASE)).toMatchObject({
      event: "Application Opened",
      properties: {
        rally_event_name: "application_opened",
        application_open_source: entrypoint,
        from_background: fromBackground,
        ...(phase === "cold_start" ? { version: "0.24.0", build: "build-0123456789" } : {}),
      },
    });
  });

  it.each([
    ["launch_started", "application_lifecycle", undefined],
    ["foreground", "application_lifecycle", undefined],
    ["background", "Application Backgrounded", undefined],
    ["ready", "application_lifecycle", undefined],
    ["graceful_exit", "application_lifecycle", undefined],
  ] as const)("maps lifecycle state %s without manufacturing a second event", (state, destinationEvent, fromBackground) => {
    const lifecycleEnvelope: TelemetryEnvelope = {
      ...event,
      contextSchemaVersion: 2,
      name: "application_lifecycle",
      source: "desktop-main",
      category: "essential",
      identityScope: "installation",
      context: {
        ...event.context,
        platform: "win32",
        arch: "x64",
        channel: "stable",
        launchId: "018f22f2-4c22-7abc-8def-0123456789a0",
      },
      properties: { state, crashReportingEligible: true },
    };

    const capture = mapPostHogCapture(row({ envelope: lifecycleEnvelope }), WEB_BASE);
    expect(capture.event).toBe(destinationEvent);
    expect(capture.properties).toMatchObject({
      rally_event_name: "application_lifecycle",
      state,
      $app_version: "0.24.0",
      $app_build: "build-0123456789",
      $os_name: "Windows",
    });
    if (fromBackground === undefined) expect(capture.properties).not.toHaveProperty("from_background");
    else expect(capture.properties).toHaveProperty("from_background", fromBackground);
    expect(capture.properties).not.toHaveProperty("version");
    expect(capture.properties).not.toHaveProperty("build");
  });

  it("does not mark proxied desktop events as server events", () => {
    const capture = mapPostHogCapture(row({
      envelope: {
        ...event,
        contextSchemaVersion: 2,
        source: "desktop-renderer",
        name: "screen_viewed",
        properties: { screen: "workspace_home" },
      },
    }), WEB_BASE);

    expect(capture.properties).not.toHaveProperty("$is_server");
  });

  it("uses PostHog's reserved session property for desktop launch correlation", () => {
    const launchId = "018f22f2-4c22-7abc-8def-0123456789a0";
    const capture = mapPostHogCapture(row({
      envelope: { ...event, context: { ...event.context, launchId } },
    }), WEB_BASE);

    expect(capture.properties).toMatchObject({ $session_id: launchId, launch_id: launchId });
    expect(capture.properties).not.toHaveProperty("session_id");
  });

  it("keeps anonymous and installation captures personless", () => {
    expect(mapPostHogCapture(row({
      envelope: { ...event, identityScope: "installation" },
    }), WEB_BASE).properties).toMatchObject({ $process_person_profile: false, $is_identified: false });
  });

  it("keeps workspace-owned tool activity personless while grouping it", () => {
    const toolEnvelope: TelemetryEnvelope = {
      ...event,
      name: "agent_tool_started",
      source: "api",
      identityScope: "workspace",
      properties: {
        workstreamId: "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d3",
        harnessRunId: "018f3f4e-7b5a-7cc1-9a6f-2aa0324b79d4",
        toolName: "search_messages",
        pluginId: "rally.workstream",
        capability: "workstream.search",
        mode: "read",
        runKind: "system",
        executionScope: "workspace",
      },
    };
    const workspaceAnalyticsId = "018f22f2-4c22-7abc-8def-012345678900";

    expect(mapPostHogCapture(row({
      envelope: toolEnvelope,
      analyticsSubjectId: workspaceAnalyticsId,
      workspaceAnalyticsId,
    }), WEB_BASE).properties).toMatchObject({
      distinct_id: workspaceAnalyticsId,
      $groups: { workspace: workspaceAnalyticsId },
      $process_person_profile: false,
      $is_identified: false,
    });
  });

  it("does not update a person profile from an anonymous settings snapshot", () => {
    const settingsEnvelope: TelemetryEnvelope = {
      ...event,
      contextSchemaVersion: 2,
      name: "application_settings_state",
      source: "desktop-main",
      identityScope: "anonymous-epoch",
      context: { ...event.context, platform: "darwin" },
      properties: {
        launchAtLoginEnabled: true,
        launchAtLoginAvailable: true,
        lockdownModeEnabled: false,
        lockdownModeAvailable: true,
        applicationIcon: "dark",
        applicationIconAutomatic: true,
        applicationIconAvailable: true,
      },
    };

    expect(mapPostHogCapture(row({ envelope: settingsEnvelope }), WEB_BASE).properties)
      .not.toHaveProperty("$set");
  });

  it("discards retired meeting delivery already in flight from an old API", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendPostHogBatch({
      host: "https://us.i.posthog.com", projectToken: "test", webBaseUrl: WEB_BASE.webBaseUrl,
      rows: [row({ envelope: { ...event, name: "note_created", properties: {} } as TelemetryEnvelope })],
    })).resolves.toEqual({ result: "delivered", requestId: null, retryAfterMs: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the official batch shape and fixed configured endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, {
      status: 200,
      headers: { "x-request-id": "posthog-request-1" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendPostHogBatch({
      host: "https://us.i.posthog.com",
      projectToken: "phc_test_project_token",
      webBaseUrl: WEB_BASE.webBaseUrl,
      rows: [row()],
    })).resolves.toEqual({ result: "delivered", requestId: "posthog-request-1", retryAfterMs: null });

    expect(fetchMock).toHaveBeenCalledWith("https://us.i.posthog.com/batch", expect.objectContaining({
      method: "POST",
      headers: { "content-type": "application/json" },
    }));
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body));
    expect(body).toEqual({
      api_key: "phc_test_project_token",
      batch: [mapPostHogCapture(row(), WEB_BASE)],
    });
    expect(JSON.stringify(body)).not.toMatch(/ip_address|request_ip|email|customerMessage/u);
  });

  it.each([
    [408, "retry", null],
    [429, "retry", 15_000],
    [503, "retry", null],
    [400, "terminal", null],
    [401, "terminal", null],
  ] as const)("classifies status %s without returning provider body", async (status, result, retryAfterMs) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("secret provider payload", {
      status,
      headers: status === 429 ? { "retry-after": "15" } : {},
    })));
    await expect(sendPostHogBatch({
      host: "https://us.i.posthog.com",
      projectToken: "phc_test_project_token",
      webBaseUrl: WEB_BASE.webBaseUrl,
      rows: [row()],
    })).resolves.toEqual({ result, requestId: null, retryAfterMs });
  });

  it("rejects an unapproved host before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendPostHogBatch({
      host: "https://analytics.example.com",
      projectToken: "phc_test_project_token",
      webBaseUrl: WEB_BASE.webBaseUrl,
      rows: [row()],
    })).rejects.toThrow("posthog_host_forbidden");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("web page URLs stay on the configured site origin", () => {
  it("does not let a doubled-slash pathname resolve to another host", () => {
    // `site_page_viewed.pathname` is validated as `^\/[a-z0-9_:/.-]*$`, which
    // admits a leading `//`. Resolving that against the base with `new URL`
    // reads it as a network-path reference, so `$current_url` would name a host
    // that is not ours while `$host` still said it was. Reachable by visiting a
    // doubled-slash path on the site itself.
    const envelope: TelemetryEnvelope = {
      ...event,
      name: "site_page_viewed",
      source: "site",
      identityScope: "anonymous-epoch",
      properties: { page: "landing", pathname: "//evil.example/x" },
    };

    const capture = mapPostHogCapture(row({ envelope }), WEB_BASE);

    expect(capture.properties["$current_url"]).toBe("https://rallywith.ai//evil.example/x");
    expect(capture.properties["$host"]).toBe("rallywith.ai");
  });
});
