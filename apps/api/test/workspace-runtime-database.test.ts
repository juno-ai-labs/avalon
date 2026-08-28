import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  __workspaceRuntimeDatabaseTesting,
  workspaceRuntimeDatabase,
} from "../src/services/workspace-runtime-database";
import type { WorkspaceRuntimeSqlResult } from "../src/durable-objects/workspace-runtime-sql";
import { createTestEnv } from "./helpers/cloudflare-test";
import { sqliteD1 } from "./helpers/sqlite-d1";

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000501";

describe("workspace runtime database routing", () => {
  it("reads the conflict clause as part of the verb, not as the table", () => {
    // The resource-alias allocator's statement. Reading `OR` as the table made
    // the router refuse it as cross-authority, so allocation threw at prepare
    // time on every path and the maintenance pass that owns the backfill was
    // due forever without ever naming a row.
    expect(__workspaceRuntimeDatabaseTesting.localStatement(
      `UPDATE OR IGNORE resources SET slug = ?
        WHERE id = ? AND workspace_id = ? AND slug IS NULL
        RETURNING slug`,
    )).toBe(true);
    // The same reading on the other verbs, and the refusal it must not lose:
    // a conflict clause is not a licence to write a table the object lacks.
    expect(__workspaceRuntimeDatabaseTesting.localStatement(
      "INSERT OR IGNORE INTO resources (id, workspace_id) VALUES (?, ?)",
    )).toBe(true);
    expect(() => __workspaceRuntimeDatabaseTesting.localStatement(
      `UPDATE OR REPLACE workspace_members SET role = ?
        WHERE user_id IN (SELECT uploaded_by_user_id FROM resources)`,
    )).toThrow("workspace_runtime_cross_authority_statement:workspace_members");
  });

  it("rejects a read that joins a local table to one only the region has", () => {
    // The statement `slackUserIsLinked` used to run. It named a local table, so
    // this router claimed it, and executed it inside an object with no
    // `workspace_members` — which surfaced in production as `no such table`
    // on every Slack run-outcome delivery, retried until the ingress budget
    // was spent, rather than as anything naming the boundary it crossed.
    expect(() => __workspaceRuntimeDatabaseTesting.localStatement(
      `SELECT 1 AS linked
         FROM slack_user_links l
         JOIN workspace_members wm
           ON wm.workspace_id = l.workspace_id AND wm.user_id = l.user_id
        WHERE l.connection_id = ? AND l.status = 'active' AND wm.status = 'active'`,
    )).toThrow("workspace_runtime_cross_authority_statement:workspace_members");

    // The halves each execute somewhere, and the router still says where.
    expect(__workspaceRuntimeDatabaseTesting.localStatement(
      "SELECT user_id FROM slack_user_links WHERE connection_id = ? AND status = 'active'",
    )).toBe(true);
    expect(__workspaceRuntimeDatabaseTesting.localStatement(
      "SELECT 1 AS linked FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
    )).toBe(false);
  });

  it("keeps object tables that the local list does not name on the local side", () => {
    // WorkspaceDO holds more tables than `WORKSPACE_LOCAL_TABLES` enumerates,
    // so the guard above keys off a regional-only list rather than off
    // "anything unlisted". These would break if it did.
    expect(__workspaceRuntimeDatabaseTesting.localStatement(
      `SELECT directory.title FROM workspace_workstream_directory directory
         JOIN workspace_workstream_pins pin ON pin.workstream_id = directory.workstream_id`,
    )).toBe(true);
    // `workspaces` must not match inside `workspace_workstream_directory`, and
    // `sessions` must not match inside `slack_agent_sessions`.
    expect(__workspaceRuntimeDatabaseTesting.localStatement(
      "SELECT id FROM slack_agent_sessions WHERE workspace_id = ?",
    )).toBe(true);
  });

  it("rejects regional mutations that smuggle a WorkspaceDO table through a subquery", () => {
    expect(() => __workspaceRuntimeDatabaseTesting.localStatement(
      `INSERT INTO audit_events (id, workspace_id)
       SELECT 'audit', workspace_id FROM slack_agent_sessions WHERE id = 'session'`,
    )).toThrow("workspace_runtime_cross_authority_statement");
    expect(__workspaceRuntimeDatabaseTesting.localStatement(
      "INSERT INTO audit_events (id, workspace_id) VALUES ('audit', 'workspace')",
    )).toBe(false);
  });

  it("routes workspace product tables locally, leaves control rows in D1, and rejects mixed batches", async () => {
    const regional = new DatabaseSync(":memory:");
    regional.exec(`
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO workspaces (id, name) VALUES ('${WORKSPACE_ID}', 'Control plane');
    `);
    const calls: Array<Array<{ sql: string; params: Array<string | number | null> }>> = [];
    const local = async (
      statements: Array<{ sql: string; params: Array<string | number | null> }>,
    ): Promise<WorkspaceRuntimeSqlResult[]> => {
      calls.push(statements);
      return statements.map(() => ({
        columns: ["id", "title"],
        rows: [{ id: "resource-1", title: "Workspace authority" }],
        changes: 0,
      }));
    };
    const database = workspaceRuntimeDatabase(
      createTestEnv({ DB: sqliteD1(regional), AVALON_REGION: "global" }),
      WORKSPACE_ID,
      local,
    );
    try {
      await expect(database.prepare("SELECT id, title FROM resources WHERE workspace_id = ?")
        .bind(WORKSPACE_ID).first()).resolves.toEqual({
        id: "resource-1",
        title: "Workspace authority",
      });
      await expect(database.prepare("SELECT name FROM workspaces WHERE id = ?")
        .bind(WORKSPACE_ID).first("name")).resolves.toBe("Control plane");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual([{
        sql: "SELECT id, title FROM resources WHERE workspace_id = ?",
        params: [WORKSPACE_ID],
      }]);

      await expect(database.batch([
        database.prepare("SELECT id FROM resources WHERE workspace_id = ?").bind(WORKSPACE_ID),
        database.prepare("SELECT id FROM workspaces WHERE id = ?").bind(WORKSPACE_ID),
      ])).rejects.toThrow("workspace_runtime_cross_authority_transaction");
      await expect(database.exec(
        "SELECT id FROM resources; SELECT id FROM workspaces",
      )).rejects.toThrow("workspace_runtime_cross_authority_transaction");
      expect(calls).toHaveLength(1);
    } finally {
      regional.close();
    }
  });
});
