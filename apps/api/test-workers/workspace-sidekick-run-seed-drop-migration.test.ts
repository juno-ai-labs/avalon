/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * WorkspaceDO migration 154 drops `sidekick_runs.seed_json`, the column the
 * removed demo seeder wrote a seeded run's script into.
 *
 * On real workerd because the claim is that workerd's SQLite accepts the
 * in-place `DROP COLUMN` on this STRICT table with its triggers, and keeps
 * every run: a drop that failed would take every Organization object offline
 * at construction, and one that rebuilt the table would risk the run history
 * and the triggers that keep each run's row in its Sidekick's shared
 * conversation. The historical schema and its upgrade commit in separate
 * object events, as `durable-object-sqlite.md` requires of an upgrade test.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const DROP_MIGRATION = 154;
const COMPONENT = "workspace_do";

const columns = (sql: SqlStorage): string[] =>
  sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('sidekick_runs') ORDER BY cid").toArray().map((row) => row.name);

describe("the WorkspaceDO seeded-run column drop on workerd", () => {
  it("given an object holding a seeded run, when 154 applies, then the column is gone and every run and trigger remains", async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName("workspace-sidekick-run-seed-drop");
    await stub.ping();

    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((m) => m.version < DROP_MIGRATION),
        component: COMPONENT,
        workerVersionId: "worker-before-seed-drop",
        now: 1_000,
      });
      state.storage.sql.exec(
        `INSERT INTO sidekick_runs
           (sidekick_id, run_id, occurrence_key, trigger_json, definition_revision, harness_run_id, state, seed_json, created_at, updated_at)
         VALUES ('sidekick-one', 'run-seeded', 'seed:v1:a', '{}', 1, 'harness-seeded', 'completed', '{"packVersion":"v1"}', 10, 10),
                ('sidekick-one', 'run-plain', 'manual:k', '{}', 1, 'harness-plain', 'pending', NULL, 20, 20)`,
      );
      expect(columns(state.storage.sql)).toContain("seed_json");
    });

    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
        component: COMPONENT,
        workerVersionId: "worker-with-seed-drop",
        now: 2_000,
      });
      const sql = state.storage.sql;
      expect(sql.exec<{ version: number }>(
        "SELECT version FROM _sql_schema_migrations WHERE version = ?", DROP_MIGRATION,
      ).toArray()).toEqual([{ version: DROP_MIGRATION }]);
      expect(columns(sql)).not.toContain("seed_json");
      expect(sql.exec("SELECT run_id, state, harness_run_id FROM sidekick_runs ORDER BY created_at").toArray()).toEqual([
        { run_id: "run-seeded", state: "completed", harness_run_id: "harness-seeded" },
        { run_id: "run-plain", state: "pending", harness_run_id: "harness-plain" },
      ]);
      expect(sql.exec("SELECT name FROM sqlite_master WHERE tbl_name = 'sidekick_runs' AND type = 'trigger' ORDER BY name").toArray())
        .toEqual([{ name: "sidekick_runs_row_on_change" }, { name: "sidekick_runs_row_on_insert" }]);
    });
  });
});
