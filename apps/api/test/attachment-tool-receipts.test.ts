import { asUserId } from "@rally/contracts";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  seedWorkstreamObjectRoot,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
} from "./helpers/durable-authority";

import {
  __attachmentToolReceiptTesting,
  invalidateAttachmentToolReplay,
  registerAttachmentToolReceipt,
  validateAttachmentToolReceiptReplay,
} from "../src/services/attachment-tool-receipts";
import { applyWorkstreamObjectSchema } from "../src/durable-objects/workstream-object-schema";
import { WorkstreamToolReceiptStorage } from "../src/durable-objects/workstream-tool-receipt-storage";
import type { ToolReceiptObjectPort } from "../src/durable-objects/workstream-tool-receipt-protocol";
import { createToolReceiptObjectPort } from "../src/runtime/tool-receipt-port";
import {
  createCloudflareTestBinding,
  createTestD1Database,
  createTestEnv,
  createTestD1PreparedStatement,
  createTestD1Result,
} from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";

const RESOURCE_ID = "00000000-0000-4000-8000-000000000001";
const SECOND_RESOURCE_ID = "00000000-0000-4000-8000-000000000003";
const INVOCATION_ID = "00000000-0000-4000-8000-000000000002";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000004";
const WORKSTREAM_ID = "00000000-0000-4000-8000-000000000005";
const USER_ID = asUserId("00000000-0000-4000-8000-000000000006");
const RUN_ID = "00000000-0000-4000-8000-000000000007";
const HASH = "a".repeat(64);
const OUTPUT_REF = "receipts/output.json";

class SqliteStatement {
  private values: unknown[] = [];
  constructor(private readonly statement: StatementSync) {}
  bind(...values: unknown[]): SqliteStatement { this.values = values; return this; }
  async run(): Promise<D1Result<unknown>> {
    const result = this.statement.run(...this.values as SQLInputValue[]);
    return createTestD1Result({ success: true, meta: { changes: Number(result.changes) } });
  }
  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values as SQLInputValue[]) as T | undefined) ?? null;
  }
  async all<T>(): Promise<D1Result<T>> {
    return createTestD1Result({
      success: true,
      results: this.statement.all(...this.values as SQLInputValue[]) as T[],
    });
  }
}

function sqliteD1(database: DatabaseSync): D1Database {
  return createTestD1Database({
    prepare: (sql: string) => createTestD1PreparedStatement(new SqliteStatement(database.prepare(sql))),
    async batch(statements: D1PreparedStatement[]) {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  });
}

const databases: DatabaseSync[] = [];
const objectStores: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const store of objectStores.splice(0)) store.close();
});

function fixture() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE resources (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'avalon_upload', model_content_sha256 TEXT, updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z');
    CREATE TABLE workstreams (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);
    CREATE TABLE notes (resource_id TEXT NOT NULL, workspace_id TEXT NOT NULL, archived_at TEXT, scope TEXT, owner_user_id TEXT, updated_at TEXT);
    CREATE TABLE resource_object_deletion_outbox (
      object_ref TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, resource_id TEXT NOT NULL, object_kind TEXT NOT NULL,
      cleanup_eligible INTEGER NOT NULL DEFAULT 1,
      attempt_count INTEGER NOT NULL DEFAULT 0, last_error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO resources (id, workspace_id, model_content_sha256) VALUES
      ('${RESOURCE_ID}', '${WORKSPACE_ID}', '${HASH}'),
      ('${SECOND_RESOURCE_ID}', '${WORKSPACE_ID}', '${HASH}');
    INSERT INTO workstreams (id, workspace_id) VALUES ('${WORKSTREAM_ID}', '${WORKSPACE_ID}');
  `);
  // The attachment half is the object's, so it is a real object database with
  // the real schema. What remains in the fake D1 above is the workspace's half:
  // the resource row and its note authorization, which is the split this slice
  // makes visible.
  const objectStore = testWorkstreamObjectStore();
  objectStores.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID });
  for (const resourceId of [RESOURCE_ID, SECOND_RESOURCE_ID]) attachResource(objectStore, resourceId);
  return {
    database,
    objectStore,
    d1: sqliteD1(database),
    agents: testSubstreamAgentsBinding(objectStore),
  };
}

/** Attach one resource to the work stream's object. */
function attachResource(store: DatabaseSync, resourceId: string): void {
  store.prepare(
    `INSERT INTO workstream_resource_links
       (resource_id, attached_by_user_id, watch_enabled, relationship_type,
        resource_json, attached_at, updated_at)
     VALUES (?, NULL, 0, 'attachment', '{}', 1, 1)
     ON CONFLICT(resource_id) DO NOTHING`,
  ).run(resourceId);
}

function readOutput(sha256 = HASH) {
  return {
    resourceId: RESOURCE_ID,
    title: "Brief",
    sourceMimeType: "text/markdown",
    modelMimeType: "text/markdown",
    version: { sha256, extractorVersion: "attachment-text-v2" },
    range: { start: 0, end: 5 },
    totalCharacters: 5,
    charactersBefore: 0,
    charactersReturned: 5,
    charactersAfter: 0,
    text: "Brief",
    previousCursor: null,
    nextCursor: null,
  };
}

/**
 * The work-stream half of the fixture: a real receipt authority on real schema.
 *
 * This module spans two Durable Objects and that is the whole reason it is
 * shaped the way it is. `resources` and the deletion outbox belong to the
 * workspace and stay on `env.DB` above; receipts belong to the work stream and
 * are reached through the typed port. Injecting a `WorkstreamToolReceiptStorage`
 * over the checked-in object schema keeps both halves real — no double stands in
 * for anything that could run here.
 *
 * The previous version of this file called the exported functions with a bare
 * `D1Database`, which selected a second implementation that has since been
 * deleted. It was green against a schema regional D1 has not had since migration
 * 0090, and it was the only coverage the register path had. That is why this
 * rebuild is part of the same change rather than a follow-up.
 */
function receiptAuthority(): { receipts: ToolReceiptObjectPort; sql: ReturnType<typeof createTestSqlStorage> } {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const sql = createTestSqlStorage(database);
  const binding = createCloudflareTestBinding<DurableObjectStorage>({
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    transactionSync: (body: () => unknown) => body(),
    sql,
  });
  applyWorkstreamObjectSchema(binding, "v", 1);
  sql.exec(`INSERT INTO workstream (
      id, workstream_key, parent_workspace_key, parent_do_id, parent_generation, region,
      authority_mode, authority_generation, title, description, preview, scope,
      exact_state, state_reason_code, next_sequence_number, next_attention_ordinal,
      unread_tracking_start_ordinal, authority_epoch, scope_epoch,
      source_authorization_floor, listing_epoch, deletion_epoch, run_revision,
      created_at, last_people_activity_at, state_changed_at, updated_at
    ) VALUES (1,'${WORKSTREAM_ID}','${WORKSPACE_ID}',NULL,0,'global','authoritative',1,'T','','','workspace',
              'idle','s',1,1,0,0,0,0,0,0,0,1,1,1,1)`);
  sql.exec(`INSERT INTO substreams (id,kind,inherit_mode,depth,return_mode,audience,tool_policy,status,created_at)
    VALUES ('0','main','none',0,'none','workspace','full','open',1)`);
  sql.exec(`INSERT INTO runs (run_id, substream_id, status, budget, attempt_epoch,
      model_iteration, next_action_cursor, input_fence_seq, revision, started_at,
      active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
      tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
      created_at, updated_at, legacy_attempt_id, lease_owner, lease_expires_at)
    VALUES ('${RUN_ID}','0','running','{}',0,0,'',0,0,1,0,0,0,0,0,0,0,0,0,0,1,1,'attempt-1','owner-1',9999999999999)`);
  sql.exec(`INSERT INTO tool_effects
      (effect_intent_id, run_id, attempt_epoch, tool_position, occurrence_key, tool_name,
       mode, request_hash, authority_revision, status, tool_call_id, input_json, output_ref)
    VALUES ('${INVOCATION_ID}','${RUN_ID}',0,0,'runtime:${INVOCATION_ID}','read_resource',
            'read','request-hash','runtime','completed','call-1','{}','receipts/output.json')`);
  return {
    receipts: createToolReceiptObjectPort(
      createTestEnv({}),
      WORKSPACE_ID,
      WORKSTREAM_ID,
      new WorkstreamToolReceiptStorage(binding),
    ),
    sql,
  };
}

function target<T extends Record<string, unknown>>(overrides: T): T & {
  workspaceId: string; workstreamId: string;
} {
  return { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, ...overrides };
}

describe("attachment tool receipts", () => {
  it("registers a dependency only while the exact derivative is still current", async () => {
    const { database, d1, agents } = fixture();
    const { receipts, sql } = receiptAuthority();
    const env = createTestEnv({ DB: d1, SUBSTREAM_AGENTS: agents, AVALON_REGION: "global" });

    await registerAttachmentToolReceipt(env, target({
      invocationId: INVOCATION_ID,
      expectedOutputRef: OUTPUT_REF,
      canonicalToolName: "read_resource",
      output: readOutput(),
    }), receipts);
    expect(sql.exec(
      "SELECT resource_id, derivative_sha256 FROM attachment_tool_receipts",
    ).toArray()).toEqual([{ resource_id: RESOURCE_ID, derivative_sha256: HASH }]);

    database.prepare("UPDATE resources SET model_content_sha256 = ? WHERE id = ?")
      .run("b".repeat(64), RESOURCE_ID);
    await expect(registerAttachmentToolReceipt(env, target({
      invocationId: INVOCATION_ID,
      expectedOutputRef: OUTPUT_REF,
      canonicalToolName: "read_resource",
      output: readOutput(),
    }), receipts)).rejects.toThrow("attachment_receipt_version_changed");
    expect(sql.exec("SELECT COUNT(*) AS count FROM attachment_tool_receipts").one().count).toBe(0);
  });

  it("refuses to register against a receipt this work stream does not hold", async () => {
    const { d1, agents } = fixture();
    const { receipts } = receiptAuthority();

    // Cross-work-stream protection used to be a `WHERE workstream_id = ?` on a
    // shared table. It is now structural: another work stream's receipts are in
    // another object, so the row is simply absent and the register fails closed.
    await expect(registerAttachmentToolReceipt(createTestEnv({ DB: d1, SUBSTREAM_AGENTS: agents, AVALON_REGION: "global" }), target({
      invocationId: "00000000-0000-4000-8000-0000000000ff",
      expectedOutputRef: OUTPUT_REF,
      canonicalToolName: "read_resource",
      output: readOutput(),
    }), receipts)).rejects.toThrow("attachment_receipt_version_changed");
  });

  it("requires current authorization and derivative identity on every attachment replay", async () => {
    const { database, objectStore, d1, agents } = fixture();
    const { receipts, sql } = receiptAuthority();
    const env = createTestEnv({ DB: d1, SUBSTREAM_AGENTS: agents, AVALON_REGION: "global" });
    const validate = (capability: string) => validateAttachmentToolReceiptReplay(env, target({
      principal: { type: "user" as const, userId: USER_ID },
      invocationId: INVOCATION_ID,
      capability,
    }), receipts);

    await registerAttachmentToolReceipt(env, target({
      invocationId: INVOCATION_ID,
      expectedOutputRef: OUTPUT_REF,
      canonicalToolName: "read_resource",
      output: readOutput(),
    }), receipts);

    await expect(validate("workstream.resources.read")).resolves.toBe("valid");

    // A receipt that has not completed has nothing to replay, and must be
    // indistinguishable from one with no dependencies at all.
    sql.exec("UPDATE tool_effects SET status = 'executing'");
    await expect(validate("workstream.resources.read")).resolves.toBe("invalid");
    sql.exec("UPDATE tool_effects SET status = 'completed'");

    objectStore.prepare("DELETE FROM workstream_resource_links WHERE resource_id = ?").run(RESOURCE_ID);
    await expect(validate("workstream.resources.read")).resolves.toBe("invalid");
    attachResource(objectStore, RESOURCE_ID);

    await expect(validate("workstream.resources.list")).resolves.toBe("invalid");
    await expect(validate("slack.search")).resolves.toBe("not_attachment");

    database.prepare("UPDATE resources SET model_content_sha256 = ? WHERE id = ?")
      .run("b".repeat(64), RESOURCE_ID);
    await expect(validate("workstream.resources.read")).resolves.toBe("invalid");
  });

  it("removes an invalid replay and queues its durable output for cleanup", async () => {
    const { database, d1, agents } = fixture();
    const { receipts, sql } = receiptAuthority();

    await invalidateAttachmentToolReplay(
      createTestEnv({ DB: d1, SUBSTREAM_AGENTS: agents, AVALON_REGION: "global" }),
      target({ invocationId: INVOCATION_ID }),
      receipts,
    );

    expect(sql.exec("SELECT COUNT(*) AS count FROM tool_effects").one().count).toBe(0);
    expect(database.prepare(
      "SELECT object_ref, object_kind FROM resource_object_deletion_outbox",
    ).get()).toEqual({ object_ref: "receipts/output.json", object_kind: "receipt" });
  });

  it("queues nothing for a receipt that was already gone", async () => {
    const { database, d1, agents } = fixture();
    const { receipts } = receiptAuthority();

    await invalidateAttachmentToolReplay(
      createTestEnv({ DB: d1, SUBSTREAM_AGENTS: agents, AVALON_REGION: "global" }),
      target({ invocationId: "00000000-0000-4000-8000-0000000000ff" }),
      receipts,
    );

    // The ref is what authorizes the outbox row, and a receipt that is not there
    // has none. Enqueuing on a guess would schedule a deletion against an object
    // this work stream may not own.
    expect(database.prepare("SELECT COUNT(*) AS count FROM resource_object_deletion_outbox").get())
      .toEqual({ count: 0 });
  });

  it("rolls back every dependency when one image version changes before registration", async () => {
    const { database, d1, agents } = fixture();
    const { receipts, sql } = receiptAuthority();
    const output = {
      requested: 2,
      returned: 2,
      items: [RESOURCE_ID, SECOND_RESOURCE_ID].map((resourceId, index) => ({
        resourceId,
        title: `Image ${index + 1}`,
        sourceMimeType: "image/png",
        modelMimeType: "image/png" as const,
        version: { sha256: HASH, extractorVersion: "image-v1" },
        sourceBytes: 100,
        derivativeBytes: 80,
        width: 10,
        height: 10,
        status: "included" as const,
        reasonCode: null,
        reason: null,
        suggestedCall: null,
        visualPartIndex: index,
      })),
    };
    database.prepare("UPDATE resources SET model_content_sha256 = ? WHERE id = ?")
      .run("b".repeat(64), SECOND_RESOURCE_ID);

    await expect(registerAttachmentToolReceipt(createTestEnv({ DB: d1, SUBSTREAM_AGENTS: agents, AVALON_REGION: "global" }), target({
      invocationId: INVOCATION_ID,
      expectedOutputRef: OUTPUT_REF,
      canonicalToolName: "view_resource",
      output,
    }), receipts)).rejects.toThrow("attachment_receipt_version_changed");
    // Both, not just the one that moved: a multi-image replay is valid only if
    // every dependency still holds, so a partial receipt is worse than none.
    expect(sql.exec("SELECT COUNT(*) AS count FROM attachment_tool_receipts").one().count).toBe(0);
  });

  it("does not attach or delete dependencies after a successor replaces the output reference", async () => {
    const { database, d1, agents } = fixture();
    const { receipts, sql } = receiptAuthority();
    // The receipt was replanned onto another call and completed again between
    // this caller's completion and its registration. Its dependency belongs to
    // the successor's result, so the loser must neither add to it nor take it
    // away — and the digest is moved too, so the loser reaches its own
    // compensating rollback rather than stopping at the record.
    sql.exec(
      `UPDATE tool_effects SET output_ref = 'receipts/successor.json' WHERE effect_intent_id = ?`,
      INVOCATION_ID,
    );
    sql.exec(
      `INSERT INTO attachment_tool_receipts
       (workspace_id, resource_id, tool_invocation_id, derivative_sha256, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      WORKSPACE_ID,
      SECOND_RESOURCE_ID,
      INVOCATION_ID,
      HASH,
      1,
    );
    database.prepare("UPDATE resources SET model_content_sha256 = ? WHERE id = ?")
      .run("b".repeat(64), RESOURCE_ID);

    await expect(registerAttachmentToolReceipt(createTestEnv({ DB: d1, SUBSTREAM_AGENTS: agents, AVALON_REGION: "global" }), target({
      invocationId: INVOCATION_ID,
      expectedOutputRef: OUTPUT_REF,
      canonicalToolName: "read_resource",
      output: readOutput(),
    }), receipts)).rejects.toThrow("attachment_receipt_version_changed");

    expect(sql.exec(
      `SELECT resource_id, derivative_sha256 FROM attachment_tool_receipts
        WHERE tool_invocation_id = ?`,
      INVOCATION_ID,
    ).toArray()).toEqual([{ resource_id: SECOND_RESOURCE_ID, derivative_sha256: HASH }]);
  });

  it("does not make a mixed image/metadata view result replayable", () => {
    const dependencies = __attachmentToolReceiptTesting.attachmentReceiptDependencies("view_resource", {
      requested: 2,
      returned: 1,
      items: [{
        resourceId: RESOURCE_ID,
        title: "Image",
        sourceMimeType: "image/png",
        modelMimeType: "image/png",
        version: { sha256: HASH, extractorVersion: "image-v1" },
        sourceBytes: 100,
        derivativeBytes: 80,
        width: 10,
        height: 10,
        status: "included",
        reasonCode: null,
        reason: null,
        suggestedCall: null,
        visualPartIndex: 0,
      }, {
        resourceId: SECOND_RESOURCE_ID,
        title: "Private document",
        sourceMimeType: "text/markdown",
        modelMimeType: null,
        version: null,
        sourceBytes: 100,
        derivativeBytes: null,
        width: null,
        height: null,
        status: "skipped",
        reasonCode: "resource_tool_mismatch",
        reason: "Use read_resource",
        suggestedCall: { tool: "read_resource", arguments: { resourceId: SECOND_RESOURCE_ID } },
        visualPartIndex: null,
      }],
    });
    expect(dependencies).toEqual([]);
  });
});
