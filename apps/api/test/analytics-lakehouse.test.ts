import type { TelemetryEnvelope } from "@avalon/contracts/telemetry";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { consumeAnalyticsLakehouseQueue } from "../src/queues/analytics-lakehouse-consumer";
import {
  ANALYTICS_LAKEHOUSE_RECOVERY_QUERY,
  analyticsLakehousePointer,
  recoverUndeliveredAnalyticsLakehouseEvents,
  type AnalyticsLakehouseRecord,
} from "../src/services/analytics-lakehouse";
import { TelemetryCollector } from "../src/telemetry/collector";
import { canonicalTelemetryJson, telemetryPayloadHash } from "../src/telemetry/payload-integrity";
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

    await expect(recoverUndeliveredAnalyticsLakehouseEvents(env)).resolves.toBe(1);
    expect(recovered).toHaveLength(1);
    expect(database.prepare(
      "SELECT analytics_lakehouse_state FROM telemetry_accepted_events WHERE event_id = ?",
    ).get(eventId)).toEqual({ analytics_lakehouse_state: "queued" });
    database.close();
  });

  it("recovers queued rows after consumer retries can exhaust", async () => {
    const database = migratedSqliteDatabase();
    const pointers: unknown[] = [];
    const pipelineSend = vi.fn().mockRejectedValueOnce(new Error("pipeline unavailable"))
      .mockResolvedValue(undefined);
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      LOG_LEVEL: "error",
      ANALYTICS_LAKEHOUSE_QUEUE: createCloudflareTestBinding<Queue>({
        async send(body: unknown) { pointers.push(body); },
      }),
      ANALYTICS_LAKEHOUSE: createCloudflareTestBinding<NonNullable<Env["ANALYTICS_LAKEHOUSE"]>>({
        send: pipelineSend,
      }),
    });
    await new TelemetryCollector(env).accept(event(), {
      route: "global",
      routingBasis: "explicit_selection",
      analyticsSubjectId: "anonymous-epoch-1",
      subjectUserId: null,
      workspaceAnalyticsId: null,
    });
    const retry = vi.fn();
    await consumeAnalyticsLakehouseQueue({
      queue: "avalon-global-analytics-events-lakehouse",
      messages: [{ id: "failed", timestamp: new Date(), body: pointers[0], attempts: 1, ack: vi.fn(), retry }],
      metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    }, env);
    expect(retry).toHaveBeenCalledOnce();
    expect(database.prepare(
      "SELECT analytics_lakehouse_state FROM telemetry_accepted_events WHERE event_id = ?",
    ).get(eventId)).toEqual({ analytics_lakehouse_state: "queued" });

    pointers.length = 0;
    await expect(recoverUndeliveredAnalyticsLakehouseEvents(env)).resolves.toBe(1);
    expect(pointers).toHaveLength(1);
    const ack = vi.fn();
    await consumeAnalyticsLakehouseQueue({
      queue: "avalon-global-analytics-events-lakehouse",
      messages: [{ id: "recovered", timestamp: new Date(), body: pointers[0], attempts: 1, ack, retry: vi.fn() }],
      metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    }, env);
    expect(ack).toHaveBeenCalledOnce();
    expect(pipelineSend).toHaveBeenCalledTimes(2);
    expect(database.prepare(
      "SELECT analytics_lakehouse_state FROM telemetry_accepted_events WHERE event_id = ?",
    ).get(eventId)).toEqual({ analytics_lakehouse_state: "delivered" });
    database.close();
  });

  it("uses the partial recovery index without sorting the retained ledger", () => {
    const database = migratedSqliteDatabase();
    const plan = database.prepare(`EXPLAIN QUERY PLAN ${ANALYTICS_LAKEHOUSE_RECOVERY_QUERY}`)
      .all("2026-08-24T20:00:00.000Z") as { detail: string }[];
    expect(plan.some((step) => step.detail.includes("telemetry_accepted_events_analytics_lakehouse_idx"))).toBe(true);
    expect(plan.some((step) => step.detail.includes("USE TEMP B-TREE"))).toBe(false);
    database.close();
  });

  it("acknowledges a missing acceptance row as expired", async () => {
    const database = migratedSqliteDatabase();
    const ack = vi.fn();
    const retry = vi.fn();
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      LOG_LEVEL: "error",
      ANALYTICS_LAKEHOUSE: createCloudflareTestBinding<NonNullable<Env["ANALYTICS_LAKEHOUSE"]>>({
        send: vi.fn(),
      }),
    });
    await consumeAnalyticsLakehouseQueue({
      queue: "avalon-global-analytics-events-lakehouse",
      messages: [{
        id: "expired",
        timestamp: new Date(),
        body: analyticsLakehousePointer(eventId, "missing-row-hash"),
        attempts: 1,
        ack,
        retry,
      }],
      metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    }, env);
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    database.close();
  });

  it("acknowledges a pointer whose hash does not match the canonical row", async () => {
    const database = migratedSqliteDatabase();
    const pointers: unknown[] = [];
    const pipelineSend = vi.fn();
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      LOG_LEVEL: "error",
      ANALYTICS_LAKEHOUSE_QUEUE: createCloudflareTestBinding<Queue>({
        async send(body: unknown) { pointers.push(body); },
      }),
      ANALYTICS_LAKEHOUSE: createCloudflareTestBinding<NonNullable<Env["ANALYTICS_LAKEHOUSE"]>>({
        send: pipelineSend,
      }),
    });
    await new TelemetryCollector(env).accept(event(), {
      route: "global",
      routingBasis: "explicit_selection",
      analyticsSubjectId: "anonymous-epoch-1",
      subjectUserId: null,
      workspaceAnalyticsId: null,
    });
    const ack = vi.fn();
    const retry = vi.fn();
    await consumeAnalyticsLakehouseQueue({
      queue: "avalon-global-analytics-events-lakehouse",
      messages: [{
        id: "wrong-hash",
        timestamp: new Date(),
        body: { ...(pointers[0] as object), payloadHash: "wrong-hash" },
        attempts: 1,
        ack,
        retry,
      }],
      metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    }, env);
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(pipelineSend).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT analytics_lakehouse_state FROM telemetry_accepted_events WHERE event_id = ?",
    ).get(eventId)).toEqual({ analytics_lakehouse_state: "queued" });
    database.close();
  });

  it("acknowledges an analytics pointer that reaches the EU consumer", async () => {
    const database = migratedSqliteDatabase();
    const pipelineSend = vi.fn();
    const ack = vi.fn();
    const retry = vi.fn();
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "eu",
      LOG_LEVEL: "error",
      ANALYTICS_LAKEHOUSE: createCloudflareTestBinding<NonNullable<Env["ANALYTICS_LAKEHOUSE"]>>({
        send: pipelineSend,
      }),
    });
    await consumeAnalyticsLakehouseQueue({
      queue: "avalon-global-analytics-events-lakehouse",
      messages: [{
        id: "misrouted",
        timestamp: new Date(),
        body: analyticsLakehousePointer(eventId, "pointer-hash"),
        attempts: 1,
        ack,
        retry,
      }],
      metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    }, env);
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(pipelineSend).not.toHaveBeenCalled();
    database.close();
  });

  it("suppresses an attributable product event after a late opt-out", async () => {
    const database = migratedSqliteDatabase();
    database.prepare(`INSERT INTO users
      (id, google_subject, email, name, created_at, updated_at, product_analytics_enabled)
      VALUES ('analytics-user', 'analytics-google', 'analytics@example.com', 'Analytics User',
              '2026-08-24T19:00:00.000Z', '2026-08-24T19:00:00.000Z', 1)`).run();
    const pointers: unknown[] = [];
    const pipelineSend = vi.fn();
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      LOG_LEVEL: "error",
      ANALYTICS_LAKEHOUSE_QUEUE: createCloudflareTestBinding<Queue>({
        async send(body: unknown) { pointers.push(body); },
      }),
      ANALYTICS_LAKEHOUSE: createCloudflareTestBinding<NonNullable<Env["ANALYTICS_LAKEHOUSE"]>>({
        send: pipelineSend,
      }),
    });
    await new TelemetryCollector(env).accept(event(), {
      route: "global",
      routingBasis: "explicit_binding",
      analyticsSubjectId: "person-analytics-1",
      subjectUserId: "analytics-user",
      workspaceAnalyticsId: null,
    });
    database.prepare("UPDATE users SET product_analytics_enabled = 0 WHERE id = 'analytics-user'").run();
    const ack = vi.fn();
    const retry = vi.fn();
    await consumeAnalyticsLakehouseQueue({
      queue: "avalon-global-analytics-events-lakehouse",
      messages: [{ id: "suppressed", timestamp: new Date(), body: pointers[0], attempts: 1, ack, retry }],
      metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    }, env);
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(pipelineSend).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT analytics_lakehouse_state FROM telemetry_accepted_events WHERE event_id = ?",
    ).get(eventId)).toEqual({ analytics_lakehouse_state: "suppressed" });
    database.close();
  });

  it("recomputes the acceptance hash and rejects a modified stored envelope", async () => {
    const database = migratedSqliteDatabase();
    const pointers: unknown[] = [];
    const pipelineSend = vi.fn();
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      LOG_LEVEL: "error",
      ANALYTICS_LAKEHOUSE_QUEUE: createCloudflareTestBinding<Queue>({
        async send(body: unknown) { pointers.push(body); },
      }),
      ANALYTICS_LAKEHOUSE: createCloudflareTestBinding<NonNullable<Env["ANALYTICS_LAKEHOUSE"]>>({
        send: pipelineSend,
      }),
    });
    await new TelemetryCollector(env).accept(event(), {
      route: "global",
      routingBasis: "explicit_selection",
      analyticsSubjectId: "anonymous-epoch-1",
      subjectUserId: null,
      workspaceAnalyticsId: null,
    });
    const storedRow = database.prepare(
      "SELECT envelope_json FROM telemetry_accepted_events WHERE event_id = ?",
    ).get(eventId) as { envelope_json: string };
    const stored = JSON.parse(storedRow.envelope_json) as TelemetryEnvelope;
    stored.properties = { selectedRegion: "eu", entrypoint: "first_run" };
    database.prepare(
      "UPDATE telemetry_accepted_events SET envelope_json = ? WHERE event_id = ?",
    ).run(canonicalTelemetryJson(stored), eventId);

    const ack = vi.fn();
    const retry = vi.fn();
    await consumeAnalyticsLakehouseQueue({
      queue: "avalon-global-analytics-events-lakehouse",
      messages: [{ id: "tampered", timestamp: new Date(), body: pointers[0], attempts: 1, ack, retry }],
      metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    }, env);
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(pipelineSend).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT analytics_lakehouse_state FROM telemetry_accepted_events WHERE event_id = ?",
    ).get(eventId)).toEqual({ analytics_lakehouse_state: "rejected" });
    database.close();
  });

  it("terminalizes an accepted envelope that the live registry no longer accepts", async () => {
    const database = migratedSqliteDatabase();
    const original = event();
    const retiredEnvelope = { ...original, name: "retired_event_name" };
    const payloadHash = await telemetryPayloadHash(retiredEnvelope, {
      route: "global",
      analyticsSubjectId: "anonymous-epoch-1",
      subjectUserId: null,
      workspaceAnalyticsId: null,
    });
    database.prepare(`INSERT INTO telemetry_accepted_events
      (event_id, payload_hash, envelope_json, route, routing_basis, analytics_subject_id,
       workspace_analytics_id, subject_user_id, accepted_at, normalized_timestamp,
       delete_at, delivery_state, terminal_code)
      VALUES (?, ?, ?, 'global', 'explicit_selection', 'anonymous-epoch-1', NULL, NULL,
              '2026-08-24T19:00:02.000Z', '2026-08-24T19:00:00.000Z',
              '2026-11-22T19:00:02.000Z', 'pending', NULL)`)
      .run(eventId, payloadHash, canonicalTelemetryJson(retiredEnvelope));
    const pipelineSend = vi.fn();
    const ack = vi.fn();
    const retry = vi.fn();
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      LOG_LEVEL: "error",
      ANALYTICS_LAKEHOUSE: createCloudflareTestBinding<NonNullable<Env["ANALYTICS_LAKEHOUSE"]>>({
        send: pipelineSend,
      }),
    });
    await consumeAnalyticsLakehouseQueue({
      queue: "avalon-global-analytics-events-lakehouse",
      messages: [{
        id: "retired",
        timestamp: new Date(),
        body: analyticsLakehousePointer(eventId, payloadHash),
        attempts: 1,
        ack,
        retry,
      }],
      metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    }, env);
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(pipelineSend).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT analytics_lakehouse_state FROM telemetry_accepted_events WHERE event_id = ?",
    ).get(eventId)).toEqual({ analytics_lakehouse_state: "rejected" });
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
