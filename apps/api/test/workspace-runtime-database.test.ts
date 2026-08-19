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
