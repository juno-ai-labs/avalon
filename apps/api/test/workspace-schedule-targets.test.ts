/**
 * The workspace alarm's due-time queries, against the object's own schema.
 *
 * A maintenance entry is due at the earliest row its pass will act on, and the
 * hot loop of 2026-08-22 was a query that counted a row its pass did not
 * remove. These cases pin the two arms that could do that again — the draft
 * reap keeps a linked draft on purpose, and `strftime` drops the milliseconds
 * the pass's own cutoff keeps — on the ledger production applies, because the
 * links table exists nowhere else. `docs/durable-object-alarms.md` is the
 * module document.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import {
  reapSettledWorkspaceNotificationIntents,
  workspaceNotificationIntentMaintenanceTarget,
} from "../src/durable-objects/workspace-notification-intent-storage";
import {
  runWorkspaceScheduleTarget,
  terminalReconcileOutcome,
  workspaceScheduleTargets,
  type WorkspaceScheduleContext,
  type WorkspaceScheduleTarget,
} from "../src/services/workspace-schedule-execution";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";
import { sqliteD1 } from "./helpers/sqlite-d1";
import {
  createTestWorkspaceDO,
  testWorkspaceObjectBinding,
} from "./helpers/workspace-object-rpcs";

const WORKSPACE_ID = "00000000-0000-7000-8000-0000000000a1";
const WORKSTREAM_ID = "00000000-0000-7000-8000-0000000000a2";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

/** The object each fixture database belongs to; passes run against it. */
const workspaceObjects = new Map<DatabaseSync, WorkspaceDO>();

/** The object's ledger, every version, as the constructor applies it. */
function workspaceObjectDatabase(): DatabaseSync {
  const regional = new DatabaseSync(":memory:");
  databases.push(regional);
  // A real WorkspaceDO: its constructor applies the ledger, and the resource
  // maintenance passes below run as its typed methods over this database.
  const workspaceObject = createTestWorkspaceDO({
    workspaceId: WORKSPACE_ID,
    regionalDatabase: regional,
    register: (created) => { databases.push(created); },
  });
  workspaceObjects.set(workspaceObject.objectDatabase, workspaceObject.instance);
  return workspaceObject.objectDatabase;
}

function scheduleContext(database: DatabaseSync): WorkspaceScheduleContext {
  const env = createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    APP_ENV: "test",
    PAYLOADS: createCloudflareTestBinding<R2Bucket>({ delete: async () => undefined }),
    WORKSPACE_DOS: testWorkspaceObjectBinding(workspaceObjects.get(database)!, [
      "claimResourceSlug",
      "listResourcesAwaitingSlug",
      "listReapableResourceObjects",
      "claimResourceObjectRemoval",
      "retireResourceObjectStaging",
      "recordResourceObjectCleanupFailure",
      "reapExpiredDraftResources",
    ]),
  });
  const storage = createCloudflareTestBinding<DurableObjectStorage>({
    transactionSync: (body: () => unknown) => body(),
    sql: createTestSqlStorage(database),
  });
  return {
    env,
    workspaceEnv: env,
    workspaceId: WORKSPACE_ID,
    directory: {
      workstreamScheduleTargets: async () => ({ items: [] }),
    },
    notificationIntents: {
      notificationIntentMaintenanceTarget: async (input) =>
        workspaceNotificationIntentMaintenanceTarget(storage, input.workspaceId),
      reapSettledWorkstreamNotificationIntents: async (input) =>
        reapSettledWorkspaceNotificationIntents(storage, input, Date.now()),
    },
    dueTerminalSubstreams: async () => [],
  };
}

function seedDraft(database: DatabaseSync, id: string, createdAt: string): void {
  database.prepare(
    `INSERT INTO resources
       (id, workspace_id, resource_type, provider, title, created_at, updated_at,
        uploaded_by_user_id, attachment_status)
     VALUES (?, ?, 'file', 'avalon_upload', 'draft.pdf', ?, ?, 'user-1', 'draft')`,
  ).run(id, WORKSPACE_ID, createdAt, createdAt);
}

function linkToWorkstream(database: DatabaseSync, resourceId: string): void {
  database.prepare(
    `INSERT OR IGNORE INTO channels
       (workstream_id, authority_generation, waterline, source_event_id, payload_hash, title,
        description, preview, scope, exact_state, last_activity_at, origin_type, title_status,
        latest_attention_ordinal, unread_tracking_start_ordinal, source_created_at,
        source_updated_at, projected_at)
     VALUES (?, 1, 1, 'event-1', 'hash', 'Linked', '', '', 'workspace', 'running', 0, 'ad_hoc',
             'settled', 0, 0, 0, 0, 0)`,
  ).run(WORKSTREAM_ID);
  database.prepare(
    `INSERT INTO workspace_workstream_resource_links
       (workstream_id, resource_id, watch_enabled, relationship_type, authority_generation,
        waterline, source_event_id, projected_at)
     VALUES (?, ?, 0, 'attachment', 1, 1, ?, 0)`,
  ).run(WORKSTREAM_ID, resourceId, `link-${resourceId}`);
}

function maintenance(targets: WorkspaceScheduleTarget[], id: string): WorkspaceScheduleTarget[] {
  return targets.filter((target) => target.kind === "maintenance" && target.id === id);
}

function expiredDrafts(targets: WorkspaceScheduleTarget[]): WorkspaceScheduleTarget[] {
  return maintenance(targets, "expired_drafts");
}

async function runMaintenance(database: DatabaseSync, id: string) {
  return runWorkspaceScheduleTarget(
    scheduleContext(database),
    { kind: "maintenance", id, dueAt: "2026-01-01T00:00:00.000Z" },
    new Date(),
  );
}

describe("the expired-drafts due time", () => {
  it("counts only the drafts the reap will remove, so a linked draft cannot pin the pass", async () => {
    const database = workspaceObjectDatabase();
    seedDraft(database, "00000000-0000-7000-8000-0000000000d1", "2026-01-01T00:00:00.000Z");
    linkToWorkstream(database, "00000000-0000-7000-8000-0000000000d1");

    // The linked draft is the only draft: nothing is due.
    expect(expiredDrafts(await workspaceScheduleTargets(scheduleContext(database)))).toEqual([]);

    // An unlinked draft, newer than the linked one, is what the pass is due for.
    seedDraft(database, "00000000-0000-7000-8000-0000000000d2", "2026-02-01T00:00:00.000Z");

    expect(expiredDrafts(await workspaceScheduleTargets(scheduleContext(database))))
      .toEqual([{ kind: "maintenance", id: "expired_drafts", dueAt: "2026-02-02T00:00:01Z" }]);
  });

  it("rounds a due time up to the next whole second rather than down to the last", async () => {
    // The pass compares the millisecond column against its own cutoff. A due
    // time rounded down fires up to 999 ms before the row is reapable, finds
    // nothing, and comes back at the identical instant — which the stall gate
    // now holds and reports.
    const database = workspaceObjectDatabase();
    seedDraft(database, "00000000-0000-7000-8000-0000000000d3", "2026-03-01T10:20:30.700Z");

    expect(expiredDrafts(await workspaceScheduleTargets(scheduleContext(database))))
      .toEqual([{ kind: "maintenance", id: "expired_drafts", dueAt: "2026-03-02T10:20:31Z" }]);
  });
});

describe("the resource-alias backfill", () => {
  it("is due for the oldest unnamed resource, and stops being due once every one is named", async () => {
    const database = workspaceObjectDatabase();
    const seed = (id: string, createdAt: string): void => {
      database.prepare(
        `INSERT INTO resources
           (id, workspace_id, resource_type, provider, title, metadata_json, created_at, updated_at)
         VALUES (?, ?, 'document', 'notion', 'Spec', '{}', ?, ?)`,
      ).run(id, WORKSPACE_ID, createdAt, createdAt);
    };
    seed("00000000-0000-7000-8000-0000000000e1", "2026-01-01T00:00:00.000Z");
    seed("00000000-0000-7000-8000-0000000000e2", "2026-02-01T00:00:00.000Z");

    expect(maintenance(await workspaceScheduleTargets(scheduleContext(database)), "resource_slugs"))
      .toEqual([{ kind: "maintenance", id: "resource_slugs", dueAt: "2026-01-01T00:00:00.000Z" }]);

    await expect(runMaintenance(database, "resource_slugs")).resolves.toEqual({ progressed: true });

    // Nothing left to name, so the entry drops out rather than re-deriving the
    // same instant and being held as a stall.
    expect(maintenance(await workspaceScheduleTargets(scheduleContext(database)), "resource_slugs"))
      .toEqual([]);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM resources WHERE slug IS NULL",
    ).get()).toEqual({ count: 0 });
  });
});

describe("what a maintenance pass tells the stall check", () => {
  it("arms cleanup for an eligible row with no resource pointer", async () => {
    const database = workspaceObjectDatabase();
    database.prepare(
      `INSERT INTO resource_object_deletion_outbox
         (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
       VALUES ('regional/eligible', ?, '00000000-0000-7000-8000-0000000000d7',
               'original', '2026-01-01', '2026-01-01')`,
    ).run(WORKSPACE_ID);

    expect(maintenance(
      await workspaceScheduleTargets(scheduleContext(database)),
      "resource_objects",
    )).toEqual([{ kind: "maintenance", id: "resource_objects", dueAt: "2026-01-01" }]);
  });

  it("does not arm cleanup for an inactive publication still owned by its writer", async () => {
    const database = workspaceObjectDatabase();
    database.prepare(
      `INSERT INTO resource_object_deletion_outbox
         (object_ref, workspace_id, resource_id, object_kind, cleanup_eligible, created_at, updated_at)
       VALUES ('regional/staged', ?, '00000000-0000-7000-8000-0000000000d8',
               'original', 0, '2026-01-01', '2026-01-01')`,
    ).run(WORKSPACE_ID);

    expect(maintenance(
      await workspaceScheduleTargets(scheduleContext(database)),
      "resource_objects",
    )).toEqual([]);

    database.prepare(
      `INSERT INTO resources
         (id, workspace_id, resource_type, provider, title, content_ref,
          metadata_json, attachment_status, created_at, updated_at)
       VALUES ('00000000-0000-7000-8000-0000000000d8', ?, 'generated_file',
               'avalon_generated', 'Staged', 'regional/staged', '{}', 'attached',
               '2026-01-01', '2026-01-01')`,
    ).run(WORKSPACE_ID);
    expect(maintenance(
      await workspaceScheduleTargets(scheduleContext(database)),
      "resource_objects",
    )).toEqual([{
      kind: "maintenance",
      id: "resource_objects",
      dueAt: "2026-01-01",
    }]);
  });

  it("arms cleanup when only resource history references staged bytes", async () => {
    const database = workspaceObjectDatabase();
    database.prepare(
      `INSERT INTO resources
         (id, workspace_id, resource_type, provider, title, content_ref,
          metadata_json, attachment_status, created_at, updated_at)
       VALUES ('00000000-0000-7000-8000-0000000000d6', ?, 'generated_file',
               'avalon_generated', 'Historical', 'regional/current', '{}', 'attached',
               '2026-01-01', '2026-01-01')`,
    ).run(WORKSPACE_ID);
    database.prepare(
      `UPDATE resource_versions SET content_ref = 'regional/historical'
        WHERE resource_id = '00000000-0000-7000-8000-0000000000d6' AND version = 1`,
    ).run();
    database.prepare(
      `INSERT INTO resource_object_deletion_outbox
         (object_ref, workspace_id, resource_id, object_kind, cleanup_eligible, created_at, updated_at)
       VALUES ('regional/historical', ?, '00000000-0000-7000-8000-0000000000d6',
               'original', 0, '2026-01-01', '2026-01-01')`,
    ).run(WORKSPACE_ID);

    expect(maintenance(
      await workspaceScheduleTargets(scheduleContext(database)),
      "resource_objects",
    )).toEqual([{ kind: "maintenance", id: "resource_objects", dueAt: "2026-01-01" }]);
  });

  it("reports progress from a reap by the rows it retired, and nothing when there were none", async () => {
    const database = workspaceObjectDatabase();

    expect(await runMaintenance(database, "resource_objects")).toBeUndefined();

    database.prepare(
      `INSERT INTO resource_object_deletion_outbox
         (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
       VALUES ('regional/object', ?, '00000000-0000-7000-8000-0000000000d9', 'receipt', '2026-01-01', '2026-01-01')`,
    ).run(WORKSPACE_ID);

    expect(await runMaintenance(database, "resource_objects")).toEqual({ progressed: true });
    expect(await runMaintenance(database, "resource_objects")).toBeUndefined();
  });

  it("reports progress from the notification-intent reap the same way", async () => {
    const database = workspaceObjectDatabase();
    const insert = (id: string, state: string, updatedAt: string) => database.prepare(
      `INSERT INTO workstream_notification_intents
         (intent_id, workspace_id, workstream_id, recipient_user_id, source_message_id, source_generation,
          source_version, required_directory_version, notification_kind, payload_hash, state, updated_at, created_at)
       VALUES (?, ?, ?, 'user-1', ?, 1, 1, 1, 'mention', 'hash', ?, ?, ?)`,
    ).run(id, WORKSPACE_ID, WORKSTREAM_ID, `message-${id}`, state, updatedAt, updatedAt);
    insert("00000000-0000-7000-8000-0000000000f1", "delivered", "2026-01-01T00:00:00.000Z");
    insert("00000000-0000-7000-8000-0000000000f2", "pending", "2026-01-01T00:00:00.000Z");

    expect(await runMaintenance(database, "notification_intents")).toEqual({ progressed: true });
    // The settled intent is gone; the pending one is not the reap's to take.
    expect(await runMaintenance(database, "notification_intents")).toBeUndefined();
    expect(database.prepare("SELECT intent_id FROM workstream_notification_intents").all())
      .toEqual([{ intent_id: "00000000-0000-7000-8000-0000000000f2" }]);
  });

  it("holds a Terminal deadline the pass could not act on, and stalls one it found nothing for", () => {
    // The provider-backed half of the reconcile stays untested here; this is
    // the policy the alarm reads, which is what a false page would come from.
    expect(terminalReconcileOutcome("deferred")).toEqual({ waitMs: 60_000 });
    expect(terminalReconcileOutcome("stopped")).toEqual({ waitMs: 30_000 });
    expect(terminalReconcileOutcome("archived")).toEqual({ waitMs: 30_000 });
    expect(terminalReconcileOutcome("expired")).toEqual({ waitMs: 30_000 });
    expect(terminalReconcileOutcome("none")).toBeUndefined();
  });
});
