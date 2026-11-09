/**
 * The local development seed, which is not a migration.
 *
 * `seed.sql` and `seed-product.json` are live, editable files that
 * `pnpm db:seed` applies on every fresh checkout — unlike the migrations, which
 * are immutable once deployed and guarded by the baseline manifest digest.
 * These three tests moved here when the per-migration suite was retired: they
 * were only ever in it because they needed a migrated database to seed into.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

function migrateFreshDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  for (const fileName of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(new URL(`../migrations/${fileName}`, import.meta.url), "utf8"));
  }
  return database;
}

describe("the development seed", () => {
  it("applies the development seed after every migration, touching no product table", () => {
    const database = migrateFreshDatabase();
    database.exec(readFileSync(new URL("../seed.sql", import.meta.url), "utf8"));
    // The seed owns only the regional control plane. Product content —
    // transcripts, resources, connections, automations — lives in
    // seed-product.json and reaches the Durable Objects through the Worker's
    // dev seed route, which is what lets the legacy D1 product tables be
    // dropped. A product row appearing here again would quietly recreate the
    // dependency that blocked the drop.
    expect(database.prepare(
      "SELECT COUNT(*) AS n FROM users",
    ).get()).toEqual({ n: 2 });
    // No conversation anchor either: the seeded Canvases and Sidekick are
    // anchored by the creation paths the dev seed route calls.
    expect(database.prepare("SELECT COUNT(*) AS n FROM workstreams").get()).toEqual({ n: 0 });
    // Every workspace/work-stream product table is gone. The D1 seed writes
    // only identity and routing anchors; product fixtures go through the local
    // Worker's Durable Object seed route.
    for (const table of ["messages", "harness_runs", "tool_invocations",
      "workstream_resources", "elicitations", "workstream_wakeups",
      "resources", "connector_connections", "workstream_participants",
      "workstream_read_states", "workstream_pins", "automation_subscriptions",
      "schedules", "work_opportunities", "memory_items"]) {
      expect(database.prepare(
        `SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = ?`,
      ).get(table), `${table} must no longer exist in D1`).toEqual({ n: 0 });
    }
    database.close();
  });

  it("opens a fresh post-retirement seed using explicit routing rows", () => {
    const database = migrateFreshDatabase();
    database.exec(readFileSync(new URL("../seed.sql", import.meta.url), "utf8"));
    database.exec(`
      UPDATE workstream_authority_control
         SET phase = 'maintenance_draining', generation = 1,
             serving_contract_version = required_serving_contract_version,
             updated_at = '2026-08-20T00:00:00.000Z'
       WHERE id = 1;
      UPDATE workstream_authority_control
         SET phase = 'maintenance_importing', updated_at = '2026-08-20T00:01:00.000Z'
       WHERE id = 1;
    `);
    // Migration 0090 deliberately removes the completed import-population
    // triggers. A fresh local seed creates routing rows explicitly, without
    // reconstructing any product source schema.
    expect(database.prepare("SELECT COUNT(*) AS count FROM workstream_authority_routes").get())
      .toEqual({ count: 0 });
    database.exec(`
      INSERT INTO workstream_authority_routes (
        workspace_id, workstream_id, generation, object_name, state, stage_index,
        source_cursor, source_fence_sequence, source_hash, target_hash,
        row_counts_json, imported_at, verified_at, activated_at, updated_at
      )
      SELECT w.workspace_id, w.id, 1, ws.region || ':' || w.workspace_id || ':' || w.id,
             'verified', 0, 0, 0, 'seeded_in_do', 'seeded_in_do', '{}', NULL,
             '2026-08-20T00:02:00.000Z', NULL, '2026-08-20T00:02:00.000Z'
        FROM workstreams w JOIN workspaces ws ON ws.id = w.workspace_id;
      UPDATE workstream_authority_control
         SET phase = 'maintenance_verified', verified_at = '2026-08-20T00:03:00.000Z',
             updated_at = '2026-08-20T00:03:00.000Z'
       WHERE id = 1;
      UPDATE workstream_authority_routes
         SET state = 'active', activated_at = '2026-08-20T00:04:00.000Z',
             updated_at = '2026-08-20T00:04:00.000Z';
      UPDATE workstream_authority_control
         SET phase = 'durable_object_open', opened_at = '2026-08-20T00:05:00.000Z',
             updated_at = '2026-08-20T00:05:00.000Z'
       WHERE id = 1;
    `);
    expect(database.prepare(
      "SELECT phase, generation FROM workstream_authority_control WHERE id = 1",
    ).get()).toEqual({ phase: "durable_object_open", generation: 1 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM workstream_authority_routes WHERE state = 'active'",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });
});
