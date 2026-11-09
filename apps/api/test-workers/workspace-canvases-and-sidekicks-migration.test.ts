/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * WorkspaceDO migrations 136 to 140, the Canvases and Sidekicks schema, on an
 * object populated at version 135, the last one main shipped.
 *
 * On real workerd because every Organization object takes these five in one
 * construction, and the claims are about workerd's SQLite: the in-place
 * `DROP COLUMN` on the STRICT `sidekick_runs` with its new triggers, and the
 * table copies (the sidebar waterlines, a Sidekick's conversation
 * attachments, the pins, the retirement graph, the memory digest holders and
 * the notification intents) keeping every row with foreign keys enforced. A
 * statement that failed would take every Organization offline at
 * construction; a copy that dropped a row would lose a run, a pin, a
 * retirement receipt, a memory holder or a pending delivery. The historical
 * schema and its upgrade commit in separate object events, as
 * `durable-object-sqlite.md` requires of an upgrade test.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const LAST_SHIPPED = 135;
const COMPONENT = "workspace_do";
const WORKSPACE = "00000000-0000-7000-8000-000000000135";

const columns = (sql: SqlStorage, table: string): string[] =>
  sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).toArray().map((row) => row.name);

describe("the WorkspaceDO Canvases and Sidekicks migrations on workerd", () => {
  it("given an object populated at v135, when 136 to 140 apply, then every copied row, run and trigger remains", async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName("workspace-canvases-and-sidekicks-v135");
    await stub.ping();

    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((m) => m.version <= LAST_SHIPPED),
        component: COMPONENT,
        workerVersionId: "worker-main",
        now: 1_000,
      });
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO workspace_identity (id, workspace_id, region, placement_affinity, created_at, updated_at)
        VALUES (1, ?, 'global', 'wnam', 1, 1)`, WORKSPACE);
      sql.exec(`INSERT INTO sidekick_runs
          (sidekick_id, run_id, occurrence_key, trigger_json, definition_revision, harness_run_id, state, seed_json, created_at, updated_at)
        VALUES ('sidekick-one', 'run-seeded', 'seed:v1:a', '{}', 1, 'harness-seeded', 'completed', '{"packVersion":"v1"}', 10, 10),
               ('sidekick-one', 'run-plain', 'manual:k', '{}', 1, 'harness-plain', 'pending', NULL, 20, 20)`);
      sql.exec(`UPDATE workspace_sidebar_list_state SET waterline = 41 WHERE list = 'automations'`);
      sql.exec(`INSERT INTO sidekick_conversation_attachments VALUES ('sidekick-one', 'workstream', 'thread-one', '0', 'user-one', 5)`);
      sql.exec(`INSERT INTO workspace_pins VALUES ('user-one', 'thread', 'thread-one', NULL, 0, 1, 2)`);
      sql.exec(`INSERT INTO workspace_retirement_graph VALUES ('automation', 'sidekick-one', 10, 20)`);
      // Main's 135: a conversation the retirement walk already closed.
      sql.exec(`INSERT INTO workspace_retirement_children VALUES ('sidekick-one', '0', 15)`);
      sql.exec(`INSERT INTO memory_digest_holders VALUES ('sidekick-conversation', 'automation', 'sidekick-one', '0', 7)`);
      sql.exec(`INSERT INTO memory_digest_holder_facts VALUES ('sidekick-conversation', 'user:one', 'fact-one')`);
      sql.exec(`INSERT INTO workstream_notification_intents
          (intent_id, workspace_id, workstream_id, recipient_user_id, source_message_id, source_generation, source_version,
           required_directory_version, notification_kind, payload_json, payload_hash, state, attempts, lease_id, lease_expires_at,
           created_at, updated_at)
        VALUES ('mention-leased', ?, 'thread-one', 'robin', 'message-one', 1, 1, 1, 'mention', '{}', 'hash', 'processing', 1,
          'lease-one', 'later', 'now', 'now')`, WORKSPACE);
      expect(columns(sql, "sidekick_runs")).toContain("seed_json");
    });

    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
        component: COMPONENT,
        workerVersionId: "worker-canvases-and-sidekicks",
        now: 2_000,
      });
      const sql = state.storage.sql;
      expect(sql.exec<{ version: number }>(
        "SELECT version FROM _sql_schema_migrations WHERE version > ? ORDER BY version", LAST_SHIPPED,
      ).toArray().map((row) => row.version)).toEqual([136, 137, 138, 139, 140]);

      expect(columns(sql, "sidekick_runs")).not.toContain("seed_json");
      expect(columns(sql, "sidekick_runs")).toEqual(expect.arrayContaining(["step_count", "requester_user_id"]));
      expect(sql.exec("SELECT run_id, state, harness_run_id, step_count FROM sidekick_runs ORDER BY created_at").toArray()).toEqual([
        { run_id: "run-seeded", state: "completed", harness_run_id: "harness-seeded", step_count: 0 },
        { run_id: "run-plain", state: "pending", harness_run_id: "harness-plain", step_count: 0 },
      ]);
      expect(sql.exec("SELECT name FROM sqlite_master WHERE tbl_name = 'sidekick_runs' AND type = 'trigger' ORDER BY name").toArray())
        .toEqual([{ name: "sidekick_runs_row_on_change" }, { name: "sidekick_runs_row_on_insert" }]);

      expect(sql.exec("SELECT list, waterline FROM workspace_sidebar_list_state ORDER BY list").toArray()).toEqual([
        { list: "activity", waterline: 0 }, { list: "automations", waterline: 41 },
        { list: "canvases", waterline: 0 },
      ]);
      expect(sql.exec("SELECT parent_kind, parent_id, attached_at FROM sidekick_conversation_attachments").toArray())
        .toEqual([{ parent_kind: "workstream", parent_id: "thread-one", attached_at: 5 }]);
      // Migration 139 deletes the retired pin kinds; the copy kept them until then.
      expect(sql.exec("SELECT COUNT(*) AS count FROM workspace_pins").one()).toEqual({ count: 0 });
      expect(sql.exec("SELECT parent_kind, parent_id, retired_at FROM workspace_retirement_graph").toArray())
        .toEqual([{ parent_kind: "automation", parent_id: "sidekick-one", retired_at: 20 }]);
      // Neither the graph copy nor the Thread-era drop touches the child receipts.
      expect(sql.exec("SELECT parent_id, substream_id, retired_at FROM workspace_retirement_children").toArray())
        .toEqual([{ parent_id: "sidekick-one", substream_id: "0", retired_at: 15 }]);
      expect(sql.exec("SELECT conversation, parent_kind FROM memory_digest_holders").toArray())
        .toEqual([{ conversation: "sidekick-conversation", parent_kind: "automation" }]);
      expect(sql.exec("SELECT fact_id FROM memory_digest_holder_facts").toArray()).toEqual([{ fact_id: "fact-one" }]);
      expect(sql.exec("SELECT intent_id, state, lease_id, lease_expires_at FROM workstream_notification_intents").toArray())
        .toEqual([{ intent_id: "mention-leased", state: "processing", lease_id: "lease-one", lease_expires_at: "later" }]);

      // Each copied table admits a Canvas, and the intents and Activity admit a declined request.
      sql.exec(`INSERT INTO workspace_pins VALUES ('user-one', 'canvas', 'canvas-one', NULL, 0, 3, 3)`);
      sql.exec(`INSERT INTO workspace_retirement_graph VALUES ('canvas', 'canvas-one', 30, NULL)`);
      sql.exec(`INSERT INTO memory_digest_holders VALUES ('canvas-conversation', 'canvas', 'canvas-one', '0', 8)`);
      sql.exec(`INSERT INTO workstream_notification_intents
          (intent_id, workspace_id, workstream_id, recipient_user_id, source_message_id, source_generation, source_version,
           required_directory_version, notification_kind, payload_json, payload_hash, state, attempts, created_at, updated_at)
        VALUES ('access_denied:r2', ?, 'canvas-one', 'robin', 'access_denied:r2', 1, 1, 1, 'access_denied', '{}', 'hash',
          'delivered', 0, 'now', 'now')`, WORKSPACE);
      sql.exec(`INSERT INTO workspace_activity_items
          (item_id, workspace_id, recipient_user_id, kind, parent_kind, parent_id, substream_id, actor_kind, actor_id, created_at, subject_id)
        VALUES ('access_denied:r2', ?, 'robin', 'access_denied', 'canvas', 'canvas-one', '0', 'person', 'ada', 6, 'r2')`, WORKSPACE);
      expect(() => sql.exec("UPDATE workstream_notification_intents SET workspace_id = 'another' WHERE intent_id = 'access_denied:r2'"))
        .toThrow(/workspace_identity_mismatch/u);
      expect(sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
    });
  });
});
