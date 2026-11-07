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

describe("AgentLoopDO over a conversation stored before the rename", () => {
  it("constructs over a v82 root, keeping its identity and columns, and admits a Canvas parent", async () => {
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
      state.storage.sql.exec(`UPDATE workstream SET parent_kind = 'canvas' WHERE id = 1`);
    });
  });
});
