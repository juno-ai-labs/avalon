/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The conversation class renamed to `AgentLoopDO` (Wrangler tag v15) keeps
 * every object's storage, so what matters is that the class constructs over a
 * conversation's stored state as it was before the rename: a root at schema
 * version 82, carried through version 83, with its identity and every column
 * intact. The rename itself is the deploy's to prove; this proves the class
 * the deploy points the namespace at reads what the old one wrote.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { asWorkspaceId } from "@rally/contracts";

import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import {
  WORKSTREAM_OBJECT_SCHEMA_COMPONENT,
  WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
  WORKSTREAM_OBJECT_SCHEMA_VERSION,
} from "../src/durable-objects/workstream-object-schema";
import { WorkstreamObjectStore } from "../src/durable-objects/workstream-object-storage";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000a1d00");
const PARENT_ID = "00000000-0000-7000-8000-0000000a1d01";

describe("the conversation store AgentLoopDO opens, over a conversation stored before the rename", () => {
  it("opens a v82 root, keeping its identity and columns, and admits a Canvas parent at v83", async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName("agent-loop-do-continuity-v82");
    await stub.ping();
    // The history and the root are committed in their own event, as a deployed
    // object's are before the new build wakes it.
    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 82),
        component: WORKSTREAM_OBJECT_SCHEMA_COMPONENT,
        workerVersionId: "worker-before-rename",
        now: 1_000,
      });
      state.storage.sql.exec(
        `INSERT INTO workstream
           (id, workstream_key, parent_workspace_key, region, authority_mode, authority_generation,
            title, description, scope, exact_state, state_reason_code, next_sequence_number,
            next_attention_ordinal, authority_epoch, scope_epoch, source_authorization_floor,
            listing_epoch, deletion_epoch, run_revision, created_at, last_people_activity_at,
            state_changed_at, updated_at, parent_kind, archive_generation)
         VALUES (1, ?, ?, 'global', 'authoritative', 3, 'Release notes', '', 'personal', 'idle', 'seeded',
                 9, 4, 1, 1, 0, 1, 0, 2, 1000, 1100, 1200, 1300, 'automation', 1)`,
        PARENT_ID, WORKSPACE_ID,
      );
    });
    await runInDurableObject(stub, (_instance, state) => {
      // What the renamed class does first on wake: open its store, which
      // applies the rest of the history.
      const store = new WorkstreamObjectStore(state.storage, "worker-after-rename", "global");
      expect(store.identity()).toEqual({ workspaceId: WORKSPACE_ID, parentKind: "automation", parentId: PARENT_ID });
      expect(state.storage.sql.exec<{ version: number }>(
        `SELECT MAX(version) AS version FROM _sql_schema_migrations`,
      ).one().version).toBe(WORKSTREAM_OBJECT_SCHEMA_VERSION);
      expect(state.storage.sql.exec(
        `SELECT authority_generation, next_sequence_number, archive_generation FROM workstream WHERE id = 1`,
      ).one()).toEqual({ authority_generation: 3, next_sequence_number: 9, archive_generation: 1 });
      // Migration 83 widened the root's CHECK: a Canvas parent is now storable.
      state.storage.sql.exec(`UPDATE workstream SET parent_kind = 'canvas' WHERE id = 1`);
      expect(state.storage.sql.exec<{ parent_kind: string }>(
        `SELECT parent_kind FROM workstream WHERE id = 1`,
      ).one().parent_kind).toBe("canvas");
    });
  });

  it("drops the suggestion, handoff and import tables at v84, and a frozen roster takes writes again", async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName("agent-loop-do-v84-drops");
    await stub.ping();
    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 83),
        component: WORKSTREAM_OBJECT_SCHEMA_COMPONENT,
        workerVersionId: "worker-before-v84",
        now: 1_000,
      });
      state.storage.sql.exec(
        `INSERT INTO workstream
           (id, workstream_key, parent_workspace_key, region, authority_mode, authority_generation,
            title, description, scope, exact_state, state_reason_code, next_sequence_number,
            next_attention_ordinal, authority_epoch, scope_epoch, source_authorization_floor,
            listing_epoch, deletion_epoch, run_revision, created_at, last_people_activity_at,
            state_changed_at, updated_at, parent_kind, archive_generation)
         VALUES (1, ?, ?, 'global', 'authoritative', 1, 'Launch', '', 'personal', 'idle', 'seeded',
                 1, 1, 1, 1, 0, 1, 0, 0, 1000, 1000, 1000, 1000, 'canvas', 0)`,
        PARENT_ID, WORKSPACE_ID,
      );
      // A handoff frozen before its projection began: the roster refuses writes.
      state.storage.sql.exec(
        `INSERT INTO participant_authority_transfer (singleton, transfer_id, phase, snapshot_json, prepared_at, projection_write)
         VALUES (1, 'transfer-1', 'frozen', '{}', 1000, 0)`,
      );
      state.storage.sql.exec(
        `INSERT INTO turn_disposition_judgements (run_id, judged_turn_id, code, created_at) VALUES ('run-1', 'turn-1', 'quiet', 1000)`,
      );
      state.storage.sql.exec(
        `INSERT INTO imported_session_sources (id, provider, session_id, created_at, updated_at) VALUES (1, 'claude', 's-1', 1000, 1000)`,
      );
      expect(() => state.storage.sql.exec(
        `INSERT INTO participants (user_id, participation_reason, status, participant_epoch, added_at, updated_at)
         VALUES ('00000000-0000-7000-8000-0000000a1d02', 'creator', 'active', 0, 1000, 1000)`,
      )).toThrow(/participant_authority_transferred/u);
    });
    await runInDurableObject(stub, (_instance, state) => {
      const store = new WorkstreamObjectStore(state.storage, "worker-after-v84", "global");
      expect(store.identity()).toEqual({ workspaceId: WORKSPACE_ID, parentKind: "canvas", parentId: PARENT_ID });
      const tables = state.storage.sql.exec<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE name IN ('conversation_suggestions', 'turn_disposition_judgements',
           'participant_authority_transfer', 'participant_projection_revisions', 'imported_session_sources',
           'imported_session_messages', 'imported_session_update_receipts')`,
      ).toArray();
      expect(tables).toEqual([]);
      // The freeze triggers went with the handoff: the roster is written again.
      state.storage.sql.exec(
        `INSERT INTO participants (user_id, participation_reason, status, participant_epoch, added_at, updated_at)
         VALUES ('00000000-0000-7000-8000-0000000a1d02', 'creator', 'active', 0, 1000, 1000)`,
      );
      expect(state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM participants`).one().count).toBe(1);
    });
  });
});
