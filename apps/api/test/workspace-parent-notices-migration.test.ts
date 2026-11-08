/**
 * WorkspaceDO migration 150 rebuilds `workstream_notification_intents` and
 * `workspace_activity_items` so their CHECKs admit a reply, a pinned Canvas's
 * new version, an access request and its grant. A rebuild that drops a row,
 * a lease, an index or an identity-fence trigger would lose a delivery, a
 * person's feed, or let another Organization's row in.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const VERSION = 150;
const WORKSPACE_ID = "00000000-0000-7000-8000-00000000c150";
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

const insertIntent = (database: DatabaseSync, row: { intentId: string; kind: string; state: string; workspaceId?: string;
  leaseId?: string | null; deliveredAt?: string | null }) => database.prepare(`INSERT INTO workstream_notification_intents
    (intent_id, workspace_id, workstream_id, recipient_user_id, source_message_id, source_generation, source_version,
     required_directory_version, notification_kind, payload_json, payload_hash, state, attempts, lease_id, lease_expires_at,
     last_error_code, created_at, updated_at, delivered_at)
  VALUES (?, ?, 'canvas-one', 'user-one', ?, 1, 1, 1, ?, '{"kind":"mention_notification"}', 'hash', ?, 2, ?, NULL, NULL,
          '2026-11-07T00:00:00.000Z', '2026-11-07T00:00:00.000Z', ?)`)
  .run(row.intentId, row.workspaceId ?? WORKSPACE_ID, `source-${row.intentId}`, row.kind, row.state, row.leaseId ?? null, row.deliveredAt ?? null);

const insertItem = (database: DatabaseSync, itemId: string, kind: string) => database.prepare(`INSERT INTO workspace_activity_items
    (item_id, workspace_id, recipient_user_id, kind, parent_kind, parent_id, substream_id, message_id, message_sequence, run_id,
     actor_kind, actor_id, preview, attention_ordinal, created_at)
  VALUES (?, ?, 'user-one', ?, 'canvas', 'canvas-one', '0', 'turn-one', 4, NULL, 'person', 'user-two', 'Look', 3, 1700)`)
  .run(itemId, WORKSPACE_ID, kind);

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe("WorkspaceDO migration 150", () => {
  it("keeps every intent and Activity row, their indexes and the identity fence, and admits the four new kinds", () => {
    const database = openDatabase();
    apply(database, VERSION - 1);
    database.prepare(`INSERT INTO workspace_identity (id, workspace_id, region, placement_affinity, created_at, updated_at)
      VALUES (1, ?, 'global', 'wnam', 0, 0)`).run(WORKSPACE_ID);
    insertIntent(database, { intentId: "mention-leased", kind: "mention", state: "processing", leaseId: "lease-one" });
    insertIntent(database, { intentId: "run-done", kind: "run_finished", state: "delivered", deliveredAt: "2026-11-07T00:01:00.000Z" });
    insertItem(database, "mention-leased", "mention");
    expect(() => insertIntent(database, { intentId: "early", kind: "new_message", state: "delivered" })).toThrow(/CHECK constraint failed/u);
    expect(() => insertItem(database, "early", "new_message")).toThrow(/CHECK constraint failed/u);

    apply(database, VERSION, VERSION - 1);

    expect(database.prepare(`SELECT intent_id, notification_kind, state, attempts, lease_id, delivered_at
      FROM workstream_notification_intents ORDER BY intent_id`).all()).toEqual([
      { intent_id: "mention-leased", notification_kind: "mention", state: "processing", attempts: 2, lease_id: "lease-one", delivered_at: null },
      { intent_id: "run-done", notification_kind: "run_finished", state: "delivered", attempts: 2, lease_id: null,
        delivered_at: "2026-11-07T00:01:00.000Z" },
    ]);
    expect(database.prepare(`SELECT item_id, kind, message_id, message_sequence, actor_id, preview, attention_ordinal, created_at, subject_id
      FROM workspace_activity_items`).all()).toEqual([{
      item_id: "mention-leased", kind: "mention", message_id: "turn-one", message_sequence: 4, actor_id: "user-two", preview: "Look",
      attention_ordinal: 3, created_at: 1700, subject_id: null,
    }]);
    expect(database.prepare(`SELECT name FROM sqlite_master WHERE tbl_name IN ('workstream_notification_intents', 'workspace_activity_items')
      AND type IN ('index', 'trigger') AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name`).all()).toEqual([
      { name: "workspace_activity_items_parent_idx" },
      { name: "workspace_activity_items_recipient_idx" },
      { name: "workstream_notification_intents_delivery_idx" },
      { name: "workstream_notification_intents_recipient_kind_idx" },
      { name: "workstream_notification_intents_terminal_idx" },
      { name: "workstream_notification_intents_workspace_identity_insert" },
      { name: "workstream_notification_intents_workspace_identity_update" },
    ]);
    for (const kind of ["new_message", "artifact_updated", "access_request", "access_granted"]) {
      insertIntent(database, { intentId: `new-${kind}`, kind, state: "delivered" });
      insertItem(database, `new-${kind}`, kind);
    }
    expect(() => insertIntent(database, { intentId: "other", kind: "mention", state: "pending", workspaceId: "another-workspace" }))
      .toThrow(/workspace_identity_mismatch/u);
  });
});
