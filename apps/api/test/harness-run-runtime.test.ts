import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { runHarness, type HarnessTool } from "@rally/agent-harness";
import { asHarnessRunId, asUserId, asWorkspaceId, asWorkstreamId, type HarnessRunId } from "@rally/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CoalescedRunLiveness,
  cancelDescendantHarnessRuns,
  claimHarnessAttempt,
  checkpointToolInvocation,
  completeToolInvocation,
  finalizeToolInvocationFailure,
  heartbeatHarnessAttempt,
  loadPersistedHarnessHostOutcome,
  markToolInvocationTimedOut,
  persistHarnessHostOutcome,
  persistImmutableRunScope,
  persistRunPluginActivation,
  persistToolExecutionPlan,
  reapStaleHarnessRuns,
  recordInferenceAttempt,
  terminalizeQueuedHarnessRun,
  terminalizeHarnessAttempt,
  __harnessRunRuntimeTesting,
} from "../src/runtime/harness-run-runtime";
import { __integrationTesting } from "../src/services/integrations";
import { createCloudflareTestBinding, createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";
import {
  seedCanonicalConversationTurn,
  seedWorkstreamRun,
  seedWorkstreamObjectRoot,
  testWorkstreamObjectStore,
  testHarnessRunPort,
  testMessagePort,
  testToolReceiptPort,
} from "./helpers/durable-authority";
import { legacyProductSqliteDatabase } from "./helpers/sqlite-d1";
import { responsesStreamResponse } from "@rally/agent-harness/test-support/responses-stream";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-000000000001");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-4000-8000-000000000002");
const RUN_ONE = asHarnessRunId("00000000-0000-4000-8000-000000000003");
const RUN_TWO = asHarnessRunId("00000000-0000-4000-8000-000000000004");

class SqliteD1Statement {
  private values: unknown[] = [];

  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): SqliteD1Statement {
    this.values = values;
    return this;
  }

  async run(): Promise<D1Result<unknown>> {
    const result = this.statement.run(...this.values as SQLInputValue[]);
    return createTestD1Result<unknown>({ success: true, meta: { changes: Number(result.changes) } });
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values as SQLInputValue[]) as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return createTestD1Result<T>({
      success: true,
      results: this.statement.all(...this.values as SQLInputValue[]) as T[],
      meta: { changes: 0 },
    });
  }
}

class SqliteD1Database {
  readonly binding: D1Database;
  private batchTail: Promise<void> = Promise.resolve();

  constructor(readonly database: DatabaseSync) {
    this.binding = createTestD1Database({
      prepare: (sql: string) => createTestD1PreparedStatement(new SqliteD1Statement(database.prepare(sql))),
      batch: (statements: D1PreparedStatement[]) => {
        const batch = this.batchTail.then(async () => {
          const results: D1Result<unknown>[] = [];
          database.exec("BEGIN");
          try {
            for (const statement of statements) {
              results.push(await (statement as unknown as SqliteD1Statement).run());
            }
            database.exec("COMMIT");
            return results;
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
        });
        this.batchTail = batch.then(() => undefined, () => undefined);
        return batch;
      },
    });
  }
}

/**
 * A narrow prepare/exec facade for normalized fixture setup and inspection.
 */
interface ObjectFacade {
  prepare(sql: string): {
    get(...params: Array<string | number | null>): Record<string, string | number | null> | undefined;
    all(...params: Array<string | number | null>): Array<Record<string, string | number | null>>;
    run(...params: Array<string | number | null>): { changes: number };
  };
  exec(script: string): void;
}

function objectFacade(object: DatabaseSync): ObjectFacade {
  return {
    prepare: (sql: string) => ({
      get: (...params: Array<string | number | null>) =>
        object.prepare(sql).get(...params as SQLInputValue[]) as
          Record<string, string | number | null> | undefined,
      all: (...params: Array<string | number | null>) => object.prepare(sql)
        .all(...params as SQLInputValue[]) as Array<Record<string, string | number | null>>,
      run: (...params: Array<string | number | null>) => {
        const result = object.prepare(sql).run(...params as SQLInputValue[]);
        return { changes: Number(result.changes) };
      },
    }),
    exec: (script: string) => object.exec(script),
  };
}

interface RuntimeFixture {
  /** The regional (D1) database: users, workspaces, directory, automation rows. */
  database: DatabaseSync;
  /** Normalized access to the work stream's object database. */
  object: ObjectFacade;
  /** Regional D1 for automation delivery settlement, never work-stream state. */
  binding: D1Database;
  receipts: ReturnType<typeof testToolReceiptPort>;
  runs: ReturnType<typeof testHarnessRunPort>;
  messages: ReturnType<typeof testMessagePort>;
  /** The raw object database, for the rare normalized-table statement. */
  objectDatabase: DatabaseSync;
}

function fixture(): RuntimeFixture {
  const database = legacyProductSqliteDatabase();
  database.exec(`
    INSERT INTO users
      (id, google_subject, email, name, created_at, updated_at)
    VALUES ('user-runtime', 'google-runtime', 'runtime@example.com', 'Runtime', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces
      (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE_ID}', 'Runtime', 'runtime', 'global', 'user-runtime', '2026-01-01', '2026-01-01');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, last_activity_at, created_at, updated_at)
    VALUES ('${WORKSTREAM_ID}', '${WORKSPACE_ID}', 'Runtime', 'Runtime', 'ad_hoc', 'user-runtime',
            'idle', '2026-01-01', '2026-01-01', '2026-01-01');
  `);
  // The run receipts and work-stream product state live in the work stream's
  // object since migration 0090 dropped the regional D1 copies.
  const objectDatabase = testWorkstreamObjectStore();
  openDatabases.push(objectDatabase);
  seedWorkstreamObjectRoot(objectDatabase, {
    workstreamId: WORKSTREAM_ID,
    workspaceId: WORKSPACE_ID,
    title: "Runtime",
    description: "Runtime",
    originType: "ad_hoc",
    createdByUserId: "user-runtime",
    exactState: "idle",
  });
  const object = objectFacade(objectDatabase);
  // Seeded 'admitted', not 'running': the object permits one mutating run per
  // substream (`runs_mutating_substream_uq`), so two pre-claimed running rows
  // could not coexist — and claiming is what moves a run to running anyway.
  seedWorkstreamRun(objectDatabase, { id: RUN_ONE, status: "admitted",
    executionPrincipalJson: '{"type":"user","userId":"user-runtime"}' });
  seedWorkstreamRun(objectDatabase, { id: RUN_TWO, status: "admitted",
    executionPrincipalJson: '{"type":"user","userId":"user-runtime"}' });
  return {
    database,
    binding: new SqliteD1Database(database).binding,
    object,
    objectDatabase,
    // The receipt operations no longer take a database handle: the lease fence
    // moved inside the object, so they take the port instead.
    receipts: testToolReceiptPort(objectDatabase),
    runs: testHarnessRunPort(objectDatabase),
    messages: testMessagePort(objectDatabase),
  };
}

/** Records which operations a port was asked for, in order. */
function countingPort<T extends object>(port: T, calls: string[]): T {
  return new Proxy(port, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function" || typeof property !== "string") return value;
      return (...args: unknown[]) => {
        calls.push(property);
        return (value as (...rest: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

const openDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

function input(harnessRunId: HarnessRunId) {
  return { workspaceId: WORKSPACE_ID, parentId: WORKSTREAM_ID, harnessRunId };
}

function seedAutomationRun(sqlite: RuntimeFixture, suffix: string): string {
  const templateId = `automation-template-${suffix}`;
  const versionId = `automation-template-version-${suffix}`;
  const subscriptionId = `automation-subscription-${suffix}`;
  const runId = `automation-run-${suffix}`;
  sqlite.database.prepare(
    `INSERT INTO automation_templates
      (id, workspace_id, owner_user_id, name, description, sharing_state,
       latest_version_number, created_at, updated_at)
     VALUES (?, ?, 'user-runtime', 'Stale run', 'Stale run', 'workspace', 1,
             '2026-08-03', '2026-08-03')`,
  ).run(templateId, WORKSPACE_ID);
  sqlite.database.prepare(
    `INSERT INTO automation_template_versions
      (id, template_id, version_number, instructions, trigger_definitions_json,
       required_capabilities_json, expected_outputs_json, default_behavior_json,
       created_by_user_id, created_at)
     VALUES (?, ?, 1, 'Run', '[]', '[]', '[]', '{}', 'user-runtime', '2026-08-03')`,
  ).run(versionId, templateId);
  sqlite.database.prepare(
    `INSERT INTO automation_subscriptions
      (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
       execution_principal_json, connector_bindings_json, overrides_json,
       status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'workspace', NULL, '{"type":"workspace"}', '{}', '{}',
             'active', '2026-08-03', '2026-08-03')`,
  ).run(subscriptionId, WORKSPACE_ID, templateId, versionId);
  sqlite.database.prepare(
    `INSERT INTO automation_runs
      (id, workspace_id, automation_subscription_id, workstream_id, trigger_type,
       started_at, status, created_at)
     VALUES (?, ?, ?, ?, 'scheduled', '2026-08-03T00:00:00.000Z', 'running',
             '2026-08-03T00:00:00.000Z')`,
  ).run(runId, WORKSPACE_ID, subscriptionId, WORKSTREAM_ID);
  return runId;
}

/**
 * The member-visible half of a started tool call: the transcript row the host
 * writes on `tool_started`, keyed by the receipt it was planned against. The
 * spinner these tests are about is this row's `tool_status`, so asserting on
 * the receipt alone would not have caught the symptom.
 */
function seedPendingToolCard(sqlite: RuntimeFixture, invocationId: string, toolName: string): void {
  seedCanonicalConversationTurn(sqlite.object, {
    turnId: invocationId,
    clientMessageId: `tool:${invocationId}`,
    actor: "assistant",
    authorSnapshot: null,
    messageType: "tool",
    text: "",
    structuredContentJson: JSON.stringify({
      invocation: { id: invocationId, toolName, status: "started" },
    }),
    transcriptSequence: 90,
    createdAt: "2026-08-03T00:00:00.000Z",
  });
}

describe("durable harness attempt runtime", () => {
  it("canonicalizes persisted receipt keys by UTF-16 code unit", () => {
    expect(__harnessRunRuntimeTesting.stableJson({ "é": 3, a: 2, "😀": 4, Z: 1 }))
      .toBe('{"Z":1,"a":2,"é":3,"😀":4}');
  });

  it("preserves final-turn authority failures instead of relabeling them as missing data", async () => {
    const transportFailure = new Error("workstream_object_unavailable");
    const runs = {
      lifecycleEvent: async () => ({
        event_type: "host_outcome_persisted",
        member_safe_payload_json: JSON.stringify({ finalTurnId: "run-one:turn:1" }),
      }),
      finalAssistantTurn: async () => {
        throw transportFailure;
      },
    };

    await expect(__harnessRunRuntimeTesting.assertFinalTurnPersisted(
      runs as never,
      "run-one",
      "run-one:turn:1",
    )).rejects.toBe(transportFailure);
  });

  it("requires the final-turn checkpoint and canonical turn to name the same identity", async () => {
    const finalAssistantTurn = vi.fn(async () => ({ turn_id: "run-one:turn:1" }));
    const runs = (payload: string, eventType = "host_outcome_persisted") => ({
      lifecycleEvent: async () => ({
        event_type: eventType,
        member_safe_payload_json: payload,
      }),
      finalAssistantTurn,
    });

    await expect(__harnessRunRuntimeTesting.assertFinalTurnPersisted(
      runs("not-json") as never,
      "run-one",
      "run-one:turn:1",
    )).rejects.toThrow("final_turn_not_persisted");
    await expect(__harnessRunRuntimeTesting.assertFinalTurnPersisted(
      runs(JSON.stringify({ finalTurnId: "run-one:turn:2" })) as never,
      "run-one",
      "run-one:turn:1",
    )).rejects.toThrow("final_turn_not_persisted");
    await expect(__harnessRunRuntimeTesting.assertFinalTurnPersisted(
      runs(JSON.stringify({ finalTurnId: "run-one:turn:1" }), "final_message_persisted") as never,
      "run-one",
      "run-one:turn:1",
    )).rejects.toThrow("final_turn_not_persisted");
    expect(finalAssistantTurn).not.toHaveBeenCalled();

    finalAssistantTurn.mockResolvedValueOnce({ turn_id: "run-one:turn:2" });
    await expect(__harnessRunRuntimeTesting.assertFinalTurnPersisted(
      runs(JSON.stringify({ finalTurnId: "run-one:turn:1" })) as never,
      "run-one",
      "run-one:turn:1",
    )).rejects.toThrow("final_turn_not_persisted");
  });

  it("serializes attempts, freezes scope, persists activation, and terminalizes once", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const first = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-one",
      owner: "owner-one",
    });
    expect(first.state).toBe("claimed");
    if (first.state !== "claimed") throw new Error("expected claimed attempt");

    const queued = await claimHarnessAttempt(sqlite.runs, input(RUN_TWO), {
      attemptId: "attempt-two",
      owner: "owner-two",
    });
    expect(queued.state).toBe("busy");

    const scope = {
      executionPrincipal: { type: "user", userId: "user-runtime" },
      eligibleConnectionIds: ["connection-b", "connection-a", "connection-a"],
      eligibleCapabilities: ["issues.read", "issues.write"],
      eligibleConnectionCapabilities: {
        "connection-b": ["issues.write"],
        "connection-a": ["issues.read"],
      },
      triggerPolicy: { kind: "interactive" },
      routingPolicyVersion: "routing-v1",
      promptVersion: "prompt-v1",
      toolSurfaceHash: "tools-v1",
      limits: { maxIterations: 8 },
    };
    expect(await persistImmutableRunScope(sqlite.runs, input(RUN_ONE), first.lease, scope))
      .toMatchObject({ reused: false });
    expect(await persistImmutableRunScope(sqlite.runs, input(RUN_ONE), first.lease, scope))
      .toMatchObject({ reused: true });
    // A deploy moves `promptVersion`, the tool-surface hash and the routing
    // policy version, so an attempt resuming across one recomputes a different
    // scope. It reuses what the run was admitted with instead of failing.
    expect(await persistImmutableRunScope(sqlite.runs, input(RUN_ONE), first.lease, {
      ...scope,
      promptVersion: "prompt-v2",
    })).toMatchObject({ reused: true });

    await persistRunPluginActivation(sqlite.runs, input(RUN_ONE), first.lease, {
      pluginId: "connection:00000000-0000-4000-8000-000000000099",
      toolSurfaceHash: "plugin-tools-v1",
    });
    await heartbeatHarnessAttempt(sqlite.runs, RUN_ONE, first.lease);
    await expect(terminalizeHarnessAttempt(sqlite.runs, input(RUN_ONE), first.lease, {
      status: "completed",
    }, sqlite.receipts )).rejects.toThrow("final_turn_required");
    await expect(terminalizeHarnessAttempt(sqlite.runs, input(RUN_ONE), first.lease, {
      status: "completed",
      finalTurnId: `${RUN_ONE}:turn:1`,
    }, sqlite.receipts )).rejects.toThrow("final_turn_not_persisted");
    const beforePublish = Date.now();
    await persistHarnessHostOutcome(sqlite.runs, input(RUN_ONE), first.lease, {
      turnId: `${RUN_ONE}:turn:1`,
      text: "Done",
    }, null, { status: "completed" });
    // The activity clock is stamped by the authority at the instant it writes,
    // where the routed batch bound a timestamp the caller had taken moments
    // earlier — so this asserts the append moved it forward rather than pinning
    // a value the caller no longer supplies.
    const published = sqlite.object.prepare(
      `SELECT next_attention_ordinal, last_people_activity_at FROM workstream WHERE id = 1`,
    ).get() as { next_attention_ordinal: number; last_people_activity_at: number };
    // The object's counter, one ahead of what the retired view rendered as
    // `latest_attention_sequence_number`.
    expect(published.next_attention_ordinal).toBe(2);
    expect(published.last_people_activity_at).toBeGreaterThanOrEqual(beforePublish);

    expect(await terminalizeHarnessAttempt(sqlite.runs, input(RUN_ONE), first.lease, {
      status: "completed",
      finalTurnId: `${RUN_ONE}:turn:1`,
    }, sqlite.receipts )).toBe("terminalized");
    expect(await terminalizeHarnessAttempt(sqlite.runs, input(RUN_ONE), first.lease, {
      status: "completed",
      finalTurnId: `${RUN_ONE}:turn:1`,
    }, sqlite.receipts )).toBe("already_terminal");
    expect(sqlite.object.prepare(
      "SELECT COUNT(*) AS count FROM run_lifecycle_events WHERE run_id = ? AND event_key = 'terminal'",
    ).get(RUN_ONE)).toEqual({ count: 1 });

    const second = await claimHarnessAttempt(sqlite.runs, input(RUN_TWO), {
      attemptId: "attempt-two",
      owner: "owner-two",
    });
    expect(second.state).toBe("claimed");
    expect(sqlite.object.prepare(
      "SELECT exact_state FROM workstream WHERE id = 1",
    ).get()).toEqual({ exact_state: "running" });
  });

  it("extends host liveness after every committed attempt heartbeat", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-loop-heartbeat",
      owner: "owner-loop-heartbeat",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");
    const heartbeatLoop = vi.fn(async () => undefined);
    const liveness = new CoalescedRunLiveness(sqlite.runs, RUN_ONE, claim.lease, {
      leaseSeconds: 60,
      minimumIntervalMs: 5_000,
      afterHeartbeat: heartbeatLoop,
    });

    await liveness.pulse("run_start", true);
    await liveness.pulse("lease_monitor", true);

    expect(heartbeatLoop).toHaveBeenCalledTimes(2);
  });

  it("attributes a joined heartbeat wait to the joining stage", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-coalesced-heartbeat",
      owner: "owner-coalesced-heartbeat",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");
    let enterLoop!: () => void;
    let releaseLoop!: () => void;
    const loopEntered = new Promise<void>((resolve) => { enterLoop = resolve; });
    const loopBlocked = new Promise<void>((resolve) => { releaseLoop = resolve; });
    const timings: string[] = [];
    const liveness = new CoalescedRunLiveness(sqlite.runs, RUN_ONE, claim.lease, {
      afterHeartbeat: async () => { enterLoop(); await loopBlocked; },
      onTiming: (stage, part) => { timings.push(`${stage}:${part}`); },
    });

    const first = liveness.pulse("run_start", true);
    await loopEntered;
    const joined = liveness.pulse("before_model", true);
    releaseLoop();
    await Promise.all([first, joined]);

    expect(timings).toContain("run_start:attempt");
    expect(timings).toContain("run_start:loop");
    expect(timings).toContain("before_model:coalesced");
    expect(timings).not.toContain("before_model:attempt");
  });

  it("keeps the workstream running while a superseding interactive turn is pending", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const original = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-superseded",
      owner: "owner-superseded",
    });
    if (original.state !== "claimed") throw new Error("expected claimed original attempt");
    sqlite.object.prepare(
      `UPDATE runs
          SET cancellation_requested_at = ?, cancellation_reason = 'superseded_by_follow_up'
        WHERE run_id = ?`,
    ).run(Date.parse("2026-08-07T12:00:00.000Z"), RUN_ONE);

    await expect(terminalizeHarnessAttempt(
      sqlite.runs,
      input(RUN_ONE),
      original.lease,
      { status: "stopped" },
      sqlite.receipts,
    )).resolves.toBe("terminalized");
    expect(sqlite.object.prepare(
      "SELECT exact_state FROM workstream WHERE id = 1",
    ).get()).toEqual({ exact_state: "running" });

    const replacement = await claimHarnessAttempt(sqlite.runs, input(RUN_TWO), {
      attemptId: "attempt-replacement",
      owner: "owner-replacement",
    });
    expect(replacement.state).toBe("claimed");
  });

  it("fences final-turn writes and recovers a final persisted before terminalization", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const original = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-original",
      owner: "owner-original",
    });
    expect(original.state).toBe("claimed");
    if (original.state !== "claimed") throw new Error("expected claimed attempt");

    await persistHarnessHostOutcome(sqlite.runs, input(RUN_ONE), original.lease, {
      turnId: `${RUN_ONE}:turn:1`,
      text: "Durable before terminalization",
    }, null, { status: "completed" });
    await persistHarnessHostOutcome(sqlite.runs, input(RUN_ONE), original.lease, {
      turnId: `${RUN_ONE}:turn:1`,
      text: "Durable before terminalization",
    }, null, { status: "completed" });
    await expect(persistHarnessHostOutcome(sqlite.runs, input(RUN_ONE), original.lease, {
      turnId: `${RUN_ONE}:turn:1`,
      text: "Durable before terminalization",
    }, null, {
      status: "failed",
      error: { code: "changed_outcome", message: "Must not replace the durable outcome" },
    })).rejects.toThrow("host_outcome_content_mismatch");
    expect(sqlite.object.prepare(
      `SELECT turn.turn_id, turn.actor, event.attempt_id
         FROM participant_transcript_turns turn
         JOIN run_lifecycle_events event
           ON event.run_id = ? AND event.event_key = 'host_outcome'
        WHERE turn.turn_id = ?`,
    ).get(RUN_ONE, `${RUN_ONE}:turn:1`)).toEqual({
      turn_id: `${RUN_ONE}:turn:1`,
      actor: "assistant",
      attempt_id: "attempt-original",
    });
    expect(sqlite.object.prepare(
      `SELECT COUNT(*) AS count FROM run_lifecycle_events
        WHERE run_id = ? AND event_key = 'host_outcome'`,
    ).get(RUN_ONE)).toEqual({ count: 1 });

    sqlite.object.prepare(
      "UPDATE runs SET lease_expires_at = 1577836800000 WHERE run_id = ?",
    ).run(RUN_ONE);
    await expect(persistHarnessHostOutcome(sqlite.runs, input(RUN_ONE), original.lease, {
      turnId: `${RUN_ONE}:turn:1`,
      text: "Must not persist",
    }, null, { status: "completed" })).rejects.toThrow("durable attempt lease");
    expect(sqlite.object.prepare(
      `SELECT COUNT(*) AS count FROM canonical_conversation_turn_details WHERE id = 'message-from-stale-owner'`,
    ).get()).toEqual({ count: 0 });

    const recovery = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-recovery",
      owner: "owner-recovery",
    });
    expect(recovery.state).toBe("claimed");
    if (recovery.state !== "claimed") throw new Error("expected recovery attempt");
    expect(await terminalizeHarnessAttempt(sqlite.runs, input(RUN_ONE), recovery.lease, {
      status: "completed",
      finalTurnId: `${RUN_ONE}:turn:1`,
    }, sqlite.receipts )).toBe("terminalized");
  });

  it.each([
    {
      status: "failed" as const,
      error: {
        code: "context_limit_exceeded",
        message: "The selected model could not fit the durable context",
      },
    },
    { status: "stopped" as const, error: undefined },
    { status: "needs_input" as const, error: undefined },
  ])("recovers the exact $status outcome after a crash following final-turn persistence", async ({
    status,
    error,
  }) => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: `attempt-crash-${status}`,
      owner: `owner-crash-${status}`,
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");

    if (status === "stopped") {
      sqlite.object.prepare(
        `UPDATE runs
            SET cancellation_requested_at = 1785715200000,
                cancellation_reason = 'stopped_by_user'
          WHERE run_id = ?`,
      ).run(RUN_ONE);
    }

    await persistHarnessHostOutcome(sqlite.runs, input(RUN_ONE), claim.lease, {
      turnId: `${RUN_ONE}:turn:1`,
      text: `Partial durable output before ${status}`,
    }, null, {
      status,
      ...(error ? { error } : {}),
    });

    // Simulate the host disappearing before the Workflow's terminalization
    // step. Recovery must use the immutable checkpoint, not infer completion
    // merely because the final turn row exists.
    expect(sqlite.object.prepare(
      "SELECT status, terminalized_at FROM runs WHERE run_id = ?",
    ).get(RUN_ONE)).toEqual({ status: "running", terminalized_at: null });
    expect(await loadPersistedHarnessHostOutcome(sqlite.runs, input(RUN_ONE))).toEqual({
      finalTurnId: `${RUN_ONE}:turn:1`,
      status,
      ...(error ? { error } : {}),
    });
    const lifecycle = sqlite.object.prepare(
      `SELECT status, member_safe_payload_json
         FROM run_lifecycle_events
        WHERE run_id = ? AND event_key = 'host_outcome'`,
    ).get(RUN_ONE) as { status: string; member_safe_payload_json: string };
    expect(lifecycle.status).toBe(status);
    expect(JSON.parse(lifecycle.member_safe_payload_json)).toEqual({
      finalTurnId: `${RUN_ONE}:turn:1`,
      participantNoticeTurnId: null,
      ...(error ? { error } : {}),
    });
  });

  it("recovers a failed outcome and its system notice without requiring an assistant turn", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-notice-only",
      owner: "owner-notice-only",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");
    const notice = {
      turnId: `${RUN_ONE}:attachment-boundary`,
      text: "Attachment content could not be verified.",
    };

    await persistHarnessHostOutcome(
      sqlite.runs,
      input(RUN_ONE),
      claim.lease,
      null,
      notice,
      {
        status: "failed",
        error: { code: "empty_completion", message: "No durable answer" },
      },
    );

    expect(await loadPersistedHarnessHostOutcome(sqlite.runs, input(RUN_ONE))).toEqual({
      participantNoticeTurnId: notice.turnId,
      status: "failed",
      error: { code: "empty_completion", message: "No durable answer" },
    });
    expect(sqlite.object.prepare(
      `SELECT author_type, message_type, content, produced_by_run_id
         FROM canonical_conversation_turn_details WHERE id = ?`,
    ).get(notice.turnId)).toEqual({
      author_type: "system",
      message_type: "system",
      content: notice.text,
      produced_by_run_id: RUN_ONE,
    });
  });

  it("terminalizes a queued run without disturbing the active attempt", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const active = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-active",
      owner: "owner-active",
    });
    expect(active.state).toBe("claimed");
    expect(await claimHarnessAttempt(sqlite.runs, input(RUN_TWO), {
      attemptId: "attempt-queued",
      owner: "owner-queued",
    })).toMatchObject({ state: "busy" });

    expect(await terminalizeQueuedHarnessRun(
      sqlite.runs,
      input(RUN_TWO),
      { attemptId: "attempt-queued", owner: "owner-queued" },
      { code: "run_admission_timeout", message: "The work stream remained busy for too long" },
    )).toBe("terminalized");
    expect(await terminalizeQueuedHarnessRun(
      sqlite.runs,
      input(RUN_TWO),
      { attemptId: "attempt-queued", owner: "owner-queued" },
      { code: "run_admission_timeout", message: "The work stream remained busy for too long" },
    )).toBe("already_terminal");
    expect(sqlite.object.prepare(
      "SELECT status, legacy_attempt_id AS attempt_id, lease_owner FROM runs WHERE run_id = ?",
    ).get(RUN_TWO)).toEqual({ status: "failed", attempt_id: "attempt-queued", lease_owner: null });
    expect(sqlite.object.prepare(
      "SELECT COUNT(*) AS count FROM run_lifecycle_events WHERE run_id = ? AND event_key = 'terminal'",
    ).get(RUN_TWO)).toEqual({ count: 1 });
    expect(sqlite.object.prepare(
      "SELECT exact_state FROM workstream WHERE id = 1",
    ).get()).toEqual({ exact_state: "running" });
  });

  it("never claims a run cancelled before lease acquisition", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    sqlite.object.prepare(
      `UPDATE runs
          SET status = 'admitted', cancellation_requested_at = ${Date.parse("2026-08-03T00:00:00.000Z")}
        WHERE run_id = ?`,
    ).run(RUN_ONE);

    expect(await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-cancelled-before-claim",
      owner: "owner-cancelled-before-claim",
    })).toEqual({ state: "cancelled" });
    expect(sqlite.object.prepare(
      "SELECT status, legacy_attempt_id AS attempt_id, lease_owner FROM runs WHERE run_id = ?",
    ).get(RUN_ONE)).toEqual({ status: "admitted", attempt_id: null, lease_owner: null });

    expect(await terminalizeQueuedHarnessRun(
      sqlite.runs,
      input(RUN_ONE),
      { attemptId: "attempt-cancelled-before-claim", owner: "owner-cancelled-before-claim" },
      { code: "run_cancelled", message: "The run was stopped before it started" },
      "stopped",
    )).toBe("terminalized");
    expect(sqlite.object.prepare(
      "SELECT status, terminalized_at FROM runs WHERE run_id = ?",
    ).get(RUN_ONE)).toMatchObject({ status: "cancelled" });
  });

  it("CAS-reaps stale ownership and records append-only inference accounting", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const automationRunId = seedAutomationRun(sqlite, "stale");
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-stale",
      owner: "owner-stale",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");
    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      invocationId: "invocation-stale-parent",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-stale-parent",
      toolName: "terminal.execute",
      inputHash: "input-stale-parent",
      input: { command: "sleep 300" },
      plan: { pluginId: "terminal", canonicalToolName: "terminal.execute", mode: "write" },
      mode: "write",
    });
    seedCanonicalConversationTurn(sqlite.object, {
      turnId: "invocation-stale-parent",
      clientMessageId: "tool:invocation-stale-parent",
      actor: "assistant",
      authorSnapshot: null,
      messageType: "tool",
      text: "",
      structuredContentJson: JSON.stringify({ invocation: {
        id: "invocation-stale-parent",
        toolName: "terminal.execute",
        status: "started",
        outputSummary: null,
        completedAt: null,
        error: null,
      } }),
      transcriptSequence: 1,
      producedByRunId: RUN_ONE,
      createdAt: "2026-08-03T00:00:00.000Z",
    });
    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      invocationId: "invocation-stale-read",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-stale-read",
      toolName: "linear.issue.get",
      inputHash: "input-stale-read",
      input: { id: "AVA-1" },
      plan: { pluginId: "linear", canonicalToolName: "linear.issue.get", mode: "read" },
      mode: "read",
    });
    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      invocationId: "invocation-stale-pending-write",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-stale-pending-write",
      toolName: "linear.issue.update",
      inputHash: "input-stale-pending-write",
      input: { id: "AVA-1", title: "Pending" },
      plan: { pluginId: "linear", canonicalToolName: "linear.issue.update", mode: "write" },
      mode: "write",
    });
    sqlite.object.prepare(
      "UPDATE tool_effects SET status = 'admitted' WHERE effect_intent_id = ?",
    ).run("invocation-stale-pending-write");
    expect(sqlite.object.prepare(
      "SELECT status, settled_at, error_json FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-stale-parent")).toEqual({
      status: "executing",
      settled_at: null,
      error_json: null,
    });
    sqlite.object.prepare(
      "UPDATE runs SET lease_expires_at = 1577836800000 WHERE run_id = ?",
    ).run(RUN_ONE);

    expect(await reapStaleHarnessRuns(sqlite.runs, {
      receipts: () => sqlite.receipts,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
    })).toEqual([RUN_ONE]);
    expect(sqlite.object.prepare("SELECT status, lease_owner FROM runs WHERE run_id = ?").get(RUN_ONE))
      .toEqual({ status: "failed", lease_owner: null });
    expect(sqlite.object.prepare(
      "SELECT status, settled_at, error_json FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-stale-parent")).toMatchObject({
      status: "ambiguous",
      error_json: JSON.stringify({
        code: "ambiguous_external_write",
        message: "The parent run lost its durable lease while an external write was in flight",
      }),
    });
    expect(sqlite.objectDatabase.prepare(
      `SELECT block.lifecycle_state AS tool_status,
              json_extract(payload.payload_json, '$.status') AS visible_status,
              json_extract(payload.payload_json, '$.error') AS visible_error
         FROM participant_transcript_blocks block
         JOIN transcript_facts fact ON fact.fact_id = block.fact_id
         JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id
        WHERE block.turn_id = ?`,
    ).get("invocation-stale-parent")).toEqual({
      tool_status: "ambiguous",
      visible_status: "ambiguous",
      visible_error: "The parent run lost its durable lease while an external write was in flight",
    });
    expect(sqlite.object.prepare(
      "SELECT effect_intent_id, status FROM tool_effects WHERE effect_intent_id IN (?, ?) ORDER BY effect_intent_id",
    ).all("invocation-stale-pending-write", "invocation-stale-read")).toEqual([
      { effect_intent_id: "invocation-stale-pending-write", status: "failed" },
      { effect_intent_id: "invocation-stale-read", status: "failed" },
    ]);
    expect(sqlite.database.prepare(
      "SELECT status, completed_at, result_summary FROM automation_runs WHERE id = ?",
    ).get(automationRunId)).toMatchObject({
      status: "running",
      result_summary: null,
    });

    await recordInferenceAttempt(sqlite.runs, {
      id: "inference-1",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      attemptId: "attempt-stale",
      turnId: "turn-1",
      endpointAttempt: 1,
      fallbackAttempt: 0,
      provider: "openrouter",
      model: "google/gemini-2.5-flash-lite",
      workspaceIdentityHash: "workspace-hash",
      outcome: "failed",
      failureClassification: "stream_idle_timeout",
      latencyMs: 20_000,
      ttftMs: 1_200,
      inputTokens: 800,
      outputTokens: 200,
      reasoningTokens: 50,
      cachedTokens: 100,
      costMicrousd: 125,
      responseBytes: 4_096,
      startedAt: "2026-08-03T00:00:00.000Z",
      completedAt: "2026-08-03T00:00:20.000Z",
    });
    expect(sqlite.object.prepare(
      `SELECT provider, model, outcome, failure_classification, latency_ms, ttft_ms,
              input_tokens, output_tokens, reasoning_tokens, cached_tokens,
              cost_micros, response_bytes
         FROM inference_attempts WHERE inference_attempt_id = 'inference-1'`,
    ).get()).toEqual({
      provider: "openrouter",
      model: "google/gemini-2.5-flash-lite",
      outcome: "failed",
      failure_classification: "stream_idle_timeout",
      latency_ms: 20_000,
      ttft_ms: 1_200,
      input_tokens: 800,
      output_tokens: 200,
      reasoning_tokens: 50,
      cached_tokens: 100,
      cost_micros: 125,
      response_bytes: 4_096,
    });
  });

  it("repairs a terminal root whose first receipt-reaper call failed", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const automationRunId = seedAutomationRun(sqlite, "stale-receipt-retry");
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-stale-receipt-retry",
      owner: "owner-stale-receipt-retry",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");
    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      invocationId: "invocation-stale-receipt-retry",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-stale-receipt-retry",
      toolName: "run_command",
      inputHash: "stale-receipt-retry-input",
      input: { command: "sleep 60" },
      plan: { operation: "command.run", mode: "write", idempotency: "record_before_execute" },
      mode: "write",
    });
    sqlite.object.prepare(
      "UPDATE runs SET lease_expires_at = 1577836800000 WHERE run_id = ?",
    ).run(RUN_ONE);

    let settlementCalls = 0;
    const flakyReceipts = {
      ...sqlite.receipts,
      settleResidualReceipts: async (
        repair: Parameters<typeof sqlite.receipts.settleResidualReceipts>[0],
      ) => {
        settlementCalls += 1;
        if (settlementCalls === 1) throw new Error("transient_receipt_rpc_failure");
        return sqlite.receipts.settleResidualReceipts(repair);
      },
    } satisfies typeof sqlite.receipts;
    const repairFailures: unknown[] = [];

    expect(await reapStaleHarnessRuns(sqlite.runs, {
      receipts: () => flakyReceipts,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      onReceiptRepairFailure: (failure) => repairFailures.push(failure),
    })).toEqual([RUN_ONE]);
    expect(repairFailures).toEqual([{
      phase: "stale_root",
      runId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      attemptId: claim.lease.attemptId,
      reason: "transient_receipt_rpc_failure",
    }]);
    expect(sqlite.object.prepare(
      "SELECT status, terminalized_at FROM runs WHERE run_id = ?",
    ).get(RUN_ONE)).toMatchObject({ status: "failed" });
    expect(sqlite.object.prepare(
      "SELECT status FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-stale-receipt-retry")).toEqual({ status: "executing" });
    expect(sqlite.object.prepare(
      `SELECT COUNT(*) AS count FROM run_lifecycle_events
        WHERE run_id = ? AND event_key = 'residual_receipts_settled'`,
    ).get(RUN_ONE)).toEqual({ count: 0 });
    expect(sqlite.database.prepare(
      "SELECT status FROM automation_runs WHERE id = ?",
    ).get(automationRunId)).toEqual({ status: "running" });
    expect(await reapStaleHarnessRuns(sqlite.runs, {
      receipts: () => flakyReceipts,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
    })).toEqual([]);
    expect(sqlite.object.prepare(
      "SELECT status, error_json FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-stale-receipt-retry")).toEqual({
      status: "ambiguous",
      error_json: '{"code":"ambiguous_external_write","message":"The parent run lost its durable lease while an external write was in flight"}',
    });
    expect(sqlite.object.prepare(
      `SELECT COUNT(*) AS count FROM run_lifecycle_events
        WHERE run_id = ? AND event_key = 'residual_receipts_settled'`,
    ).get(RUN_ONE)).toEqual({ count: 1 });
    expect(sqlite.database.prepare(
      "SELECT status, result_summary FROM automation_runs WHERE id = ?",
    ).get(automationRunId)).toEqual({
      status: "running",
      result_summary: null,
    });
    expect(settlementCalls).toBe(2);
  });

  it("steps over an unsettleable terminal repair and still reaps stale work behind it", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const stopped = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-unsettleable-repair",
      owner: "owner-unsettleable-repair",
    });
    if (stopped.state !== "claimed") throw new Error("expected claimed stopped attempt");
    await persistToolExecutionPlan(sqlite.receipts, stopped.lease, {
      invocationId: "invocation-unsettleable-repair",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-unsettleable-repair",
      toolName: "linear_issue_get",
      inputHash: "unsettleable-repair-input",
      input: { issueId: "AVA-1" },
      plan: { operation: "linear.issue.get", mode: "read" },
      mode: "read",
    });
    const failBeforeSettlement = {
      ...sqlite.receipts,
      settleResidualReceipts: async () => {
        throw new Error("receipt_rpc_unavailable");
      },
    } satisfies typeof sqlite.receipts;
    await expect(terminalizeHarnessAttempt(sqlite.runs, input(RUN_ONE), stopped.lease, {
      status: "stopped",
    }, failBeforeSettlement )).rejects.toThrow("receipt_rpc_unavailable");

    const stale = await claimHarnessAttempt(sqlite.runs, input(RUN_TWO), {
      attemptId: "attempt-behind-unsettleable-repair",
      owner: "owner-behind-unsettleable-repair",
    });
    if (stale.state !== "claimed") throw new Error("expected claimed stale attempt");
    sqlite.object.prepare(
      "UPDATE runs SET lease_expires_at = 1577836800000 WHERE run_id = ?",
    ).run(RUN_TWO);

    const repairFailures: unknown[] = [];
    const refusingReceipts = {
      ...sqlite.receipts,
      settleResidualReceipts: async (
        repair: Parameters<typeof sqlite.receipts.settleResidualReceipts>[0],
      ) => repair.runId === RUN_ONE
        ? { settled: 0, open: 1 }
        : sqlite.receipts.settleResidualReceipts(repair),
    } satisfies typeof sqlite.receipts;
    expect(await reapStaleHarnessRuns(sqlite.runs, {
      receipts: () => refusingReceipts,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      limit: 1,
      onReceiptRepairFailure: (failure) => repairFailures.push(failure),
    })).toEqual([RUN_TWO]);
    expect(repairFailures).toEqual([{
      phase: "terminal_repair",
      runId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      attemptId: stopped.lease.attemptId,
      reason: "residual_receipts_not_settled",
    }]);
    expect(sqlite.object.prepare(
      "SELECT status FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-unsettleable-repair")).toEqual({ status: "executing" });
    expect(sqlite.object.prepare(
      "SELECT status, terminalized_at FROM runs WHERE run_id = ?",
    ).get(RUN_TWO)).toMatchObject({ status: "failed" });
    expect(sqlite.object.prepare(
      `SELECT run_id, event_key FROM run_lifecycle_events
        WHERE run_id = ? AND event_key = 'residual_receipts_settled'`,
    ).get(RUN_TWO)).toEqual({
      run_id: RUN_TWO,
      event_key: "residual_receipts_settled",
    });
  });

  it("does not let historical receipt repair fail a later automation elicitation", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const automationRunId = seedAutomationRun(sqlite, "receipt-repair-needs-input");
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-repair-before-needs-input",
      owner: "owner-repair-before-needs-input",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed stale attempt");
    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      invocationId: "invocation-repair-before-needs-input",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-repair-before-needs-input",
      toolName: "run_command",
      inputHash: "repair-before-needs-input",
      input: { command: "sleep 60" },
      plan: { operation: "command.run", mode: "write", idempotency: "record_before_execute" },
      mode: "write",
    });
    sqlite.object.prepare(
      "UPDATE runs SET lease_expires_at = 1577836800000 WHERE run_id = ?",
    ).run(RUN_ONE);
    let settlementCalls = 0;
    const flakyReceipts = {
      ...sqlite.receipts,
      settleResidualReceipts: async (
        repair: Parameters<typeof sqlite.receipts.settleResidualReceipts>[0],
      ) => {
        settlementCalls += 1;
        if (settlementCalls === 1) throw new Error("transient_receipt_rpc_failure");
        return sqlite.receipts.settleResidualReceipts(repair);
      },
    } satisfies typeof sqlite.receipts;
    expect(await reapStaleHarnessRuns(sqlite.runs, {
      receipts: () => flakyReceipts,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
    })).toEqual([RUN_ONE]);
    sqlite.database.prepare(
      `UPDATE automation_runs
          SET status = 'needs_input', result_summary = 'Waiting for the member'
        WHERE id = ?`,
    ).run(automationRunId);

    expect(await reapStaleHarnessRuns(sqlite.runs, {
      receipts: () => flakyReceipts,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
    })).toEqual([]);
    expect(sqlite.database.prepare(
      "SELECT status, completed_at, result_summary FROM automation_runs WHERE id = ?",
    ).get(automationRunId)).toEqual({
      status: "needs_input",
      completed_at: null,
      result_summary: "Waiting for the member",
    });
    expect(sqlite.object.prepare(
      `SELECT COUNT(*) AS count FROM run_lifecycle_events
        WHERE run_id = ? AND event_key = 'residual_receipts_settled'`,
    ).get(RUN_ONE)).toEqual({ count: 1 });
  });

  it("persists exactly one inference-ledger row for every Bind defect, retry, and fallback attempt", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-bind-ledger",
      owner: "owner-bind-ledger",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");

    const primaryModel = "google/gemini-2.5-flash-lite";
    const fallbackModel = "google/gemini-3.6-flash";
    const responses = [
      inferenceStreamResponse([{
        choices: [{ delta: {}, finish_reason: "stop" }],
      }]),
      inferenceStreamResponse([{
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "provider-ledger-read",
              type: "function",
              function: { name: "ledger_read", arguments: "{}" },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 7, completion_tokens: 2 },
      }]),
      Response.json({ error: { message: "primary temporarily unavailable" } }, { status: 503 }),
      inferenceStreamResponse([{
        choices: [{ delta: { content: "fallback completed" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }]),
    ];
    const requestedModels: string[] = [];
    const fetcher = (async (_request: RequestInfo | URL, init?: RequestInit) => {
      requestedModels.push((JSON.parse(String(init?.body)) as { model: string }).model);
      const response = responses.shift();
      if (!response) throw new Error("unexpected inference request");
      return response;
    }) as typeof fetch;
    const ledgerRead: HarnessTool = {
      definition: {
        name: "ledger_read",
        description: "Exercise a second Bind model turn",
        capability: "ledger.read",
        mode: "read",
        idempotency: "safe",
        inputSchema: { type: "object", additionalProperties: false },
      },
      execute: async () => ({ output: { ok: true }, summary: "Read ledger fixture" }),
    };
    let callbackIndex = 0;

    const outcome = await runHarness({
      config: {
        apiKey: "test-key",
        primaryModel,
        fallbackModels: [fallbackModel],
        fetch: fetcher,
        maxIterations: 4,
        maxToolCalls: 4,
        // Present only so a real run deadline never outranks the provider arm in
        // an assertion about the inference ledger; the loop itself is in-memory.
        maxWallClockMs: 120_000,
        toolTimeoutMs: 100,
        maxWebResults: 4,
        completionDefectRetries: 1,
      },
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      loopId: `workstream:${WORKSTREAM_ID}:substream:0:loop`,
      harnessRunId: RUN_ONE,
      executionPrincipal: { type: "user", userId: asUserId("00000000-0000-4000-8000-00000000000a") },
      systemPrompt: "Exercise the durable inference ledger.",
      messages: [{ role: "user", content: "Use the read tool, then finish." }],
      corePlugins: [{
        canonicalId: "rally:test_ledger",
        modelId: "rally_test_ledger",
        shortWireName: "ledger",
        description: "Test ledger tools",
        preload: true,
        explicit: true,
        tools: [ledgerRead],
      }],
      onEvent: () => undefined,
      onInferenceAttempt: async (attempt) => {
        callbackIndex += 1;
        const completedAtMs = Date.now();
        await recordInferenceAttempt(sqlite.runs, {
          id: `bind-callback-${String(callbackIndex).padStart(2, "0")}`,
          harnessRunId: RUN_ONE,
          workspaceId: WORKSPACE_ID,
          workstreamId: WORKSTREAM_ID,
          attemptId: claim.lease.attemptId,
          turnId: attempt.turnId,
          endpointAttempt: attempt.cursor.endpointAttempt + 1,
          // A model fallback is a route stage; provider candidates remain
          // independently visible in routing_decision_json in production.
          fallbackAttempt: attempt.cursor.stageIndex,
          provider: attempt.provider,
          model: attempt.model,
          workspaceIdentityHash: "workspace-ledger-test",
          routingDecision: {
            stageIndex: attempt.cursor.stageIndex,
            candidateIndex: attempt.cursor.candidateIndex,
            disposition: attempt.disposition,
          },
          outcome: attempt.disposition ?? (attempt.success ? "success" : "failed"),
          ...(attempt.failureKind ? { failureClassification: attempt.failureKind } : {}),
          latencyMs: attempt.latencyMs,
          ...(attempt.ttftMs != null ? { ttftMs: attempt.ttftMs } : {}),
          ...(attempt.inputTokens != null ? { inputTokens: attempt.inputTokens } : {}),
          ...(attempt.outputTokens != null ? { outputTokens: attempt.outputTokens } : {}),
          ...(attempt.responseBytes != null ? { responseBytes: attempt.responseBytes } : {}),
          startedAt: new Date(completedAtMs - attempt.latencyMs).toISOString(),
          completedAt: new Date(completedAtMs).toISOString(),
        });
      },
    });

    expect(outcome).toMatchObject({ status: "completed", content: "fallback completed" });
    expect(requestedModels).toEqual([primaryModel, primaryModel, primaryModel, fallbackModel]);
    expect(callbackIndex).toBe(requestedModels.length);
    expect(sqlite.object.prepare(
      "SELECT COUNT(*) AS count FROM inference_attempts WHERE run_id = ?",
    ).get(RUN_ONE)).toEqual({ count: requestedModels.length });
    expect(sqlite.object.prepare(
      `SELECT inference_attempt_id AS id, turn_id, endpoint_attempt, fallback_attempt, model, outcome,
              failure_classification
         FROM inference_attempts
        WHERE run_id = ?
        ORDER BY inference_attempt_id`,
    ).all(RUN_ONE)).toEqual([
      {
        id: "bind-callback-01",
        turn_id: `workstream:${WORKSTREAM_ID}:substream:0:loop:turn:1`,
        endpoint_attempt: 1,
        fallback_attempt: 0,
        model: primaryModel,
        outcome: "defect",
        failure_classification: "completion_defect",
      },
      {
        id: "bind-callback-02",
        turn_id: `workstream:${WORKSTREAM_ID}:substream:0:loop:turn:1`,
        endpoint_attempt: 2,
        fallback_attempt: 0,
        model: primaryModel,
        outcome: "retry",
        failure_classification: null,
      },
      {
        id: "bind-callback-03",
        turn_id: `workstream:${WORKSTREAM_ID}:substream:0:loop:turn:2`,
        endpoint_attempt: 1,
        fallback_attempt: 0,
        model: primaryModel,
        outcome: "fallback",
        failure_classification: "http",
      },
      {
        id: "bind-callback-04",
        turn_id: `workstream:${WORKSTREAM_ID}:substream:0:loop:turn:2`,
        endpoint_attempt: 1,
        fallback_attempt: 1,
        model: fallbackModel,
        outcome: "fallback",
        failure_classification: null,
      },
    ]);
  });

  it("fences immutable tool plans and checkpoints ambiguous timed-out writes", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-tools",
      owner: "owner-tools",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");

    const readPlan = {
      invocationId: "invocation-read",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-read",
      toolName: "linear.issue.get",
      inputHash: "input-read",
      input: { id: "AVA-1" },
      plan: {
        pluginId: "connection:connection-linear",
        canonicalToolName: "linear.issue.get",
        capability: "issues.read",
        connectionId: "connection-linear",
        mode: "read",
        idempotency: "safe",
        toolSurfaceHash: "linear-surface-v1",
      },
      mode: "read" as const,
    };
    expect(await persistToolExecutionPlan(sqlite.receipts, claim.lease, readPlan))
      .toMatchObject({ state: "created", invocationId: "invocation-read" });
    await checkpointToolInvocation(sqlite.receipts, claim.lease, {
      harnessRunId: RUN_ONE,
      invocationId: "invocation-read",
      checkpointIndex: 1,
      phase: "provider_request_started",
    });
    expect(await persistToolExecutionPlan(sqlite.receipts, claim.lease, readPlan))
      .toMatchObject({ state: "resume_read", invocationId: "invocation-read" });
    expect(await completeToolInvocation(sqlite.receipts, claim.lease, {
      harnessRunId: RUN_ONE,
      invocationId: "invocation-read",
      checkpointIndex: 2,
      outputRef: "payloads/runtime/read.json",
      outputSummary: "Issue AVA-1",
    })).toBe("persisted");
    // A provider-facing alias may change between attempts. It is not part of
    // the immutable execution plan, so replay remains bound to canonical policy.
    expect(await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      ...readPlan,
      toolName: "default_api.linear_issue_get",
    }))
      .toMatchObject({ state: "replay_completed", invocationId: "invocation-read" });
    expect(await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      ...readPlan,
      toolName: "default_api.linear_issue_get",
      plan: { ...readPlan.plan, canonicalToolName: "linear.issue.update", mode: "write" },
    })).toMatchObject({ state: "ambiguous_external_write", invocationId: "invocation-read" });

    const writePlan = await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      invocationId: "invocation-write",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-write",
      toolName: "linear.issue.update",
      inputHash: "input-write",
      input: { id: "AVA-1", title: "Updated" },
      plan: { connectionId: "connection-linear", operation: "issue.update" },
      providerIdempotencyKey: "rally:run:call-write",
      mode: "write",
    });
    expect(writePlan.state).toBe("created");
    expect(await markToolInvocationTimedOut(sqlite.receipts, claim.lease, {
      harnessRunId: RUN_ONE,
      invocationId: "invocation-write",
      mayHaveWritten: true,
    })).toBe("ambiguous");
    expect(sqlite.object.prepare(
      "SELECT status, provider_idempotency_key FROM tool_effects WHERE effect_intent_id = 'invocation-write'",
    ).get()).toEqual({ status: "ambiguous", provider_idempotency_key: "rally:run:call-write" });
    expect(await completeToolInvocation(sqlite.receipts, claim.lease, {
      harnessRunId: RUN_ONE,
      invocationId: "invocation-write",
      checkpointIndex: 2,
      outputRef: "payloads/runtime/reconciled-write.json",
      outputSummary: "Reconciled durable write",
      allowAmbiguousReconciliation: true,
    })).toBe("persisted");
    expect(sqlite.object.prepare(
      "SELECT status, output_ref FROM tool_effects WHERE effect_intent_id = 'invocation-write'",
    ).get()).toEqual({ status: "completed", output_ref: "payloads/runtime/reconciled-write.json" });
    expect(sqlite.object.prepare(
      "SELECT phase FROM tool_effect_checkpoints WHERE effect_intent_id = 'invocation-read' ORDER BY checkpoint_index",
    ).all()).toEqual([
      { phase: "execution_planned" },
      { phase: "provider_request_started" },
      { phase: "result_persisted" },
    ]);
  });

  it("accepts exact legacy receipt plans without weakening read and write replay fences", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-compatible-plans",
      owner: "owner-compatible-plans",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");

    const legacyReadPlan = {
      pluginId: "connection:connection-linear",
      canonicalToolName: "linear.search_issues",
      capability: "linear.issue.read",
      connectionId: "connection-linear",
      mode: "read",
      idempotency: "safe",
      toolSurfaceHash: "linear-surface-prefixed",
    };
    const currentReadPlan = {
      ...legacyReadPlan,
      canonicalToolName: "search_issues",
      toolSurfaceHash: "linear-surface-prefix-free",
    };
    const readCoordinates = {
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-compatible-read",
      toolName: "linear_search_issues",
      inputHash: "compatible-read-input",
      input: { query: "receipts" },
      mode: "read" as const,
    };
    expect(await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      ...readCoordinates,
      invocationId: "invocation-compatible-read",
      plan: legacyReadPlan,
    })).toMatchObject({ state: "created" });
    expect(await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      ...readCoordinates,
      plan: currentReadPlan,
      compatiblePriorPlans: [legacyReadPlan],
    })).toMatchObject({ state: "resume_read" });
    expect(await completeToolInvocation(sqlite.receipts, claim.lease, {
      harnessRunId: RUN_ONE,
      invocationId: "invocation-compatible-read",
      checkpointIndex: 1,
      outputRef: "payloads/runtime/compatible-read.json",
      outputSummary: "Found issues",
    })).toBe("persisted");
    expect(await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      ...readCoordinates,
      plan: currentReadPlan,
      compatiblePriorPlans: [legacyReadPlan],
    })).toMatchObject({ state: "replay_completed" });
    expect(await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      ...readCoordinates,
      plan: currentReadPlan,
      compatiblePriorPlans: [{ ...legacyReadPlan, toolSurfaceHash: "wrong-legacy-surface" }],
    })).toMatchObject({ state: "ambiguous_external_write" });

    const legacyWritePlan = {
      ...legacyReadPlan,
      canonicalToolName: "linear.create_comment",
      capability: "linear.comment.write",
      mode: "write",
      idempotency: "provider_key",
    };
    const currentWritePlan = {
      ...legacyWritePlan,
      canonicalToolName: "create_comment",
      toolSurfaceHash: "linear-surface-prefix-free",
    };
    const writeCoordinates = {
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-compatible-write",
      toolName: "linear_create_comment",
      inputHash: "compatible-write-input",
      input: { issueId: "AVA-1", body: "Reviewed" },
      mode: "write" as const,
    };
    expect(await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      ...writeCoordinates,
      invocationId: "invocation-compatible-write",
      plan: legacyWritePlan,
    })).toMatchObject({ state: "created" });
    expect(await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      ...writeCoordinates,
      plan: currentWritePlan,
      compatiblePriorPlans: [legacyWritePlan],
    })).toMatchObject({ state: "ambiguous_external_write" });
  });

  it("routes plan conflicts, repeated writes, definitive failures, and timeouts through terminal receipt fencing", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-terminal-branches",
      owner: "owner-terminal-branches",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");

    const basePlan = {
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolName: "linear.issue.get",
      inputHash: "same-input",
      input: { id: "AVA-2" },
      mode: "read" as const,
    };
    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      ...basePlan,
      invocationId: "invocation-plan-conflict",
      toolCallId: "call-plan-conflict",
      plan: { operation: "issue.get", version: 1 },
    });
    expect(await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      ...basePlan,
      toolCallId: "call-plan-conflict",
      plan: { operation: "issue.get", version: 2 },
    })).toMatchObject({ state: "ambiguous_external_write" });

    const writePlan = {
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolName: "linear.issue.update",
      inputHash: "write-input",
      input: { id: "AVA-2", title: "Updated" },
      plan: { operation: "issue.update" },
      mode: "write" as const,
    };
    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      ...writePlan,
      invocationId: "invocation-write-retry",
      toolCallId: "call-write-retry",
    });
    expect(await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      ...writePlan,
      toolCallId: "call-write-retry",
    })).toMatchObject({ state: "ambiguous_external_write" });

    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      ...basePlan,
      invocationId: "invocation-definitive-failure",
      toolCallId: "call-definitive-failure",
      plan: { operation: "issue.get" },
    });
    expect(await finalizeToolInvocationFailure(sqlite.receipts, claim.lease, {
      harnessRunId: RUN_ONE,
      invocationId: "invocation-definitive-failure",
      status: "failed",
      phase: "execution_failed",
      error: {
        code: "tool_failed",
        message: "The provider rejected the request",
        data: {
          code: "revision_conflict",
          details: { reason: "Read the item again by ID before retrying." },
        },
      },
    })).toBe("persisted");

    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      ...basePlan,
      invocationId: "invocation-read-timeout",
      toolCallId: "call-read-timeout",
      plan: { operation: "issue.get" },
    });
    expect(await markToolInvocationTimedOut(sqlite.receipts, claim.lease, {
      harnessRunId: RUN_ONE,
      invocationId: "invocation-read-timeout",
      mayHaveWritten: false,
    })).toBe("failed");

    const rows = sqlite.object.prepare(
      `SELECT effect_intent_id, status, error_json FROM tool_effects
        WHERE effect_intent_id IN (?, ?, ?, ?) ORDER BY effect_intent_id`,
    ).all(
      "invocation-plan-conflict",
      "invocation-write-retry",
      "invocation-definitive-failure",
      "invocation-read-timeout",
    );
    expect(rows).toEqual([
      {
        effect_intent_id: "invocation-definitive-failure",
        status: "failed",
        error_json: '{"code":"tool_failed","message":"The provider rejected the request","data":{"code":"revision_conflict","details":{"reason":"Read the item again by ID before retrying."}}}',
      },
      {
        effect_intent_id: "invocation-plan-conflict",
        status: "ambiguous",
        error_json: '{"code":"ambiguous_external_write","message":"A tool-call receipt was reused with a different immutable execution plan"}',
      },
      {
        effect_intent_id: "invocation-read-timeout",
        status: "failed",
        error_json: '{"code":"tool_timeout","message":"The tool request timed out before producing a result"}',
      },
      {
        effect_intent_id: "invocation-write-retry",
        status: "ambiguous",
        error_json: '{"code":"ambiguous_external_write","message":"A prior write may have reached the provider"}',
      },
    ]);
    expect(sqlite.object.prepare(
      `SELECT effect_intent_id, phase FROM tool_effect_checkpoints
        WHERE effect_intent_id IN (?, ?, ?, ?)
          AND checkpoint_index = 1
        ORDER BY effect_intent_id`,
    ).all(
      "invocation-plan-conflict",
      "invocation-write-retry",
      "invocation-definitive-failure",
      "invocation-read-timeout",
    )).toEqual([
      { effect_intent_id: "invocation-definitive-failure", phase: "execution_failed" },
      { effect_intent_id: "invocation-plan-conflict", phase: "ambiguous_external_write" },
      { effect_intent_id: "invocation-read-timeout", phase: "timed_out" },
      { effect_intent_id: "invocation-write-retry", phase: "ambiguous_external_write" },
    ]);
  });

  it("rebinds a settled read receipt whose coordinates a re-executed pass reused", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-receipt-reuse",
      owner: "owner-receipt-reuse",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");

    const readPlan = {
      pluginId: "rally:tool-discovery",
      canonicalToolName: "load_plugin",
      capability: "tools.discover",
      connectionId: null,
      mode: "read",
      idempotency: "safe",
      toolSurfaceHash: "discovery-surface-v1",
    };
    const coordinates = {
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      // The positional receipt id a restarted pass mints again from turn one.
      toolCallId: `${RUN_ONE}:turn:1:tool:0`,
      mode: "read" as const,
    };
    expect(await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      ...coordinates,
      invocationId: "invocation-reused-coordinate",
      toolName: "load_plugin",
      inputHash: "terminal-plugin",
      input: { pluginId: "rally_terminal" },
      plan: readPlan,
    })).toMatchObject({ state: "created" });
    expect(await completeToolInvocation(sqlite.receipts, claim.lease, {
      harnessRunId: RUN_ONE,
      invocationId: "invocation-reused-coordinate",
      checkpointIndex: 1,
      outputRef: "payloads/runtime/loaded-terminal.json",
      outputSummary: "Loaded Terminal; 9 tools are now available",
    })).toBe("persisted");

    // The identical call still replays. Rebinding may never cost a pass the
    // result it already paid for.
    expect(await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      ...coordinates,
      toolName: "load_plugin",
      inputHash: "terminal-plugin",
      input: { pluginId: "rally_terminal" },
      plan: readPlan,
    })).toMatchObject({ state: "replay_completed", invocationId: "invocation-reused-coordinate" });

    // A different read landing on the same coordinate executes instead of
    // halting the run: nothing external moved, so nothing is ambiguous.
    expect(await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      ...coordinates,
      toolName: "search_code",
      inputHash: "github-search",
      input: { query: "debug model list" },
      plan: {
        ...readPlan,
        pluginId: "connection:connection-github",
        canonicalToolName: "search_code",
        capability: "code.read",
        connectionId: "connection-github",
        toolSurfaceHash: "github-surface-v1",
      },
    })).toMatchObject({ state: "created", invocationId: "invocation-reused-coordinate" });
    // The rebind reopens the receipt (status back to `started`, prior result
    // cleared) and rewrites its coordinates to the call that landed on them —
    // tool_name, input_hash, connection, and the plan itself — through the
    // v8 `_runtime_tool_invocations_update` trigger. Before v8 the trigger
    // carried no plan arms: the port reported `created` while the object kept
    // the original call's coordinates, and the next pass compared against the
    // wrong receipt.
    expect(sqlite.object.prepare(
      `SELECT tool_name, status, request_hash, connection_id, output_ref, output_summary,
              error_json, json_extract(execution_plan_json, '$.canonicalToolName') AS planned_tool
         FROM tool_effects WHERE effect_intent_id = 'invocation-reused-coordinate'`,
    ).get()).toEqual({
      tool_name: "search_code",
      status: "executing",
      request_hash: "github-search",
      // The rebinding call names no top-level connection (its connection
      // lives inside the plan); the rebind writes that null over the old
      // binding rather than leaving a stale one.
      connection_id: null,
      output_ref: null,
      output_summary: null,
      error_json: null,
      planned_tool: "search_code",
    });
    expect(sqlite.object.prepare(
      `SELECT phase FROM tool_effect_checkpoints
        WHERE effect_intent_id = 'invocation-reused-coordinate' ORDER BY checkpoint_index`,
    ).all()).toEqual([
      { phase: "execution_planned" },
      { phase: "result_persisted" },
      { phase: "execution_replanned" },
    ]);

    // The rebound call completes through the same path production uses, which
    // passes a static `checkpointIndex: 1`. A replanned receipt is already past
    // that index, so the completion has to derive its own.
    expect(await completeToolInvocation(sqlite.receipts, claim.lease, {
      harnessRunId: RUN_ONE,
      invocationId: "invocation-reused-coordinate",
      checkpointIndex: 1,
      outputRef: "payloads/runtime/searched-code.json",
      outputSummary: "Found 3 matches",
    })).toBe("persisted");
    expect(sqlite.object.prepare(
      `SELECT status, output_ref, checkpoint_index FROM tool_effects
        WHERE effect_intent_id = 'invocation-reused-coordinate'`,
    ).get()).toEqual({
      status: "completed",
      output_ref: "payloads/runtime/searched-code.json",
      checkpoint_index: 3,
    });
    expect(sqlite.object.prepare(
      `SELECT checkpoint_index, phase FROM tool_effect_checkpoints
        WHERE effect_intent_id = 'invocation-reused-coordinate' ORDER BY checkpoint_index`,
    ).all()).toEqual([
      { checkpoint_index: 0, phase: "execution_planned" },
      { checkpoint_index: 1, phase: "result_persisted" },
      { checkpoint_index: 2, phase: "execution_replanned" },
      { checkpoint_index: 3, phase: "result_persisted" },
    ]);

    // A write landing on a settled read coordinate still fails closed, and a
    // read landing on a settled write coordinate reports the ambiguity rather
    // than raising a lease failure that never happened.
    expect(await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      ...coordinates,
      mode: "write",
      toolName: "publish_branch_and_pr",
      inputHash: "publish",
      input: { branch: "add-model" },
      plan: { ...readPlan, canonicalToolName: "publish_branch_and_pr", mode: "write" },
    })).toMatchObject({ state: "ambiguous_external_write" });

    const settledWrite = `${RUN_ONE}:turn:2:tool:0`;
    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      ...coordinates,
      toolCallId: settledWrite,
      invocationId: "invocation-settled-write",
      mode: "write",
      toolName: "publish_branch_and_pr",
      inputHash: "publish",
      input: { branch: "add-model" },
      plan: { ...readPlan, canonicalToolName: "publish_branch_and_pr", mode: "write" },
    });
    await completeToolInvocation(sqlite.receipts, claim.lease, {
      harnessRunId: RUN_ONE,
      invocationId: "invocation-settled-write",
      checkpointIndex: 1,
      outputRef: "payloads/runtime/published.json",
      outputSummary: "Opened pull request",
    });
    expect(await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      ...coordinates,
      toolCallId: settledWrite,
      toolName: "load_plugin",
      inputHash: "github-plugin",
      input: { pluginId: "plugin_github" },
      plan: readPlan,
    })).toMatchObject({ state: "ambiguous_external_write", invocationId: "invocation-settled-write" });
    expect(sqlite.object.prepare(
      "SELECT status FROM tool_effects WHERE effect_intent_id = 'invocation-settled-write'",
    ).get()).toEqual({ status: "completed" });
  });

  it("refuses to rebind a read receipt that other durable state is keyed to", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-receipt-dependents",
      owner: "owner-receipt-dependents",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");

    const readPlan = {
      pluginId: "rally:workstream",
      canonicalToolName: "run_subagent",
      capability: "subagent.run",
      connectionId: null,
      mode: "read",
      idempotency: "safe",
      toolSurfaceHash: "workstream-surface-v1",
    };
    const delegation = {
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: `${RUN_ONE}:turn:1:tool:0`,
      mode: "read" as const,
      plan: readPlan,
    };
    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      ...delegation,
      invocationId: "invocation-delegation",
      toolName: "run_subagent",
      inputHash: "first-objective",
      input: { objective: "Find the model list" },
    });
    await completeToolInvocation(sqlite.receipts, claim.lease, {
      harnessRunId: RUN_ONE,
      invocationId: "invocation-delegation",
      checkpointIndex: 1,
      outputRef: "payloads/runtime/child.json",
      outputSummary: "The sub-agent reported back",
    });

    // `run_subagent` is a read, but its child run is keyed by this coordinate
    // and admits exactly one objective there. Rebinding would promise an
    // execution that `admitInlineChildAttempt` then refuses.
    seedWorkstreamRun(sqlite.objectDatabase, {
      id: "00000000-0000-4000-8000-0000000000c1", status: "completed",
      origin: "inline_child",
      executionPrincipalJson: JSON.stringify({ type: "user", userId: "00000000-0000-4000-8000-000000000009" }),
      parentRunId: RUN_ONE, parentToolCallId: delegation.toolCallId,
      chainRootRunId: RUN_ONE, chainDepth: 1, delegatedTaskHash: "first-objective",
      createdAt: Date.now(),
    });
    expect(await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      ...delegation,
      toolName: "run_subagent",
      inputHash: "second-objective",
      input: { objective: "Find the composer instead" },
    })).toMatchObject({ state: "ambiguous_external_write", invocationId: "invocation-delegation" });

    // An attachment read records the derivatives it depended on against the
    // invocation id, and a lifecycle trigger deletes the invocation when that
    // resource changes — which after a rebind would delete a different read.
    const attachmentPlan = { ...readPlan, canonicalToolName: "view_resource", capability: "workstream.resources.view" };
    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: `${RUN_ONE}:turn:1:tool:1`,
      invocationId: "invocation-attachment",
      toolName: "view_resource",
      inputHash: "first-resource",
      input: { resourceId: "resource-one" },
      plan: attachmentPlan,
      mode: "read",
    });
    await completeToolInvocation(sqlite.receipts, claim.lease, {
      harnessRunId: RUN_ONE,
      invocationId: "invocation-attachment",
      checkpointIndex: 1,
      outputRef: "payloads/runtime/viewed.json",
      outputSummary: "Viewed the resource",
    });
    sqlite.database.prepare(
      `INSERT INTO resources
       (id, workspace_id, resource_type, provider, title, metadata_json, created_at, updated_at)
       VALUES (?, ?, 'file', 'avalon', 'One', '{}', ?, ?)`,
    ).run("resource-one", WORKSPACE_ID, new Date().toISOString(), new Date().toISOString());
    // The receipts table is object-native (no compat view), so its
    // `created_at` is epoch milliseconds like every other object column.
    sqlite.object.prepare(
      `INSERT INTO attachment_tool_receipts
       (workspace_id, resource_id, tool_invocation_id, derivative_sha256, created_at)
       VALUES (?, ?, ?, 'sha-one', ?)`,
    ).run(WORKSPACE_ID, "resource-one", "invocation-attachment", Date.now());
    expect(await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: `${RUN_ONE}:turn:1:tool:1`,
      toolName: "view_resource",
      inputHash: "second-resource",
      input: { resourceId: "resource-two" },
      plan: attachmentPlan,
      mode: "read",
    })).toMatchObject({ state: "ambiguous_external_write", invocationId: "invocation-attachment" });

    // A `failed` receipt is still mutable for an ambiguous finalize, and still
    // flips: a write that failed may have reached the provider before it did,
    // and that is the row the member sees the "could not confirm" wording on.
    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      ...delegation,
      toolCallId: `${RUN_ONE}:turn:1:tool:2`,
      invocationId: "invocation-failed-read",
      toolName: "search_code",
      inputHash: "first-search",
      input: { query: "one" },
      plan: { ...readPlan, canonicalToolName: "search_code", capability: "code.read" },
    });
    await finalizeToolInvocationFailure(sqlite.receipts, claim.lease, {
      harnessRunId: RUN_ONE,
      invocationId: "invocation-failed-read",
      status: "failed",
      phase: "execution_failed",
      error: { code: "tool_failed", message: "The provider rejected the request" },
    });
    expect(await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      ...delegation,
      toolCallId: `${RUN_ONE}:turn:1:tool:2`,
      toolName: "search_code",
      inputHash: "second-search",
      input: { query: "two" },
      plan: { ...readPlan, canonicalToolName: "search_code", capability: "code.read" },
    })).toMatchObject({ state: "ambiguous_external_write", invocationId: "invocation-failed-read" });
    expect(sqlite.object.prepare(
      "SELECT status, error_json FROM tool_effects WHERE effect_intent_id = 'invocation-failed-read'",
    ).get()).toEqual({
      status: "ambiguous",
      error_json: '{"code":"ambiguous_external_write","message":"A tool-call receipt was reused with a different immutable execution plan"}',
    });

    // Both refusals leave the settled receipts exactly as they were.
    expect(sqlite.object.prepare(
      `SELECT effect_intent_id, status, request_hash FROM tool_effects
        WHERE effect_intent_id IN ('invocation-delegation', 'invocation-attachment') ORDER BY effect_intent_id`,
    ).all()).toEqual([
      { effect_intent_id: "invocation-attachment", status: "completed", request_hash: "first-resource" },
      { effect_intent_id: "invocation-delegation", status: "completed", request_hash: "first-objective" },
    ]);
  });

  it("refuses a read rebind against dependent state that lands inside its own transaction", async () => {
    for (const dependentKind of ["attachment", "child"] as const) {
      const sqlite = fixture();
      openDatabases.push(sqlite.database);
      const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
        attemptId: `attempt-replan-${dependentKind}-race`,
        owner: `owner-replan-${dependentKind}-race`,
      });
      if (claim.state !== "claimed") throw new Error("expected claimed attempt");

      const toolCallId = `${RUN_ONE}:turn:1:tool:0`;
      const readPlan = {
        pluginId: "rally:workstream",
        canonicalToolName: "view_resource",
        capability: "workstream.resources.view",
        connectionId: null,
        mode: "read" as const,
        idempotency: "safe",
        toolSurfaceHash: "workstream-surface-v1",
      };
      await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
        invocationId: "invocation-replan-race",
        harnessRunId: RUN_ONE,
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        toolCallId,
        toolName: "view_resource",
        inputHash: "resource-before-race",
        input: { resourceId: "resource-before-race" },
        plan: readPlan,
        mode: "read",
      });
      await completeToolInvocation(sqlite.receipts, claim.lease, {
        harnessRunId: RUN_ONE,
        invocationId: "invocation-replan-race",
        checkpointIndex: 1,
        outputRef: "payloads/runtime/resource-before-race.json",
        outputSummary: "Viewed the original resource",
      });

      // The routed version read the dependents, then rebound in a second batch,
      // so a dependency landing between the two would be missed and the CAS had
      // to repeat the predicate. Here both happen in one `transactionSync`, and
      // the latest a competing write can arrive is the instant the transaction
      // opens — which is where this one is staged. What is being proved is that
      // the decision is made against the rows as they are at write time, not
      // against anything read before the call.
      let staged = false;
      const racedReceipts = testToolReceiptPort(sqlite.objectDatabase, () => {
        if (staged) return;
        staged = true;
        if (dependentKind === "attachment") {
          sqlite.object.prepare(
            `INSERT INTO attachment_tool_receipts
             (workspace_id, resource_id, tool_invocation_id, derivative_sha256, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          ).run(
            WORKSPACE_ID,
            "resource-raced",
            "invocation-replan-race",
            "sha-raced",
            Date.now(),
          );
        } else {
          seedWorkstreamRun(sqlite.objectDatabase, {
            id: "00000000-0000-4000-8000-0000000000c2", status: "completed",
            origin: "inline_child",
            executionPrincipalJson: JSON.stringify({ type: "user", userId: "00000000-0000-4000-8000-000000000009" }),
            parentRunId: RUN_ONE, parentToolCallId: toolCallId,
            chainRootRunId: RUN_ONE, chainDepth: 1, delegatedTaskHash: "raced-objective",
            createdAt: Date.now(),
          });
        }
      });

      expect(await persistToolExecutionPlan(racedReceipts, claim.lease, {
        harnessRunId: RUN_ONE,
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        toolCallId,
        toolName: "view_resource",
        inputHash: "resource-after-race",
        input: { resourceId: "resource-after-race" },
        plan: readPlan,
        mode: "read",
      })).toMatchObject({
        state: "ambiguous_external_write",
        invocationId: "invocation-replan-race",
      });
      expect(staged).toBe(true);
      expect(sqlite.object.prepare(
        `SELECT status, request_hash, output_ref FROM tool_effects
          WHERE effect_intent_id = 'invocation-replan-race'`,
      ).get()).toEqual({
        status: "completed",
        request_hash: "resource-before-race",
        output_ref: "payloads/runtime/resource-before-race.json",
      });
    }
  });

  it("does not publish an R2 result reference when its lease is lost after upload", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-upload-race",
      owner: "owner-upload-race",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");
    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      invocationId: "invocation-upload-race",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call/upload race",
      toolName: "linear.issue.get",
      inputHash: "upload-race-input",
      input: { id: "AVA-3" },
      plan: { operation: "issue.get" },
      mode: "read",
    });

    let uploaded = false;
    let uploadedKey = "";
    const env = createTestEnv({
      AVALON_REGION: "global",
      DB: sqlite.binding,
      PAYLOADS: createCloudflareTestBinding<R2Bucket>({
        put: async (key: string) => {
          uploaded = true;
          uploadedKey = key;
          return {} as R2Object;
        },
      }),
    });

    // Stolen through `ownershipGuard`, which runs on both sides of the upload,
    // rather than by intercepting a D1 batch. The routed version uploaded and
    // then settled in a separate round trip, so this case broke the lease
    // *between* the two by mutating on the way into `batch`; settlement is now
    // one transaction on the object and has no such window. The guard is the
    // real seam for the same instant, and the claim is unchanged: the upload is
    // allowed to have happened, and the receipt must not point at it.
    let guardCalls = 0;
    const stealLeaseAfterUpload = async () => {
      guardCalls += 1;
      if (guardCalls !== 2) return;
      sqlite.object.prepare(
        `UPDATE runs
            SET legacy_attempt_id = 'attempt-upload-successor',
                lease_owner = 'owner-upload-successor',
                lease_expires_at = 4070908800000
          WHERE run_id = ?`,
      ).run(RUN_ONE);
    };

    await expect(__integrationTesting.persistSuccessfulToolResult(env, input(RUN_ONE), claim.lease, {
      invocationId: "invocation-upload-race",
      toolCallId: "call/upload race",
      output: { issue: { id: "AVA-3", title: "Immutable result" } },
      outputSummary: "Issue AVA-3",
    }, stealLeaseAfterUpload, sqlite.receipts, sqlite.runs)).rejects.toMatchObject({ code: "run_ownership_lost" });
    expect(uploaded).toBe(true);
    expect(uploadedKey).toContain(
      `/tool-results/${claim.lease.attemptId}/call%2Fupload%20race/`,
    );
    expect(uploadedKey).toMatch(/[A-Za-z0-9_-]{43}\.json$/u);
    expect(__integrationTesting.toolReplayOutputKey(
      env,
      input(RUN_ONE),
      claim.lease.attemptId,
      "call/upload race",
      "different-content-hash",
    )).not.toBe(uploadedKey);
    expect(sqlite.object.prepare(
      `SELECT status, output_ref, output_summary, checkpoint_index
         FROM tool_effects WHERE effect_intent_id = ?`,
    ).get("invocation-upload-race")).toEqual({
      status: "executing",
      output_ref: null,
      output_summary: null,
      checkpoint_index: 0,
    });
    expect(sqlite.object.prepare(
      "SELECT COUNT(*) AS count FROM tool_effect_checkpoints WHERE effect_intent_id = ?",
    ).get("invocation-upload-race")).toEqual({ count: 1 });

    uploaded = false;
    await expect(__integrationTesting.persistSuccessfulToolResult(env, input(RUN_ONE), claim.lease, {
      invocationId: "invocation-upload-race",
      toolCallId: "call/upload race",
      output: { issue: { id: "AVA-3" } },
      outputSummary: "Issue AVA-3",
    }, undefined, sqlite.receipts, sqlite.runs)).rejects.toMatchObject({ code: "run_ownership_lost" });
    expect(uploaded).toBe(false);
  });

  it("persists a returned tool result after a member stop while the attempt still owns settlement", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-completion-after-cancel",
      owner: "owner-completion-after-cancel",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");
    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      invocationId: "invocation-completion-after-cancel",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-completion-after-cancel",
      toolName: "linear_issue_get",
      inputHash: "completion-after-cancel-input",
      input: { issueId: "AVA-4" },
      plan: { operation: "issue.get", mode: "read", idempotency: "safe" },
      mode: "read",
    });
    sqlite.object.prepare(
      `UPDATE runs
          SET cancellation_requested_at = 1785715200000,
              cancellation_reason = 'member_stop'
        WHERE run_id = ?`,
    ).run(RUN_ONE);
    let uploaded = false;
    const env = createTestEnv({
      AVALON_REGION: "global",
      DB: sqlite.binding,
      PAYLOADS: createCloudflareTestBinding<R2Bucket>({
        put: async () => {
          uploaded = true;
          return {} as R2Object;
        },
      }),
    });

    await expect(__integrationTesting.settleRootHarnessToolCompletion(env, input(RUN_ONE), claim.lease, {
      invocationId: "invocation-completion-after-cancel",
      toolCallId: "call-completion-after-cancel",
      canonicalToolName: "get_issue",
      attachmentOutput: { issue: { id: "AVA-4" } },
      durableOutput: { issue: { id: "AVA-4" } },
      outputSummary: "Issue AVA-4",
    }, sqlite.receipts, sqlite.runs)).resolves.toContain("/tool-results/");
    expect(uploaded).toBe(true);
    expect(sqlite.object.prepare(
      "SELECT status, output_summary FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-completion-after-cancel")).toEqual({
      status: "completed",
      output_summary: "Issue AVA-4",
    });
  });

  it("checks the root completion lease before registering an attachment dependency", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-stale-attachment",
      owner: "owner-stale-attachment",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");
    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      invocationId: "invocation-stale-attachment",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-stale-attachment",
      toolName: "read_resource",
      inputHash: "stale-attachment-input",
      input: { resourceId: "00000000-0000-4000-8000-000000000099" },
      plan: { operation: "resource.read", mode: "read", idempotency: "safe" },
      mode: "read",
    });
    sqlite.object.prepare(
      `UPDATE runs
          SET legacy_attempt_id = 'attempt-stale-attachment-successor',
              lease_owner = 'owner-stale-attachment-successor',
              lease_expires_at = 4070908800000
        WHERE run_id = ?`,
    ).run(RUN_ONE);
    let uploaded = false;
    const env = createTestEnv({
      AVALON_REGION: "global",
      DB: sqlite.binding,
      PAYLOADS: createCloudflareTestBinding<R2Bucket>({
        put: async () => {
          uploaded = true;
          return {} as R2Object;
        },
      }),
    });
    const attachmentOutput = {
      resourceId: "00000000-0000-4000-8000-000000000099",
      title: "Stale",
      sourceMimeType: "text/plain",
      modelMimeType: "text/plain",
      version: { sha256: "a".repeat(64), extractorVersion: "attachment-text-v2" },
      range: { start: 0, end: 5 },
      totalCharacters: 5,
      charactersBefore: 0,
      charactersReturned: 5,
      charactersAfter: 0,
      text: "stale",
      previousCursor: null,
      nextCursor: null,
    };

    await expect(__integrationTesting.settleRootHarnessToolCompletion(
      env,
      input(RUN_ONE),
      claim.lease,
      {
        invocationId: "invocation-stale-attachment",
        toolCallId: "call-stale-attachment",
        canonicalToolName: "read_resource",
        attachmentOutput,
        durableOutput: attachmentOutput,
        outputSummary: "Read stale resource",
      },
      sqlite.receipts,
      sqlite.runs,
    )).rejects.toMatchObject({ code: "run_ownership_lost" });
    expect(uploaded).toBe(false);
    expect(sqlite.object.prepare(
      "SELECT COUNT(*) AS count FROM attachment_tool_receipts WHERE tool_invocation_id = ?",
    ).get("invocation-stale-attachment")).toEqual({ count: 0 });
  });

  it("refuses every failure and ambiguity fence, leaving the receipt untouched", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-failure-fences",
      owner: "owner-failure-fences",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");

    const fenceCases = [
      {
        name: "attempt",
        mutate: () => sqlite.object.prepare(
          "UPDATE runs SET legacy_attempt_id = 'attempt-other' WHERE run_id = ?",
        ).run(RUN_ONE),
        code: "run_ownership_lost",
      },
      {
        name: "owner",
        mutate: () => sqlite.object.prepare(
          "UPDATE runs SET lease_owner = 'owner-other' WHERE run_id = ?",
        ).run(RUN_ONE),
        code: "run_ownership_lost",
      },
      {
        name: "state",
        mutate: () => sqlite.object.prepare(
          "UPDATE runs SET status = 'needs_input' WHERE run_id = ?",
        ).run(RUN_ONE),
        code: "run_ownership_lost",
      },
      {
        name: "cancellation",
        mutate: () => sqlite.object.prepare(
          "UPDATE runs SET cancellation_requested_at = 1785715200000 WHERE run_id = ?",
        ).run(RUN_ONE),
        code: "run_cancelled",
      },
      {
        name: "db-time-expiry",
        mutate: () => sqlite.object.prepare(
      "UPDATE runs SET lease_expires_at = 1577836800000 WHERE run_id = ?",
        ).run(RUN_ONE),
        code: "run_ownership_lost",
      },
    ];

    for (const status of ["failed", "ambiguous"] as const) {
      for (const fence of fenceCases) {
        sqlite.object.prepare(
          `UPDATE runs
              SET legacy_attempt_id = ?, lease_owner = ?, status = 'running',
                  cancellation_requested_at = NULL, terminalized_at = NULL,
                  lease_expires_at = 4070908800000
            WHERE run_id = ?`,
        ).run(claim.lease.attemptId, claim.lease.owner, RUN_ONE);
        const suffix = `${status}-${fence.name}`;
        const invocationId = `invocation-${suffix}`;
        await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
          invocationId,
          harnessRunId: RUN_ONE,
          workspaceId: WORKSPACE_ID,
          workstreamId: WORKSTREAM_ID,
          toolCallId: `call-${suffix}`,
          toolName: status === "ambiguous" ? "linear.issue.update" : "linear.issue.get",
          inputHash: `input-${suffix}`,
          input: { suffix },
          plan: { operation: suffix },
          mode: status === "ambiguous" ? "write" : "read",
        });

        // Mutated before the call rather than intercepted inside it. The
        // routed version fenced, then wrote in a separate round trip, so this
        // case had to break the lease *between* the two to be meaningful —
        // hence a D1 binding that mutated on the way into `batch`. The
        // operation is now one transaction on the object, so no such window
        // exists to aim at; the fence is read and acted on together.
        fence.mutate();
        await expect(finalizeToolInvocationFailure(sqlite.receipts, claim.lease, {
          harnessRunId: RUN_ONE,
          invocationId,
          status,
          phase: status === "ambiguous" ? "ambiguous_external_write" : "execution_failed",
          error: {
            code: status === "ambiguous" ? "ambiguous_external_write" : "tool_failed",
            message: `Fenced ${suffix}`,
          },
        })).rejects.toMatchObject({ code: fence.code });
        expect(sqlite.object.prepare(
          "SELECT status, error_json, checkpoint_index FROM tool_effects WHERE effect_intent_id = ?",
        ).get(invocationId)).toEqual({
          status: "executing",
          error_json: null,
          checkpoint_index: 0,
        });
        expect(sqlite.object.prepare(
          "SELECT COUNT(*) AS count FROM tool_effect_checkpoints WHERE effect_intent_id = ?",
        ).get(invocationId)).toEqual({ count: 1 });
      }
    }
  });

  it("does not advance a checkpoint when the lease expires before its transaction opens", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-checkpoint-pre-admission-expiry",
      owner: "owner-checkpoint-pre-admission-expiry",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");
    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      invocationId: "invocation-checkpoint-pre-admission-expiry",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-checkpoint-pre-admission-expiry",
      toolName: "linear_issue_get",
      inputHash: "checkpoint-pre-admission-expiry-input",
      input: { issueId: "AVA-1" },
      plan: { operation: "issue.get", mode: "read", idempotency: "safe" },
      mode: "read",
    });
    // The routed version staged this between the checkpoint insert and the
    // receipt update, because those were two serialized statements and the
    // lease could lapse between them. There is no such gap now, so the lease is
    // expired at the last instant it can still be: as the transaction opens,
    // before the fence is read.
    let intercepted = false;
    const racingReceipts = testToolReceiptPort(sqlite.objectDatabase, () => {
      if (intercepted) return;
      intercepted = true;
      sqlite.object.prepare(
        "UPDATE runs SET lease_expires_at = 0 WHERE run_id = ?",
      ).run(RUN_ONE);
    });

    await expect(checkpointToolInvocation(racingReceipts, claim.lease, {
      harnessRunId: RUN_ONE,
      invocationId: "invocation-checkpoint-pre-admission-expiry",
      checkpointIndex: 1,
      phase: "provider_started",
    })).rejects.toMatchObject({ code: "run_ownership_lost" });
    expect(intercepted).toBe(true);
    expect(sqlite.object.prepare(
      "SELECT status, checkpoint_index FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-checkpoint-pre-admission-expiry")).toEqual({
      status: "executing",
      checkpoint_index: 0,
    });
    expect(sqlite.object.prepare(
      "SELECT COUNT(*) AS count FROM tool_effect_checkpoints WHERE effect_intent_id = ?",
    ).get("invocation-checkpoint-pre-admission-expiry")).toEqual({ count: 1 });
  });

  it("advances a checkpoint once its insert wins before lease expiry", async () => {
    // The lease is expired the instant the operation's checkpoint has been
    // admitted — after its fence was read, inside its own transaction. The
    // routed version needed a second statement to survive this because it
    // sampled expiry twice; here the fence is read once and everything after it
    // is in the same transaction, so the settlement finishes by construction.
    let crossOnCheckpoint = false;
    let crossedLeaseBoundary = false;
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const receipts = testToolReceiptPort(sqlite.objectDatabase, undefined, (statement) => {
      if (
        !crossOnCheckpoint
        || crossedLeaseBoundary
        || !statement.includes("INSERT INTO tool_effect_checkpoints")
      ) return;
      crossedLeaseBoundary = true;
      sqlite.objectDatabase.prepare("UPDATE runs SET lease_expires_at = ? WHERE run_id = ?")
        .run(Date.parse("2020-01-01T00:00:00.000Z"), RUN_ONE);
    });
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-checkpoint-lease-boundary",
      owner: "owner-checkpoint-lease-boundary",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");
    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      invocationId: "invocation-checkpoint-lease-boundary",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-checkpoint-lease-boundary",
      toolName: "linear_issue_get",
      inputHash: "checkpoint-lease-boundary-input",
      input: { issueId: "AVA-1" },
      plan: { operation: "issue.get", mode: "read", idempotency: "safe" },
      mode: "read",
    });

    crossOnCheckpoint = true;
    await expect(checkpointToolInvocation(receipts, claim.lease, {
      harnessRunId: RUN_ONE,
      invocationId: "invocation-checkpoint-lease-boundary",
      checkpointIndex: 1,
      phase: "provider_started",
    })).resolves.toBeUndefined();
    expect(crossedLeaseBoundary).toBe(true);
    expect(sqlite.object.prepare(
      "SELECT status, checkpoint_index FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-checkpoint-lease-boundary")).toEqual({
      status: "executing",
      checkpoint_index: 1,
    });
  });

  it("completes a receipt once its result checkpoint wins before lease expiry", async () => {
    // Same instrument, same reason, as the checkpoint case above.
    let crossOnSettlement = false;
    let crossedLeaseBoundary = false;
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const receipts = testToolReceiptPort(sqlite.objectDatabase, undefined, (statement) => {
      if (
        !crossOnSettlement
        || crossedLeaseBoundary
        || !statement.includes("INSERT INTO tool_effect_checkpoints")
      ) return;
      crossedLeaseBoundary = true;
      sqlite.objectDatabase.prepare("UPDATE runs SET lease_expires_at = ? WHERE run_id = ?")
        .run(Date.parse("2020-01-01T00:00:00.000Z"), RUN_ONE);
    });
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-completion-lease-boundary",
      owner: "owner-completion-lease-boundary",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");
    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      invocationId: "invocation-completion-lease-boundary",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-completion-lease-boundary",
      toolName: "linear_issue_get",
      inputHash: "completion-lease-boundary-input",
      input: { issueId: "AVA-1" },
      plan: { operation: "issue.get", mode: "read", idempotency: "safe" },
      mode: "read",
    });

    crossOnSettlement = true;
    await expect(completeToolInvocation(receipts, claim.lease, {
      harnessRunId: RUN_ONE,
      invocationId: "invocation-completion-lease-boundary",
      checkpointIndex: 1,
      outputRef: "payloads/runtime/completion-lease-boundary.json",
      outputSummary: "Issue AVA-1",
    })).resolves.toBe("persisted");
    expect(crossedLeaseBoundary).toBe(true);
    expect(sqlite.object.prepare(
      "SELECT status, output_ref, checkpoint_index FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-completion-lease-boundary")).toEqual({
      status: "completed",
      output_ref: "payloads/runtime/completion-lease-boundary.json",
      checkpoint_index: 1,
    });
  });

  it("finalizes a failed receipt once its checkpoint wins before lease expiry", async () => {
    // Same instrument, same reason, as the checkpoint case above.
    let crossOnSettlement = false;
    let crossedLeaseBoundary = false;
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const receipts = testToolReceiptPort(sqlite.objectDatabase, undefined, (statement) => {
      if (
        !crossOnSettlement
        || crossedLeaseBoundary
        || !statement.includes("INSERT INTO tool_effect_checkpoints")
      ) return;
      crossedLeaseBoundary = true;
      sqlite.objectDatabase.prepare("UPDATE runs SET lease_expires_at = ? WHERE run_id = ?")
        .run(Date.parse("2020-01-01T00:00:00.000Z"), RUN_ONE);
    });
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-failure-lease-boundary",
      owner: "owner-failure-lease-boundary",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");
    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      invocationId: "invocation-failure-lease-boundary",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-failure-lease-boundary",
      toolName: "linear_issue_get",
      inputHash: "failure-lease-boundary-input",
      input: { issueId: "AVA-1" },
      plan: { operation: "issue.get", mode: "read", idempotency: "safe" },
      mode: "read",
    });

    crossOnSettlement = true;
    await expect(finalizeToolInvocationFailure(receipts, claim.lease, {
      harnessRunId: RUN_ONE,
      invocationId: "invocation-failure-lease-boundary",
      status: "failed",
      phase: "execution_failed",
      error: { code: "provider_failed", message: "Provider failed" },
    })).resolves.toBe("persisted");
    expect(crossedLeaseBoundary).toBe(true);
    expect(sqlite.object.prepare(
      "SELECT status, error_json, checkpoint_index FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-failure-lease-boundary")).toEqual({
      status: "failed",
      error_json: '{"code":"provider_failed","message":"Provider failed"}',
      checkpoint_index: 1,
    });
  });

  it("settles completed and failed tools before the owning attempt terminalizes as stopped", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-cancelled",
      owner: "owner-cancelled",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");

    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      invocationId: "invocation-cancelled-write",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-cancelled-write",
      toolName: "run_command",
      inputHash: "cancelled-write-input",
      input: { command: "sleep 60" },
      plan: {
        pluginId: "rally:terminal",
        canonicalToolName: "run_command",
        capability: "terminal.command.run",
        connectionId: null,
        mode: "write",
        idempotency: "record_before_execute",
        toolSurfaceHash: "terminal-surface-v1",
      },
      mode: "write",
    });
    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      invocationId: "invocation-cancelled-read",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-cancelled-read",
      toolName: "linear_issue_get",
      inputHash: "cancelled-read-input",
      input: { issueId: "AVA-1" },
      plan: {
        pluginId: "connection:linear",
        canonicalToolName: "get_issue",
        capability: "linear.issue.read",
        connectionId: "linear",
        mode: "read",
        idempotency: "safe",
        toolSurfaceHash: "linear-surface-v1",
      },
      mode: "read",
    });

    sqlite.object.prepare(
      `UPDATE runs
          SET cancellation_requested_at = 1785715200000,
              cancellation_reason = 'member_stop'
        WHERE run_id IN (?, ?)`,
    ).run(RUN_ONE, RUN_TWO);

    await expect(heartbeatHarnessAttempt(sqlite.runs, RUN_ONE, claim.lease))
      .rejects.toMatchObject({ code: "run_cancelled" });
    expect(await completeToolInvocation(sqlite.receipts, claim.lease, {
      harnessRunId: RUN_ONE,
      invocationId: "invocation-cancelled-read",
      checkpointIndex: 1,
      outputRef: "payloads/runtime/cancelled-read.json",
      outputSummary: "Issue AVA-1",
      allowCancellationRequested: true,
    })).toBe("persisted");
    expect(await __integrationTesting.settleRootHarnessToolFailure(sqlite.receipts, claim.lease, {
      harnessRunId: RUN_ONE,
      invocationId: "invocation-cancelled-write",
      status: "ambiguous",
      phase: "ambiguous_external_write",
      error: {
        code: "ambiguous_external_write",
        message: "The stopped command may have reached the provider",
      },
      memberSafePayload: { code: "ambiguous_external_write" },
    })).toBe("persisted");
    expect(await terminalizeHarnessAttempt(sqlite.runs, input(RUN_ONE), claim.lease, {
      status: "stopped",
      error: { code: "run_cancelled", message: "The member stopped this run" },
      memberSafePayload: { code: "run_cancelled" },
    }, sqlite.receipts )).toBe("terminalized");

    expect(sqlite.object.prepare(
      `SELECT status, cancellation_requested_at, terminalized_at, lease_owner
         FROM runs WHERE run_id = ?`,
    ).get(RUN_ONE)).toMatchObject({
      status: "cancelled",
      cancellation_requested_at: 1785715200000,
      lease_owner: null,
    });
    expect(sqlite.object.prepare(
      "SELECT exact_state FROM workstream WHERE id = 1",
    ).get()).toEqual({ exact_state: "idle" });
    expect(sqlite.object.prepare(
      "SELECT effect_intent_id, status, output_ref, error_json FROM tool_effects WHERE run_id = ? ORDER BY effect_intent_id",
    ).all(RUN_ONE)).toEqual([
      {
        effect_intent_id: "invocation-cancelled-read",
        status: "completed",
        output_ref: "payloads/runtime/cancelled-read.json",
        error_json: null,
      },
      {
        effect_intent_id: "invocation-cancelled-write",
        status: "ambiguous",
        output_ref: null,
        error_json: '{"code":"ambiguous_external_write","message":"The stopped command may have reached the provider"}',
      },
    ]);
    expect(sqlite.object.prepare(
      "SELECT status, member_safe_payload_json FROM run_lifecycle_events WHERE run_id = ? AND event_key = 'terminal'",
    // The lifecycle event records the run's status in the object's vocabulary,
    // where `stopped` is `cancelled`. Nothing outside this file reads the
    // column, and the storage class is the object's voice by contract.
    ).get(RUN_ONE)).toEqual({
      status: "cancelled",
      member_safe_payload_json: '{"code":"run_cancelled"}',
    });
  });

  it("settles inherited receipts before a successor stops an expired run", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const expired = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-stop-expired",
      owner: "owner-stop-expired",
    });
    if (expired.state !== "claimed") throw new Error("expected claimed attempt");
    await persistToolExecutionPlan(sqlite.receipts, expired.lease, {
      invocationId: "invocation-expired-attempt",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-expired-attempt",
      toolName: "run_command",
      inputHash: "expired-attempt-input",
      input: { command: "sleep 60" },
      plan: { operation: "command.run", mode: "write", idempotency: "record_before_execute" },
      mode: "write",
    });
    await persistToolExecutionPlan(sqlite.receipts, expired.lease, {
      invocationId: "invocation-expired-read",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-expired-read",
      toolName: "linear_issue_get",
      inputHash: "expired-read-input",
      input: { issueId: "AVA-1" },
      plan: { operation: "issue.get", mode: "read", idempotency: "safe" },
      mode: "read",
    });
    sqlite.object.prepare(
      "UPDATE runs SET lease_expires_at = 1577836800000 WHERE run_id = ?",
    ).run(RUN_ONE);
    const successor = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-stop-successor",
      owner: "owner-stop-successor",
    });
    if (successor.state !== "claimed") throw new Error("expected successor attempt");
    // A pre-fix settlement could admit its next checkpoint and then miss the
    // receipt update when the lease deadline crossed between batch statements.
    // Stop must advance past that occupied index rather than conflict forever.
    sqlite.object.prepare(
      `INSERT INTO tool_effect_checkpoints
         (checkpoint_id, effect_intent_id, run_id, attempt_id, checkpoint_index,
          phase, member_safe_payload_json, created_at)
       VALUES (?, ?, ?, ?, 1, 'result_persisted', '{}', 1787000000000)`,
    ).run(
      "checkpoint-orphan-before-stop",
      "invocation-expired-attempt",
      RUN_ONE,
      successor.lease.attemptId,
    );
    // The receipt itself survives the claim, unsettled. The attempt is no
    // longer part of the assertion: it was the compatibility view deriving a
    // displayed attempt from the owning run, and `tool_effects` has no such
    // column — which is why the rebinding that comment described is gone too.
    // `executing` is the object's spelling of what the view called `started`.
    expect(sqlite.object.prepare(
      "SELECT status FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-expired-attempt")).toEqual({ status: "executing" });
    // Steering aborts the loop with a stopped outcome but intentionally does
    // not persist cancellation_requested_at. Residual cleanup belongs to the
    // stopped outcome, not only to member cancellation.
    await expect(terminalizeHarnessAttempt(sqlite.runs, input(RUN_ONE), successor.lease, {
      status: "stopped",
      error: { code: "run_cancelled", message: "The member stopped this run" },
      memberSafePayload: { code: "run_cancelled" },
    }, sqlite.receipts )).resolves.toBe("terminalized");
    expect(sqlite.object.prepare(
      "SELECT status, terminalized_at FROM runs WHERE run_id = ?",
    ).get(RUN_ONE)).toMatchObject({ status: "cancelled" });
    expect(sqlite.object.prepare(
      "SELECT COUNT(*) AS count FROM run_lifecycle_events WHERE run_id = ? AND event_key = 'terminal'",
    ).get(RUN_ONE)).toEqual({ count: 1 });
    expect(sqlite.object.prepare(
      "SELECT effect_intent_id, status, error_json FROM tool_effects WHERE run_id = ? ORDER BY effect_intent_id",
    ).all(RUN_ONE)).toEqual([
      {
        effect_intent_id: "invocation-expired-attempt",
        status: "ambiguous",
        error_json: '{"code":"ambiguous_external_write","message":"The run stopped while an external write was unresolved"}',
      },
      {
        effect_intent_id: "invocation-expired-read",
        status: "failed",
        error_json: '{"code":"run_cancelled","message":"The run stopped before the tool produced a result"}',
      },
    ]);
    expect(sqlite.object.prepare(
      `SELECT effect_intent_id, attempt_id, phase, member_safe_payload_json
         FROM tool_effect_checkpoints
        WHERE run_id = ?
          AND phase IN ('ambiguous_external_write', 'cancelled')
        ORDER BY effect_intent_id`,
    ).all(RUN_ONE)).toEqual([
      {
        effect_intent_id: "invocation-expired-attempt",
        attempt_id: successor.lease.attemptId,
        phase: "ambiguous_external_write",
        member_safe_payload_json: '{"code":"ambiguous_external_write"}',
      },
      {
        effect_intent_id: "invocation-expired-read",
        attempt_id: successor.lease.attemptId,
        phase: "cancelled",
        member_safe_payload_json: '{"code":"run_cancelled"}',
      },
    ]);
  });

  it("retries stopped-run receipt settlement after its committed response is lost", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-stopped-receipt-retry",
      owner: "owner-stopped-receipt-retry",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");
    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      invocationId: "invocation-stopped-receipt-retry",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-stopped-receipt-retry",
      toolName: "linear_issue_get",
      inputHash: "stopped-receipt-retry-input",
      input: { issueId: "AVA-1" },
      plan: { operation: "linear.issue.get", mode: "read" },
      mode: "read",
    });
    const outcome = {
      status: "stopped" as const,
      error: { code: "run_cancelled", message: "The member stopped this run" },
    };
    let settlementCalls = 0;
    const flakyReceipts = {
      ...sqlite.receipts,
      settleResidualReceipts: async (
        repair: Parameters<typeof sqlite.receipts.settleResidualReceipts>[0],
      ) => {
        settlementCalls += 1;
        const result = await sqlite.receipts.settleResidualReceipts(repair);
        if (settlementCalls === 1) throw new Error("lost_receipt_rpc_response");
        return result;
      },
    } satisfies typeof sqlite.receipts;

    await expect(terminalizeHarnessAttempt(
      sqlite.runs,
      input(RUN_ONE),
      claim.lease,
      outcome,
      flakyReceipts,
    )).rejects.toThrow("lost_receipt_rpc_response");
    expect(sqlite.object.prepare(
      "SELECT status, terminalized_at FROM runs WHERE run_id = ?",
    ).get(RUN_ONE)).toMatchObject({ status: "cancelled" });
    expect(sqlite.object.prepare(
      "SELECT status FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-stopped-receipt-retry")).toEqual({ status: "failed" });
    expect(sqlite.object.prepare(
      `SELECT COUNT(*) AS count FROM run_lifecycle_events
        WHERE run_id = ? AND event_key = 'residual_receipts_settled'`,
    ).get(RUN_ONE)).toEqual({ count: 0 });
    const checkpointsAfterLostResponse = sqlite.object.prepare(
      `SELECT checkpoint_index, phase, member_safe_payload_json FROM tool_effect_checkpoints
        WHERE effect_intent_id = ? AND phase = 'cancelled' ORDER BY checkpoint_index`,
    ).all("invocation-stopped-receipt-retry");
    expect(checkpointsAfterLostResponse).toEqual([{
      checkpoint_index: 1,
      phase: "cancelled",
      member_safe_payload_json: '{"code":"run_cancelled"}',
    }]);

    await expect(terminalizeHarnessAttempt(
      sqlite.runs,
      input(RUN_ONE),
      claim.lease,
      outcome,
      flakyReceipts,
    )).resolves.toBe("already_terminal");
    expect(sqlite.object.prepare(
      "SELECT status, error_json FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-stopped-receipt-retry")).toEqual({
      status: "failed",
      error_json: '{"code":"run_cancelled","message":"The run stopped before the tool produced a result"}',
    });
    expect(sqlite.object.prepare(
      `SELECT COUNT(*) AS count FROM run_lifecycle_events
        WHERE run_id = ? AND event_key = 'residual_receipts_settled'`,
    ).get(RUN_ONE)).toEqual({ count: 1 });
    expect(sqlite.object.prepare(
      `SELECT checkpoint_index, phase, member_safe_payload_json FROM tool_effect_checkpoints
        WHERE effect_intent_id = ? AND phase = 'cancelled' ORDER BY checkpoint_index`,
    ).all("invocation-stopped-receipt-retry")).toEqual(checkpointsAfterLostResponse);
    expect(settlementCalls).toBe(2);
  });

  it("closes the tool card of a run that terminalizes failed with a receipt still open", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-direct-failure",
      owner: "owner-direct-failure",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");
    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      invocationId: "invocation-direct-failure",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: `${RUN_ONE}:turn:2:tool:0`,
      toolName: "load_plugin",
      inputHash: "direct-failure-input",
      input: { pluginId: "plugin_x" },
      plan: { operation: "rally.plugins.load", mode: "read", idempotency: "safe" },
      mode: "read",
    });
    seedPendingToolCard(sqlite, "invocation-direct-failure", "load_plugin");
    expect(sqlite.object.prepare(
      "SELECT tool_status FROM canonical_conversation_turn_details WHERE id = ?",
    ).get("invocation-direct-failure")).toEqual({ tool_status: "pending" });

    // The run dies between `tool_started` and the guard that reports
    // `tool_failed` — a required host port throwing, an evicted executor — so
    // the receipt is never settled by the tool's own path.
    expect(await terminalizeHarnessAttempt(sqlite.runs, input(RUN_ONE), claim.lease, {
      status: "failed",
      error: { code: "tool_receipt_persistence_failed", message: "A required host persistence port failed" },
      memberSafePayload: { code: "tool_receipt_persistence_failed" },
    }, sqlite.receipts )).toBe("terminalized");

    expect(sqlite.object.prepare(
      "SELECT status, error_json FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-direct-failure")).toEqual({
      status: "failed",
      // Not the reaper's "lost its durable lease": this run wrote its own
      // terminal row, so nothing here observed a lease being lost.
      error_json: '{"code":"run_terminated","message":"The run ended before the tool produced a result"}',
    });
    expect(sqlite.object.prepare(
      "SELECT tool_status FROM canonical_conversation_turn_details WHERE id = ?",
    ).get("invocation-direct-failure")).toEqual({ tool_status: "failed" });
    expect(sqlite.object.prepare(
      `SELECT COUNT(*) AS count FROM run_lifecycle_events
        WHERE run_id = ? AND event_key = 'residual_receipts_settled'`,
    ).get(RUN_ONE)).toEqual({ count: 1 });
  });

  it("closes the tool card of a run that answered while a receipt stayed open", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-completed-residual",
      owner: "owner-completed-residual",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");
    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      invocationId: "invocation-completed-residual",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: `${RUN_ONE}:turn:2:tool:1`,
      toolName: "load_plugin",
      inputHash: "completed-residual-input",
      input: { pluginId: "plugin_x" },
      plan: { operation: "rally.plugins.load", mode: "read", idempotency: "safe" },
      mode: "read",
    });
    seedPendingToolCard(sqlite, "invocation-completed-residual", "load_plugin");
    await persistHarnessHostOutcome(sqlite.runs, input(RUN_ONE), claim.lease, {
      turnId: `${RUN_ONE}:turn:1`,
      text: "Here is what those teams use",
    }, null, { status: "completed" });

    // The worst case of the two: Bind synthesizes a tool error for the call
    // whose terminal event never reached the host, the model answers anyway,
    // and the run reaches `completed` with the card still spinning.
    expect(await terminalizeHarnessAttempt(sqlite.runs, input(RUN_ONE), claim.lease, {
      status: "completed",
      finalTurnId: `${RUN_ONE}:turn:1`,
    }, sqlite.receipts )).toBe("terminalized");

    expect(sqlite.object.prepare(
      "SELECT status FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-completed-residual")).toEqual({ status: "failed" });
    expect(sqlite.object.prepare(
      "SELECT tool_status FROM canonical_conversation_turn_details WHERE id = ?",
    ).get("invocation-completed-residual")).toEqual({ tool_status: "failed" });
    expect(sqlite.object.prepare(
      `SELECT COUNT(*) AS count FROM run_lifecycle_events
        WHERE run_id = ? AND event_key = 'residual_receipts_settled'`,
    ).get(RUN_ONE)).toEqual({ count: 1 });
  });

  it("repairs a directly-failed root that lost its settlement response, sparing a live automation run", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const automationRunId = seedAutomationRun(sqlite, "direct-failure-repair");
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-direct-failure-repair",
      owner: "owner-direct-failure-repair",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");
    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      invocationId: "invocation-direct-failure-repair",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: `${RUN_ONE}:turn:3:tool:0`,
      toolName: "load_plugin",
      inputHash: "direct-failure-repair-input",
      input: { pluginId: "plugin_x" },
      plan: { operation: "rally.plugins.load", mode: "read", idempotency: "safe" },
      mode: "read",
    });
    seedPendingToolCard(sqlite, "invocation-direct-failure-repair", "load_plugin");

    let settlementCalls = 0;
    const flakyReceipts = {
      ...sqlite.receipts,
      settleResidualReceipts: async (
        repair: Parameters<typeof sqlite.receipts.settleResidualReceipts>[0],
      ) => {
        settlementCalls += 1;
        if (settlementCalls === 1) throw new Error("lost_receipt_rpc_response");
        return sqlite.receipts.settleResidualReceipts(repair);
      },
    } satisfies typeof sqlite.receipts;

    await expect(terminalizeHarnessAttempt(sqlite.runs, input(RUN_ONE), claim.lease, {
      status: "failed",
      error: { code: "harness_execution_failed", message: "The Avalon harness could not complete this run" },
      memberSafePayload: { code: "harness_execution_failed" },
    }, flakyReceipts )).rejects.toThrow("lost_receipt_rpc_response");
    expect(sqlite.object.prepare(
      "SELECT status FROM runs WHERE run_id = ?",
    ).get(RUN_ONE)).toEqual({ status: "failed" });
    expect(sqlite.object.prepare(
      "SELECT tool_status FROM canonical_conversation_turn_details WHERE id = ?",
    ).get("invocation-direct-failure-repair")).toEqual({ tool_status: "pending" });

    // The dispatch does not retry a run whose terminal row already landed, so
    // the bounded sweep on the next dispatch is the only thing left that can
    // close this card.
    expect(await reapStaleHarnessRuns(sqlite.runs, {
      receipts: () => flakyReceipts,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
    })).toEqual([]);
    expect(settlementCalls).toBe(2);
    expect(sqlite.object.prepare(
      "SELECT status, error_json FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-direct-failure-repair")).toEqual({
      status: "failed",
      error_json: '{"code":"run_terminated","message":"The run ended before the tool produced a result"}',
    });
    expect(sqlite.object.prepare(
      "SELECT tool_status FROM canonical_conversation_turn_details WHERE id = ?",
    ).get("invocation-direct-failure-repair")).toEqual({ tool_status: "failed" });
    expect(sqlite.object.prepare(
      `SELECT COUNT(*) AS count FROM run_lifecycle_events
        WHERE run_id = ? AND event_key = 'residual_receipts_settled'`,
    ).get(RUN_ONE)).toEqual({ count: 1 });
    // The automation settlement this walk performs for a reaped root matches
    // every unfinished automation row in the work stream rather than this run's
    // own, so a directly-failed root must not trigger it.
    expect(sqlite.database.prepare(
      "SELECT status FROM automation_runs WHERE id = ?",
    ).get(automationRunId)).toEqual({ status: "running" });
  });

  it("closes the tool card of a run that suspended for input with a receipt still open", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-needs-input-residual",
      owner: "owner-needs-input-residual",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");
    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      invocationId: "invocation-needs-input-residual",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: `${RUN_ONE}:turn:2:tool:0`,
      toolName: "load_plugin",
      inputHash: "needs-input-residual-input",
      input: { pluginId: "plugin_x" },
      plan: { operation: "rally.plugins.load", mode: "read", idempotency: "safe" },
      mode: "read",
    });
    seedPendingToolCard(sqlite, "invocation-needs-input-residual", "load_plugin");

    // The fourth terminal status, and the one whose safety the change argues
    // rather than demonstrates elsewhere: an elicitation returns a normal result
    // carrying `halt`, so its own receipt settles before the run suspends and a
    // receipt still open here belongs to some earlier call. Settling it is
    // therefore right, and a continuation gets a fresh run id, so nothing is
    // closed out from under a run that will resume.
    expect(await terminalizeHarnessAttempt(sqlite.runs, input(RUN_ONE), claim.lease, {
      status: "needs_input",
      memberSafePayload: {},
    }, sqlite.receipts )).toBe("terminalized");

    expect(sqlite.object.prepare(
      "SELECT status, error_json FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-needs-input-residual")).toEqual({
      status: "failed",
      error_json: '{"code":"run_terminated","message":"The run ended before the tool produced a result"}',
    });
    expect(sqlite.object.prepare(
      "SELECT tool_status FROM canonical_conversation_turn_details WHERE id = ?",
    ).get("invocation-needs-input-residual")).toEqual({ tool_status: "failed" });
    expect(sqlite.object.prepare(
      `SELECT COUNT(*) AS count FROM run_lifecycle_events
        WHERE run_id = ? AND event_key = 'residual_receipts_settled'`,
    ).get(RUN_ONE)).toEqual({ count: 1 });
    // Settling the receipt does not relabel the run itself: it is still waiting
    // on a person, not failed. (Asserted on the run rather than the work stream,
    // whose status is held back here by the fixture's second scheduled run --
    // an interaction this change has nothing to do with.)
    expect(sqlite.object.prepare(
      "SELECT status FROM runs WHERE run_id = ?",
    ).get(RUN_ONE)).toEqual({ status: "needs_input" });
  });

  it("repairs a marker backfill without delaying the stale-lease reap behind it", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    // An ordinary completed run carrying no settlement marker — the shape every
    // row terminalized before settlement became universal has, and which the
    // repair walk now enrols. Terminalized by hand, so no marker is recorded.
    const backfill = await claimHarnessAttempt(sqlite.runs, input(RUN_TWO), {
      attemptId: "attempt-marker-backfill",
      owner: "owner-marker-backfill",
    });
    if (backfill.state !== "claimed") throw new Error("expected claimed attempt");
    sqlite.object.prepare(
      `UPDATE runs
          SET status = 'completed', completed_at = 1785542400000,
              terminalized_at = 1785542400000,
              lease_owner = NULL, lease_expires_at = NULL
        WHERE run_id = ?`,
    ).run(RUN_TWO);

    // An executor that died without terminalizing at all. Its expired lease is
    // the only signal it leaves, and this reap is the only thing that will ever
    // close its card.
    const stale = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-stale-behind-backfill",
      owner: "owner-stale-behind-backfill",
    });
    if (stale.state !== "claimed") throw new Error("expected claimed attempt");
    await persistToolExecutionPlan(sqlite.receipts, stale.lease, {
      invocationId: "invocation-stale-behind-backfill",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: `${RUN_ONE}:turn:1:tool:0`,
      toolName: "load_plugin",
      inputHash: "stale-behind-backfill-input",
      input: { pluginId: "plugin_x" },
      plan: { operation: "rally.plugins.load", mode: "read", idempotency: "safe" },
      mode: "read",
    });
    seedPendingToolCard(sqlite, "invocation-stale-behind-backfill", "load_plugin");
    sqlite.object.prepare(
      "UPDATE runs SET lease_expires_at = 1577836800000 WHERE run_id = ?",
    ).run(RUN_ONE);

    // One slot per pass. The backfill row fills the repair page; sharing a
    // budget would return here having reaped nothing.
    expect(await reapStaleHarnessRuns(sqlite.runs, {
      receipts: () => sqlite.receipts,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      limit: 1,
    })).toEqual([RUN_ONE]);
    expect(sqlite.object.prepare(
      "SELECT tool_status FROM canonical_conversation_turn_details WHERE id = ?",
    ).get("invocation-stale-behind-backfill")).toEqual({ tool_status: "failed" });
    // Both halves of the activation did their work, not one at the other's cost.
    expect(sqlite.object.prepare(
      `SELECT COUNT(*) AS count FROM run_lifecycle_events
        WHERE run_id = ? AND event_key = 'residual_receipts_settled'`,
    ).get(RUN_TWO)).toEqual({ count: 1 });
  });

  it("finishes a reaped root's lost settlement with the reaper's wording, not its own", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-reaped-then-returned",
      owner: "owner-reaped-then-returned",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");
    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      invocationId: "invocation-reaped-then-returned",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: `${RUN_ONE}:turn:1:tool:0`,
      toolName: "load_plugin",
      inputHash: "reaped-then-returned-input",
      input: { pluginId: "plugin_x" },
      plan: { operation: "rally.plugins.load", mode: "read", idempotency: "safe" },
      mode: "read",
    });
    sqlite.object.prepare(
      "UPDATE runs SET lease_expires_at = 1577836800000 WHERE run_id = ?",
    ).run(RUN_ONE);

    // The reaper terminalizes the lapsed root but loses its settlement response,
    // so the row is terminal, unmarked, and its receipt still open.
    const losingReceipts = {
      ...sqlite.receipts,
      settleResidualReceipts: async () => { throw new Error("lost_receipt_rpc_response"); },
    } satisfies typeof sqlite.receipts;
    expect(await reapStaleHarnessRuns(sqlite.runs, {
      receipts: () => losingReceipts,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
    })).toEqual([RUN_ONE]);
    expect(sqlite.object.prepare(
      "SELECT status FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-reaped-then-returned")).toEqual({ status: "executing" });

    // The reaper keeps `attempt_id` and only clears the lease, so the original
    // executor's own repeat of its terminalization lands in `already_terminal`
    // and finishes the protocol. It must not relabel the reaper's work.
    expect(await terminalizeHarnessAttempt(sqlite.runs, input(RUN_ONE), claim.lease, {
      status: "failed",
      error: { code: "harness_execution_failed", message: "The Avalon harness could not complete this run" },
      memberSafePayload: { code: "harness_execution_failed" },
    }, sqlite.receipts )).toBe("already_terminal");
    expect(sqlite.object.prepare(
      "SELECT status, error_json FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-reaped-then-returned")).toEqual({
      status: "failed",
      error_json: '{"code":"parent_run_terminated","message":"The parent run lost its durable lease"}',
    });
  });

  it("bulk-settles more residual receipts than one runtime transaction may contain", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-many-stopped-receipts",
      owner: "owner-many-stopped-receipts",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");

    for (let index = 0; index < 60; index += 1) {
      const mode = index % 2 === 0 ? "write" : "read";
      await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
        invocationId: `invocation-residual-${index}`,
        harnessRunId: RUN_ONE,
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        toolCallId: `call-residual-${index}`,
        toolName: mode === "write" ? "run_command" : "linear_issue_get",
        inputHash: `residual-input-${index}`,
        input: { index },
        plan: { operation: `residual.${index}`, mode, idempotency: "record_before_execute" },
        mode,
      });
    }

    const calls: string[] = [];
    await expect(terminalizeHarnessAttempt(
      countingPort(sqlite.runs, calls),
      input(RUN_ONE),
      claim.lease,
      {
        status: "stopped",
        error: { code: "run_cancelled", message: "The run was steered" },
        memberSafePayload: { code: "run_cancelled" },
      },
      countingPort(sqlite.receipts, calls),
    )).resolves.toBe("terminalized");

    expect(sqlite.object.prepare(
      `SELECT status, COUNT(*) AS count FROM tool_effects
        WHERE run_id = ? GROUP BY status ORDER BY status`,
    ).all(RUN_ONE)).toEqual([
      { status: "ambiguous", count: 30 },
      { status: "failed", count: 30 },
    ]);
    // Sixty open receipts, and the cost of stopping does not move: one read to
    // check the run, one transaction to terminalize it, one to settle every
    // receipt, and one to record that the settlement happened. The object
    // settles all sixty inside its own transaction rather than per receipt, and
    // the separate marker is what makes that acknowledgment retryable after a
    // crash between the two authorities.
    expect(calls).toEqual([
      "run",
      "terminalizeAttempt",
      "settleResidualReceipts",
      "recordReceiptReconciliation",
    ]);
  });

  it("leaves a stopped run's receipts alone when its terminalization loses the lease", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-stop-lease-boundary",
      owner: "owner-stop-lease-boundary",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");
    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      invocationId: "invocation-stop-lease-boundary",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-stop-lease-boundary",
      toolName: "run_command",
      inputHash: "stop-lease-boundary-input",
      input: { command: "sleep 60" },
      plan: { operation: "command.run", mode: "write", idempotency: "record_before_execute" },
      mode: "write",
    });
    sqlite.object.prepare(
      "UPDATE runs SET lease_expires_at = ? WHERE run_id = ?",
    ).run(Date.parse("2020-01-01T00:00:00.000Z"), RUN_ONE);

    // The routed version settled receipts and terminalized in one D1 batch,
    // with the receipts first, so a lease lost between the two statements still
    // left them settled. The two stores cannot share a transaction any more, so
    // the settlement runs after the terminal write instead — and when that
    // write loses the lease there is nothing to settle *for*: the run is still
    // live, and its receipts belong to whoever holds it now. Closing them here
    // is the failure this ordering exists to avoid.
    await expect(terminalizeHarnessAttempt(sqlite.runs, input(RUN_ONE), claim.lease, {
      status: "stopped",
      error: { code: "run_cancelled", message: "The member stopped this run" },
      memberSafePayload: { code: "run_cancelled" },
    }, sqlite.receipts )).rejects.toThrow("durable attempt lease");
    expect(sqlite.object.prepare(
      "SELECT status, error_json FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-stop-lease-boundary")).toEqual({
      status: "executing",
      error_json: null,
    });
    expect(sqlite.object.prepare(
      `SELECT COUNT(*) AS count FROM tool_effect_checkpoints
        WHERE effect_intent_id = ? AND phase = 'ambiguous_external_write'`,
    ).get("invocation-stop-lease-boundary")).toEqual({ count: 0 });
    expect(sqlite.object.prepare(
      "SELECT status, terminalized_at, lease_owner FROM runs WHERE run_id = ?",
    ).get(RUN_ONE)).toEqual({
      status: "running",
      terminalized_at: null,
      lease_owner: claim.lease.owner,
    });
  });
  it("fences every durable write from an executor after its lease ownership is replaced", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-obsolete",
      owner: "owner-obsolete",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");
    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      invocationId: "invocation-obsolete-stop",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-obsolete-stop",
      toolName: "run_command",
      inputHash: "obsolete-stop-input",
      input: { command: "sleep 60" },
      plan: { operation: "command.run", mode: "write", idempotency: "record_before_execute" },
      mode: "write",
    });

    sqlite.object.prepare(
      `UPDATE runs
          SET legacy_attempt_id = 'attempt-successor', lease_owner = 'owner-successor',
              lease_expires_at = 4070908800000
        WHERE run_id = ?`,
    ).run(RUN_ONE);

    const scope = {
      executionPrincipal: { type: "user", userId: "user-runtime" },
      eligibleConnectionIds: ["connection-a"],
      eligibleCapabilities: ["issues.read"],
      eligibleConnectionCapabilities: { "connection-a": ["issues.read"] },
      triggerPolicy: { kind: "interactive" },
      routingPolicyVersion: "routing-v1",
      promptVersion: "prompt-v1",
      toolSurfaceHash: "tools-v1",
      limits: { maxIterations: 8 },
    };
    await expect(heartbeatHarnessAttempt(sqlite.runs, RUN_ONE, claim.lease))
      .rejects.toMatchObject({ code: "run_ownership_lost" });
    await expect(persistImmutableRunScope(sqlite.runs, input(RUN_ONE), claim.lease, scope))
      .rejects.toMatchObject({ code: "run_ownership_lost" });
    await expect(persistRunPluginActivation(sqlite.runs, input(RUN_ONE), claim.lease, {
      pluginId: "connection:stale",
      toolSurfaceHash: "surface-stale",
    })).rejects.toMatchObject({ code: "run_ownership_lost" });
    await expect(terminalizeHarnessAttempt(sqlite.runs, input(RUN_ONE), claim.lease, {
      status: "stopped",
      error: { code: "obsolete", message: "An obsolete executor cannot terminalize" },
    }, sqlite.receipts )).rejects.toMatchObject({ code: "run_ownership_lost" });

    expect(sqlite.object.prepare(
      "SELECT status, legacy_attempt_id AS attempt_id, lease_owner, terminalized_at FROM runs WHERE run_id = ?",
    ).get(RUN_ONE)).toEqual({
      status: "running",
      attempt_id: "attempt-successor",
      lease_owner: "owner-successor",
      terminalized_at: null,
    });
    expect(sqlite.object.prepare(
      "SELECT COUNT(*) AS count FROM run_lifecycle_events WHERE run_id = ? AND event_key = 'terminal'",
    ).get(RUN_ONE)).toEqual({ count: 0 });
    expect(sqlite.object.prepare(
      "SELECT status, checkpoint_index FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-obsolete-stop")).toEqual({ status: "executing", checkpoint_index: 0 });
    expect(sqlite.object.prepare(
      "SELECT COUNT(*) AS count FROM tool_effect_checkpoints WHERE effect_intent_id = ?",
    ).get("invocation-obsolete-stop")).toEqual({ count: 1 });
  });

  it("does not reap a stale-row snapshot whose lease is renewed inside the reap transaction", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-racing-reaper",
      owner: "owner-racing-reaper",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");
    sqlite.object.prepare(
      "UPDATE runs SET lease_expires_at = 1577836800000 WHERE run_id = ?",
    ).run(RUN_ONE);

    // The renewal lands inside the reap's own transaction, immediately before
    // its body reads the fence. That is where this race has to be staged now
    // that the compare-and-swap is one transaction rather than a D1 batch: the
    // scan has already seen the stale deadline, and the write must still refuse.
    let intercepted = false;
    const racingRuns = testHarnessRunPort(sqlite.objectDatabase, () => {
      if (intercepted) return;
      intercepted = true;
      sqlite.object.prepare(
        "UPDATE runs SET heartbeat_at = 1785715200000, lease_expires_at = 4070908800000 WHERE run_id = ?",
      ).run(RUN_ONE);
    });

    expect(await reapStaleHarnessRuns(racingRuns, {
      receipts: () => sqlite.receipts,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
    })).toEqual([]);
    expect(intercepted).toBe(true);
    expect(sqlite.object.prepare(
      "SELECT status, legacy_attempt_id AS attempt_id, lease_owner, lease_expires_at, terminalized_at FROM runs WHERE run_id = ?",
    ).get(RUN_ONE)).toEqual({
      status: "running",
      attempt_id: "attempt-racing-reaper",
      lease_owner: "owner-racing-reaper",
      lease_expires_at: 4070908800000,
      terminalized_at: null,
    });
    expect(sqlite.object.prepare(
      "SELECT COUNT(*) AS count FROM run_lifecycle_events WHERE run_id = ? AND event_key = 'terminal'",
    ).get(RUN_ONE)).toEqual({ count: 0 });
  });

  it("requires a persisted agent text message before committing completed terminal state", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-final-turn",
      owner: "owner-final-turn",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");

    await expect(terminalizeHarnessAttempt(sqlite.runs, input(RUN_ONE), claim.lease, {
      status: "completed",
    }, sqlite.receipts )).rejects.toThrow("final_turn_required");
    seedCanonicalConversationTurn(sqlite.object, {
      turnId: "human-final",
      clientMessageId: "human-final",
      actor: "human",
      authorUserId: "user-runtime",
      authorSnapshot: { displayName: "Runtime user", avatarUrl: null },
      text: "Not an agent result",
      transcriptSequence: 1,
      createdAt: "2026-08-03",
    });
    await expect(terminalizeHarnessAttempt(sqlite.runs, input(RUN_ONE), claim.lease, {
      status: "completed",
      finalTurnId: "human-final",
    }, sqlite.receipts )).rejects.toThrow("final_turn_not_persisted");
    expect(sqlite.object.prepare(
      "SELECT terminalized_at FROM runs WHERE run_id = ?",
    ).get(RUN_ONE)).toEqual({ terminalized_at: null });
    expect(sqlite.object.prepare(
      "SELECT COUNT(*) AS count FROM run_lifecycle_events WHERE run_id = ? AND event_key = 'terminal'",
    ).get(RUN_ONE)).toEqual({ count: 0 });
  });

  it("keeps realtime failures best-effort while final turn and terminal state remain durable", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-realtime-outage",
      owner: "owner-realtime-outage",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");

    const delivered: string[] = [];
    const dropped: string[] = [];
    await expect(__integrationTesting.publishRuntimeEventBestEffort(
      { type: "stream_completed", streamId: RUN_ONE },
      [
        {
          channel: "runtime_observer",
          publish: async () => { throw new Error("observer unavailable"); },
        },
        {
          channel: "workstream_realtime",
          publish: async (event) => { delivered.push(String(event.type)); },
        },
      ],
      (channel) => { dropped.push(channel); },
    )).resolves.toBeUndefined();

    expect(dropped).toEqual(["runtime_observer"]);
    expect(delivered).toEqual(["stream_completed"]);

    await persistHarnessHostOutcome(sqlite.runs, input(RUN_ONE), claim.lease, {
      turnId: `${RUN_ONE}:turn:1`,
      text: "Durable despite the realtime outage",
    }, null, { status: "completed" });
    await expect(terminalizeHarnessAttempt(sqlite.runs, input(RUN_ONE), claim.lease, {
      status: "completed",
      finalTurnId: `${RUN_ONE}:turn:1`,
    }, sqlite.receipts )).resolves.toBe("terminalized");

    expect(sqlite.object.prepare(
      `SELECT turn.actor, payload.payload_json, event.attempt_id
         FROM participant_transcript_turns turn
         JOIN transcript_facts fact ON fact.fact_id = turn.root_fact_id
         JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id
         JOIN run_lifecycle_events event
           ON event.run_id = ? AND event.event_key = 'host_outcome'
        WHERE turn.turn_id = ?`,
    ).get(RUN_ONE, `${RUN_ONE}:turn:1`)).toMatchObject({
      actor: "assistant",
      payload_json: expect.stringContaining("Durable despite the realtime outage"),
      attempt_id: "attempt-realtime-outage",
    });
    expect(sqlite.object.prepare(
      "SELECT status, final_turn_id, terminalized_at FROM runs WHERE run_id = ?",
    ).get(RUN_ONE)).toMatchObject({
      status: "completed",
      final_turn_id: `${RUN_ONE}:turn:1`,
    });
    expect(sqlite.object.prepare(
      "SELECT COUNT(*) AS count FROM run_lifecycle_events WHERE run_id = ? AND event_key = 'terminal'",
    ).get(RUN_ONE)).toEqual({ count: 1 });
  });

  it("canonicalizes the recorded scope and makes plugin activation idempotent", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.runs, input(RUN_ONE), {
      attemptId: "attempt-immutable",
      owner: "owner-immutable",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");

    const firstScope = {
      executionPrincipal: { userId: "user-runtime", type: "user" },
      eligibleConnectionIds: ["connection-b", "connection-a", "connection-b"],
      eligibleCapabilities: ["issues.write", "issues.read", "issues.read"],
      eligibleConnectionCapabilities: {
        "connection-b": ["issues.write", "issues.write"],
        "connection-a": ["issues.read"],
      },
      triggerPolicy: { source: "desktop", kind: "interactive" },
      routingPolicyVersion: "routing-v1",
      promptVersion: "prompt-v1",
      toolSurfaceHash: "tools-v1",
      limits: { maxToolCalls: 12, maxIterations: 8 },
    };
    const first = await persistImmutableRunScope(sqlite.runs, input(RUN_ONE), claim.lease, firstScope);
    const reordered = await persistImmutableRunScope(sqlite.runs, input(RUN_ONE), claim.lease, {
      ...firstScope,
      executionPrincipal: { type: "user", userId: "user-runtime" },
      eligibleConnectionIds: ["connection-a", "connection-b"],
      eligibleCapabilities: ["issues.read", "issues.write"],
      eligibleConnectionCapabilities: {
        "connection-a": ["issues.read"],
        "connection-b": ["issues.write"],
      },
      triggerPolicy: { kind: "interactive", source: "desktop" },
      limits: { maxIterations: 8, maxToolCalls: 12 },
    });
    expect(reordered).toEqual({ scopeHash: first.scopeHash, reused: true });

    const plugin = {
      pluginId: "connection:00000000-0000-4000-8000-000000000099",
      toolSurfaceHash: "surface-v1",
    };
    await persistRunPluginActivation(sqlite.runs, input(RUN_ONE), claim.lease, plugin);
    await persistRunPluginActivation(sqlite.runs, input(RUN_ONE), claim.lease, plugin);
    await persistRunPluginActivation(sqlite.runs, input(RUN_ONE), claim.lease, {
      ...plugin,
      toolSurfaceHash: "surface-v2",
    });

    expect(sqlite.object.prepare(
      "SELECT eligible_connection_ids_json, eligible_capabilities_json FROM run_scopes WHERE run_id = ?",
    ).get(RUN_ONE)).toEqual({
      eligible_connection_ids_json: '["connection-a","connection-b"]',
      eligible_capabilities_json: '["issues.read","issues.write"]',
    });
    expect(sqlite.object.prepare(
      "SELECT COUNT(*) AS count FROM run_plugin_activations WHERE run_id = ? AND plugin_id = ?",
    ).get(RUN_ONE, plugin.pluginId)).toEqual({ count: 1 });
  });
});

describe("inline child-run durability", () => {
  it("keeps ordinary elicitation continuations in the normal queue", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const continuationId = asHarnessRunId("00000000-0000-4000-8000-000000000005");
    seedWorkstreamRun(sqlite.objectDatabase, { id: continuationId, status: "admitted",
      origin: "elicitation_resume", executionPrincipalJson: '{"type":"user","userId":"user-runtime"}',
      parentRunId: RUN_ONE, createdAt: Date.parse("2026-08-03T00:00:00.000Z") });

    const claim = await claimHarnessAttempt(sqlite.runs, input(continuationId), {
      attemptId: "attempt-continuation",
      owner: "owner-continuation",
    });
    expect(claim.state).toBe("claimed");
    if (claim.state !== "claimed") throw new Error("expected claimed continuation");

    expect(await cancelDescendantHarnessRuns(sqlite.runs, RUN_ONE, "parent_cancelled"))
      .toBe(0);
    expect(sqlite.object.prepare(
      `SELECT parent_run_id AS parent_harness_run_id, parent_tool_call_id, cancellation_requested_at
         FROM runs WHERE run_id = ?`,
    ).get(continuationId)).toEqual({
      parent_harness_run_id: RUN_ONE,
      parent_tool_call_id: null,
      cancellation_requested_at: null,
    });

    await persistHarnessHostOutcome(sqlite.runs, input(continuationId), claim.lease, {
      turnId: `${continuationId}:turn:1`,
      text: "Continuation complete",
    }, null, { status: "completed" });
    expect(await terminalizeHarnessAttempt(
      sqlite.runs,
      input(continuationId),
      claim.lease,
      { status: "completed", finalTurnId: `${continuationId}:turn:1` },
      sqlite.receipts,
    )).toBe("terminalized");
  });
});

function inferenceStreamResponse(events: unknown[]): Response {
  return responsesStreamResponse(events);
}
