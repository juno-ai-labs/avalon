import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  AGENT_RUN_DISPATCH_LEASE_MS,
  AGENT_RUN_DISPATCH_SWEEP_MS,
  BLOCK_DASHBOARD_RUN_DISPATCHES,
  SUBSTREAM_AGENT_RUN_DISPATCHES,
  claimAgentRunDispatch,
  deferAgentRunDispatch,
  nextAgentRunDispatchWakeUpAt,
  releaseAgentRunDispatchLeases,
  settleAgentRunDispatch,
} from "../src/durable-objects/agent-run-dispatch-queue";
import { BLOCK_DASHBOARD_AGENT_SCHEMA_MIGRATIONS } from "../src/durable-objects/block-dashboard-agent";
import { applyWorkstreamObjectSchema } from "../src/durable-objects/workstream-object-schema";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";

const NOW = 1_760_000_000_000;

/** A workstream object seeded far enough to hold dispatch rows. */
function substreamQueue(): SqlStorage {
  const database = new DatabaseSync(":memory:");
  const sql = createTestSqlStorage(database);
  applyWorkstreamObjectSchema(
    createCloudflareTestBinding<DurableObjectStorage>({
      getAlarm: async () => null,
      setAlarm: async () => undefined,
      transactionSync: (body: () => unknown) => body(),
      sql,
    }),
    "test-worker-version",
    NOW,
  );
  sql.exec(
    `INSERT INTO substreams
       (id, kind, inherit_mode, depth, return_mode, audience, tool_policy, status, created_at)
     VALUES ('0', 'main', 'none', 0, 'none', 'workspace', 'full', 'open', ?)`,
    NOW,
  );
  return sql;
}

function seedRun(sql: SqlStorage, runId: string): void {
  sql.exec(
    `INSERT INTO runs (
       run_id, substream_id, workflow_instance_id, status, budget, attempt_epoch,
       model_iteration, next_action_cursor, input_fence_seq, revision, started_at,
       active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
       tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
       created_at, updated_at
     ) VALUES (?, '0', NULL, 'admitted', '{}', 0, 0, '', 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?, ?)`,
    runId,
    NOW,
    NOW,
    NOW,
  );
}

function enqueue(
  sql: SqlStorage,
  runId: string,
  overrides: {
    state?: string;
    availableAt?: number;
    leaseExpiresAt?: number | null;
    startedAt?: number | null;
    createdAt?: number;
  } = {},
): void {
  seedRun(sql, runId);
  sql.exec(
    `INSERT INTO agent_run_dispatches
       (run_id, input_json, state, attempt, available_at, started_at, completed_at,
        last_error_code, lease_token, lease_expires_at, created_at, updated_at)
     VALUES (?, '{}', ?, 0, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
    runId,
    overrides.state ?? "queued",
    overrides.availableAt ?? NOW,
    overrides.startedAt ?? null,
    overrides.leaseExpiresAt == null ? null : "lease-token",
    overrides.leaseExpiresAt ?? null,
    overrides.createdAt ?? NOW,
    NOW,
  );
}

const RUN_A = "00000000-0000-7000-8000-0000000000c1";
const RUN_B = "00000000-0000-7000-8000-0000000000c2";

describe("agent run dispatch scheduling", () => {
  // The production stall: an invocation claimed a run, was cancelled before it
  // finished, and the scheduler — which consulted an in-memory "a drain is
  // active" flag — computed that nothing was due and deleted the alarm. The
  // row stayed `running` forever with nothing left to rediscover it. The wake-up
  // must come from the rows alone, so no cancellation can suppress it.
  it("keeps a wake-up armed for a run abandoned by a cancelled invocation", () => {
    const sql = substreamQueue();
    enqueue(sql, RUN_A, {
      state: "running",
      startedAt: NOW - 600_000,
      leaseExpiresAt: NOW - 1_000,
    });

    const wakeUpAt = nextAgentRunDispatchWakeUpAt(sql, SUBSTREAM_AGENT_RUN_DISPATCHES, NOW);

    expect(wakeUpAt).not.toBeNull();
    expect(wakeUpAt!).toBeLessThanOrEqual(NOW);
    expect(claimAgentRunDispatch(sql, SUBSTREAM_AGENT_RUN_DISPATCHES, {
      now: NOW,
      leaseToken: "recovering",
    })?.id).toBe(RUN_A);
  });

  it("waits for the lease of a run that is still genuinely in flight", () => {
    const sql = substreamQueue();
    const leaseExpiresAt = NOW + 20_000;
    enqueue(sql, RUN_A, { state: "running", startedAt: NOW, leaseExpiresAt });

    expect(nextAgentRunDispatchWakeUpAt(sql, SUBSTREAM_AGENT_RUN_DISPATCHES, NOW))
      .toBe(leaseExpiresAt);
    expect(claimAgentRunDispatch(sql, SUBSTREAM_AGENT_RUN_DISPATCHES, {
      now: NOW,
      leaseToken: "second-claimant",
    })).toBeNull();
  });

  it("never sleeps past the sweep interval while any dispatch is outstanding", () => {
    const sql = substreamQueue();
    enqueue(sql, RUN_A, {
      state: "running",
      startedAt: NOW,
      leaseExpiresAt: NOW + 10 * AGENT_RUN_DISPATCH_SWEEP_MS,
    });

    expect(nextAgentRunDispatchWakeUpAt(sql, SUBSTREAM_AGENT_RUN_DISPATCHES, NOW))
      .toBe(NOW + AGENT_RUN_DISPATCH_SWEEP_MS);
  });

  // A live lease would otherwise postpone recovery to its expiry, so a run
  // whose owner died seconds ago would wait out the full lease.
  it("recovers a run immediately once the isolate holding its lease is gone", () => {
    const sql = substreamQueue();
    enqueue(sql, RUN_A, {
      state: "running",
      startedAt: NOW - 10_000,
      leaseExpiresAt: NOW + AGENT_RUN_DISPATCH_LEASE_MS,
    });

    releaseAgentRunDispatchLeases(sql, SUBSTREAM_AGENT_RUN_DISPATCHES, NOW);

    expect(nextAgentRunDispatchWakeUpAt(sql, SUBSTREAM_AGENT_RUN_DISPATCHES, NOW))
      .toBeLessThanOrEqual(NOW);
    expect(claimAgentRunDispatch(sql, SUBSTREAM_AGENT_RUN_DISPATCHES, {
      now: NOW,
      leaseToken: "successor",
    })).toMatchObject({ id: RUN_A, started: false });
  });

  it("leaves a terminal dispatch alone when releasing stale leases", () => {
    const sql = substreamQueue();
    enqueue(sql, RUN_A);
    const claim = claimAgentRunDispatch(sql, SUBSTREAM_AGENT_RUN_DISPATCHES, {
      now: NOW,
      leaseToken: "token",
    });
    settleAgentRunDispatch(
      sql,
      SUBSTREAM_AGENT_RUN_DISPATCHES,
      claim!.id,
      claim!.leaseToken,
      "completed",
      null,
      NOW,
    );

    releaseAgentRunDispatchLeases(sql, SUBSTREAM_AGENT_RUN_DISPATCHES, NOW);

    expect(nextAgentRunDispatchWakeUpAt(sql, SUBSTREAM_AGENT_RUN_DISPATCHES, NOW)).toBeNull();
  });

  it("stops scheduling once every dispatch is terminal", () => {
    const sql = substreamQueue();
    enqueue(sql, RUN_A);

    const claim = claimAgentRunDispatch(sql, SUBSTREAM_AGENT_RUN_DISPATCHES, {
      now: NOW,
      leaseToken: "token",
    });
    settleAgentRunDispatch(
      sql,
      SUBSTREAM_AGENT_RUN_DISPATCHES,
      claim!.id,
      claim!.leaseToken,
      "completed",
      null,
      NOW,
    );

    expect(nextAgentRunDispatchWakeUpAt(sql, SUBSTREAM_AGENT_RUN_DISPATCHES, NOW)).toBeNull();
    expect(claimAgentRunDispatch(sql, SUBSTREAM_AGENT_RUN_DISPATCHES, {
      now: NOW,
      leaseToken: "nobody",
    })).toBeNull();
  });
});

describe("agent run dispatch claiming", () => {
  it("leases a queued run and reports that it must be started", () => {
    const sql = substreamQueue();
    enqueue(sql, RUN_A);

    const claim = claimAgentRunDispatch(sql, SUBSTREAM_AGENT_RUN_DISPATCHES, {
      now: NOW,
      leaseToken: "token",
    });

    expect(claim).toMatchObject({
      id: RUN_A,
      started: true,
      attempt: 1,
      leaseExpiresAt: NOW + AGENT_RUN_DISPATCH_LEASE_MS,
    });
  });

  it("reclaims a run whose lease expired without restarting its bookkeeping", () => {
    const sql = substreamQueue();
    enqueue(sql, RUN_A, {
      state: "running",
      startedAt: NOW - 600_000,
      leaseExpiresAt: NOW - 1,
    });

    const claim = claimAgentRunDispatch(sql, SUBSTREAM_AGENT_RUN_DISPATCHES, {
      now: NOW,
      leaseToken: "recovering",
    });

    // `started` stays false so the caller does not re-announce a run that the
    // member already saw begin.
    expect(claim).toMatchObject({ id: RUN_A, started: false, attempt: 1 });
  });

  it("hands one dispatch to only one claimant", () => {
    const sql = substreamQueue();
    enqueue(sql, RUN_A);

    const first = claimAgentRunDispatch(sql, SUBSTREAM_AGENT_RUN_DISPATCHES, {
      now: NOW,
      leaseToken: "first",
    });
    const second = claimAgentRunDispatch(sql, SUBSTREAM_AGENT_RUN_DISPATCHES, {
      now: NOW,
      leaseToken: "second",
    });

    expect(first?.id).toBe(RUN_A);
    expect(second).toBeNull();
  });

  it("recovers an interrupted run before starting newer queued work", () => {
    const sql = substreamQueue();
    enqueue(sql, RUN_A, { createdAt: NOW - 1_000 });
    enqueue(sql, RUN_B, {
      state: "running",
      startedAt: NOW - 600_000,
      leaseExpiresAt: NOW - 1,
      createdAt: NOW,
    });

    const claim = claimAgentRunDispatch(sql, SUBSTREAM_AGENT_RUN_DISPATCHES, {
      now: NOW,
      leaseToken: "token",
    });

    expect(claim?.id).toBe(RUN_B);
  });

  it("drops the lease when a run is deferred so rediscovery is not postponed", () => {
    const sql = substreamQueue();
    enqueue(sql, RUN_A);

    const claim = claimAgentRunDispatch(sql, SUBSTREAM_AGENT_RUN_DISPATCHES, {
      now: NOW,
      leaseToken: "token",
    });
    const retryAt = NOW + 5_000;
    deferAgentRunDispatch(
      sql,
      SUBSTREAM_AGENT_RUN_DISPATCHES,
      claim!.id,
      claim!.leaseToken,
      retryAt,
      "transient",
      NOW,
    );

    expect(nextAgentRunDispatchWakeUpAt(sql, SUBSTREAM_AGENT_RUN_DISPATCHES, NOW)).toBe(retryAt);
    expect(claimAgentRunDispatch(sql, SUBSTREAM_AGENT_RUN_DISPATCHES, {
      now: retryAt,
      leaseToken: "next",
    })?.id).toBe(RUN_A);
  });
});

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
});
