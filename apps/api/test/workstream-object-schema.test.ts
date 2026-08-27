import { asWorkspaceId } from "@rally/contracts";
import { asWorkstreamId } from "@rally/contracts";
import { DatabaseSync } from "node:sqlite";
import { ServerSocketEventSchema } from "@rally/contracts";
import { describe, expect, it } from "vitest";

import {
  applyWorkstreamObjectSchema,
  WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
  WORKSTREAM_OBJECT_SCHEMA_VERSION,
} from "../src/durable-objects/workstream-object-schema";
import { WorkstreamIdentityStorage } from "../src/durable-objects/workstream-identity-storage";
import { WorkstreamObjectStore } from "../src/durable-objects/workstream-object-storage";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { rewriteWorkstreamRuntimeSql } from "../src/durable-objects/workstream-runtime-sql";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000000a1");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-0000000000a2");
const RUN_ID = "00000000-0000-7000-8000-0000000000a3";
const MESSAGE_ID = "00000000-0000-7000-8000-0000000000a4";
const RECIPIENT_ID = "00000000-0000-7000-8000-0000000000a6";
const AUTHOR_ID = "00000000-0000-7000-8000-0000000000a7";
const ATTEMPT_ID = "00000000-0000-7000-8000-0000000000a8";
const RECOVERED_ATTEMPT_ID = "00000000-0000-7000-8000-0000000000a9";
const OUTSIDER_ID = "00000000-0000-7000-8000-0000000000aa";

const EXPECTED_TABLES = [
  "_internal_durable_alarms",
  "_runtime_statement_changes",
  "_sql_schema_migrations",
  "active_agent_compaction",
  "active_output_chunks",
  "active_output_turns",
  "agent_run_dispatches",
  "attachment_tool_receipts",
  "bind_loop_heads",
  "bind_loop_state_messages",
  "bind_loop_states",
  "bind_provider_boundaries",
  "block_dashboard_block_runs",
  "block_dashboard_configuration_versions",
  "block_dashboard_user_preferences",
  "compaction_checkpoints",
  "content_refs",
  "description_refresh_state",
  "due_work",
  "durable_inbox_receipts",
  "durable_outbox",
  "elicitation_requests",
  "inference_attempts",
  "legacy_transcript_backfills",
  "member_attention",
  "object_versions",
  "part_attachments",
  "part_mentions",
  "participant_transcript_blocks",
  "participant_transcript_turns",
  "participants",
  "parts",
  "plugin_activation_hints",
  "projection_keys",
  "realtime_state",
  "repository_publications",
  "resource_inventory_revision",
  "run_lifecycle_events",
  "run_memory_contexts",
  "run_plugin_activations",
  "run_scopes",
  "run_steering",
  "runs",
  "substream_agent_identity",
  "substreams",
  "suggested_actions",
  "terminal_imported_resources",
  "terminal_publication_grants",
  "terminal_repository",
  "terminal_tasks",
  "terminal_workspace",
  "tool_effect_checkpoints",
  "tool_effects",
  "transcript_activities",
  "transcript_activity_intervals",
  "transcript_compaction_checkpoints",
  "transcript_counters",
  "transcript_facts",
  "transcript_payloads",
  "workstream",
  "workstream_resource_links",
  "workstream_wakeups",
] as const;

function objectStorage(
  database: DatabaseSync,
): DurableObjectStorage {
  return createCloudflareTestBinding<DurableObjectStorage>({
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    transactionSync: (body: () => unknown) => body(),
    sql: createTestSqlStorage(database),
  });
}

describe("the Workstream Durable Object relational schema", () => {
  it("removes view UPSERT clauses without changing real-table UPSERTs or RETURNING", () => {
    const compatibilityView = rewriteWorkstreamRuntimeSql(
      `INSERT INTO messages (id, workspace_id, workstream_id, text_content)
       VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET text_content = excluded.text_content
       RETURNING id`,
    );
    expect(compatibilityView).toContain("_runtime_messages");
    expect(compatibilityView).not.toContain("ON CONFLICT");
    expect(compatibilityView).toContain("RETURNING id");

    const realTable = rewriteWorkstreamRuntimeSql(
      `INSERT INTO attachment_tool_receipts (tool_call_id, resource_id)
       VALUES (?, ?) ON CONFLICT(tool_call_id) DO UPDATE SET resource_id = excluded.resource_id
       RETURNING resource_id`,
    );
    expect(realTable).toContain("ON CONFLICT(tool_call_id) DO UPDATE");
    expect(realTable).toContain("RETURNING resource_id");
  });

  it("creates the complete workstream-down table contract idempotently", () => {
    const database = new DatabaseSync(":memory:");
    const storage = objectStorage(database);
    try {
      applyWorkstreamObjectSchema(storage, "worker-one", 1_000);
      applyWorkstreamObjectSchema(storage, "worker-two", 2_000);

      // Migration versions are hashed and immutable once deployed, so the list
      // only ever grows: assert it is a gapless 1..N whose last entry is the
      // declared schema version, rather than pinning a count that any new
      // migration would have to edit.
      expect(WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.map((migration) => migration.version))
        .toEqual(WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.map((_, index) => index + 1));
      expect(WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS).toHaveLength(WORKSTREAM_OBJECT_SCHEMA_VERSION);

      const tables = database.prepare(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      ).all().map((row) => String(row.name));
      expect(tables).toEqual(EXPECTED_TABLES);
      const strictness = database.prepare("PRAGMA table_list").all()
        .filter((row) => row.schema === "main" && EXPECTED_TABLES.includes(String(row.name) as never))
        .map((row) => ({ name: String(row.name), strict: Number(row.strict) }));
      expect(strictness).toHaveLength(EXPECTED_TABLES.length);
      expect(strictness.every((table) => table.strict === 1)).toBe(true);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare(
        `SELECT worker_version_id, contract_version, schema_version
           FROM object_versions WHERE id = 1`,
      ).get()).toEqual({
        worker_version_id: "worker-two",
        contract_version: 1,
        schema_version: WORKSTREAM_OBJECT_SCHEMA_VERSION,
      });
      expect(database.prepare("SELECT COUNT(*) AS count FROM _sql_schema_migrations").get())
        .toEqual({ count: WORKSTREAM_OBJECT_SCHEMA_VERSION });

      const widestTable = tables.reduce((widest, table) => {
        const columnCount = database.prepare(`PRAGMA table_info("${table}")`).all().length;
        return columnCount > widest.columnCount ? { table, columnCount } : widest;
      }, { table: "", columnCount: 0 });
      expect(widestTable.columnCount).toBeLessThanOrEqual(100);
      for (const migration of WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS) {
        for (const statement of migration.statements) {
          expect(new TextEncoder().encode(statement).byteLength).toBeLessThanOrEqual(100_000);
        }
      }
    } finally {
      database.close();
    }
  });

  it("keeps accepted restricted suggestions contained across direct audience writes", () => {
    const database = new DatabaseSync(":memory:");
    const storage = objectStorage(database);
    try {
      applyWorkstreamObjectSchema(storage, "worker-one", 1_000);
      database.prepare(
        `INSERT INTO workstream
           (id, workstream_key, parent_workspace_key, region, authority_mode,
            authority_generation, title, description, scope, exact_state,
            state_reason_code, next_sequence_number, next_attention_ordinal,
            authority_epoch, scope_epoch, source_authorization_floor, listing_epoch,
            deletion_epoch, run_revision, created_at, last_people_activity_at,
            state_changed_at, updated_at)
         VALUES (1, ?, ?, 'global', 'authoritative', 1, '', '', 'personal', 'idle',
                 'test', 1, 1, 1, 0, 0, 1, 0, 1, 1000, 1000, 1000, 1000)`,
      ).run(WORKSTREAM_ID, WORKSPACE_ID);
      database.prepare(
        `INSERT INTO participants
           (user_id, participation_reason, added_by_user_id, status,
            participant_epoch, added_at, removed_at, updated_at)
         VALUES (?, 'creator', ?, 'active', 1, 1000, NULL, 1000)`,
      ).run(AUTHOR_ID, AUTHOR_ID);
      database.prepare(
        `INSERT INTO suggested_actions
           (action_id, version, source_activity_id, delivery_id, audience_kind,
            audience_user_id, provenance_ref, authorization_selector_hash,
            source_revisions_json, source_authorization_epoch, display_title,
            display_body, status, created_at, expires_at, share_intent_json)
         VALUES (?, 1, 'activity', 'restricted-delivery', 'workstream', NULL,
                 'activity:1', 'selector', '[]', 0, 'Private title', 'Private body',
                 'pending', 1000, 2000, ?)`,
      ).run(RECIPIENT_ID, JSON.stringify({
        sourceAudience: { scope: "users", userIds: [AUTHOR_ID] },
      }));
      database.prepare(
        `UPDATE suggested_actions SET status = 'accepted', resolved_at = 1500,
                resolved_by_user_id = ?, resolution_client_id = 'accept-restricted'
          WHERE action_id = ?`,
      ).run(AUTHOR_ID, RECIPIENT_ID);

      expect(() => database.prepare(
        `UPDATE suggested_actions SET share_intent_json = ? WHERE action_id = ?`,
      ).run(JSON.stringify({ sourceAudience: { scope: "workspace" } }), RECIPIENT_ID))
        .toThrow("accepted_suggestion_source_audience_immutable");
      expect(() => database.prepare(
        `DELETE FROM suggested_actions WHERE action_id = ?`,
      ).run(RECIPIENT_ID)).toThrow("accepted_suggestion_source_audience_immutable");
      expect(() => database.prepare(
        `INSERT INTO participants
           (user_id, participation_reason, added_by_user_id, status,
            participant_epoch, added_at, removed_at, updated_at)
         VALUES (?, 'explicit', ?, 'active', 1, 1600, NULL, 1600)`,
      ).run(OUTSIDER_ID, AUTHOR_ID)).toThrow("workstream_audience_restricted_content");
      expect(() => database.prepare(
        `UPDATE workstream SET scope = 'workspace', scope_epoch = scope_epoch + 1
          WHERE id = 1`,
      ).run()).toThrow("workstream_audience_restricted_content");

      expect(database.prepare(
        `SELECT user_id FROM participants WHERE status = 'active' ORDER BY user_id`,
      ).all()).toEqual([{ user_id: AUTHOR_ID }]);
      expect(database.prepare("SELECT scope FROM workstream WHERE id = 1").get())
        .toEqual({ scope: "personal" });
    } finally {
      database.close();
    }
  });

  it("retires the reader-less cutover tables on an object that already holds rows in them", () => {
    const database = new DatabaseSync(":memory:");
    const storage = objectStorage(database);
    try {
      // Stop one migration short of the drop, so the tables exist exactly as
      // they do on a deployed object rather than being created and removed in
      // the same bootstrap transaction a fresh object runs.
      applyDurableObjectSqliteMigrations({
        storage,
        migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.filter((migration) => migration.version < 12),
        component: "workstream",
        workerVersionId: "worker-before",
        now: 1_000,
      });
      const retired = ["_data_migrations", "_migration_command_receipts", "compaction_jobs", "terminal_commands"];
      const present = () => database.prepare(
        `SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (?, ?, ?, ?) ORDER BY name`,
      ).all(...retired).map((row) => String(row.name));
      expect(present()).toEqual(retired);

      // A drop of an empty table proves nothing about a populated one: SQLite
      // refuses to drop a table another row still references, and these two
      // carry the campaign and command rows a real object would hold.
      database.prepare(
        `INSERT INTO _data_migrations
           (campaign_id, target_version, phase, status, attempts, updated_at)
         VALUES ('campaign', 1, 'copy', 'running', 0, 1000)`,
      ).run();
      database.prepare(
        `INSERT INTO _migration_command_receipts
           (command_id, campaign_id, command_kind, request_hash, result_hash, result_code, completed_at)
         VALUES ('command', 'campaign', 'copy', 'req', 'res', 'ok', 1000)`,
      ).run();

      applyWorkstreamObjectSchema(storage, "worker-after", 2_000);

      expect(present()).toEqual([]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare(
        "SELECT schema_version FROM object_versions WHERE id = 1",
      ).get()).toEqual({ schema_version: WORKSTREAM_OBJECT_SCHEMA_VERSION });
      // The surviving compaction authority is untouched by the sibling drop.
      expect(database.prepare("SELECT COUNT(*) AS count FROM compaction_checkpoints").get())
        .toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("carries a Terminal lifecycle blob into real columns when version 12 applies", () => {
    const database = new DatabaseSync(":memory:");
    const storage = objectStorage(database);
    try {
      // Stop before the promotion so the row exists in the shape a deployed
      // object holds it: epoch columns for the two the table already had, and
      // ISO-8601 strings inside `lifecycle_json` for the nine it did not.
      applyDurableObjectSqliteMigrations({
        storage,
        migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.filter((migration) => migration.version < 12),
        component: "workstream",
        workerVersionId: "worker-before",
        now: 1_000,
      });
      database.prepare(
        `INSERT INTO terminal_workspace
           (id, provider, sandbox_id, lifecycle_state, authority_epoch, last_command_at,
            idle_expires_at, created_at, updated_at, generation, stable_name,
            applied_network_revision, version, lifecycle_json)
         VALUES (1, 'daytona', 'daytona-1', 'stopped', 4, ?, ?, ?, ?, 3, 'sandbox', 1, 4, ?)`,
      ).run(
        Date.parse("2026-08-17T12:00:00.000Z"),
        Date.parse("2026-08-17T12:05:00.000Z"),
        Date.parse("2026-08-17T11:00:00.000Z"),
        Date.parse("2026-08-17T12:00:00.000Z"),
        JSON.stringify({
          authorityFingerprint: "authority",
          operationRunId: RUN_ID,
          operationLeaseExpiresAt: "2026-08-17T12:16:00.000Z",
          lifecycleClaimId: null,
          lifecycleClaimExpiresAt: null,
          archiveDueAt: "2026-08-17T13:00:00.000Z",
          expireDueAt: "2026-09-16T12:00:00.000Z",
          finalDiffResourceId: "resource-1",
          failureCode: null,
        }),
      );

      applyWorkstreamObjectSchema(storage, "worker-after", 2_000);

      expect(database.prepare(
        `SELECT authority_fingerprint, operation_run_id, operation_lease_expires_at,
                lifecycle_claim_id, lifecycle_claim_expires_at, archive_due_at,
                expire_due_at, final_diff_resource_id, failure_code, generation
           FROM terminal_workspace WHERE id = 1`,
      ).get()).toEqual({
        authority_fingerprint: "authority",
        operation_run_id: RUN_ID,
        // The deadlines were ISO-8601 inside the blob and are epoch
        // milliseconds as columns. A rounding error here would move an alarm.
        operation_lease_expires_at: Date.parse("2026-08-17T12:16:00.000Z"),
        lifecycle_claim_id: null,
        lifecycle_claim_expires_at: null,
        archive_due_at: Date.parse("2026-08-17T13:00:00.000Z"),
        expire_due_at: Date.parse("2026-09-16T12:00:00.000Z"),
        final_diff_resource_id: "resource-1",
        failure_code: null,
        generation: 3,
      });
      // `authority_epoch` and the blob are both gone; nothing read the former
      // and nothing may reach the latter again.
      const columns = database.prepare(`PRAGMA table_info(terminal_workspace)`)
        .all().map((column) => String(column.name));
      expect(columns).not.toContain("lifecycle_json");
      expect(columns).not.toContain("authority_epoch");
      // The compatibility views the blob existed for are gone with it.
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM sqlite_schema
          WHERE name LIKE '_runtime_terminal%' OR name LIKE '_runtime_repository_publications%'`,
      ).get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("enforces substream, semantic-part, and suggested-action shapes in SQLite", () => {
    const database = new DatabaseSync(":memory:");
    const storage = objectStorage(database);
    try {
      applyWorkstreamObjectSchema(storage, "worker-one", 1_000);
      database.prepare(
        `INSERT INTO workstream
           (id, workstream_key, parent_workspace_key, region, authority_mode,
            authority_generation, title, description, scope, exact_state,
            state_reason_code, next_sequence_number, next_attention_ordinal,
            authority_epoch, scope_epoch, source_authorization_floor, listing_epoch,
            deletion_epoch, run_revision, created_at, last_people_activity_at,
            state_changed_at, updated_at)
         VALUES (1, ?, ?, 'global', 'authoritative', 1, '', '', 'workspace', 'idle',
                 'test', 1, 1, 1, 0, 0, 1, 0, 1, 1000, 1000, 1000, 1000)`,
      ).run(WORKSTREAM_ID, WORKSPACE_ID);
      database.prepare(
        `INSERT INTO substreams
           (id, kind, inherit_mode, inherit_from_substream_id, inherit_fence_seq,
            depth, return_mode, origin_part_id, owner_user_id, audience,
            tool_policy, status, created_at, closed_at)
         VALUES ('0', 'main', 'none', NULL, NULL, 0, 'none', NULL, NULL,
                 'workspace', 'full', 'open', 1000, NULL)`,
      ).run();

      expect(() => database.prepare(
        `INSERT INTO substreams
           (id, kind, inherit_mode, inherit_from_substream_id, inherit_fence_seq,
            depth, return_mode, origin_part_id, owner_user_id, audience,
            tool_policy, status, created_at, closed_at)
         VALUES ('not-main', 'main', 'none', NULL, NULL, 0, 'none', NULL, NULL,
                 'workspace', 'full', 'open', 1000, NULL)`,
      ).run()).toThrow();
      expect(() => database.prepare(
        `INSERT INTO parts
           (id, substream_id, sequence_number, role, kind, author_type, content,
            visibility, pinned, created_at, updated_at)
         VALUES (?, '0', 1, 'assistant', 'tool_call', 'agent', '',
                 'people', 0, 1000, 1000)`,
      ).run(MESSAGE_ID)).toThrow();
      expect(() => database.prepare(
        `INSERT INTO suggested_actions
           (action_id, version, source_activity_id, delivery_id, audience_kind,
            audience_user_id, provenance_ref, authorization_selector_hash,
            source_revisions_json, source_authorization_epoch, display_title,
            display_body, status, created_at, expires_at)
         VALUES (?, 1, 'activity', 'delivery', 'workstream', NULL, 'activity:1',
                 'selector', '[]', 0, 'Title', 'Body', 'accepted', 1000, 2000)`,
      ).run(RECIPIENT_ID)).toThrow();

      database.prepare(
        `INSERT INTO suggested_actions
           (action_id, version, source_activity_id, delivery_id, audience_kind,
            audience_user_id, provenance_ref, authorization_selector_hash,
            source_revisions_json, source_authorization_epoch, display_title,
            display_body, status, created_at, expires_at)
         VALUES (?, 1, 'activity', 'delivery-valid', 'workstream', NULL, 'activity:1',
                 'selector', '[]', 0, 'Title', 'Body', 'pending', 1000, 2000)`,
      ).run(RECIPIENT_ID);
      database.prepare(
        `UPDATE suggested_actions SET status = 'accepted', resolved_at = 1500,
                resolved_by_user_id = ?, resolution_client_id = 'accept-once'
          WHERE action_id = ?`,
      ).run(AUTHOR_ID, RECIPIENT_ID);
      expect(() => database.prepare(
        `UPDATE suggested_actions SET status = 'pending', resolved_at = NULL,
                resolved_by_user_id = NULL, resolution_client_id = NULL
          WHERE action_id = ?`,
      ).run(RECIPIENT_ID)).toThrow("suggested_action_terminal_status_immutable");
    } finally {
      database.close();
    }
  });

  // `projects the generic runtime's stopped settlement as stopped` was here.
  // It covered migration 12's compat projection: the shared runtime could only
  // write `idle` through the retired view, because D1's harness-status CHECK
  // had no `stopped`, and the object read the already-cancelled latest run as
  // evidence that this particular idle meant a user stop. Migration 26 retires
  // that view and every writer reaches the harness-run authority directly, so
  // there is no longer a projection to test — the run's own status is what a
  // reader sees.

  it("refuses a changed implementation under an already-applied schema version", () => {
    const database = new DatabaseSync(":memory:");
    const storage = objectStorage(database);
    try {
      applyWorkstreamObjectSchema(storage, "worker-one");
      database.prepare(
        `UPDATE _sql_schema_migrations SET implementation_hash = 'changed' WHERE version = 1`,
      ).run();

      expect(() => applyWorkstreamObjectSchema(storage, "worker-two"))
        .toThrow("substream_agent_do_schema_hash_mismatch:1");
    } finally {
      database.close();
    }
  });

  it("makes a re-add through the identity authority unseen again", () => {
    const database = new DatabaseSync(":memory:");
    const storage = objectStorage(database);
    try {
      applyWorkstreamObjectSchema(storage, "worker-one", 1_000);
      database.prepare(
        `INSERT INTO workstream
           (id, workstream_key, parent_workspace_key, region, authority_mode,
            authority_generation, title, description, scope, exact_state,
            state_reason_code, next_sequence_number, next_attention_ordinal,
            authority_epoch, scope_epoch, source_authorization_floor, listing_epoch,
            deletion_epoch, run_revision, created_at, last_people_activity_at,
            state_changed_at, updated_at)
         VALUES (1, ?, ?, 'global', 'authoritative', 1, 'Local', 'Object owned',
                 'workspace', 'scheduled', 'test', 1, 1, 1, 0, 0, 1, 0, 1,
                 1000, 1000, 1000, 1000)`,
      ).run(WORKSTREAM_ID, WORKSPACE_ID);
      // Somebody who is in the work stream and has opened it.
      database.prepare(
        `INSERT INTO participants
           (user_id, participation_reason, added_by_user_id, status, participant_epoch,
            added_at, removed_at, first_opened_at, updated_at)
         VALUES (?, 'explicit', ?, 'active', 0, 1000, NULL, 2000, 2000)`,
      ).run(AUTHOR_ID, AUTHOR_ID);

      const readBack = () => database.prepare(
        `SELECT status, participant_epoch, first_opened_at FROM participants WHERE user_id = ?`,
      ).get(AUTHOR_ID) as { status: string; participant_epoch: number; first_opened_at: number | null };

      // Removed, then re-admitted the way `admitConnectorAudience` does it.
      // The retired participant view's INSTEAD OF triggers used to reactivate
      // the row; `admitParticipant` is what does it now, and this is the
      // behaviour that had to survive the view being dropped.
      const identity = new WorkstreamIdentityStorage(storage);
      database.prepare(
        `UPDATE participants SET status = 'removed', removed_at = 3000 WHERE user_id = ?`,
      ).run(AUTHOR_ID);
      expect(identity.admitParticipant({
        userId: AUTHOR_ID,
        addedByUserId: AUTHOR_ID,
        reason: "explicit",
        now: 4000,
      })).toEqual({ outcome: "readmitted" });

      const afterReadmit = readBack();
      expect(afterReadmit.status).toBe("active");
      // The epoch says a new participation began; the marker has to agree.
      expect(afterReadmit.participant_epoch).toBe(1);
      expect(afterReadmit.first_opened_at).toBeNull();

      // Being removed is not being shown it again: the reset belongs to one
      // direction of the transition, not to both. A second admission of
      // somebody already seated changes nothing at all.
      database.prepare(
        `UPDATE participants SET first_opened_at = 6000 WHERE user_id = ?`,
      ).run(AUTHOR_ID);
      expect(identity.admitParticipant({
        userId: AUTHOR_ID,
        addedByUserId: AUTHOR_ID,
        reason: "explicit",
        now: 7000,
      })).toEqual({ outcome: "unchanged" });
      expect(readBack().first_opened_at).toBe(6000);

    } finally {
      database.close();
    }
  });

  it("serves legacy runtime SQL from normalized object-local tables", () => {
    const database = new DatabaseSync(":memory:");
    const storage = objectStorage(database);
    try {
      applyWorkstreamObjectSchema(storage, "worker-one", 1_000);
      database.prepare(
        `INSERT INTO workstream
           (id, workstream_key, parent_workspace_key, region, authority_mode,
            authority_generation, title, description, scope, exact_state,
            state_reason_code, next_sequence_number, next_attention_ordinal,
            authority_epoch, scope_epoch, source_authorization_floor, listing_epoch,
            deletion_epoch, run_revision, created_at, last_people_activity_at,
            state_changed_at, updated_at)
         VALUES (1, ?, ?, 'global', 'authoritative', 1, 'Local', 'Object owned',
                 'workspace', 'scheduled', 'test', 1, 1, 1, 0, 0, 1, 0, 1,
                 1000, 1000, 1000, 1000)`,
      ).run(WORKSTREAM_ID, WORKSPACE_ID);
      database.prepare(
        `INSERT INTO substreams
           (id, kind, inherit_mode, inherit_from_substream_id, inherit_fence_seq,
            depth, return_mode, origin_part_id, owner_user_id, audience,
            tool_policy, status, created_at, closed_at)
         VALUES ('0', 'main', 'none', NULL, NULL, 0, 'none', NULL, NULL,
                 'workspace', 'full', 'open', 1000, NULL)`,
      ).run();
      database.prepare(rewriteWorkstreamRuntimeSql(
        `INSERT INTO harness_runs
           (id, workspace_id, workstream_id, origin, execution_principal_json,
            status, model, created_at)
         VALUES (?, ?, ?, 'opening_message', ?, 'scheduled', 'test-model', ?)`,
      )).run(RUN_ID, WORKSPACE_ID, WORKSTREAM_ID, JSON.stringify({
        type: "workspace",
        workspaceId: WORKSPACE_ID,
      }), "2026-08-17T12:00:00.000Z");
      database.prepare(rewriteWorkstreamRuntimeSql(
        `INSERT INTO messages
           (id, client_message_id, workspace_id, workstream_id, author_type,
            message_type, text_content, sequence_number, harness_run_id, created_at)
         VALUES (?, 'runtime-message', ?, ?, 'agent', 'text', 'hello', 1, ?, ?)`,
      )).run(MESSAGE_ID, WORKSPACE_ID, WORKSTREAM_ID, RUN_ID, "2026-08-17T12:00:01.000Z");
      // Terminal is deliberately absent here. Its tables left the legacy
      // vocabulary in schema version 12: the services hold a typed port onto
      // `terminal_workspace` and friends, so there is no compatibility view
      // left for a `workstream_sandboxes` statement to be rewritten onto.
      //
      // So is the scheduling slice, and for the same reason: version 20 dropped
      // the wake-up, compaction, description-refresh and plugin-hint views, so
      // a `workstream_context_compactions` statement has nothing to be
      // rewritten onto either. What that slice writes is proved against a real
      // object store in `workstream-resource-inventory.test.ts` — the fence
      // refusing a write, the fenced and unfenced reads, and the principal
      // scoping — rather than against a statement's bindings.

      expect(database.prepare("SELECT run_id, status FROM runs").get()).toEqual({
        run_id: RUN_ID,
        status: "admitted",
      });
      expect(database.prepare("SELECT id, content FROM parts").get()).toEqual({
        id: MESSAGE_ID,
        content: "hello",
      });
    } finally {
      database.close();
    }
  });

  it("pins one external work-stream identity to each existing Durable Object", async () => {
    const database = new DatabaseSync(":memory:");
    const store = new WorkstreamObjectStore(objectStorage(database), "worker-one", "global");
    try {
      await store.waitUntilReady();
      store.ensureIdentity({ workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID }, "global");

      expect(() => store.ensureIdentity({
        workspaceId: WORKSPACE_ID,
        workstreamId: asWorkstreamId("00000000-0000-7000-8000-0000000000ff"),
      }, "global")).toThrow("workstream_object_identity_mismatch");
    } finally {
      database.close();
    }
  });


  it("checkpoints live output in bounded relational chunks and clears it at terminal state", async () => {
    const database = new DatabaseSync(":memory:");
    const store = new WorkstreamObjectStore(objectStorage(database), "worker-one", "eu");
    try {
      await store.waitUntilReady();
      store.ensureIdentity({ workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID }, "eu");
      const at = "2026-08-16T12:00:00.000Z";
      store.commitRealtimeEvent(ServerSocketEventSchema.parse({
        type: "stream_started",
        sequence: 0,
        occurredAt: at,
        messageId: MESSAGE_ID,
        harnessRunId: RUN_ID,
        turnId: "turn-one",
        epoch: 0,
        streamSeq: 0,
        reset: false,
      }));
      store.commitRealtimeEvent(ServerSocketEventSchema.parse({
        type: "stream_delta",
        sequence: 0,
        occurredAt: at,
        messageId: MESSAGE_ID,
        harnessRunId: RUN_ID,
        turnId: "turn-one",
        epoch: 0,
        streamSeq: 1,
        reset: false,
        delta: `${"a".repeat(70_000)}😀`,
      }));

      expect(store.activeStreamCheckpoints()[0]?.text).toBe(`${"a".repeat(70_000)}😀`);
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM active_output_chunks`,
      ).get()).toEqual({ count: 2 });
      expect(database.prepare(
        `SELECT MAX(byte_length) AS bytes FROM active_output_chunks`,
      ).get()).toEqual({ bytes: 60 * 1024 });

      store.commitRealtimeEvent(ServerSocketEventSchema.parse({
        type: "compaction_started",
        sequence: 0,
        occurredAt: at,
        compaction: {
          harnessRunId: RUN_ID,
          attemptId: ATTEMPT_ID,
          compactionIndex: 1,
          trigger: "auto",
          startedAt: at,
        },
      }));
      expect(store.activeCompaction()).toEqual({
        harnessRunId: RUN_ID,
        attemptId: ATTEMPT_ID,
        compactionIndex: 1,
        trigger: "auto",
        startedAt: at,
      });
      store.commitRealtimeEvent(ServerSocketEventSchema.parse({
        type: "compaction_started",
        sequence: 0,
        occurredAt: at,
        compaction: {
          harnessRunId: RUN_ID,
          attemptId: RECOVERED_ATTEMPT_ID,
          compactionIndex: 1,
          trigger: "manual",
          startedAt: at,
        },
      }));
      store.commitRealtimeEvent(ServerSocketEventSchema.parse({
        type: "compaction_finished",
        sequence: 0,
        occurredAt: at,
        harnessRunId: RUN_ID,
        attemptId: ATTEMPT_ID,
        compactionIndex: 1,
        outcome: "completed",
      }));
      expect(store.activeCompaction()).toMatchObject({
        attemptId: RECOVERED_ATTEMPT_ID,
        compactionIndex: 1,
      });

      // One model response can finish before the agent loop. Its active turn is
      // therefore gone when the later run-level terminal status arrives.
      database.prepare("DELETE FROM active_output_turns").run();
      store.commitRealtimeEvent(ServerSocketEventSchema.parse({
        type: "harness_status_changed",
        sequence: 0,
        occurredAt: at,
        status: "completed",
      }));
      expect(store.activeStreamCheckpoints()).toEqual([]);
      expect(store.activeCompaction()).toBeNull();
      expect(database.prepare("SELECT status FROM runs WHERE run_id = ?").get(RUN_ID))
        .toEqual({ status: "completed" });
    } finally {
      database.close();
    }
  });

  it("projects a stopped realtime event to the cancelled durable run state", async () => {
    const database = new DatabaseSync(":memory:");
    const store = new WorkstreamObjectStore(objectStorage(database), "worker-one", "global");
    try {
      await store.waitUntilReady();
      store.ensureIdentity({ workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID }, "global");
      const at = "2026-08-21T03:00:00.000Z";
      store.commitRealtimeEvent(ServerSocketEventSchema.parse({
        type: "stream_started",
        sequence: 0,
        occurredAt: at,
        messageId: MESSAGE_ID,
        harnessRunId: RUN_ID,
        turnId: "turn-stopped",
        epoch: 0,
        streamSeq: 0,
        reset: false,
      }));
      database.prepare("DELETE FROM active_output_turns").run();
      store.commitRealtimeEvent(ServerSocketEventSchema.parse({
        type: "harness_status_changed",
        sequence: 0,
        occurredAt: at,
        status: "stopped",
      }));

      expect(database.prepare(
        "SELECT status, terminal_reason FROM runs WHERE run_id = ?",
      ).get(RUN_ID)).toEqual({ status: "cancelled", terminal_reason: "cancelled" });
    } finally {
      database.close();
    }
  });
});
