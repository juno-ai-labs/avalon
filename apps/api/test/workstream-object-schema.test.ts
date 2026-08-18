import { DatabaseSync } from "node:sqlite";
import { ServerSocketEventSchema } from "@avalon/contracts";
import { describe, expect, it } from "vitest";

import {
  applyWorkstreamObjectSchema,
  WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
  WORKSTREAM_OBJECT_SCHEMA_VERSION,
} from "../src/durable-objects/workstream-object-schema";
import {
  WORKSTREAM_AUTHORITY_CAMPAIGN_PREFIX,
  WORKSTREAM_AUTHORITY_IMPORT_STAGES,
  WorkstreamAuthorityImporter,
  workstreamImportHash,
} from "../src/durable-objects/workstream-authority-import";
import { WorkstreamObjectStore } from "../src/durable-objects/workstream-object-storage";
import { workstreamRegionalEffectWakeMessage } from "../src/durable-objects/workstream-regional-effect";
import { rewriteWorkstreamRuntimeSql } from "../src/durable-objects/workstream-runtime-sql";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";

const WORKSPACE_ID = "00000000-0000-7000-8000-0000000000a1";
const WORKSTREAM_ID = "00000000-0000-7000-8000-0000000000a2";
const RUN_ID = "00000000-0000-7000-8000-0000000000a3";
const MESSAGE_ID = "00000000-0000-7000-8000-0000000000a4";
const RECIPIENT_ID = "00000000-0000-7000-8000-0000000000a6";
const AUTHOR_ID = "00000000-0000-7000-8000-0000000000a7";

const EXPECTED_TABLES = [
  "_data_migrations",
  "_migration_command_receipts",
  "_runtime_statement_changes",
  "_sql_schema_migrations",
  "active_output_chunks",
  "active_output_turns",
  "activity_delivery_receipts",
  "agent_run_dispatches",
  "attachment_tool_receipts",
  "compaction_checkpoints",
  "compaction_jobs",
  "content_refs",
  "description_refresh_state",
  "due_work",
  "durable_inbox_receipts",
  "durable_outbox",
  "elicitation_requests",
  "grant_sessions",
  "hypersight_block_runs",
  "hypersight_configuration_versions",
  "hypersight_user_preferences",
  "inference_attempts",
  "legacy_artifacts",
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
  "run_events",
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
  "workstream_events",
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
  it("creates the complete workstream-down table contract idempotently", () => {
    const database = new DatabaseSync(":memory:");
    const storage = objectStorage(database);
    try {
      applyWorkstreamObjectSchema(storage, "worker-one", 1_000);
      applyWorkstreamObjectSchema(storage, "worker-two", 2_000);

      const tables = database.prepare(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      ).all().map((row) => String(row.name));
      expect(tables).toEqual(EXPECTED_TABLES);
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

  it("imports, verifies, and activates one maintenance-fenced authority generation", async () => {
    const database = new DatabaseSync(":memory:");
    const storage = objectStorage(database);
    const store = new WorkstreamObjectStore(storage, "worker-one", "global");
    try {
      await store.waitUntilReady();
      store.ensureIdentity({ workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID }, "global");
      const importer = new WorkstreamAuthorityImporter(storage);
      const generation = 7;
      const campaignId = `${WORKSTREAM_AUTHORITY_CAMPAIGN_PREFIX}:${generation}`;
      importer.execute({
        operation: "begin",
        campaignId,
        generation,
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        sourceFence: 1,
        sourceHash: "source-fence-hash",
      });
      expect(() => store.allocateSequence()).toThrow("workstream_realtime_authority_fenced");

      let pageHash = "";
      const counts = Object.fromEntries(WORKSTREAM_AUTHORITY_IMPORT_STAGES.map((stage) => [stage, 0]));
      for (const stage of WORKSTREAM_AUTHORITY_IMPORT_STAGES) {
        const rows = stage === "workstream" ? [{
          workstream_key: WORKSTREAM_ID,
          parent_workspace_key: WORKSPACE_ID,
          region: "global",
          title: "Imported title",
          description: "Imported description",
          scope: "workspace",
          exact_state: "completed",
          state_reason_code: "imported_from_d1",
          next_sequence_number: 2,
          next_attention_ordinal: 1,
          unread_tracking_start_ordinal: 0,
          created_at: 1_000,
          last_people_activity_at: 2_000,
          state_changed_at: 2_000,
          completed_at: 2_000,
          origin_type: "ad_hoc",
          created_by_user_id: null,
          automation_subscription_id: null,
          automation_run_id: null,
          planned_for: null,
          email_address: null,
          email_route_status: "pending",
          created_from_opportunity_id: null,
          opportunity_version: null,
          opportunity_display_prompt_hash: null,
          opportunity_execution_prompt_hash: null,
          description_source: "derived",
          system_kind: null,
          title_status: "settled",
          model_override: null,
          archived_at: null,
          updated_at: 2_000,
        }] : [];
        counts[stage] = rows.length;
        const cursor = `end:${stage}`;
        const requestBody = {
          campaignId,
          generation,
          stage,
          priorCursor: null,
          cursor,
          rows,
          stageComplete: true,
        };
        if (stage === "workstream") {
          const wrongCursorBody = { ...requestBody, priorCursor: "skipped-page" };
          expect(() => importer.execute({
            operation: "page",
            commandId: `${campaignId}:${stage}:wrong-cursor`,
            requestHash: workstreamImportHash(wrongCursorBody),
            ...wrongCursorBody,
          })).toThrow("workstream_import_prior_cursor_mismatch");
        }
        const requestHash = workstreamImportHash(requestBody);
        const result = importer.execute({
          operation: "page",
          commandId: `${campaignId}:${stage}`,
          requestHash,
          ...requestBody,
        });
        expect(result.ok).toBe(true);
        pageHash = String(result.resultHash);
      }

      const verified = importer.execute({
        operation: "verify",
        campaignId,
        generation,
        expectedPageHash: pageHash,
        expectedCounts: counts,
      });
      expect(verified.phase).toBe("verified");
      expect(database.prepare(
        "SELECT authority_mode, authority_generation, title FROM workstream WHERE id = 1",
      ).get()).toEqual({
        authority_mode: "preparing",
        authority_generation: generation,
        title: "Imported title",
      });

      const activated = importer.execute({ operation: "activate", campaignId, generation });
      expect(activated.phase).toBe("authoritative");
      expect(store.allocateSequence()).toBe(1);
      expect(database.prepare("SELECT authority_mode FROM workstream WHERE id = 1").get())
        .toEqual({ authority_mode: "authoritative" });

      const commonEffect = {
        kind: "directory_common" as const,
        title: "Imported title",
        description: "Imported description",
        preview: "Latest result",
        scope: "workspace" as const,
        state: "completed",
        systemKind: null,
        lastActivityAt: "2026-08-17T00:00:00.000Z",
        completedAt: "2026-08-17T00:00:00.000Z",
        archivedAt: null,
      };
      const firstProjection = await store.commitWithRegionalEffects(() => "committed", [{
        partitionKey: "common",
        effect: commonEffect,
      }]);
      const duplicateProjection = await store.commitWithRegionalEffects(() => "committed", [{
        partitionKey: "common",
        effect: commonEffect,
      }]);
      expect(firstProjection).toEqual({ result: "committed", enqueued: 1 });
      expect(duplicateProjection).toEqual({ result: "committed", enqueued: 0 });

      const due = store.dueRegionalEffects(Date.now() + 1);
      expect(due).toEqual([expect.objectContaining({
        generation,
        partitionKey: "common",
        sourceVersion: 1,
        effect: commonEffect,
      })]);
      expect(workstreamRegionalEffectWakeMessage(due[0]!)).not.toHaveProperty("effect");
      store.markRegionalEffectsQueued(due);
      expect(store.dueRegionalEffects()).toEqual([]);
      expect(store.acknowledgeRegionalEffect(due[0]!.messageId, due[0]!.payloadHash)).toBe(true);
      expect(database.prepare("SELECT COUNT(*) AS count FROM durable_outbox").get())
        .toEqual({ count: 0 });

      const mentionCommit = await store.commitWithRegionalEffects(() => "mentioned", [
        {
          partitionKey: `user:${RECIPIENT_ID}`,
          effect: {
            kind: "directory_user",
            userId: RECIPIENT_ID,
            isParticipant: true,
            unreadCount: 1,
            youAreMentioned: true,
            listable: true,
          },
        },
        {
          partitionKey: `notification:${MESSAGE_ID}:${RECIPIENT_ID}`,
          sourceVersion: 2,
          dedupeKey: `notification:${MESSAGE_ID}:${RECIPIENT_ID}`,
          dependsOnProjectionKey: `user:${RECIPIENT_ID}`,
          effect: {
            kind: "mention_notification",
            intentId: `mention:${MESSAGE_ID}:${RECIPIENT_ID}`,
            messageId: MESSAGE_ID,
            recipientUserId: RECIPIENT_ID,
            authorUserId: AUTHOR_ID,
            authorNameSnapshot: "Author",
            workstreamTitleSnapshot: "Imported title",
            messageText: "Please review",
            occurredAt: "2026-08-17T00:00:00.000Z",
          },
        },
      ]);
      expect(mentionCommit).toEqual({ result: "mentioned", enqueued: 2 });
      expect(store.dueRegionalEffects(Date.now() + 1)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          partitionKey: `notification:${MESSAGE_ID}:${RECIPIENT_ID}`,
          requiredProjectionVersion: 1,
        }),
      ]));
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
      expect(database.prepare("SELECT status FROM runs WHERE run_id = ?").get(RUN_ID))
        .toEqual({ status: "completed" });
    } finally {
      database.close();
    }
  });
});
