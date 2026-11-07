/**
 * WorkspaceDO migrations 97 (one pin table) and 98 (a Channel's read
 * waterline), upgraded the way a deployed Organization is: populated at 96 and
 * committed in its own event, then woken with every migration. A fresh schema
 * has no rows to keep, which is what these two exist to prove they keep.
 */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
import { isArtifactNewsCause } from "../src/durable-objects/workspace-pin-storage";
import { drainResourceVersionChanges } from "../src/durable-objects/workspace-resource-versions";

const OWNER = "00000000-0000-7000-8000-0000000000a1";
const SPACE = "00000000-0000-7000-8000-0000000000b1";
const OLDER = "00000000-0000-7000-8000-0000000000c1";
const NEWER = "00000000-0000-7000-8000-0000000000c2";
const REMOVED = "00000000-0000-7000-8000-0000000000c3";

describe("migrations 97 and 98", () => {
  it("upgrade a populated Organization at 96, keeping its pins and numbering its placements read", async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName("navigation-v96");
    await stub.ping();
    await runInDurableObject(stub, (_instance, state) => {
      const before = WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 96);
      expect(before.at(-1)?.version).toBe(96);
      applyDurableObjectSqliteMigrations({
        storage: state.storage, migrations: before, component: "workspace_do", workerVersionId: "before-navigation", now: 1,
      });
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO spaces
        (space_id, title, scope, authority_generation, source_version, payload_hash, revision, created_at, updated_at)
        VALUES (?, 'Hiring', 'workspace', 1, 1, 'space', 1, 0, 0)`, SPACE);
      for (const [workstreamId, joinedAt, membership] of [
        [OLDER, 100, "active"], [NEWER, 200, "active"], [REMOVED, 150, "removed"],
      ] as const) {
        sql.exec(`INSERT INTO space_channel_memberships (space_id, workstream_id, state, generation, joined_at, updated_at)
          VALUES (?, ?, ?, 1, ?, ?)`, SPACE, workstreamId, membership, joinedAt, joinedAt);
      }
      // A pin names a thread the directory holds.
      sql.exec(`INSERT INTO channels (
        workstream_id, authority_generation, waterline, source_event_id, payload_hash,
        title, description, preview, scope, exact_state, origin_type, title_status,
        latest_attention_ordinal, unread_tracking_start_ordinal, last_activity_at,
        source_created_at, source_updated_at, projected_at
      ) VALUES (?, 1, 1, 'event-1', 'hash', 'Shortlist', '', '', 'workspace', 'idle', 'ad_hoc', 'settled', 0, 0, 200, 200, 200, 200)`,
      NEWER);
      sql.exec(`INSERT INTO workspace_workstream_pins (user_id, space_id, workstream_id, position, created_at, updated_at)
        VALUES (?, ?, ?, 0, 5, 5)`, OWNER, SPACE, NEWER);
    });

    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 146) /* 147 drops what this reads */, component: "workspace_do",
        workerVersionId: "with-navigation", now: 2,
      });
      const sql = state.storage.sql;
      // 97: the old pin is a thread pin in the one table.
      expect(sql.exec(`SELECT user_id, item_kind, item_id, parent_id, position FROM workspace_pins`).toArray())
        .toEqual([{ user_id: OWNER, item_kind: "thread", item_id: NEWER, parent_id: null, position: 0 }]);
      // 98: active placements numbered in placement order, a removed one left
      // unnumbered, and the Channel read through all of them by everyone.
      expect(sql.exec(`SELECT workstream_id, attention_ordinal FROM space_channel_memberships ORDER BY joined_at`).toArray())
        .toEqual([
          { workstream_id: OLDER, attention_ordinal: 1 },
          { workstream_id: REMOVED, attention_ordinal: null },
          { workstream_id: NEWER, attention_ordinal: 2 },
        ]);
      expect(sql.exec(`SELECT latest_attention_ordinal, unread_tracking_start_ordinal FROM spaces WHERE space_id = ?`, SPACE).toArray())
        .toEqual([{ latest_attention_ordinal: 2, unread_tracking_start_ordinal: 2 }]);
      expect(sql.exec(`SELECT COUNT(*) AS count FROM space_reads`).one()).toEqual({ count: 0 });
      expect(sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
    });
  });
});

describe("migration 110", () => {
  it("upgrades a populated Organization at 109, keeping every pin in place and admitting an artifact with its thread", async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName("artifact-pins-v109");
    await stub.ping();
    await runInDurableObject(stub, (_instance, state) => {
      const before = WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 109);
      expect(before.at(-1)?.version).toBe(109);
      applyDurableObjectSqliteMigrations({
        storage: state.storage, migrations: before, component: "workspace_do", workerVersionId: "before-artifact-pins", now: 1,
      });
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO workspace_pins (user_id, item_kind, item_id, parent_id, position, created_at, updated_at)
        VALUES (?, 'thread', ?, NULL, 0, 5, 6)`, OWNER, NEWER);
      sql.exec(`INSERT INTO workspace_pins (user_id, item_kind, item_id, parent_id, position, created_at, updated_at)
        VALUES (?, 'breakout', ?, ?, 0, 7, 8)`, OWNER, REMOVED, OLDER);
    });

    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 146) /* 147 drops what this reads */, component: "workspace_do",
        workerVersionId: "with-artifact-pins", now: 2,
      });
      const sql = state.storage.sql;
      expect(sql.exec(`SELECT item_kind, item_id, parent_id, position, created_at, updated_at FROM workspace_pins ORDER BY item_kind`).toArray())
        .toEqual([
          { item_kind: "breakout", item_id: REMOVED, parent_id: OLDER, position: 0, created_at: 7, updated_at: 8 },
          { item_kind: "thread", item_id: NEWER, parent_id: null, position: 0, created_at: 5, updated_at: 6 },
        ]);
      sql.exec(`INSERT INTO workspace_pins (user_id, item_kind, item_id, parent_id, position, created_at, updated_at)
        VALUES (?, 'artifact', ?, ?, 0, 9, 9)`, OWNER, SPACE, NEWER);
      // An artifact names its thread, as a breakout does.
      expect(() => sql.exec(`INSERT INTO workspace_pins (user_id, item_kind, item_id, parent_id, position, created_at, updated_at)
        VALUES (?, 'artifact', ?, NULL, 1, 9, 9)`, OWNER, OLDER)).toThrow(/CHECK constraint failed/u);
      expect(sql.exec(`SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'workspace_pins' AND name = 'workspace_pins_order_idx'`).toArray())
        .toEqual([{ name: "workspace_pins_order_idx" }]);
    });
  });
});

describe("migration 112", () => {
  it("upgrades a populated Organization at 111, keeping version history and capturing who a revision was for", async () => {
    const workspaceId = "00000000-0000-7000-8000-0000000000d1";
    const resource = "00000000-0000-7000-8000-0000000000d2";
    const run = "00000000-0000-7000-8000-0000000000d3";
    const stub = env.MIGRATION_PROBE_DO!.getByName("on-behalf-of-v111");
    await stub.ping();
    await runInDurableObject(stub, (_instance, state) => {
      const before = WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 111);
      expect(before.at(-1)?.version).toBe(111);
      applyDurableObjectSqliteMigrations({
        storage: state.storage, migrations: before, component: "workspace_do", workerVersionId: "before-on-behalf-of", now: 1,
      });
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO workspace_identity (id, workspace_id, region, placement_affinity, created_at, updated_at)
        VALUES (1, ?, 'global', 'wnam', 0, 0)`, workspaceId);
      sql.exec(`INSERT INTO resources
          (id, workspace_id, resource_type, provider, provider_resource_id, title, mime_type,
           content_ref, content_sha256, metadata_json, attachment_status, model_content_status,
           created_at, updated_at, revision_author_kind, revision_author_run_id, revision_cause)
        VALUES (?, ?, 'generated_file', 'avalon_generated', 'terminal:plan.md', 'Plan', 'text/markdown',
                'global/v1', 'a', '{}', 'attached', 'pending', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z',
                'agent', ?, 'created')`, resource, workspaceId, run);
      sql.exec(`UPDATE resources SET content_ref = 'global/v2', content_sha256 = 'b',
          revision_author_kind = 'agent', revision_author_run_id = ?, revision_cause = 'published'
        WHERE id = ?`, run, resource);
    });

    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS, component: "workspace_do",
        workerVersionId: "with-on-behalf-of", now: 2,
      });
      const sql = state.storage.sql;
      // A revision staged for a person records them; the next write, staged by nobody, does not inherit it.
      sql.exec(`UPDATE resources SET content_ref = 'global/v3', content_sha256 = 'c',
          revision_author_kind = 'agent', revision_author_run_id = ?, revision_cause = 'published',
          revision_on_behalf_of_user_id = ?
        WHERE id = ?`, run, OWNER, resource);
      sql.exec(`UPDATE resources SET title = 'Plan, renamed' WHERE id = ?`, resource);
      expect(sql.exec(`SELECT version, content_ref, cause, on_behalf_of_user_id FROM resource_versions
          WHERE resource_id = ? ORDER BY version`, resource).toArray()).toEqual([
        { version: 1, content_ref: "global/v1", cause: "created", on_behalf_of_user_id: null },
        { version: 2, content_ref: "global/v2", cause: "published", on_behalf_of_user_id: null },
        { version: 3, content_ref: "global/v3", cause: "published", on_behalf_of_user_id: OWNER },
        { version: 4, content_ref: "global/v3", cause: null, on_behalf_of_user_id: null },
      ]);
      expect(sql.exec(`SELECT revision_on_behalf_of_user_id FROM resources WHERE id = ?`, resource).one())
        .toEqual({ revision_on_behalf_of_user_id: null });
    });
  });
});

describe("migration 113", () => {
  it("upgrades a populated Organization at 112, keeping version causes and recording a rename as one", async () => {
    const workspaceId = "00000000-0000-7000-8000-0000000000e1";
    const resource = "00000000-0000-7000-8000-0000000000e2";
    const run = "00000000-0000-7000-8000-0000000000e3";
    const stub = env.MIGRATION_PROBE_DO!.getByName("renamed-cause-v112");
    await stub.ping();
    await runInDurableObject(stub, (_instance, state) => {
      const before = WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 112);
      expect(before.at(-1)?.version).toBe(112);
      applyDurableObjectSqliteMigrations({
        storage: state.storage, migrations: before, component: "workspace_do", workerVersionId: "before-renamed-cause", now: 1,
      });
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO workspace_identity (id, workspace_id, region, placement_affinity, created_at, updated_at)
        VALUES (1, ?, 'global', 'wnam', 0, 0)`, workspaceId);
      sql.exec(`INSERT INTO resources
          (id, workspace_id, resource_type, provider, provider_resource_id, title, mime_type,
           content_ref, content_sha256, metadata_json, attachment_status, model_content_status,
           created_at, updated_at, revision_author_kind, revision_author_run_id, revision_cause)
        VALUES (?, ?, 'generated_file', 'avalon_generated', 'terminal:plan.md', 'Plan', 'text/markdown',
                'global/v1', 'a', '{}', 'attached', 'pending', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z',
                'agent', ?, 'created')`, resource, workspaceId, run);
      sql.exec(`UPDATE resources SET content_ref = 'global/v2', content_sha256 = 'b',
          revision_author_kind = 'agent', revision_author_run_id = ?, revision_cause = 'published'
        WHERE id = ?`, run, resource);
      sql.exec(`INSERT INTO workspace_pins (user_id, item_kind, item_id, parent_id, position, created_at, updated_at)
        VALUES (?, 'artifact', ?, ?, 0, 0, 0)`, OWNER, resource, NEWER);
      sql.exec(`DELETE FROM workspace_artifact_updates`);
    });

    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS, component: "workspace_do",
        workerVersionId: "with-renamed-cause", now: 2,
      });
      const sql = state.storage.sql;
      sql.exec(`UPDATE resources SET title = 'Plan, renamed',
          revision_author_kind = 'member', revision_author_user_id = ?, revision_cause = 'renamed'
        WHERE id = ?`, OWNER, resource);
      sql.exec(`UPDATE resources SET content_ref = 'global/v3', content_sha256 = 'c',
          revision_author_kind = 'agent', revision_author_run_id = ?, revision_cause = 'published'
        WHERE id = ?`, run, resource);
      expect(sql.exec(`SELECT version, title, cause, author_kind FROM resource_versions
          WHERE resource_id = ? ORDER BY version`, resource).toArray()).toEqual([
        { version: 1, title: "Plan", cause: "created", author_kind: "agent" },
        { version: 2, title: "Plan", cause: "published", author_kind: "agent" },
        { version: 3, title: "Plan, renamed", cause: "renamed", author_kind: "member" },
        { version: 4, title: "Plan, renamed", cause: "published", author_kind: "agent" },
      ]);
      // The capture triggers came back: staging is consumed after each version.
      expect(sql.exec(`SELECT revision_cause, revision_author_kind FROM resources WHERE id = ?`, resource).one())
        .toEqual({ revision_cause: null, revision_author_kind: null });
      // The ledger holds both versions with their causes; a pinner hears
      // about the republish, not the rename.
      const changes = drainResourceVersionChanges(sql);
      expect(changes).toEqual([
        { resourceId: resource, version: 3, cause: "renamed" },
        { resourceId: resource, version: 4, cause: "published" },
      ]);
      expect(changes.filter((change) => isArtifactNewsCause(change.cause)).map((change) => change.version))
        .toEqual([4]);
      expect(() => sql.exec(`UPDATE resources SET title = 'Plan again', revision_cause = 'invented' WHERE id = ?`, resource))
        .toThrow(/CHECK constraint failed/u);
      expect(sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
    });
  });
});

describe("migration 114", () => {
  it("upgrades a populated Organization at 113, keeping a queued pinned version and recording every resource after", async () => {
    const workspaceId = "00000000-0000-7000-8000-0000000000f1";
    const pinned = "00000000-0000-7000-8000-0000000000f2";
    const unpinned = "00000000-0000-7000-8000-0000000000f3";
    const stub = env.MIGRATION_PROBE_DO!.getByName("version-ledger-v113");
    await stub.ping();
    const republish = (sql: SqlStorage, id: string, ref: string) => sql.exec(
      `UPDATE resources SET content_ref = ?, content_sha256 = ?, revision_author_kind = 'system',
         revision_cause = 'published' WHERE id = ?`, ref, ref, id);
    await runInDurableObject(stub, (_instance, state) => {
      const before = WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 113);
      expect(before.at(-1)?.version).toBe(113);
      applyDurableObjectSqliteMigrations({
        storage: state.storage, migrations: before, component: "workspace_do", workerVersionId: "before-version-ledger", now: 1,
      });
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO workspace_identity (id, workspace_id, region, placement_affinity, created_at, updated_at)
        VALUES (1, ?, 'global', 'wnam', 0, 0)`, workspaceId);
      for (const id of [pinned, unpinned]) {
        sql.exec(`INSERT INTO resources
            (id, workspace_id, resource_type, provider, title, mime_type, content_ref, content_sha256,
             metadata_json, created_at, updated_at)
          VALUES (?, ?, 'generated_file', 'avalon_generated', 'Plan', 'text/markdown', 'v1', 'v1', '{}',
                  '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`, id, workspaceId);
      }
      sql.exec(`INSERT INTO workspace_pins (user_id, item_kind, item_id, parent_id, position, created_at, updated_at)
        VALUES (?, 'artifact', ?, ?, 0, 0, 0)`, OWNER, pinned, NEWER);
      // Queued by the old trigger and not yet drained when the deployment lands.
      republish(sql, pinned, "v2");
      republish(sql, unpinned, "v2");
      expect(sql.exec(`SELECT resource_id, version FROM workspace_artifact_updates`).toArray())
        .toEqual([{ resource_id: pinned, version: 2 }]);
    });

    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS, component: "workspace_do",
        workerVersionId: "with-version-ledger", now: 2,
      });
      const sql = state.storage.sql;
      expect(sql.exec(`SELECT name FROM sqlite_schema WHERE name IN
          ('workspace_artifact_updates', 'resource_versions_queue_artifact_update')`).toArray()).toEqual([]);
      republish(sql, unpinned, "v3");
      expect(drainResourceVersionChanges(sql)).toEqual([
        { resourceId: pinned, version: 2, cause: "published" },
        { resourceId: unpinned, version: 3, cause: "published" },
      ]);
      expect(sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
    });
  });
});
