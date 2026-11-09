/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * WorkspaceDO migration 141, the drop of the tables the Thread operations
 * kept, on an object populated at version 140, the last one main shipped.
 *
 * On real workerd because the claims are about workerd's SQLite with foreign
 * keys enforced: `schedules` and `digest_schedules` must come through
 * untouched, and a drop in the wrong order would abort on a
 * referenced parent and take every Organization offline at construction.
 * The historical schema and its upgrade commit in separate object events, as
 * `durable-object-sqlite.md` requires of an upgrade test.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const LAST_SHIPPED = 140;
const COMPONENT = "workspace_do";
const WORKSPACE = "00000000-0000-7000-8000-000000000140";
const THREAD = "00000000-0000-7000-8000-000000001401";
const CHANNEL = "00000000-0000-7000-8000-000000001402";
const CANVAS = "00000000-0000-7000-8000-000000001403";
const SIDEKICK = "00000000-0000-7000-8000-000000001404";
const PERSON = "00000000-0000-7000-8000-000000001405";

const DROPPED_TABLES = [
  "channels", "channel_viewers", "breakouts", "breakout_viewers", "spaces", "space_viewers",
  "parent_metadata", "parent_child_projections", "parent_child_viewer_projections", "parent_child_receipts",
  "parent_projection_keys", "parent_state_clock", "parent_state_changes", "parent_outbox",
  "parent_breakout_preparations", "parent_breakout_members", "parent_breakout_member_effects",
  "parent_participant_migrations", "parent_connector_admissions", "parent_sidekicks",
  "workspace_workstream_resource_links", "slack_agent_sessions", "slack_agent_feedback",
  "external_registration_generations", "workspace_workstream_effect_receipts",
];

const KEPT_PARENT_TABLES = [
  "parent_children", "parent_invitations", "parent_invitation_operations", "parent_grants",
  "parent_grant_operations", "parent_grant_imports", "parent_grant_revision",
  "parent_participant_targets", "parent_participant_deliveries",
];

const schemaNames = (sql: SqlStorage, type: "table" | "trigger"): string[] =>
  sql.exec<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = ? ORDER BY name", type)
    .toArray().map((row) => row.name);

describe("the WorkspaceDO Thread parents drop on workerd", () => {
  it("given an object populated at v140, when 141 applies, then the Thread tables are gone and every kept row remains", async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName("workspace-thread-parents-drop-v140");
    await stub.ping();

    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((m) => m.version <= LAST_SHIPPED),
        component: COMPONENT,
        workerVersionId: "worker-main",
        now: 1_000,
      });
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO workspace_identity (id, workspace_id, region, placement_affinity, created_at, updated_at)
        VALUES (1, ?, 'global', 'wnam', 1, 1)`, WORKSPACE);
      // A Thread, its viewer and an artifact link, as an Organization the
      // operator had not reached would hold them.
      sql.exec(`INSERT INTO channels
          (workstream_id, authority_generation, waterline, source_event_id, payload_hash, title, description, preview,
           scope, exact_state, last_activity_at, origin_type, title_status, latest_attention_ordinal,
           unread_tracking_start_ordinal, source_created_at, source_updated_at, projected_at)
        VALUES (?, 1, 1, 'event-thread', 'hash', 'Launch', '', '', 'workspace', 'idle', 5, 'ad_hoc', 'settled', 0, 0, 1, 1, 1)`,
      THREAD);
      sql.exec(`INSERT INTO channel_viewers
          (workstream_id, user_id, authority_generation, waterline, source_event_id, payload_hash, is_participant,
           unread_count, you_are_mentioned, listable, seen_attention_ordinal, manual_unread_generation,
           latest_mention_attention_ordinal, projected_at)
        VALUES (?, ?, 1, 1, 'event-viewer', 'hash', 1, 0, 0, 1, 0, 0, 0, 1)`, THREAD, PERSON);
      sql.exec(`INSERT INTO workspace_workstream_resource_links
          (workstream_id, resource_id, watch_enabled, relationship_type, authority_generation, waterline, source_event_id, projected_at)
        VALUES (?, 'resource-one', 0, 'attached', 1, 1, 'event-link', 1)`, THREAD);
      sql.exec(`INSERT INTO spaces
          (space_id, title, scope, authority_generation, source_version, payload_hash, revision, created_at, updated_at)
        VALUES (?, 'General', 'workspace', 1, 0, 'hash', 1, 1, 1)`, CHANNEL);
      sql.exec(`INSERT INTO parent_metadata
          (parent_id, parent_kind, workspace_id, region, authority_generation, created_at, updated_at)
        VALUES (?, 'workstream', ?, 'global', 1, 1, 1)`, THREAD, WORKSPACE);
      sql.exec(`INSERT INTO parent_sidekicks (parent_id, sidekick_id, attached_at) VALUES (?, ?, 1)`, THREAD, SIDEKICK);
      // A digest and its schedule beside a connector poll's schedule; 141
      // leaves both tables as they are.
      sql.exec(`INSERT INTO digest_schedules
          (id, workspace_id, user_id, day_mask, execution_principal_json, created_at, updated_at)
        VALUES ('digest-one', ?, ?, 127, '{}', 'then', 'then')`, WORKSPACE, PERSON);
      sql.exec(`INSERT INTO schedules
          (id, workspace_id, digest_schedule_id, schedule_type, interval_seconds, timezone, next_run_at, created_at, updated_at)
        VALUES ('schedule-digest', ?, 'digest-one', 'interval', 86400, 'UTC', 'next', 'then', 'then')`, WORKSPACE);
      sql.exec(`INSERT INTO schedules
          (id, workspace_id, connector_connection_id, schedule_type, interval_seconds, timezone, next_run_at, last_run_at,
           enabled, version, created_at, updated_at)
        VALUES ('schedule-poll', ?, 'connection-one', 'interval', 900, 'UTC', 'next', 'last', 1, 7, 'then', 'later')`, WORKSPACE);
      // The kept neighbours: a Canvas, its share and its Sidekick
      // attachment, a Sidekick's attachment to the Thread, and the Thread's
      // resource location and conversation view.
      sql.exec(`INSERT INTO canvas_directory
          (canvas_id, workspace_id, title, created_by_user_id, created_at, updated_at, visibility, authority_generation, title_status)
        VALUES (?, ?, 'Plan', ?, 2, 2, 'creator', 1, 'settled')`, CANVAS, WORKSPACE, PERSON);
      sql.exec(`INSERT INTO parent_grants (parent_id, user_id, scope_kind, substream_id, grant_json)
        VALUES (?, ?, 'workstream', '', '{}')`, CANVAS, PERSON);
      sql.exec(`INSERT INTO parent_children (parent_id, substream_id, kind, created_at) VALUES (?, '0', 'main', 1)`, THREAD);
      sql.exec(`INSERT INTO sidekick_conversation_attachments VALUES (?, 'canvas', ?, '0', ?, 3), (?, 'workstream', ?, '0', ?, 4)`,
        SIDEKICK, CANVAS, PERSON, SIDEKICK, THREAD, PERSON);
      sql.exec(`INSERT INTO authorization_locations (parent_id, substream_id, parent_kind, resource_id)
        VALUES (?, '0', 'workstream', 'resource-one')`, THREAD);
      sql.exec(`INSERT INTO conversation_view_headers VALUES (?, '0', 1, 1, '{}')`, THREAD);
      expect(schemaNames(sql, "table")).toEqual(expect.arrayContaining(DROPPED_TABLES));
    });

    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
        component: COMPONENT,
        workerVersionId: "worker-thread-parents-drop",
        now: 2_000,
      });
      const sql = state.storage.sql;
      expect(sql.exec<{ version: number }>(
        "SELECT version FROM _sql_schema_migrations WHERE version > ? ORDER BY version", LAST_SHIPPED,
      ).toArray().map((row) => row.version)).toEqual([141]);

      const tables = schemaNames(sql, "table");
      expect(DROPPED_TABLES.filter((table) => tables.includes(table))).toEqual([]);
      expect(KEPT_PARENT_TABLES.filter((table) => !tables.includes(table))).toEqual([]);
      expect(tables).not.toContain("schedules_v141");
      expect(schemaNames(sql, "trigger").filter((name) => /^memory_digest_(thread|breakout|space)_|^search_authz_workspace_workstream_|^parent_breakout_members_freeze_/u.test(name)))
        .toEqual([]);

      // `schedules` and `digest_schedules` are untouched: both schedules stay.
      expect(tables).toEqual(expect.arrayContaining(["schedules", "digest_schedules"]));
      expect(sql.exec("SELECT id FROM schedules ORDER BY id").toArray())
        .toEqual([{ id: "schedule-digest" }, { id: "schedule-poll" }]);

      expect(sql.exec("SELECT canvas_id, title FROM canvas_directory").toArray()).toEqual([{ canvas_id: CANVAS, title: "Plan" }]);
      expect(sql.exec("SELECT parent_id, user_id FROM parent_grants").toArray()).toEqual([{ parent_id: CANVAS, user_id: PERSON }]);
      expect(sql.exec("SELECT parent_id, substream_id FROM parent_children").toArray()).toEqual([{ parent_id: THREAD, substream_id: "0" }]);
      expect(sql.exec("SELECT parent_kind, parent_id FROM sidekick_conversation_attachments").toArray())
        .toEqual([{ parent_kind: "canvas", parent_id: CANVAS }]);
      expect(sql.exec("SELECT parent_id, parent_kind, resource_id FROM authorization_locations").toArray())
        .toEqual([{ parent_id: THREAD, parent_kind: "workstream", resource_id: "resource-one" }]);
      expect(sql.exec("SELECT parent_id, substream_id FROM conversation_view_headers").toArray())
        .toEqual([{ parent_id: THREAD, substream_id: "0" }]);
      expect(sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
    });
  });
});
