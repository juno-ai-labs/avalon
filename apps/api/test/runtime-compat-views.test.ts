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
