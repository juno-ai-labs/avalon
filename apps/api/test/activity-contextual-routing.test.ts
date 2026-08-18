import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

// Hoisted rather than declared beside the mock: `vi.mock` is lifted above every
// `const` in the file, so a factory closing over an ordinary binding reads it
// before initialization.
const { runStructuredInference } = vi.hoisted(() => ({ runStructuredInference: vi.fn() }));
vi.mock("../src/services/structured-inference", () => ({ runStructuredInference }));

import type { Env } from "../src/env";
import { __testing, consumeActivityQueue } from "../src/queues/activity-consumer";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createCloudflareTestBinding, createTestDurableObjectId, createTestEnv } from "./helpers/cloudflare-test";

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
const OTHER_NEWS = "github.issue_comment.created";

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
function roomNamespace(): DurableObjectNamespace {
  const namespace = {
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: () => ({ fetch: async () => new Response(null, { status: 200 }) }),
    jurisdiction: () => namespace,
  };
  return createCloudflareTestBinding<DurableObjectNamespace>(namespace);
}

/**
 * The GitHub credentials are what put GitHub in this env's connector registry,
 * and the registry is what answers whether an event type is digestible. Without
 * them every activity here would be withheld for the uninteresting reason that
 * the connector is unregistered in this region — which is itself asserted once,
 * deliberately, below.
 */
function envFor(database: DatabaseSync, overrides: Partial<Record<string, unknown>> = {}): Env {
  return createTestEnv({
    DB: sqliteD1(database),
    SUBSTREAM_AGENTS: roomNamespace(),
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
  const database = migratedSqliteDatabase();
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
    actor_json: "{}",
    occurred_at: "2026-08-11T11:30:00.000Z",
    received_at: "2026-08-11T11:30:01.000Z",
    title: input.title ?? "juno-ai-labs/avalon: review requested",
    summary: "A summary",
    text_snippet: "A snippet",
    visibility_json: "{}",
    target_user_ids_json: "[]",
    entity_keys_json: "[]",
    metadata_json: "{}",
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

/** The candidate ids the model was actually offered. */
function offeredCandidates(): string[] {
  const [, request] = runStructuredInference.mock.calls[0] as [unknown, { messages: Array<{ content: string }> }];
  const payload = JSON.parse(request.messages[1]!.content) as { candidates: Array<{ id: string }> };
  return payload.candidates.map((candidate) => candidate.id);
}

function suggestionCount(database: DatabaseSync): number {
  return (database.prepare("SELECT COUNT(*) AS count FROM activity_suggestions WHERE status = 'pending'")
    .get() as { count: number }).count;
}

describe("contextual routing pause boundary", () => {
  it("skips contextual inference and still batches an unclaimed activity for Suggested work", async () => {
    const database = seededDatabase();
    const env = envFor(database);
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

    expect(runStructuredInference).not.toHaveBeenCalled();
    expect(suggestionCount(database)).toBe(0);
    expect(database.prepare(
      "SELECT source_id, status FROM opportunity_batch_events WHERE source_kind = 'activity'",
    ).get()).toEqual({ source_id: activityId, status: "pending" });
    expect(database.prepare("SELECT processing_status FROM activities WHERE id = ?").get(activityId))
      .toEqual({ processing_status: "processed" });
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });
});

describe("contextual routing: where the bar starts", () => {
  it("offers a card at the base bar for activity a digest would carry", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    modelAnswers({ confidence: 0.82 });

    await expect(routeContextually(env, insertActivity(database, { id: "00000000-0000-7000-8000-0000000000f1", eventType: NEWS }), new Set()))
      .resolves.toBe(true);
    expect(suggestionCount(database)).toBe(1);
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
    expect(suggestionCount(database)).toBe(0);

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
    expect(suggestionCount(database)).toBe(1);
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

describe("contextual routing: a work stream's run of dismissals", () => {
  it("stops offering a work stream after three dismissals", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    // A different event type, so this exercises the work stream's run rather
    // than the event-type score.
    for (const [index, day] of [1, 2, 3].entries()) {
      recordResolution(database, {
        suffix: `1${index}`, workstreamId: STREAM_A, eventType: OTHER_NEWS, status: "dismissed", resolvedAt: daysAgo(day),
      });
    }
    modelAnswers({ workstreamId: STREAM_B, confidence: 0.9 });

    await routeContextually(env, insertActivity(database, { id: "00000000-0000-7000-8000-0000000000f4", eventType: NEWS }), new Set());

    expect(offeredCandidates()).not.toContain(STREAM_A);
    expect(offeredCandidates()).toContain(STREAM_B);
  });

  it("keeps a work stream whose dismissals came from another producer", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    // A work stream must not lose its place in this module's candidate pool
    // over three dismissals of suggested-work's cards.
    for (const [index, day] of [1, 2, 3].entries()) {
      recordResolution(database, {
        suffix: `c${index}`, workstreamId: STREAM_A, eventType: OTHER_NEWS, status: "dismissed", resolvedAt: daysAgo(day),
        source: "suggested_work",
      });
    }
    modelAnswers({ confidence: 0.9 });

    await routeContextually(env, insertActivity(database, { id: "00000000-0000-7000-8000-000000000103", eventType: NEWS }), new Set());

    expect(offeredCandidates()).toContain(STREAM_A);
  });

  it("lets one acceptance clear the run", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    for (const [index, day] of [3, 4, 5].entries()) {
      recordResolution(database, {
        suffix: `2${index}`, workstreamId: STREAM_A, eventType: OTHER_NEWS, status: "dismissed", resolvedAt: daysAgo(day),
      });
    }
    recordResolution(database, {
      suffix: "29", workstreamId: STREAM_A, eventType: OTHER_NEWS, status: "accepted", resolvedAt: daysAgo(1),
    });
    modelAnswers({ confidence: 0.9 });

    await routeContextually(env, insertActivity(database, { id: "00000000-0000-7000-8000-0000000000f5", eventType: NEWS }), new Set());

    expect(offeredCandidates()).toContain(STREAM_A);
  });

  it("replaces an already-routed work stream instead of spending its slot", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    // Thirteen candidates for twelve slots, so the LIMIT actually bites — with
    // three work streams this assertion would hold whether the exclusion runs
    // in the query or in JavaScript afterwards, and prove nothing.
    for (let index = 0; index < 10; index += 1) {
      database.prepare(
        `INSERT INTO workstreams
           (id, workspace_id, title, objective, origin_type, created_by_user_id,
            harness_status, last_activity_at, created_at, updated_at)
         VALUES (?, ?, ?, 'Filler', 'ad_hoc', ?, 'idle', ?, '2026-01-01', '2026-01-01')`,
      ).run(
        `00000000-0000-7000-8000-0000000e${String(index).padStart(4, "0")}`,
        WORKSPACE,
        `Filler ${index}`,
        MEMBER,
        `2026-08-0${index % 9}T09:00:00.000Z`,
      );
    }
    modelAnswers({ workstreamId: STREAM_B, confidence: 0.9 });

    // A watch already delivered this activity to STREAM_A. Excluding it after
    // the LIMIT leaves the model eleven candidates; excluding it inside the
    // query hands it the twelfth it would otherwise have lost.
    await routeContextually(
      env,
      insertActivity(database, { id: "00000000-0000-7000-8000-0000000000fe", eventType: NEWS }),
      new Set([STREAM_A]),
    );

    expect(offeredCandidates()).not.toContain(STREAM_A);
    expect(offeredCandidates()).toContain(STREAM_B);
    expect(offeredCandidates()).toHaveLength(12);
  });

  it("forgets dismissals older than the window", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    // Nobody has offered this work stream a suggestion in over a month, so it
    // has had no chance to earn the acceptance that would clear its run.
    for (const [index, day] of [40, 45, 50].entries()) {
      recordResolution(database, {
        suffix: `3${index}`, workstreamId: STREAM_A, eventType: OTHER_NEWS, status: "dismissed", resolvedAt: daysAgo(day),
      });
    }
    modelAnswers({ confidence: 0.9 });

    await routeContextually(env, insertActivity(database, { id: "00000000-0000-7000-8000-0000000000f6", eventType: NEWS }), new Set());

    expect(offeredCandidates()).toContain(STREAM_A);
  });
});

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
    expect(suggestionCount(database)).toBe(0);

    runStructuredInference.mockReset();
    modelAnswers({ confidence: 0.95 });
    await expect(routeContextually(env, insertActivity(database, { id: "00000000-0000-7000-8000-0000000000f9", eventType: NEWS }), new Set()))
      .resolves.toBe(true);
    expect(suggestionCount(database)).toBe(1);
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
    expect(suggestionCount(database)).toBe(1);
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
    expect(suggestionCount(database)).toBe(1);
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
    expect(suggestionCount(database)).toBe(1);
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
