/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * WorkspaceDO migration 45 replaces the `projects` table to widen a CHECK
 * vocabulary, and six tables cascade from it.
 *
 * This has to run on real workerd rather than on `node:sqlite`. The failure it
 * guards is a `DROP TABLE` firing `ON DELETE CASCADE` for real, and the reason
 * it fires is a runtime property: `PRAGMA foreign_keys = OFF` is silently a
 * no-op once anything in the same Durable Object event has touched SQLite.
 * `durable-object-sqlite.md` states the rule this test exists for — a rebuild of
 * a referenced parent needs a populated upgrade test, because a fresh-schema
 * test passes either way, which is how the last instance of this was found.
 *
 * Every table in the cascade closure is seeded, including the two beneath
 * `project_default_resources` that a direct-children-only test would miss.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const PALETTE_MIGRATION = 45;
const COMPONENT = "workspace_do";

const PROJECT_ID = "00000000-0000-7000-8000-0000000009a1";
const USER_ID = "00000000-0000-7000-8000-0000000009a2";
const WORKSTREAM_ID = "00000000-0000-7000-8000-0000000009a3";
const RESOURCE_ID = "00000000-0000-7000-8000-0000000009a4";

describe("the WorkspaceDO project palette migration on workerd", () => {
  it("given an object on the previous schema with every cascading table populated, when 45 applies, then nothing is lost", async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName("workspace-project-palette-v44");
    await stub.ping();

    await runInDurableObject(stub, (_instance, state) => {
      const before = WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((m) => m.version < PALETTE_MIGRATION);
      expect(before.at(-1)?.version).toBe(PALETTE_MIGRATION - 1);
      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: before,
        component: COMPONENT,
        workerVersionId: "worker-before-palette",
        now: 1_000,
      });

      const sql = state.storage.sql;
      // `teal` is a colour the picker no longer offers. It has to come through
      // the rebuild untouched: the migration widens the vocabulary and never
      // remaps a stored value.
      sql.exec(
        `INSERT INTO projects (
           project_id, name, normalized_name, icon_key, icon_color_key, scope, status,
           creator_user_id, created_at, updated_at, presentation_revision,
           audience_generation, lifecycle_generation
         ) VALUES (?, 'Hiring', 'hiring', 'briefcase', 'teal', 'workspace', 'active', ?, 1, 1, 1, 1, 1)`,
        PROJECT_ID,
        USER_ID,
      );
      sql.exec(
        `INSERT INTO project_participants (project_id, user_id, state, generation, created_at, updated_at)
         VALUES (?, ?, 'active', 1, 1, 1)`,
        PROJECT_ID,
        USER_ID,
      );
      sql.exec(
        `INSERT INTO workspace_project_order (user_id, project_id, position, created_at, updated_at)
         VALUES (?, ?, 1, 1, 1)`,
        USER_ID,
        PROJECT_ID,
      );
      sql.exec(
        `INSERT INTO project_workstream_memberships (project_id, workstream_id, state, generation, joined_at, updated_at)
         VALUES (?, ?, 'active', 1, 1, 1)`,
        PROJECT_ID,
        WORKSTREAM_ID,
      );
      sql.exec(
        `INSERT INTO project_default_resources (project_id, resource_id, state, generation, created_at, updated_at)
         VALUES (?, ?, 'active', 1, 1, 1)`,
        PROJECT_ID,
        RESOURCE_ID,
      );
      sql.exec(
        `INSERT INTO project_default_resource_targets
           (project_id, resource_id, default_generation, workstream_id, membership_generation, state, created_at, updated_at)
         VALUES (?, ?, 1, ?, 1, 'pending', 1, 1)`,
        PROJECT_ID,
        RESOURCE_ID,
        WORKSTREAM_ID,
      );
      sql.exec(
        `INSERT INTO project_default_resource_publications
           (project_id, resource_id, default_generation, workstream_id, membership_generation,
            requested_by_user_id, state, attempts, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, 1, ?, 1, ?, 'pending', 0, 1, 1, 1)`,
        PROJECT_ID,
        RESOURCE_ID,
        WORKSTREAM_ID,
        USER_ID,
      );

      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
        component: COMPONENT,
        workerVersionId: "worker-with-palette",
        now: 2_000,
      });

      const count = (table: string): number => sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;

      // The project itself, still holding a colour the picker retired.
      expect(sql.exec<{ icon_color_key: string }>(
        `SELECT icon_color_key FROM projects WHERE project_id = ?`, PROJECT_ID,
      ).one().icon_color_key).toBe("teal");

      // Every table the cascade would have emptied, the two deepest included.
      expect(count("project_participants")).toBe(1);
      expect(count("workspace_project_order")).toBe(1);
      expect(count("project_workstream_memberships")).toBe(1);
      expect(count("project_default_resources")).toBe(1);
      expect(count("project_default_resource_targets")).toBe(1);
      expect(count("project_default_resource_publications")).toBe(1);

      // No scratch table left behind, and the widened vocabulary is live.
      expect(sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE '%\\_v45\\_hold' ESCAPE '\\'`,
      ).one().n).toBe(0);
      expect(() => sql.exec(
        `INSERT INTO projects (
           project_id, name, normalized_name, icon_key, icon_color_key, scope, status,
           creator_user_id, created_at, updated_at, presentation_revision,
           audience_generation, lifecycle_generation
         ) VALUES (?, 'Design', 'design', 'palette', 'fuchsia', 'workspace', 'active', ?, 1, 1, 1, 1, 1)`,
        "00000000-0000-7000-8000-0000000009b1",
        USER_ID,
      )).not.toThrow();

      // Foreign keys still point at the replacement rather than a dropped table.
      expect(() => sql.exec(
        `INSERT INTO project_participants (project_id, user_id, state, generation, created_at, updated_at)
         VALUES ('00000000-0000-7000-8000-00000000ffff', ?, 'active', 1, 1, 1)`,
        USER_ID,
      )).toThrow();
    });
  });
});
