/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * WorkspaceDO migration 50 replaces `memory_scopes` to rename the stored
 * `automation` kind to `sidekick`, and eight tables cascade from it, three of
 * them through `memory_tables` and `memory_table_rows` rather than directly.
 *
 * This has to run on real workerd rather than on `node:sqlite`. The failure it
 * guards is a `DROP TABLE` firing `ON DELETE CASCADE` for real, and the reason
 * it fires is a runtime property: `PRAGMA foreign_keys = OFF` is silently a
 * no-op once anything in the same Durable Object event has touched SQLite.
 * `durable-object-sqlite.md` states the rule this test exists for — a rebuild of
 * a referenced parent needs a populated upgrade test, because a fresh-schema
 * test passes either way.
 *
 * Every table in the cascade closure is seeded, the FTS shadow tables are
 * checked through a match rather than a count, and the triggers the domain
 * schema attached to the table — immutability and the workspace identity
 * fences — are proved to still fire.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const SCOPE_KIND_MIGRATION = 50;
const COMPONENT = "workspace_do";

const WORKSPACE_ID = "00000000-0000-7000-8000-0000000009c0";
const AUTOMATION_ID = "00000000-0000-7000-8000-0000000009c1";
const USER_ID = "00000000-0000-7000-8000-0000000009c2";
const SIDEKICK_SCOPE_ID = "scope-sidekick";
const USER_SCOPE_ID = "scope-user";
const WORKSPACE_SCOPE_ID = "scope-workspace";
const ITEM_ID = "item-1";
const TABLE_ID = "table-1";
const COLUMN_ID = "table-1:column:0";
const ROW_ID = "row-1";
const AT = "2026-09-01T00:00:00.000Z";

describe("the WorkspaceDO memory scope kind migration on workerd", () => {
  it("given an object on the previous schema with an automation scope and every dependent populated, when 50 applies, then the scope reads sidekick and nothing is lost", async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName("workspace-memory-scope-kind-v49");
    await stub.ping();

    await runInDurableObject(stub, (_instance, state) => {
      const before = WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((m) => m.version < SCOPE_KIND_MIGRATION);
      expect(before.at(-1)?.version).toBe(SCOPE_KIND_MIGRATION - 1);
      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: before,
        component: COMPONENT,
        workerVersionId: "worker-before-scope-kind",
        now: 1_000,
      });

      const sql = state.storage.sql;
      // The object's identity, which every fenced table checks its rows against.
      sql.exec("INSERT INTO workspace_identity VALUES (1, ?, 'global', 'wnam', 0, 0)", WORKSPACE_ID);
      const insertScope = `INSERT INTO memory_scopes (memory_scope_id, workspace_id, kind, owner_id, created_at)
                           VALUES (?, ?, ?, ?, ?)`;
      // The kind the previous schema stored for a Sidekick, beside two kinds
      // the migration must leave exactly as they are.
      sql.exec(insertScope, SIDEKICK_SCOPE_ID, WORKSPACE_ID, "automation", AUTOMATION_ID, AT);
      sql.exec(insertScope, USER_SCOPE_ID, WORKSPACE_ID, "user", USER_ID, AT);
      sql.exec(insertScope, WORKSPACE_SCOPE_ID, WORKSPACE_ID, "workspace", WORKSPACE_ID, AT);

      sql.exec(
        `INSERT INTO memory_items
           (memory_item_id, memory_scope_id, workspace_id, text, revision, provenance_json,
            last_mutation_id, created_at, updated_at)
         VALUES (?, ?, ?, 'Use the crimson summary template', 1, '{}', 'mutation-1', ?, ?)`,
        ITEM_ID, SIDEKICK_SCOPE_ID, WORKSPACE_ID, AT, AT,
      );
      sql.exec(
        `INSERT INTO memory_mutations
           (memory_mutation_id, receipt_id, memory_item_id, memory_scope_id, workspace_id, operation,
            prior_revision, resulting_revision, actor_principal_json, harness_run_id, workstream_id,
            rationale, input_hash, mutation_json, result_json, created_at)
         VALUES ('mutation-1', 'receipt-1', ?, ?, ?, 'add', NULL, 1, '{}', 'run-1', ?,
                 'Future runs need this', 'hash-1', '{}', '{}', ?)`,
        ITEM_ID, SIDEKICK_SCOPE_ID, WORKSPACE_ID, AUTOMATION_ID, AT,
      );
      sql.exec(
        `INSERT INTO memory_index_outbox
           (outbox_id, memory_item_id, memory_scope_id, workspace_id, revision, operation, status,
            attempt_count, available_at, created_at, updated_at)
         VALUES ('outbox-1', ?, ?, ?, 1, 'upsert', 'pending', 0, ?, ?, ?)`,
        ITEM_ID, SIDEKICK_SCOPE_ID, WORKSPACE_ID, AT, AT, AT,
      );
      sql.exec(
        `INSERT INTO memory_tables
           (memory_table_id, memory_scope_id, workspace_id, name, description, usage_instructions,
            key_column_ids_json, schema_revision, data_revision, provenance_json, created_at, updated_at)
         VALUES (?, ?, ?, 'Seen entries', 'One row per discovered entry', 'Insert by canonical URL',
                 ?, 1, 1, '{}', ?, ?)`,
        TABLE_ID, SIDEKICK_SCOPE_ID, WORKSPACE_ID, JSON.stringify([COLUMN_ID]), AT, AT,
      );
      sql.exec(
        `INSERT INTO memory_table_columns
           (memory_table_column_id, memory_table_id, name, description, value_type, is_required,
            is_searchable, position, created_at)
         VALUES (?, ?, 'url', 'Canonical entry URL', 'url', 1, 1, 0, ?)`,
        COLUMN_ID, TABLE_ID, AT,
      );
      sql.exec(
        `INSERT INTO memory_table_rows
           (memory_table_row_id, memory_table_id, memory_scope_id, workspace_id, natural_key_hash,
            data_json, searchable_text, revision, provenance_json, created_by_mutation_id,
            last_mutation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'key-1', '{"url":"https://example.com/post"}', 'https://example.com/post',
                 1, '{}', 'table-mutation-1', 'table-mutation-1', ?, ?)`,
        ROW_ID, TABLE_ID, SIDEKICK_SCOPE_ID, WORKSPACE_ID, AT, AT,
      );
      sql.exec(
        `INSERT INTO memory_table_cells
           (memory_table_row_id, memory_table_id, memory_table_column_id, value_type, string_value)
         VALUES (?, ?, ?, 'url', 'https://example.com/post')`,
        ROW_ID, TABLE_ID, COLUMN_ID,
      );
      sql.exec(
        `INSERT INTO memory_table_mutations
           (memory_table_mutation_id, receipt_id, memory_table_id, memory_scope_id, workspace_id,
            operation, actor_principal_json, harness_run_id, workstream_id, rationale, input_hash,
            mutation_json, result_json, created_at)
         VALUES ('table-mutation-1', 'receipt-2', ?, ?, ?, 'insert_rows', '{}', 'run-1', ?,
                 'Discovered an entry', 'hash-2', '{}', '{}', ?)`,
        TABLE_ID, SIDEKICK_SCOPE_ID, WORKSPACE_ID, AUTOMATION_ID, AT,
      );

      // Up to the last migration that still has an item store to look at:
      // 116 imports the items as facts and drops the tables this test reads.
      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 115),
        component: COMPONENT,
        workerVersionId: "worker-with-scope-kind",
        now: 2_000,
      });

      const count = (table: string): number => sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;

      // The Sidekick's scope now reads `sidekick`, under the same id and owner;
      // the other kinds came through untouched.
      expect(sql.exec<{ memory_scope_id: string; kind: string; owner_id: string }>(
        `SELECT memory_scope_id, kind, owner_id FROM memory_scopes ORDER BY memory_scope_id`,
      ).toArray()).toEqual([
        { memory_scope_id: SIDEKICK_SCOPE_ID, kind: "sidekick", owner_id: AUTOMATION_ID },
        { memory_scope_id: USER_SCOPE_ID, kind: "user", owner_id: USER_ID },
        { memory_scope_id: WORKSPACE_SCOPE_ID, kind: "workspace", owner_id: WORKSPACE_ID },
      ]);

      // Every table the cascade would have emptied, the three deepest included,
      // and each row still pointing at the renamed scope.
      for (const table of [
        "memory_items",
        "memory_mutations",
        "memory_index_outbox",
        "memory_tables",
        "memory_table_columns",
        "memory_table_rows",
        "memory_table_cells",
        "memory_table_mutations",
      ]) {
        expect(count(table), table).toBe(1);
      }
      expect(sql.exec<{ memory_scope_id: string }>(
        `SELECT memory_scope_id FROM memory_items WHERE memory_item_id = ?`, ITEM_ID,
      ).one().memory_scope_id).toBe(SIDEKICK_SCOPE_ID);

      // The FTS shadow tables were rebuilt by the restore's insert triggers, so
      // the text is still searchable rather than merely present.
      expect(sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM memory_items_fts WHERE memory_items_fts MATCH 'crimson'`,
      ).one().n).toBe(1);
      expect(sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM memory_table_rows_fts WHERE memory_table_rows_fts MATCH 'example'`,
      ).one().n).toBe(1);

      // No scratch table left behind; the old kind is refused and the new one
      // admitted.
      expect(sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE '%\\_v50\\_hold' ESCAPE '\\'`,
      ).one().n).toBe(0);
      expect(() => sql.exec(insertScope, "scope-legacy", WORKSPACE_ID, "automation", "other-automation", AT)).toThrow();
      expect(() => sql.exec(insertScope, "scope-other", WORKSPACE_ID, "sidekick", "other-automation", AT)).not.toThrow();

      // The row is still immutable, the identity fence still refuses another
      // workspace's row, and foreign keys still point at the replacement rather
      // than a dropped table.
      expect(() => sql.exec(
        `UPDATE memory_scopes SET owner_id = 'somebody-else' WHERE memory_scope_id = ?`, SIDEKICK_SCOPE_ID,
      )).toThrow(/memory_scope_immutable/u);
      expect(() => sql.exec(
        insertScope, "scope-foreign", "00000000-0000-7000-8000-00000000ffff", "user", USER_ID, AT,
      )).toThrow(/workspace_identity_mismatch/u);
      expect(() => sql.exec(
        `INSERT INTO memory_items
           (memory_item_id, memory_scope_id, workspace_id, text, revision, provenance_json,
            last_mutation_id, created_at, updated_at)
         VALUES ('item-orphan', 'scope-missing', ?, 'Nobody owns this', 1, '{}', 'mutation-x', ?, ?)`,
        WORKSPACE_ID, AT, AT,
      )).toThrow();
    });
  });
});
