import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const workspace = "00000000-0000-7000-8000-000000000152";

/**
 * Migration 152 rebuilds the notification intents and the Activity rows to
 * admit `access_denied`. A populated v151 object keeps every row, the
 * Activity row's `subject_id` included, and its identity triggers.
 */
describe("access denied migration", () => {
  it("keeps populated v151 intents and Activity rows, and admits a declined request", async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName("access-denied-populated-v151");
    await stub.ping();
    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({ storage: state.storage,
        migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 151),
        component: "workspace_do", workerVersionId: "before-denials", now: 1 });
      const sql = state.storage.sql;
      sql.exec("INSERT INTO workspace_identity (id, workspace_id, region, placement_affinity, created_at, updated_at) VALUES (1, ?, 'global', 'wnam', 1, 1)", workspace);
      sql.exec(`INSERT INTO workstream_notification_intents
        (intent_id, workspace_id, workstream_id, recipient_user_id, source_message_id, source_generation, source_version,
         required_directory_version, notification_kind, payload_json, payload_hash, state, attempts, created_at, updated_at, delivered_at)
        VALUES ('access_granted:r1', ?, 'canvas', 'robin', 'access_granted:r1', 1, 1, 1, 'access_granted', '{}', 'hash', 'delivered', 0, 'now', 'now', 'now')`, workspace);
      sql.exec(`INSERT INTO workspace_activity_items
        (item_id, workspace_id, recipient_user_id, kind, parent_kind, parent_id, substream_id, actor_kind, actor_id, created_at, subject_id)
        VALUES ('access_granted:r1', ?, 'robin', 'access_granted', 'canvas', 'canvas', '0', 'person', 'avery', 5, 'r1')`, workspace);
    });
    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
        component: "workspace_do", workerVersionId: "with-denials", now: 2 });
      const sql = state.storage.sql;
      expect(sql.exec("SELECT intent_id, notification_kind, state, delivered_at FROM workstream_notification_intents").toArray())
        .toEqual([{ intent_id: "access_granted:r1", notification_kind: "access_granted", state: "delivered", delivered_at: "now" }]);
      expect(sql.exec("SELECT item_id, kind, created_at, subject_id FROM workspace_activity_items").toArray())
        .toEqual([{ item_id: "access_granted:r1", kind: "access_granted", created_at: 5, subject_id: "r1" }]);
      sql.exec(`INSERT INTO workstream_notification_intents
        (intent_id, workspace_id, workstream_id, recipient_user_id, source_message_id, source_generation, source_version,
         required_directory_version, notification_kind, payload_json, payload_hash, state, attempts, created_at, updated_at)
        VALUES ('access_denied:r2', ?, 'canvas', 'robin', 'access_denied:r2', 1, 1, 1, 'access_denied', '{}', 'hash', 'delivered', 0, 'now', 'now')`, workspace);
      sql.exec(`INSERT INTO workspace_activity_items
        (item_id, workspace_id, recipient_user_id, kind, parent_kind, parent_id, substream_id, actor_kind, actor_id, created_at, subject_id)
        VALUES ('access_denied:r2', ?, 'robin', 'access_denied', 'canvas', 'canvas', '0', 'person', 'ada', 6, 'r2')`, workspace);
      expect(() => sql.exec("UPDATE workstream_notification_intents SET workspace_id = 'another' WHERE intent_id = 'access_denied:r2'"))
        .toThrow(/workspace_identity_mismatch/u);
      expect(() => sql.exec(`INSERT INTO workspace_activity_items
        (item_id, workspace_id, recipient_user_id, kind, parent_kind, parent_id, actor_kind, created_at)
        VALUES ('x', ?, 'robin', 'thread_started', 'canvas', 'canvas', 'person', 7)`, workspace)).toThrow(/CHECK constraint/u);
      expect(sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
    });
  });
});
