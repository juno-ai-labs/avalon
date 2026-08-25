import { asWorkspaceId } from "@avalon/contracts";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { WorkspaceDO } from "../src/durable-objects/workspace-do";
import { withWorkstreamRuntimeDatabase } from "../src/services/workstream-runtime-database";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import {
  createCloudflareTestBinding,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";
import {
  openWorkstreamAuthorityForTest,
  testSubstreamAgentsBinding,
  workstreamObjectGet,
  workstreamObjectRootRow,
  workstreamObjectParticipantRows,
} from "./helpers/durable-authority";

// The real launcher creates the `harness_runs` row the delivery then points at,
// so the stub creates one too — without it the foreign key would be the only
// thing these tests were exercising. It admits the row the way the launcher
// does since the cutover: through the routed execution environment, into the
// work stream's own object. (Dynamic import because this callback is hoisted
// above the module's imports.)
const launchWorkstreamHarness = vi.hoisted(() => vi.fn(async (
  env: { DB: D1Database },
  input: { workspaceId: string; workstreamId: string },
) => {
  const { withWorkstreamRuntimeDatabase: route } = await import("../src/services/workstream-runtime-database");
  const routed = route(env as never, input.workspaceId, input.workstreamId);
  const id = crypto.randomUUID();
  await routed.DB.prepare(
    `INSERT INTO harness_runs
       (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
     VALUES (?, ?, ?, 'scheduled_digest', '{"type":"user","userId":"00000000-0000-7000-8000-000000000002"}',
             'running', '2026-08-11')`,
  ).bind(id, input.workspaceId, input.workstreamId).run();
  return id;
}));

vi.mock("../src/services/workstream-service", () => ({ launchWorkstreamHarness }));
vi.mock("../src/services/integrations", () => ({ publishWorkstreamEvent: vi.fn(async () => undefined) }));

const { fireDigestSchedule, renderDigestBrief } = await import("../src/services/digest-run-service");
const { markWorkflowInstanceCreated } = await import("../src/lib/workflow-launch-signal");

/** The shape `launchWorkstreamHarness` throws when its instance is already live. */
function harnessLaunchLeftRunExecutingError(): Error {
  return markWorkflowInstanceCreated(new Error("workflow_unavailable"));
}
const { recordActivityEventOrThrow } = await import("../src/services/activity-event-service");

const WORKSPACE = asWorkspaceId("00000000-0000-7000-8000-000000000001");
const OWNER = "00000000-0000-7000-8000-000000000002";
const OTHER = "00000000-0000-7000-8000-000000000003";
const SCHEDULE = "00000000-0000-7000-8000-000000000005";
const PLANNED_FOR = "2026-08-11T16:00:00.000Z";

const databases: DatabaseSync[] = [];
/** Per-workstream object databases the runtime SQL port opened, by id. */
let objectStores = new Map<string, DatabaseSync>();
afterEach(() => {
  vi.unstubAllGlobals();
  for (const store of objectStores.values()) store.close();
  objectStores = new Map();
  for (const database of databases.splice(0)) database.close();
  launchWorkstreamHarness.mockClear();
});

/**
 * The activity log moved into the WorkspaceDO's own storage with the cutover,
 * and its semantics — audience filtering, the digestible subset, the window
 * cap, target relations — are exactly what these tests exercise. So the three
 * activity RPCs are served by a real `WorkspaceDO` over a real object-schema
 * database rather than by a re-implementation whose bugs would be this file's
 * own. Everything else on the WORKSPACE_DOS stub keeps the migrated D1
 * database as its store, the way the runtime SQL port stub does.
 */
function workspaceActivityRpcs(database: DatabaseSync): Record<string, unknown> {
  const doDatabase = new DatabaseSync(":memory:");
  databases.push(doDatabase);
  const storage = createCloudflareTestBinding<DurableObjectStorage>({
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    deleteAlarm: async () => undefined,
    transactionSync: <T,>(body: () => T) => body(),
    sql: createTestSqlStorage(doDatabase),
  });
  // The constructor registers the runtime-only websocket auto-response pair.
  vi.stubGlobal("WebSocketRequestResponsePair", class {
    constructor(readonly request: string, readonly response: string) {}
  });
  const workspaceDO = new WorkspaceDO(
    createCloudflareTestBinding<DurableObjectState>({
      id: createTestDurableObjectId("workspace-do"),
      blockConcurrencyWhile: async <T,>(body: () => Promise<T>) => body(),
      setWebSocketAutoResponse: () => undefined,
      waitUntil: () => undefined,
      storage,
    }),
    createTestEnv({ DB: sqliteD1(database), AVALON_REGION: "global", APP_ENV: "test" }),
  );
  doDatabase.prepare(
    `INSERT INTO workspace_identity
       (id, workspace_id, region, placement_affinity, created_at, updated_at)
     VALUES (1, ?, 'global', 'wnam', 0, 0)`,
  ).run(WORKSPACE);
  return {
    recordActivityEvent: (input: unknown) => workspaceDO.recordActivityEvent(input as never),
    listActivityEvents: (input: unknown) => workspaceDO.listActivityEvents(input as never),
    latestActivityEventCursor: (input: unknown) => workspaceDO.latestActivityEventCursor(input as never),
  };
}

function envFor(database: DatabaseSync): Env {
  objectStores = new Map();
  return createTestEnv({
    DB: sqliteD1(database),
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
    WORKSPACE_DOS: testSubstreamAgentsBinding(database, { extra: workspaceActivityRpcs(database) }),
    AVALON_REGION: "global",
    APP_ENV: "test",
    PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
  });
}

/** The object of the one work stream the occurrence under test created. */
function onlyObjectStore(): DatabaseSync {
  const stores = [...objectStores.values()];
  if (stores.length !== 1) throw new Error(`expected exactly one work-stream object, saw ${stores.length}`);
  return stores[0]!;
}

function objectStoreFor(workstreamId: string): DatabaseSync {
  const store = objectStores.get(workstreamId);
  if (!store) throw new Error(`no work-stream object was opened for ${workstreamId}`);
  return store;
}

function seededDatabase(enabled = 1): DatabaseSync {
  const database = preRetirementProductSqliteDatabase();
  databases.push(database);
  // Every occurrence creates its work stream through the Durable-Object
  // authority; open it before any product rows exist, as a fresh stack does.
  openWorkstreamAuthorityForTest(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, timezone, created_at, updated_at)
    VALUES ('${OWNER}', 'g-owner', 'owner@example.com', 'Owner', 'Europe/London', '2026-01-01', '2026-01-01'),
           ('${OTHER}', 'g-other', 'other@example.com', 'Other', 'Europe/London', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE}', 'Avalon Studio', 'avalon-studio', 'global', '${OWNER}', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${WORKSPACE}', '${OWNER}', 'owner', 'active', '2026-01-01'),
           ('${WORKSPACE}', '${OTHER}', 'member', 'active', '2026-01-01');
    INSERT INTO digest_schedules
      (id, workspace_id, user_id, day_mask, enabled,
       execution_principal_json, version, created_at, updated_at)
    VALUES ('${SCHEDULE}', '${WORKSPACE}', '${OWNER}', 62, ${enabled},
            '{"type":"user","userId":"${OWNER}"}', 1, '2026-01-01', '2026-01-01');
  `);
  return database;
}

async function recordEvent(env: Env, dedupeKey: string): Promise<string> {
  return await recordActivityEventOrThrow(env, {
    workspaceId: WORKSPACE,
    eventType: "workstream.message.posted",
    subjectType: "workstream",
    subjectId: null,
    actorType: "user",
    actorUserId: OTHER,
    actorLabel: "Other",
    title: "Launch",
    body: "Shipped the installer",
    audience: { kind: "workspace" },
    digestible: true,
    occurredAt: "2026-08-11T09:00:00.000Z",
    sourceKind: "message",
    dedupeKey,
  });
}

describe("firing a digest occurrence", () => {
  it("starts one run and records the window it froze", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    await recordEvent(env, "message:1");
    await recordEvent(env, "message:2");

    const outcome = await fireDigestSchedule(env, {
      scheduleId: SCHEDULE, workspaceId: WORKSPACE, plannedFor: PLANNED_FOR,
    });

    expect(outcome.started).toBe(true);
    expect(launchWorkstreamHarness).toHaveBeenCalledTimes(1);
    const delivery = database.prepare(
      "SELECT status, event_count, cursor_from, cursor_through FROM digest_deliveries",
    ).get() as { status: string; event_count: number; cursor_from: number | null; cursor_through: number };
    expect(delivery).toMatchObject({ status: "running", event_count: 2, cursor_from: null });
    expect(delivery.cursor_through).toBe(2);
  });

  it("steps its cursor over what no connector confirmed is worth telling anyone", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    await recordEvent(env, "message:1");
    for (const index of [1, 2, 3]) {
      await recordActivityEventOrThrow(env, {
        workspaceId: WORKSPACE,
        eventType: "connector.github.github.check_run.completed",
        subjectType: "github_commit",
        subjectId: null,
        actorType: "external",
        actorLabel: "github",
        title: "check run completed — verify / lint",
        audience: { kind: "workspace" },
        digestible: false,
        occurredAt: "2026-08-11T09:00:00.000Z",
        sourceKind: "activity",
        dedupeKey: `activity:${index}`,
      });
    }

    await fireDigestSchedule(env, { scheduleId: SCHEDULE, workspaceId: WORKSPACE, plannedFor: PLANNED_FOR });

    const delivery = database.prepare(
      "SELECT event_count, cursor_through FROM digest_deliveries",
    ).get() as { event_count: number; cursor_through: number };
    // One event digested, and the cursor past all four. Stopping at the last
    // digestible event instead would make every later occurrence re-scan the
    // three that were withheld, forever.
    expect(delivery).toEqual({ event_count: 1, cursor_through: 4 });
    const brief = workstreamObjectGet(
      onlyObjectStore(),
      "SELECT text_content FROM messages WHERE message_type = 'system'",
    ) as { text_content: string };
    expect(brief.text_content).toContain("(1 item)");
    expect(brief.text_content).not.toContain("check run completed");
  });

  it("settles as empty when a whole window was machinery", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    await recordActivityEventOrThrow(env, {
      workspaceId: WORKSPACE,
      eventType: "connector.github.github.workflow_run.in_progress",
      subjectType: "github_workflow_run",
      subjectId: null,
      actorType: "external",
      actorLabel: "github",
      title: "workflow run in_progress — CI",
      audience: { kind: "workspace" },
      digestible: false,
      occurredAt: "2026-08-11T09:00:00.000Z",
      sourceKind: "activity",
      dedupeKey: "activity:1",
    });

    const outcome = await fireDigestSchedule(env, {
      scheduleId: SCHEDULE, workspaceId: WORKSPACE, plannedFor: PLANNED_FOR,
    });

    // Nothing to say and nothing sent, rather than a model asked to write a
    // morning briefing about continuous integration.
    expect(outcome).toEqual({ started: false, reason: "empty" });
    expect(launchWorkstreamHarness).not.toHaveBeenCalled();
    expect(database.prepare("SELECT status, cursor_through FROM digest_deliveries").get())
      .toEqual({ status: "empty", cursor_through: 1 });
  });

  it("runs in a private work stream the recipient alone participates in", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    await recordEvent(env, "message:1");

    await fireDigestSchedule(env, { scheduleId: SCHEDULE, workspaceId: WORKSPACE, plannedFor: PLANNED_FOR });

    // Two declarations, two questions: private is who may read it, machinery is
    // whether it is listed. Both live in the work stream's own object since the
    // cutover — the D1 row is only the identity anchor.
    const store = onlyObjectStore();
    expect(workstreamObjectRootRow(store, "system_kind, scope"))
      .toEqual({ system_kind: "digest", scope: "personal" });
    expect(workstreamObjectParticipantRows(store, "user_id")).toEqual([{ user_id: OWNER }]);
  });

  it("gives the next occurrence a work stream of its own", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    await recordEvent(env, "message:1");
    await fireDigestSchedule(env, { scheduleId: SCHEDULE, workspaceId: WORKSPACE, plannedFor: PLANNED_FOR });
    database.exec("UPDATE digest_deliveries SET status = 'delivered'");
    await recordEvent(env, "message:2");

    await fireDigestSchedule(env, {
      scheduleId: SCHEDULE, workspaceId: WORKSPACE, plannedFor: "2026-08-11T20:00:00.000Z",
    });

    // Nothing carries between occurrences but the cursor. A shared work stream
    // would hand this run the previous digest as replayed assistant history,
    // unlabelled and uncheckable against a window the projector drops.
    const deliveries = database.prepare(
      "SELECT workstream_id FROM digest_deliveries ORDER BY planned_for",
    ).all() as Array<{ workstream_id: string }>;
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]!.workstream_id).not.toBe(deliveries[1]!.workstream_id);
    // Each occurrence owns its own: one identity anchor per work stream in the
    // regional index, and one object holding the product row.
    expect(database.prepare("SELECT COUNT(*) AS count FROM workstreams").get()).toEqual({ count: 2 });
    // Titled by occurrence alone, in the recipient's own timezone, and short
    // enough that the sidebar's ellipsis does not eat the time — which is the
    // only thing telling two occurrences on the same day apart. The title is
    // product state, so it lives on each object's root.
    expect(deliveries.map(({ workstream_id }) => workstreamObjectRootRow<{ title: string }>(
      objectStoreFor(workstream_id),
      "title",
    ).title)).toEqual([
      "Digest · 11 Aug · 5:00 PM",
      "Digest · 11 Aug · 9:00 PM",
    ]);
  });

  it("leaves the occurrence alone when the launch left a run executing", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    await recordEvent(env, "message:1");
    // `launchWorkstreamHarness` creates the Workflow instance before it records
    // the instance id, so this failure arrives with a live run already reading
    // the transcript. It marks its own run row `failed` on the way out, which
    // is exactly why the row cannot be what decides this.
    launchWorkstreamHarness.mockImplementationOnce(async (
      launchEnv: { DB: D1Database },
      input: { workspaceId: string; workstreamId: string },
    ) => {
      const routed = withWorkstreamRuntimeDatabase(launchEnv as never, input.workspaceId, input.workstreamId);
      await routed.DB.prepare(
        `INSERT INTO harness_runs
           (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
         VALUES (?, ?, ?, 'scheduled_digest', '{"type":"user","userId":"${OWNER}"}',
                 'failed', '2026-08-11')`,
      ).bind(crypto.randomUUID(), input.workspaceId, input.workstreamId).run();
      throw harnessLaunchLeftRunExecutingError();
    });

    await expect(fireDigestSchedule(env, {
      scheduleId: SCHEDULE, workspaceId: WORKSPACE, plannedFor: PLANNED_FOR,
    })).rejects.toThrow();

    // Releasing the claim would let a retry digest this window a second time,
    // and deleting the work stream would cascade the transcript away beneath
    // the run still reading it.
    expect(database.prepare("SELECT COUNT(*) AS count FROM digest_deliveries").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM workstreams").get()).toEqual({ count: 1 });
    expect(workstreamObjectGet(onlyObjectStore(), "SELECT COUNT(*) AS count FROM messages"))
      .toEqual({ count: 1 });
  });

  it("releases the work stream with the claim when the launch never happened", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    await recordEvent(env, "message:1");
    launchWorkstreamHarness.mockRejectedValueOnce(new Error("queue unavailable"));

    await expect(fireDigestSchedule(env, {
      scheduleId: SCHEDULE, workspaceId: WORKSPACE, plannedFor: PLANNED_FOR,
    })).rejects.toThrow("queue unavailable");

    // The scheduler's retry re-fires this occurrence, so a failed attempt must
    // release the claim. The work stream cannot be deleted with it any more —
    // a Durable Object identity cannot join the claim's transaction — so the
    // release leaves the D1 anchor and archives the object root instead: a
    // durable, unlistable tombstone, transcript and all.
    expect(database.prepare("SELECT COUNT(*) AS count FROM digest_deliveries").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM workstreams").get()).toEqual({ count: 1 });
    const tombstone = workstreamObjectRootRow<{ system_kind: string; archived_at: number | null }>(
      onlyObjectStore(),
      "system_kind, archived_at",
    );
    expect(tombstone.system_kind).toBe("digest");
    expect(tombstone.archived_at).not.toBeNull();
    expect(workstreamObjectGet(onlyObjectStore(), "SELECT COUNT(*) AS count FROM messages"))
      .toEqual({ count: 1 });
  });

  it("digests each event exactly once across consecutive occurrences", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    await recordEvent(env, "message:1");
    await fireDigestSchedule(env, { scheduleId: SCHEDULE, workspaceId: WORKSPACE, plannedFor: PLANNED_FOR });
    database.exec("UPDATE digest_deliveries SET status = 'delivered'");
    await recordEvent(env, "message:2");

    await fireDigestSchedule(env, {
      scheduleId: SCHEDULE, workspaceId: WORKSPACE, plannedFor: "2026-08-11T20:00:00.000Z",
    });

    const [, second] = database.prepare(
      "SELECT cursor_from, cursor_through, event_count FROM digest_deliveries ORDER BY planned_for",
    ).all() as Array<{ cursor_from: number | null; cursor_through: number; event_count: number }>;
    // The second window starts exactly where the first stopped.
    expect(second).toEqual({ cursor_from: 1, cursor_through: 2, event_count: 1 });
  });

  it("never advances the reader's in-app unread waterline", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    await recordEvent(env, "message:1");

    await fireDigestSchedule(env, { scheduleId: SCHEDULE, workspaceId: WORKSPACE, plannedFor: PLANNED_FOR });

    // A digest says "what you have been told"; read state says "what you have
    // read". Skimming an email must not clear the badges in the app.
    expect(database.prepare("SELECT COUNT(*) AS count FROM workstream_read_states").get()).toEqual({ count: 0 });
  });

  it("settles a window with nothing in it without running the model", async () => {
    const database = seededDatabase();

    const outcome = await fireDigestSchedule(envFor(database), {
      scheduleId: SCHEDULE, workspaceId: WORKSPACE, plannedFor: PLANNED_FOR,
    });

    expect(outcome).toEqual({ started: false, reason: "empty" });
    expect(launchWorkstreamHarness).not.toHaveBeenCalled();
    expect(database.prepare("SELECT status FROM digest_deliveries").get()).toEqual({ status: "empty" });
  });

  it("refuses a second run for an occurrence a retried alarm already claimed", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    await recordEvent(env, "message:1");
    await fireDigestSchedule(env, { scheduleId: SCHEDULE, workspaceId: WORKSPACE, plannedFor: PLANNED_FOR });

    const second = await fireDigestSchedule(env, {
      scheduleId: SCHEDULE, workspaceId: WORKSPACE, plannedFor: PLANNED_FOR,
    });

    expect(second).toEqual({ started: false, reason: "already_planned" });
    expect(launchWorkstreamHarness).toHaveBeenCalledTimes(1);
  });

  it("does not fire a disabled digest", async () => {
    const database = seededDatabase(0);
    const env = envFor(database);
    await recordEvent(env, "message:1");

    expect(await fireDigestSchedule(env, {
      scheduleId: SCHEDULE, workspaceId: WORKSPACE, plannedFor: PLANNED_FOR,
    })).toEqual({ started: false, reason: "disabled" });
  });

  it("does not fire for someone whose membership is no longer active", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    await recordEvent(env, "message:1");
    database.exec(`UPDATE workspace_members SET status = 'suspended' WHERE user_id = '${OWNER}'`);

    expect(await fireDigestSchedule(env, {
      scheduleId: SCHEDULE, workspaceId: WORKSPACE, plannedFor: PLANNED_FOR,
    })).toEqual({ started: false, reason: "unauthorized" });
  });

  it("stops the window where the read stopped, not where the log ends", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    // More events than one run is given. Recording the log's top as covered
    // would step the cursor straight over the remainder for ever.
    for (let index = 0; index < 205; index += 1) await recordEvent(env, `message:${index}`);

    await fireDigestSchedule(env, { scheduleId: SCHEDULE, workspaceId: WORKSPACE, plannedFor: PLANNED_FOR });

    const delivery = database.prepare(
      "SELECT event_count, cursor_through FROM digest_deliveries",
    ).get() as { event_count: number; cursor_through: number };
    expect(delivery.event_count).toBe(200);
    expect(delivery.cursor_through).toBe(200);

    database.exec("UPDATE digest_deliveries SET status = 'delivered'");
    await fireDigestSchedule(env, {
      scheduleId: SCHEDULE, workspaceId: WORKSPACE, plannedFor: "2026-08-11T20:00:00.000Z",
    });
    const [, second] = database.prepare(
      "SELECT cursor_from, event_count FROM digest_deliveries ORDER BY planned_for",
    ).all() as Array<{ cursor_from: number; event_count: number }>;
    // The five that did not fit are digested next time rather than lost.
    expect(second).toEqual({ cursor_from: 200, event_count: 5 });
  });

  it("freezes how many of the window's events name the recipient", async () => {
    const database = seededDatabase();
    const env = envFor(database);
    await recordEvent(env, "message:1");
    await recordActivityEventOrThrow(env, {
      workspaceId: WORKSPACE,
      eventType: "workstream.message.posted",
      subjectType: "workstream",
      subjectId: null,
      actorType: "user",
      actorUserId: OTHER,
      actorLabel: "Other",
      title: "Launch",
      audience: { kind: "workspace" },
      digestible: true,
      occurredAt: "2026-08-11T09:00:00.000Z",
      sourceKind: "message",
      dedupeKey: "message:2",
      targets: [{ userId: OWNER, relation: "mentioned" }],
    });

    await fireDigestSchedule(env, { scheduleId: SCHEDULE, workspaceId: WORKSPACE, plannedFor: PLANNED_FOR });

    // Counted against the window the run was given, so a later read cannot
    // disagree by re-deriving the audience filter or the look-back floor.
    expect(database.prepare("SELECT event_count, highlight_count FROM digest_deliveries").get())
      .toEqual({ event_count: 2, highlight_count: 1 });
  });
});

describe("the brief a digest run is triggered with", () => {
  const schedule = { user_name: "Ada", workspace_name: "Avalon Studio", timezone: "Europe/London" };

  function event(overrides: Record<string, unknown> = {}) {
    return {
      log_sequence: 1,
      id: "00000000-0000-7000-8000-0000000000b1",
      event_type: "workstream.message.posted",
      subject_type: "workstream",
      subject_id: "00000000-0000-7000-8000-0000000000c1",
      subject_sequence_number: 4,
      actor_type: "user",
      actor_user_id: OTHER,
      actor_label: "Other",
      title: "Launch",
      body: "Shipped the installer",
      canonical_url: null,
      occurred_at: "2026-08-11T09:00:00.000Z",
      created_at: "2026-08-11T09:00:00.000Z",
      metadata_json: "{}",
      is_target: 0,
      target_relations: null,
      ...overrides,
    };
  }

  it("groups by subject rather than listing a flat timeline", () => {
    const brief = renderDigestBrief(schedule, [
      event(),
      event({ id: "b2", log_sequence: 2, body: "Fixed the crash" }),
      event({ id: "b3", log_sequence: 3, subject_id: "c2", title: "Pricing", body: "Raised the tier" }),
    ]);

    expect(brief.match(/^### /gmu)).toHaveLength(2);
    expect(brief).toContain("### Launch — workstream");
    expect(brief).toContain("### Pricing — workstream");
  });

  it("does not restate the formatting policy the run's system prompt already carries", () => {
    // A digest run is an ordinary work-stream run, so its system prompt has
    // RESPONSE_FORMATTING_POLICY. A second copy here once sat right under the
    // brief's own output shape and invited tables where a bullet was asked for.
    expect(renderDigestBrief(schedule, [event()])).not.toContain("# Response formatting");
  });

  it("marks the items that name the reader so the model can lead with them", () => {
    const brief = renderDigestBrief(schedule, [
      event(),
      event({ id: "b2", log_sequence: 2, is_target: 1, target_relations: "mentioned" }),
    ]);

    expect(brief).toContain("[mentioned — THIS NAMES THEM]");
    expect(brief).toContain("`## Needs you` covering the 1 item");
  });

  it("points the run at the window rather than at what an earlier digest sent", () => {
    const brief = renderDigestBrief(schedule, [event()]);

    expect(brief).toContain("Write this digest from the source material below and nothing else");
    expect(brief).toContain("Ada");
    expect(brief).toContain("Europe/London");
    expect(brief).toContain("(1 item)");
    // The rule must not depend on the transcript's delivery notes. Those are
    // `system` rows and the protocol projector drops them, so from the second
    // occurrence onward every earlier digest would read as never delivered and
    // be restated. `cursor_from` already makes the windows non-overlapping,
    // and a failed delivery's events come back in this brief rather than only
    // in the older summary.
    expect(brief).not.toContain("delivered");
  });

  it("tells the run its final message is the thing that gets mailed", () => {
    // `settleDigestRun` mails `message.textContent` of the last message and has
    // no way to tell a digest from a sign-off, so the brief is the only place
    // this can be established. A run that ended with "Outcome: Digest artifact
    // created (id …)" mailed that sentence, and it settled as delivered.
    const brief = renderDigestBrief(schedule, [event()]);

    expect(brief).toContain("Your final message in this run is the digest");
    expect(brief).toContain("mailed verbatim");
  });

  it("hands the run the real link so the digest can point rather than describe", () => {
    const brief = renderDigestBrief(schedule, [
      event({ canonical_url: "https://with-avalon.com/app/workstreams/c1" }),
    ]);

    expect(brief).toContain("link: https://with-avalon.com/app/workstreams/c1");
    expect(brief).toContain("Never invent a URL");
  });

  it("suppresses the priority section when nothing names the reader", () => {
    const brief = renderDigestBrief(schedule, [event()]);

    expect(brief).toContain('do not write a "Needs you" section');
    expect(brief).not.toContain("THIS NAMES THEM");
  });
});
