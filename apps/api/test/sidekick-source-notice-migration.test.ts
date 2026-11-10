/**
 * WorkspaceDO migration 145 rebuilds `workstream_notification_intents` and
 * `workspace_activity_items` once each, so their CHECKs admit the three
 * notices a Sidekick source request writes. A rebuild that drops a row, a
 * lease, a delivery time, an index or an identity-fence trigger would lose a
 * mention's delivery, re-send a reply notice, empty a person's Activity, or
 * let another Organization's row in.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const VERSION = 145;
const WORKSPACE_ID = "00000000-0000-7000-8000-00000000c145";
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

describe("WorkspaceDO migration 145, a source request's notices", () => {
  it("keeps every intent and Activity row with its indexes and identity fence, and admits the three source kinds in both", () => {
    const database = openDatabase();
    apply(database, VERSION - 1);
    database.prepare(`INSERT INTO workspace_identity (id, workspace_id, region, placement_affinity, created_at, updated_at)
      VALUES (1, ?, 'global', 'wnam', 0, 0)`).run(WORKSPACE_ID);
    insertIntent(database, { intentId: "mention-delivered", kind: "mention", state: "delivered", deliveredAt: "2026-11-09T00:01:00.000Z" });
    insertIntent(database, { intentId: "denied-leased", kind: "access_denied", state: "processing",
      leaseId: "lease-one", leaseExpiresAt: "2026-11-09T00:05:00.000Z" });
    insertItem(database, "item-mention", "mention", null);
    insertItem(database, "item-denied", "access_denied", "request-one");
    for (const kind of ["source_request", "source_approved", "source_declined"]) {
      expect(() => insertIntent(database, { intentId: `early-${kind}`, kind, state: "delivered" })).toThrow(/CHECK constraint failed/u);
      expect(() => insertItem(database, `early-${kind}`, kind, "request-two")).toThrow(/CHECK constraint failed/u);
    }

    apply(database, VERSION, VERSION - 1);

    expect(database.prepare(`SELECT intent_id, notification_kind, state, attempts, lease_id, lease_expires_at, delivered_at
      FROM workstream_notification_intents ORDER BY intent_id`).all()).toEqual([
      { intent_id: "denied-leased", notification_kind: "access_denied", state: "processing", attempts: 1,
        lease_id: "lease-one", lease_expires_at: "2026-11-09T00:05:00.000Z", delivered_at: null },
      { intent_id: "mention-delivered", notification_kind: "mention", state: "delivered", attempts: 1, lease_id: null,
        lease_expires_at: null, delivered_at: "2026-11-09T00:01:00.000Z" },
    ]);
    expect(database.prepare(`SELECT item_id, kind, parent_id, message_id, message_sequence, actor_id, preview, attention_ordinal,
      created_at, subject_id FROM workspace_activity_items ORDER BY item_id`).all()).toEqual([
      { item_id: "item-denied", kind: "access_denied", parent_id: "canvas-one", message_id: "turn-one", message_sequence: 4,
        actor_id: "user-two", preview: "Look", attention_ordinal: 3, created_at: 1700, subject_id: "request-one" },
      { item_id: "item-mention", kind: "mention", parent_id: "canvas-one", message_id: "turn-one", message_sequence: 4,
        actor_id: "user-two", preview: "Look", attention_ordinal: 3, created_at: 1700, subject_id: null },
    ]);
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
    for (const kind of ["source_request", "source_approved", "source_declined"]) {
      insertIntent(database, { intentId: `new-${kind}`, kind, state: "delivered" });
      insertItem(database, `new-${kind}`, kind, "request-two");
    }
    expect(() => insertIntent(database, { intentId: "retired", kind: "thread_started", state: "delivered" })).toThrow(/CHECK constraint failed/u);
    expect(() => insertItem(database, "retired", "thread_started", null)).toThrow(/CHECK constraint failed/u);
    expect(() => insertIntent(database, { intentId: "other", kind: "source_request", state: "delivered", workspaceId: "another-workspace" }))
      .toThrow(/workspace_identity_mismatch/u);
    expect(() => database.exec(`UPDATE workstream_notification_intents SET workspace_id = 'another-workspace'
      WHERE intent_id = 'mention-delivered'`)).toThrow(/workspace_identity_mismatch/u);
    // The asked person's name, taken when they answer.
    database.exec(`INSERT INTO sidekick_source_requests (request_id, sidekick_id, user_id, connector_type, event_types_json, state,
      requested_by_user_id, requested_by_name, created_at, decided_at, person_name)
      VALUES ('request-two', 'sidekick-one', 'user-one', 'google', '["email.received"]', 'approved', 'user-two', 'Avery', 1, 2, 'Robin')`);
    expect(database.prepare(`SELECT person_name FROM sidekick_source_requests`).all()).toEqual([{ person_name: "Robin" }]);
  });
});
