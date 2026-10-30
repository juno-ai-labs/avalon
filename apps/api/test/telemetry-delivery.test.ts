import "../../../tests/isolated-region";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { asUserId } from "@rally/contracts";
import type { HonoAppEnv } from "../src/env";
import { authenticatedTelemetryRoutes } from "../src/routes/telemetry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelemetryCollector } from "../src/telemetry/collector";
import { processTelemetryOutbox } from "../src/telemetry/delivery";
import { recordDestinationOutcome } from "../src/telemetry/operations";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, migratedObservabilityFixture, sqliteD1 } from "./helpers/sqlite-d1";

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
  database: ReturnType<typeof migratedObservabilityFixture>,
  delivery: ReturnType<typeof exceptionEnvelope>,
  deleteAt = "2026-11-10T20:00:00.000Z",
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
    deleteAt,
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

  it("holds events when an identity transition commits during candidate selection", async () => {
    const database = migratedObservabilityFixture();
    database.prepare(`INSERT INTO users (id, google_subject, email, name, created_at, updated_at,
      product_analytics_enabled) VALUES ('018f22f2-4c22-7abc-8def-0123456789ad', 'google-1', 'person@example.com', 'Person', ?, ?, 1)`).run(now, now);
    const db = sqliteD1(database);
    const deliverTelemetryBatch = vi.fn(async () => ({ postHog: { result: "delivered" as const, requestId: "test", retryAfterMs: null } }));
    const env = createTestEnv({ DB: db, AVALON_REGION: "global", POSTHOG_HOST: "https://us.i.posthog.com", POSTHOG_PROJECT_TOKEN: "phc_test", TELEMETRY_DELIVERY: { deliverTelemetryBatch } });
    await new TelemetryCollector(env).accept(envelope("018f22f2-4c22-7abc-8def-0123456789ab"), {
      route: "global", routingBasis: "explicit_binding", analyticsSubjectId: "person-1",
      subjectUserId: "018f22f2-4c22-7abc-8def-0123456789ad", workspaceAnalyticsId: null,
    });
    const prepare = db.prepare.bind(db);
    const intercepted = vi.spyOn(db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.includes("SELECT e.event_id")) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation(async () => {
          const result = await all();
          database.prepare(`INSERT INTO telemetry_profile_jobs
            (id, subject_user_id, job_kind, destination_analytics_id, anonymous_epoch_id,
             properties_json, version, state, created_at, delete_at)
            VALUES ('transition-1', '018f22f2-4c22-7abc-8def-0123456789ad', 'epoch_transition', 'person-1', 'epoch-1', '{}',
                    1, 'pending', ?, '2026-11-10T20:00:00.000Z')`).run(now);
          return result;
        });
      }
      return statement;
    });
    await expect(processTelemetryOutbox(env)).resolves.toMatchObject({ selected: 0, delivered: 0 });
    expect(deliverTelemetryBatch).not.toHaveBeenCalled();
    expect(database.prepare("SELECT delivery_state FROM telemetry_accepted_events").get()).toEqual({ delivery_state: "pending" });
    intercepted.mockRestore();
    database.close();
  });

  it.each([false, true])("uses the inclusive cutoff and skips a stale opt-out purge (reenabled: %s)", async (reenabled) => {
    const database = migratedObservabilityFixture();
    database.prepare(`INSERT INTO users (id, google_subject, email, name, created_at, updated_at,
      product_analytics_enabled, product_analytics_preference_version)
      VALUES ('018f22f2-4c22-7abc-8def-0123456789ad', 'google-1', 'person@example.com', 'Person', ?, ?, 1, 1)`).run(now, now);
    const env = createTestEnv({ DB: sqliteD1(database), AVALON_REGION: "global" });
    for (const [index, eventId] of ["018f22f2-4c22-7abc-8def-0123456789ab", "018f22f2-4c22-7abc-8def-0123456789ac"].entries()) {
      vi.setSystemTime(new Date(Date.parse(now) + index));
      await new TelemetryCollector(env).accept(envelope(eventId), {
        route: "global", routingBasis: "explicit_binding", analyticsSubjectId: "person-1",
        subjectUserId: "018f22f2-4c22-7abc-8def-0123456789ad", workspaceAnalyticsId: null,
      });
    }
    const prepare = env.DB.prepare.bind(env.DB);
    const preferenceRead = vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      if (reenabled && sql === "SELECT product_analytics_enabled, product_analytics_preference_version FROM users WHERE id = ?") {
        database.prepare("UPDATE users SET product_analytics_enabled = 1, product_analytics_preference_version = 3").run();
      }
      return prepare(sql);
    });
    const app = new Hono<HonoAppEnv>();
    app.use("*", async (c, next) => {
      c.set("requestReceivedAt", Date.parse(now));
      c.set("auth", { userId: asUserId("018f22f2-4c22-7abc-8def-0123456789ad"), workspaceId: null, sessionId: "session-1", region: "global", role: null });
      await next();
    });
    app.route("/telemetry", authenticatedTelemetryRoutes);
    const response = await app.request("/telemetry/preference", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false, expectedVersion: 1 }),
    }, env);
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(database.prepare("SELECT event_id FROM telemetry_accepted_events ORDER BY event_id").all()).toEqual([
      ...(reenabled ? [{ event_id: "018f22f2-4c22-7abc-8def-0123456789ab" }] : []),
      { event_id: "018f22f2-4c22-7abc-8def-0123456789ac" },
    ]));
    preferenceRead.mockRestore();
    database.close();
  });

  it("batches pending rows and records successful acknowledgement", async () => {
    const identity = migratedSqliteDatabase();
    const database = new DatabaseSync(":memory:");
    database.exec(readFileSync(new URL("../../../packages/db/telemetry-migrations/0001_initial.sql", import.meta.url), "utf8"));
    const deliverTelemetryBatch = vi.fn(async () => ({
      postHog: {
        result: "delivered" as const,
        requestId: "posthog-request-1",
        retryAfterMs: null,
      },
    }));
    const env = createTestEnv({
      DB: sqliteD1(identity),
      TELEMETRY_DB: sqliteD1(database),
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

    insertAcceptedException(database, exceptionEnvelope("018f22f2-4c22-7abc-8def-0123456789af"), now);
    identity.prepare(`INSERT INTO telemetry_ingest_rate_buckets
      (surface, subject_hash, bucket_start, count, delete_at)
      VALUES ('telemetry_bootstrap', ?, ?, 1, ?)`).run("a".repeat(43), now, now);
    await expect(processTelemetryOutbox(env)).resolves.toEqual({
      selected: 1,
      delivered: 1,
      retried: 0,
      terminal: 0,
      suppressed: 0,
      expired: 2,
      unparseable: 0,
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
    expect(identity.prepare("SELECT name FROM sqlite_schema WHERE name = 'telemetry_accepted_events'").get()).toBeUndefined();
    expect(database.prepare("SELECT event_id FROM telemetry_accepted_events WHERE event_id = ?").get("018f22f2-4c22-7abc-8def-0123456789af")).toBeUndefined();
    expect(identity.prepare("SELECT * FROM telemetry_ingest_rate_buckets").all()).toEqual([]);
    identity.close();
    database.close();
  });

  it("delegates JavaScript exceptions to the exception RPC method", async () => {
    const database = migratedObservabilityFixture();
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
    const database = migratedObservabilityFixture();
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

  it.each([
    // Accepted by a newer contract that widened the enum, then the API rolled back.
    ["schema-skewed", (skewed: ReturnType<typeof envelope>) => JSON.stringify({
      ...skewed,
      properties: { ...skewed.properties, entrypoint: "moon" },
    }), expect.stringMatching(/^stored_envelope_invalid:properties\.entrypoint:invalid_value$/u)],
    ["malformed", () => "{not json", "stored_envelope_invalid"],
  ] as const)("parks a %s row and still delivers the rows behind it", async (_, storedJson, terminalCode) => {
    const database = migratedObservabilityFixture();
    const deliverTelemetryBatch = vi.fn(async () => ({
      postHog: { result: "delivered" as const, requestId: "posthog-request-3", retryAfterMs: null },
    }));
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      POSTHOG_HOST: "https://us.i.posthog.com",
      POSTHOG_PROJECT_TOKEN: "phc_test",
      TELEMETRY_DELIVERY: { deliverTelemetryBatch },
    });
    const skewed = envelope("018f22f2-4c22-7abc-8def-0123456789aa");
    database.prepare(`
      INSERT INTO telemetry_accepted_events (
        event_id, payload_hash, envelope_json, route, routing_basis,
        analytics_subject_id, workspace_analytics_id, subject_user_id,
        accepted_at, normalized_timestamp, delete_at, delivery_state
      ) VALUES (?, 'payload-hash', ?, 'global', 'explicit_binding', 'subject-1', NULL, NULL,
                '2026-08-12T19:59:00.000Z', ?, '2026-11-10T20:00:00.000Z', 'pending')
    `).run(
      skewed.eventId,
      storedJson(skewed),
      now,
    );
    const validId = "018f22f2-4c22-7abc-8def-0123456789ab";
    await new TelemetryCollector(env).accept(envelope(validId), {
      route: "global",
      routingBasis: "geolocation_fallback",
      analyticsSubjectId: "018f22f2-4c22-7abc-8def-0123456789ad",
      subjectUserId: null,
      workspaceAnalyticsId: null,
    });

    await expect(processTelemetryOutbox(env)).resolves.toMatchObject({
      selected: 1,
      delivered: 1,
      unparseable: 1,
    });
    expect(deliverTelemetryBatch).toHaveBeenCalledWith(expect.objectContaining({
      rows: [expect.objectContaining({ eventId: validId })],
    }));
    expect(database.prepare(`
      SELECT event_id, delivery_state, attempt_count, next_attempt_at, terminal_code
      FROM telemetry_accepted_events ORDER BY event_id
    `).all()).toEqual([
      {
        event_id: skewed.eventId,
        delivery_state: "retrying",
        attempt_count: 1,
        next_attempt_at: "2026-08-12T20:01:00.000Z",
        terminal_code: terminalCode,
      },
      {
        event_id: validId,
        delivery_state: "delivered",
        attempt_count: 1,
        next_attempt_at: null,
        terminal_code: null,
      },
    ]);
    database.close();
  });

  it("translates telemetry RPC transport rejection into durable retry", async () => {
    const database = migratedObservabilityFixture();
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
    const database = migratedObservabilityFixture();
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

  it("drains the outbox page after page within one pass", async () => {
    const database = migratedObservabilityFixture();
    const deliverTelemetryBatch = vi.fn(async () => ({
      postHog: { result: "delivered" as const, requestId: null, retryAfterMs: null },
    }));
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      POSTHOG_HOST: "https://us.i.posthog.com",
      POSTHOG_PROJECT_TOKEN: "phc_test",
      TELEMETRY_DELIVERY: { deliverTelemetryBatch },
    });
    for (const eventId of [
      "018f22f2-4c22-7abc-8def-0123456789ab",
      "018f22f2-4c22-7abc-8def-0123456789ac",
      "018f22f2-4c22-7abc-8def-0123456789ae",
    ]) {
      await new TelemetryCollector(env).accept(envelope(eventId), {
        route: "global",
        routingBasis: "geolocation_fallback",
        analyticsSubjectId: "018f22f2-4c22-7abc-8def-0123456789ad",
        subjectUserId: null,
        workspaceAnalyticsId: null,
      });
    }

    await expect(processTelemetryOutbox(env, { pageSize: 2 })).resolves.toMatchObject({
      selected: 3,
      delivered: 3,
      retried: 0,
    });
    expect(deliverTelemetryBatch).toHaveBeenCalledTimes(2);
    expect(database.prepare(
      "SELECT COUNT(*) AS delivered FROM telemetry_accepted_events WHERE delivery_state = 'delivered'",
    ).get()).toEqual({ delivered: 3 });
    database.close();
  });

  it("ends the pass before a page that would cross the pass budget", async () => {
    const database = migratedObservabilityFixture();
    const deliverTelemetryBatch = vi.fn(async () => {
      vi.setSystemTime(new Date(Date.now() + 2_000));
      return { postHog: { result: "delivered" as const, requestId: null, retryAfterMs: null } };
    });
    const env = createTestEnv({
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      POSTHOG_HOST: "https://us.i.posthog.com",
      POSTHOG_PROJECT_TOKEN: "phc_test",
      TELEMETRY_DELIVERY: { deliverTelemetryBatch },
    });
    for (const eventId of [
      "018f22f2-4c22-7abc-8def-0123456789ab",
      "018f22f2-4c22-7abc-8def-0123456789ac",
      "018f22f2-4c22-7abc-8def-0123456789ae",
    ]) {
      await new TelemetryCollector(env).accept(envelope(eventId), {
        route: "global",
        routingBasis: "geolocation_fallback",
        analyticsSubjectId: "018f22f2-4c22-7abc-8def-0123456789ad",
        subjectUserId: null,
        workspaceAnalyticsId: null,
      });
    }

    // Each page takes two seconds; a third second would not fit a second page.
    await expect(processTelemetryOutbox(env, { pageSize: 1, passBudgetMs: 3_000 })).resolves.toMatchObject({
      selected: 1,
      delivered: 1,
    });
    expect(deliverTelemetryBatch).toHaveBeenCalledTimes(1);
    expect(database.prepare(
      "SELECT COUNT(*) AS pending FROM telemetry_accepted_events WHERE delivery_state = 'pending'",
    ).get()).toEqual({ pending: 2 });
    database.close();
  });

  it("leaves accepted rows untouched while the destination circuit is open", async () => {
    const database = migratedObservabilityFixture();
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
