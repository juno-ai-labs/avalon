import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  AGENT_RUN_DISPATCH_LEASE_MS,
  BLOCK_DASHBOARD_RUN_DISPATCHES,
  claimAgentRunDispatch,
  deferAgentRunDispatch,
  nextAgentRunDispatchWakeUpAt,
  settleAgentRunDispatch,
} from "../src/durable-objects/agent-run-dispatch-queue";
import { BLOCK_DASHBOARD_AGENT_SCHEMA_MIGRATIONS } from "../src/durable-objects/block-dashboard-agent";
import { createTestSqlStorage } from "./helpers/sql-storage";

const NOW = 1_760_000_000_000;

describe("block dashboard dispatch scheduling", () => {
  function blockQueue(): SqlStorage {
    const database = new DatabaseSync(":memory:");
    const sql = createTestSqlStorage(database);
    for (const migration of BLOCK_DASHBOARD_AGENT_SCHEMA_MIGRATIONS) {
      for (const statement of migration.statements) sql.exec(statement);
    }
    sql.exec(
      `INSERT INTO agent_run_dispatches
         (block_run_id, dispatch_json, configuration_version_number, trigger_sequence,
          source_created_at, state, attempt, available_at, started_at, completed_at,
          last_error_code, lease_token, lease_expires_at, created_at, updated_at)
       VALUES ('block-run', '{}', 1, 0, ?, 'running', 1, ?, ?, NULL, NULL, 'stale', ?, ?, ?)`,
      NOW,
      NOW,
      NOW - 600_000,
      NOW - 1_000,
      NOW,
      NOW,
    );
    return sql;
  }

  it("keeps a wake-up armed for an abandoned block run", () => {
    const sql = blockQueue();

    const wakeUpAt = nextAgentRunDispatchWakeUpAt(sql, BLOCK_DASHBOARD_RUN_DISPATCHES, NOW);

    expect(wakeUpAt).not.toBeNull();
    expect(wakeUpAt!).toBeLessThanOrEqual(NOW);
    expect(claimAgentRunDispatch(sql, BLOCK_DASHBOARD_RUN_DISPATCHES, {
      now: NOW,
      leaseToken: "recovering",
    })?.id).toBe("block-run");
  });

  it("fences a stale BlockDashboard executor from releasing a successor lease", () => {
    const sql = blockQueue();
    const stale = claimAgentRunDispatch(sql, BLOCK_DASHBOARD_RUN_DISPATCHES, {
      now: NOW,
      leaseToken: "stale-executor",
    });
    expect(stale?.id).toBe("block-run");
    sql.exec(
      `UPDATE agent_run_dispatches
          SET lease_token = 'successor', lease_expires_at = ?, updated_at = ?
        WHERE block_run_id = 'block-run'`,
      NOW + AGENT_RUN_DISPATCH_LEASE_MS,
      NOW,
    );

    expect(deferAgentRunDispatch(
      sql,
      BLOCK_DASHBOARD_RUN_DISPATCHES,
      "block-run",
      "stale-executor",
      NOW + 5_000,
      "stale_failure",
      NOW,
    )).toBe(false);
    expect(settleAgentRunDispatch(
      sql,
      BLOCK_DASHBOARD_RUN_DISPATCHES,
      "block-run",
      "stale-executor",
      "failed",
      "stale_failure",
      NOW,
    )).toBe(false);
    expect(sql.exec<{
      state: string;
      lease_token: string | null;
      completed_at: number | null;
      last_error_code: string | null;
    }>(
      `SELECT state, lease_token, completed_at, last_error_code
         FROM agent_run_dispatches WHERE block_run_id = 'block-run'`,
    ).toArray()[0]).toEqual({
      state: "running",
      lease_token: "successor",
      completed_at: null,
      last_error_code: null,
    });
  });
});
