import "../../../tests/isolated-region";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelemetryCollector } from "../src/telemetry/collector";
import { processTelemetryOutbox } from "../src/telemetry/delivery";
import { recordDestinationOutcome } from "../src/telemetry/operations";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const now = "2026-08-12T20:00:00.000Z";

function envelope(eventId: string) {
  return {
    schema: "ai.rallywith.telemetry.event" as const,
    schemaVersion: 1 as const,
    eventId,
    name: "onboarding_region_selected" as const,
    source: "desktop-renderer" as const,
    category: "product" as const,
    identityScope: "anonymous-epoch" as const,
    originalTimestamp: now,
    sentAt: now,
    context: {
      environment: "production" as const,
      release: "0.24.0",
      buildId: "build-0123456789",
      onboardingJourneyId: "018f22f2-4c22-7abc-8def-0123456789aa",
    },
    properties: { selectedRegion: "global", entrypoint: "first_run" },
  };
}

function exceptionEnvelope(eventId: string) {
  return {
    schema: "ai.rallywith.telemetry.event" as const,
    schemaVersion: 1 as const,
    eventId,
    name: "javascript_exception" as const,
    source: "desktop-main" as const,
    category: "diagnostic" as const,
    identityScope: "platform-user" as const,
    originalTimestamp: now,
    sentAt: now,
    context: {
      environment: "production" as const,
      release: "1.235.0",
      buildId: "build-test",
      launchId: "018f22f2-4c22-7abc-8def-0123456789aa",
    },
    properties: {
      process: "main" as const,
      errorCode: "unknown" as const,
      breadcrumbStatus: "unavailable" as const,
      fingerprint: "a".repeat(64),
      generatedFrames: ["main.js:1:2"],
    },
  };
}

function insertAcceptedException(
  database: ReturnType<typeof migratedSqliteDatabase>,
  delivery: ReturnType<typeof exceptionEnvelope>,
): void {
  database.prepare(`
    INSERT INTO telemetry_accepted_events (
      event_id, payload_hash, envelope_json, route, routing_basis,
      analytics_subject_id, workspace_analytics_id, subject_user_id,
      accepted_at, normalized_timestamp, delete_at, delivery_state
    ) VALUES (?, ?, ?, 'global', 'explicit_binding', ?, NULL, NULL, ?, ?, ?, 'pending')
  `).run(
    delivery.eventId,
    "payload-hash",
    JSON.stringify(delivery),
    "subject-1",
    now,
    now,
    "2026-11-10T20:00:00.000Z",
  );
}

describe("Global telemetry delivery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("batches pending rows and records successful acknowledgement", async () => {
    const database = migratedSqliteDatabase();
    const deliverTelemetryBatch = vi.fn(async () => ({
      postHog: {
        result: "delivered" as const,
        requestId: "posthog-request-1",
        retryAfterMs: null,
      },
    }));
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      POSTHOG_HOST: "https://us.i.posthog.com",
      POSTHOG_PROJECT_TOKEN: "phc_test",
      PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
      TELEMETRY_DELIVERY: { deliverTelemetryBatch },
    });
    await new TelemetryCollector(env).accept(
      envelope("018f22f2-4c22-7abc-8def-0123456789ab"),
      {
        route: "global",
        routingBasis: "geolocation_fallback",
        analyticsSubjectId: "018f22f2-4c22-7abc-8def-0123456789ad",
        subjectUserId: null,
        workspaceAnalyticsId: null,
      },
    );
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("the regional API must not call PostHog directly");
    }));

    await expect(processTelemetryOutbox(env)).resolves.toEqual({
      selected: 1,
      delivered: 1,
      retried: 0,
      terminal: 0,
      suppressed: 0,
      expired: 0,
    });
    expect(database.prepare(
      "SELECT delivery_state, delivered_at, attempt_count FROM telemetry_accepted_events",
    ).get()).toEqual({ delivery_state: "delivered", delivered_at: now, attempt_count: 1 });
    expect(deliverTelemetryBatch).toHaveBeenCalledWith(expect.objectContaining({
      host: "https://us.i.posthog.com",
      projectToken: "phc_test",
      webBaseUrl: "https://with-avalon.com",
      rows: [expect.objectContaining({
        eventId: "018f22f2-4c22-7abc-8def-0123456789ab",
        analyticsSubjectId: "018f22f2-4c22-7abc-8def-0123456789ad",
      })],
    }));
    database.close();
  });

  it("delegates JavaScript exceptions to the exception RPC method", async () => {
    const database = migratedSqliteDatabase();
    const delivery = exceptionEnvelope("018f22f2-4c22-7abc-8def-0123456789af");
    insertAcceptedException(database, delivery);
    const deliverTelemetryBatch = vi.fn();
    const deliverJavascriptExceptionBatch = vi.fn(async () => ({
      postHog: {
        result: "delivered" as const,
        requestId: "posthog-exception-request-1",
        retryAfterMs: null,
      },
    }));
    const env = createTestEnv({
      DB: sqliteD1(database),
      TELEMETRY_PAYLOADS: { get: vi.fn(async () => null) },
      AVALON_REGION: "global",
      POSTHOG_HOST: "https://us.i.posthog.com",
      POSTHOG_PROJECT_TOKEN: "phc_test",
      TELEMETRY_DELIVERY: { deliverTelemetryBatch, deliverJavascriptExceptionBatch },
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("the regional API must not call PostHog directly");
    }));

    await expect(processTelemetryOutbox(env)).resolves.toMatchObject({
      selected: 1,
      delivered: 1,
    });
    expect(deliverTelemetryBatch).not.toHaveBeenCalled();
    expect(deliverJavascriptExceptionBatch).toHaveBeenCalledWith(expect.objectContaining({
      rows: [expect.objectContaining({
        eventId: delivery.eventId,
        symbolicatedFrames: ["main.js:1:2"],
      })],
    }));
    database.close();
  });

  it("commits a successful sibling when exception RPC transport rejects", async () => {
    const database = migratedSqliteDatabase();
    const ordinaryId = "018f22f2-4c22-7abc-8def-0123456789ab";
    const exception = exceptionEnvelope("018f22f2-4c22-7abc-8def-0123456789af");
    const env = createTestEnv({
      DB: sqliteD1(database),
      TELEMETRY_PAYLOADS: { get: vi.fn(async () => null) },
      AVALON_REGION: "global",
      POSTHOG_HOST: "https://us.i.posthog.com",
      POSTHOG_PROJECT_TOKEN: "phc_test",
      TELEMETRY_DELIVERY: {
        deliverTelemetryBatch: vi.fn(async () => ({
          postHog: {
            result: "delivered" as const,
            requestId: "posthog-request-mixed",
            retryAfterMs: null,
          },
        })),
        deliverJavascriptExceptionBatch: vi.fn(async () => {
          throw new Error("posthog_rpc_unavailable");
        }),
      },
    });
    await new TelemetryCollector(env).accept(envelope(ordinaryId), {
      route: "global",
      routingBasis: "geolocation_fallback",
      analyticsSubjectId: "018f22f2-4c22-7abc-8def-0123456789ad",
      subjectUserId: null,
      workspaceAnalyticsId: null,
    });
    insertAcceptedException(database, exception);

    await expect(processTelemetryOutbox(env)).resolves.toMatchObject({
      selected: 2,
      delivered: 1,
      retried: 1,
    });
    expect(database.prepare(`
      SELECT event_id, delivery_state, attempt_count, next_attempt_at
      FROM telemetry_accepted_events ORDER BY event_id
    `).all()).toEqual([
      {
        event_id: ordinaryId,
        delivery_state: "delivered",
        attempt_count: 1,
        next_attempt_at: null,
      },
      {
        event_id: exception.eventId,
        delivery_state: "retrying",
        attempt_count: 1,
        next_attempt_at: "2026-08-12T20:01:00.000Z",
      },
    ]);
    database.close();
  });

  it("translates telemetry RPC transport rejection into durable retry", async () => {
    const database = migratedSqliteDatabase();
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      POSTHOG_HOST: "https://us.i.posthog.com",
      POSTHOG_PROJECT_TOKEN: "phc_test",
      TELEMETRY_DELIVERY: {
        deliverTelemetryBatch: vi.fn(async () => {
          throw new Error("posthog_rpc_unavailable");
        }),
      },
    });
    await new TelemetryCollector(env).accept(
      envelope("018f22f2-4c22-7abc-8def-0123456789ab"),
      {
        route: "global",
        routingBasis: "geolocation_fallback",
        analyticsSubjectId: "018f22f2-4c22-7abc-8def-0123456789ad",
        subjectUserId: null,
        workspaceAnalyticsId: null,
      },
    );

    await expect(processTelemetryOutbox(env)).resolves.toMatchObject({ retried: 1 });
    expect(database.prepare(`
      SELECT delivery_state, attempt_count, next_attempt_at
      FROM telemetry_accepted_events
    `).get()).toEqual({
      delivery_state: "retrying",
      attempt_count: 1,
      next_attempt_at: "2026-08-12T20:01:00.000Z",
    });
    database.close();
  });

  it("retries transient failures without renewing the absolute deadline", async () => {
    const database = migratedSqliteDatabase();
    const deliverTelemetryBatch = vi.fn(async () => ({
      postHog: {
        result: "retry" as const,
        requestId: "posthog-request-2",
        retryAfterMs: 30_000,
      },
    }));
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      POSTHOG_HOST: "https://us.i.posthog.com",
      POSTHOG_PROJECT_TOKEN: "phc_test",
      TELEMETRY_DELIVERY: { deliverTelemetryBatch },
    });
    await new TelemetryCollector(env).accept(
      envelope("018f22f2-4c22-7abc-8def-0123456789ab"),
      {
        route: "global",
        routingBasis: "geolocation_fallback",
        analyticsSubjectId: "018f22f2-4c22-7abc-8def-0123456789ad",
        subjectUserId: null,
        workspaceAnalyticsId: null,
      },
    );
    const deadline = database.prepare("SELECT delete_at FROM telemetry_accepted_events").get();
    await expect(processTelemetryOutbox(env)).resolves.toMatchObject({ retried: 1 });
    expect(database.prepare(
      "SELECT delivery_state, attempt_count, next_attempt_at, delete_at FROM telemetry_accepted_events",
    ).get()).toEqual({
      delivery_state: "retrying",
      attempt_count: 1,
      next_attempt_at: "2026-08-12T20:00:30.000Z",
      ...deadline,
    });
    expect(deliverTelemetryBatch).toHaveBeenCalledTimes(1);
    database.close();
  });

  it("leaves accepted rows untouched while the destination circuit is open", async () => {
    const database = migratedSqliteDatabase();
    const deliverTelemetryBatch = vi.fn(async () => ({
      postHog: {
        result: "delivered" as const,
        requestId: "posthog-request-3",
        retryAfterMs: null,
      },
    }));
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      POSTHOG_HOST: "https://us.i.posthog.com",
      POSTHOG_PROJECT_TOKEN: "phc_test",
      TELEMETRY_DELIVERY: { deliverTelemetryBatch },
    });
    await new TelemetryCollector(env).accept(
      envelope("018f22f2-4c22-7abc-8def-0123456789ab"),
      {
        route: "global",
        routingBasis: "geolocation_fallback",
        analyticsSubjectId: "018f22f2-4c22-7abc-8def-0123456789ad",
        subjectUserId: null,
        workspaceAnalyticsId: null,
      },
    );
    for (let index = 0; index < 5; index += 1) {
      await recordDestinationOutcome(env, "posthog_capture", "retryable", new Date(now));
    }
    await expect(processTelemetryOutbox(env)).resolves.toMatchObject({ selected: 0, delivered: 0 });
    expect(deliverTelemetryBatch).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT delivery_state, attempt_count FROM telemetry_accepted_events",
    ).get()).toEqual({ delivery_state: "pending", attempt_count: 0 });

    vi.setSystemTime(new Date("2026-08-12T20:05:00.001Z"));
    await expect(processTelemetryOutbox(env)).resolves.toMatchObject({ selected: 1, delivered: 1 });
    expect(deliverTelemetryBatch).toHaveBeenCalledTimes(1);
    database.close();
  });



});
