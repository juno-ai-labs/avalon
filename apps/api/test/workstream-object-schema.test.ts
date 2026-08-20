import { DatabaseSync } from "node:sqlite";
import { ServerSocketEventSchema } from "@avalon/contracts";
import { describe, expect, it } from "vitest";

import {
  applyWorkstreamObjectSchema,
  WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
  WORKSTREAM_OBJECT_SCHEMA_VERSION,
} from "../src/durable-objects/workstream-object-schema";
import { WorkstreamObjectStore } from "../src/durable-objects/workstream-object-storage";
import { rewriteWorkstreamRuntimeSql } from "../src/durable-objects/workstream-runtime-sql";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";

const WORKSPACE_ID = "00000000-0000-7000-8000-0000000000a1";
const WORKSTREAM_ID = "00000000-0000-7000-8000-0000000000a2";
const RUN_ID = "00000000-0000-7000-8000-0000000000a3";
const MESSAGE_ID = "00000000-0000-7000-8000-0000000000a4";
const RECIPIENT_ID = "00000000-0000-7000-8000-0000000000a6";
const AUTHOR_ID = "00000000-0000-7000-8000-0000000000a7";
const ATTEMPT_ID = "00000000-0000-7000-8000-0000000000a8";
const RECOVERED_ATTEMPT_ID = "00000000-0000-7000-8000-0000000000a9";

const EXPECTED_TABLES = [
  "_data_migrations",
  "_migration_command_receipts",
  "_runtime_statement_changes",
  "_sql_schema_migrations",
  "active_agent_compaction",
  "active_output_chunks",
  "active_output_turns",
  "agent_run_dispatches",
  "attachment_tool_receipts",
  "block_dashboard_block_runs",
  "block_dashboard_configuration_versions",
  "block_dashboard_user_preferences",
  "compaction_checkpoints",
  "compaction_jobs",
  "content_refs",
  "description_refresh_state",
  "due_work",
  "durable_inbox_receipts",
  "durable_outbox",
  "elicitation_requests",
  "inference_attempts",
  "member_attention",
  "object_versions",
  "part_attachments",
  "part_mentions",
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
  "terminal_commands",
  "terminal_imported_resources",
  "terminal_publication_grants",
  "terminal_repository",
  "terminal_tasks",
  "terminal_workspace",
  "tool_effect_checkpoints",
  "tool_effects",
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

      expect(WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS).toHaveLength(1);
      expect(WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS[0]?.version).toBe(1);

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

  it("refuses a changed implementation under an already-applied schema version", () => {
    const database = new DatabaseSync(":memory:");
    const storage = objectStorage(database);
    try {
      applyWorkstreamObjectSchema(storage, "worker-one");
      database.prepare(
        `UPDATE _sql_schema_migrations SET implementation_hash = 'changed' WHERE version = 1`,
      ).run();

      expect(() => applyWorkstreamObjectSchema(storage, "worker-two"))
        .toThrow("workstream_schema_hash_mismatch:1");
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
      for (const compactedThroughSequence of [1, 2]) {
        database.prepare(rewriteWorkstreamRuntimeSql(
          `INSERT INTO workstream_context_compactions
             (workstream_id, workspace_id, harness_run_id, compacted_through_sequence,
              messages_json, summary, checkpoint_template_version, execution_principal_key,
              resource_visibility_fingerprint, model, context_tokens_before_compaction,
              context_window_tokens, input_tokens, output_tokens, cost_microusd,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, '[]', ?, 1, ?, 'inventory:0', 'test-model',
                   100, 200000, 80, 20, 1, ?, ?)`,
        )).run(
          WORKSTREAM_ID,
          WORKSPACE_ID,
          RUN_ID,
          compactedThroughSequence,
          `summary-${compactedThroughSequence}`,
          `workspace:${WORKSPACE_ID}`,
          `2026-08-17T12:00:0${compactedThroughSequence}.000Z`,
          `2026-08-17T12:00:0${compactedThroughSequence}.000Z`,
        );
      }
      database.prepare(rewriteWorkstreamRuntimeSql(
        `INSERT INTO workstream_sandboxes
           (workspace_id, workstream_id, state, stable_name, provider_sandbox_id,
            generation, authority_fingerprint, applied_network_revision, version,
            last_activity_at, created_at, updated_at)
         VALUES (?, ?, 'running', 'sandbox', 'daytona-1', 1, 'authority', 1, 1, ?, ?, ?)`,
      )).run(
        WORKSPACE_ID,
        WORKSTREAM_ID,
        "2026-08-17T12:00:02.000Z",
        "2026-08-17T12:00:02.000Z",
        "2026-08-17T12:00:02.000Z",
      );

      expect(database.prepare("SELECT run_id, status FROM runs").get()).toEqual({
        run_id: RUN_ID,
        status: "admitted",
      });
      expect(database.prepare("SELECT id, content FROM parts").get()).toEqual({
        id: MESSAGE_ID,
        content: "hello",
      });
      expect(database.prepare("SELECT COUNT(*) AS count FROM compaction_checkpoints").get())
        .toEqual({ count: 2 });
      expect(database.prepare(
        "SELECT sandbox_id, lifecycle_state FROM terminal_workspace WHERE id = 1",
      ).get()).toEqual({ sandbox_id: "daytona-1", lifecycle_state: "running" });
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
        workstreamId: "00000000-0000-7000-8000-0000000000ff",
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
});
