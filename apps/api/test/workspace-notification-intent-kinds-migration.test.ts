/**
 * WorkspaceDO migration 138 rebuilds `workstream_notification_intents` once so
 * its CHECK admits the seven Canvas and Sidekick notices, and adds the index a
 * reply's cooldown seeks. A rebuild that drops a row, a lease, a delivery
 * time, an index or an identity-fence trigger would lose a mention's delivery,
 * re-send a reply notice, or let another Organization's row in.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const VERSION = 138;
const WORKSPACE_ID = "00000000-0000-7000-8000-00000000c137";
const openDatabases: DatabaseSync[] = [];

function openDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  openDatabases.push(database);
  return database;
}

function apply(database: DatabaseSync, through: number, after = 0): void {
  for (const migration of WORKSPACE_DO_SCHEMA_MIGRATIONS) {
    if (migration.version <= after) continue;
    if (migration.version > through) break;
    for (const statement of migration.statements) database.exec(statement);
  }
}

const insertIntent = (database: DatabaseSync, row: {
  intentId: string; kind: string; state: string; workspaceId?: string; leaseId?: string | null; leaseExpiresAt?: string | null;
  deliveredAt?: string | null;
}) => database.prepare(`INSERT INTO workstream_notification_intents
    (intent_id, workspace_id, workstream_id, recipient_user_id, source_message_id, source_generation, source_version,
     required_directory_version, notification_kind, payload_json, payload_hash, state, attempts, lease_id, lease_expires_at,
     last_error_code, created_at, updated_at, delivered_at)
  VALUES (?, ?, 'canvas-one', 'user-one', ?, 1, 1, 1, ?, '{"kind":"mention_notification"}', 'hash', ?, 1, ?, ?, NULL,
          '2026-11-07T00:00:00.000Z', '2026-11-07T00:00:00.000Z', ?)`)
  .run(row.intentId, row.workspaceId ?? WORKSPACE_ID, `source-${row.intentId}`, row.kind, row.state,
    row.leaseId ?? null, row.leaseExpiresAt ?? null, row.deliveredAt ?? null);

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe("WorkspaceDO migration 138", () => {
  it("keeps every intent, its lease and delivery, its indexes and its identity fence, and admits every new notice", () => {
    const database = openDatabase();
    apply(database, VERSION - 1);
    database.prepare(`INSERT INTO workspace_identity (id, workspace_id, region, placement_affinity, created_at, updated_at)
      VALUES (1, ?, 'global', 'wnam', 0, 0)`).run(WORKSPACE_ID);
    insertIntent(database, { intentId: "mention-delivered", kind: "mention", state: "delivered",
      deliveredAt: "2026-11-07T00:01:00.000Z" });
    insertIntent(database, { intentId: "mention-leased", kind: "participant_added", state: "processing",
      leaseId: "lease-one", leaseExpiresAt: "2026-11-07T00:05:00.000Z" });
    for (const kind of ["needs_input", "new_message", "access_denied"]) {
      expect(() => insertIntent(database, { intentId: `early-${kind}`, kind, state: "delivered" }))
        .toThrow(/CHECK constraint failed/u);
    }

    apply(database, VERSION, VERSION - 1);

    expect(database.prepare(`SELECT intent_id, notification_kind, state, attempts, lease_id, lease_expires_at, delivered_at
      FROM workstream_notification_intents ORDER BY intent_id`).all()).toEqual([
      { intent_id: "mention-delivered", notification_kind: "mention", state: "delivered", attempts: 1, lease_id: null,
        lease_expires_at: null, delivered_at: "2026-11-07T00:01:00.000Z" },
      { intent_id: "mention-leased", notification_kind: "participant_added", state: "processing", attempts: 1,
        lease_id: "lease-one", lease_expires_at: "2026-11-07T00:05:00.000Z", delivered_at: null },
    ]);
    expect(database.prepare(`SELECT name FROM sqlite_master WHERE tbl_name = 'workstream_notification_intents'
      AND type IN ('index', 'trigger') AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name`).all()).toEqual([
      { name: "workstream_notification_intents_delivery_idx" },
      { name: "workstream_notification_intents_recipient_kind_idx" },
      { name: "workstream_notification_intents_terminal_idx" },
      { name: "workstream_notification_intents_workspace_identity_insert" },
      { name: "workstream_notification_intents_workspace_identity_update" },
    ]);
    for (const kind of ["needs_input", "run_finished", "new_message", "artifact_updated", "access_request",
      "access_granted", "access_denied"]) {
      insertIntent(database, { intentId: `new-${kind}`, kind, state: "delivered" });
    }
    expect(() => insertIntent(database, { intentId: "retired", kind: "thread_started", state: "delivered" }))
      .toThrow(/CHECK constraint failed/u);
    expect(() => insertIntent(database, { intentId: "other", kind: "mention", state: "pending", workspaceId: "another-workspace" }))
      .toThrow(/workspace_identity_mismatch/u);
    expect(() => database.exec(`UPDATE workstream_notification_intents SET workspace_id = 'another-workspace'
      WHERE intent_id = 'mention-delivered'`)).toThrow(/workspace_identity_mismatch/u);
  });
});
