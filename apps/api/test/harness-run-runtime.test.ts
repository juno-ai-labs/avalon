import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { runHarness, type HarnessTool } from "@avalon/agent-harness";
import { afterEach, describe, expect, it } from "vitest";

import {
  type ImmutableRunScope,
  admitInlineChildAttempt,
  assertInlineChildAttemptOwned,
  cancelDescendantHarnessRuns,
  claimHarnessAttempt,
  checkpointToolInvocation,
  completeToolInvocation,
  finalizeToolInvocationFailure,
  heartbeatInlineChildAttempt,
  heartbeatHarnessAttempt,
  loadInlineChildResult,
  loadPersistedHarnessFinalOutcome,
  markToolInvocationTimedOut,
  persistHarnessFinalMessage,
  persistInlineChildScope,
  persistImmutableRunScope,
  persistRunPluginActivation,
  persistToolExecutionPlan,
  reapStaleHarnessRuns,
  recordInferenceAttempt,
  terminalizeInlineChildAttempt,
  terminalizeQueuedHarnessRun,
  terminalizeHarnessAttempt,
} from "../src/runtime/harness-run-runtime";
import { __integrationTesting } from "../src/services/integrations";
import { createCloudflareTestBinding, createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";

const migrationsDirectory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const WORKSTREAM_ID = "00000000-0000-4000-8000-000000000002";
const RUN_ONE = "00000000-0000-4000-8000-000000000003";
const RUN_TWO = "00000000-0000-4000-8000-000000000004";

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

function fixture(): SqliteD1Database {
  const database = new DatabaseSync(":memory:");
  for (const fileName of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(`${migrationsDirectory}/${fileName}`, "utf8"));
  }
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
    INSERT INTO harness_runs
      (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
    VALUES
      ('${RUN_ONE}', '${WORKSPACE_ID}', '${WORKSTREAM_ID}', 'test', '{"type":"user","userId":"user-runtime"}', 'running', '2026-08-03'),
      ('${RUN_TWO}', '${WORKSPACE_ID}', '${WORKSTREAM_ID}', 'test', '{"type":"user","userId":"user-runtime"}', 'running', '2026-08-03');
  `);
  return new SqliteD1Database(database);
}

const openDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

function input(harnessRunId: string) {
  return { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, harnessRunId };
}

const PARENT_SCOPE = {
  executionPrincipal: { type: "user", userId: "user-runtime" },
  eligibleConnectionIds: ["connection-read", "connection-write"],
  eligibleCapabilities: ["documents.read", "documents.write"],
  eligibleConnectionCapabilities: {
    "connection-read": ["documents.read"],
    "connection-write": ["documents.read", "documents.write"],
  },
  triggerPolicy: { kind: "interactive" },
  routingPolicyVersion: "routing-v1",
  promptVersion: "prompt-v1",
  toolSurfaceHash: "parent-tools-v1",
  limits: { maxIterations: 8, maxToolCalls: 16 },
} satisfies ImmutableRunScope;

async function claimScopedParent(sqlite: SqliteD1Database) {
  const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
    attemptId: "attempt-parent",
    owner: "owner-parent",
  });
  if (claim.state !== "claimed") throw new Error("expected claimed parent attempt");
  await persistImmutableRunScope(sqlite.binding, input(RUN_ONE), claim.lease, PARENT_SCOPE);
  return claim.lease;
}

function childScope(overrides: Partial<ImmutableRunScope> = {}): ImmutableRunScope {
  return {
    ...PARENT_SCOPE,
    eligibleConnectionIds: ["connection-read"],
    eligibleCapabilities: ["documents.read"],
    eligibleConnectionCapabilities: { "connection-read": ["documents.read"] },
    triggerPolicy: { kind: "sub_agent", readOnly: true },
    toolSurfaceHash: "child-tools-v1",
    limits: { maxIterations: 4, maxToolCalls: 8 },
    ...overrides,
  };
}

describe("durable harness attempt runtime", () => {
  it("serializes attempts, freezes scope, persists activation, and terminalizes once", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const first = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
      attemptId: "attempt-one",
      owner: "owner-one",
    });
    expect(first.state).toBe("claimed");
    if (first.state !== "claimed") throw new Error("expected claimed attempt");

    const queued = await claimHarnessAttempt(sqlite.binding, input(RUN_TWO), {
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
    expect(await persistImmutableRunScope(sqlite.binding, input(RUN_ONE), first.lease, scope))
      .toMatchObject({ reused: false });
    expect(await persistImmutableRunScope(sqlite.binding, input(RUN_ONE), first.lease, scope))
      .toMatchObject({ reused: true });
    await expect(persistImmutableRunScope(sqlite.binding, input(RUN_ONE), first.lease, {
      ...scope,
      promptVersion: "prompt-v2",
    })).rejects.toThrow("immutable_run_scope_mismatch");

    await persistRunPluginActivation(sqlite.binding, input(RUN_ONE), first.lease, {
      pluginId: "connection:00000000-0000-4000-8000-000000000099",
      toolSurfaceHash: "plugin-tools-v1",
    });
    await heartbeatHarnessAttempt(sqlite.binding, RUN_ONE, first.lease);
    await expect(terminalizeHarnessAttempt(sqlite.binding, input(RUN_ONE), first.lease, {
      status: "completed",
    })).rejects.toThrow("final_message_required");
    await expect(terminalizeHarnessAttempt(sqlite.binding, input(RUN_ONE), first.lease, {
      status: "completed",
      finalMessageId: "message-final",
    })).rejects.toThrow("final_message_not_persisted");
    await persistHarnessFinalMessage(sqlite.binding, input(RUN_ONE), first.lease, {
      id: "message-final",
      sequenceNumber: 1,
      text: "Done",
      createdAt: "2026-08-03T00:00:00.000Z",
    }, { status: "completed" });
    expect(sqlite.database.prepare(
      `SELECT latest_attention_sequence_number, last_activity_at
       FROM workstreams WHERE id = ?`,
    ).get(WORKSTREAM_ID)).toEqual({
      latest_attention_sequence_number: 1,
      last_activity_at: "2026-08-03T00:00:00.000Z",
    });

    expect(await terminalizeHarnessAttempt(sqlite.binding, input(RUN_ONE), first.lease, {
      status: "completed",
      finalMessageId: "message-final",
    })).toBe("terminalized");
    expect(await terminalizeHarnessAttempt(sqlite.binding, input(RUN_ONE), first.lease, {
      status: "completed",
      finalMessageId: "message-final",
    })).toBe("already_terminal");
    expect(sqlite.database.prepare(
      "SELECT COUNT(*) AS count FROM harness_run_lifecycle_events WHERE harness_run_id = ? AND event_key = 'terminal'",
    ).get(RUN_ONE)).toEqual({ count: 1 });

    const second = await claimHarnessAttempt(sqlite.binding, input(RUN_TWO), {
      attemptId: "attempt-two",
      owner: "owner-two",
    });
    expect(second.state).toBe("claimed");
    expect(sqlite.database.prepare(
      "SELECT harness_status FROM workstreams WHERE id = ?",
    ).get(WORKSTREAM_ID)).toEqual({ harness_status: "running" });
  });

  it("runs HyperSight blocks beside each other and beside the single interactive executor", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const runThree = "00000000-0000-4000-8000-000000000005";
    const runFour = "00000000-0000-4000-8000-000000000006";
    sqlite.database.exec(`
      UPDATE harness_runs SET origin = 'hypersight_block', status = 'scheduled';
      UPDATE workstreams SET harness_status = 'idle' WHERE id = '${WORKSTREAM_ID}';
      INSERT INTO harness_runs
        (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
      VALUES
        ('${runThree}', '${WORKSPACE_ID}', '${WORKSTREAM_ID}', 'human_message',
         '{"type":"user","userId":"user-runtime"}', 'running', '2026-08-03'),
        ('${runFour}', '${WORKSPACE_ID}', '${WORKSTREAM_ID}', 'hypersight_block',
         '{"type":"workspace","workspaceId":"${WORKSPACE_ID}"}', 'scheduled', '2026-08-03');
    `);

    const [firstBlock, secondBlock] = await Promise.all([
      claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
        attemptId: "attempt-hypersight-one",
        owner: "owner-hypersight-one",
      }),
      claimHarnessAttempt(sqlite.binding, input(RUN_TWO), {
        attemptId: "attempt-hypersight-two",
        owner: "owner-hypersight-two",
      }),
    ]);
    expect(firstBlock.state).toBe("claimed");
    expect(secondBlock.state).toBe("claimed");
    expect(sqlite.database.prepare(
      "SELECT harness_status FROM workstreams WHERE id = ?",
    ).get(WORKSTREAM_ID)).toEqual({ harness_status: "idle" });

    const interactive = await claimHarnessAttempt(sqlite.binding, input(runThree), {
      attemptId: "attempt-interactive",
      owner: "owner-interactive",
    });
    expect(interactive.state).toBe("claimed");
    const laterBlock = await claimHarnessAttempt(sqlite.binding, input(runFour), {
      attemptId: "attempt-hypersight-four",
      owner: "owner-hypersight-four",
    });
    expect(laterBlock.state).toBe("claimed");
  });

  it("keeps the workstream running while a superseding interactive turn is pending", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const original = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
      attemptId: "attempt-superseded",
      owner: "owner-superseded",
    });
    if (original.state !== "claimed") throw new Error("expected claimed original attempt");
    sqlite.database.prepare(
      `UPDATE harness_runs
          SET cancellation_requested_at = ?, cancellation_reason = 'superseded_by_follow_up'
        WHERE id = ?`,
    ).run("2026-08-07T12:00:00.000Z", RUN_ONE);

    await expect(terminalizeHarnessAttempt(
      sqlite.binding,
      input(RUN_ONE),
      original.lease,
      { status: "stopped" },
    )).resolves.toBe("terminalized");
    expect(sqlite.database.prepare(
      "SELECT harness_status FROM workstreams WHERE id = ?",
    ).get(WORKSTREAM_ID)).toEqual({ harness_status: "running" });

    const replacement = await claimHarnessAttempt(sqlite.binding, input(RUN_TWO), {
      attemptId: "attempt-replacement",
      owner: "owner-replacement",
    });
    expect(replacement.state).toBe("claimed");
  });

  it("terminalizes a HyperSight result without a transcript message or workstream status change", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    sqlite.database.exec(`
      DELETE FROM harness_runs WHERE id = '${RUN_TWO}';
      UPDATE harness_runs
         SET origin = 'hypersight_block', status = 'scheduled', model = 'x-ai/grok-4.3'
       WHERE id = '${RUN_ONE}';
      UPDATE workstreams SET harness_status = 'completed' WHERE id = '${WORKSTREAM_ID}';
      INSERT INTO hypersight_configuration_versions
        (id, workspace_id, workstream_id, version_number, blocks_json,
         created_by_user_id, created_at)
      VALUES ('hypersight-runtime-version', '${WORKSPACE_ID}', '${WORKSTREAM_ID}', 1,
              '[{"id":"block-runtime","prompt":"Summarize"}]', 'user-runtime', '2026-08-03');
      INSERT INTO hypersight_block_runs
        (id, workspace_id, workstream_id, configuration_version_id, block_id, prompt,
         trigger_sequence, harness_run_id, status, created_at)
      VALUES ('hypersight-runtime-run', '${WORKSPACE_ID}', '${WORKSTREAM_ID}',
              'hypersight-runtime-version', 'block-runtime', 'Summarize', 12,
              '${RUN_ONE}', 'queued', '2026-08-03');
    `);

    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
      attemptId: "attempt-hypersight",
      owner: "owner-hypersight",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed HyperSight attempt");
    expect(sqlite.database.prepare(
      "SELECT harness_status FROM workstreams WHERE id = ?",
    ).get(WORKSTREAM_ID)).toEqual({ harness_status: "completed" });
    sqlite.database.prepare(
      "UPDATE hypersight_block_runs SET status = 'completed', markdown = '# Current view' WHERE harness_run_id = ?",
    ).run(RUN_ONE);

    await expect(terminalizeHarnessAttempt(
      sqlite.binding,
      input(RUN_ONE),
      claim.lease,
      { status: "completed" },
    )).resolves.toBe("terminalized");
    expect(sqlite.database.prepare(
      "SELECT status, final_message_id FROM harness_runs WHERE id = ?",
    ).get(RUN_ONE)).toEqual({ status: "completed", final_message_id: null });
    expect(sqlite.database.prepare(
      "SELECT harness_status FROM workstreams WHERE id = ?",
    ).get(WORKSTREAM_ID)).toEqual({ harness_status: "completed" });
  });

  it("fences final-message writes and recovers a final persisted before terminalization", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const original = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
      attemptId: "attempt-original",
      owner: "owner-original",
    });
    expect(original.state).toBe("claimed");
    if (original.state !== "claimed") throw new Error("expected claimed attempt");

    await persistHarnessFinalMessage(sqlite.binding, input(RUN_ONE), original.lease, {
      id: "message-recoverable",
      sequenceNumber: 1,
      text: "Durable before terminalization",
      createdAt: "2026-08-03T00:00:00.000Z",
    }, { status: "completed" });
    await persistHarnessFinalMessage(sqlite.binding, input(RUN_ONE), original.lease, {
      id: "message-recoverable",
      sequenceNumber: 1,
      text: "Durable before terminalization",
      createdAt: "2026-08-03T00:00:00.000Z",
    }, { status: "completed" });
    await expect(persistHarnessFinalMessage(sqlite.binding, input(RUN_ONE), original.lease, {
      id: "message-recoverable",
      sequenceNumber: 1,
      text: "Durable before terminalization",
      createdAt: "2026-08-03T00:00:00.000Z",
    }, {
      status: "failed",
      error: { code: "changed_outcome", message: "Must not replace the durable outcome" },
    })).rejects.toThrow("final_message_host_outcome_mismatch");
    expect(sqlite.database.prepare(
      `SELECT harness_attempt_id FROM messages WHERE id = 'message-recoverable'`,
    ).get()).toEqual({ harness_attempt_id: "attempt-original" });
    expect(sqlite.database.prepare(
      `SELECT COUNT(*) AS count FROM harness_run_lifecycle_events
        WHERE harness_run_id = ? AND event_key = 'final_message'`,
    ).get(RUN_ONE)).toEqual({ count: 1 });

    sqlite.database.prepare(
      "UPDATE harness_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(RUN_ONE);
    await expect(persistHarnessFinalMessage(sqlite.binding, input(RUN_ONE), original.lease, {
      id: "message-from-stale-owner",
      sequenceNumber: 2,
      text: "Must not persist",
      createdAt: "2026-08-03T00:00:01.000Z",
    }, { status: "completed" })).rejects.toThrow("durable attempt lease");
    expect(sqlite.database.prepare(
      `SELECT COUNT(*) AS count FROM messages WHERE id = 'message-from-stale-owner'`,
    ).get()).toEqual({ count: 0 });

    const recovery = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
      attemptId: "attempt-recovery",
      owner: "owner-recovery",
    });
    expect(recovery.state).toBe("claimed");
    if (recovery.state !== "claimed") throw new Error("expected recovery attempt");
    expect(await terminalizeHarnessAttempt(sqlite.binding, input(RUN_ONE), recovery.lease, {
      status: "completed",
      finalMessageId: "message-recoverable",
    })).toBe("terminalized");
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
  ])("recovers the exact $status outcome after a crash following final-message persistence", async ({
    status,
    error,
  }) => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
      attemptId: `attempt-crash-${status}`,
      owner: `owner-crash-${status}`,
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");

    if (status === "stopped") {
      sqlite.database.prepare(
        `UPDATE harness_runs
            SET cancellation_requested_at = '2026-08-03T00:00:00.000Z',
                cancellation_reason = 'stopped_by_user'
          WHERE id = ?`,
      ).run(RUN_ONE);
    }

    const messageId = `message-crash-${status}`;
    await persistHarnessFinalMessage(sqlite.binding, input(RUN_ONE), claim.lease, {
      id: messageId,
      sequenceNumber: 1,
      text: `Partial durable output before ${status}`,
      createdAt: "2026-08-03T00:00:01.000Z",
    }, {
      status,
      ...(error ? { error } : {}),
    });

    // Simulate the host disappearing before the Workflow's terminalization
    // step. Recovery must use the immutable checkpoint, not infer completion
    // merely because the final message row exists.
    expect(sqlite.database.prepare(
      "SELECT status, terminalized_at FROM harness_runs WHERE id = ?",
    ).get(RUN_ONE)).toEqual({ status: "running", terminalized_at: null });
    expect(await loadPersistedHarnessFinalOutcome(sqlite.binding, input(RUN_ONE))).toEqual({
      messageId,
      status,
      ...(error ? { error } : {}),
    });
    const lifecycle = sqlite.database.prepare(
      `SELECT status, member_safe_payload_json
         FROM harness_run_lifecycle_events
        WHERE harness_run_id = ? AND event_key = 'final_message'`,
    ).get(RUN_ONE) as { status: string; member_safe_payload_json: string };
    expect(lifecycle.status).toBe(status);
    expect(JSON.parse(lifecycle.member_safe_payload_json)).toEqual({
      finalMessageId: messageId,
      hostOutcome: {
        status,
        ...(error ? { error } : {}),
      },
    });
  });

  it("terminalizes a queued run without disturbing the active attempt", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const active = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
      attemptId: "attempt-active",
      owner: "owner-active",
    });
    expect(active.state).toBe("claimed");
    expect(await claimHarnessAttempt(sqlite.binding, input(RUN_TWO), {
      attemptId: "attempt-queued",
      owner: "owner-queued",
    })).toMatchObject({ state: "busy" });

    expect(await terminalizeQueuedHarnessRun(
      sqlite.binding,
      input(RUN_TWO),
      { attemptId: "attempt-queued", owner: "owner-queued" },
      { code: "run_admission_timeout", message: "The work stream remained busy for too long" },
    )).toBe("terminalized");
    expect(await terminalizeQueuedHarnessRun(
      sqlite.binding,
      input(RUN_TWO),
      { attemptId: "attempt-queued", owner: "owner-queued" },
      { code: "run_admission_timeout", message: "The work stream remained busy for too long" },
    )).toBe("already_terminal");
    expect(sqlite.database.prepare(
      "SELECT status, attempt_id, lease_owner FROM harness_runs WHERE id = ?",
    ).get(RUN_TWO)).toEqual({ status: "failed", attempt_id: "attempt-queued", lease_owner: null });
    expect(sqlite.database.prepare(
      "SELECT COUNT(*) AS count FROM harness_run_lifecycle_events WHERE harness_run_id = ? AND event_key = 'terminal'",
    ).get(RUN_TWO)).toEqual({ count: 1 });
    expect(sqlite.database.prepare(
      "SELECT harness_status FROM workstreams WHERE id = ?",
    ).get(WORKSTREAM_ID)).toEqual({ harness_status: "running" });
  });

  it("never claims a run cancelled before lease acquisition", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    sqlite.database.prepare(
      `UPDATE harness_runs
          SET status = 'scheduled', cancellation_requested_at = '2026-08-03T00:00:00.000Z'
        WHERE id = ?`,
    ).run(RUN_ONE);

    expect(await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
      attemptId: "attempt-cancelled-before-claim",
      owner: "owner-cancelled-before-claim",
    })).toEqual({ state: "cancelled" });
    expect(sqlite.database.prepare(
      "SELECT status, attempt_id, lease_owner FROM harness_runs WHERE id = ?",
    ).get(RUN_ONE)).toEqual({ status: "scheduled", attempt_id: null, lease_owner: null });

    expect(await terminalizeQueuedHarnessRun(
      sqlite.binding,
      input(RUN_ONE),
      { attemptId: "attempt-cancelled-before-claim", owner: "owner-cancelled-before-claim" },
      { code: "run_cancelled", message: "The run was stopped before it started" },
      "stopped",
    )).toBe("terminalized");
    expect(sqlite.database.prepare(
      "SELECT status, terminalized_at FROM harness_runs WHERE id = ?",
    ).get(RUN_ONE)).toMatchObject({ status: "stopped" });
  });

  it("CAS-reaps stale ownership and records append-only inference accounting", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    sqlite.database.exec(`
      INSERT INTO automation_templates
        (id, workspace_id, owner_user_id, name, description, sharing_state,
         latest_version_number, created_at, updated_at)
      VALUES ('automation-template-stale', '${WORKSPACE_ID}', 'user-runtime',
              'Stale run', 'Stale run', 'workspace', 1, '2026-08-03', '2026-08-03');
      INSERT INTO automation_template_versions
        (id, template_id, version_number, instructions, trigger_definitions_json,
         required_capabilities_json, expected_outputs_json, default_behavior_json,
         created_by_user_id, created_at)
      VALUES ('automation-template-version-stale', 'automation-template-stale', 1,
              'Run', '[]', '[]', '[]', '{}', 'user-runtime', '2026-08-03');
      INSERT INTO automation_subscriptions
        (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
         execution_principal_json, connector_bindings_json, overrides_json,
         status, created_at, updated_at)
      VALUES ('automation-subscription-stale', '${WORKSPACE_ID}', 'automation-template-stale',
              'automation-template-version-stale', 'workspace', NULL,
              '{"type":"workspace"}', '{}', '{}', 'active', '2026-08-03', '2026-08-03');
    `);
    sqlite.database.prepare(
      `INSERT INTO automation_runs
       (id, workspace_id, automation_subscription_id, workstream_id, trigger_type,
        started_at, status, created_at)
       VALUES (?, ?, ?, ?, 'scheduled', ?, 'running', ?)`,
    ).run(
      "automation-run-stale",
      WORKSPACE_ID,
      "automation-subscription-stale",
      WORKSTREAM_ID,
      "2026-08-03T00:00:00.000Z",
      "2026-08-03T00:00:00.000Z",
    );
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
      attemptId: "attempt-stale",
      owner: "owner-stale",
    });
    expect(claim.state).toBe("claimed");
    sqlite.database.prepare(
      "UPDATE harness_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(RUN_ONE);

    expect(await reapStaleHarnessRuns(sqlite.binding, {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
    })).toEqual([RUN_ONE]);
    expect(sqlite.database.prepare("SELECT status, lease_owner FROM harness_runs WHERE id = ?").get(RUN_ONE))
      .toEqual({ status: "failed", lease_owner: null });
    expect(sqlite.database.prepare(
      "SELECT status, completed_at, result_summary FROM automation_runs WHERE id = 'automation-run-stale'",
    ).get()).toMatchObject({
      status: "failed",
      result_summary: "The harness executor lost its durable lease",
    });

    await recordInferenceAttempt(sqlite.binding, {
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
    expect(sqlite.database.prepare(
      `SELECT provider, model, outcome, failure_classification, latency_ms, ttft_ms,
              input_tokens, output_tokens, reasoning_tokens, cached_tokens,
              cost_microusd, response_bytes
         FROM inference_attempts WHERE id = 'inference-1'`,
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
      cost_microusd: 125,
      response_bytes: 4_096,
    });
    expect(() => sqlite.database.prepare(
      "UPDATE inference_attempts SET outcome = 'success' WHERE id = 'inference-1'",
    ).run()).toThrow("inference_attempt_immutable");
  });

  it("persists exactly one inference-ledger row for every Bind defect, retry, and fallback attempt", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
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
        maxWallClockMs: 2_000,
        toolTimeoutMs: 100,
        maxWebResults: 4,
        completionDefectRetries: 1,
      },
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      harnessRunId: RUN_ONE,
      executionPrincipal: { type: "user", userId: "user-runtime" },
      systemPrompt: "Exercise the durable inference ledger.",
      messages: [{ role: "user", content: "Use the read tool, then finish." }],
      corePlugins: [{
        canonicalId: "avalon:test_ledger",
        modelId: "avalon_test_ledger",
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
        await recordInferenceAttempt(sqlite.binding, {
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
    expect(sqlite.database.prepare(
      "SELECT COUNT(*) AS count FROM inference_attempts WHERE harness_run_id = ?",
    ).get(RUN_ONE)).toEqual({ count: requestedModels.length });
    expect(sqlite.database.prepare(
      `SELECT id, turn_id, endpoint_attempt, fallback_attempt, model, outcome,
              failure_classification
         FROM inference_attempts
        WHERE harness_run_id = ?
        ORDER BY id`,
    ).all(RUN_ONE)).toEqual([
      {
        id: "bind-callback-01",
        turn_id: `${RUN_ONE}:turn:1`,
        endpoint_attempt: 1,
        fallback_attempt: 0,
        model: primaryModel,
        outcome: "defect",
        failure_classification: "completion_defect",
      },
      {
        id: "bind-callback-02",
        turn_id: `${RUN_ONE}:turn:1`,
        endpoint_attempt: 2,
        fallback_attempt: 0,
        model: primaryModel,
        outcome: "retry",
        failure_classification: null,
      },
      {
        id: "bind-callback-03",
        turn_id: `${RUN_ONE}:turn:2`,
        endpoint_attempt: 1,
        fallback_attempt: 0,
        model: primaryModel,
        outcome: "fallback",
        failure_classification: "http",
      },
      {
        id: "bind-callback-04",
        turn_id: `${RUN_ONE}:turn:2`,
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
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
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
    expect(await persistToolExecutionPlan(sqlite.binding, claim.lease, readPlan))
      .toMatchObject({ state: "created", invocationId: "invocation-read" });
    await checkpointToolInvocation(sqlite.binding, claim.lease, {
      harnessRunId: RUN_ONE,
      invocationId: "invocation-read",
      checkpointIndex: 1,
      phase: "provider_request_started",
    });
    expect(await persistToolExecutionPlan(sqlite.binding, claim.lease, readPlan))
      .toMatchObject({ state: "resume_read", invocationId: "invocation-read" });
    expect(await completeToolInvocation(sqlite.binding, claim.lease, {
      harnessRunId: RUN_ONE,
      invocationId: "invocation-read",
      checkpointIndex: 2,
      outputRef: "payloads/runtime/read.json",
      outputSummary: "Issue AVA-1",
    })).toBe("persisted");
    // A provider-facing alias may change between attempts. It is not part of
    // the immutable execution plan, so replay remains bound to canonical policy.
    expect(await persistToolExecutionPlan(sqlite.binding, claim.lease, {
      ...readPlan,
      toolName: "default_api.linear_issue_get",
    }))
      .toMatchObject({ state: "replay_completed", invocationId: "invocation-read" });
    expect(await persistToolExecutionPlan(sqlite.binding, claim.lease, {
      ...readPlan,
      toolName: "default_api.linear_issue_get",
      plan: { ...readPlan.plan, canonicalToolName: "linear.issue.update", mode: "write" },
    })).toMatchObject({ state: "ambiguous_external_write", invocationId: "invocation-read" });

    const writePlan = await persistToolExecutionPlan(sqlite.binding, claim.lease, {
      invocationId: "invocation-write",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-write",
      toolName: "linear.issue.update",
      inputHash: "input-write",
      input: { id: "AVA-1", title: "Updated" },
      plan: { connectionId: "connection-linear", operation: "issue.update" },
      providerIdempotencyKey: "avalon:run:call-write",
      mode: "write",
    });
    expect(writePlan.state).toBe("created");
    expect(await markToolInvocationTimedOut(sqlite.binding, claim.lease, {
      harnessRunId: RUN_ONE,
      invocationId: "invocation-write",
      mayHaveWritten: true,
    })).toBe("ambiguous");
    expect(sqlite.database.prepare(
      "SELECT status, provider_idempotency_key FROM tool_invocations WHERE id = 'invocation-write'",
    ).get()).toEqual({ status: "ambiguous", provider_idempotency_key: "avalon:run:call-write" });
    expect(await completeToolInvocation(sqlite.binding, claim.lease, {
      harnessRunId: RUN_ONE,
      invocationId: "invocation-write",
      checkpointIndex: 2,
      outputRef: "payloads/runtime/reconciled-write.json",
      outputSummary: "Reconciled durable write",
      allowAmbiguousReconciliation: true,
    })).toBe("persisted");
    expect(sqlite.database.prepare(
      "SELECT status, output_ref FROM tool_invocations WHERE id = 'invocation-write'",
    ).get()).toEqual({ status: "completed", output_ref: "payloads/runtime/reconciled-write.json" });
    expect(sqlite.database.prepare(
      "SELECT phase FROM tool_invocation_checkpoints WHERE tool_invocation_id = 'invocation-read' ORDER BY checkpoint_index",
    ).all()).toEqual([
      { phase: "execution_planned" },
      { phase: "provider_request_started" },
      { phase: "result_persisted" },
    ]);
  });

  it("accepts exact legacy receipt plans without weakening read and write replay fences", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
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
    expect(await persistToolExecutionPlan(sqlite.binding, claim.lease, {
      ...readCoordinates,
      invocationId: "invocation-compatible-read",
      plan: legacyReadPlan,
    })).toMatchObject({ state: "created" });
    expect(await persistToolExecutionPlan(sqlite.binding, claim.lease, {
      ...readCoordinates,
      plan: currentReadPlan,
      compatiblePriorPlans: [legacyReadPlan],
    })).toMatchObject({ state: "resume_read" });
    expect(await completeToolInvocation(sqlite.binding, claim.lease, {
      harnessRunId: RUN_ONE,
      invocationId: "invocation-compatible-read",
      checkpointIndex: 1,
      outputRef: "payloads/runtime/compatible-read.json",
      outputSummary: "Found issues",
    })).toBe("persisted");
    expect(await persistToolExecutionPlan(sqlite.binding, claim.lease, {
      ...readCoordinates,
      plan: currentReadPlan,
      compatiblePriorPlans: [legacyReadPlan],
    })).toMatchObject({ state: "replay_completed" });
    expect(await persistToolExecutionPlan(sqlite.binding, claim.lease, {
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
    expect(await persistToolExecutionPlan(sqlite.binding, claim.lease, {
      ...writeCoordinates,
      invocationId: "invocation-compatible-write",
      plan: legacyWritePlan,
    })).toMatchObject({ state: "created" });
    expect(await persistToolExecutionPlan(sqlite.binding, claim.lease, {
      ...writeCoordinates,
      plan: currentWritePlan,
      compatiblePriorPlans: [legacyWritePlan],
    })).toMatchObject({ state: "ambiguous_external_write" });
  });

  it("routes plan conflicts, repeated writes, definitive failures, and timeouts through terminal receipt fencing", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
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
    await persistToolExecutionPlan(sqlite.binding, claim.lease, {
      ...basePlan,
      invocationId: "invocation-plan-conflict",
      toolCallId: "call-plan-conflict",
      plan: { operation: "issue.get", version: 1 },
    });
    expect(await persistToolExecutionPlan(sqlite.binding, claim.lease, {
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
    await persistToolExecutionPlan(sqlite.binding, claim.lease, {
      ...writePlan,
      invocationId: "invocation-write-retry",
      toolCallId: "call-write-retry",
    });
    expect(await persistToolExecutionPlan(sqlite.binding, claim.lease, {
      ...writePlan,
      toolCallId: "call-write-retry",
    })).toMatchObject({ state: "ambiguous_external_write" });

    await persistToolExecutionPlan(sqlite.binding, claim.lease, {
      ...basePlan,
      invocationId: "invocation-definitive-failure",
      toolCallId: "call-definitive-failure",
      plan: { operation: "issue.get" },
    });
    expect(await finalizeToolInvocationFailure(sqlite.binding, claim.lease, {
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

    await persistToolExecutionPlan(sqlite.binding, claim.lease, {
      ...basePlan,
      invocationId: "invocation-read-timeout",
      toolCallId: "call-read-timeout",
      plan: { operation: "issue.get" },
    });
    expect(await markToolInvocationTimedOut(sqlite.binding, claim.lease, {
      harnessRunId: RUN_ONE,
      invocationId: "invocation-read-timeout",
      mayHaveWritten: false,
    })).toBe("failed");

    const rows = sqlite.database.prepare(
      `SELECT id, status, error_json FROM tool_invocations
        WHERE id IN (?, ?, ?, ?) ORDER BY id`,
    ).all(
      "invocation-plan-conflict",
      "invocation-write-retry",
      "invocation-definitive-failure",
      "invocation-read-timeout",
    );
    expect(rows).toEqual([
      {
        id: "invocation-definitive-failure",
        status: "failed",
        error_json: '{"code":"tool_failed","message":"The provider rejected the request","data":{"code":"revision_conflict","details":{"reason":"Read the item again by ID before retrying."}}}',
      },
      {
        id: "invocation-plan-conflict",
        status: "ambiguous",
        error_json: '{"code":"ambiguous_external_write","message":"A tool-call receipt was reused with a different immutable execution plan"}',
      },
      {
        id: "invocation-read-timeout",
        status: "failed",
        error_json: '{"code":"tool_timeout","message":"The tool request timed out before producing a result"}',
      },
      {
        id: "invocation-write-retry",
        status: "ambiguous",
        error_json: '{"code":"ambiguous_external_write","message":"A prior write may have reached the provider"}',
      },
    ]);
    expect(sqlite.database.prepare(
      `SELECT tool_invocation_id, phase FROM tool_invocation_checkpoints
        WHERE tool_invocation_id IN (?, ?, ?, ?)
          AND checkpoint_index = 1
        ORDER BY tool_invocation_id`,
    ).all(
      "invocation-plan-conflict",
      "invocation-write-retry",
      "invocation-definitive-failure",
      "invocation-read-timeout",
    )).toEqual([
      { tool_invocation_id: "invocation-definitive-failure", phase: "execution_failed" },
      { tool_invocation_id: "invocation-plan-conflict", phase: "ambiguous_external_write" },
      { tool_invocation_id: "invocation-read-timeout", phase: "timed_out" },
      { tool_invocation_id: "invocation-write-retry", phase: "ambiguous_external_write" },
    ]);
  });

  it("rebinds a settled read receipt whose coordinates a re-executed pass reused", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
      attemptId: "attempt-receipt-reuse",
      owner: "owner-receipt-reuse",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");

    const readPlan = {
      pluginId: "avalon:tool-discovery",
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
    expect(await persistToolExecutionPlan(sqlite.binding, claim.lease, {
      ...coordinates,
      invocationId: "invocation-reused-coordinate",
      toolName: "load_plugin",
      inputHash: "terminal-plugin",
      input: { pluginId: "avalon_terminal" },
      plan: readPlan,
    })).toMatchObject({ state: "created" });
    expect(await completeToolInvocation(sqlite.binding, claim.lease, {
      harnessRunId: RUN_ONE,
      invocationId: "invocation-reused-coordinate",
      checkpointIndex: 1,
      outputRef: "payloads/runtime/loaded-terminal.json",
      outputSummary: "Loaded Terminal; 9 tools are now available",
    })).toBe("persisted");

    // The identical call still replays. Rebinding may never cost a pass the
    // result it already paid for.
    expect(await persistToolExecutionPlan(sqlite.binding, claim.lease, {
      ...coordinates,
      toolName: "load_plugin",
      inputHash: "terminal-plugin",
      input: { pluginId: "avalon_terminal" },
      plan: readPlan,
    })).toMatchObject({ state: "replay_completed", invocationId: "invocation-reused-coordinate" });

    // A different read landing on the same coordinate executes instead of
    // halting the run: nothing external moved, so nothing is ambiguous.
    expect(await persistToolExecutionPlan(sqlite.binding, claim.lease, {
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
    expect(sqlite.database.prepare(
      `SELECT tool_name, status, input_hash, output_ref, output_summary, error_json
         FROM tool_invocations WHERE id = 'invocation-reused-coordinate'`,
    ).get()).toEqual({
      tool_name: "search_code",
      status: "started",
      input_hash: "github-search",
      output_ref: null,
      output_summary: null,
      error_json: null,
    });
    expect(sqlite.database.prepare(
      `SELECT phase FROM tool_invocation_checkpoints
        WHERE tool_invocation_id = 'invocation-reused-coordinate' ORDER BY checkpoint_index`,
    ).all()).toEqual([
      { phase: "execution_planned" },
      { phase: "result_persisted" },
      { phase: "execution_replanned" },
    ]);

    // A write landing on a settled read coordinate still fails closed, and a
    // read landing on a settled write coordinate reports the ambiguity rather
    // than raising a lease failure that never happened.
    await completeToolInvocation(sqlite.binding, claim.lease, {
      harnessRunId: RUN_ONE,
      invocationId: "invocation-reused-coordinate",
      checkpointIndex: 3,
      outputRef: "payloads/runtime/searched-code.json",
      outputSummary: "Found 3 matches",
    });
    expect(await persistToolExecutionPlan(sqlite.binding, claim.lease, {
      ...coordinates,
      mode: "write",
      toolName: "publish_branch_and_pr",
      inputHash: "publish",
      input: { branch: "add-model" },
      plan: { ...readPlan, canonicalToolName: "publish_branch_and_pr", mode: "write" },
    })).toMatchObject({ state: "ambiguous_external_write" });

    const settledWrite = `${RUN_ONE}:turn:2:tool:0`;
    await persistToolExecutionPlan(sqlite.binding, claim.lease, {
      ...coordinates,
      toolCallId: settledWrite,
      invocationId: "invocation-settled-write",
      mode: "write",
      toolName: "publish_branch_and_pr",
      inputHash: "publish",
      input: { branch: "add-model" },
      plan: { ...readPlan, canonicalToolName: "publish_branch_and_pr", mode: "write" },
    });
    await completeToolInvocation(sqlite.binding, claim.lease, {
      harnessRunId: RUN_ONE,
      invocationId: "invocation-settled-write",
      checkpointIndex: 1,
      outputRef: "payloads/runtime/published.json",
      outputSummary: "Opened pull request",
    });
    expect(await persistToolExecutionPlan(sqlite.binding, claim.lease, {
      ...coordinates,
      toolCallId: settledWrite,
      toolName: "load_plugin",
      inputHash: "github-plugin",
      input: { pluginId: "plugin_github" },
      plan: readPlan,
    })).toMatchObject({ state: "ambiguous_external_write", invocationId: "invocation-settled-write" });
    expect(sqlite.database.prepare(
      "SELECT status FROM tool_invocations WHERE id = 'invocation-settled-write'",
    ).get()).toEqual({ status: "completed" });
  });

  it("does not publish an R2 result reference when its lease is lost after upload", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
      attemptId: "attempt-upload-race",
      owner: "owner-upload-race",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");
    await persistToolExecutionPlan(sqlite.binding, claim.lease, {
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
    let intercepted = false;
    const racingBinding = createTestD1Database({
      prepare: sqlite.binding.prepare.bind(sqlite.binding),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!intercepted) {
          intercepted = true;
          expect(uploaded).toBe(true);
          sqlite.database.prepare(
            `UPDATE harness_runs
                SET attempt_id = 'attempt-upload-successor',
                    lease_owner = 'owner-upload-successor',
                    lease_expires_at = '2099-01-01T00:00:00.000Z'
              WHERE id = ?`,
          ).run(RUN_ONE);
        }
        return sqlite.binding.batch(statements);
      },
    });
    const env = createTestEnv({
      AVALON_REGION: "global",
      DB: racingBinding,
      PAYLOADS: createCloudflareTestBinding<R2Bucket>({
        put: async (key: string) => {
          uploaded = true;
          uploadedKey = key;
          return {} as R2Object;
        },
      }),
    });

    await expect(__integrationTesting.persistSuccessfulToolResult(env, input(RUN_ONE), claim.lease, {
      invocationId: "invocation-upload-race",
      toolCallId: "call/upload race",
      output: { issue: { id: "AVA-3", title: "Immutable result" } },
      outputSummary: "Issue AVA-3",
    })).rejects.toMatchObject({ code: "run_ownership_lost" });
    expect(intercepted).toBe(true);
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
    expect(sqlite.database.prepare(
      `SELECT status, output_ref, output_summary, checkpoint_index
         FROM tool_invocations WHERE id = ?`,
    ).get("invocation-upload-race")).toEqual({
      status: "started",
      output_ref: null,
      output_summary: null,
      checkpoint_index: 0,
    });
    expect(sqlite.database.prepare(
      "SELECT COUNT(*) AS count FROM tool_invocation_checkpoints WHERE tool_invocation_id = ?",
    ).get("invocation-upload-race")).toEqual({ count: 1 });

    uploaded = false;
    await expect(__integrationTesting.persistSuccessfulToolResult(env, input(RUN_ONE), claim.lease, {
      invocationId: "invocation-upload-race",
      toolCallId: "call/upload race",
      output: { issue: { id: "AVA-3" } },
      outputSummary: "Issue AVA-3",
    })).rejects.toMatchObject({ code: "run_ownership_lost" });
    expect(uploaded).toBe(false);
  });

  it("rechecks every failure and ambiguity fence at the atomic D1 mutation", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
      attemptId: "attempt-failure-fences",
      owner: "owner-failure-fences",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");

    const fenceCases = [
      {
        name: "attempt",
        mutate: () => sqlite.database.prepare(
          "UPDATE harness_runs SET attempt_id = 'attempt-other' WHERE id = ?",
        ).run(RUN_ONE),
        code: "run_ownership_lost",
      },
      {
        name: "owner",
        mutate: () => sqlite.database.prepare(
          "UPDATE harness_runs SET lease_owner = 'owner-other' WHERE id = ?",
        ).run(RUN_ONE),
        code: "run_ownership_lost",
      },
      {
        name: "state",
        mutate: () => sqlite.database.prepare(
          "UPDATE harness_runs SET status = 'needs_input' WHERE id = ?",
        ).run(RUN_ONE),
        code: "run_ownership_lost",
      },
      {
        name: "cancellation",
        mutate: () => sqlite.database.prepare(
          "UPDATE harness_runs SET cancellation_requested_at = '2026-08-03T00:00:00.000Z' WHERE id = ?",
        ).run(RUN_ONE),
        code: "run_cancelled",
      },
      {
        name: "db-time-expiry",
        mutate: () => sqlite.database.prepare(
          "UPDATE harness_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
        ).run(RUN_ONE),
        code: "run_ownership_lost",
      },
    ];

    for (const status of ["failed", "ambiguous"] as const) {
      for (const fence of fenceCases) {
        sqlite.database.prepare(
          `UPDATE harness_runs
              SET attempt_id = ?, lease_owner = ?, status = 'running',
                  cancellation_requested_at = NULL, terminalized_at = NULL,
                  lease_expires_at = '2099-01-01T00:00:00.000Z'
            WHERE id = ?`,
        ).run(claim.lease.attemptId, claim.lease.owner, RUN_ONE);
        const suffix = `${status}-${fence.name}`;
        const invocationId = `invocation-${suffix}`;
        await persistToolExecutionPlan(sqlite.binding, claim.lease, {
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

        let intercepted = false;
        const racingBinding = createTestD1Database({
          prepare: sqlite.binding.prepare.bind(sqlite.binding),
          batch: async (statements: D1PreparedStatement[]) => {
            if (!intercepted) {
              intercepted = true;
              fence.mutate();
            }
            return sqlite.binding.batch(statements);
          },
        });
        await expect(finalizeToolInvocationFailure(racingBinding, claim.lease, {
          harnessRunId: RUN_ONE,
          invocationId,
          status,
          phase: status === "ambiguous" ? "ambiguous_external_write" : "execution_failed",
          error: {
            code: status === "ambiguous" ? "ambiguous_external_write" : "tool_failed",
            message: `Fenced ${suffix}`,
          },
        })).rejects.toMatchObject({ code: fence.code });
        expect(intercepted).toBe(true);
        expect(sqlite.database.prepare(
          "SELECT status, error_json, checkpoint_index FROM tool_invocations WHERE id = ?",
        ).get(invocationId)).toEqual({
          status: "started",
          error_json: null,
          checkpoint_index: 0,
        });
        expect(sqlite.database.prepare(
          "SELECT COUNT(*) AS count FROM tool_invocation_checkpoints WHERE tool_invocation_id = ?",
        ).get(invocationId)).toEqual({ count: 1 });
      }
    }
  });

  it("observes cancellation and still permits the owning attempt to terminalize as stopped", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
      attemptId: "attempt-cancelled",
      owner: "owner-cancelled",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");

    sqlite.database.prepare(
      `UPDATE harness_runs
          SET cancellation_requested_at = '2026-08-03T00:00:00.000Z',
              cancellation_reason = 'member_stop'
        WHERE id IN (?, ?)`,
    ).run(RUN_ONE, RUN_TWO);

    await expect(heartbeatHarnessAttempt(sqlite.binding, RUN_ONE, claim.lease))
      .rejects.toMatchObject({ code: "run_cancelled" });
    expect(await terminalizeHarnessAttempt(sqlite.binding, input(RUN_ONE), claim.lease, {
      status: "stopped",
      error: { code: "run_cancelled", message: "The member stopped this run" },
      memberSafePayload: { code: "run_cancelled" },
    })).toBe("terminalized");

    expect(sqlite.database.prepare(
      `SELECT status, cancellation_requested_at, terminalized_at, lease_owner
         FROM harness_runs WHERE id = ?`,
    ).get(RUN_ONE)).toMatchObject({
      status: "stopped",
      cancellation_requested_at: "2026-08-03T00:00:00.000Z",
      lease_owner: null,
    });
    expect(sqlite.database.prepare(
      "SELECT harness_status FROM workstreams WHERE id = ?",
    ).get(WORKSTREAM_ID)).toEqual({ harness_status: "idle" });
    expect(sqlite.database.prepare(
      "SELECT status, member_safe_payload_json FROM harness_run_lifecycle_events WHERE harness_run_id = ? AND event_key = 'terminal'",
    ).get(RUN_ONE)).toEqual({
      status: "stopped",
      member_safe_payload_json: '{"code":"run_cancelled"}',
    });
  });

  it("fences every durable write from an executor after its lease ownership is replaced", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
      attemptId: "attempt-obsolete",
      owner: "owner-obsolete",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");

    sqlite.database.prepare(
      `UPDATE harness_runs
          SET attempt_id = 'attempt-successor', lease_owner = 'owner-successor',
              lease_expires_at = '2099-01-01T00:00:00.000Z'
        WHERE id = ?`,
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
    await expect(heartbeatHarnessAttempt(sqlite.binding, RUN_ONE, claim.lease))
      .rejects.toMatchObject({ code: "run_ownership_lost" });
    await expect(persistImmutableRunScope(sqlite.binding, input(RUN_ONE), claim.lease, scope))
      .rejects.toMatchObject({ code: "run_ownership_lost" });
    await expect(persistRunPluginActivation(sqlite.binding, input(RUN_ONE), claim.lease, {
      pluginId: "connection:stale",
      toolSurfaceHash: "surface-stale",
    })).rejects.toMatchObject({ code: "run_ownership_lost" });
    await expect(terminalizeHarnessAttempt(sqlite.binding, input(RUN_ONE), claim.lease, {
      status: "failed",
      error: { code: "obsolete", message: "An obsolete executor cannot terminalize" },
    })).rejects.toMatchObject({ code: "run_ownership_lost" });

    expect(sqlite.database.prepare(
      "SELECT status, attempt_id, lease_owner, terminalized_at FROM harness_runs WHERE id = ?",
    ).get(RUN_ONE)).toEqual({
      status: "running",
      attempt_id: "attempt-successor",
      lease_owner: "owner-successor",
      terminalized_at: null,
    });
    expect(sqlite.database.prepare(
      "SELECT COUNT(*) AS count FROM harness_run_lifecycle_events WHERE harness_run_id = ? AND event_key = 'terminal'",
    ).get(RUN_ONE)).toEqual({ count: 0 });
  });

  it("does not reap a stale-row snapshot whose lease is renewed before the CAS batch", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
      attemptId: "attempt-racing-reaper",
      owner: "owner-racing-reaper",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");
    sqlite.database.prepare(
      "UPDATE harness_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(RUN_ONE);

    let intercepted = false;
    const racingBinding = createTestD1Database({
      prepare: sqlite.binding.prepare.bind(sqlite.binding),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!intercepted) {
          intercepted = true;
          sqlite.database.prepare(
            "UPDATE harness_runs SET heartbeat_at = '2026-08-03T00:00:00.000Z', lease_expires_at = '2099-01-01T00:00:00.000Z' WHERE id = ?",
          ).run(RUN_ONE);
        }
        return sqlite.binding.batch(statements);
      },
    });

    expect(await reapStaleHarnessRuns(racingBinding, {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
    })).toEqual([]);
    expect(intercepted).toBe(true);
    expect(sqlite.database.prepare(
      "SELECT status, attempt_id, lease_owner, lease_expires_at, terminalized_at FROM harness_runs WHERE id = ?",
    ).get(RUN_ONE)).toEqual({
      status: "running",
      attempt_id: "attempt-racing-reaper",
      lease_owner: "owner-racing-reaper",
      lease_expires_at: "2099-01-01T00:00:00.000Z",
      terminalized_at: null,
    });
    expect(sqlite.database.prepare(
      "SELECT COUNT(*) AS count FROM harness_run_lifecycle_events WHERE harness_run_id = ? AND event_key = 'terminal'",
    ).get(RUN_ONE)).toEqual({ count: 0 });
  });

  it("requires a persisted agent text message before committing completed terminal state", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
      attemptId: "attempt-final-message",
      owner: "owner-final-message",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");

    await expect(terminalizeHarnessAttempt(sqlite.binding, input(RUN_ONE), claim.lease, {
      status: "completed",
    })).rejects.toThrow("final_message_required");
    sqlite.database.prepare(
      `INSERT INTO messages
       (id, client_message_id, workspace_id, workstream_id, author_type, author_user_id,
        message_type, text_content, sequence_number, created_at)
       VALUES ('human-final', 'human-final', ?, ?, 'human', 'user-runtime', 'text', 'Not an agent result', 1, '2026-08-03')`,
    ).run(WORKSPACE_ID, WORKSTREAM_ID);
    await expect(terminalizeHarnessAttempt(sqlite.binding, input(RUN_ONE), claim.lease, {
      status: "completed",
      finalMessageId: "human-final",
    })).rejects.toThrow("final_message_not_persisted");
    expect(sqlite.database.prepare(
      "SELECT terminalized_at FROM harness_runs WHERE id = ?",
    ).get(RUN_ONE)).toEqual({ terminalized_at: null });
    expect(sqlite.database.prepare(
      "SELECT COUNT(*) AS count FROM harness_run_lifecycle_events WHERE harness_run_id = ? AND event_key = 'terminal'",
    ).get(RUN_ONE)).toEqual({ count: 0 });
  });

  it("keeps realtime failures best-effort while final message and terminal state remain durable", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
      attemptId: "attempt-realtime-outage",
      owner: "owner-realtime-outage",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");

    const delivered: string[] = [];
    const dropped: string[] = [];
    await expect(__integrationTesting.publishRuntimeEventBestEffort(
      { type: "stream_completed", messageId: "message-realtime-outage" },
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

    await persistHarnessFinalMessage(sqlite.binding, input(RUN_ONE), claim.lease, {
      id: "message-realtime-outage",
      sequenceNumber: 1,
      text: "Durable despite the realtime outage",
      createdAt: "2026-08-03T00:00:00.000Z",
    }, { status: "completed" });
    await expect(terminalizeHarnessAttempt(sqlite.binding, input(RUN_ONE), claim.lease, {
      status: "completed",
      finalMessageId: "message-realtime-outage",
    })).resolves.toBe("terminalized");

    expect(sqlite.database.prepare(
      `SELECT text_content, harness_run_id, harness_attempt_id
         FROM messages WHERE id = 'message-realtime-outage'`,
    ).get()).toEqual({
      text_content: "Durable despite the realtime outage",
      harness_run_id: RUN_ONE,
      harness_attempt_id: "attempt-realtime-outage",
    });
    expect(sqlite.database.prepare(
      "SELECT status, final_message_id, terminalized_at FROM harness_runs WHERE id = ?",
    ).get(RUN_ONE)).toMatchObject({
      status: "completed",
      final_message_id: "message-realtime-outage",
    });
    expect(sqlite.database.prepare(
      "SELECT COUNT(*) AS count FROM harness_run_lifecycle_events WHERE harness_run_id = ? AND event_key = 'terminal'",
    ).get(RUN_ONE)).toEqual({ count: 1 });
  });

  it("canonicalizes immutable scope and makes plugin activation idempotent but not mutable", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
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
      memoryContextHash: "memory-context-v1",
      limits: { maxToolCalls: 12, maxIterations: 8 },
    };
    const first = await persistImmutableRunScope(sqlite.binding, input(RUN_ONE), claim.lease, firstScope);
    const reordered = await persistImmutableRunScope(sqlite.binding, input(RUN_ONE), claim.lease, {
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
    await persistRunPluginActivation(sqlite.binding, input(RUN_ONE), claim.lease, plugin);
    await persistRunPluginActivation(sqlite.binding, input(RUN_ONE), claim.lease, plugin);
    await expect(persistRunPluginActivation(sqlite.binding, input(RUN_ONE), claim.lease, {
      ...plugin,
      toolSurfaceHash: "surface-v2",
    })).rejects.toThrow("plugin_activation_mismatch");

    expect(sqlite.database.prepare(
      "SELECT eligible_connection_ids_json, eligible_capabilities_json, memory_context_hash FROM harness_run_scopes WHERE harness_run_id = ?",
    ).get(RUN_ONE)).toEqual({
      eligible_connection_ids_json: '["connection-a","connection-b"]',
      eligible_capabilities_json: '["issues.read","issues.write"]',
      memory_context_hash: "memory-context-v1",
    });
    expect(sqlite.database.prepare(
      "SELECT COUNT(*) AS count FROM harness_run_plugin_activations WHERE harness_run_id = ? AND plugin_id = ?",
    ).get(RUN_ONE, plugin.pluginId)).toEqual({ count: 1 });
  });
});

describe("inline child-run durability", () => {
  it("keeps ordinary elicitation continuations in the normal queue", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const continuationId = "00000000-0000-4000-8000-000000000005";
    sqlite.database.prepare(
      `INSERT INTO harness_runs
       (id, workspace_id, workstream_id, origin, execution_principal_json,
        parent_harness_run_id, status, created_at)
       VALUES (?, ?, ?, 'elicitation_resume', '{"type":"user","userId":"user-runtime"}',
               ?, 'scheduled', '2026-08-03')`,
    ).run(continuationId, WORKSPACE_ID, WORKSTREAM_ID, RUN_ONE);

    const claim = await claimHarnessAttempt(sqlite.binding, input(continuationId), {
      attemptId: "attempt-continuation",
      owner: "owner-continuation",
    });
    expect(claim.state).toBe("claimed");
    if (claim.state !== "claimed") throw new Error("expected claimed continuation");

    expect(await cancelDescendantHarnessRuns(sqlite.binding, RUN_ONE, "parent_cancelled"))
      .toBe(0);
    expect(sqlite.database.prepare(
      `SELECT parent_harness_run_id, parent_tool_call_id, cancellation_requested_at
         FROM harness_runs WHERE id = ?`,
    ).get(continuationId)).toEqual({
      parent_harness_run_id: RUN_ONE,
      parent_tool_call_id: null,
      cancellation_requested_at: null,
    });

    await persistHarnessFinalMessage(sqlite.binding, input(continuationId), claim.lease, {
      id: "message-continuation-final",
      sequenceNumber: 1,
      text: "Continuation complete",
      createdAt: "2026-08-03T00:00:00.000Z",
    }, { status: "completed" });
    expect(await terminalizeHarnessAttempt(
      sqlite.binding,
      input(continuationId),
      claim.lease,
      { status: "completed", finalMessageId: "message-continuation-final" },
    )).toBe("terminalized");
  });

  it("freezes a read-only narrowing of parent authority before activating child plugins", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const parentLease = await claimScopedParent(sqlite);
    const admitted = await admitInlineChildAttempt(
      sqlite.binding,
      input(RUN_ONE),
      parentLease,
      {
        parentToolCallId: "tool-child-scope",
        objective: "Read the authorized document metadata",
        childHarnessRunId: "child-scope",
        attemptId: "attempt-child-scope",
        owner: "owner-child-scope",
      },
    );
    if (admitted.state !== "claimed") throw new Error("expected claimed child attempt");

    const persisted = await persistInlineChildScope(
      sqlite.binding,
      input(RUN_ONE),
      parentLease,
      admitted.childInput,
      admitted.lease,
      childScope(),
    );
    expect(persisted.reused).toBe(false);
    expect(await persistInlineChildScope(
      sqlite.binding,
      input(RUN_ONE),
      parentLease,
      admitted.childInput,
      admitted.lease,
      childScope(),
    )).toEqual({ scopeHash: persisted.scopeHash, reused: true });

    await persistRunPluginActivation(sqlite.binding, admitted.childInput, admitted.lease, {
      pluginId: "connection:connection-read",
      toolSurfaceHash: "child-plugin-tools-v1",
    });
    expect(sqlite.database.prepare(
      `SELECT eligible_connection_ids_json, eligible_capabilities_json,
              eligible_connection_capabilities_json, trigger_policy_json
         FROM harness_run_scopes WHERE harness_run_id = ?`,
    ).get(admitted.childInput.harnessRunId)).toEqual({
      eligible_connection_ids_json: '["connection-read"]',
      eligible_capabilities_json: '["documents.read"]',
      eligible_connection_capabilities_json: '{"connection-read":["documents.read"]}',
      trigger_policy_json: '{"kind":"sub_agent","readOnly":true}',
    });
    expect(sqlite.database.prepare(
      `SELECT plugin_id FROM harness_run_plugin_activations WHERE harness_run_id = ?`,
    ).all(admitted.childInput.harnessRunId)).toEqual([
      { plugin_id: "connection:connection-read" },
    ]);

    await expect(persistInlineChildScope(
      sqlite.binding,
      input(RUN_ONE),
      parentLease,
      admitted.childInput,
      admitted.lease,
      childScope({
        eligibleConnectionIds: ["connection-not-in-parent"],
        eligibleConnectionCapabilities: { "connection-not-in-parent": ["documents.read"] },
      }),
    )).rejects.toThrow("inline_child_scope_widened");
    await expect(persistInlineChildScope(
      sqlite.binding,
      input(RUN_ONE),
      parentLease,
      admitted.childInput,
      admitted.lease,
      childScope({ triggerPolicy: { kind: "sub_agent", readOnly: false } }),
    )).rejects.toThrow("inline_child_scope_not_read_only");
  });

  it("uses the parent tool-call receipt as the deterministic child replay key", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const parentLease = await claimScopedParent(sqlite);
    const options = {
      parentToolCallId: "tool-replay",
      objective: "Summarize the two read-only findings",
      childHarnessRunId: "child-replay",
      attemptId: "attempt-child-replay",
      owner: "owner-child-replay",
    };
    const first = await admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, options);
    if (first.state !== "claimed") throw new Error("expected claimed child attempt");
    expect(first.reused).toBe(false);
    expect(await admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, options))
      .toMatchObject({ state: "busy", childInput: first.childInput });
    expect(await admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, {
      ...options,
      childHarnessRunId: "ignored-child-id",
      attemptId: "another-attempt",
      owner: "another-owner",
    })).toMatchObject({ state: "busy", childInput: first.childInput });

    await persistInlineChildScope(
      sqlite.binding,
      input(RUN_ONE),
      parentLease,
      first.childInput,
      first.lease,
      childScope(),
    );
    const outcome = {
      status: "completed" as const,
      result: { answer: `Two findings ${"x".repeat(70_000)}`, citations: ["resource:one", "resource:two"] },
      model: "google/gemini-2.5-flash-lite",
      usage: { inputTokens: 31, outputTokens: 12 },
    };
    expect(await terminalizeInlineChildAttempt(
      sqlite.binding,
      input(RUN_ONE),
      parentLease,
      first.childInput,
      first.lease,
      outcome,
    )).toBe("terminalized");
    expect(await terminalizeInlineChildAttempt(
      sqlite.binding,
      input(RUN_ONE),
      parentLease,
      first.childInput,
      first.lease,
      outcome,
    )).toBe("already_terminal");
    await expect(terminalizeInlineChildAttempt(
      sqlite.binding,
      input(RUN_ONE),
      parentLease,
      first.childInput,
      first.lease,
      { ...outcome, result: { answer: "Changed after completion" } },
    )).rejects.toThrow("durable attempt lease");

    expect(await loadInlineChildResult(sqlite.binding, RUN_ONE, options.parentToolCallId))
      .toEqual({ state: "replay", childInput: first.childInput, outcome });
    expect(await admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, {
      ...options,
      childHarnessRunId: "another-ignored-child-id",
      attemptId: "attempt-after-completion",
      owner: "owner-after-completion",
    })).toEqual({ state: "replay", childInput: first.childInput, outcome });
    await expect(admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, {
      ...options,
      objective: "A different task must not reuse the receipt",
    })).rejects.toThrow("inline_child_objective_mismatch");
  });

  it("reclaims an expired child with its durable attempt ID and a fresh fenced owner", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const parentLease = await claimScopedParent(sqlite);
    const options = {
      parentToolCallId: "tool-child-takeover",
      objective: "Resume the same durable investigation",
      childHarnessRunId: "child-takeover",
      attemptId: "attempt-child-takeover",
      owner: "owner-child-obsolete",
    };
    const original = await admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, options);
    if (original.state !== "claimed") throw new Error("expected original child claim");
    await persistInlineChildScope(
      sqlite.binding,
      input(RUN_ONE),
      parentLease,
      original.childInput,
      original.lease,
      childScope(),
    );
    sqlite.database.prepare(
      "UPDATE harness_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(original.childInput.harnessRunId);

    const takeover = await admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, {
      ...options,
      attemptId: "ignored-new-attempt-id",
      owner: "owner-child-takeover",
    });
    if (takeover.state !== "claimed") throw new Error("expected reclaimed child");
    expect(takeover).toMatchObject({
      childInput: original.childInput,
      reused: true,
      lease: {
        attemptId: original.lease.attemptId,
        owner: "owner-child-takeover",
        attemptNumber: 2,
      },
    });
    await expect(assertInlineChildAttemptOwned(
      sqlite.binding,
      input(RUN_ONE),
      parentLease,
      original.childInput,
      original.lease,
    )).rejects.toThrow("durable attempt lease");
    await expect(assertInlineChildAttemptOwned(
      sqlite.binding,
      input(RUN_ONE),
      parentLease,
      takeover.childInput,
      takeover.lease,
    )).resolves.toBeUndefined();
    expect(await persistInlineChildScope(
      sqlite.binding,
      input(RUN_ONE),
      parentLease,
      takeover.childInput,
      takeover.lease,
      childScope(),
    )).toMatchObject({ reused: true });
  });

  it("does not reclaim an expired child through an occupied workspace child slot", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const parentLease = await claimScopedParent(sqlite);
    const firstOptions = {
      parentToolCallId: "tool-expired-at-capacity",
      objective: "Resume only when a child slot is available",
      childHarnessRunId: "child-expired-at-capacity",
      attemptId: "attempt-expired-at-capacity",
      owner: "owner-expired-at-capacity",
      maxActiveWorkspaceChildren: 1,
      maxChainRuns: 64,
    };
    const first = await admitInlineChildAttempt(
      sqlite.binding,
      input(RUN_ONE),
      parentLease,
      firstOptions,
    );
    if (first.state !== "claimed") throw new Error("expected first child claim");
    sqlite.database.prepare(
      "UPDATE harness_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(first.childInput.harnessRunId);

    expect(await admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, {
      parentToolCallId: "tool-live-capacity-holder",
      objective: "Occupy the only workspace child slot",
      childHarnessRunId: "child-live-capacity-holder",
      attemptId: "attempt-live-capacity-holder",
      owner: "owner-live-capacity-holder",
      maxActiveWorkspaceChildren: 1,
      maxChainRuns: 64,
    })).toMatchObject({ state: "claimed" });

    expect(await admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, {
      ...firstOptions,
      owner: "owner-reclaim-blocked-by-capacity",
    })).toEqual({ state: "refused", reason: "workspace_child_capacity" });
    expect(sqlite.database.prepare(
      "SELECT lease_owner, attempt_number, lease_expires_at FROM harness_runs WHERE id = ?",
    ).get(first.childInput.harnessRunId)).toEqual({
      lease_owner: first.lease.owner,
      attempt_number: 1,
      lease_expires_at: "2020-01-01T00:00:00.000Z",
    });
  });

  it("atomically reserves parallel child capacity and frees it after terminalization", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const parentLease = await claimScopedParent(sqlite);
    const [first, second] = await Promise.all([
      admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, {
        parentToolCallId: "tool-parallel-one",
        objective: "Investigate source one",
        childHarnessRunId: "child-parallel-one",
        attemptId: "attempt-parallel-one",
        owner: "owner-parallel-one",
        maxChainRuns: 64,
        maxActiveWorkspaceChildren: 2,
      }),
      admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, {
        parentToolCallId: "tool-parallel-two",
        objective: "Investigate source two",
        childHarnessRunId: "child-parallel-two",
        attemptId: "attempt-parallel-two",
        owner: "owner-parallel-two",
        maxChainRuns: 64,
        maxActiveWorkspaceChildren: 2,
      }),
    ]);
    expect([first.state, second.state]).toEqual(["claimed", "claimed"]);
    if (first.state !== "claimed" || second.state !== "claimed") {
      throw new Error("expected both parallel children to claim capacity");
    }
    expect(sqlite.database.prepare(
      `SELECT COUNT(*) AS count FROM harness_runs
        WHERE parent_harness_run_id = ? AND status = 'running'`,
    ).get(RUN_ONE)).toEqual({ count: 2 });

    expect(await admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, {
      parentToolCallId: "tool-parallel-overflow",
      objective: "Investigate source three",
      childHarnessRunId: "child-parallel-overflow",
      attemptId: "attempt-parallel-overflow",
      owner: "owner-parallel-overflow",
      maxChainRuns: 64,
      maxActiveWorkspaceChildren: 2,
    })).toEqual({ state: "refused", reason: "workspace_child_capacity" });

    expect(await terminalizeInlineChildAttempt(
      sqlite.binding,
      input(RUN_ONE),
      parentLease,
      first.childInput,
      first.lease,
      { status: "completed", result: { finding: "one" } },
    )).toBe("terminalized");
    expect(await admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, {
      parentToolCallId: "tool-parallel-after-slot",
      objective: "Investigate source three",
      childHarnessRunId: "child-parallel-after-slot",
      attemptId: "attempt-parallel-after-slot",
      owner: "owner-parallel-after-slot",
      maxChainRuns: 64,
      maxActiveWorkspaceChildren: 2,
    })).toMatchObject({ state: "claimed" });
  });

  it("enforces chain and depth budgets independently of workspace capacity", async () => {
    const chainSqlite = fixture();
    openDatabases.push(chainSqlite.database);
    const chainParentLease = await claimScopedParent(chainSqlite);
    expect(await admitInlineChildAttempt(chainSqlite.binding, input(RUN_ONE), chainParentLease, {
      parentToolCallId: "tool-chain-one",
      objective: "Use the only chain slot",
      childHarnessRunId: "child-chain-one",
      attemptId: "attempt-chain-one",
      owner: "owner-chain-one",
      maxChainRuns: 2,
      maxActiveWorkspaceChildren: 64,
    })).toMatchObject({ state: "claimed" });
    expect(await admitInlineChildAttempt(chainSqlite.binding, input(RUN_ONE), chainParentLease, {
      parentToolCallId: "tool-chain-overflow",
      objective: "Exceed the chain budget",
      childHarnessRunId: "child-chain-overflow",
      attemptId: "attempt-chain-overflow",
      owner: "owner-chain-overflow",
      maxChainRuns: 2,
      maxActiveWorkspaceChildren: 64,
    })).toEqual({ state: "refused", reason: "chain_budget_exhausted" });

    const depthSqlite = fixture();
    openDatabases.push(depthSqlite.database);
    const depthParentLease = await claimScopedParent(depthSqlite);
    const child = await admitInlineChildAttempt(depthSqlite.binding, input(RUN_ONE), depthParentLease, {
      parentToolCallId: "tool-depth-one",
      objective: "Create the first level",
      childHarnessRunId: "child-depth-one",
      attemptId: "attempt-depth-one",
      owner: "owner-depth-one",
      maxDepth: 2,
      maxChainRuns: 64,
    });
    if (child.state !== "claimed") throw new Error("expected first-level child");
    await persistInlineChildScope(
      depthSqlite.binding,
      input(RUN_ONE),
      depthParentLease,
      child.childInput,
      child.lease,
      childScope(),
    );
    expect(await admitInlineChildAttempt(depthSqlite.binding, child.childInput, child.lease, {
      parentToolCallId: "tool-depth-overflow",
      objective: "Attempt a disallowed second level",
      childHarnessRunId: "child-depth-overflow",
      attemptId: "attempt-depth-overflow",
      owner: "owner-depth-overflow",
      maxDepth: 1,
      maxChainRuns: 64,
    })).toEqual({ state: "refused", reason: "depth_limit" });
  });

  it("propagates cancellation to descendants while permitting fenced stopped terminalization", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const parentLease = await claimScopedParent(sqlite);
    const child = await admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, {
      parentToolCallId: "tool-cancel",
      objective: "Wait for cancellation",
      childHarnessRunId: "child-cancel",
      attemptId: "attempt-child-cancel",
      owner: "owner-child-cancel",
    });
    if (child.state !== "claimed") throw new Error("expected claimed child");
    await persistInlineChildScope(
      sqlite.binding,
      input(RUN_ONE),
      parentLease,
      child.childInput,
      child.lease,
      childScope(),
    );

    expect(await cancelDescendantHarnessRuns(sqlite.binding, RUN_ONE, "parent_cancelled"))
      .toBe(1);
    await expect(assertInlineChildAttemptOwned(
      sqlite.binding,
      input(RUN_ONE),
      parentLease,
      child.childInput,
      child.lease,
    )).rejects.toThrow("cancelled");
    await expect(heartbeatInlineChildAttempt(
      sqlite.binding,
      input(RUN_ONE),
      parentLease,
      child.childInput,
      child.lease,
    )).rejects.toThrow("cancelled");
    expect(await terminalizeInlineChildAttempt(
      sqlite.binding,
      input(RUN_ONE),
      parentLease,
      child.childInput,
      child.lease,
      {
        status: "stopped",
        error: { code: "run_cancelled", message: "The parent cancelled this child" },
      },
    )).toBe("terminalized");
  });

  it("fences child heartbeats, scope writes, and completion after parent lease loss", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const parentLease = await claimScopedParent(sqlite);
    const child = await admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, {
      parentToolCallId: "tool-parent-lease-loss",
      objective: "Must stop when the parent loses ownership",
      childHarnessRunId: "child-parent-lease-loss",
      attemptId: "attempt-parent-lease-loss",
      owner: "owner-parent-lease-loss",
    });
    if (child.state !== "claimed") throw new Error("expected claimed child");
    sqlite.database.prepare(
      "UPDATE harness_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(RUN_ONE);

    await expect(heartbeatInlineChildAttempt(
      sqlite.binding,
      input(RUN_ONE),
      parentLease,
      child.childInput,
      child.lease,
    )).rejects.toThrow("durable attempt lease");
    await expect(persistInlineChildScope(
      sqlite.binding,
      input(RUN_ONE),
      parentLease,
      child.childInput,
      child.lease,
      childScope(),
    )).rejects.toThrow("durable attempt lease");
    await expect(terminalizeInlineChildAttempt(
      sqlite.binding,
      input(RUN_ONE),
      parentLease,
      child.childInput,
      child.lease,
      { status: "completed", result: { shouldNotPersist: true } },
    )).rejects.toThrow("durable attempt lease");
    expect(sqlite.database.prepare(
      "SELECT status, terminalized_at, child_result_json FROM harness_runs WHERE id = ?",
    ).get(child.childInput.harnessRunId)).toEqual({
      status: "running",
      terminalized_at: null,
      child_result_json: null,
    });
  });

  it("leaves a stale child reclaimable while its parent owns a live attempt", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const parentLease = await claimScopedParent(sqlite);
    const options = {
      parentToolCallId: "tool-stale-live-parent",
      objective: "Resume after a child executor disappears",
      childHarnessRunId: "child-stale-live-parent",
      attemptId: "attempt-child-stale-live-parent",
      owner: "owner-child-stale-live-parent",
    };
    const child = await admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, options);
    if (child.state !== "claimed") throw new Error("expected claimed child");
    sqlite.database.prepare(
      "UPDATE harness_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(child.childInput.harnessRunId);

    expect(await reapStaleHarnessRuns(sqlite.binding, {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
    })).toEqual([]);
    expect(await loadInlineChildResult(sqlite.binding, RUN_ONE, options.parentToolCallId))
      .toMatchObject({ state: "running", childInput: child.childInput });

    const reclaimed = await admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, {
      ...options,
      owner: "owner-child-reclaimed-after-reaper",
    });
    expect(reclaimed).toMatchObject({
      state: "claimed",
      childInput: child.childInput,
      reused: true,
      lease: {
        attemptId: child.lease.attemptId,
        owner: "owner-child-reclaimed-after-reaper",
        attemptNumber: 2,
      },
    });
  });

  it("cleans up an expired child after its parent terminalizes without changing workstream state", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const parentLease = await claimScopedParent(sqlite);
    sqlite.database.exec(`
      INSERT INTO automation_templates
        (id, workspace_id, owner_user_id, name, description, sharing_state,
         latest_version_number, created_at, updated_at)
      VALUES ('automation-template-child', '${WORKSPACE_ID}', 'user-runtime',
              'Child safety', 'Child safety', 'workspace', 1, '2026-08-03', '2026-08-03');
      INSERT INTO automation_template_versions
        (id, template_id, version_number, instructions, trigger_definitions_json,
         required_capabilities_json, expected_outputs_json, default_behavior_json,
         created_by_user_id, created_at)
      VALUES ('automation-template-version-child', 'automation-template-child', 1,
              'Run', '[]', '[]', '[]', '{}', 'user-runtime', '2026-08-03');
      INSERT INTO automation_subscriptions
        (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
         execution_principal_json, connector_bindings_json, overrides_json,
         status, created_at, updated_at)
      VALUES ('automation-subscription-child', '${WORKSPACE_ID}', 'automation-template-child',
              'automation-template-version-child', 'workspace', NULL,
              '{"type":"workspace"}', '{}', '{}', 'active', '2026-08-03', '2026-08-03');
      INSERT INTO automation_runs
        (id, workspace_id, automation_subscription_id, workstream_id, trigger_type,
         started_at, status, created_at)
      VALUES ('automation-run-child', '${WORKSPACE_ID}', 'automation-subscription-child',
              '${WORKSTREAM_ID}', 'scheduled', '2026-08-03', 'running', '2026-08-03');
    `);
    const child = await admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, {
      parentToolCallId: "tool-stale-child",
      objective: "Become stale",
      childHarnessRunId: "child-stale",
      attemptId: "attempt-child-stale",
      owner: "owner-child-stale",
    });
    if (child.state !== "claimed") throw new Error("expected claimed child");
    sqlite.database.prepare(
      "UPDATE harness_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(child.childInput.harnessRunId);
    sqlite.database.prepare(
      `UPDATE harness_runs
          SET status = 'completed', completed_at = '2026-08-03T00:00:00.000Z',
              terminalized_at = '2026-08-03T00:00:00.000Z',
              lease_owner = NULL, lease_expires_at = NULL
        WHERE id = ?`,
    ).run(RUN_ONE);

    expect(await reapStaleHarnessRuns(sqlite.binding, {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
    })).toEqual([child.childInput.harnessRunId]);
    expect(sqlite.database.prepare(
      "SELECT harness_status FROM workstreams WHERE id = ?",
    ).get(WORKSTREAM_ID)).toEqual({ harness_status: "running" });
    expect(sqlite.database.prepare(
      "SELECT status, completed_at, result_summary FROM automation_runs WHERE id = 'automation-run-child'",
    ).get()).toEqual({ status: "running", completed_at: null, result_summary: null });
    expect(await loadInlineChildResult(sqlite.binding, RUN_ONE, "tool-stale-child"))
      .toEqual({
        state: "replay",
        childInput: child.childInput,
        outcome: {
          status: "failed",
          error: {
            code: "parent_run_unavailable",
            message: "The parent run no longer owns a live attempt",
          },
        },
      });
    const persisted = sqlite.database.prepare(
      "SELECT child_result_json, child_result_hash FROM harness_runs WHERE id = ?",
    ).get(child.childInput.harnessRunId) as {
      child_result_json: string;
      child_result_hash: string;
    };
    const actualHash = Array.from(new Uint8Array(await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(persisted.child_result_json),
    ))).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(persisted.child_result_hash).toBe(actualHash);

    sqlite.database.prepare(
      `UPDATE harness_runs
          SET child_result_json = '{"status":"failed","error":{"code":"tampered","message":"tampered"}}'
        WHERE id = ?`,
    ).run(child.childInput.harnessRunId);
    await expect(loadInlineChildResult(sqlite.binding, RUN_ONE, "tool-stale-child"))
      .rejects.toThrow("inline_child_result_hash_mismatch");
  });

  it("cleans up an expired child after cancellation is requested", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const parentLease = await claimScopedParent(sqlite);
    const child = await admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, {
      parentToolCallId: "tool-cancelled-child-cleanup",
      objective: "Stop after cancellation",
      childHarnessRunId: "child-cancelled-cleanup",
      attemptId: "attempt-child-cancelled-cleanup",
      owner: "owner-child-cancelled-cleanup",
    });
    if (child.state !== "claimed") throw new Error("expected claimed child");
    expect(await cancelDescendantHarnessRuns(sqlite.binding, RUN_ONE, "parent_cancelled"))
      .toBe(1);
    sqlite.database.prepare(
      "UPDATE harness_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(child.childInput.harnessRunId);

    expect(await reapStaleHarnessRuns(sqlite.binding, {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
    })).toEqual([child.childInput.harnessRunId]);
    expect(await loadInlineChildResult(sqlite.binding, RUN_ONE, "tool-cancelled-child-cleanup"))
      .toEqual({
        state: "replay",
        childInput: child.childInput,
        outcome: {
          status: "stopped",
          error: { code: "run_cancelled", message: "The child run was cancelled" },
        },
      });
    expect(sqlite.database.prepare(
      "SELECT harness_status FROM workstreams WHERE id = ?",
    ).get(WORKSTREAM_ID)).toEqual({ harness_status: "running" });
  });

  it("does not clean up a child snapshot whose lease is renewed before the CAS batch", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const parentLease = await claimScopedParent(sqlite);
    const child = await admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, {
      parentToolCallId: "tool-child-reaper-race",
      objective: "Win the cleanup race",
      childHarnessRunId: "child-reaper-race",
      attemptId: "attempt-child-reaper-race",
      owner: "owner-child-reaper-race",
    });
    if (child.state !== "claimed") throw new Error("expected claimed child");
    sqlite.database.prepare(
      "UPDATE harness_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(child.childInput.harnessRunId);
    sqlite.database.prepare(
      `UPDATE harness_runs
          SET status = 'completed', terminalized_at = '2026-08-03T00:00:00.000Z',
              lease_owner = NULL, lease_expires_at = NULL
        WHERE id = ?`,
    ).run(RUN_ONE);

    let intercepted = false;
    const racingBinding = createTestD1Database({
      prepare: sqlite.binding.prepare.bind(sqlite.binding),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!intercepted) {
          intercepted = true;
          sqlite.database.prepare(
            "UPDATE harness_runs SET heartbeat_at = '2026-08-03T00:00:00.000Z', lease_expires_at = '2099-01-01T00:00:00.000Z' WHERE id = ?",
          ).run(child.childInput.harnessRunId);
        }
        return sqlite.binding.batch(statements);
      },
    });

    expect(await reapStaleHarnessRuns(racingBinding, {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
    })).toEqual([]);
    expect(intercepted).toBe(true);
    expect(sqlite.database.prepare(
      "SELECT status, lease_owner, lease_expires_at, terminalized_at FROM harness_runs WHERE id = ?",
    ).get(child.childInput.harnessRunId)).toEqual({
      status: "running",
      lease_owner: child.lease.owner,
      lease_expires_at: "2099-01-01T00:00:00.000Z",
      terminalized_at: null,
    });
  });
});

function inferenceStreamResponse(events: unknown[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
