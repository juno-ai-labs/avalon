/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Conversation schema v71 on an object that already holds a conversation:
 * the work-stream row an earlier version wrote survives with no agent
 * profile, which is what an ordinary conversation reads as, and the new
 * desktop-action table takes rows and enforces its answered-outcome rule.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS } from "../src/durable-objects/workstream-object-schema";

describe("conversation schema v71 in workerd", () => {
  it("upgrades a populated v70 conversation to an ordinary one and adds desktop actions", async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName("populated-v70-desktop-actions-upgrade");
    await stub.ping();
    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 70),
        component: "substream_agent_do",
        workerVersionId: "worker-v70",
        now: 1_000,
      });
      state.storage.sql.exec(
        `INSERT INTO workstream (
           id, workstream_key, parent_workspace_key, parent_do_id, parent_generation, region,
           authority_mode, authority_generation, title, description, preview, scope,
           exact_state, state_reason_code, next_sequence_number, next_attention_ordinal,
           unread_tracking_start_ordinal, authority_epoch, scope_epoch,
           source_authorization_floor, listing_epoch, deletion_epoch, run_revision,
           created_at, last_people_activity_at, state_changed_at, updated_at
         ) VALUES (
           1, 'workstream-1', 'workspace-1', NULL, 0, 'global',
           'authoritative', 1, 'Garden plan', 'Beds for spring', '', 'personal',
           'idle', 'seeded', 1, 1, 0, 0, 0,
           0, 0, 0, 0, 1, 1, 1, 1
         )`,
      );

      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
        component: "substream_agent_do",
        workerVersionId: "worker-v71",
        now: 2_000,
      });

      expect(state.storage.sql.exec<{ title: string; description: string; agent_profile: string | null }>(
        `SELECT title, description, agent_profile FROM workstream WHERE id = 1`,
      ).one()).toEqual({ title: "Garden plan", description: "Beds for spring", agent_profile: null });

      state.storage.sql.exec(
        `INSERT INTO desktop_actions
           (action_id, run_id, tool_call_id, action_json, status, outcome_json, answered_by_user_id, created_at, answered_at)
         VALUES ('action-1', 'run-1', 'call-1', '{"kind":"browser.snapshot"}', 'answered', '{"ok":true}', 'user-1', 2000, 2001)`,
      );
      expect(state.storage.sql.exec<{ status: string; outcome_json: string }>(
        `SELECT status, outcome_json FROM desktop_actions WHERE action_id = 'action-1'`,
      ).one()).toEqual({ status: "answered", outcome_json: '{"ok":true}' });
      // An answered action without its outcome is refused, not stored.
      expect(() => state.storage.sql.exec(
        `INSERT INTO desktop_actions
           (action_id, run_id, tool_call_id, action_json, status, outcome_json, answered_by_user_id, created_at, answered_at)
         VALUES ('action-2', 'run-1', 'call-2', '{"kind":"browser.snapshot"}', 'answered', NULL, 'user-1', 2000, 2001)`,
      )).toThrow(/CHECK constraint failed/);
      expect(state.storage.sql.exec(`PRAGMA foreign_key_check`).toArray()).toEqual([]);
    });
  });
});
