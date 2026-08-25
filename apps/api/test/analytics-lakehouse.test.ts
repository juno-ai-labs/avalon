import type { TelemetryEnvelope } from "@avalon/contracts/telemetry";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { consumeAnalyticsLakehouseQueue } from "../src/queues/analytics-lakehouse-consumer";
import {
  recoverPendingAnalyticsLakehouseEvents,
  type AnalyticsLakehouseRecord,
} from "../src/services/analytics-lakehouse";
import { TelemetryCollector } from "../src/telemetry/collector";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const eventId = "018f22f2-4c22-7abc-8def-0123456789ab";

function event(): TelemetryEnvelope {
  return {
    schema: "com.avalon.telemetry.event",
    schemaVersion: 1,
    contextSchemaVersion: 2,
    eventId,
    name: "onboarding_region_selected",
    source: "desktop-renderer",
    category: "product",
    identityScope: "anonymous-epoch",
    originalTimestamp: "2026-08-24T19:00:00.000Z",
    sentAt: "2026-08-24T19:00:01.000Z",
    context: {
      environment: "production",
      release: "0.24.0",
      buildId: "build-0123456789",
      platform: "darwin",
      arch: "arm64",
      channel: "stable",
      launchId: "018f22f2-4c22-7abc-8def-0123456789a1",
      requestId: "018f22f2-4c22-7abc-8def-0123456789a2",
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      deviceId: "018f22f2-4c22-7abc-8def-0123456789a3",
      windowId: "018f22f2-4c22-7abc-8def-0123456789a4",
      osVersion: "15.6",
      locale: "en-US",
      timezone: "America/Los_Angeles",
      screenWidth: 1728,
      screenHeight: 1117,
      viewportWidth: 1280,
      viewportHeight: 800,
    },
    properties: { selectedRegion: "global", entrypoint: "first_run" },
  };
}

function backendEvent(): TelemetryEnvelope {
  return {
    schema: "com.avalon.telemetry.event",
    schemaVersion: 1,
    eventId: "018f22f2-4c22-7abc-8def-0123456789ac",
    name: "api_operation_outcome",
    source: "api",
    category: "essential",
    identityScope: "platform-user",
    originalTimestamp: "2026-08-24T19:02:00.000Z",
    sentAt: "2026-08-24T19:02:00.000Z",
    context: {
      environment: "production",
      release: "0.24.0",
      buildId: "build-0123456789",
      requestId: "018f22f2-4c22-7abc-8def-0123456789a5",
    },
    properties: { operation: "run_start", result: "success", duration: "100ms_1s" },
  };
}

describe("analytics events lakehouse", () => {
  it("projects backend events through the same accepted-event path", async () => {
    const database = migratedSqliteDatabase();
    const pointers: unknown[] = [];
    const delivered: AnalyticsLakehouseRecord[][] = [];
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      LOG_LEVEL: "error",
      ANALYTICS_LAKEHOUSE_QUEUE: createCloudflareTestBinding<Queue>({
        async send(body: unknown) { pointers.push(body); },
      }),
      ANALYTICS_LAKEHOUSE: createCloudflareTestBinding<NonNullable<Env["ANALYTICS_LAKEHOUSE"]>>({
        async send(records: Record<string, unknown>[]) {
          delivered.push(records as AnalyticsLakehouseRecord[]);
        },
      }),
    });
    await new TelemetryCollector(env).accept(backendEvent(), {
      route: "global",
      routingBasis: "explicit_binding",
      analyticsSubjectId: "person-analytics-1",
      subjectUserId: null,
      workspaceAnalyticsId: null,
    });
    const ack = vi.fn();
    await consumeAnalyticsLakehouseQueue({
      queue: "avalon-global-analytics-events-lakehouse",
      messages: [{ id: "backend", timestamp: new Date(), body: pointers[0], attempts: 1, ack, retry: vi.fn() }],
      metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    }, env);
    expect(delivered[0]?.[0]).toMatchObject({
      event_name: "api_operation_outcome",
      source: "api",
      authoritative_source: "api",
      properties: { operation: "run_start", result: "success", duration: "100ms_1s" },
    });
    expect(ack).toHaveBeenCalledOnce();
    database.close();
  });

  it("projects the complete accepted client metadata without direct user IDs", async () => {
    const database = migratedSqliteDatabase();
    const pointers: unknown[] = [];
    const delivered: AnalyticsLakehouseRecord[][] = [];
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      LOG_LEVEL: "error",
      ANALYTICS_LAKEHOUSE_QUEUE: createCloudflareTestBinding<Queue>({
        async send(body: unknown) { pointers.push(body); },
      }),
      ANALYTICS_LAKEHOUSE: createCloudflareTestBinding<NonNullable<Env["ANALYTICS_LAKEHOUSE"]>>({
        async send(records: Record<string, unknown>[]) {
          delivered.push(records as AnalyticsLakehouseRecord[]);
        },
      }),
    });

    await new TelemetryCollector(env).accept(event(), {
      route: "global",
      routingBasis: "geolocation_fallback",
      analyticsSubjectId: "anonymous-epoch-1",
      subjectUserId: null,
      workspaceAnalyticsId: "workspace-analytics-1",
    });
    expect(pointers).toHaveLength(1);
    expect(database.prepare(
      "SELECT analytics_lakehouse_state FROM telemetry_accepted_events WHERE event_id = ?",
    ).get(eventId)).toEqual({ analytics_lakehouse_state: "queued" });

    const ack = vi.fn();
    const retry = vi.fn();
    await consumeAnalyticsLakehouseQueue({
      queue: "avalon-global-analytics-events-lakehouse",
      messages: [{ id: "message-1", timestamp: new Date(), body: pointers[0], attempts: 1, ack, retry }],
      metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    }, env);

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(delivered[0]?.[0]).toMatchObject({
      event_id: eventId,
      event_name: "onboarding_region_selected",
      source: "desktop-renderer",
      authoritative_source: "desktop-renderer",
      owner: "product-analytics",
      regional_retention: "13-months",
      route: "global",
      analytics_subject_id: "anonymous-epoch-1",
      workspace_analytics_id: "workspace-analytics-1",
      request_id: "018f22f2-4c22-7abc-8def-0123456789a2",
      trace_id: "a".repeat(32),
      device_id: "018f22f2-4c22-7abc-8def-0123456789a3",
      os_version: "15.6",
      locale: "en-US",
      screen_width: 1728,
      property_classifications: { selectedRegion: "product", entrypoint: "product" },
      context: expect.objectContaining({ platform: "darwin", arch: "arm64" }),
      properties: { selectedRegion: "global", entrypoint: "first_run" },
    });
    expect(delivered[0]?.[0]).not.toHaveProperty("subject_user_id");
    expect(database.prepare(
      "SELECT analytics_lakehouse_state FROM telemetry_accepted_events WHERE event_id = ?",
    ).get(eventId)).toEqual({ analytics_lakehouse_state: "delivered" });
    database.close();
  });

  it("leaves a failed enqueue pending and recovers it without changing acceptance", async () => {
    const database = migratedSqliteDatabase();
    const recovered: unknown[] = [];
    const queue = createCloudflareTestBinding<Queue>({
      send: vi.fn().mockRejectedValueOnce(new Error("queue unavailable"))
        .mockImplementation(async (body: unknown) => { recovered.push(body); }),
    });
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      LOG_LEVEL: "error",
      ANALYTICS_LAKEHOUSE_QUEUE: queue,
    });

    await expect(new TelemetryCollector(env).accept(event(), {
      route: "global",
      routingBasis: "explicit_selection",
      analyticsSubjectId: "anonymous-epoch-1",
      subjectUserId: null,
      workspaceAnalyticsId: null,
    })).resolves.toEqual({ result: "accepted", eventId });
    expect(database.prepare(
      "SELECT analytics_lakehouse_state FROM telemetry_accepted_events WHERE event_id = ?",
    ).get(eventId)).toEqual({ analytics_lakehouse_state: "pending" });

    await expect(recoverPendingAnalyticsLakehouseEvents(env)).resolves.toBe(1);
    expect(recovered).toHaveLength(1);
    expect(database.prepare(
      "SELECT analytics_lakehouse_state FROM telemetry_accepted_events WHERE event_id = ?",
    ).get(eventId)).toEqual({ analytics_lakehouse_state: "queued" });
    database.close();
  });

  it("does not export EU client or backend telemetry", async () => {
    const database = migratedSqliteDatabase();
    const send = vi.fn();
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "eu",
      ANALYTICS_LAKEHOUSE_QUEUE: createCloudflareTestBinding<Queue>({ send }),
    });
    await new TelemetryCollector(env).accept(event(), {
      route: "eu",
      routingBasis: "ip_geolocation",
      analyticsSubjectId: "eu-anonymous-epoch-1",
      subjectUserId: null,
      workspaceAnalyticsId: null,
    });
    expect(send).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT analytics_lakehouse_state FROM telemetry_accepted_events WHERE event_id = ?",
    ).get(eventId)).toEqual({ analytics_lakehouse_state: null });
    database.close();
  });
});
