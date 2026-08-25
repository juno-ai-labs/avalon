import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelemetryEnvelope } from "@rally/contracts/telemetry";
import { TelemetryBootstrapService } from "../src/telemetry/bootstrap";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const epochId = "018f22f2-4c22-7abc-8def-0123456789ab";
const eventId = "018f22f2-4c22-7abc-8def-0123456789ac";
const now = "2026-08-12T20:00:00.000Z";

function onboardingEvent(journeyId: string): TelemetryEnvelope {
  return {
    schema: "com.rally.telemetry.event",
    schemaVersion: 1,
    eventId,
    name: "onboarding_region_selected",
    source: "desktop-renderer",
    category: "product",
    identityScope: "anonymous-epoch",
    originalTimestamp: now,
    sentAt: now,
    context: {
      environment: "production",
      release: "0.24.0",
      buildId: "build-0123456789",
      onboardingJourneyId: journeyId,
      operationId: eventId,
    },
    properties: { selectedRegion: "eu", entrypoint: "first_run" },
  };
}

function lifecycleEvent(): TelemetryEnvelope {
  return {
    schema: "com.rally.telemetry.event",
    schemaVersion: 1,
    eventId,
    name: "application_lifecycle",
    source: "desktop-main",
    category: "essential",
    identityScope: "installation",
    originalTimestamp: now,
    sentAt: now,
    context: { environment: "production", release: "0.24.0", buildId: "build-0123456789" },
    properties: { state: "launch_started", crashReportingEligible: true },
  };
}

describe("anonymous telemetry bootstrap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ["DE", "eu", "ip_geolocation"],
    ["US", "global", "ip_geolocation"],
    [undefined, "global", "geolocation_fallback"],
    ["XX", "global", "geolocation_fallback"],
  ] as const)("routes country %s immediately to %s", async (country, route, routingBasis) => {
    const database = migratedSqliteDatabase();
    const service = new TelemetryBootstrapService(createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      SESSION_SIGNING_KEY: "test-telemetry-bootstrap-signing-key",
    }));

    const result = await service.bootstrap(epochId, country);
    expect(result).toMatchObject({ route, routingBasis });
    expect(result.capability).not.toContain(epochId);
    expect(database.prepare(`
      SELECT anonymous_epoch_id, route, routing_basis, created_at, expires_at, delete_at
      FROM telemetry_onboarding_journeys WHERE journey_id = ?
    `).get(result.journeyId)).toEqual({
      anonymous_epoch_id: epochId,
      route,
      routing_basis: routingBasis,
      created_at: now,
      expires_at: "2026-08-12T21:00:00.000Z",
      delete_at: "2026-11-10T20:00:00.000Z",
    });
    const serialized = JSON.stringify(database.prepare(
      "SELECT * FROM telemetry_onboarding_journeys WHERE journey_id = ?",
    ).get(result.journeyId));
    expect(serialized).not.toContain(country ?? "not-a-country");
    database.close();
  });

  it("forwards the exact validated EU projection and keeps no Global event row", async () => {
    const database = migratedSqliteDatabase();
    const projections: unknown[] = [];
    const service = new TelemetryBootstrapService(createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      SESSION_SIGNING_KEY: "test-telemetry-bootstrap-signing-key",
      EU_TELEMETRY_BRIDGE: {
        acceptAnonymous: async (projection: unknown) => {
          projections.push(projection);
          return { result: "accepted", eventId };
        },
      },
    }));
    const bootstrap = await service.bootstrap(epochId, "FR");

    await expect(service.accept(bootstrap.capability, [onboardingEvent(bootstrap.journeyId)]))
      .resolves.toEqual([{ result: "accepted", eventId }]);
    expect(projections).toEqual([{
      event: onboardingEvent(bootstrap.journeyId),
      route: "eu",
      routingBasis: "ip_geolocation",
      analyticsSubjectId: epochId,
      subjectUserId: null,
      workspaceAnalyticsId: null,
    }]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM telemetry_accepted_events").get())
      .toEqual({ count: 0 });
    database.close();
  });

  it("accepts a pre-workspace creation intent under the fixed anonymous epoch", async () => {
    const database = migratedSqliteDatabase();
    const projections: unknown[] = [];
    const service = new TelemetryBootstrapService(createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      SESSION_SIGNING_KEY: "test-telemetry-bootstrap-signing-key",
      EU_TELEMETRY_BRIDGE: {
        acceptAnonymous: async (projection: unknown) => {
          projections.push(projection);
          return { result: "accepted", eventId };
        },
      },
    }));
    const bootstrap = await service.bootstrap(epochId, "DE");
    const intent: TelemetryEnvelope = {
      ...onboardingEvent(bootstrap.journeyId),
      name: "workspace_create_requested",
      identityScope: "anonymous-epoch",
      properties: { selectedRegion: "eu", entrypoint: "first_run" },
    };

    await expect(service.accept(bootstrap.capability, [intent]))
      .resolves.toEqual([{ result: "accepted", eventId }]);
    expect(projections).toMatchObject([{
      route: "eu",
      analyticsSubjectId: epochId,
      event: { name: "workspace_create_requested", identityScope: "anonymous-epoch" },
    }]);
    database.close();
  });

  it("rejects expired, tampered, wrong-epoch, and non-onboarding capability use", async () => {
    const database = migratedSqliteDatabase();
    const service = new TelemetryBootstrapService(createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      SESSION_SIGNING_KEY: "test-telemetry-bootstrap-signing-key",
    }));
    const bootstrap = await service.bootstrap(epochId, "US");
    const valid = onboardingEvent(bootstrap.journeyId);

    await expect(service.accept(`${bootstrap.capability}x`, [valid]))
      .rejects.toThrow("telemetry_capability_invalid");
    await expect(service.accept(bootstrap.capability, [{ ...valid, identityScope: "workspace-user" }]))
      .rejects.toThrow("telemetry_anonymous_event_forbidden");
    await expect(service.accept(bootstrap.capability, [{ ...valid, name: "run_requested", properties: { entrypoint: "composer" } }]))
      .rejects.toThrow("telemetry_anonymous_event_forbidden");
    vi.advanceTimersByTime(60 * 60 * 1_000 + 1);
    await expect(service.accept(bootstrap.capability, [valid]))
      .rejects.toThrow("telemetry_capability_expired");
    database.close();
  });

  it("accepts only content-free installation health through a bootstrap capability", async () => {
    const database = migratedSqliteDatabase();
    const service = new TelemetryBootstrapService(createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      SESSION_SIGNING_KEY: "test-telemetry-bootstrap-signing-key",
    }));
    const bootstrap = await service.bootstrap(epochId, "US");
    const installationId = "018f22f2-4c22-7abc-8def-0123456789ad";
    await expect(service.accept(bootstrap.capability, [lifecycleEvent()], installationId))
      .resolves.toEqual([{ result: "accepted", eventId }]);
    expect(database.prepare(
      "SELECT analytics_subject_id, subject_user_id FROM telemetry_accepted_events",
    ).get()).toEqual({ analytics_subject_id: installationId, subject_user_id: null });
    database.close();
  });

  it("replaces an expired journey row before its retention sweep runs", async () => {
    const database = migratedSqliteDatabase();
    database.prepare(`INSERT INTO telemetry_onboarding_journeys
      (journey_id, anonymous_epoch_id, route, routing_basis, created_at, expires_at, delete_at)
      VALUES (?, ?, 'eu', 'ip_geolocation', ?, ?, ?)`).run(
      "018f22f2-4c22-7abc-8def-0123456789aa",
      epochId,
      "2026-05-13T19:00:00.000Z",
      "2026-05-13T20:00:00.000Z",
      "2026-08-12T19:59:59.000Z",
    );
    const service = new TelemetryBootstrapService(createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      SESSION_SIGNING_KEY: "test-telemetry-bootstrap-signing-key",
    }));

    const result = await service.bootstrap(epochId, "US");

    expect(result).toMatchObject({ route: "global", routingBasis: "ip_geolocation" });
    expect(result.journeyId).not.toBe("018f22f2-4c22-7abc-8def-0123456789aa");
    expect(database.prepare(`SELECT COUNT(*) AS count FROM telemetry_onboarding_journeys
      WHERE anonymous_epoch_id = ?`).get(epochId)).toEqual({ count: 1 });
    database.close();
  });
});
