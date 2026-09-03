import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { WORKSTREAM_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workstream-do";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";

function storage(database: DatabaseSync): DurableObjectStorage {
  return createCloudflareTestBinding<DurableObjectStorage>({
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    transactionSync: (body: () => unknown) => body(),
    sql: createTestSqlStorage(database),
  });
}

function apply(database: DatabaseSync, through: number): void {
  applyDurableObjectSqliteMigrations({
    storage: storage(database),
    migrations: WORKSTREAM_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= through),
    component: "workstream_do_test",
    workerVersionId: `worker-v${through}`,
    now: through,
  });
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

    apply(database, 4);

    expect(database.prepare(
      `SELECT message_id, effect_kind FROM durable_outbox ORDER BY message_id`,
    ).all()).toEqual([{ message_id: "keep", effect_kind: "directory_common" }]);
    expect(() => insert.run("rejected", "suggestion:other", "suggestion_feedback")).toThrow();
  });

  it("drops every retired dashboard table in version 5", () => {
    const database = new DatabaseSync(":memory:");
    apply(database, 4);
    database.exec(`
      INSERT INTO block_dashboard_configuration_versions
        (configuration_version_id, version_number, blocks_json, created_by_user_id, created_at)
      VALUES ('configuration-5', 1, '[]', 'user-5', 5);
      INSERT INTO block_dashboard_block_runs
        (block_run_id, configuration_version_id, block_id, prompt, trigger_sequence,
         harness_run_id, status, created_at)
      VALUES ('run-5', 'configuration-5', 'block-5', 'Retired prompt', 1,
              'harness-5', 'queued', 5);
      INSERT INTO block_dashboard_user_preferences (user_id, visible, updated_at)
      VALUES ('user-5', 1, 5);
      INSERT INTO block_dashboard_dispatch_outbox
        (block_run_id, block_id, dispatch_json, attempts, not_before, created_at)
      VALUES ('run-5', 'block-5', '{}', 0, 5, 5);
      INSERT INTO block_dashboard_block_result_receipts
        (block_run_id, block_id, source_version, payload_hash, received_at)
      VALUES ('run-5', 'block-5', 1, 'hash-5', 5);
      INSERT INTO block_dashboard_source_refresh_outbox
        (id, trigger_sequence, attempts, not_before, created_at, updated_at)
      VALUES (1, 1, 0, 5, 5, 5);
    `);
    expect(database.prepare(
      `SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name LIKE 'block_dashboard_%'
        ORDER BY name`,
    ).all()).toHaveLength(6);

    apply(database, 5);

    expect(database.prepare(
      `SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name LIKE 'block_dashboard_%'`,
    ).all()).toEqual([]);
    expect(database.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
  });
});
