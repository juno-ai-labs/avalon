import "../../../tests/isolated-region";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelemetryEnvelope } from "@rally/contracts/telemetry";
import { TelemetryCollector } from "../src/telemetry/collector";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, migratedObservabilityFixture, sqliteD1 } from "./helpers/sqlite-d1";

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
    const identity = migratedSqliteDatabase();
    const database = new DatabaseSync(":memory:");
    database.exec(readFileSync(new URL("../../../packages/db/telemetry-migrations/0001_initial.sql", import.meta.url), "utf8"));
    const env = createTestEnv({ DB: sqliteD1(identity), TELEMETRY_DB: sqliteD1(database), AVALON_REGION: "global" });
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
    expect(identity.prepare("SELECT name FROM sqlite_schema WHERE name = 'telemetry_accepted_events'").get()).toBeUndefined();
    identity.close();
    database.close();
  });

  it("uses the same delivery policy for an isolated deployment", async () => {
    const database = migratedObservabilityFixture();
    const env = createTestEnv({ DB: sqliteD1(database), AVALON_REGION: "enterprise" });
    const collector = new TelemetryCollector(env);
    const event = productEvent({
      properties: { selectedRegion: "enterprise", entrypoint: "first_run" },
    });

    await expect(collector.accept(event, {
      route: "enterprise",
      routingBasis: "ip_geolocation",
      analyticsSubjectId: "enterprise-anonymous-epoch-1",
      subjectUserId: null,
      workspaceAnalyticsId: null,
    })).resolves.toEqual({ result: "accepted", eventId });

    const accepted = database.prepare(
      `SELECT route, delivery_state, terminal_code, delete_at, analytics_lakehouse_state
       FROM telemetry_accepted_events WHERE event_id = ?`,
    ).get(eventId);
    expect(accepted).toEqual({
      route: "enterprise",
      delivery_state: "pending",
      terminal_code: null,
      delete_at: "2026-11-10T20:00:05.000Z",
      analytics_lakehouse_state: "pending",
    });
    database.close();
  });

  it("acknowledges identical retries and rejects an event id reused for another payload", async () => {
    const database = migratedObservabilityFixture();
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
      properties: { selectedRegion: "enterprise", entrypoint: "first_run" },
    }), context)).resolves.toEqual({ result: "conflict", eventId });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM telemetry_accepted_events WHERE event_id = ?",
    ).get(eventId)).toEqual({ count: 1 });
    database.close();
  });

  it("fails closed for attributable nonessential events when the preference is off or missing", async () => {
    const database = migratedObservabilityFixture();
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
    const database = migratedObservabilityFixture();
    const collector = new TelemetryCollector(createTestEnv({ DB: sqliteD1(database), AVALON_REGION: "enterprise" }));
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

it('suppresses delayed built-in meeting telemetry before storing or scheduling it', async () => {
  const database = migratedObservabilityFixture();
  const env = createTestEnv({ DB: sqliteD1(database), AVALON_REGION: 'global' });
  const collector = new TelemetryCollector(env);
  const event = {
    ...productEvent(), name: 'note_opened', identityScope: 'workspace-user',
    properties: { noteId: '00000000-0000-7000-8000-000000000101', visibility: 'private', recordingState: 'complete', navigation: 'opened' },
  } as TelemetryEnvelope;
  const context = { route: 'global' as const, routingBasis: 'explicit_binding' as const,
    analyticsSubjectId: 'subject', subjectUserId: null, workspaceAnalyticsId: 'workspace' };
  await expect(collector.accept(event, context)).resolves.toEqual({ result: 'suppressed', eventId });
  expect(database.prepare('SELECT COUNT(*) AS count FROM telemetry_accepted_events').get()).toEqual({ count: 0 });
  expect(database.prepare('SELECT COUNT(*) AS count FROM telemetry_delivery_receipts').get()).toEqual({ count: 0 });
});
