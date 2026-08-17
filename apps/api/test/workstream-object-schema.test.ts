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
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";

const WORKSPACE_ID = "00000000-0000-7000-8000-0000000000a1";
const WORKSTREAM_ID = "00000000-0000-7000-8000-0000000000a2";
const RUN_ID = "00000000-0000-7000-8000-0000000000a3";
const MESSAGE_ID = "00000000-0000-7000-8000-0000000000a4";
const TICKET_ID = "00000000-0000-7000-8000-0000000000a5";
const RECIPIENT_ID = "00000000-0000-7000-8000-0000000000a6";
const AUTHOR_ID = "00000000-0000-7000-8000-0000000000a7";

const EXPECTED_TABLES = [
  "_data_migrations",
  "_migration_command_receipts",
  "_sql_schema_migrations",
  "active_output_chunks",
  "active_output_turns",
  "activity_delivery_receipts",
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
  "runs",
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
  values = new Map<string, unknown>(),
  deleteHook?: (keys: string[], values: Map<string, unknown>) => void,
): DurableObjectStorage {
  return createCloudflareTestBinding<DurableObjectStorage>({
    get: async (key: string | string[]) => Array.isArray(key)
      ? new Map(key.flatMap((entry) => values.has(entry) ? [[entry, values.get(entry)]] : []))
      : values.get(key),
    put: async (key: string, value: unknown) => { values.set(key, value); },
    list: async ({ prefix = "" }: { prefix?: string } = {}) => new Map(
      [...values].filter(([key]) => key.startsWith(prefix)),
    ),
    delete: async (key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key];
      deleteHook?.(keys, values);
      if (Array.isArray(key)) {
        let deleted = 0;
        for (const entry of key) if (values.delete(entry)) deleted += 1;
        return deleted;
      }
      return values.delete(key);
    },
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
        .toEqual({ count: 1 });

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

  it("migrates every legacy room key into SQL while awaiting the authority import", async () => {
    const database = new DatabaseSync(":memory:");
    const now = Date.now();
    const values = new Map<string, unknown>([
      ["roomIdentity", { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID }],
      ["eventSequence", 42],
      ["activeStreamCheckpoints", {
        messageId: MESSAGE_ID,
        harnessRunId: RUN_ID,
        turnId: "turn-one",
        epoch: 2,
        streamSeq: 9,
        seenTurnIds: ["turn-one"],
        textChunkCount: 2,
        turnStartOffset: 0,
        roomSequence: 42,
        createdAt: new Date(now).toISOString(),
      }],
      ["activeStreamCheckpointText:00000000", "already "],
      ["activeStreamCheckpointText:00000001", "streamed"],
      ["pendingHyperSightRefresh", {
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        triggerSequence: 42,
        firstQueuedAt: now,
      }],
      [`socket-ticket:${TICKET_ID}`, Math.floor(now / 1_000) + 60],
    ]);
    const store = new WorkstreamObjectStore(objectStorage(database, values), "worker-one", "global");
    try {
      await store.waitUntilReady();

      expect(store.identity()).toEqual({ workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID });
      expect(store.currentSequence()).toBe(42);
      expect(store.activeStreamCheckpoints()).toEqual([expect.objectContaining({
        harnessRunId: RUN_ID,
        messageId: MESSAGE_ID,
        epoch: 2,
        streamSeq: 9,
        text: "already streamed",
      })]);
      expect(store.pendingHyperSightRefresh()).toEqual(expect.objectContaining({ triggerSequence: 42 }));
      expect(database.prepare(
        `SELECT authority_mode, state_reason_code FROM workstream WHERE id = 1`,
      ).get()).toEqual({
        authority_mode: "preparing",
        state_reason_code: "awaiting_authoritative_import",
      });
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM durable_inbox_receipts WHERE channel = 'socket_ticket'`,
      ).get()).toEqual({ count: 1 });
      expect(database.prepare(
        `SELECT phase, status FROM _data_migrations WHERE campaign_id = 'workstream-room-kv-to-sql-v1'`,
      ).get()).toEqual({ phase: "completed", status: "completed" });
      expect(database.prepare("SELECT data_version FROM object_versions WHERE id = 1").get())
        .toEqual({ data_version: 1 });
      expect(values.size).toBe(0);
    } finally {
      database.close();
    }
  });

  it("resumes cleanup without reparsing a partially deleted legacy checkpoint", async () => {
    const database = new DatabaseSync(":memory:");
    const now = Date.now();
    const values = new Map<string, unknown>([
      ["roomIdentity", { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID }],
      ["activeStreamCheckpoints", {
        messageId: MESSAGE_ID,
        harnessRunId: RUN_ID,
        turnId: "turn-one",
        epoch: 0,
        streamSeq: 1,
        seenTurnIds: ["turn-one"],
        textChunkCount: 2,
        turnStartOffset: 0,
        roomSequence: 1,
        createdAt: new Date(now).toISOString(),
      }],
      ["activeStreamCheckpointText:00000000", "kept "],
      ["activeStreamCheckpointText:00000001", "safely"],
    ]);
    let failCleanup = true;
    const firstStore = new WorkstreamObjectStore(objectStorage(database, values, (keys, entries) => {
      if (!failCleanup) return;
      failCleanup = false;
      entries.delete(keys[0] as string);
      entries.delete(keys[1] as string);
      throw new Error("simulated_cleanup_interruption");
    }), "worker-one", "global");
    try {
      await expect(firstStore.waitUntilReady()).rejects.toThrow("simulated_cleanup_interruption");
      expect(database.prepare(
        `SELECT phase, status FROM _data_migrations WHERE campaign_id = 'workstream-room-kv-to-sql-v1'`,
      ).get()).toEqual({ phase: "copied", status: "running" });

      const resumed = new WorkstreamObjectStore(objectStorage(database, values), "worker-two", "global");
      await resumed.waitUntilReady();

      expect(resumed.activeStreamCheckpoints()[0]?.text).toBe("kept safely");
      expect(values.size).toBe(0);
      expect(database.prepare(
        `SELECT phase, status FROM _data_migrations WHERE campaign_id = 'workstream-room-kv-to-sql-v1'`,
      ).get()).toEqual({ phase: "completed", status: "completed" });
    } finally {
      database.close();
    }
  });

  it("marks a new empty object migrated so it does not rescan legacy key families", async () => {
    const database = new DatabaseSync(":memory:");
    let listCalls = 0;
    const firstStorage = objectStorage(database);
    const originalList = firstStorage.list.bind(firstStorage);
    Object.defineProperty(firstStorage, "list", {
      value: async (...args: Parameters<DurableObjectStorage["list"]>) => {
        listCalls += 1;
        return originalList(...args);
      },
    });
    try {
      await new WorkstreamObjectStore(firstStorage, "worker-one", "global").waitUntilReady();
      expect(listCalls).toBe(2);

      const secondStorage = objectStorage(database);
      const secondList = secondStorage.list.bind(secondStorage);
      Object.defineProperty(secondStorage, "list", {
        value: async (...args: Parameters<DurableObjectStorage["list"]>) => {
          listCalls += 1;
          return secondList(...args);
        },
      });
      await new WorkstreamObjectStore(secondStorage, "worker-two", "global").waitUntilReady();

      expect(listCalls).toBe(2);
      expect(database.prepare("SELECT data_version FROM object_versions WHERE id = 1").get())
        .toEqual({ data_version: 1 });
    } finally {
      database.close();
    }
  });

  it("fails closed without deleting an unreadable legacy checkpoint", async () => {
    const database = new DatabaseSync(":memory:");
    const values = new Map<string, unknown>([
      ["roomIdentity", { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID }],
      ["activeStreamCheckpoints", { textChunkCount: "corrupt" }],
    ]);
    const store = new WorkstreamObjectStore(objectStorage(database, values), "worker-one", "global");
    try {
      await expect(store.waitUntilReady()).rejects.toThrow("legacy_active_checkpoint_invalid");
      expect(values.has("activeStreamCheckpoints")).toBe(true);
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
