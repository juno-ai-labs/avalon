/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";

import type { MigrationProbeDO } from "../src/durable-objects/migration-probe-do";

import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

// Migration 72 renames the six directory tables WorkspaceDO held at v70 and
// seeded `parent_imports` from two of them, which migration 75 drops. Every assertion below starts from a
// populated v70 object committed in its own event, because a fresh schema has
// no rows to lose, no foreign keys to leave pointing at an old name, and no
// triggers to strand.
const RENAMES = {
  workspace_workstream_directory: "channels",
  workspace_workstream_viewers: "channel_viewers",
  workspace_breakout_directory: "breakouts",
  workspace_breakout_viewers: "breakout_viewers",
  workspace_space_directory: "spaces",
  workspace_space_viewers: "space_viewers",
} as const;
type OldTable = keyof typeof RENAMES;
const OLD_TABLES = Object.keys(RENAMES) as OldTable[];

interface SchemaEntry { type: string; name: string; tbl_name: string }
interface V70Schema { dependents: SchemaEntry[]; indexColumns: Record<string, string[]> }

function channelRow(sql: SqlStorage, id: string, archivedAt: number | null) {
  sql.exec(`INSERT INTO workspace_workstream_directory (
    workstream_id, authority_generation, waterline, source_event_id, payload_hash,
    title, description, preview, scope, exact_state, archived_at, origin_type,
    title_status, latest_attention_ordinal, unread_tracking_start_ordinal,
    last_activity_at, source_created_at, source_updated_at, projected_at
  ) VALUES (?, 1, 1, ?, 'hash', ?, '', '', 'workspace', 'idle', ?, 'ad_hoc',
    'settled', 0, 0, 100, 100, 100, 100)`, id, `event-${id}`, `Title ${id}`, archivedAt);
}

function channelViewerRow(sql: SqlStorage, channelId: string, userId: string, table = "workspace_workstream_viewers") {
  sql.exec(`INSERT INTO ${table} (
    workstream_id, user_id, authority_generation, waterline, source_event_id, payload_hash,
    is_participant, unread_count, you_are_mentioned, listable, seen_attention_ordinal,
    manual_unread_generation, latest_mention_attention_ordinal, projected_at
  ) VALUES (?, ?, 1, 1, 'event', 'hash', 1, 0, 0, 1, 0, 0, 0, 100)`, channelId, userId);
}

function spaceRow(sql: SqlStorage, id: string, archivedAt: number | null) {
  sql.exec(`INSERT INTO workspace_space_directory (
    space_id, title, scope, archived_at, authority_generation, source_version,
    payload_hash, revision, created_at, updated_at
  ) VALUES (?, ?, 'workspace', ?, 1, 1, 'hash', 1, 100, 100)`, id, `Space ${id}`, archivedAt);
}

function indexColumns(sql: SqlStorage, index: string): string[] {
  return sql.exec<{ name: string | null }>("SELECT name FROM pragma_index_info(?) ORDER BY seqno", index)
    .toArray().map((column) => column.name ?? "<expression>");
}

function rows<T extends Record<string, SqlStorageValue>>(sql: SqlStorage, query: string, ...bindings: SqlStorageValue[]): T[] {
  return sql.exec<T>(query, ...bindings).toArray();
}

/**
 * Builds WorkspaceDO through v70 in one object event, populates every table
 * migration 72 renames and every table that references one, then upgrades in a
 * second event, as a deployed object is woken by a new worker. Returns the v70
 * indexes and triggers on the renamed tables, read before the upgrade.
 */
async function upgradeFromPopulatedV70(name: string): Promise<{ stub: DurableObjectStub<MigrationProbeDO>; v70: V70Schema }> {
  const stub = env.MIGRATION_PROBE_DO!.getByName(name);
  await stub.ping();

  const v70 = await runInDurableObject(stub, (_instance, state): V70Schema => {
    const before = WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 70);
    expect(before.at(-1)?.version).toBe(70);
    applyDurableObjectSqliteMigrations({
      storage: state.storage, migrations: before, component: "workspace_do",
      workerVersionId: "before-hosted-parents", now: 1,
    });
    const sql = state.storage.sql;

    // An archived Channel and an archived Space are still parents a legacy
    // object holds; the seed has to list them as well as the live ones.
    channelRow(sql, "channel-live", null);
    channelRow(sql, "channel-archived", 50);
    channelViewerRow(sql, "channel-live", "user-a");
    channelViewerRow(sql, "channel-live", "user-b");
    channelViewerRow(sql, "channel-archived", "user-a");
    spaceRow(sql, "space-live", null);
    spaceRow(sql, "space-archived", 60);
    sql.exec(`INSERT INTO workspace_space_viewers (
      space_id, user_id, is_participant, authority_generation, source_version, payload_hash
    ) VALUES ('space-live', 'user-a', 1, 1, 1, 'hash'), ('space-archived', 'user-b', 0, 1, 1, 'hash')`);
    sql.exec(`INSERT INTO workspace_breakout_directory (
      workstream_id, substream_id, authority_generation, waterline, source_event_id,
      payload_hash, title, description, scope, exact_state, title_status,
      last_activity_at, latest_attention_ordinal, unread_tracking_start_ordinal,
      source_created_at, source_updated_at, projected_at
    ) VALUES ('channel-live', 'breakout-1', 1, 1, 'event-b', 'hash', 'Breakout', '',
      'workspace', 'idle', 'settled', 100, 0, 0, 100, 100, 100)`);
    sql.exec(`INSERT INTO workspace_breakout_viewers (
      workstream_id, substream_id, user_id, authority_generation, waterline, source_event_id,
      payload_hash, is_participant, unread_count, you_are_mentioned, unseen, listable,
      seen_attention_ordinal, manual_unread_generation, latest_mention_attention_ordinal, projected_at
    ) VALUES ('channel-live', 'breakout-1', 'user-a', 1, 1, 'event-b', 'hash', 1, 0, 0, 0, 1, 0, 0, 0, 100)`);
    // The tables holding a foreign key into the renamed directories, plus the
    // membership table that names both without one.
    sql.exec(`INSERT INTO workspace_workstream_pins (user_id, space_id, workstream_id, position, created_at, updated_at)
      VALUES ('user-a', 'space-live', 'channel-live', 0, 100, 100)`);
    sql.exec(`INSERT INTO workspace_workstream_access (user_id, workstream_id, last_accessed_at)
      VALUES ('user-a', 'channel-live', 100)`);
    sql.exec(`INSERT INTO space_channel_memberships (space_id, workstream_id, state, generation, joined_at, updated_at)
      VALUES ('space-live', 'channel-live', 'active', 1, 100, 100)`);
    // The directory writes above fired the search-authorization triggers;
    // the upgraded object starts from an empty outbox so a later row is
    // attributable to one write.
    sql.exec("DELETE FROM search_authorization_push");

    const dependents = rows<SchemaEntry & Record<string, SqlStorageValue>>(sql,
      `SELECT type, name, tbl_name FROM sqlite_schema
        WHERE type IN ('index', 'trigger') AND sql IS NOT NULL AND tbl_name IN (${OLD_TABLES.map(() => "?").join(", ")})
        ORDER BY name`, ...OLD_TABLES);
    return {
      dependents,
      indexColumns: Object.fromEntries(dependents.filter((entry) => entry.type === "index")
        .map((entry) => [entry.name, indexColumns(sql, entry.name)])),
    };
  });

  await runInDurableObject(stub, (_instance, state) => {
    applyDurableObjectSqliteMigrations({
      storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 146) /* 147 drops what this reads */,
      component: "workspace_do", workerVersionId: "with-hosted-parents", now: 2,
    });
  });
  return { stub, v70 };
}

it("drops the legacy import ledger once every parent is hosted", async () => {
  // Migration 72 seeded a pending row for every Channel and Space; migration
  // 75 drops the ledger with the legacy classes it imported from.
  const { stub } = await upgradeFromPopulatedV70("hosted-parent-v70-seed");
  await runInDurableObject(stub, (_instance, state) => {
    expect(rows(state.storage.sql, "SELECT name FROM sqlite_master WHERE name LIKE 'parent_imports%'")).toEqual([]);
  });
});

it("carries every v70 directory row into channels, channel_viewers, spaces, space_viewers, breakouts and breakout_viewers and leaves no old table or reference behind", async () => {
  const { stub } = await upgradeFromPopulatedV70("hosted-parent-v70-rows");
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    expect(rows(sql, "SELECT workstream_id, title, archived_at FROM channels ORDER BY workstream_id")).toEqual([
      { workstream_id: "channel-archived", title: "Title channel-archived", archived_at: 50 },
      { workstream_id: "channel-live", title: "Title channel-live", archived_at: null },
    ]);
    expect(rows(sql, "SELECT workstream_id, user_id FROM channel_viewers ORDER BY workstream_id, user_id")).toEqual([
      { workstream_id: "channel-archived", user_id: "user-a" },
      { workstream_id: "channel-live", user_id: "user-a" },
      { workstream_id: "channel-live", user_id: "user-b" },
    ]);
    expect(rows(sql, "SELECT space_id, archived_at FROM spaces ORDER BY space_id")).toEqual([
      { space_id: "space-archived", archived_at: 60 },
      { space_id: "space-live", archived_at: null },
    ]);
    expect(rows(sql, "SELECT space_id, user_id, is_participant FROM space_viewers ORDER BY space_id")).toEqual([
      { space_id: "space-archived", user_id: "user-b", is_participant: 0 },
      { space_id: "space-live", user_id: "user-a", is_participant: 1 },
    ]);
    expect(rows(sql, "SELECT workstream_id, substream_id, title FROM breakouts")).toEqual([
      { workstream_id: "channel-live", substream_id: "breakout-1", title: "Breakout" },
    ]);
    expect(rows(sql, "SELECT workstream_id, substream_id, user_id FROM breakout_viewers")).toEqual([
      { workstream_id: "channel-live", substream_id: "breakout-1", user_id: "user-a" },
    ]);
    expect(rows(sql, "SELECT space_id, workstream_id, state FROM space_channel_memberships")).toEqual([
      { space_id: "space-live", workstream_id: "channel-live", state: "active" },
    ]);
    expect(rows(sql, "SELECT user_id, space_id, workstream_id FROM workspace_workstream_pins")).toEqual([
      { user_id: "user-a", space_id: "space-live", workstream_id: "channel-live" },
    ]);
    expect(rows(sql, `SELECT name FROM sqlite_schema WHERE name IN (${OLD_TABLES.map(() => "?").join(", ")})`, ...OLD_TABLES))
      .toEqual([]);
    // Nothing in the schema (a foreign key, a trigger body, a view) still
    // names a table that no longer exists.
    const stale = new RegExp(`\\b(${OLD_TABLES.join("|")})\\b`);
    expect(rows<{ name: string; sql: string }>(sql, "SELECT name, sql FROM sqlite_schema WHERE sql IS NOT NULL")
      .filter((entry) => stale.test(entry.sql)).map((entry) => entry.name)).toEqual([]);
  });
});

it("repoints v70 foreign keys at channels and spaces: the graph checks clean, a missing parent is refused and a Channel delete still cascades", async () => {
  const { stub } = await upgradeFromPopulatedV70("hosted-parent-v70-keys");
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    expect(sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
    for (const child of ["channel_viewers", "workspace_workstream_pins", "workspace_workstream_access"]) {
      expect(rows<{ table: string }>(sql, "SELECT \"table\" FROM pragma_foreign_key_list(?)", child)
        .map((key) => key.table)).toContain("channels");
    }
    expect(rows<{ table: string }>(sql, "SELECT \"table\" FROM pragma_foreign_key_list('workspace_workstream_pins')")
      .map((key) => key.table)).toContain("spaces");
    expect(() => channelViewerRow(sql, "channel-missing", "user-a", "channel_viewers")).toThrow(/FOREIGN KEY/);

    sql.exec("DELETE FROM channels WHERE workstream_id = 'channel-live'");
    expect(rows(sql, "SELECT user_id FROM channel_viewers WHERE workstream_id = 'channel-live'")).toEqual([]);
    expect(rows(sql, "SELECT user_id FROM workspace_workstream_pins")).toEqual([]);
    expect(rows(sql, "SELECT user_id FROM workspace_workstream_access")).toEqual([]);
    expect(rows(sql, "SELECT user_id FROM channel_viewers WHERE workstream_id = 'channel-archived'")).toEqual([{ user_id: "user-a" }]);
    expect(sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
  });
});

it("keeps the v70 search-authorization triggers firing on channels and channel_viewers", async () => {
  const { stub, v70 } = await upgradeFromPopulatedV70("hosted-parent-v70-triggers");
  // The fixture only means something if v70 had triggers on both tables.
  expect(v70.dependents.filter((entry) => entry.type === "trigger").map((entry) => entry.tbl_name))
    .toEqual(expect.arrayContaining(["workspace_workstream_directory", "workspace_workstream_viewers"]));
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    expect(rows(sql, "SELECT kind, target_id FROM search_authorization_push")).toEqual([]);
    sql.exec("UPDATE channel_viewers SET is_participant = 0 WHERE workstream_id = 'channel-live' AND user_id = 'user-b'");
    sql.exec("UPDATE channels SET archived_at = 70 WHERE workstream_id = 'channel-archived'");
    expect(rows(sql, "SELECT kind, target_id, revision FROM search_authorization_push ORDER BY target_id")).toEqual([
      { kind: "parent", target_id: "channel-archived", revision: 1 },
      { kind: "parent", target_id: "channel-live", revision: 1 },
    ]);
    const triggers = rows<{ name: string; tbl_name: string }>(sql,
      "SELECT name, tbl_name FROM sqlite_schema WHERE type = 'trigger'");
    for (const entry of v70.dependents.filter((dependent) => dependent.type === "trigger")) {
      expect(triggers).toContainEqual({ name: entry.name, tbl_name: RENAMES[entry.tbl_name as OldTable] });
    }
  });
});

it("keeps every v70 index on the renamed tables, on the same columns", async () => {
  const { stub, v70 } = await upgradeFromPopulatedV70("hosted-parent-v70-indexes");
  const indexes = v70.dependents.filter((entry) => entry.type === "index");
  // The fixture only means something if v70 had indexes on the renamed tables.
  expect(new Set(indexes.map((entry) => entry.tbl_name)))
    .toEqual(new Set(["workspace_workstream_directory", "workspace_space_directory", "workspace_space_viewers"]));
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    const after = rows<{ name: string; tbl_name: string }>(sql,
      "SELECT name, tbl_name FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL");
    for (const entry of indexes) {
      expect(after).toContainEqual({ name: entry.name, tbl_name: RENAMES[entry.tbl_name as OldTable] });
      expect(indexColumns(sql, entry.name)).toEqual(v70.indexColumns[entry.name]);
    }
  });
});

it("narrows parent_metadata to identity at v79 and keeps every parent's row", async () => {
  // Populated at v78 with the full old row, committed in its own event, then
  // upgraded as a deployed object is: a fresh schema has no rows to lose.
  const stub = env.MIGRATION_PROBE_DO!.getByName("hosted-parent-v78-metadata");
  await stub.ping();
  await runInDurableObject(stub, (_instance, state) => {
    const before = WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 78);
    expect(before.at(-1)?.version).toBe(78);
    applyDurableObjectSqliteMigrations({
      storage: state.storage, migrations: before, component: "workspace_do",
      workerVersionId: "before-narrow-metadata", now: 1,
    });
    const insert = (id: string, kind: string, generation: number, revision: number, archivedAt: number | null) =>
      state.storage.sql.exec(`INSERT INTO parent_metadata
        (parent_id, parent_kind, workspace_id, region, authority_generation, revision, title, description,
         preview, scope, exact_state, system_kind, last_activity_at, completed_at, archived_at, email_address,
         created_by_user_id, title_status, latest_attention_ordinal, unread_tracking_start_ordinal,
         next_wakeup_due_at, next_wakeup_prompt, next_terminal_action_at, source_created_at, source_updated_at,
         created_at, updated_at)
        VALUES (?, ?, 'workspace-1', 'global', ?, ?, 'Title', 'Description', 'Preview', 'workspace', 'idle',
          NULL, 100, NULL, ?, NULL, 'user-a', 'settled', 3, 1, NULL, NULL, 400, 100, 200, 10, 20)`,
        id, kind, generation, revision, archivedAt);
    insert("channel-1", "workstream", 2, 7, null);
    insert("space-1", "space", 1, 3, 60);
  });

  await runInDurableObject(stub, (_instance, state) => {
    applyDurableObjectSqliteMigrations({
      storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
      component: "workspace_do", workerVersionId: "with-narrow-metadata", now: 2,
    });
    const sql = state.storage.sql;
    expect(rows(sql, "SELECT name FROM pragma_table_info('parent_metadata') ORDER BY cid").map((row) => row.name))
      .toEqual(["parent_id", "parent_kind", "workspace_id", "region", "authority_generation", "revision",
        "created_at", "updated_at"]);
    expect(rows(sql, "SELECT * FROM parent_metadata ORDER BY parent_id")).toEqual([
      { parent_id: "channel-1", parent_kind: "workstream", workspace_id: "workspace-1", region: "global",
        authority_generation: 2, revision: 7, created_at: 10, updated_at: 20 },
      { parent_id: "space-1", parent_kind: "space", workspace_id: "workspace-1", region: "global",
        authority_generation: 1, revision: 3, created_at: 10, updated_at: 20 },
    ]);
    expect(rows(sql, "SELECT name FROM sqlite_master WHERE name LIKE 'parent_metadata_%'")).toEqual([]);
    expect(rows(sql, "PRAGMA foreign_key_check")).toEqual([]);
  });
});
