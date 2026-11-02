/**
 * WorkspaceDO migration 100 lists every thread that exists when it ships for
 * the description-summary backfill. An archived thread is left alone: nobody
 * reads its description in a Channel's feed.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { deferThreadBackfill, threadBackfillWork } from "../src/durable-objects/thread-backfill";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
import { createTestSqlStorage } from "./helpers/sql-storage";

const THREAD_BACKFILL_MIGRATION_VERSION = 100;
const OPEN_THREAD = "00000000-0000-7000-8000-0000000000f1";
const ARCHIVED_THREAD = "00000000-0000-7000-8000-0000000000f2";

const openDatabases: DatabaseSync[] = [];

function openDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  openDatabases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

function apply(database: DatabaseSync, through: number, after = 0): void {
  for (const migration of WORKSPACE_DO_SCHEMA_MIGRATIONS) {
    if (migration.version <= after) continue;
    if (migration.version > through) break;
    for (const statement of migration.statements) database.exec(statement);
  }
}

function insertThread(database: DatabaseSync, workstreamId: string, archivedAt: number | null): void {
  database.prepare(
    `INSERT INTO channels (
       workstream_id, authority_generation, waterline, source_event_id, payload_hash,
       title, description, preview, scope, exact_state, system_kind, last_activity_at,
       completed_at, archived_at, email_address, origin_type, origin_label,
       created_by_user_id, automation_subscription_id, automation_run_id, planned_for,
       title_status, latest_attention_ordinal, unread_tracking_start_ordinal,
       next_wakeup_due_at, next_wakeup_prompt, next_terminal_action_at,
       source_created_at, source_updated_at, projected_at)
     VALUES (?, 1, 1, ?, 'hash', 'Thread', '', '', 'workspace', 'idle', NULL, 1,
             NULL, ?, NULL, 'ad_hoc', NULL, NULL, NULL, NULL, NULL,
             'settled', 0, 0, NULL, NULL, NULL, 1, 1, 1)`,
  ).run(workstreamId, `event-${workstreamId}`, archivedAt);
}

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe("WorkspaceDO migration 100", () => {
  it("lists every open thread for the description summary and leaves an archived one", () => {
    const database = openDatabase();
    apply(database, THREAD_BACKFILL_MIGRATION_VERSION - 1);
    insertThread(database, OPEN_THREAD, null);
    insertThread(database, ARCHIVED_THREAD, 5);

    apply(database, THREAD_BACKFILL_MIGRATION_VERSION, THREAD_BACKFILL_MIGRATION_VERSION - 1);

    expect(database.prepare(
      "SELECT job, workstream_id, attempts, not_before, in_flight FROM thread_backfill ORDER BY workstream_id",
    ).all()).toEqual([{ job: "description_summary", workstream_id: OPEN_THREAD, attempts: 0, not_before: 0, in_flight: 0 }]);
  });
});

describe("WorkspaceDO migration 133", () => {
  it("keeps a claimed row's claim through the upgrade, then bounds and resumes its pass", () => {
    const resume = 133;
    const parent = "00000000-0000-7000-8000-0000000000f3";
    const older = "00000000-0000-7000-8000-0000000000f4";
    const newer = "00000000-0000-7000-8000-0000000000f5";
    const database = openDatabase();
    apply(database, resume - 1);
    // A row stuck mid-backfill, as production holds one: claimed, deep in its retries.
    database.prepare(`INSERT INTO thread_backfill(job, workstream_id, attempts, not_before, in_flight)
      VALUES ('conversation_view', ?, 412, 9000, 1)`).run(parent);
    for (const [substreamId, kind, createdAt] of [["0", "main", 100], [older, "child", 200], [newer, "child", 5000]] as const) {
      database.prepare(`INSERT INTO parent_children(parent_id, substream_id, kind, created_at)
        VALUES (?, ?, ?, ?)`).run(parent, substreamId, kind, createdAt);
    }

    apply(database, resume, resume - 1);

    expect(database.prepare(
      "SELECT attempts, not_before, in_flight, resume_from, admitted_before FROM thread_backfill WHERE workstream_id = ?",
    ).all(parent)).toEqual([{ attempts: 412, not_before: 9000, in_flight: 1, resume_from: null, admitted_before: null }]);

    const sql = createTestSqlStorage(database);
    const row = { job: "conversation_view" as const, workstreamId: parent };
    // Its first pass after the upgrade admits what was registered by then, and no later child.
    expect(threadBackfillWork(sql, row, 1000)).toEqual({ substreamIds: ["0", older] });
    expect(deferThreadBackfill(sql, row.job, parent, 412, older)).toBe(true);
    expect(threadBackfillWork(sql, row, 6000)).toEqual({ substreamIds: [older] });
  });
});
