import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  invalidateAttachmentToolReplay,
  registerAttachmentToolReceipt,
  validateAttachmentToolReceiptReplay,
} from "../src/services/attachment-tool-receipts";
import {
  createTestD1Database,
  createTestD1PreparedStatement,
  createTestD1Result,
} from "./helpers/cloudflare-test";

const RESOURCE_ID = "00000000-0000-4000-8000-000000000001";
const INVOCATION_ID = "00000000-0000-4000-8000-000000000002";
const HASH = "a".repeat(64);

class SqliteStatement {
  private values: unknown[] = [];
  constructor(private readonly statement: StatementSync) {}
  bind(...values: unknown[]): SqliteStatement { this.values = values; return this; }
  async run(): Promise<D1Result<unknown>> {
    const result = this.statement.run(...this.values as SQLInputValue[]);
    return createTestD1Result({ success: true, meta: { changes: Number(result.changes) } });
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
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function fixture() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE resources (id TEXT PRIMARY KEY, model_content_sha256 TEXT);
    CREATE TABLE tool_invocations (id TEXT PRIMARY KEY, output_ref TEXT);
    CREATE TABLE attachment_tool_receipts (
      resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      tool_invocation_id TEXT NOT NULL REFERENCES tool_invocations(id) ON DELETE CASCADE,
      derivative_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (resource_id, tool_invocation_id)
    );
    CREATE TABLE resource_object_deletion_outbox (
      object_ref TEXT PRIMARY KEY, resource_id TEXT NOT NULL, object_kind TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0, last_error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO resources (id, model_content_sha256) VALUES ('${RESOURCE_ID}', '${HASH}');
    INSERT INTO tool_invocations (id, output_ref) VALUES ('${INVOCATION_ID}', 'receipts/output.json');
  `);
  return { database, d1: sqliteD1(database) };
}

function readOutput(sha256 = HASH) {
  return {
    resourceId: RESOURCE_ID,
    title: "Brief",
    sourceMimeType: "text/markdown",
    modelMimeType: "text/markdown",
    version: { sha256, extractorVersion: "attachment-text-v1" },
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

describe("attachment tool receipts", () => {
  it("registers a dependency only while the exact derivative is still current", async () => {
    const { database, d1 } = fixture();

    await registerAttachmentToolReceipt(d1, {
      invocationId: INVOCATION_ID,
      canonicalToolName: "read_resource",
      output: readOutput(),
    });
    expect(database.prepare(
      "SELECT resource_id, derivative_sha256 FROM attachment_tool_receipts",
    ).get()).toEqual({ resource_id: RESOURCE_ID, derivative_sha256: HASH });

    database.prepare("UPDATE resources SET model_content_sha256 = ? WHERE id = ?")
      .run("b".repeat(64), RESOURCE_ID);
    await expect(registerAttachmentToolReceipt(d1, {
      invocationId: INVOCATION_ID,
      canonicalToolName: "read_resource",
      output: readOutput(),
    })).rejects.toThrow("attachment_receipt_version_changed");
    expect(database.prepare("SELECT COUNT(*) AS count FROM attachment_tool_receipts").get())
      .toEqual({ count: 0 });
  });

  it("requires current authorization and derivative identity on every attachment replay", async () => {
    const { database, d1 } = fixture();
    await registerAttachmentToolReceipt(d1, {
      invocationId: INVOCATION_ID,
      canonicalToolName: "read_resource",
      output: readOutput(),
    });

    await expect(validateAttachmentToolReceiptReplay(d1, {
      invocationId: INVOCATION_ID,
      capability: "workstream.resources.read",
      visibleResourceIds: new Set([RESOURCE_ID]),
    })).resolves.toBe("valid");
    await expect(validateAttachmentToolReceiptReplay(d1, {
      invocationId: INVOCATION_ID,
      capability: "workstream.resources.read",
      visibleResourceIds: new Set(),
    })).resolves.toBe("invalid");
    await expect(validateAttachmentToolReceiptReplay(d1, {
      invocationId: INVOCATION_ID,
      capability: "workstream.resources.list",
      visibleResourceIds: new Set([RESOURCE_ID]),
    })).resolves.toBe("invalid");
    await expect(validateAttachmentToolReceiptReplay(d1, {
      invocationId: INVOCATION_ID,
      capability: "slack.search",
      visibleResourceIds: new Set(),
    })).resolves.toBe("not_attachment");

    database.prepare("UPDATE resources SET model_content_sha256 = ? WHERE id = ?")
      .run("b".repeat(64), RESOURCE_ID);
    await expect(validateAttachmentToolReceiptReplay(d1, {
      invocationId: INVOCATION_ID,
      capability: "workstream.resources.read",
      visibleResourceIds: new Set([RESOURCE_ID]),
    })).resolves.toBe("invalid");
  });

  it("removes an invalid replay and queues its durable output for cleanup", async () => {
    const { database, d1 } = fixture();

    await invalidateAttachmentToolReplay(d1, INVOCATION_ID);

    expect(database.prepare("SELECT COUNT(*) AS count FROM tool_invocations").get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT object_ref, object_kind FROM resource_object_deletion_outbox",
    ).get()).toEqual({ object_ref: "receipts/output.json", object_kind: "receipt" });
  });
});
