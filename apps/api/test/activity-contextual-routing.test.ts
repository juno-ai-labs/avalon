import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { asWorkspaceId } from "@rally/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

// Hoisted rather than declared beside the mock: `vi.mock` is lifted above every
// `const` in the file, so a factory closing over an ordinary binding reads it
// before initialization.
const { runStructuredInference } = vi.hoisted(() => ({ runStructuredInference: vi.fn() }));
vi.mock("../src/services/structured-inference", () => ({ runStructuredInference }));

import type { Env } from "../src/env";
import {
  WorkspaceConnectorEventProcessQueueMessageSchema,
  type WorkspaceConnectorEvent,
} from "../src/durable-objects/workspace-connector-event-protocol";
import { __testing, consumeActivityQueue } from "../src/queues/activity-consumer";
import {
  workspaceConnectorEventProcessQueueMessage,
  workspaceConnectorEventQueueMessage,
} from "../src/services/workspace-connector-event-ingress";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createCloudflareTestBinding, createTestDurableObjectId, createTestEnv } from "./helpers/cloudflare-test";
import { uuidV7 } from "../src/lib/uuid-v7";

const { routeContextually } = __testing;

const WORKSPACE = "00000000-0000-7000-8000-000000000001";
const MEMBER = "00000000-0000-7000-8000-000000000002";
const COLLEAGUE = "00000000-0000-7000-8000-000000000004";
const CONNECTION = "00000000-0000-7000-8000-000000000003";
const STREAM_A = "00000000-0000-7000-8000-00000000000a";
const STREAM_B = "00000000-0000-7000-8000-00000000000b";
const STREAM_HISTORY = "00000000-0000-7000-8000-00000000000c";

const NEWS = "github.pull_request.review_requested";
const MACHINERY = "github.check_run.completed";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  runStructuredInference.mockReset();
});

/**
 * Relative to the real clock, not a fixed instant: the windows under test are
 * measured from `new Date()` inside the feedback reads, so a pinned base date
 * would drift past them and turn every recent resolution into an expired one.
 */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
}

/** A namespace that accepts every room event, so the insert path is the test. */
/**
 * The work-stream agent, recording the cards admission decides to offer.
 *
 * `createActivitySuggestion` wrote them straight into D1 when the authority was
 * closed; that arm is deleted, so it now goes to the object. The stub keeps the
 * insert-once semantics the assertions depend on — a repeated `id` is not
 * inserted twice — and hands the row back in the shape the caller parses.
 */
function roomNamespace(created: Map<string, Record<string, unknown>>): DurableObjectNamespace {
  const namespace = {
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: () => ({
      publishEvent: async () => ({ status: 200, bodyJson: "null" }),
      createRuntimeSuggestion: async (request: {
        input: {
          id: string; activityId: string; title: string; summary: string;
          confidence: number; reason: string;
        };
        workstreamId: string;
      }) => {
        const inserted = !created.has(request.input.id);
        const suggestion = {
          id: request.input.id,
          activityId: request.input.activityId,
          workstreamId: request.workstreamId,
          title: request.input.title,
          summary: request.input.summary,
          confidence: request.input.confidence,
          reason: request.input.reason,
          status: "pending",
          createdAt: "2026-08-12T00:00:00.000Z",
          resolvedAt: null,
        };
        if (inserted) created.set(request.input.id, suggestion);
        return {
          status: 200,
          bodyJson: JSON.stringify({ suggestion: created.get(request.input.id), inserted }),
        };
      },
    }),
    jurisdiction: () => namespace,
  };
  return createCloudflareTestBinding<DurableObjectNamespace>(namespace);
}

/**
 * The workspace object, answering from this test's own fixture.
 *
 * `suggestionAdmission` used to read resolved suggestions out of D1 directly;
 * that arm only ran when the authority was closed and is deleted. It asks the
 * object now, so the stub answers the same question over the same seeded rows.
 * These tests are about what admission *decides* from that feedback — the bars,
 * the floors, the windows, whose cards count — and every one of those
 * assertions is unchanged. What WorkspaceDO's own query does with its own
 * tables is its business, and belongs on real workerd.
 */
function workspaceNamespace(database: DatabaseSync): Env["WORKSPACE_DOS"] {
  const hashes = new Map<string, string>();
  const connectorEvents = new Map<string, {
    event: WorkspaceConnectorEvent;
    status: "pending" | "processing" | "processed" | "failed";
    leaseId: string | null;
    attempt: number;
  }>();
  const namespace = {
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: () => ({
      suggestionFeedback: async (input: {
        source: string; since: string; provider: string; eventType: string;
      }) => ({
        items: database.prepare(
          `SELECT s.workstream_id, s.activity_id, s.status, s.resolved_at,
                  s.resolved_by_user_id
             FROM activity_suggestions s
             JOIN activities a ON a.id = s.activity_id
            WHERE s.source = ? AND s.status IN ('accepted', 'dismissed')
              AND s.resolved_at >= ? AND a.provider = ? AND a.event_type = ?
            ORDER BY s.resolved_at, s.workstream_id, s.id`,
        ).all(input.source, input.since, input.provider, input.eventType)
          .map((row) => {
            const item = row as Record<string, unknown>;
            return {
              workstreamId: String(item.workstream_id),
              activityId: String(item.activity_id),
              status: String(item.status) as "accepted" | "dismissed",
              resolvedAt: String(item.resolved_at),
              resolvedByUserId: item.resolved_by_user_id == null
                ? null
                : String(item.resolved_by_user_id),
            };
          }),
      }),
      /**
       * Eligibility and ordering only.
       *
       * The object's own query also applies the dismissal run, the
       * producer scoping and the already-routed exclusion — deliberately not
       * reproduced here, because a stub that reproduced them would let a test
       * of those rules pass while asserting nothing but this function. They are
       * asserted against a real WorkspaceDO in
       * `test-workers/durable-object-runtime.test.ts`.
       */
      routingCandidates: async (input: { limit: number }) => ({
        items: database.prepare(
          `SELECT w.id, w.title, w.objective, w.last_activity_at
             FROM workstreams w
            WHERE w.archived_at IS NULL
              AND w.harness_status IN ('idle', 'running', 'needs_input', 'scheduled')
            ORDER BY w.last_activity_at DESC, w.id
            LIMIT ?`,
        ).all(input.limit).map((row) => {
          const item = row as Record<string, unknown>;
          return {
            workstreamId: String(item.id),
            title: String(item.title),
            description: String(item.objective ?? ""),
            lastActivityAt: String(item.last_activity_at),
          };
        }),
      }),
      ingestConnectorEvent: async (input: {
        ingressEventId: string;
        payloadHash: string;
        event: WorkspaceConnectorEvent;
      }) => {
        const prior = hashes.get(input.ingressEventId);
        if (prior && prior !== input.payloadHash) throw new Error("connector_event_ingress_idempotency_conflict");
        hashes.set(input.ingressEventId, input.payloadHash);
        if (!connectorEvents.has(input.ingressEventId)) {
          connectorEvents.set(input.ingressEventId, {
            event: input.event,
            status: "pending",
            leaseId: null,
            attempt: -1,
          });
        }
        const stored = connectorEvents.get(input.ingressEventId)!;
        return {
          eventId: input.ingressEventId,
          duplicate: Boolean(prior),
          processingStatus: stored.status,
          processingAttempt: stored.attempt,
        };
      },
      connectorEvent: async (input: { eventId: string }) =>
        connectorEvents.get(input.eventId)?.event ?? null,
      claimConnectorEvent: async (input: {
        eventId: string;
        processingOwnerId: string;
        attempt: number;
        orchestrator?: "queue" | "workflow";
      }) => {
        const stored = connectorEvents.get(input.eventId);
        if (!stored) throw new Error("connector_event_not_found");
        if (stored.status === "processed") return { outcome: "processed" as const };
        if (stored.status === "processing") {
          return {
            outcome: "busy" as const,
            reason: "active_lease_not_expired" as const,
            retryAt: Date.now() + 15 * 60_000,
          };
        }
        if (stored.status === "failed" && input.attempt < stored.attempt) {
          return {
            outcome: "busy" as const,
            reason: "failed_attempt_not_advanced" as const,
            retryAt: null,
          };
        }
        const processingLeaseId = input.orchestrator === "workflow"
          ? input.processingOwnerId
          : uuidV7();
        const processingLeaseExpiresAt = Date.now() + 15 * 60_000;
        stored.status = "processing";
        stored.leaseId = processingLeaseId;
        stored.attempt = input.attempt;
        return {
          outcome: "claimed" as const,
          event: stored.event,
          processingLeaseId,
          processingLeaseExpiresAt,
        };
      },
      settleConnectorEvent: async (input: {
        eventId: string;
        processingOwnerId: string;
        processingLeaseId?: string;
        outcome: "processed" | "failed";
      }) => {
        const stored = connectorEvents.get(input.eventId);
        const processingLeaseId = input.processingLeaseId ?? input.processingOwnerId;
        if (!stored || stored.status !== "processing" || stored.leaseId !== processingLeaseId) {
          throw new Error("connector_event_settlement_fenced");
        }
        stored.status = input.outcome;
      },
      enqueueOpportunitySource: async () => undefined,
      recordActivityEvent: async () => "00000000-0000-7000-8000-0000000000ee",
      executeRuntimeSql: async (input: {
        statements: Array<{ sql: string; params: Array<string | number | null> }>;
      }) => ({
        status: 200,
        bodyJson: JSON.stringify({
          results: input.statements.map((statement) => {
            const rows = database.prepare(statement.sql).all(
              ...statement.params as SQLInputValue[],
            ) as Array<Record<string, string | number | null>>;
            return {
              columns: rows[0] ? Object.keys(rows[0]) : [],
              rows,
              changes: 0,
            };
          }),
        }),
      }),
    }),
    jurisdiction: () => namespace,
  };
  return createCloudflareTestBinding<Env["WORKSPACE_DOS"]>(namespace);
}

/**
 * The GitHub credentials are what put GitHub in this env's connector registry,
 * and the registry is what answers whether an event type is digestible. Without
 * them every activity here would be withheld for the uninteresting reason that
 * the connector is unregistered in this region — which is itself asserted once,
 * deliberately, below.
 */
/** Cards the object accepted this test, keyed by id so a replay stays one card. */
const createdSuggestions = new Map<string, Record<string, unknown>>();

function envFor(database: DatabaseSync, overrides: Partial<Record<string, unknown>> = {}): Env {
  createdSuggestions.clear();
  return createTestEnv({
    DB: sqliteD1(database),
    SUBSTREAM_AGENTS: roomNamespace(createdSuggestions),
    WORKSPACE_DOS: workspaceNamespace(database),
    ACTIVITY_QUEUE: { send: vi.fn().mockResolvedValue({}) },
    CONNECTOR_EVENT_WORKFLOW: { create: vi.fn().mockResolvedValue({}) },
    AVALON_REGION: "global",
    APP_ENV: "test",
    LOG_LEVEL: "error",
    PUBLIC_API_BASE_URL: "https://api.example.com",
    OPENROUTER_API_KEY: "test-key",
    GITHUB_APP_ID: "1",
    GITHUB_APP_CLIENT_ID: "client",
    GITHUB_APP_CLIENT_SECRET: "secret",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nunused-test-key\n-----END PRIVATE KEY-----",
    GITHUB_WEBHOOK_SECRET: "webhook",
    ...overrides,
  });
}

function seededDatabase(): DatabaseSync {
  const database = preRetirementProductSqliteDatabase();
  databases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${MEMBER}', 'g-a', 'a@example.com', 'A', '2026-01-01', '2026-01-01'),
           ('${COLLEAGUE}', 'g-b', 'b@example.com', 'B', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE}', 'Avalon Studio', 'avalon-studio', 'global', '${MEMBER}', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${WORKSPACE}', '${MEMBER}', 'owner', 'active', '2026-01-01'),
           ('${WORKSPACE}', '${COLLEAGUE}', 'member', 'active', '2026-01-01');
    INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, owner_user_id, display_name,
       granted_scopes_json, model_plugin_id, status, created_at, updated_at)
    VALUES ('${CONNECTION}', '${WORKSPACE}', 'github', 'workspace', NULL, 'GitHub',
            '[]', 'plugin_github', 'healthy', '2026-01-01', '2026-01-01');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, last_activity_at, created_at, updated_at)
    VALUES
      ('${STREAM_A}', '${WORKSPACE}', 'Sidebar UX', 'Make the sidebar legible', 'ad_hoc', '${MEMBER}',
       'idle', '2026-08-11T11:00:00.000Z', '2026-01-01', '2026-01-01'),
      ('${STREAM_B}', '${WORKSPACE}', 'Billing', 'Move billing to the new plan', 'ad_hoc', '${MEMBER}',
       'idle', '2026-08-11T10:00:00.000Z', '2026-01-01', '2026-01-01'),
      ('${STREAM_HISTORY}', '${WORKSPACE}', 'Archive', 'Somewhere past decisions live', 'ad_hoc', '${MEMBER}',
       'idle', '2026-08-01T10:00:00.000Z', '2026-01-01', '2026-01-01');
  `);
  return database;
}

/** Writes the activity row the suggestion's foreign key needs, and returns the join shape. */
function insertActivity(
  database: DatabaseSync,
  input: { id: string; eventType: string; title?: string },
): Parameters<typeof routeContextually>[1] {
  database.prepare(
    `INSERT INTO activities
       (id, workspace_id, connection_id, connection_scope, connection_owner_user_id, provider,
        provider_event_id, event_type, resource_type, provider_resource_id, occurred_at, received_at,
        title, summary, text_snippet, dedupe_key, processing_status)
     VALUES (?, ?, ?, 'workspace', NULL, 'github', ?, ?, 'github_pull_request', 'juno-ai-labs/avalon#7',
             '2026-08-11T11:30:00.000Z', '2026-08-11T11:30:01.000Z', ?, 'A summary', 'A snippet', ?, 'processing')`,
  ).run(
    input.id,
    WORKSPACE,
    CONNECTION,
    `ev-${input.id}`,
    input.eventType,
    input.title ?? "juno-ai-labs/avalon: review requested",
    `dedupe-${input.id}`,
  );
  return {
    id: input.id,
    workspace_id: WORKSPACE,
    workspace_region: "global",
    connection_id: CONNECTION,
    connector_type: "github",
    connection_scope: "workspace",
    connection_owner_user_id: null,
    provider: "github",
    provider_event_id: `ev-${input.id}`,
    event_type: input.eventType,
    resource_type: "github_pull_request",
    provider_resource_id: "juno-ai-labs/avalon#7",
    payload_ref: null,
    actor_json: "{}",
    subject_json: "{}",
    occurred_at: "2026-08-11T11:30:00.000Z",
    received_at: "2026-08-11T11:30:01.000Z",
    title: input.title ?? "juno-ai-labs/avalon: review requested",
    summary: "A summary",
    text_snippet: "A snippet",
    visibility_json: "{}",
    target_user_ids_json: "[]",
    entity_keys_json: "[]",
    dedupe_key: `dedupe-${input.id}`,
    raw_content_hash: null,
    metadata_json: "{}",
    external_people_json: "[]",
    processing_status: "processing",
  } as Parameters<typeof routeContextually>[1];
}

/** A resolution somebody already made, as the feedback reads it back. */
function recordResolution(
  database: DatabaseSync,
  input: {
    suffix: string;
    workstreamId: string;
    eventType: string;
    status: "accepted" | "dismissed";
    resolvedAt: string;
    /** Who clicked. Defaults to one person, which is what leaves a type unsuppressed. */
    resolvedBy?: string;
    /** Which producer's card it was. Defaults to this module's own. */
    source?: "contextual_routing" | "suggested_work" | "unknown";
  },
): void {
  const activityId = `00000000-0000-7000-8000-0000000f${input.suffix.padStart(4, "0")}`;
  insertActivity(database, { id: activityId, eventType: input.eventType });
  database.prepare(
    `INSERT INTO activity_suggestions
       (id, workspace_id, activity_id, workstream_id, confidence, reason, status, created_at, resolved_at, resolved_by_user_id, source)
     VALUES (?, ?, ?, ?, 0.9, 'A past match', ?, ?, ?, ?, ?)`,
  ).run(
    `00000000-0000-7000-8000-0000005${input.suffix.padStart(5, "0")}`,
    WORKSPACE,
    activityId,
    input.workstreamId,
    input.status,
    input.resolvedAt,
    input.resolvedAt,
    input.resolvedBy ?? MEMBER,
    input.source ?? "contextual_routing",
  );
}

function modelAnswers(input: { workstreamId?: string; confidence: number; suggest?: boolean }): void {
  runStructuredInference.mockResolvedValue({
    model: "test-model",
    result: {
      candidateWorkstreamId: input.workstreamId ?? STREAM_A,
      confidence: input.confidence,
      reason: "The pull request is the work this stream is doing",
      matchedEntities: ["juno-ai-labs/avalon#7"],
      suggest: input.suggest ?? true,
    },
  });
}

/**
 * Cards this run offered.
 *
 * Read from what the object accepted rather than from D1: admission writes
 * through the work-stream object now, and the `activity_suggestions` rows these
 * tests still seed are *resolved* feedback, which is a different thing that
 * happens to share a table name in the fixture.
 */
function suggestionCount(): number {
  return createdSuggestions.size;
}

describe("connector event Queue boundary", () => {
  it("admits a post-cutover Queue event without a D1 activity-body handoff", async () => {
    const database = seededDatabase();
    const env = envFor(database, { LOG_LEVEL: "info" });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const activityId = "00000000-0000-7000-8000-0000000000e1";
    const ack = vi.fn();
    const retry = vi.fn();
    const body = await workspaceConnectorEventQueueMessage({
      connectorType: "github",
      // A legacy Workflow can redrive at the old ceiling. Native Queue retries
      // must still reacquire there rather than saturating their own generation.
      attempt: 5,
      activity: {
        id: activityId,
        workspaceId: WORKSPACE,
        region: "global",
        connectionId: CONNECTION,
        connectionScope: "workspace",
        connectionOwnerUserId: null,
        provider: "github",
        providerEventId: "delivery-post-cutover",
        eventType: NEWS,
        resourceType: "github_pull_request",
        providerResourceId: "juno-ai-labs/avalon#8",
        actor: {},
        subject: {},
        occurredAt: "2026-08-11T11:30:00.000Z",
        receivedAt: "2026-08-11T11:30:01.000Z",
        title: "Review requested",
        summary: "A normalized event travels in Queue",
        textSnippet: "No D1 staging row",
        payloadRef: "global/provider-webhooks/github/body.json",
        visibility: {},
        targetUserIds: [],
        entityKeys: ["github:pr:8"],
        dedupeKey: "github:delivery-post-cutover",
        rawContentHash: "body-hash",
        metadata: {},
        externalPeople: [],
      },
    });
    const message = {
      id: "workspace-connector-event",
      timestamp: new Date("2026-08-11T11:30:02.000Z"),
      body,
      attempts: 1,
      ack,
      retry,
    } satisfies Message<unknown>;

    await consumeActivityQueue({
      messages: [message],
      queue: "activity",
      metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
      retryAll: vi.fn(),
      ackAll: vi.fn(),
    }, env);

    expect(database.prepare("SELECT COUNT(*) AS count FROM activities").get())
      .toEqual({ count: 0 });
    expect(env.ACTIVITY_QUEUE.send).toHaveBeenCalledWith(expect.objectContaining({
      kind: "connector_event_process",
      schemaVersion: 1,
      region: "global",
      workspaceId: WORKSPACE,
      eventId: activityId,
      processingOwnerId: expect.any(String),
      processingAttempt: 5,
    }));
    expect(env.CONNECTOR_EVENT_WORKFLOW.create).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: "connector_event_queue_terminal",
      connector_type: "github",
      connector_event_id: activityId,
      processing_owner_id: expect.any(String),
      processing_outcome: "enqueued",
      outcome: "admitted",
      queue_attempts: 1,
    }));
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();

    const processBody = vi.mocked(env.ACTIVITY_QUEUE.send).mock.calls[0]?.[0];
    expect(processBody).toBeDefined();
    const processPointer = WorkspaceConnectorEventProcessQueueMessageSchema.parse(processBody);
    runStructuredInference
      .mockRejectedValueOnce(new Error("injected_connector_processing_failure"))
      .mockResolvedValueOnce({
        model: "test-model",
        result: {
          candidateWorkstreamId: null,
          confidence: 0,
          reason: "No contextual match",
          matchedEntities: [],
          suggest: false,
        },
      });
    const firstProcessAck = vi.fn();
    const firstProcessRetry = vi.fn();
    await consumeActivityQueue({
      messages: [{
        id: "connector-process-message",
        timestamp: new Date("2026-08-11T11:30:03.000Z"),
        body: processBody,
        attempts: 1,
        ack: firstProcessAck,
        retry: firstProcessRetry,
      }],
      queue: "activity",
      metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
      retryAll: vi.fn(),
      ackAll: vi.fn(),
    }, env);
    expect(firstProcessAck).not.toHaveBeenCalled();
    expect(firstProcessRetry).toHaveBeenCalledWith({ delaySeconds: 5 });

    const staleProcessAck = vi.fn();
    const staleProcessRetry = vi.fn();
    await consumeActivityQueue({
      messages: [{
        id: "stale-connector-process-message",
        timestamp: new Date("2026-08-11T11:30:03.500Z"),
        body: workspaceConnectorEventProcessQueueMessage({
          region: processPointer.region,
          workspaceId: processPointer.workspaceId,
          eventId: processPointer.eventId,
          processingOwnerId: processPointer.processingOwnerId,
          processingAttempt: 4,
        }),
        attempts: 1,
        ack: staleProcessAck,
        retry: staleProcessRetry,
      }],
      queue: "activity",
      metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
      retryAll: vi.fn(),
      ackAll: vi.fn(),
    }, env);
    expect(staleProcessAck).toHaveBeenCalledOnce();
    expect(staleProcessRetry).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: "connector_event_process_terminal",
      connector_event_id: activityId,
      processing_attempt: 4,
      outcome: "skipped",
      reason: "failed_attempt_not_advanced",
    }));

    const secondProcessAck = vi.fn();
    const secondProcessRetry = vi.fn();
    await consumeActivityQueue({
      messages: [{
        id: "connector-process-message",
        timestamp: new Date("2026-08-11T11:30:03.000Z"),
        body: processBody,
        attempts: 2,
        ack: secondProcessAck,
        retry: secondProcessRetry,
      }],
      queue: "activity",
      metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
      retryAll: vi.fn(),
      ackAll: vi.fn(),
    }, env);
    expect(secondProcessAck).toHaveBeenCalledOnce();
    expect(secondProcessRetry).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: "connector_event_process_terminal",
      connector_event_id: activityId,
      outcome: "processed",
      queue_attempts: 2,
    }));
  });

  it("terminally skips a connector process pointer delivered to the wrong region", async () => {
    const database = seededDatabase();
    const env = envFor(database, { LOG_LEVEL: "info" });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const ack = vi.fn();
    const retry = vi.fn();
    const eventId = "00000000-0000-7000-8000-0000000000e2";
    const processingOwnerId = "00000000-0000-7000-8000-0000000000e3";

    await consumeActivityQueue({
      messages: [{
        id: "wrong-region-connector-process",
        timestamp: new Date("2026-08-11T11:30:03.000Z"),
        body: workspaceConnectorEventProcessQueueMessage({
          region: "eu",
          workspaceId: asWorkspaceId(WORKSPACE),
          eventId,
          processingOwnerId,
          processingAttempt: 0,
        }),
        attempts: 1,
        ack,
        retry,
      }],
      queue: "activity",
      metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
      retryAll: vi.fn(),
      ackAll: vi.fn(),
    }, env);

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: "connector_event_process_terminal",
      connector_event_id: eventId,
      processing_owner_id: processingOwnerId,
      outcome: "skipped",
      reason: "region_mismatch",
    }));
  });

  it("acks a legacy activity-queue message without reading the frozen D1 row behind it", async () => {
    const database = seededDatabase();
    const env = envFor(database, { LOG_LEVEL: "info" });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const activityId = "00000000-0000-7000-8000-0000000000f1";
    insertActivity(database, { id: activityId, eventType: NEWS });
    database.prepare("UPDATE activities SET processing_status = 'pending' WHERE id = ?").run(activityId);
    const ack = vi.fn();
    const retry = vi.fn();
    const message = {
      id: "activity-queue-message",
      timestamp: new Date("2026-08-11T11:30:02.000Z"),
      body: { region: "global", workspaceId: WORKSPACE, activityId, attempt: 0 },
      attempts: 1,
      ack,
      retry,
    } satisfies Message<unknown>;
    const batch = {
      messages: [message],
      queue: "activity",
      metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
      retryAll: vi.fn(),
      ackAll: vi.fn(),
    } satisfies MessageBatch<unknown>;

    await consumeActivityQueue(batch, env);

    // Every producer of this message shape returns before sending it once
    // WORKSPACE_DOS is bound, so one can only be in flight from before the
    // cutover. Admitting it would hand WorkspaceDO a second connector-event
    // authority built from a D1 row nothing has written since; leaving it
    // unacked would redeliver it forever. It is acked, and nothing else.
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(env.CONNECTOR_EVENT_WORKFLOW.create).not.toHaveBeenCalled();
    expect(runStructuredInference).not.toHaveBeenCalled();
    expect(suggestionCount()).toBe(0);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: "connector_event_queue_terminal",
      workspace_id: WORKSPACE,
      connector_event_id: activityId,
      outcome: "skipped",
      reason: "legacy_message_after_cutover",
    }));
    expect(database.prepare("SELECT processing_status FROM activities WHERE id = ?").get(activityId))
      .toEqual({ processing_status: "pending" });
  });
});

describe("contextual routing: where the bar starts", () => {
  it("offers a card at the base bar for activity a digest would carry", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    modelAnswers({ confidence: 0.82 });

    await expect(routeContextually(env, insertActivity(database, { id: "00000000-0000-7000-8000-0000000000f1", eventType: NEWS }), new Set()))
      .resolves.toBe(true);
    expect(suggestionCount()).toBe(1);
  });

  it("holds activity its connector calls machinery to a higher bar", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    // A check run finishing is operational in the GitHub manifest, which drew a
    // real news/machinery line — so the bar rises to 0.9, and the confidence
    // that would have carried a review request is no longer enough.
    modelAnswers({ confidence: 0.85 });

    await expect(routeContextually(env, insertActivity(database, { id: "00000000-0000-7000-8000-0000000000f2", eventType: MACHINERY }), new Set()))
      .resolves.toBe(false);
    expect(suggestionCount()).toBe(0);

    runStructuredInference.mockReset();
    modelAnswers({ confidence: 0.95 });
    await expect(routeContextually(env, insertActivity(database, { id: "00000000-0000-7000-8000-0000000000f3", eventType: MACHINERY }), new Set()))
      .resolves.toBe(true);
  });

  it("draws no prior from a connector that classified nothing as news", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    // The generic webhook declares `digestible: []` because Avalon cannot parse
    // what a caller posts — a statement about rendering a digest line, not
    // about relevance to a work stream. Reading it as a "no" would take the
    // connector that PRD flow 4 tests contextual routing with out of contextual
    // routing entirely.
    const webhook = insertActivity(database, {
      id: "00000000-0000-7000-8000-0000000000f4", eventType: "webhook.received",
    });
    modelAnswers({ confidence: 0.82 });

    await expect(routeContextually(env, { ...webhook, connector_type: "generic_webhook", provider: "generic_webhook" }, new Set()))
      .resolves.toBe(true);
    expect(suggestionCount()).toBe(1);
  });

  it("keeps the base bar when the registry cannot answer at all", async () => {
    const database = seededDatabase();
    // No GitHub credentials. A missing answer must not disable contextual
    // routing region-wide the way one malformed credential otherwise could.
    const env = envFor(database, { GITHUB_APP_ID: undefined });
    modelAnswers({ confidence: 0.82 });

    await expect(routeContextually(env, insertActivity(database, { id: "00000000-0000-7000-8000-0000000000f5", eventType: NEWS }), new Set()))
      .resolves.toBe(true);
  });
});

// The "a work stream's run of dismissals" suite is gone with the D1 candidate
// query it covered. The dismissal run, its producer scoping, its window and the
// already-routed exclusion are all subqueries inside WorkspaceDO's
// `routingCandidates` now, so they are asserted against a real object in
// `test-workers/durable-object-runtime.test.ts`. Reproducing them in the stub
// above would have kept these five green while proving only that the stub
// reproduced them.

describe("contextual routing: an event type's record in this workspace", () => {
  it("stops asking about an event type two people have only ever dismissed", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    for (const [index, day] of [1, 2, 3, 4].entries()) {
      recordResolution(database, {
        suffix: `4${index}`, workstreamId: STREAM_HISTORY, eventType: NEWS, status: "dismissed", resolvedAt: daysAgo(day),
        resolvedBy: index < 2 ? MEMBER : COLLEAGUE,
      });
    }
    modelAnswers({ confidence: 0.99 });

    await expect(routeContextually(env, insertActivity(database, { id: "00000000-0000-7000-8000-0000000000f7", eventType: NEWS }), new Set()))
      .resolves.toBe(false);
    // The saving is the point: a type that cannot produce a card must not buy
    // an inference to discover that.
    expect(runStructuredInference).not.toHaveBeenCalled();
  });

  it("lets one person raise the bar but not close the door for everybody", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    // Same four dismissals, all from one person. A card sits in a shared
    // transcript and anybody may clear it, so this is as likely to be somebody
    // tidying up as a judgement the whole workspace shares.
    for (const [index, day] of [1, 2, 3, 4].entries()) {
      recordResolution(database, {
        suffix: `8${index}`, workstreamId: STREAM_HISTORY, eventType: NEWS, status: "dismissed", resolvedAt: daysAgo(day),
      });
    }
    modelAnswers({ confidence: 0.9 });

    await expect(routeContextually(env, insertActivity(database, { id: "00000000-0000-7000-8000-0000000000fc", eventType: NEWS }), new Set()))
      .resolves.toBe(false);
    // Not suppressed — the model was still asked, and the type can still earn
    // the acceptance that would lift the bar again.
    expect(runStructuredInference).toHaveBeenCalledOnce();

    runStructuredInference.mockReset();
    modelAnswers({ confidence: 0.96 });
    await expect(routeContextually(env, insertActivity(database, { id: "00000000-0000-7000-8000-0000000000fd", eventType: NEWS }), new Set()))
      .resolves.toBe(true);
  });

  it("raises the bar for an event type that is usually dismissed", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    for (const [index, day] of [1, 2, 3].entries()) {
      recordResolution(database, {
        suffix: `5${index}`, workstreamId: STREAM_HISTORY, eventType: NEWS, status: "dismissed", resolvedAt: daysAgo(day),
      });
    }
    recordResolution(database, {
      suffix: "59", workstreamId: STREAM_HISTORY, eventType: NEWS, status: "accepted", resolvedAt: daysAgo(4),
    });
    // One in four accepted puts the floor at 0.9125, so the old constant is no
    // longer enough on its own.
    modelAnswers({ confidence: 0.85 });

    await expect(routeContextually(env, insertActivity(database, { id: "00000000-0000-7000-8000-0000000000f8", eventType: NEWS }), new Set()))
      .resolves.toBe(false);
    expect(runStructuredInference).toHaveBeenCalledOnce();
    expect(suggestionCount()).toBe(0);

    runStructuredInference.mockReset();
    modelAnswers({ confidence: 0.95 });
    await expect(routeContextually(env, insertActivity(database, { id: "00000000-0000-7000-8000-0000000000f9", eventType: NEWS }), new Set()))
      .resolves.toBe(true);
    expect(suggestionCount()).toBe(1);
  });

  it("lets a workspace's acceptances lower a bar its connector raised", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    // A check run is machinery in the GitHub manifest, so it starts at 0.9.
    // This workspace has accepted four of them, which is the only evidence that
    // exists about whether they are useful *here* — and it beats the
    // declaration rather than being capped by it. Without this case a
    // regression clamping the computed floor to the declared one passes
    // everything else in this file.
    for (const [index, day] of [1, 2, 3, 4].entries()) {
      recordResolution(database, {
        suffix: `9${index}`, workstreamId: STREAM_HISTORY, eventType: MACHINERY, status: "accepted", resolvedAt: daysAgo(day),
      });
    }
    modelAnswers({ confidence: 0.85 });

    await expect(routeContextually(env, insertActivity(database, { id: "00000000-0000-7000-8000-0000000000ff", eventType: MACHINERY }), new Set()))
      .resolves.toBe(true);
    expect(suggestionCount()).toBe(1);
  });

  it("keeps the base floor while the sample is too small to mean anything", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    recordResolution(database, {
      suffix: "60", workstreamId: STREAM_HISTORY, eventType: NEWS, status: "dismissed", resolvedAt: daysAgo(1),
    });
    modelAnswers({ confidence: 0.82 });

    // One dismissal out of one is a 0% accept rate that means nothing, and
    // suppressing on it would remove the only way the type can earn a record.
    await expect(routeContextually(env, insertActivity(database, { id: "00000000-0000-7000-8000-0000000000fa", eventType: NEWS }), new Set()))
      .resolves.toBe(true);
    expect(suggestionCount()).toBe(1);
  });

  it("ignores another producer's cards when scoring an event type", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    // The suggested-work path publishes the same card through the same helper
    // and it is resolved by the same endpoint. Four dismissals of *its* cards,
    // by two people, would suppress this type if the score counted them — but
    // they are evidence about a deliberate whole-window decision, not about
    // this module's per-event guess.
    for (const [index, day] of [1, 2, 3, 4].entries()) {
      recordResolution(database, {
        suffix: `a${index}`, workstreamId: STREAM_HISTORY, eventType: NEWS, status: "dismissed", resolvedAt: daysAgo(day),
        resolvedBy: index < 2 ? MEMBER : COLLEAGUE,
        source: "suggested_work",
      });
    }
    modelAnswers({ confidence: 0.82 });

    await expect(routeContextually(env, insertActivity(database, { id: "00000000-0000-7000-8000-000000000101", eventType: NEWS }), new Set()))
      .resolves.toBe(true);
    expect(runStructuredInference).toHaveBeenCalledOnce();
    expect(suggestionCount()).toBe(1);
  });

  it("ignores resolutions written before the producer was recorded", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    // Rows predating the `source` column cannot be attributed to either
    // producer, so they count for neither rather than being guessed into this
    // module's evidence.
    for (const [index, day] of [1, 2, 3, 4].entries()) {
      recordResolution(database, {
        suffix: `b${index}`, workstreamId: STREAM_HISTORY, eventType: NEWS, status: "dismissed", resolvedAt: daysAgo(day),
        resolvedBy: index < 2 ? MEMBER : COLLEAGUE,
        source: "unknown",
      });
    }
    modelAnswers({ confidence: 0.82 });

    await expect(routeContextually(env, insertActivity(database, { id: "00000000-0000-7000-8000-000000000102", eventType: NEWS }), new Set()))
      .resolves.toBe(true);
  });

  it("forgets resolutions older than the event-type window", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    for (const [index, day] of [100, 110, 120, 130].entries()) {
      recordResolution(database, {
        suffix: `7${index}`, workstreamId: STREAM_HISTORY, eventType: NEWS, status: "dismissed", resolvedAt: daysAgo(day),
      });
    }
    modelAnswers({ confidence: 0.85 });

    // The one card this costs is the price of suppression being a decaying
    // opinion rather than permanent.
    await expect(routeContextually(env, insertActivity(database, { id: "00000000-0000-7000-8000-0000000000fb", eventType: NEWS }), new Set()))
      .resolves.toBe(true);
  });
});
