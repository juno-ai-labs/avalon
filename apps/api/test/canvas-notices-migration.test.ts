/**
 * WorkspaceDO migration 150 rebuilds `workstream_notification_intents` and
 * `workspace_activity_items` again so their CHECKs admit a Canvas notice
 * (`canvas_notice`), and adds the two tables a Canvas's notices keep. A
 * rebuild that drops a row, a lease, a delivery time, an index or an
 * identity-fence trigger would lose a mention's delivery, re-send a notice,
 * empty a person's Activity, or let another Organization's row in.
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

const insertIntent = (database: DatabaseSync, row: {
  intentId: string; kind: string; state: string; workspaceId?: string; leaseId?: string | null; leaseExpiresAt?: string | null;
  deliveredAt?: string | null;
}) => database.prepare(`INSERT INTO workstream_notification_intents
    (intent_id, workspace_id, workstream_id, recipient_user_id, source_message_id, source_generation, source_version,
     required_directory_version, notification_kind, payload_json, payload_hash, state, attempts, lease_id, lease_expires_at,
     last_error_code, created_at, updated_at, delivered_at)
  VALUES (?, ?, 'canvas-one', 'user-one', ?, 1, 1, 1, ?, '{"kind":"mention_notification"}', 'hash', ?, 1, ?, ?, NULL,
          '2026-11-09T00:00:00.000Z', '2026-11-09T00:00:00.000Z', ?)`)
  .run(row.intentId, row.workspaceId ?? WORKSPACE_ID, `source-${row.intentId}`, row.kind, row.state,
    row.leaseId ?? null, row.leaseExpiresAt ?? null, row.deliveredAt ?? null);

const insertItem = (database: DatabaseSync, itemId: string, kind: string, subjectId: string | null) => database.prepare(
  `INSERT INTO workspace_activity_items
    (item_id, workspace_id, recipient_user_id, kind, parent_kind, parent_id, substream_id, message_id, message_sequence, run_id,
     actor_kind, actor_id, preview, attention_ordinal, created_at, subject_id)
  VALUES (?, ?, 'user-one', ?, 'canvas', 'canvas-one', '0', 'turn-one', 4, NULL, 'person', 'user-two', 'Look', 3, 1700, ?)`,
).run(itemId, WORKSPACE_ID, kind, subjectId);

/** Every index and trigger on a table, and every other schema object whose SQL names it. */
function dependents(database: DatabaseSync, table: string) {
  return {
    own: database.prepare(`SELECT name FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger')
      AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name`).all(table),
    elsewhere: database.prepare(`SELECT name FROM sqlite_master WHERE tbl_name <> ? AND sql LIKE '%' || ? || '%' ORDER BY name`).all(table, table),
  };
}

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe("WorkspaceDO migration 150, a Canvas's notices", () => {
  it("keeps every intent and Activity row with its indexes and identity fence, and admits the Canvas notice kind in both", () => {
    const database = openDatabase();
    apply(database, VERSION - 1);
    database.prepare(`INSERT INTO workspace_identity (id, workspace_id, region, placement_affinity, created_at, updated_at)
      VALUES (1, ?, 'global', 'wnam', 0, 0)`).run(WORKSPACE_ID);
    insertIntent(database, { intentId: "source-delivered", kind: "source_request", state: "delivered", deliveredAt: "2026-11-09T00:01:00.000Z" });
    insertIntent(database, { intentId: "mention-leased", kind: "mention", state: "processing",
      leaseId: "lease-one", leaseExpiresAt: "2026-11-09T00:05:00.000Z" });
    insertItem(database, "item-source", "source_request", "request-one");
    expect(() => insertIntent(database, { intentId: "early", kind: "canvas_notice", state: "delivered" })).toThrow(/CHECK constraint failed/u);
    expect(() => insertItem(database, "early", "canvas_notice", null)).toThrow(/CHECK constraint failed/u);

    apply(database, VERSION, VERSION - 1);

    expect(database.prepare(`SELECT intent_id, notification_kind, state, attempts, lease_id, lease_expires_at, delivered_at
      FROM workstream_notification_intents ORDER BY intent_id`).all()).toEqual([
      { intent_id: "mention-leased", notification_kind: "mention", state: "processing", attempts: 1,
        lease_id: "lease-one", lease_expires_at: "2026-11-09T00:05:00.000Z", delivered_at: null },
      { intent_id: "source-delivered", notification_kind: "source_request", state: "delivered", attempts: 1, lease_id: null,
        lease_expires_at: null, delivered_at: "2026-11-09T00:01:00.000Z" },
    ]);
    expect(database.prepare(`SELECT item_id, kind, subject_id FROM workspace_activity_items`).all())
      .toEqual([{ item_id: "item-source", kind: "source_request", subject_id: "request-one" }]);
    expect(dependents(database, "workstream_notification_intents")).toEqual({
      own: [
        { name: "workstream_notification_intents_delivery_idx" },
        { name: "workstream_notification_intents_recipient_kind_idx" },
        { name: "workstream_notification_intents_terminal_idx" },
        { name: "workstream_notification_intents_workspace_identity_insert" },
        { name: "workstream_notification_intents_workspace_identity_update" },
      ],
      elsewhere: [],
    });
    expect(dependents(database, "workspace_activity_items")).toEqual({
      own: [{ name: "workspace_activity_items_parent_idx" }, { name: "workspace_activity_items_recipient_idx" }],
      elsewhere: [],
    });
    insertIntent(database, { intentId: "notice", kind: "canvas_notice", state: "delivered" });
    insertItem(database, "notice", "canvas_notice", null);
    // The kind is no longer a list the table holds: the contracts' enum guards it, so the next kind costs no rebuild.
    insertIntent(database, { intentId: "later", kind: "a_later_kind", state: "delivered" });
    expect(() => insertIntent(database, { intentId: "blank", kind: "", state: "delivered" })).toThrow(/CHECK constraint failed/u);
    expect(() => insertIntent(database, { intentId: "other", kind: "canvas_notice", state: "delivered", workspaceId: "another-workspace" }))
      .toThrow(/workspace_identity_mismatch/u);
    // A Canvas's registration and one person's choice for it.
    database.exec(`INSERT INTO canvas_notice_registrations (canvas_id, purpose, registered_by_kind, registered_by_id, registered_by_name,
      revision, record_message_id, registered_at, updated_at)
      VALUES ('canvas-one', 'New episodes', 'sidekick', 'sidekick-one', 'Podcaster', 2, NULL, 1, 1)`);
    database.exec(`INSERT INTO canvas_notice_operations (operation_id, canvas_id, revision) VALUES ('op-one', 'canvas-one', 2)`);
    database.exec(`INSERT INTO canvas_notification_choices (canvas_id, user_id, channels_json, updated_at) VALUES ('canvas-one', 'user-one', '[]', 1)`);
    expect(() => database.exec(`INSERT INTO canvas_notification_choices (canvas_id, user_id, channels_json, updated_at)
      VALUES ('canvas-one', 'user-two', '{"push":true}', 1)`)).toThrow(/CHECK constraint failed/u);
  });
});
