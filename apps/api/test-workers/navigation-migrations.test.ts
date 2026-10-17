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
        storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS, component: "workspace_do",
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
        storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS, component: "workspace_do",
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
