import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelemetryEnvelope } from "@rally/contracts/telemetry";
import { TelemetryCollector } from "../src/telemetry/collector";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const eventId = "018f22f2-4c22-7abc-8def-0123456789ab";
const timestamp = "2026-08-12T20:00:00.000Z";

function productEvent(
  overrides: Partial<Pick<TelemetryEnvelope, "eventId" | "originalTimestamp" | "sentAt" | "properties">> = {},
): TelemetryEnvelope {
  return {
    schema: "ai.rallywith.telemetry.event",
    schemaVersion: 1,
    eventId,
    name: "onboarding_region_selected",
    source: "desktop-renderer",
    category: "product",
    identityScope: "anonymous-epoch",
    originalTimestamp: timestamp,
    sentAt: timestamp,
    context: {
      environment: "production",
      release: "0.24.0",
      buildId: "build-0123456789",
      platform: "darwin",
      arch: "arm64",
      channel: "stable",
      launchId: "018f22f2-4c22-7abc-8def-0123456789a1",
      onboardingJourneyId: eventId,
      operationId: eventId,
    },
    properties: { selectedRegion: "global", entrypoint: "first_run" },
    ...overrides,
  };
}

describe("regional telemetry collector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T20:00:05.000Z"));
  });

  afterEach(() => vi.useRealTimers());

  it("durably accepts Global events with one immutable internal deadline", async () => {
    const database = migratedSqliteDatabase();
    const env = createTestEnv({ DB: sqliteD1(database), AVALON_REGION: "global" });
    const collector = new TelemetryCollector(env);

    await expect(collector.accept(productEvent(), {
      route: "global",
      routingBasis: "geolocation_fallback",
      analyticsSubjectId: "anonymous-epoch-1",
      subjectUserId: null,
      workspaceAnalyticsId: null,
    })).resolves.toEqual({ result: "accepted", eventId });

    const row = database.prepare(`
      SELECT route, routing_basis, delivery_state, accepted_at, normalized_timestamp,
             delete_at, subject_user_id, analytics_lakehouse_state
      FROM telemetry_accepted_events WHERE event_id = ?
    `).get(eventId);
    expect(row).toEqual({
      route: "global",
      routing_basis: "geolocation_fallback",
      delivery_state: "pending",
      accepted_at: "2026-08-12T20:00:05.000Z",
      normalized_timestamp: "2026-08-12T20:00:05.000Z",
      delete_at: "2026-11-10T20:00:05.000Z",
      subject_user_id: null,
      analytics_lakehouse_state: "pending",
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM telemetry_eu_events").get()).toEqual({ count: 0 });
    database.close();
  });

  it("writes EU product events only to the exact regional internal sink", async () => {
    const database = migratedSqliteDatabase();
    const env = createTestEnv({ DB: sqliteD1(database), AVALON_REGION: "eu" });
    const collector = new TelemetryCollector(env);
    const event = productEvent({
      properties: { selectedRegion: "eu", entrypoint: "first_run" },
    });

    await expect(collector.accept(event, {
      route: "eu",
      routingBasis: "ip_geolocation",
      analyticsSubjectId: "eu-anonymous-epoch-1",
      subjectUserId: null,
      workspaceAnalyticsId: null,
    })).resolves.toEqual({ result: "accepted", eventId });

    const accepted = database.prepare(
      `SELECT route, delivery_state, terminal_code, delete_at, analytics_lakehouse_state
       FROM telemetry_accepted_events WHERE event_id = ?`,
    ).get(eventId);
    expect(accepted).toEqual({
      route: "eu",
      delivery_state: "terminal",
      terminal_code: "eu_internal",
      delete_at: "2026-11-10T20:00:05.000Z",
      analytics_lakehouse_state: null,
    });
    const eu = database.prepare(`
      SELECT event_name, analytics_subject_id, workspace_analytics_id,
             environment, release, build_id, platform, architecture, channel, launch_id,
             properties_json, delete_at
      FROM telemetry_eu_events WHERE event_id = ?
    `).get(eventId);
    expect(eu).toEqual({
      event_name: "onboarding_region_selected",
      analytics_subject_id: "eu-anonymous-epoch-1",
      workspace_analytics_id: null,
      environment: "production",
      release: "0.24.0",
      build_id: "build-0123456789",
      platform: "darwin",
      architecture: "arm64",
      channel: "stable",
      launch_id: "018f22f2-4c22-7abc-8def-0123456789a1",
      properties_json: '{"entrypoint":"first_run","selectedRegion":"eu"}',
      delete_at: "2027-09-12T20:00:05.000Z",
    });
    database.close();
  });

  it("anchors the EU semantic-event deadline to the normalized occurrence, not delayed acceptance", async () => {
    const database = migratedSqliteDatabase();
    const collector = new TelemetryCollector(createTestEnv({ DB: sqliteD1(database), AVALON_REGION: "eu" }));
    const delayed = productEvent({
      originalTimestamp: "2026-08-01T00:00:00.000Z",
      sentAt: "2026-08-12T20:00:04.000Z",
      properties: { selectedRegion: "eu", entrypoint: "first_run" },
    });

    await collector.accept(delayed, {
      route: "eu",
      routingBasis: "ip_geolocation",
      analyticsSubjectId: "eu-anonymous-epoch-1",
      subjectUserId: null,
      workspaceAnalyticsId: null,
    });

    expect(database.prepare(`
      SELECT normalized_timestamp, delete_at FROM telemetry_eu_events WHERE event_id = ?
    `).get(eventId)).toEqual({
      normalized_timestamp: "2026-08-01T00:00:01.000Z",
      delete_at: "2027-09-01T00:00:01.000Z",
    });
    database.close();
  });

  it("acknowledges identical retries and rejects an event id reused for another payload", async () => {
    const database = migratedSqliteDatabase();
    const collector = new TelemetryCollector(createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
    }));
    const context = {
      route: "global" as const,
      routingBasis: "explicit_selection" as const,
      analyticsSubjectId: "anonymous-epoch-1",
      subjectUserId: null,
      workspaceAnalyticsId: null,
    };

    await expect(collector.accept(productEvent(), context)).resolves.toEqual({ result: "accepted", eventId });
    await expect(collector.accept(productEvent(), context)).resolves.toEqual({ result: "duplicate", eventId });
    await expect(collector.accept(productEvent({
      properties: { selectedRegion: "eu", entrypoint: "first_run" },
    }), context)).resolves.toEqual({ result: "conflict", eventId });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM telemetry_accepted_events WHERE event_id = ?",
    ).get(eventId)).toEqual({ count: 1 });
    database.close();
  });

  it("fails closed for attributable nonessential events when the preference is off or missing", async () => {
    const database = migratedSqliteDatabase();
    database.exec(`
      INSERT INTO users
        (id, google_subject, email, name, product_analytics_enabled, created_at, updated_at)
      VALUES
        ('off-user', 'off-subject', 'off@example.com', 'Off User', 0, '2026-08-12', '2026-08-12'),
        ('on-user', 'on-subject', 'on@example.com', 'On User', 1, '2026-08-12', '2026-08-12');
    `);
    const collector = new TelemetryCollector(createTestEnv({ DB: sqliteD1(database), AVALON_REGION: "global" }));
    const base = {
      route: "global" as const,
      routingBasis: "explicit_binding" as const,
      analyticsSubjectId: "person-1",
      workspaceAnalyticsId: null,
    };

    await expect(collector.accept(productEvent(), { ...base, subjectUserId: "off-user" }))
      .resolves.toEqual({ result: "suppressed", eventId });
    await expect(collector.accept(productEvent({ eventId: "018f22f2-4c22-7abc-8def-0123456789ac" }), {
      ...base,
      subjectUserId: "missing-user",
    })).resolves.toEqual({ result: "suppressed", eventId: "018f22f2-4c22-7abc-8def-0123456789ac" });
    await expect(collector.accept(productEvent({ eventId: "018f22f2-4c22-7abc-8def-0123456789ad" }), {
      ...base,
      subjectUserId: "on-user",
    })).resolves.toEqual({ result: "accepted", eventId: "018f22f2-4c22-7abc-8def-0123456789ad" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM telemetry_accepted_events").get()).toEqual({ count: 1 });
    database.close();
  });

  it("rejects a forged route before any regional write", async () => {
    const database = migratedSqliteDatabase();
    const collector = new TelemetryCollector(createTestEnv({ DB: sqliteD1(database), AVALON_REGION: "eu" }));
    await expect(collector.accept(productEvent(), {
      route: "global",
      routingBasis: "explicit_binding",
      analyticsSubjectId: "person-1",
      subjectUserId: null,
      workspaceAnalyticsId: null,
    })).resolves.toEqual({ result: "route_mismatch", eventId });
    expect(database.prepare("SELECT COUNT(*) AS count FROM telemetry_accepted_events").get()).toEqual({ count: 0 });
    database.close();
  });
});
