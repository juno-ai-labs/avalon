/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  purgeRetiredMeetingObjects,
  withMeetingRetirementPrerequisites,
} from "../src/durable-objects/meeting-notes-retirement";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
import { WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS } from "../src/durable-objects/workstream-object-schema";

const workspaceId = "00000000-0000-7000-8000-000000000da0";
const resourceId = "00000000-0000-7000-8000-000000000cb1";
const noteId = "00000000-0000-7000-8000-000000000cb0";
const ownerId = "00000000-0000-7000-8000-000000000ca1";
const at = "2033-01-01T00:00:00.000Z";

describe("schema 58 compatibility", () => {
  it("upgrades a populated workspace, preserves cleanup addresses, and removes retired tables", async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName("schema-58-workspace-upgrade");
    await stub.ping();
    await runInDurableObject(stub, async (_instance, state) => {
      const migrate = (migrations: typeof WORKSPACE_DO_SCHEMA_MIGRATIONS) =>
        withMeetingRetirementPrerequisites(state.storage, () => applyDurableObjectSqliteMigrations({
          storage: state.storage,
          component: "workspace_do",
          migrations,
          workerVersionId: "schema-58-test",
          now: 1_000,
        }));
      migrate(WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version < 57));
      const sql = state.storage.sql;
      sql.exec(
        `INSERT INTO workspace_identity(id, workspace_id, region, placement_affinity, created_at, updated_at)
         VALUES (1, ?, 'global', 'wnam', 1, 1)`,
        workspaceId,
      );
      sql.exec(
        `INSERT INTO resources
          (id, workspace_id, resource_type, provider, title, content_ref, metadata_json,
           attachment_status, created_at, updated_at)
         VALUES (?, ?, 'note', 'avalon_note', 'Retired note', ?, '{}', 'attached', ?, ?)`,
        resourceId,
        workspaceId,
        `global/${workspaceId}/resources/${resourceId}/note.md`,
        at,
        at,
      );
      sql.exec(
        `INSERT INTO notes
          (id, workspace_id, owner_user_id, resource_id, scope, title, manual_notes_markdown,
           live_notes_markdown, last_activity_at, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, 'personal', 'Retired note', 'private', 'summary', ?, ?, ?, NULL)`,
        noteId,
        workspaceId,
        ownerId,
        resourceId,
        at,
        at,
        at,
      );

      migrate(WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 57));
      expect(sql.exec("SELECT resource_id, note_id FROM retired_meeting_resources").toArray())
        .toEqual([{ resource_id: resourceId, note_id: noteId }]);
      expect(sql.exec("SELECT * FROM notes").toArray()).toEqual([]);
      await purgeRetiredMeetingObjects(state.storage, env.PAYLOADS, "global", workspaceId);
      migrate(WORKSPACE_DO_SCHEMA_MIGRATIONS);
      expect(sql.exec(
        "SELECT name FROM sqlite_schema WHERE name IN ('notes', 'note_transcript_segments')",
      ).toArray()).toEqual([]);
      expect(sql.exec("SELECT MAX(version) AS version FROM _sql_schema_migrations").one())
        .toEqual({ version: 58 });
    });
  });

  it("accepts the shipped conversation migration after main's version 57", async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName("schema-58-conversation-upgrade");
    await stub.ping();
    await runInDurableObject(stub, (_instance, state) => {
      const migrate = (before: boolean) => applyDurableObjectSqliteMigrations({
        storage: state.storage,
        component: "substream_agent_do",
        workerVersionId: "schema-58-test",
        migrations: before
          ? WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.filter((migration) => migration.version < 57)
          : WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
      });
      migrate(true);
      const insert = (id: string, provider: string) => state.storage.sql.exec(
        `INSERT INTO workstream_resource_links
          (resource_id, watch_enabled, relationship_type, resource_json, attached_at, updated_at)
         VALUES (?, 0, 'attachment', ?, 1, 1)`,
        id,
        JSON.stringify({ id, provider, title: "fixture" }),
      );
      insert(resourceId, "avalon_note");
      insert("granola-fixture", "granola");

      migrate(false);

      expect(state.storage.sql.exec(
        "SELECT resource_id FROM workstream_resource_links ORDER BY resource_id",
      ).toArray()).toEqual([{ resource_id: "granola-fixture" }]);
      expect(state.storage.sql.exec(
        "SELECT resource_id FROM retired_meeting_attachment_ids",
      ).toArray()).toEqual([{ resource_id: resourceId }]);
      expect(() => insert(resourceId, "avalon_note")).toThrow("meeting_notes_retired");
      expect(state.storage.sql.exec(
        "SELECT MAX(version) AS version FROM _sql_schema_migrations",
      ).one()).toEqual({ version: 58 });
    });
  });
});
