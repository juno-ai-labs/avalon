/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A conversation object knows which kind of parent it belongs to.
 *
 * Every object that existed before schema version 39 belongs to a work stream,
 * and the migration says so through a column default rather than a rewrite:
 * `parent_kind` lands as `'workstream'` and `workstream_key`, which is the
 * parent id, keeps its value. An object born under an automation refuses to be
 * addressed as a work stream's, because every port and every effect it emits
 * is keyed on that identity.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { asAutomationId, asSubstreamId, asWorkspaceId } from "@rally/contracts";

import { conversationObjectName } from "../src/durable-objects/names";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import {
  WORKSTREAM_OBJECT_SCHEMA_COMPONENT,
  WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
} from "../src/durable-objects/workstream-object-schema";
import { WorkstreamObjectStore } from "../src/durable-objects/workstream-object-storage";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000bc0");
const AUTOMATION_ID = asAutomationId("00000000-0000-7000-8000-000000000bc1");
const RUN_ID = asSubstreamId("00000000-0000-7000-8000-000000000bc2");

describe("a conversation object's parent kind", () => {
  it("migrates a root written before the column existed to a work stream's, which opens refused by name", async () => {
    // The probe object applies no schema of its own, so the history can be
    // stopped at version 38 and the root seeded the way that version wrote it.
    const stub = env.MIGRATION_PROBE_DO!.getByName("conversation-identity-v38");
    await stub.ping();
    await runInDurableObject(stub, (_instance, state) => {
      const beforeParentKind = WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.slice(0, 38);
      expect(beforeParentKind.at(-1)?.version).toBe(38);
      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: beforeParentKind,
        component: WORKSTREAM_OBJECT_SCHEMA_COMPONENT,
        workerVersionId: "worker-v38",
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
           1, 'workstream-before-39', ?, NULL, 0, 'global',
           'authoritative', 1, 'Older than the column', '', '', 'personal',
           'idle', 'seeded', 1, 1, 0, 0, 0,
           0, 0, 0, 0, 1, 1, 1, 1
         )`,
        WORKSPACE_ID,
      );

      // Constructing the store is what a real object does first: it applies
      // the rest of the history, version 39 included.
      // Every such root is a Thread's, retired in plan step B-7, so the
      // product read refuses it by name rather than serving a dead parent.
      const store = new WorkstreamObjectStore(state.storage, "worker-current", "global");
      expect(() => store.identity()).toThrow("conversation_parent_kind_retired:workstream");
      expect(state.storage.sql.exec<{ parent_kind: string; workstream_key: string }>(
        `SELECT parent_kind, workstream_key FROM workstream WHERE id = 1`,
      ).one()).toEqual({ parent_kind: "workstream", workstream_key: "workstream-before-39" });
    });
  });

  it("refuses to re-identify an automation's conversation as a work stream's", async () => {
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, AUTOMATION_ID, RUN_ID),
    ));
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_control (
        id INTEGER PRIMARY KEY, phase TEXT NOT NULL, generation INTEGER NOT NULL,
        required_serving_contract_version INTEGER NOT NULL,
        serving_contract_version INTEGER NOT NULL
      )`),
      env.DB.prepare(`INSERT OR REPLACE INTO workstream_authority_control
        (id, phase, generation, required_serving_contract_version, serving_contract_version)
        VALUES (1, 'durable_object_open', 1, 1, 1)`),
    ]);
    expect((await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "automation",
      parentId: AUTOMATION_ID,
      substreamId: RUN_ID,
      generation: 1,
    })).status).toBe(200);

    const refused = await stub.bootstrapRuntime({
      workspaceId: WORKSPACE_ID,
      parentKind: "canvas",
      parentId: AUTOMATION_ID,
      substreamId: RUN_ID,
      generation: 1,
    });
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.bodyJson)).toEqual({ error: "workstream_object_identity_mismatch" });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ parent_kind: string; workstream_key: string }>(
        `SELECT parent_kind, workstream_key FROM workstream WHERE id = 1`,
      ).one()).toEqual({ parent_kind: "automation", workstream_key: AUTOMATION_ID });
    });
  });
});
