import { describe, expect, it } from "vitest";
import {
  AnonymousTelemetryBatchSchema,
  CrashIngestResponseSchema,
  LinkAnonymousTelemetryResponseSchema,
  TelemetryAcceptanceBatchResponseSchema,
  TelemetryBatchSchema,
  TelemetryBreadcrumbSidecarSchema,
  TelemetryEnvelopeSchema,
  TELEMETRY_EVENTS,
  telemetryEventNames,
} from "./telemetry";

const eventId = "018f22f2-4c22-7abc-8def-0123456789ab";
const timestamp = "2026-08-12T20:00:00.000Z";

function envelope(name: string, properties: unknown) {
  return {
    schema: "com.avalon.telemetry.event",
    schemaVersion: 1,
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
        Object.keys(entry.properties.shape).sort(),
      );
      expect(entry.compatibilityNote.length).toBeGreaterThan(10);
      expect(entry.destination).toMatch(/^(posthog-and-eu-internal|internal-only)$/u);
    }
  });

  it("accepts the registered anonymous onboarding intent with exact properties", () => {
    expect(TelemetryEnvelopeSchema.parse(envelope("onboarding_region_selected", {
      selectedRegion: "eu",
      entrypoint: "first_run",
    }))).toMatchObject({ name: "onboarding_region_selected" });
  });

  it("accepts bounded native desktop SDK context and rejects malformed dimensions", () => {
    const base = envelope("onboarding_region_selected", {
      selectedRegion: "eu",
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
      selectedRegion: "eu",
      entrypoint: "first_run",
      customerMessage: "top secret",
    })],
    ["category mismatch", { ...envelope("onboarding_region_selected", {
      selectedRegion: "eu",
      entrypoint: "first_run",
    }), category: "essential" }],
    ["source mismatch", { ...envelope("onboarding_region_selected", {
      selectedRegion: "eu",
      entrypoint: "first_run",
    }), source: "api" }],
    ["identity mismatch", { ...envelope("onboarding_region_selected", {
      selectedRegion: "eu",
      entrypoint: "first_run",
    }), identityScope: "installation" }],
    ["non-v7 event id", { ...envelope("onboarding_region_selected", {
      selectedRegion: "eu",
      entrypoint: "first_run",
    }), eventId: "018f22f2-4c22-4abc-8def-0123456789ab" }],
    ["direct identifier context", { ...envelope("onboarding_region_selected", {
      selectedRegion: "eu",
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
