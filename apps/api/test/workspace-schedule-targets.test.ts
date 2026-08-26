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

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
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

const WORKSPACE_ID = "00000000-0000-7000-8000-0000000000a1";
const WORKSTREAM_ID = "00000000-0000-7000-8000-0000000000a2";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

/** The object's ledger, every version, as the constructor applies it. */
function workspaceObjectDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of WORKSPACE_DO_SCHEMA_MIGRATIONS) {
    for (const statement of migration.statements) database.exec(statement);
  }
  // Every write to the object asserts its identity first; the ledger's
  // triggers refuse a row for any other workspace.
  database.prepare(
    `INSERT INTO workspace_identity
       (id, workspace_id, region, placement_affinity, created_at, updated_at)
     VALUES (1, ?, 'global', 'wnam', 0, 0)`,
  ).run(WORKSPACE_ID);
  return database;
}

function scheduleContext(database: DatabaseSync): WorkspaceScheduleContext {
  const env = createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    PAYLOADS: createCloudflareTestBinding<R2Bucket>({ delete: async () => undefined }),
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
      plannedAutomationWorkstream: async () => null,
    },
    notificationIntents: {
      notificationIntentMaintenanceTarget: async (input) =>
        workspaceNotificationIntentMaintenanceTarget(storage, input.workspaceId),
      reapSettledWorkstreamNotificationIntents: async (input) =>
        reapSettledWorkspaceNotificationIntents(storage, input, Date.now()),
    },
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
    `INSERT OR IGNORE INTO workspace_workstream_directory
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

function seedSlackConnection(database: DatabaseSync, id: string, status: "healthy" | "disabled"): void {
  database.prepare(
    `INSERT INTO connector_connections
       (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
        status, created_at, updated_at, model_plugin_id)
     VALUES (?, ?, 'slack', 'workspace', NULL, ?, 'Slack', ?, '2026-01-01', '2026-01-01', 'plugin_slack_workspace')`,
  ).run(id, WORKSPACE_ID, `T-${id}`, status);
}

function seedUnfurledLink(database: DatabaseSync, connectionId: string, refreshedAt: string): void {
  database.prepare(
    `INSERT INTO slack_unfurled_links
       (connection_id, slack_channel_id, slack_message_ts, url, workspace_id, workstream_id,
        rendered_status, rendered_anonymous, audience_checked_at, shared_at, refreshed_at, rendered_hash)
     VALUES (?, 'C1', ?, 'https://with-avalon.com/app/workstreams/x', ?, ?, 'running', 0, ?, ?, ?, NULL)`,
  ).run(connectionId, `${refreshedAt}-${connectionId}`, WORKSPACE_ID, WORKSTREAM_ID, refreshedAt, new Date().toISOString(), refreshedAt);
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

describe("the Slack unfurl sweep's due time", () => {
  it("counts only links the sweep will load, so a disabled connection cannot pin the pass", async () => {
    // The sweep loads a link through a connection that is not disabled. A link
    // on a disabled connection is never loaded, never advanced, and never
    // deleted; counted here, it would hold the whole workspace's sweep behind
    // the stall gate for the thirty days it stays in the window.
    const database = workspaceObjectDatabase();
    seedSlackConnection(database, "00000000-0000-7000-8000-0000000000c1", "disabled");
    seedSlackConnection(database, "00000000-0000-7000-8000-0000000000c2", "healthy");
    seedUnfurledLink(database, "00000000-0000-7000-8000-0000000000c1", "2026-01-01T00:00:00.000Z");

    expect(maintenance(await workspaceScheduleTargets(scheduleContext(database)), "slack_unfurls")).toEqual([]);

    seedUnfurledLink(database, "00000000-0000-7000-8000-0000000000c2", "2026-02-01T00:00:00.000Z");

    expect(maintenance(await workspaceScheduleTargets(scheduleContext(database)), "slack_unfurls"))
      .toEqual([{ kind: "maintenance", id: "slack_unfurls", dueAt: "2026-02-01T00:05:01Z" }]);
  });
});

describe("what a maintenance pass tells the stall check", () => {
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
