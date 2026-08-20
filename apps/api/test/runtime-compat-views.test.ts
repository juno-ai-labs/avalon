import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { applyWorkstreamObjectSchema } from "../src/durable-objects/workstream-object-schema";
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
});
