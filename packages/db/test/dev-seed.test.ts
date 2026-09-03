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
    expect(database.prepare(
      `SELECT id, workspace_id, do_identity_anchor FROM workstreams
        WHERE id = '00000000-0000-7000-8000-000000000021'`,
    ).get()).toEqual({
      id: "00000000-0000-7000-8000-000000000021",
      workspace_id: "00000000-0000-7000-8000-000000000002",
      do_identity_anchor: 1,
    });
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
      INSERT INTO workspace_product_authority_routes (
        workspace_id, generation, state, stage_index, source_cursor,
        row_counts_json, last_error_code, updated_at
      )
      SELECT id, 1, 'verified', 0, 0, '{}', NULL, '2026-08-20T00:02:00.000Z'
        FROM workspaces;
      UPDATE workstream_authority_control
         SET phase = 'maintenance_verified', verified_at = '2026-08-20T00:03:00.000Z',
             updated_at = '2026-08-20T00:03:00.000Z'
       WHERE id = 1;
      UPDATE workstream_authority_routes
         SET state = 'active', activated_at = '2026-08-20T00:04:00.000Z',
             updated_at = '2026-08-20T00:04:00.000Z';
      UPDATE workspace_product_authority_routes
         SET state = 'active', updated_at = '2026-08-20T00:04:00.000Z';
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
    ).get()).toEqual({ count: 2 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });

  it("keeps the product fixtures parseable and shaped for the dev seed route", () => {
    const fixtures = JSON.parse(
      readFileSync(new URL("../seed-product.json", import.meta.url), "utf8"),
    ) as {
      workspaceId: string;
      workspaceTables: Record<string, Record<string, unknown>[]>;
      automations: {
        id: string;
        authorUserId: string;
        source: { definition: unknown; status: string; scope: string };
      }[];
      workstreams: {
        id: string; nextSequenceNumber: number;
        messages: {
          author_type: string;
          author_user_id?: string | null;
          author_name_snapshot?: string | null;
          author_avatar_url_snapshot?: string | null;
          sequence_number: number;
          structured_content_json: string | null;
        }[];
      }[];
    };
    expect(fixtures.workspaceId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(fixtures.workspaceTables).not.toHaveProperty("automation_subscriptions");
    expect(fixtures.automations.length).toBeGreaterThan(0);
    for (const automation of fixtures.automations) {
      expect(automation.id).toMatch(/^[0-9a-f-]{36}$/u);
      expect(automation.authorUserId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(automation.source.definition).toBeTypeOf("object");
      expect(automation.source.definition).not.toHaveProperty("requestedDelivery");
      expect(automation.source).not.toHaveProperty("deliveryTargets");
      expect(["active", "paused"]).toContain(automation.source.status);
      expect(["personal", "workspace"]).toContain(automation.source.scope);
    }
    expect(fixtures.workstreams.length).toBeGreaterThan(0);
    for (const workstream of fixtures.workstreams) {
      const sequences = workstream.messages.map((message) => message.sequence_number);
      expect(Math.max(0, ...sequences)).toBeLessThan(workstream.nextSequenceNumber);
      for (const message of workstream.messages) {
        if (message.structured_content_json) JSON.parse(message.structured_content_json);
        if (message.author_type === "human") {
          expect(message.author_user_id).toMatch(/^[0-9a-f-]{36}$/u);
          expect(message.author_name_snapshot?.trim()).not.toBe("");
          expect(message.author_avatar_url_snapshot ?? null).toBeNull();
        } else {
          expect(message.author_name_snapshot).toBeUndefined();
          expect(message.author_avatar_url_snapshot).toBeUndefined();
        }
      }
    }
    for (const rows of Object.values(fixtures.workspaceTables)) {
      for (const row of rows) expect(typeof row.id).toBe("string");
    }
  });
});
