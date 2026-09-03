import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { WORKSTREAM_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workstream-do";

function apply(database: DatabaseSync, through: number, after = 0): void {
  for (const migration of WORKSTREAM_DO_SCHEMA_MIGRATIONS) {
    if (migration.version <= after) continue;
    if (migration.version > through) break;
    for (const statement of migration.statements) database.exec(statement);
  }
}

describe("the WorkstreamDO migration ledger", () => {
  it("drops pending suggestion feedback while preserving every supported effect", () => {
    const database = new DatabaseSync(":memory:");
    apply(database, 3);
    const insert = database.prepare(
      `INSERT INTO durable_outbox
         (message_id, partition_key, source_version, source_epoch, effect_kind,
          payload_json, payload_hash, state, attempts, not_before, created_at)
       VALUES (?, ?, 1, 1, ?, '{}', 'hash', 'pending', 0, 0, 0)`,
    );
    insert.run("keep", "common", "directory_common");
    insert.run("retire", "suggestion:action", "suggestion_feedback");

    apply(database, 4, 3);

    expect(database.prepare(
      `SELECT message_id, effect_kind FROM durable_outbox ORDER BY message_id`,
    ).all()).toEqual([{ message_id: "keep", effect_kind: "directory_common" }]);
    expect(() => insert.run("rejected", "suggestion:other", "suggestion_feedback")).toThrow();
  });

  it("drops every retired dashboard table in version 5", () => {
    const database = new DatabaseSync(":memory:");
    apply(database, 4);
    expect(database.prepare(
      `SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name LIKE 'block_dashboard_%'
        ORDER BY name`,
    ).all()).toHaveLength(6);

    apply(database, 5, 4);

    expect(database.prepare(
      `SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name LIKE 'block_dashboard_%'`,
    ).all()).toEqual([]);
  });
});
