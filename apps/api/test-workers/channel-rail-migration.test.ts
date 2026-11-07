/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * WorkspaceDO migration 82 on an Organization that already holds Channels,
 * viewers, recommendations, Sidekicks and linked resources.
 *
 * The v79 object is built and populated in one object event and upgraded
 * across 80, 81 and 82 in a second, as a deployed object that slept through
 * the releases between is woken by a new worker: a fresh schema has no rows
 * for a new column's default or a new trigger to meet, and 81's column is one
 * 82's triggers read.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";

import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const WORKSPACE = "00000000-0000-4000-8000-0000000d7201";
const rows = (sql: SqlStorage, query: string, ...bindings: SqlStorageValue[]) => sql.exec(query, ...bindings).toArray();

it("upgrades a populated v79 Organization through 82 in one wake, every Channel at rail waterline zero and the triggers live", async () => {
  const stub = env.MIGRATION_PROBE_DO!.getByName("channel-rail-v79");
  await stub.ping();
  await runInDurableObject(stub, (_instance, state) => {
    const before = WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 79);
    expect(before.at(-1)?.version).toBe(79);
    applyDurableObjectSqliteMigrations({
      storage: state.storage, migrations: before, component: "workspace_do", workerVersionId: "before-rails", now: 1,
    });
    const sql = state.storage.sql;
    sql.exec(`INSERT INTO workspace_identity (id, workspace_id, region, placement_affinity, created_at, updated_at)
      VALUES (1, ?, 'global', 'wnam', 1, 1)`, WORKSPACE);
    for (const channel of ["channel-a", "channel-b"]) {
      sql.exec(`INSERT INTO channels (
        workstream_id, authority_generation, waterline, source_event_id, payload_hash,
        title, description, preview, scope, exact_state, origin_type, title_status,
        latest_attention_ordinal, unread_tracking_start_ordinal, last_activity_at,
        source_created_at, source_updated_at, projected_at
      ) VALUES (?, 1, 1, ?, 'hash', 'Title', '', '', 'workspace', 'idle', 'ad_hoc', 'settled', 0, 0, 100, 100, 100, 100)`,
      channel, `event-${channel}`);
    }
    sql.exec(`INSERT INTO channel_viewers (
      workstream_id, user_id, authority_generation, waterline, source_event_id, payload_hash,
      is_participant, unread_count, you_are_mentioned, listable, seen_attention_ordinal,
      manual_unread_generation, latest_mention_attention_ordinal, projected_at
    ) VALUES ('channel-a', 'user-a', 1, 1, 'event', 'hash', 1, 0, 0, 1, 0, 0, 0, 100)`);
    sql.exec(`INSERT INTO parent_sidekicks (parent_id, sidekick_id, attached_at) VALUES ('channel-a', 'sidekick-a', 1)`);
    sql.exec(`INSERT INTO automation_directory (automation_id, workspace_id, author_user_id, source_version,
        payload_hash, lifecycle, scope, owning_workstream_id, title, description, projected_at)
      VALUES ('sidekick-b', ?, 'user-a', 1, 'hash', 'active', 'workstream', 'channel-b', 'Room helper', '', 1)`, WORKSPACE);
    sql.exec(`INSERT INTO resources (id, workspace_id, resource_type, provider, title, metadata_json, created_at, updated_at)
      VALUES ('resource-a', ?, 'document', 'avalon_upload', 'Plan', '{}', 'now', 'now')`, WORKSPACE);
    sql.exec(`INSERT INTO workspace_workstream_resource_links (
      workstream_id, resource_id, watch_enabled, relationship_type, authority_generation, waterline,
      source_event_id, projected_at
    ) VALUES ('channel-a', 'resource-a', 0, 'attachment', 1, 1, 'event', 100)`);
  });

  await runInDurableObject(stub, (_instance, state) => {
    applyDurableObjectSqliteMigrations({
      storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
      component: "workspace_do", workerVersionId: "with-rails", now: 2,
    });
  });

  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    expect(rows(sql, `SELECT workstream_id, rail_waterline, sidekick_attachments_reported FROM channels ORDER BY workstream_id`))
      .toEqual([
        { workstream_id: "channel-a", rail_waterline: 0, sidekick_attachments_reported: 0 },
        { workstream_id: "channel-b", rail_waterline: 0, sidekick_attachments_reported: 0 },
      ]);
    expect(rows(sql, `SELECT workstream_id FROM channel_rail_changes`)).toEqual([]);
    expect(rows(sql, `SELECT parent_id, sidekick_id FROM parent_sidekicks`))
      .toEqual([{ parent_id: "channel-a", sidekick_id: "sidekick-a" }]);
    expect(rows(sql, `SELECT version FROM _sql_schema_migrations WHERE version BETWEEN 80 AND 82 ORDER BY version`))
      .toEqual([{ version: 80 }, { version: 81 }, { version: 82 }]);
    expect(rows(sql, `SELECT automation_id, run_as_user_id, title FROM automation_directory`))
      .toEqual([{ automation_id: "sidekick-b", run_as_user_id: null, title: "Room helper" }]);
    expect(rows(sql, "PRAGMA foreign_key_check")).toEqual([]);

    // A linked resource renamed after the upgrade moves only the Channel that lists it.
    sql.exec(`UPDATE resources SET title = 'Plan, revised' WHERE id = 'resource-a'`);
    expect(rows(sql, `SELECT workstream_id FROM channels WHERE rail_waterline > 0`)).toEqual([{ workstream_id: "channel-a" }]);
    expect(rows(sql, `SELECT workstream_id FROM channel_rail_changes`)).toEqual([{ workstream_id: "channel-a" }]);

    // The room's Sidekick carried across 81 is an Organization Sidekick since
    // 137, which retired the room scope and the owner trigger: renaming it
    // moves no room.
    const [channelA] = rows(sql, `SELECT rail_waterline FROM channels WHERE workstream_id = 'channel-a'`);
    sql.exec(`UPDATE automation_directory SET title = 'Room helper, renamed' WHERE automation_id = 'sidekick-b'`);
    expect(rows(sql, `SELECT workstream_id, rail_waterline FROM channels ORDER BY workstream_id`)).toEqual([
      { workstream_id: "channel-a", rail_waterline: channelA!.rail_waterline },
      { workstream_id: "channel-b", rail_waterline: 0 },
    ]);
  });
});
