import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelemetryEnvelope } from "@avalon/contracts/telemetry";
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

const event: TelemetryEnvelope = {
  schema: "com.avalon.telemetry.event",
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
        $exception_fingerprint: crash.fingerprint,
        $exception_source: "avalon_native",
        $session_id: crash.launchId,
        launch_id: crash.launchId,
        channel: "stable",
        native_crash_report: crash.report,
      }),
      crash.crashId,
    );
    expect(flush).toHaveBeenCalledOnce();
  });

  it.each([
    ["react_boundary", "ReactBoundary"],
    ["network_error", "NetworkError"],
  ] as const)("uses PostHog's exception SDK path for %s diagnostics", async (errorCode, expectedName) => {
    const exceptionEnvelope: TelemetryEnvelope = {
      ...event,
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
        $exception_fingerprint: "b".repeat(64),
        $session_id: exceptionEnvelope.context.launchId,
        launch_id: exceptionEnvelope.context.launchId,
        breadcrumb_status: "available",
      }),
      exceptionEnvelope.eventId,
    );
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
      timestamp: transition.createdAt,
      properties: {
        distinct_id: transition.destinationAnalyticsId,
        $anon_distinct_id: transition.anonymousEpochId,
        $set: { email: "ada@example.com", name: "Ada" },
        $insert_id: transition.jobId,
        $geoip_disable: true,
        $lib: "avalon-regional-telemetry",
        $lib_version: "1",
      },
    });
  });

  it("maps authenticated captures idiomatically without corrupting semantic properties", () => {
    expect(mapPostHogCapture(row({
      workspaceAnalyticsId: "018f22f2-4c22-7abc-8def-0123456789ae",
      envelope: { ...event, identityScope: "workspace-user" },
    }))).toEqual({
      event: "workspace_create_completed",
      timestamp: "2026-08-12T20:00:02.000Z",
      properties: {
        distinct_id: "018f22f2-4c22-7abc-8def-0123456789ad",
        $insert_id: event.eventId,
        $geoip_disable: true,
        $groups: { workspace: "018f22f2-4c22-7abc-8def-0123456789ae" },
        $lib: "avalon-regional-telemetry",
        $lib_version: "1",
        $process_person_profile: true,
        $set_once: { first_avalon_release: "0.24.0" },
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

  it("uses PostHog's reserved session property for desktop launch correlation", () => {
    const launchId = "018f22f2-4c22-7abc-8def-0123456789a0";
    const capture = mapPostHogCapture(row({
      envelope: { ...event, context: { ...event.context, launchId } },
    }));

    expect(capture.properties).toMatchObject({ $session_id: launchId, launch_id: launchId });
    expect(capture.properties).not.toHaveProperty("session_id");
  });

  it("keeps anonymous and installation captures personless", () => {
    expect(mapPostHogCapture(row({
      envelope: { ...event, identityScope: "installation" },
    })).properties).toMatchObject({ $process_person_profile: false });
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
      rows: [row()],
    })).resolves.toEqual({ result: "delivered", requestId: "posthog-request-1", retryAfterMs: null });

    expect(fetchMock).toHaveBeenCalledWith("https://us.i.posthog.com/batch", expect.objectContaining({
      method: "POST",
      headers: { "content-type": "application/json" },
    }));
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body));
    expect(body).toEqual({
      api_key: "phc_test_project_token",
      batch: [mapPostHogCapture(row())],
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
      rows: [row()],
    })).resolves.toEqual({ result, requestId: null, retryAfterMs });
  });

  it("rejects an unapproved host before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendPostHogBatch({
      host: "https://analytics.example.com",
      projectToken: "phc_test_project_token",
      rows: [row()],
    })).rejects.toThrow("posthog_host_forbidden");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
