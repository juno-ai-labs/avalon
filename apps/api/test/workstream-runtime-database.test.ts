import { describe, expect, it } from "vitest";

import {
  __workstreamRuntimeDatabaseTesting,
  workstreamRuntimeDatabase,
} from "../src/services/workstream-runtime-database";
import { createTestEnv } from "./helpers/cloudflare-test";
import type { WorkstreamRuntimeSqlResult } from "../src/durable-objects/workstream-runtime-sql";
import { DatabaseSync } from "node:sqlite";
import { sqliteD1 } from "./helpers/sqlite-d1";

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000601";
const WORKSTREAM_ID = "00000000-0000-7000-8000-000000000602";

describe("work-stream runtime database routing", () => {
  it("routes wake-up persistence to the owning WorkstreamDO", () => {
    expect(__workstreamRuntimeDatabaseTesting.localStatement(
      "SELECT id FROM workstream_wakeups WHERE workstream_id = ?",
    )).toBe(true);
  });

  it("leaves workspace-owned resource and identity reads for the underlying workspace router", () => {
    expect(__workstreamRuntimeDatabaseTesting.localStatement(
      "SELECT title FROM resources WHERE workspace_id = ?",
    )).toBe(false);
    expect(__workstreamRuntimeDatabaseTesting.localStatement(
      "SELECT name FROM users WHERE id = ?",
    )).toBe(false);
  });

  it("rejects exec batches that span work-stream and parent authorities", async () => {
    const underlying = new DatabaseSync(":memory:");
    underlying.exec("CREATE TABLE resources (id TEXT PRIMARY KEY)");
    const local = async (
      statements: Array<{ sql: string; params: Array<string | number | null> }>,
    ): Promise<WorkstreamRuntimeSqlResult[]> => statements.map(() => ({
      columns: [], rows: [], changes: 0,
    }));
    const database = workstreamRuntimeDatabase(
      createTestEnv({ DB: sqliteD1(underlying), AVALON_REGION: "global" }),
      WORKSPACE_ID,
      WORKSTREAM_ID,
      "0",
      local,
    );
    try {
      await expect(database.exec(
        "SELECT id FROM messages; SELECT id FROM resources",
      )).rejects.toThrow("workstream_runtime_cross_authority_transaction");
    } finally {
      underlying.close();
    }
  });
});
