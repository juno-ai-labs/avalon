import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("PostHog delivery Service Binding RPC protocol", () => {
  const binding = env.POSTHOG_RPC_TEST;
  if (!binding) throw new Error("POSTHOG_RPC_TEST binding is unavailable");

  it("carries a typed telemetry envelope to the private Worker", async () => {
    await expect(binding.sendTelemetryBatch({
      host: "https://us.i.posthog.com",
      projectToken: "phc_test",
      webBaseUrl: "https://rallywith.ai",
      rows: [{
        eventId: "00000000-0000-7000-8000-000000000001",
        envelope: {
          schema: "ai.rallywith.telemetry.event",
          schemaVersion: 1,
          eventId: "00000000-0000-7000-8000-000000000001",
          name: "onboarding_region_selected",
          source: "desktop-renderer",
          category: "product",
          identityScope: "anonymous-epoch",
          originalTimestamp: "2026-09-01T12:00:00.000Z",
          sentAt: "2026-09-01T12:00:00.000Z",
          context: {
            environment: "development",
            release: "1.235.0",
            buildId: "build-test",
            onboardingJourneyId: "00000000-0000-7000-8000-000000000002",
          },
          properties: { selectedRegion: "global", entrypoint: "first_run" },
        },
        analyticsSubjectId: "subject-1",
        workspaceAnalyticsId: null,
        normalizedTimestamp: "2026-09-01T12:00:00.000Z",
      }],
    })).resolves.toEqual({
      result: "delivered",
      requestId: "00000000-0000-7000-8000-000000000001:onboarding_region_selected:https://rallywith.ai",
      retryAfterMs: null,
    });
  });

  it("carries the sanitized nested crash report by value", async () => {
    await expect(binding.sendCrashBatch({
      host: "https://us.i.posthog.com",
      projectToken: "phc_test",
      rows: [{
        crashId: "00000000-0000-7000-8000-000000000003",
        deviceId: "device-1",
        analyticsSubjectId: "subject-1",
        workspaceAnalyticsId: "workspace-1",
        processPersonProfile: true,
        receivedAt: "2026-09-01T12:00:00.000Z",
        release: "1.235.0",
        buildId: "build-test",
        platform: "darwin",
        architecture: "arm64",
        processRole: "renderer",
        launchId: "00000000-0000-7000-8000-000000000004",
        channel: "stable",
        parserState: "symbolicated",
        fingerprint: "fingerprint-1",
        report: { status: "symbolicated", threads: [{ frames: [{ function: "main" }] }] },
      }],
    })).resolves.toEqual({
      result: "delivered",
      requestId: "symbolicated",
      retryAfterMs: null,
    });
  });

  it("exposes the exception and profile methods as typed RPC calls", async () => {
    const telemetryRow = {
      eventId: "00000000-0000-7000-8000-000000000005",
      envelope: {
        schema: "ai.rallywith.telemetry.event" as const,
        schemaVersion: 1 as const,
        eventId: "00000000-0000-7000-8000-000000000005",
        name: "javascript_exception" as const,
        source: "desktop-main" as const,
        category: "diagnostic" as const,
        identityScope: "platform-user" as const,
        originalTimestamp: "2026-09-01T12:00:00.000Z",
        sentAt: "2026-09-01T12:00:00.000Z",
        context: {
          environment: "development" as const,
          release: "1.235.0",
          buildId: "build-test",
        },
        properties: {
          process: "main" as const,
          errorCode: "unknown" as const,
          breadcrumbStatus: "unavailable" as const,
          fingerprint: "a".repeat(64),
          generatedFrames: ["main.js:1:2"],
        },
      },
      analyticsSubjectId: "subject-1",
      workspaceAnalyticsId: null,
      normalizedTimestamp: "2026-09-01T12:00:00.000Z",
      symbolicatedFrames: ["src/main.ts:10:2"],
    };

    const [exception, profile] = await Promise.all([
      binding.sendJavascriptExceptionBatch({
        host: "https://us.i.posthog.com",
        projectToken: "phc_test",
        rows: [telemetryRow],
      }),
      binding.sendProfileBatch({
        host: "https://us.i.posthog.com",
        projectToken: "phc_test",
        rows: [{
          jobId: "00000000-0000-7000-8000-000000000006",
          kind: "person_profile",
          destinationAnalyticsId: "subject-1",
          anonymousEpochId: null,
          properties: { name: "Ada" },
          createdAt: "2026-09-01T12:00:00.000Z",
        }],
      }),
    ]);

    expect(exception.requestId).toBe("src/main.ts:10:2");
    expect(profile.requestId).toBe("person_profile");
  });
});
