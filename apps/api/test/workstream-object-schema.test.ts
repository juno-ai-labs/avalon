import "../../../tests/isolated-region";
import { asWorkspaceId } from "@rally/contracts";
import { asWorkstreamId } from "@rally/contracts";
import { DatabaseSync } from "node:sqlite";
import { ServerSocketEventSchema } from "@rally/contracts";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import {
  applyWorkstreamObjectSchema,
  WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
  WORKSTREAM_OBJECT_SCHEMA_VERSION,
} from "../src/durable-objects/workstream-object-schema";
import { WorkstreamIdentityStorage } from "../src/durable-objects/workstream-identity-storage";
import { substreamLoopId } from "../src/durable-objects/names";
import { WorkstreamObjectStore } from "../src/durable-objects/workstream-object-storage";
import { SubstreamLoopStorage } from "../src/durable-objects/substream-loop-storage";
import { WorkstreamHarnessRunStorage } from "../src/durable-objects/workstream-harness-run-storage";
import {
  applyDurableObjectSqliteMigrations,
  durableObjectMigrationHash,
} from "../src/durable-objects/sqlite-migrations";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { seedWorkstreamObjectRoot, seedWorkstreamRun } from "./helpers/durable-authority";
import { createTestSqlStorage } from "./helpers/sql-storage";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000000a1");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-0000000000a2");
const RUN_ID = "00000000-0000-7000-8000-0000000000a3";
const MESSAGE_ID = "00000000-0000-7000-8000-0000000000a4";
const RECIPIENT_ID = "00000000-0000-7000-8000-0000000000a6";
const AUTHOR_ID = "00000000-0000-7000-8000-0000000000a7";
const ATTEMPT_ID = "00000000-0000-7000-8000-0000000000a8";
const RECOVERED_ATTEMPT_ID = "00000000-0000-7000-8000-0000000000a9";

function activateRealtimeExecution(
  storage: DurableObjectStorage,
  now: number,
  options: { linkPersistentLoop?: boolean } = {},
): void {
  const runs = new WorkstreamHarnessRunStorage(storage);
  expect(runs.admitRun({
    runId: RUN_ID,
    origin: "member_message",
    executionPrincipalJson: JSON.stringify({ type: "user", userId: AUTHOR_ID }),
    status: "running",
    startedAt: now,
    model: "test/model",
    triggerPartId: null,
    parentRunId: null,
    expectedLatestRunId: null,
    now,
  })).toEqual({ outcome: "admitted" });
  expect(runs.claimAttempt({
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    owner: "realtime-test-owner",
    leaseSeconds: 60,
    lifecycleEventId: `claim:${RUN_ID}`,
    now,
  }).outcome).toBe("claimed");
  storage.sql.exec(
    `UPDATE runs SET execution_context_json = '{"kind":"realtime_test"}' WHERE run_id = ?`,
    RUN_ID,
  );
  if (options.linkPersistentLoop !== false) {
    const loops = new SubstreamLoopStorage(storage);
    const loopId = substreamLoopId(WORKSTREAM_ID);
    loops.ensureLoop({ loopId, bindStateRevision: 0, now });
    expect(loops.activateExecutionReceipt({
      runId: RUN_ID,
      loopId,
      expectedLoopRevision: loops.loop()!.revision,
      expectedBindStateRevision: 0,
      executionEpoch: 1,
      leaseOwner: "realtime-test-owner",
      leaseExpiresAt: now + 60_000,
      now,
    }).outcome).toBe("activated");
  }
}

const EXPECTED_TABLES = [
  "_internal_durable_alarms",
  "_sql_schema_migrations",
  "active_agent_compaction",
  "active_output_chunks",
  "active_output_turns",
  "assistant_turn_reservations",
  "attachment_tool_receipts",
  "authorization_projection_outbox",
  "background_agent",
  "bind_activation_inputs",
  "bind_loop_heads",
  "bind_loop_state_messages",
  "bind_provider_boundaries",
  "content_audience_fences",
  "content_refs",
  "conversation_search_links",
  "conversation_suggestions",
  "conversation_view_changes",
  "conversation_view_clock",
  "delivered_loop_inputs",
  "description_refresh_state",
  "desktop_actions",
  "due_work",
  "durable_inbox_receipts",
  "durable_outbox",
  "elicitation_requests",
  "imported_session_messages",
  "imported_session_sources",
  "imported_session_update_receipts",
  "inference_attempts",
  "inference_delay_status",
  "member_attention",
  "memory_digest_copies",
  "memory_sweep_state",
  "object_retirement",
  "object_versions",
  "participant_authority_transfer",
  "participant_projection_revisions",
  "participant_transcript_attachments",
  "participant_transcript_blocks",
  "participant_transcript_mentions",
  "participant_transcript_turns",
  "participants",
  "pending_attachment_reservation_recovery",
  "pending_loop_input_mailbox",
  "pending_loop_inputs",
  "personal_system_prompt_copies",
  "plugin_activation_hints",
  "prepared_conversation_receipts",
  "private_child_lifecycle_authority",
  "private_child_membership_authority",
  "projection_keys",
  "realtime_state",
  "repository_publications",
  "resident_context_blocks",
  "resident_context_compactions",
  "resource_inventory_revision",
  "retired_meeting_attachment_ids",
  "run_absorbed_slack_origins",
  "run_lifecycle_events",
  "run_plugin_activations",
  "run_scopes",
  "runs",
  "sidekick_attachments",
  "sidekick_execution_skills",
  "sidekick_skill_names",
  "substream_agent_identity",
  "substream_context_captures",
  "substream_initial_context",
  "substream_loops",
  "substreams",
  "terminal_imported_resources",
  "terminal_provider_observation",
  "terminal_publication_grants",
  "terminal_repository",
  "terminal_tasks",
  "terminal_workspace",
  "tool_effect_checkpoints",
  "tool_effects",
  "tool_pages",
  "transcript_activities",
  "transcript_activity_intervals",
  "transcript_compaction_checkpoints",
  "transcript_counters",
  "transcript_facts",
  "transcript_payloads",
  "turn_disposition_judgements",
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
  let warn: MockInstance;

  it("preserves existing suggestions when upgrading to resolution suggestions", () => {
    const database = new DatabaseSync(":memory:");
    const storage = objectStorage(database);
    try {
      applyDurableObjectSqliteMigrations({ storage,
        migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 78),
        component: "substream_agent_do", workerVersionId: "before-resolution", now: 1 });
      storage.sql.exec(`INSERT INTO conversation_suggestions
        (suggestion_id, kind, judged_turn_id, judged_turn_sequence, run_id, status, draft_status,
         draft_text, decision_choice, decision_confidence, decision_model, created_at)
        VALUES ('existing', 'merge_up', 'turn-1', 1, 'run-1', 'open', 'ready', 'Keep the discount.',
          'worth_carrying_up', 0.9, 'jev-test', 1)`);
      applyWorkstreamObjectSchema(storage, "with-resolution", 2);
      expect(storage.sql.exec("SELECT kind, status, draft_text FROM conversation_suggestions").toArray())
        .toEqual([{ kind: "merge_up", status: "open", draft_text: "Keep the discount." }]);
      expect(() => storage.sql.exec(`INSERT INTO conversation_suggestions
        SELECT 'duplicate', kind, judged_turn_id, judged_turn_sequence, 'another-run', status,
          draft_status, draft_text, draft_subject, target_kind, target_id, target_title,
          decision_choice, decision_confidence, decision_model, created_at, resolved_at,
          resolved_by_user_id, resolution, accepting_by_user_id FROM conversation_suggestions WHERE suggestion_id = 'existing'`))
        .toThrow(/UNIQUE/);
    } finally { database.close(); }
  });

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("keeps every shipped migration fingerprint through v32 immutable", () => {
    expect(WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS
      .filter((migration) => migration.version <= 32)
      .map((migration) => [migration.version, durableObjectMigrationHash(migration)]))
      .toEqual([
        [1, "fnv1a64:740b2c18aea9a94f"],
        [2, "fnv1a64:6a3aedde16fb0edf"],
        [3, "fnv1a64:ef09d286d0c92908"],
        [4, "fnv1a64:227602ce51828cb1"],
        [5, "fnv1a64:378ecfe08af01f41"],
        [6, "fnv1a64:5d9aca5e03e7a8c5"],
        [7, "fnv1a64:198c86c2a9187a36"],
        [8, "fnv1a64:e4e8f878b8b1f833"],
        [9, "fnv1a64:808df8fe2f1380b9"],
        [10, "fnv1a64:9519a46d04c82c19"],
        [11, "fnv1a64:dd2956457d3fdf4e"],
        [12, "fnv1a64:1d5a0ac3e1429146"],
        [13, "fnv1a64:3c5ac9beabf243f8"],
        [14, "fnv1a64:79c8836a0814470f"],
        [15, "fnv1a64:207530ec9f92e212"],
        [16, "fnv1a64:50a0b23d1d77b44b"],
        [17, "fnv1a64:907a81e47947c870"],
        [18, "fnv1a64:eca60aaf68a8ff6a"],
        [19, "fnv1a64:f57ab2addd8a0f82"],
        [20, "fnv1a64:7d48e297c9270b77"],
        [21, "fnv1a64:bbd0fe713205ead4"],
        [22, "fnv1a64:5de04264bbcd5226"],
        [23, "fnv1a64:0f9575673f4ae0d8"],
        [24, "fnv1a64:5becac5f85d26473"],
        [25, "fnv1a64:f6296520794d1119"],
        [26, "fnv1a64:00e294b01e91be59"],
        [27, "fnv1a64:c1cf2977a182c28f"],
        [28, "fnv1a64:b204afcc6c942738"],
        [29, "fnv1a64:dc704f71c381236c"],
        [30, "fnv1a64:9e186cd27f9dcd6b"],
        [31, "fnv1a64:4f82f4cf6d6c21d7"],
        [32, "fnv1a64:d4f93bb5a60c035d"],
      ]);
  });

  it("preserves live attachment recovery ownership when prepared conversation receipts are added", () => {
    const database = new DatabaseSync(":memory:");
    const storage = objectStorage(database);
    database.exec("PRAGMA foreign_keys = ON");
    try {
      applyDurableObjectSqliteMigrations({ storage,
        migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.filter((migration) => migration.version < 59),
        component: "substream_agent_do", workerVersionId: "before-prepared-content", now: 1_000 });
      new SubstreamLoopStorage(storage).ensureLoop({ loopId: WORKSTREAM_ID, bindStateRevision: 0, now: 1_000 });
      database.prepare(`INSERT INTO pending_loop_input_mailbox
        (input_id, loop_id, input_sequence, admitted_after_transcript_sequence, client_message_id,
         preparation_kind, envelope_json, state, terminal_code, created_at, updated_at)
        VALUES (?, ?, 1, 0, 'existing-upload', 'human_message', '{}', 'preparing', NULL, 1000, 1000)`)
        .run(MESSAGE_ID, WORKSTREAM_ID);
      database.prepare(`INSERT INTO pending_attachment_reservation_recovery
        (input_id, resource_id, workspace_id, workstream_id, release_authority, created_at)
        VALUES (?, ?, ?, ?, 'preparation', 1000)`).run(MESSAGE_ID, RECIPIENT_ID, WORKSPACE_ID, WORKSTREAM_ID);
      applyWorkstreamObjectSchema(storage, "with-prepared-content", 2_000);
      expect(database.prepare(`SELECT input_id, resource_id, preparation_id, mailbox_input_id, release_authority
        FROM pending_attachment_reservation_recovery`).all()).toEqual([{
          input_id: MESSAGE_ID, resource_id: RECIPIENT_ID, preparation_id: null,
          mailbox_input_id: MESSAGE_ID, release_authority: "preparation",
        }]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(() => database.prepare(`INSERT INTO pending_attachment_reservation_recovery
        (input_id, resource_id, workspace_id, workstream_id, release_authority, created_at)
        VALUES (?, ?, ?, ?, 'preparation', 1000)`).run(RUN_ID, RECIPIENT_ID, WORKSPACE_ID, WORKSTREAM_ID))
        .toThrow(/FOREIGN KEY/);
    } finally { database.close(); }
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
      const retiredMessageForeignKeys = tables.flatMap((table) => (
        database.prepare(`PRAGMA foreign_key_list("${table}")`).all()
          .filter((foreignKey) => foreignKey.table === "workstream_message_records")
          .map((foreignKey) => ({ table, from: foreignKey.from, to: foreignKey.to }))
      ));
      expect(retiredMessageForeignKeys).toEqual([]);
      expect(tables).toEqual(EXPECTED_TABLES);
      expect(database.prepare(
        `SELECT type, name FROM sqlite_schema
          WHERE name IN (
            '_runtime_harness_runs', '_runtime_inference_attempts', '_runtime_users',
            '_runtime_harness_runs_insert', '_runtime_harness_runs_update',
            '_runtime_inference_attempts_insert', '_runtime_statement_changes'
          )`,
      ).all()).toEqual([]);
      expect(database.prepare(`PRAGMA table_info("active_output_turns")`).all()
        .map((column) => column.name)).toContain("stream_id");
      expect(database.prepare(`PRAGMA table_info("active_output_turns")`).all()
        .map((column) => column.name)).toContain("transcript_sequence");
      expect(database.prepare(`PRAGMA table_info("active_output_turns")`).all()
        .map((column) => column.name)).not.toContain("message_id");
      expect(database.prepare(`PRAGMA table_info("runs")`).all()
        .map((column) => column.name)).toContain("final_turn_id");
      expect(database.prepare(`PRAGMA table_info("runs")`).all()
        .map((column) => column.name)).not.toContain("final_part_id");
      expect(database.prepare(`PRAGMA table_info("runs")`).all()
        .map((column) => column.name)).toEqual(expect.arrayContaining([
          "substream_loop_id",
          "loop_input_id",
          "loop_cycle_ordinal",
          "loop_execution_id",
          "loop_execution_epoch",
          "loop_execution_sequence",
          "execution_context_json",
          "execution_available_at",
          "external_settled_at",
          "last_settlement_error_code",
        ]));
      const pendingInputColumns = database.prepare(
        `PRAGMA table_info("pending_loop_inputs")`,
      ).all().map((column) => column.name);
      expect(pendingInputColumns).toContain("admitted_after_transcript_sequence");
      expect(database.prepare(
        `PRAGMA table_info("pending_loop_input_mailbox")`,
      ).all().map((column) => column.name)).toContain("admitted_after_transcript_sequence");
      expect(database.prepare(`PRAGMA table_info("substream_loops")`).all()
        .map((column) => column.name)).toContain("transcript_projected_through");
      expect(pendingInputColumns).not.toEqual(expect.arrayContaining([
        "state", "delivered_turn_id", "delivered_attention_ordinal", "delivered_at",
        "claimed_at", "cancelled_at", "cancelled_reason",
      ]));
      const pendingImmutableSql = String(database.prepare(
        `SELECT sql FROM sqlite_schema
          WHERE type = 'trigger' AND name = 'pending_loop_inputs_prepared_immutable'`,
      ).get()?.sql ?? "");
      expect(pendingImmutableSql).toContain("BEFORE UPDATE OF");
      expect(pendingImmutableSql).not.toMatch(/\binput_sequence\b/);
      expect(database.prepare(`PRAGMA table_info("delivered_loop_inputs")`).all()
        .map((column) => column.name)).toEqual([
          "input_id",
          "loop_id",
          "input_sequence",
          "delivered_turn_id",
          "delivered_attention_ordinal",
          "delivered_at",
        ]);
      expect(database.prepare(`PRAGMA foreign_key_list("runs")`).all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table: "delivered_loop_inputs",
            from: "loop_input_id",
            to: "input_id",
          }),
        ]),
      );
      expect(database.prepare(`PRAGMA table_info("bind_loop_heads")`).all()
        .map((column) => column.name)).toEqual(expect.arrayContaining([
          "transition_kind",
          "system_renderer_version",
          "system_input_hash",
          "last_model_turn_index",
          "last_assistant_reservation_json",
        ]));
      expect(database.prepare(
        `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'bind_loop_states'`,
      ).all()).toEqual([]);
      expect(database.prepare(`PRAGMA table_info("bind_activation_inputs")`).all()
        .map((column) => column.name)).toEqual(expect.arrayContaining([
          "loop_id", "activation_input_id", "fact_id", "admitted_state_revision",
        ]));
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

  it("retires verified payload owners without changing canonical compaction history or edges", () => {
    const database = new DatabaseSync(":memory:");
    const storage = objectStorage(database);
    try {
      applyDurableObjectSqliteMigrations({
        storage,
        migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.filter((migration) => migration.version < 32),
        component: "workstream",
        workerVersionId: "worker-before-retirement",
        now: 1_000,
      });
      database.exec("PRAGMA foreign_keys = OFF");
      database.exec(`
        INSERT INTO substreams
          (id, kind, inherit_mode, depth, return_mode, audience, tool_policy, status, created_at)
        VALUES ('0', 'main', 'none', 0, 'none', 'workspace', 'full', 'open', 1);
        INSERT INTO transcript_payloads
          (payload_id, audience, media_type, payload_json, payload_sha256, byte_length, created_at)
        VALUES
          ('message-payload', 'shared', 'application/json',
           '{"content":"Hello","role":"user","structuredContent":{"answer":42}}',
           'message-hash', 1, 1),
          ('checkpoint-payload', 'model', 'application/json',
           '{"compactedThroughSequence":2,"messages":[{"content":"Summary","role":"user"}],"model":"test/model","summary":"Summary"}',
           'checkpoint-hash', 1, 2),
          ('status-payload', 'participant', 'application/json', '{}', 'status-hash', 1, 2);
        INSERT INTO transcript_facts
          (fact_id, fact_kind, payload_id, origin_kind, run_id, turn_id, created_at)
        VALUES
          ('message-fact', 'workstream_message', 'message-payload', 'canonical', NULL, 'message-1', 1),
          ('checkpoint-fact', 'compaction_checkpoint', 'checkpoint-payload', 'canonical', 'run-1', NULL, 2),
          ('status-fact', 'compaction_status', 'status-payload', 'canonical', 'run-1', 'run-1:compaction:2', 2);
        INSERT INTO parts
          (id, substream_id, sequence_number, attention_ordinal, role, kind, author_type,
           author_user_id, content, client_message_id, visibility, pinned, message_type,
           structured_content_json, created_at, updated_at)
        VALUES ('message-1', '0', 1, 1, 'user', 'text', 'member', 'user-1', 'Hello',
                'client-1', 'both', 0, 'text', '{"answer":42}', 1, 1);
        INSERT INTO workstream_message_records
          (message_id, substream_id, sequence_number, attention_ordinal, fact_id, role, kind,
           author_type, author_user_id, client_message_id, visibility, pinned, message_type,
           created_at, updated_at)
        VALUES ('message-1', '0', 1, 1, 'message-fact', 'user', 'text', 'member', 'user-1',
                'client-1', 'both', 0, 'text', 1, 1);
        INSERT INTO participant_transcript_turns
          (transcript_sequence, turn_id, entry_kind, actor, root_fact_id, activity_id,
           revision, created_at, updated_at)
        VALUES (1, 'run-1:compaction:2', 'status', 'system', 'status-fact',
                'run-1:compaction:2', 2, 2, 3);
        INSERT INTO transcript_compaction_checkpoints
          (checkpoint_fact_id, execution_principal_key, resource_visibility_fingerprint,
           checkpoint_template_version, run_id, compacted_through_sequence, model,
           context_tokens_before_compaction, context_window_tokens, input_tokens, output_tokens,
           cost_micros, created_at, updated_at)
        VALUES ('checkpoint-fact', 'user:user-1', 'inventory:0', 1, 'run-1', 2,
                'test/model', 90, 100, 10, 2, 1, 2, 3);
        INSERT INTO transcript_activities
          (activity_id, scope, subject_id, call_index, label, lifecycle_state,
           revision, created_at, updated_at)
        VALUES ('run-1:compaction:2', 'compaction', '2', 1,
                'Context automatically compacted', 'completed', 2, 2, 3);
        INSERT INTO legacy_transcript_payload_transfers
          (id, operator_run_id, pre_transfer_bookmark, source_part_count,
           source_attachment_count, source_mention_count, source_checkpoint_count,
           source_sha256, message_record_count, checkpoint_projection_count, completed_at)
        VALUES (1, 'operator', 'bookmark', 1, 0, 0, 0,
                'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1, 0, 4);
      `);
      database.exec("PRAGMA foreign_keys = ON");
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      applyWorkstreamObjectSchema(storage, "worker-after-retirement", 2_000);

      // A row that existed only in the retired compatibility feed is not
      // promoted into the canonical transcript. There is deliberately no
      // timestamp/sequence heuristic here that could invent its position.
      expect(database.prepare(
        `SELECT content FROM canonical_conversation_turn_details WHERE id = 'message-1'`,
      ).get()).toBeUndefined();
      expect(database.prepare(`PRAGMA table_info(workstream_message_records)`).all())
        .toEqual([]);
      expect(database.prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'index' AND name = 'workstream_message_records_sequence_idx'`,
      ).get()).toBeUndefined();
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM transcript_compaction_checkpoints`,
      ).get()).toEqual({ count: 1 });
      // Activity rows are an execution projection rebuilt only by forward
      // execution. The canonical turn retains its immutable activity edge.
      expect(database.prepare(
        `SELECT lifecycle_state, revision FROM transcript_activities
          WHERE activity_id = 'run-1:compaction:2'`,
      ).get()).toBeUndefined();
      expect(database.prepare(
        `SELECT activity_id, revision FROM participant_transcript_turns
          WHERE turn_id = 'run-1:compaction:2'`,
      ).get()).toEqual({ activity_id: "run-1:compaction:2", revision: 2 });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("adds v46 name reservations without changing existing Sidekick snapshots", () => {
    const database = new DatabaseSync(":memory:");
    const storage = objectStorage(database);
    try {
      applyDurableObjectSqliteMigrations({ storage, migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 45), component: "substream_agent_do", workerVersionId: "worker-v45", now: 1_000 });
      database.exec(`INSERT INTO sidekick_execution_skills VALUES ('execution', '{"sources":[],"activeRefs":[]}');
        INSERT INTO sidekick_attachments VALUES ('sidekick', 1000)`);
      applyWorkstreamObjectSchema(storage, "worker-v46", 2_000);
      expect(database.prepare(`SELECT * FROM sidekick_execution_skills`).all()).toEqual([{ execution_id: "execution", snapshot_json: '{"sources":[],"activeRefs":[]}' }]);
      expect(database.prepare(`SELECT * FROM sidekick_attachments`).all()).toEqual([{ sidekick_id: "sidekick", attached_at: 1000 }]);
      database.exec(`INSERT INTO sidekick_skill_names VALUES ('first', 'sidekick-editor')`);
      expect(() => database.exec(`INSERT INTO sidekick_skill_names VALUES ('second', 'sidekick-editor')`)).toThrow(/UNIQUE/);
      applyWorkstreamObjectSchema(storage, "worker-v46", 3_000);
      expect(database.prepare(`SELECT * FROM sidekick_skill_names`).all()).toEqual([{ sidekick_id: "first", name: "sidekick-editor" }]);
    } finally {
      database.close();
    }
  });

  it("adds the v51 context-residency ledger without touching earlier rows and re-applies idempotently", () => {
    const database = new DatabaseSync(":memory:");
    const storage = objectStorage(database);
    try {
      applyDurableObjectSqliteMigrations({ storage, migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 50), component: "substream_agent_do", workerVersionId: "worker-v50", now: 1_000 });
      database.exec(`INSERT INTO sidekick_skill_names VALUES ('first', 'sidekick-editor')`);
      applyWorkstreamObjectSchema(storage, "worker-v51", 2_000);
      expect(database.prepare(`SELECT * FROM sidekick_skill_names`).all()).toEqual([{ sidekick_id: "first", name: "sidekick-editor" }]);
      database.exec(`INSERT INTO resident_context_blocks
        (kind, block_id, sha256, source_generation, content, truncated, residency, superseded, compactions_remaining, pending_delivery, first_delivered_at, last_delivered_at)
        VALUES ('repository_instructions', 'AGENTS.md', 'abc', 1, 'rules', 0, 'transcript', 0, 0, 1, 2000, 2000)`);
      expect(() => database.exec(`INSERT INTO resident_context_blocks
        (kind, block_id, sha256, source_generation, content, truncated, residency, superseded, compactions_remaining, pending_delivery, first_delivered_at, last_delivered_at)
        VALUES ('repository_instructions', 'AGENTS.md', 'abc', 1, 'rules', 0, 'transcript', 0, 0, 1, 2000, 2000)`)).toThrow(/UNIQUE|PRIMARY KEY/u);
      expect(() => database.exec(`UPDATE resident_context_blocks SET residency = 'prompt'`)).toThrow(/CHECK/u);
      applyWorkstreamObjectSchema(storage, "worker-v51", 3_000);
      expect(database.prepare(`SELECT block_id, residency FROM resident_context_blocks`).all()).toEqual([{ block_id: "AGENTS.md", residency: "transcript" }]);
    } finally {
      database.close();
    }
  });

  it("backfills the loop's projection mark to the transcript high-water when v45 applies", () => {
    // An existing room starts "seen through now": the mark is what the
    // transcript holds at upgrade, so nothing historical surfaces into the
    // model on the next activation. A room with no counter row gets zero,
    // which the loop's own insert also uses for a fresh room.
    const database = new DatabaseSync(":memory:");
    const storage = objectStorage(database);
    try {
      applyDurableObjectSqliteMigrations({
        storage,
        migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 44),
        component: "substream_agent_do",
        workerVersionId: "worker-v44",
        now: 1_000,
      });
      database.exec(`
        UPDATE transcript_counters SET next_transcript_sequence = 8 WHERE id = 1;
        INSERT INTO substream_loops
          (id, loop_id, revision, status, cycle_ordinal, step_ordinal, bind_state_revision,
           next_input_sequence, next_assistant_turn_sequence, next_execution_sequence,
           created_at, updated_at)
        VALUES (1, 'loop-1', 1, 'idle', 0, 0, 0, 1, 1, 1, 1, 1);
      `);
      expect(database.prepare(`PRAGMA table_info("substream_loops")`).all()
        .map((column) => column.name)).not.toContain("transcript_projected_through");
      applyDurableObjectSqliteMigrations({
        storage,
        migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
        component: "substream_agent_do",
        workerVersionId: "worker-v45",
        now: 2_000,
      });
      expect(database.prepare(
        `SELECT transcript_projected_through FROM substream_loops WHERE id = 1`,
      ).get()).toEqual({ transcript_projected_through: 7 });
    } finally {
      database.close();
    }
  });

  it("upgrades a populated v32 graph while preserving canonical history and retiring operational work", () => {
    const database = new DatabaseSync(":memory:");
    const storage = objectStorage(database);
    try {
      applyDurableObjectSqliteMigrations({
        storage,
        migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 32),
        component: "substream_agent_do",
        workerVersionId: "worker-v32",
        now: 1_000,
      });
      database.exec(`
        INSERT INTO substreams
          (id, kind, inherit_mode, depth, return_mode, origin_message_id,
           audience, tool_policy, status, created_at)
        VALUES ('0', 'main', 'none', 0, 'none', NULL, 'workspace', 'full', 'open', 1);
        INSERT INTO runs
          (run_id, substream_id, status, budget, attempt_epoch, model_iteration,
           next_action_cursor, input_fence_seq, revision, started_at,
           active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count,
           retry_count, tool_count, input_tokens, output_tokens, cost_micros,
           output_bytes, created_at, updated_at)
        VALUES ('${RUN_ID}', '0', 'running', '{}', 0, 0, '', 0, 0, 1,
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1);
        INSERT INTO transcript_payloads
          (payload_id, audience, media_type, payload_json, payload_sha256, byte_length, created_at)
        VALUES ('payload-1', 'shared', 'application/json',
                '{"role":"user","content":"Preserve me","structuredContent":null}',
                'payload-hash', 11, 1);
        INSERT INTO transcript_facts
          (fact_id, fact_kind, payload_id, origin_kind, turn_id, created_at)
        VALUES ('fact-1', 'workstream_message', 'payload-1', 'canonical', '${MESSAGE_ID}', 1);
        INSERT INTO participant_transcript_turns
          (transcript_sequence, turn_id, entry_kind, actor, author_user_id,
           root_fact_id, attention_ordinal, revision, created_at, updated_at)
        VALUES (1, '${MESSAGE_ID}', 'conversation', 'human', '${AUTHOR_ID}',
                'fact-1', 1, 1, 1, 1);
        INSERT INTO participant_transcript_blocks
          (turn_id, block_id, block_index, block_kind, fact_id, revision, updated_at)
        VALUES ('${MESSAGE_ID}', '${MESSAGE_ID}:text:0', 0, 'text', 'fact-1', 1, 1);
        INSERT INTO workstream_message_records
          (id, substream_id, sequence_number, attention_ordinal, fact_id, role,
           kind, author_type, author_user_id, client_message_id, visibility,
           pinned, message_type, created_at, updated_at)
        VALUES ('${MESSAGE_ID}', '0', 1, 1, 'fact-1', 'user', 'text', 'member',
                '${AUTHOR_ID}', 'client-1', 'both', 0, 'text', 1, 1);
        INSERT INTO substreams
          (id, kind, inherit_mode, depth, return_mode, origin_message_id,
           audience, tool_policy, status, created_at)
        VALUES ('child', 'chat', 'none', 1, 'none', '${MESSAGE_ID}',
                'workspace', 'full', 'open', 2);
        INSERT INTO workstream_message_attachments
          (message_id, resource_id, position, attachment_json)
        VALUES ('${MESSAGE_ID}', 'resource-1', 0, '{"fileName":"evidence.pdf"}');
        INSERT INTO workstream_message_mentions
          (message_id, mention_index, mention_kind, target_user_id,
           start_offset, end_offset, attention_ordinal)
        VALUES ('${MESSAGE_ID}', 0, 'person', '${RECIPIENT_ID}', 0, 4, 1);
        INSERT INTO tool_effects
          (effect_intent_id, run_id, attempt_epoch, tool_position, occurrence_key,
           tool_name, mode, request_hash, authority_revision, status, tool_call_id, input_json)
        VALUES
          ('effect-command', '${RUN_ID}', 0, 0, 'effect-command', 'run_command',
           'write', 'request-1', 'authority', 'executing', 'call-command', '{}'),
          ('effect-publish', '${RUN_ID}', 0, 1, 'effect-publish', 'publish',
           'write', 'request-2', 'authority', 'executing', 'call-publish', '{}');
        INSERT INTO tool_effect_checkpoints
          (checkpoint_id, effect_intent_id, run_id, attempt_id, checkpoint_index,
           phase, member_safe_payload_json, created_at)
        VALUES ('checkpoint-1', 'effect-command', '${RUN_ID}', '${ATTEMPT_ID}', 0,
                'executing', '{}', 1);
        INSERT INTO terminal_workspace
          (id, provider, sandbox_id, lifecycle_state, generation, stable_name,
           authority_fingerprint, applied_network_revision, version,
           created_at, updated_at)
        VALUES (1, 'daytona', 'sandbox-1', 'running', 1, 'rally-sandbox-1',
                'authority', 1, 1, 1, 1);
        INSERT INTO terminal_tasks
          (task_id, run_id, effect_intent_id, sandbox_generation,
           provider_task_name, state, command_sha256, command_deadline_at,
           stdout_head, stdout_tail, stderr_head, stderr_tail,
           stdout_bytes, stderr_bytes, created_at, updated_at)
        VALUES ('task-1', '${RUN_ID}', 'effect-command', 1,
                'rally-task-1', 'running', 'command-hash', 9999,
                '', '', '', '', 0, 0, 1, 1);
        INSERT INTO terminal_publication_grants
          (grant_id, run_id, source_message_id, principal_key, repository_full_name,
           base_ref, head_ref, expires_at, consumed_by_effect_intent_id, consumed_at, created_at)
        VALUES ('grant-1', '${RUN_ID}', '${MESSAGE_ID}', 'user:${AUTHOR_ID}',
                'owner/repo', 'main', 'rally/change', 9999, 'effect-publish', 2, 1);
        INSERT INTO repository_publications
          (publication_id, effect_intent_id, grant_id, repository_full_name,
           base_ref, head_ref, requested_commit_sha, state, title, body, created_at, updated_at)
        VALUES ('publication-1', 'effect-publish', 'grant-1', 'owner/repo',
                'main', 'rally/change', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                'publishing', 'Title', 'Body', 1, 1);
        INSERT INTO run_steering
          (run_id, steering_message_id, requested_at)
        VALUES ('${RUN_ID}', '${MESSAGE_ID}', 2);
        INSERT INTO active_output_turns
          (run_id, attempt_epoch, turn_id, substream_id, status, durable_event_seq,
           durable_through_frame_seq, next_chunk_index, message_id,
           seen_turn_ids_json, turn_start_offset, started_at, checkpointed_at, updated_at)
        VALUES ('${RUN_ID}', 0, '${RUN_ID}:turn:1', '0', 'streaming', 1, 1, 0,
                '${RUN_ID}', '["${RUN_ID}:turn:1"]', 0, 1, 1, 1);
      `);

      applyWorkstreamObjectSchema(storage, "worker-current", 2_000);

      expect(database.prepare(`SELECT resource_id FROM participant_transcript_attachments`).all())
        .toEqual([{ resource_id: "resource-1" }]);
      expect(database.prepare(`SELECT target_user_id FROM participant_transcript_mentions`).all())
        .toEqual([{ target_user_id: RECIPIENT_ID }]);
      expect(database.prepare(`SELECT run_id FROM runs`).all()).toEqual([]);
      expect(database.prepare(`SELECT task_id FROM terminal_tasks`).all())
        .toEqual([]);
      expect(database.prepare(`SELECT sandbox_id FROM terminal_workspace`).all())
        .toEqual([{ sandbox_id: "sandbox-1" }]);
      expect(database.prepare(`SELECT checkpoint_id FROM tool_effect_checkpoints`).all())
        .toEqual([]);
      expect(database.prepare(`SELECT publication_id FROM repository_publications`).all())
        .toEqual([]);
      expect(database.prepare(
        `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'run_steering'`,
      ).all()).toEqual([]);
      expect(database.prepare(
        `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'agent_run_dispatches'`,
      ).all()).toEqual([]);
      expect(database.prepare(`SELECT stream_id FROM active_output_turns`).all())
        .toEqual([]);
      expect(database.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
      expect(database.prepare(`PRAGMA foreign_keys`).get()).toEqual({ foreign_keys: 1 });
    } finally {
      database.close();
    }
  });

  it("refuses retirement while any legacy message lacks a verified canonical owner", () => {
    const database = new DatabaseSync(":memory:");
    const storage = objectStorage(database);
    try {
      applyDurableObjectSqliteMigrations({
        storage,
        migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.filter((migration) => migration.version < 32),
        component: "workstream",
        workerVersionId: "worker-before-retirement",
        now: 1_000,
      });
      database.exec(`
        INSERT INTO substreams
          (id, kind, inherit_mode, depth, return_mode, audience, tool_policy, status, created_at)
        VALUES ('0', 'main', 'none', 0, 'none', 'workspace', 'full', 'open', 1);
        INSERT INTO parts
          (id, substream_id, sequence_number, attention_ordinal, role, kind, author_type,
           author_user_id, content, visibility, pinned, message_type, created_at, updated_at)
        VALUES ('unowned', '0', 1, 1, 'user', 'text', 'member', 'member-1',
                'Not transferred', 'both', 0, 'text', 1, 1);
      `);

      expect(() => applyWorkstreamObjectSchema(storage, "worker-retirement", 2_000))
        .toThrow("transcript_payload_retirement_not_verified");
      expect(database.prepare(`SELECT content FROM parts WHERE id = 'unowned'`).get())
        .toEqual({ content: "Not transferred" });
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
      // The canonical compaction authority is untouched by the sibling drop.
      expect(database.prepare("SELECT COUNT(*) AS count FROM transcript_compaction_checkpoints").get())
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

  it("removes the retired dashboard state in version 38", () => {
    const database = new DatabaseSync(":memory:");
    const storage = objectStorage(database);
    try {
      applyDurableObjectSqliteMigrations({
        storage,
        migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.filter((migration) => migration.version < 38),
        component: "workstream",
        workerVersionId: "worker-before",
        now: 1_000,
      });
      seedWorkstreamObjectRoot(database, {
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
      }, 1_000);
      const retiredRunId = "00000000-0000-7000-8000-000000000038";
      const ordinaryRunId = "00000000-0000-7000-8000-000000000039";
      seedWorkstreamRun(database, {
        id: retiredRunId,
        origin: "block_dashboard_block",
        status: "admitted",
        createdAt: 1_000,
      });
      seedWorkstreamRun(database, {
        id: ordinaryRunId,
        origin: "member_message",
        status: "completed",
        createdAt: 900,
      });
      database.exec(`
        INSERT INTO block_dashboard_configuration_versions
          (configuration_version_id, version_number, blocks_json, created_by_user_id, created_at)
        VALUES ('configuration-38', 1, '[]', '${AUTHOR_ID}', 1000);
        INSERT INTO block_dashboard_block_runs
          (block_run_id, configuration_version_id, block_id, prompt,
           trigger_sequence, run_id, status, created_at)
        VALUES ('block-run-38', 'configuration-38', 'block-38', 'Retired prompt',
                1, '${retiredRunId}', 'queued', 1000);
        INSERT INTO run_lifecycle_events
          (event_id, run_id, attempt_id, event_key, event_type,
           member_safe_payload_json, created_at)
        VALUES ('event-38', '${retiredRunId}', 'attempt-38', 'admitted',
                'admitted', '{}', 1000);
        INSERT INTO elicitation_requests
          (elicitation_id, run_id, prompt, response_type, options_json, tool_call_id,
           minimum_selections, status, created_at)
        VALUES ('elicitation-38', '${retiredRunId}', 'Question', 'text', '[]', 'tool-call-38',
                0, 'pending', 1000);
      `);
      database.prepare(
        `INSERT INTO due_work
           (job_key, kind, due_at, epoch, payload_json, attempts, updated_at)
         VALUES ('block_dashboard_refresh', 'refresh', 1000, 1, '{}', 0, 1000)`,
      ).run();
      expect(database.prepare(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name LIKE 'block_dashboard_%'
          ORDER BY name`,
      ).all()).toHaveLength(3);
      applyWorkstreamObjectSchema(storage, "worker-after", 2_000);

      expect(database.prepare(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name LIKE 'block_dashboard_%'`,
      ).all()).toEqual([]);
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM due_work WHERE job_key = 'block_dashboard_refresh'`,
      ).get()).toEqual({ count: 0 });
      expect(database.prepare(
        `SELECT run_id FROM runs ORDER BY run_id`,
      ).all()).toEqual([{ run_id: ordinaryRunId }]);
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM run_lifecycle_events WHERE run_id = ?`,
      ).get(retiredRunId)).toEqual({ count: 0 });
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM elicitation_requests WHERE run_id = ?`,
      ).get(retiredRunId)).toEqual({ count: 0 });
      expect(database.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("upgrades a populated v65 root to the space parent kind without losing its row or triggers", () => {
    const database = new DatabaseSync(":memory:");
    const storage = objectStorage(database);
    try {
      applyDurableObjectSqliteMigrations({
        storage,
        migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 65),
        component: "substream_agent_do",
        workerVersionId: "worker-v65",
        now: 1_000,
      });
      database.prepare(
        `INSERT INTO workstream
           (id, workstream_key, parent_workspace_key, region, authority_mode,
            authority_generation, title, description, scope, exact_state,
            state_reason_code, next_sequence_number, next_attention_ordinal,
            authority_epoch, scope_epoch, source_authorization_floor, listing_epoch,
            deletion_epoch, run_revision, created_at, last_people_activity_at,
            state_changed_at, updated_at, parent_kind, appearance_json, model_override)
         VALUES (1, ?, ?, 'global', 'authoritative', 4, 'Hiring', 'About hiring',
                 'personal', 'idle', 'test', 7, 3, 2, 1, 0, 1, 0, 1,
                 1000, 1100, 1200, 1300, 'automation', '{"icon":"briefcase"}', 'sonnet')`,
      ).run(WORKSTREAM_ID, WORKSPACE_ID);
      // A fence narrower than the workspace, so the restricted-content trigger
      // has something to abort on below. Its absence after the rebuild would be
      // a silent hole in the containment preflight rather than an error.
      database.prepare(
        `INSERT INTO content_audience_fences (fence_id, audience_json, created_at)
         VALUES ('fence-1', '{"scope":"users","userIds":["${RECIPIENT_ID}"]}', 1000)`,
      ).run();

      applyWorkstreamObjectSchema(storage, "worker-v66", 2_000);

      // Every column of the singleton survived the swap, not just the one the
      // migration is about.
      expect(database.prepare(`SELECT * FROM workstream WHERE id = 1`).get()).toMatchObject({
        workstream_key: WORKSTREAM_ID,
        parent_workspace_key: WORKSPACE_ID,
        authority_generation: 4,
        title: "Hiring",
        description: "About hiring",
        scope: "personal",
        next_sequence_number: 7,
        next_attention_ordinal: 3,
        parent_kind: "automation",
        appearance_json: '{"icon":"briefcase"}',
        model_override: "sonnet",
        created_at: 1000,
        last_people_activity_at: 1100,
        state_changed_at: 1200,
        updated_at: 1300,
      });

      expect(() => database.prepare(
        `UPDATE workstream SET parent_kind = 'space' WHERE id = 1`,
      ).run()).not.toThrow();
      expect(database.prepare(`SELECT parent_kind FROM workstream WHERE id = 1`).get())
        .toEqual({ parent_kind: "space" });
      // Still closed: widening one value is not opening the column.
      expect(() => database.prepare(
        `UPDATE workstream SET parent_kind = 'project' WHERE id = 1`,
      ).run()).toThrow();

      expect(database.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'workstream'
          ORDER BY name`,
      ).all()).toEqual([
        { name: "authorization_workstream_delete" },
        { name: "authorization_workstream_insert" },
        { name: "authorization_workstream_update" },
        { name: "conversation_view_generation" },
        { name: "conversation_view_header_delete" },
        { name: "conversation_view_header_insert" },
        { name: "conversation_view_header_update" },
        { name: "workstream_restricted_content_scope" },
        { name: "workstream_search_display_update" },
      ]);
      // Present by name is not the same as installed and firing.
      expect(() => database.prepare(
        `UPDATE workstream SET scope = 'workspace' WHERE id = 1`,
      ).run()).toThrow(/workstream_audience_restricted_content/u);

      expect(database.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
      expect(database.prepare(
        `SELECT name FROM sqlite_master WHERE name = '_parent_kind_copy_workstream'`,
      ).all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("enforces substream and semantic-part shapes in SQLite", () => {
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
            depth, return_mode, origin_message_id, owner_user_id, audience,
            tool_policy, status, created_at, closed_at)
         VALUES ('0', 'main', 'none', NULL, NULL, 0, 'none', NULL, NULL,
                 'workspace', 'full', 'open', 1000, NULL)`,
      ).run();

      expect(() => database.prepare(
        `INSERT INTO substreams
           (id, kind, inherit_mode, inherit_from_substream_id, inherit_fence_seq,
            depth, return_mode, origin_message_id, owner_user_id, audience,
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

  it("warns but remains available for a changed implementation receipt", () => {
    const database = new DatabaseSync(":memory:");
    const storage = objectStorage(database);
    try {
      applyWorkstreamObjectSchema(storage, "worker-one");
      database.prepare(
        `UPDATE _sql_schema_migrations SET implementation_hash = 'changed' WHERE version = 1`,
      ).run();

      expect(() => applyWorkstreamObjectSchema(storage, "worker-two")).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({
        event: "durable_object_schema_hash_mismatch",
        message: "substream_agent_do_schema_hash_mismatch:1",
        version: 1,
        recordedImplementationHash: "changed",
      }));
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

  it("pins one external work-stream identity to each existing Durable Object", async () => {
    const database = new DatabaseSync(":memory:");
    const store = new WorkstreamObjectStore(objectStorage(database), "worker-one", "global");
    try {
      await store.waitUntilReady();
      store.ensureIdentity({ workspaceId: WORKSPACE_ID, parentKind: "workstream", parentId: WORKSTREAM_ID }, "global");

      expect(() => store.ensureIdentity({
        workspaceId: WORKSPACE_ID,
        parentKind: "workstream",
        parentId: asWorkstreamId("00000000-0000-7000-8000-0000000000ff"),
      }, "global")).toThrow("workstream_object_identity_mismatch");
    } finally {
      database.close();
    }
  });


  it("checkpoints live output in bounded relational chunks and clears it at terminal state", async () => {
    const database = new DatabaseSync(":memory:");
    const storage = objectStorage(database);
    const store = new WorkstreamObjectStore(storage, "worker-one", "enterprise");
    try {
      await store.waitUntilReady();
      store.ensureIdentity({ workspaceId: WORKSPACE_ID, parentKind: "workstream", parentId: WORKSTREAM_ID }, "enterprise");
      const now = Date.now();
      const at = new Date(now).toISOString();
      activateRealtimeExecution(storage, now);
      store.commitRealtimeEvent(ServerSocketEventSchema.parse({
        type: "stream_started",
        sequence: 0,
        occurredAt: at,
        streamId: MESSAGE_ID,
        harnessRunId: RUN_ID,
        turnId: "turn-one",
        transcriptSequence: 1,
        epoch: 0,
        streamSeq: 0,
        reset: false,
      }));
      store.commitRealtimeEvent(ServerSocketEventSchema.parse({
        type: "stream_delta",
        sequence: 0,
        occurredAt: at,
        streamId: MESSAGE_ID,
        harnessRunId: RUN_ID,
        turnId: "turn-one",
        transcriptSequence: 1,
        epoch: 0,
        streamSeq: 1,
        reset: false,
        delta: `${"a".repeat(70_000)}😀`,
      }));

      expect(store.activeStreamCheckpoints()[0]).toMatchObject({
        transcriptSequence: 1,
        text: `${"a".repeat(70_000)}😀`,
      });
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
      storage.sql.exec(
        `UPDATE runs
            SET legacy_attempt_id = ?, lease_owner = 'recovered-owner', lease_expires_at = ?
          WHERE run_id = ?`,
        RECOVERED_ATTEMPT_ID,
        Date.now() + 60_000,
        RUN_ID,
      );
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
        .toEqual({ status: "running" });
    } finally {
      database.close();
    }
  });

  it("does not recreate compaction state from a delayed event after stale reaping", async () => {
    const database = new DatabaseSync(":memory:");
    const storage = objectStorage(database);
    const store = new WorkstreamObjectStore(storage, "worker-one", "global");
    try {
      await store.waitUntilReady();
      store.ensureIdentity({ workspaceId: WORKSPACE_ID, parentKind: "workstream", parentId: WORKSTREAM_ID }, "global");
      const now = Date.now();
      const at = new Date(now).toISOString();
      activateRealtimeExecution(storage, now, { linkPersistentLoop: false });
      expect(new WorkstreamHarnessRunStorage(storage).reapStaleRoot({
        runId: RUN_ID,
        attemptId: ATTEMPT_ID,
        leaseExpiresAt: now + 60_000,
        lifecycleEventId: "stale-terminal",
        now: now + 60_001,
      })).toEqual({ outcome: "reaped" });

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

      expect(store.activeCompaction()).toBeNull();
    } finally {
      database.close();
    }
  });

  it("does not let a stopped realtime frame terminalize the durable execution receipt", async () => {
    const database = new DatabaseSync(":memory:");
    const storage = objectStorage(database);
    const store = new WorkstreamObjectStore(storage, "worker-one", "global");
    try {
      await store.waitUntilReady();
      store.ensureIdentity({ workspaceId: WORKSPACE_ID, parentKind: "workstream", parentId: WORKSTREAM_ID }, "global");
      const at = "2026-08-21T03:00:00.000Z";
      activateRealtimeExecution(storage, Date.parse(at));
      store.commitRealtimeEvent(ServerSocketEventSchema.parse({
        type: "stream_started",
        sequence: 0,
        occurredAt: at,
        streamId: MESSAGE_ID,
        harnessRunId: RUN_ID,
        turnId: "turn-stopped",
        transcriptSequence: 1,
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
      ).get(RUN_ID)).toEqual({ status: "running", terminal_reason: null });
    } finally {
      database.close();
    }
  });
});
