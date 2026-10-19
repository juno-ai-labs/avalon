/**
 * WorkspaceDO migration 119 watches every conversation import already waiting:
 * a hidden child still `reserved` on a listed thread whose main conversation
 * never opened, due an hour after the child's reservation. An opened thread, an
 * archived one, and a Breakout still in preparation are left alone.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const IMPORT_RESERVATION_RECLAIM_MIGRATION_VERSION = 119;
const STRANDED = "00000000-0000-7000-8000-0000000001f1";
const OPENED = "00000000-0000-7000-8000-0000000001f2";
const ARCHIVED = "00000000-0000-7000-8000-0000000001f3";
const PREPARING_BREAKOUT = "00000000-0000-7000-8000-0000000001f4";
const IMPORTER = "00000000-0000-7000-8000-0000000001a1";

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

/** A listed thread with its Main and one child the importer reserved at `reservedAt`. */
function insertThread(database: DatabaseSync, workstreamId: string, input: {
  archivedAt?: number; opened?: boolean; preparing?: boolean; reservedAt: number;
}): void {
  database.prepare(
    `INSERT INTO channels (
       workstream_id, authority_generation, waterline, source_event_id, payload_hash,
       title, description, preview, scope, exact_state, system_kind, last_activity_at,
       completed_at, archived_at, email_address, origin_type, origin_label,
       created_by_user_id, automation_subscription_id, automation_run_id, planned_for,
       title_status, latest_attention_ordinal, unread_tracking_start_ordinal,
       next_wakeup_due_at, next_wakeup_prompt, next_terminal_action_at,
       source_created_at, source_updated_at, projected_at)
     VALUES (?, 1, 1, ?, 'hash', 'Thread', '', '', 'personal', 'idle', NULL, 1,
             NULL, ?, NULL, 'ad_hoc', NULL, ?, NULL, NULL, NULL,
             'settled', 0, 0, NULL, NULL, NULL, 1, 1, 1)`,
  ).run(workstreamId, `event-${workstreamId}`, input.archivedAt ?? null, IMPORTER);
  const child = `${workstreamId.slice(0, -3)}c0d`;
  database.prepare(
    `INSERT INTO parent_children (parent_id, substream_id, kind, created_by_user_id, created_at, status)
     VALUES (?, '0', 'main', ?, ?, 'ready'), (?, ?, 'child', ?, ?, 'reserved')`,
  ).run(workstreamId, IMPORTER, input.reservedAt - 1, workstreamId, child, IMPORTER, input.reservedAt);
  if (input.opened) {
    database.prepare(
      `INSERT INTO parent_child_receipts (parent_id, substream_id, message_id, payload_hash, received_at)
       VALUES (?, '0', 'm1', 'hash', 1)`,
    ).run(workstreamId);
  }
  if (input.preparing) {
    database.prepare(
      `INSERT INTO parent_breakout_preparations
         (parent_id, operation_id, substream_id, creator_user_id, request_json, status, created_at, updated_at)
       VALUES (?, 'op', ?, ?, '{}', 'preparing', 1, 1)`,
    ).run(workstreamId, child, IMPORTER);
  }
}

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe("WorkspaceDO migration 119", () => {
  it("watches a listed import reservation that never opened, due an hour after it was reserved", () => {
    const database = openDatabase();
    apply(database, IMPORT_RESERVATION_RECLAIM_MIGRATION_VERSION - 1);
    insertThread(database, STRANDED, { reservedAt: 1_000 });
    insertThread(database, OPENED, { reservedAt: 1_000, opened: true });
    insertThread(database, ARCHIVED, { reservedAt: 1_000, archivedAt: 5 });
    insertThread(database, PREPARING_BREAKOUT, { reservedAt: 1_000, preparing: true });

    apply(database, IMPORT_RESERVATION_RECLAIM_MIGRATION_VERSION, IMPORT_RESERVATION_RECLAIM_MIGRATION_VERSION - 1);

    expect(database.prepare(
      "SELECT parent_id, user_id, due_at, attempts FROM import_reservation_reclaim ORDER BY parent_id",
    ).all()).toEqual([{ parent_id: STRANDED, user_id: IMPORTER, due_at: 3_601_000, attempts: 0 }]);
  });
});
