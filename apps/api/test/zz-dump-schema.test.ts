import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { describe, it } from "vitest";

import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS } from "../src/durable-objects/workstream-object-schema";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";

function storageFor(database: DatabaseSync): DurableObjectStorage {
  return createCloudflareTestBinding<DurableObjectStorage>({
    transactionSync: <T>(body: () => T): T => {
      database.exec("BEGIN IMMEDIATE");
      try { const result = body(); database.exec("COMMIT"); return result; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    },
    sql: createTestSqlStorage(database),
  });
}

describe("dump", () => {
  it("dumps", () => {
    const database = new DatabaseSync(":memory:");
    applyDurableObjectSqliteMigrations({
      storage: storageFor(database),
      migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
      component: "workstream_object",
      workerVersionId: "dump",
    });
    const rows = database.prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name = 'workstream' ORDER BY type, name",
    ).all() as unknown[];
    const refs = database.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='table' AND sql LIKE '%REFERENCES workstream%'",
    ).all() as unknown[];
    writeFileSync(
      "/tmp/claude-0/-home-user-avalon/1d691b4b-da0d-5d16-b008-046048a8198b/scratchpad/phase1/substream-agent-workstream-table.json",
      JSON.stringify({ rows, refs }, null, 2),
    );
  });
});
