import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  applyWorkstreamObjectSchema,
  WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
} from "../src/durable-objects/workstream-object-schema";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";

describe("the runtime compat views", () => {
  // SQLite validates a view body on first use, not at CREATE. `_runtime_resources`
  // shipped with an ambiguous column and sat unselectable in production until the
  // first transcript read reached it — this select-sweep makes that impossible.
  it("keeps every view selectable", () => {
    const database = new DatabaseSync(":memory:");
    const sql = createTestSqlStorage(database);
    applyWorkstreamObjectSchema(createCloudflareTestBinding<DurableObjectStorage>({
      getAlarm: async () => null, setAlarm: async () => undefined,
      transactionSync: (body: () => unknown) => body(), sql,
    }), "v", 1);
    const views = sql.exec<{ name: string }>(
      `SELECT name FROM sqlite_schema WHERE type = 'view' ORDER BY name`,
    ).toArray().map((row) => row.name);
    const broken: string[] = [];
    for (const view of views) {
      try { sql.exec(`SELECT * FROM "${view}" LIMIT 1`); }
      catch (e) { broken.push(`${view}: ${e instanceof Error ? e.message : "?"}`); }
    }
    expect(broken.join(" || ")).toBe("");
  });
});

describe("the runtime messages insert trigger", () => {
  // SQLite drops an ON CONFLICT clause aimed at a view; the trigger must
  // absorb the replay itself. A retried harness attempt writes its final
  // message again under the same `harness:<runId>` client id with a fresh
  // message id — production crashed on parts_client_message_uq instead of
  // deduplicating, which took down every retried run's settlement.
  it("absorbs a replayed write with the same client id and a fresh id", () => {
    const database = new DatabaseSync(":memory:");
    const sql = createTestSqlStorage(database);
    applyWorkstreamObjectSchema(createCloudflareTestBinding<DurableObjectStorage>({
      getAlarm: async () => null, setAlarm: async () => undefined,
      transactionSync: (body: () => unknown) => body(), sql,
    }), "v", 1);
    sql.exec(`INSERT INTO workstream (
        id, workstream_key, parent_workspace_key, parent_do_id, parent_generation, region,
        authority_mode, authority_generation, title, description, preview, scope,
        exact_state, state_reason_code, next_sequence_number, next_attention_ordinal,
        unread_tracking_start_ordinal, authority_epoch, scope_epoch,
        source_authorization_floor, listing_epoch, deletion_epoch, run_revision,
        created_at, last_people_activity_at, state_changed_at, updated_at
      ) VALUES (1,'S','W',NULL,0,'global','authoritative',1,'T','','','workspace',
                'idle','s',1,1,0,0,0,0,0,0,0,1,1,1,1)`);
    sql.exec(`INSERT INTO substreams (id,kind,inherit_mode,depth,return_mode,audience,tool_policy,status,created_at)
      VALUES ('0','main','none',0,'none','workspace','full','open',1)`);

    const write = (id: string) => sql.exec(
      `INSERT INTO _runtime_messages
         (id, client_message_id, workspace_id, workstream_id, author_type,
          message_type, text_content, sequence_number, created_at)
       VALUES (?, 'harness:run-1', 'W', 'S', 'agent', 'text', 'final answer', 5,
               '2026-08-20T12:00:00.000Z')`,
      id,
    );

    write("00000000-0000-7000-8000-00000000aa01");
    // The replay: a fresh message id, the same durable client id.
    write("00000000-0000-7000-8000-00000000aa02");

    const rows = sql.exec<{ id: string }>(
      `SELECT id FROM parts WHERE client_message_id = 'harness:run-1'`,
    ).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("00000000-0000-7000-8000-00000000aa01");
  });

  it("settles a tool write with the same id and client id", () => {
    const database = new DatabaseSync(":memory:");
    const sql = createTestSqlStorage(database);
    applyWorkstreamObjectSchema(createCloudflareTestBinding<DurableObjectStorage>({
      getAlarm: async () => null, setAlarm: async () => undefined,
      transactionSync: (body: () => unknown) => body(), sql,
    }), "v", 1);
    sql.exec(`INSERT INTO workstream (
        id, workstream_key, parent_workspace_key, parent_do_id, parent_generation, region,
        authority_mode, authority_generation, title, description, preview, scope,
        exact_state, state_reason_code, next_sequence_number, next_attention_ordinal,
        unread_tracking_start_ordinal, authority_epoch, scope_epoch,
        source_authorization_floor, listing_epoch, deletion_epoch, run_revision,
        created_at, last_people_activity_at, state_changed_at, updated_at
      ) VALUES (1,'S','W',NULL,0,'global','authoritative',1,'T','','','workspace',
                'idle','s',1,1,0,0,0,0,0,0,0,1,1,1,1)`);
    sql.exec(`INSERT INTO substreams (id,kind,inherit_mode,depth,return_mode,audience,tool_policy,status,created_at)
      VALUES ('0','main','none',0,'none','workspace','full','open',1)`);

    const id = "00000000-0000-7000-8000-00000000bb01";
    const write = (
      status: "started" | "completed",
      sequenceNumber: number,
      editedAt: string | null,
    ) => sql.exec(
      `INSERT INTO _runtime_messages
         (id, client_message_id, workspace_id, workstream_id, author_type,
          message_type, text_content, structured_content_json, sequence_number,
          created_at, edited_at)
       VALUES (?, ?, 'W', 'S', 'agent', 'tool', '', ?, ?,
               '2026-08-20T12:00:00.000Z', ?)`,
      id,
      `tool:${id}`,
      JSON.stringify({ invocation: { toolName: "workstream_read_resource", status } }),
      sequenceNumber,
      editedAt,
    );

    write("started", 5, null);
    // Production allocates a fresh sequence number for every lifecycle write.
    // Settlement still collides on both durable invocation identifiers.
    write("completed", 6, "2026-08-20T12:00:01.000Z");

    const rows = sql.exec<{
      invocation_status: string;
      tool_status: string;
      edited_at: number | null;
    }>(`SELECT json_extract(structured_content_json, '$.invocation.status') AS invocation_status,
              tool_status, edited_at
         FROM parts WHERE id = ?`, id).toArray();
    expect(rows).toEqual([{
      invocation_status: "completed",
      tool_status: "completed",
      edited_at: 1_787_227_201_000,
    }]);
  });

  it("repairs a terminal tool row stranded before schema v11", () => {
    const database = new DatabaseSync(":memory:");
    const sql = createTestSqlStorage(database);
    const storage = createCloudflareTestBinding<DurableObjectStorage>({
      getAlarm: async () => null, setAlarm: async () => undefined,
      transactionSync: (body: () => unknown) => body(), sql,
    });
    applyDurableObjectSqliteMigrations({
      storage,
      migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.slice(0, 10),
      component: "workstream",
      workerVersionId: "v10",
      now: 1,
    });
    sql.exec(`INSERT INTO workstream (
        id, workstream_key, parent_workspace_key, parent_do_id, parent_generation, region,
        authority_mode, authority_generation, title, description, preview, scope,
        exact_state, state_reason_code, next_sequence_number, next_attention_ordinal,
        unread_tracking_start_ordinal, authority_epoch, scope_epoch,
        source_authorization_floor, listing_epoch, deletion_epoch, run_revision,
        created_at, last_people_activity_at, state_changed_at, updated_at
      ) VALUES (1,'S','W',NULL,0,'global','authoritative',1,'T','','','workspace',
                'idle','s',1,1,0,0,0,0,0,0,0,1,1,1,1)`);
    sql.exec(`INSERT INTO substreams (id,kind,inherit_mode,depth,return_mode,audience,tool_policy,status,created_at)
      VALUES ('0','main','none',0,'none','workspace','full','open',1)`);
    const runId = "00000000-0000-7000-8000-00000000cc01";
    const toolId = "00000000-0000-7000-8000-00000000cc02";
    sql.exec(
      `INSERT INTO _runtime_harness_runs
         (id, workspace_id, workstream_id, origin, execution_principal_json,
          status, started_at, created_at)
       VALUES (?, 'W', 'S', 'message', '{}', 'running',
               '2026-08-20T12:00:00.000Z', '2026-08-20T12:00:00.000Z')`,
      runId,
    );
    sql.exec(
      `INSERT INTO _runtime_messages
         (id, client_message_id, workspace_id, workstream_id, author_type,
          message_type, text_content, structured_content_json, sequence_number, created_at)
       VALUES (?, ?, 'W', 'S', 'agent', 'tool', '', ?, 5,
               '2026-08-20T12:00:00.000Z')`,
      toolId,
      `tool:${toolId}`,
      JSON.stringify({ invocation: {
        id: toolId,
        toolName: "workstream_read_resource",
        activityName: "Reading an attached resource",
        status: "started",
        outputSummary: null,
        completedAt: null,
        error: null,
      } }),
    );
    sql.exec(
      `INSERT INTO _runtime_tool_invocations
         (id, workspace_id, workstream_id, harness_run_id, tool_call_id, tool_name,
          input_hash, input_json, output_summary, status, started_at, completed_at)
       VALUES (?, 'W', 'S', ?, 'call-1', 'workstream_read_resource',
               'hash', '{}', 'Read 47 characters from fixture.txt', 'completed',
               '2026-08-20T12:00:00.000Z', '2026-08-20T12:00:01.000Z')`,
      toolId,
      runId,
    );

    applyWorkstreamObjectSchema(storage, "v11", 2);

    expect(sql.exec<{
      invocation_status: string;
      output_summary: string;
      completed_at: string;
      activity_name: string | null;
      tool_status: string;
    }>(`SELECT json_extract(structured_content_json, '$.invocation.status') AS invocation_status,
              json_extract(structured_content_json, '$.invocation.outputSummary') AS output_summary,
              json_extract(structured_content_json, '$.invocation.completedAt') AS completed_at,
              json_extract(structured_content_json, '$.invocation.activityName') AS activity_name,
              tool_status
         FROM parts WHERE id = ?`, toolId).toArray()).toEqual([{
      invocation_status: "completed",
      output_summary: "Read 47 characters from fixture.txt",
      completed_at: "2026-08-20T12:00:01.000Z",
      activity_name: null,
      tool_status: "completed",
    }]);
  });

  it("repairs a receipt-only stale settlement when upgrading from schema v13", () => {
    const database = new DatabaseSync(":memory:");
    const sql = createTestSqlStorage(database);
    const storage = createCloudflareTestBinding<DurableObjectStorage>({
      getAlarm: async () => null, setAlarm: async () => undefined,
      transactionSync: (body: () => unknown) => body(), sql,
    });
    applyDurableObjectSqliteMigrations({
      storage,
      migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.slice(0, 13),
      component: "workstream",
      workerVersionId: "v13",
      now: 1,
    });
    sql.exec(`INSERT INTO workstream (
        id, workstream_key, parent_workspace_key, parent_do_id, parent_generation, region,
        authority_mode, authority_generation, title, description, preview, scope,
        exact_state, state_reason_code, next_sequence_number, next_attention_ordinal,
        unread_tracking_start_ordinal, authority_epoch, scope_epoch,
        source_authorization_floor, listing_epoch, deletion_epoch, run_revision,
        created_at, last_people_activity_at, state_changed_at, updated_at
      ) VALUES (1,'S','W',NULL,0,'global','authoritative',1,'T','','','workspace',
                'idle','s',1,1,0,0,0,0,0,0,0,1,1,1,1)`);
    sql.exec(`INSERT INTO substreams (id,kind,inherit_mode,depth,return_mode,audience,tool_policy,status,created_at)
      VALUES ('0','main','none',0,'none','workspace','full','open',1)`);
    const runId = "00000000-0000-7000-8000-00000000dd01";
    const toolId = "00000000-0000-7000-8000-00000000dd02";
    sql.exec(
      `INSERT INTO _runtime_harness_runs
         (id, workspace_id, workstream_id, origin, execution_principal_json,
          status, started_at, created_at)
       VALUES (?, 'W', 'S', 'message', '{}', 'running',
               '2026-08-20T12:00:00.000Z', '2026-08-20T12:00:00.000Z')`,
      runId,
    );
    sql.exec(
      `INSERT INTO _runtime_messages
         (id, client_message_id, workspace_id, workstream_id, author_type,
          message_type, text_content, structured_content_json, sequence_number,
          harness_run_id, created_at)
       VALUES (?, ?, 'W', 'S', 'agent', 'tool', '', ?, 5, ?,
               '2026-08-20T12:00:00.000Z')`,
      toolId,
      `tool:${toolId}`,
      JSON.stringify({ invocation: {
        id: toolId,
        toolName: "terminal_write_file",
        activityName: "Writing a file",
        status: "started",
        outputSummary: null,
        completedAt: null,
        error: null,
      } }),
      runId,
    );
    sql.exec(
      `INSERT INTO _runtime_tool_invocations
         (id, workspace_id, workstream_id, harness_run_id, tool_call_id, tool_name,
          input_hash, input_json, status, started_at, execution_plan_json)
       VALUES (?, 'W', 'S', ?, 'call-1', 'terminal_write_file',
               'hash', '{}', 'started', '2026-08-20T12:00:00.000Z', '{"mode":"write"}')`,
      toolId,
      runId,
    );
    sql.exec(
      `UPDATE _runtime_tool_invocations
          SET status = 'ambiguous', completed_at = '2026-08-20T12:05:00.000Z',
              error_json = '{"code":"ambiguous_external_write","message":"Outcome unknown"}'
        WHERE id = ?`,
      toolId,
    );
    expect(sql.exec<{ status: string }>(
      `SELECT json_extract(structured_content_json, '$.invocation.status') AS status
         FROM parts WHERE id = ?`,
      toolId,
    ).one().status).toBe("started");

    applyWorkstreamObjectSchema(storage, "v14", 2);

    expect(sql.exec<{
      visible_status: string;
      tool_status: string;
      error_code: string;
    }>(`SELECT json_extract(structured_content_json, '$.invocation.status') AS visible_status,
              tool_status,
              json_extract(structured_content_json, '$.invocation.error.code') AS error_code
         FROM parts WHERE id = ?`, toolId).one()).toEqual({
      visible_status: "ambiguous",
      tool_status: "ambiguous",
      error_code: "ambiguous_external_write",
    });
  });
});
