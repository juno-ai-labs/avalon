/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * WorkspaceDO migration 83 indexes `authorization_delivery.not_before`, the
 * column the alarm reads as `MIN(not_before)` on every wake and every re-arm to
 * decide whether that lane is due.
 *
 * On real workerd because the claim is about what workerd's SQLite reads: the
 * test counts `rowsRead` for the lane's own due query over a populated table,
 * which no plan string or Node double can stand in for. The historical schema
 * and its upgrade commit in separate object events, as
 * `durable-object-sqlite.md` requires of an upgrade test.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const INDEX_MIGRATION = 83;
const COMPONENT = "workspace_do";
const ROWS = 500;

describe("the WorkspaceDO authorization delivery index migration on workerd", () => {
  it("given an object on the previous schema holding waiting deliveries, when 83 applies, then the due read touches one row", async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName("workspace-authorization-delivery-index-v81");
    await stub.ping();

    await runInDurableObject(stub, (_instance, state) => {
      const before = WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((m) => m.version < INDEX_MIGRATION);
      expect(before.at(-1)?.version).toBe(INDEX_MIGRATION - 1);
      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: before,
        component: COMPONENT,
        workerVersionId: "worker-before-delivery-index",
        now: 1_000,
      });
      for (let index = 0; index < ROWS; index++) {
        // Descending due times, so the earliest is the last row written and
        // not the first a key-order scan would meet.
        state.storage.sql.exec(
          "INSERT INTO authorization_delivery(job_key, payload_json, not_before, revision) VALUES (?, ?, ?, ?)",
          JSON.stringify([`parent-${index}`, null]), JSON.stringify({ index }), 10_000 - index, 1 + (index % 3),
        );
      }
    });

    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
        component: COMPONENT,
        workerVersionId: "worker-with-delivery-index",
        now: 2_000,
      });
      const sql = state.storage.sql;
      expect(sql.exec<{ version: number }>(
        "SELECT version FROM _sql_schema_migrations WHERE version = ?", INDEX_MIGRATION,
      ).toArray()).toEqual([{ version: INDEX_MIGRATION }]);

      // The alarm lane's own due read, exactly as it runs: one row read, not
      // one per waiting delivery.
      const due = sql.exec<{ due: number | null }>("SELECT MIN(not_before) AS due FROM authorization_delivery");
      expect(due.one().due).toBe(10_000 - (ROWS - 1));
      expect(due.rowsRead).toBe(1);
    });
  });
});
