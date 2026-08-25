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
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      POSTHOG_HOST: "https://us.i.posthog.com",
      POSTHOG_PROJECT_TOKEN: "phc_test",
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
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));

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
    database.close();
  });

  it("retries transient failures without renewing the absolute deadline", async () => {
    const database = migratedSqliteDatabase();
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      POSTHOG_HOST: "https://us.i.posthog.com",
      POSTHOG_PROJECT_TOKEN: "phc_test",
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
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {
      status: 429,
      headers: { "retry-after": "30" },
    })));

    await expect(processTelemetryOutbox(env)).resolves.toMatchObject({ retried: 1 });
    expect(database.prepare(
      "SELECT delivery_state, attempt_count, next_attempt_at, delete_at FROM telemetry_accepted_events",
    ).get()).toEqual({
      delivery_state: "retrying",
      attempt_count: 1,
      next_attempt_at: "2026-08-12T20:00:30.000Z",
      ...deadline,
    });
    database.close();
  });

  it("leaves accepted rows untouched while the destination circuit is open", async () => {
    const database = migratedSqliteDatabase();
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      POSTHOG_HOST: "https://us.i.posthog.com",
      POSTHOG_PROJECT_TOKEN: "phc_test",
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
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(processTelemetryOutbox(env)).resolves.toMatchObject({ selected: 0, delivered: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT delivery_state, attempt_count FROM telemetry_accepted_events",
    ).get()).toEqual({ delivery_state: "pending", attempt_count: 0 });

    vi.setSystemTime(new Date("2026-08-12T20:05:00.001Z"));
    await expect(processTelemetryOutbox(env)).resolves.toMatchObject({ selected: 1, delivered: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    database.close();
  });

  it("never calls PostHog from EU and physically reaps expired internal rows", async () => {
    const database = migratedSqliteDatabase();
    database.exec(`
      INSERT INTO telemetry_delivery_receipts
        (event_id, payload_hash, route, result_code, created_at, delete_at)
      VALUES ('expired', 'hash', 'eu', 'accepted', '2026-01-01', '2026-08-12T19:59:59.000Z');
    `);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await processTelemetryOutbox(createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "eu",
    }));
    expect(result).toMatchObject({ selected: 0, expired: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(database.prepare("SELECT COUNT(*) AS count FROM telemetry_delivery_receipts").get())
      .toEqual({ count: 0 });
    database.close();
  });

  it("keeps 13-month EU semantic contributions after 90-day delivery metadata expires", async () => {
    const database = migratedSqliteDatabase();
    const env = createTestEnv({ DB: sqliteD1(database), AVALON_REGION: "eu" });
    await new TelemetryCollector(env).accept(
      { ...envelope("018f22f2-4c22-7abc-8def-0123456789ab"), properties: {
        selectedRegion: "eu", entrypoint: "first_run",
      } },
      {
        route: "eu",
        routingBasis: "ip_geolocation",
        analyticsSubjectId: "018f22f2-4c22-7abc-8def-0123456789ad",
        subjectUserId: null,
        workspaceAnalyticsId: null,
      },
    );

    vi.setSystemTime(new Date("2026-11-11T20:00:01.000Z"));
    await processTelemetryOutbox(env);
    expect(database.prepare("SELECT COUNT(*) AS count FROM telemetry_accepted_events").get())
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM telemetry_eu_events").get())
      .toEqual({ count: 1 });

    vi.setSystemTime(new Date("2027-09-13T20:00:01.000Z"));
    await processTelemetryOutbox(env);
    expect(database.prepare("SELECT COUNT(*) AS count FROM telemetry_eu_events").get())
      .toEqual({ count: 0 });
    database.close();
  });
});
