/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";

import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

it("upgrades a populated v68 breakout directory without losing its row and constrains appearance JSON", async () => {
  const stub = env.MIGRATION_PROBE_DO!.getByName("workspace-breakout-appearance-v68");
  await stub.ping();

  // Commit the old schema and row in a separate object event, as in an upgrade.
  await runInDurableObject(stub, (_instance, state) => {
    const before = WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 68);
    expect(before.at(-1)?.version).toBe(68);
    applyDurableObjectSqliteMigrations({
      storage: state.storage, migrations: before, component: "workspace_do",
      workerVersionId: "before-breakout-appearance", now: 1,
    });
    state.storage.sql.exec(`INSERT INTO workspace_breakout_directory (
      workstream_id, substream_id, authority_generation, waterline, source_event_id,
      payload_hash, title, description, scope, exact_state, title_status,
      last_activity_at, latest_attention_ordinal, unread_tracking_start_ordinal,
      source_created_at, source_updated_at, projected_at
    ) VALUES (
      'channel-1', 'breakout-1', 1, 1, 'event-1', 'hash-1', 'Existing breakout',
      '', 'workspace', 'active', 'settled', 100, 0, 0, 100, 100, 100
    )`);
  });

  await runInDurableObject(stub, (_instance, state) => {
    applyDurableObjectSqliteMigrations({
      storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
      component: "workspace_do", workerVersionId: "with-breakout-appearance", now: 2,
    });
    const sql = state.storage.sql;
    // Migration 72 renamed the directory to `breakouts`; the v68 row has to
    // survive both the appearance column and the rename.
    expect(sql.exec("SELECT name FROM sqlite_schema WHERE name = 'workspace_breakout_directory'").toArray()).toEqual([]);
    expect(sql.exec<{ substream_id: string; title: string; appearance_json: string | null }>(
      "SELECT substream_id, title, appearance_json FROM breakouts",
    ).toArray()).toEqual([{ substream_id: "breakout-1", title: "Existing breakout", appearance_json: null }]);
    expect(() => sql.exec(
      "UPDATE breakouts SET appearance_json = 'not json' WHERE substream_id = 'breakout-1'",
    )).toThrow();
    sql.exec("UPDATE breakouts SET appearance_json = '{\"icon\":\"sparkles\"}' WHERE substream_id = 'breakout-1'");
    expect(sql.exec<{ appearance_json: string }>(
      "SELECT appearance_json FROM breakouts WHERE substream_id = 'breakout-1'",
    ).one().appearance_json).toBe('{"icon":"sparkles"}');
    expect(sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
  });
});
