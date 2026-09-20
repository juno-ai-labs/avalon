import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { databaseThroughMigration } from "./helpers/migrated-schema";

const migration = readFileSync(
  new URL("../../../packages/db/migrations/0115_drop_workspace_product_authority_ledger.sql", import.meta.url),
  "utf8",
);

it("drops the workspace cutover ledger while retaining regional and workstream authority fences", () => {
  const database = databaseThroughMigration("0114_link_payloads.sql");
  try {
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('user', 'subject', 'member@example.com', 'Member', 'now', 'now');
      INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace', 'Workspace', 'workspace', 'global', 'user', 'now', 'now');
      INSERT INTO workstreams (id, workspace_id, do_identity_anchor)
      VALUES ('workstream', 'workspace', 1);
      INSERT INTO workspace_product_authority_routes
        (workspace_id, generation, state, updated_at)
      VALUES ('workspace', 1, 'active', 'now');
    `);

    database.exec(migration);

    expect(database.prepare(
      "SELECT name FROM sqlite_schema WHERE name = 'workspace_product_authority_routes'",
    ).get()).toBeUndefined();
    expect(database.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'workstream_authority_open_guard'",
    ).get()).toMatchObject({ sql: expect.not.stringContaining("workspace_product_authority_routes") });

    database.exec(`
      UPDATE workstream_authority_control
         SET phase = 'maintenance_draining', generation = 1, updated_at = 'now'
       WHERE id = 1;
      UPDATE workstream_authority_control
         SET phase = 'maintenance_importing', updated_at = 'now'
       WHERE id = 1;
      INSERT INTO workstream_authority_routes
        (workspace_id, workstream_id, generation, object_name, state,
         source_fence_sequence, updated_at)
      VALUES ('workspace', 'workstream', 1, 'global:workspace:workstream',
              'pending', 0, 'now');
    `);
    expect(() => database.exec(
      "UPDATE workstream_authority_control SET phase = 'maintenance_verified' WHERE id = 1",
    )).toThrow("workstream_authority_routes_not_verified");

    database.exec(`
      UPDATE workstream_authority_routes SET state = 'verified';
      UPDATE workstream_authority_control SET phase = 'maintenance_verified' WHERE id = 1;
    `);
    expect(() => database.exec(
      "UPDATE workstream_authority_control SET phase = 'durable_object_open' WHERE id = 1",
    )).toThrow("workstream_authority_not_ready_to_open");

    database.exec(`
      UPDATE workstream_authority_routes SET state = 'active';
      UPDATE workstream_authority_control
         SET phase = 'durable_object_open', serving_contract_version = 1
       WHERE id = 1;
    `);
    expect(database.prepare(
      "SELECT phase, generation FROM workstream_authority_control WHERE id = 1",
    ).get()).toEqual({ phase: "durable_object_open", generation: 1 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    database.close();
  }
});
