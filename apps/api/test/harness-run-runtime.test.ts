import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { runHarness, type HarnessTool } from "@avalon/agent-harness";
import { asHarnessRunId, asUserId, asWorkspaceId, asWorkstreamId, type HarnessRunId } from "@avalon/contracts";
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
import { workstreamRuntimeDatabase } from "../src/services/workstream-runtime-database";
import {
  executeWorkstreamObjectSql,
  seedWorkstreamObjectRoot,
  testWorkstreamObjectStore,
  workstreamObjectAll,
  workstreamObjectGet,
  testBlockDashboardPort,
  testToolReceiptPort,
  workstreamObjectRun,
} from "./helpers/durable-authority";
import { legacyProductSqliteDatabase } from "./helpers/sqlite-d1";

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
 * A prepare/exec facade over the work stream's object database that speaks the
 * legacy table vocabulary — every statement travels the same rewrite the
 * runtime SQL port applies, so fixtures and assertions read and write the
 * `_runtime_*` compatibility views exactly as production statements do.
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
        workstreamObjectGet(object, sql, ...params) ?? undefined,
      all: (...params: Array<string | number | null>) => workstreamObjectAll(object, sql, ...params),
      run: (...params: Array<string | number | null>) => workstreamObjectRun(object, sql, ...params),
    }),
    exec: (script: string) => {
      for (const statement of script.split(";").map((part) => part.trim()).filter(Boolean)) {
        workstreamObjectRun(object, statement);
      }
    },
  };
}

interface RuntimeFixture {
  /**
   * The production router over both stores: regional statements execute on the
   * migrated D1 database, object-owned statements travel the runtime SQL port
   * into the work stream's object — the same binding the harness runtime
   * receives from `workstreamRuntimeDatabase` since the cutover.
   */
  binding: D1Database;
  /** The regional (D1) database: users, workspaces, directory, automation rows. */
  database: DatabaseSync;
  /** Legacy-vocabulary access to the work stream's object database. */
  object: ObjectFacade;
  receipts: ReturnType<typeof testToolReceiptPort>;
  blocks: ReturnType<typeof testBlockDashboardPort>;
  /** The raw object database, for the rare normalized-table statement. */
  objectDatabase: DatabaseSync;
  /** Statement counts sent through each object-local transaction. */
  statementBatchSizes: number[];
}

interface RuntimeFixtureOptions {
  afterObjectStatement?: Parameters<typeof executeWorkstreamObjectSql>[2];
}

function fixture(options: RuntimeFixtureOptions = {}): RuntimeFixture {
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
  // The run rows and workstream product state live in the work stream's object
  // since migration 0090 dropped the D1 copies; the fixture writes them through
  // the same compat port the runtime uses.
  const objectDatabase = testWorkstreamObjectStore();
  openDatabases.push(objectDatabase);
  seedWorkstreamObjectRoot(objectDatabase, { workstreamId: WORKSTREAM_ID, workspaceId: WORKSPACE_ID });
  const object = objectFacade(objectDatabase);
  const statementBatchSizes: number[] = [];
  object.exec(`
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, last_activity_at, created_at, updated_at)
    VALUES ('${WORKSTREAM_ID}', '${WORKSPACE_ID}', 'Runtime', 'Runtime', 'ad_hoc', 'user-runtime',
            'idle', '2026-01-01', '2026-01-01', '2026-01-01')
  `);
  // Seeded 'scheduled', not 'running': the object permits one mutating run per
  // substream (`runs_mutating_substream_uq`), so two pre-claimed running rows
  // could not coexist — and claiming is what moves a run to running anyway.
  object.exec(`
    INSERT INTO harness_runs
      (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
    VALUES
      ('${RUN_ONE}', '${WORKSPACE_ID}', '${WORKSTREAM_ID}', 'test', '{"type":"user","userId":"user-runtime"}', 'scheduled', '2026-08-03');
    INSERT INTO harness_runs
      (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
    VALUES
      ('${RUN_TWO}', '${WORKSPACE_ID}', '${WORKSTREAM_ID}', 'test', '{"type":"user","userId":"user-runtime"}', 'scheduled', '2026-08-03')
  `);
  const regional = new SqliteD1Database(database);
  return {
    // The statements travel the port verbatim — no normalizing shim. SQLite
    // refuses an alias on an UPDATE of a view carrying INSTEAD OF triggers
    // ("no such column: child.id"), which is why the inline-child statements
    // are written alias-free and name-qualified in src; every inline-child
    // heartbeat/terminalize/reap test in this file is the regression test
    // that keeps an alias from coming back.
    binding: workstreamRuntimeDatabase(
      createTestEnv({ DB: regional.binding }),
      WORKSPACE_ID,
      WORKSTREAM_ID,
      "0",
      async (statements) => {
        statementBatchSizes.push(statements.length);
        return executeWorkstreamObjectSql(
          objectDatabase,
          statements,
          options.afterObjectStatement,
        );
      },
    ),
    database,
    object,
    objectDatabase,
    statementBatchSizes,
    // The receipt operations no longer take a database handle: the lease fence
    // moved inside the object, so they take the port instead.
    receipts: testToolReceiptPort(objectDatabase),
    blocks: testBlockDashboardPort(objectDatabase),
  };
}

const openDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

function input(harnessRunId: HarnessRunId) {
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

async function claimScopedParent(sqlite: RuntimeFixture) {
  const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
    attemptId: "attempt-parent",
    owner: "owner-parent",
  });
  if (claim.state !== "claimed") throw new Error("expected claimed parent attempt");
  await persistImmutableRunScope(sqlite.binding, input(RUN_ONE), claim.lease, PARENT_SCOPE);
  return claim.lease;
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
  sqlite.object.prepare(
    `INSERT INTO messages
      (id, client_message_id, workspace_id, workstream_id, author_type, message_type,
       text_content, structured_content_json, sequence_number, created_at, edited_at)
     VALUES (?, ?, ?, ?, 'agent', 'tool', '', ?, 90, '2026-08-03T00:00:00.000Z', NULL)`,
  ).run(
    invocationId,
    `tool:${invocationId}`,
    WORKSPACE_ID,
    WORKSTREAM_ID,
    JSON.stringify({ invocation: { id: invocationId, toolName, status: "started" } }),
  );
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
    }, sqlite.receipts, sqlite.blocks)).rejects.toThrow("final_message_required");
    await expect(terminalizeHarnessAttempt(sqlite.binding, input(RUN_ONE), first.lease, {
      status: "completed",
      finalMessageId: "message-final",
    }, sqlite.receipts, sqlite.blocks)).rejects.toThrow("final_message_not_persisted");
    await persistHarnessFinalMessage(sqlite.binding, input(RUN_ONE), first.lease, {
      id: "message-final",
      sequenceNumber: 1,
      text: "Done",
      createdAt: "2026-08-03T00:00:00.000Z",
    }, { status: "completed" });
    expect(sqlite.object.prepare(
      `SELECT latest_attention_sequence_number, last_activity_at
       FROM workstreams WHERE id = ?`,
    ).get(WORKSTREAM_ID)).toEqual({
      latest_attention_sequence_number: 1,
      last_activity_at: "2026-08-03T00:00:00.000Z",
    });

    expect(await terminalizeHarnessAttempt(sqlite.binding, input(RUN_ONE), first.lease, {
      status: "completed",
      finalMessageId: "message-final",
    }, sqlite.receipts, sqlite.blocks)).toBe("terminalized");
    expect(await terminalizeHarnessAttempt(sqlite.binding, input(RUN_ONE), first.lease, {
      status: "completed",
      finalMessageId: "message-final",
    }, sqlite.receipts, sqlite.blocks)).toBe("already_terminal");
    expect(sqlite.object.prepare(
      "SELECT COUNT(*) AS count FROM harness_run_lifecycle_events WHERE harness_run_id = ? AND event_key = 'terminal'",
    ).get(RUN_ONE)).toEqual({ count: 1 });

    const second = await claimHarnessAttempt(sqlite.binding, input(RUN_TWO), {
      attemptId: "attempt-two",
      owner: "owner-two",
    });
    expect(second.state).toBe("claimed");
    expect(sqlite.object.prepare(
      "SELECT harness_status FROM workstreams WHERE id = ?",
    ).get(WORKSTREAM_ID)).toEqual({ harness_status: "running" });
  });

  it("runs HyperSight blocks beside each other and the interactive executor, without workstream state", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const runThree = asHarnessRunId("00000000-0000-4000-8000-000000000005");
    const runFour = asHarnessRunId("00000000-0000-4000-8000-000000000006");
    const runFive = asHarnessRunId("00000000-0000-4000-8000-000000000007");
    // A run's origin is immutable through the compat surface (the update
    // trigger deliberately carries no origin arm); shape the fixture rows on
    // the normalized table directly.
    sqlite.objectDatabase.exec(
      "UPDATE runs SET origin = 'block_dashboard_block', status = 'admitted'",
    );
    sqlite.object.exec(`
      UPDATE workstreams SET harness_status = 'idle' WHERE id = '${WORKSTREAM_ID}';
      INSERT INTO harness_runs
        (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
      VALUES
        ('${runThree}', '${WORKSPACE_ID}', '${WORKSTREAM_ID}', 'human_message',
         '{"type":"user","userId":"user-runtime"}', 'scheduled', '2026-08-03'),
        ('${runFour}', '${WORKSPACE_ID}', '${WORKSTREAM_ID}', 'block_dashboard_block',
         '{"type":"workspace","workspaceId":"${WORKSPACE_ID}"}', 'scheduled', '2026-08-03'),
        ('${runFive}', '${WORKSPACE_ID}', '${WORKSTREAM_ID}', 'human_message',
         '{"type":"user","userId":"user-runtime"}', 'scheduled', '2026-08-03');
    `);

    // The claim SQL never fenced block-origin runs against each other — their
    // serialization lives in `block_dashboard_block_runs` — and object schema
    // v9 encodes the same exemption into `runs_mutating_substream_uq`. Before
    // v9 the second block claim (and a block claim beside a running
    // interactive holder) surfaced as a UNIQUE violation thrown through the
    // port instead of a claim.
    const firstBlock = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
      attemptId: "attempt-block-dashboard-one",
      owner: "owner-block-dashboard-one",
    });
    expect(firstBlock.state).toBe("claimed");
    if (firstBlock.state !== "claimed") throw new Error("expected claimed block attempt");
    expect((await claimHarnessAttempt(sqlite.binding, input(RUN_TWO), {
      attemptId: "attempt-block-dashboard-two",
      owner: "owner-block-dashboard-two",
    })).state).toBe("claimed");
    // A block run never moves the member-facing work stream state.
    expect(sqlite.object.prepare(
      "SELECT harness_status FROM workstreams WHERE id = ?",
    ).get(WORKSTREAM_ID)).toEqual({ harness_status: "idle" });

    // A block run terminalizes against its persisted HyperSight result rather
    // than a transcript message.
    sqlite.object.exec(`
      -- The object's own columns. The compat views that projected id,
      -- workspace_id and ISO timestamps are gone, so a fixture written in that
      -- vocabulary would be seeding the thing this slice deleted.
      INSERT INTO block_dashboard_configuration_versions
        (configuration_version_id, version_number, blocks_json, created_by_user_id, created_at)
      VALUES ('block-serialize-version', 1,
              '[{"id":"block-serialize","prompt":"Summarize"}]', 'user-runtime', 1787000000000);
      INSERT INTO block_dashboard_block_runs
        (block_run_id, configuration_version_id, block_id, prompt,
         trigger_sequence, run_id, status, created_at)
      VALUES ('block-serialize-run', 'block-serialize-version', 'block-serialize', 'Summarize', 1,
              '${RUN_ONE}', 'queued', 1787000000000);
      UPDATE block_dashboard_block_runs SET status = 'completed', markdown = '# Done'
       WHERE run_id = '${RUN_ONE}'
    `);
    expect(await terminalizeHarnessAttempt(sqlite.binding, input(RUN_ONE), firstBlock.lease, {
      status: "completed",
    }, sqlite.receipts, sqlite.blocks)).toBe("terminalized");
    expect(sqlite.object.prepare(
      "SELECT harness_status FROM workstreams WHERE id = ?",
    ).get(WORKSTREAM_ID)).toEqual({ harness_status: "idle" });

    // The interactive executor claims while a block run (RUN_TWO) still holds
    // its lease — the interactive fence ignores block-origin actives — and a
    // further block claim runs beside the interactive holder.
    const interactive = await claimHarnessAttempt(sqlite.binding, input(runThree), {
      attemptId: "attempt-interactive",
      owner: "owner-interactive",
    });
    expect(interactive.state).toBe("claimed");
    expect(sqlite.object.prepare(
      "SELECT harness_status FROM workstreams WHERE id = ?",
    ).get(WORKSTREAM_ID)).toEqual({ harness_status: "running" });
    expect((await claimHarnessAttempt(sqlite.binding, input(runFour), {
      attemptId: "attempt-block-dashboard-four",
      owner: "owner-block-dashboard-four",
    })).state).toBe("claimed");
    // Interactive concurrency is still the claim's own fence: a second
    // interactive claim reports the graceful busy the scheduler retries on,
    // never a UNIQUE violation through the port.
    expect((await claimHarnessAttempt(sqlite.binding, input(runFive), {
      attemptId: "attempt-interactive-two",
      owner: "owner-interactive-two",
    })).state).toBe("busy");
  });

  it("keeps the workstream running while a superseding interactive turn is pending", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const original = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
      attemptId: "attempt-superseded",
      owner: "owner-superseded",
    });
    if (original.state !== "claimed") throw new Error("expected claimed original attempt");
    sqlite.object.prepare(
      `UPDATE harness_runs
          SET cancellation_requested_at = ?, cancellation_reason = 'superseded_by_follow_up'
        WHERE id = ?`,
    ).run("2026-08-07T12:00:00.000Z", RUN_ONE);

    await expect(terminalizeHarnessAttempt(
      sqlite.binding,
      input(RUN_ONE),
      original.lease,
      { status: "stopped" },
      sqlite.receipts,
      sqlite.blocks,
    )).resolves.toBe("terminalized");
    expect(sqlite.object.prepare(
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
    // The compat surface has no harness-run delete (production never deletes a
    // run through the port); clearing the fixture row goes to the normalized
    // table directly.
    sqlite.objectDatabase.prepare("DELETE FROM runs WHERE run_id = ?").run(RUN_TWO);
    // Origin is immutable through the compat surface; shape the row on the
    // normalized table directly.
    sqlite.objectDatabase.prepare(
      "UPDATE runs SET origin = 'block_dashboard_block', status = 'admitted', model = 'x-ai/grok-4.3' WHERE run_id = ?",
    ).run(RUN_ONE);
    sqlite.object.exec(`
      UPDATE workstreams SET harness_status = 'completed' WHERE id = '${WORKSTREAM_ID}';
      -- The object's own columns. The compat views that projected id,
      -- workspace_id and ISO timestamps are gone, so a fixture written in that
      -- vocabulary would be seeding the thing this slice deleted.
      INSERT INTO block_dashboard_configuration_versions
        (configuration_version_id, version_number, blocks_json, created_by_user_id, created_at)
      VALUES ('block-dashboard-runtime-version', 1,
              '[{"id":"block-runtime","prompt":"Summarize"}]', 'user-runtime', 1787000000000);
      INSERT INTO block_dashboard_block_runs
        (block_run_id, configuration_version_id, block_id, prompt,
         trigger_sequence, run_id, status, created_at)
      VALUES ('block-dashboard-runtime-run', 'block-dashboard-runtime-version', 'block-runtime', 'Summarize', 12,
              '${RUN_ONE}', 'queued', 1787000000000);
    `);

    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
      attemptId: "attempt-block-dashboard",
      owner: "owner-block-dashboard",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed HyperSight attempt");
    expect(sqlite.object.prepare(
      "SELECT harness_status FROM workstreams WHERE id = ?",
    ).get(WORKSTREAM_ID)).toEqual({ harness_status: "completed" });
    sqlite.object.prepare(
      "UPDATE block_dashboard_block_runs SET status = 'completed', markdown = '# Current view' WHERE run_id = ?",
    ).run(RUN_ONE);

    await expect(terminalizeHarnessAttempt(
      sqlite.binding,
      input(RUN_ONE),
      claim.lease,
      { status: "completed" },
      sqlite.receipts,
      sqlite.blocks,
    )).resolves.toBe("terminalized");
    expect(sqlite.object.prepare(
      "SELECT status, final_message_id FROM harness_runs WHERE id = ?",
    ).get(RUN_ONE)).toEqual({ status: "completed", final_message_id: null });
    expect(sqlite.object.prepare(
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
    expect(sqlite.object.prepare(
      `SELECT harness_attempt_id FROM messages WHERE id = 'message-recoverable'`,
    ).get()).toEqual({ harness_attempt_id: "attempt-original" });
    expect(sqlite.object.prepare(
      `SELECT COUNT(*) AS count FROM harness_run_lifecycle_events
        WHERE harness_run_id = ? AND event_key = 'final_message'`,
    ).get(RUN_ONE)).toEqual({ count: 1 });

    sqlite.object.prepare(
      "UPDATE harness_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(RUN_ONE);
    await expect(persistHarnessFinalMessage(sqlite.binding, input(RUN_ONE), original.lease, {
      id: "message-from-stale-owner",
      sequenceNumber: 2,
      text: "Must not persist",
      createdAt: "2026-08-03T00:00:01.000Z",
    }, { status: "completed" })).rejects.toThrow("durable attempt lease");
    expect(sqlite.object.prepare(
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
    }, sqlite.receipts, sqlite.blocks)).toBe("terminalized");
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
      sqlite.object.prepare(
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
    expect(sqlite.object.prepare(
      "SELECT status, terminalized_at FROM harness_runs WHERE id = ?",
    ).get(RUN_ONE)).toEqual({ status: "running", terminalized_at: null });
    expect(await loadPersistedHarnessFinalOutcome(sqlite.binding, input(RUN_ONE))).toEqual({
      messageId,
      status,
      ...(error ? { error } : {}),
    });
    const lifecycle = sqlite.object.prepare(
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
    expect(sqlite.object.prepare(
      "SELECT status, attempt_id, lease_owner FROM harness_runs WHERE id = ?",
    ).get(RUN_TWO)).toEqual({ status: "failed", attempt_id: "attempt-queued", lease_owner: null });
    expect(sqlite.object.prepare(
      "SELECT COUNT(*) AS count FROM harness_run_lifecycle_events WHERE harness_run_id = ? AND event_key = 'terminal'",
    ).get(RUN_TWO)).toEqual({ count: 1 });
    expect(sqlite.object.prepare(
      "SELECT harness_status FROM workstreams WHERE id = ?",
    ).get(WORKSTREAM_ID)).toEqual({ harness_status: "running" });
  });

  it("never claims a run cancelled before lease acquisition", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    sqlite.object.prepare(
      `UPDATE harness_runs
          SET status = 'scheduled', cancellation_requested_at = '2026-08-03T00:00:00.000Z'
        WHERE id = ?`,
    ).run(RUN_ONE);

    expect(await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
      attemptId: "attempt-cancelled-before-claim",
      owner: "owner-cancelled-before-claim",
    })).toEqual({ state: "cancelled" });
    expect(sqlite.object.prepare(
      "SELECT status, attempt_id, lease_owner FROM harness_runs WHERE id = ?",
    ).get(RUN_ONE)).toEqual({ status: "scheduled", attempt_id: null, lease_owner: null });

    expect(await terminalizeQueuedHarnessRun(
      sqlite.binding,
      input(RUN_ONE),
      { attemptId: "attempt-cancelled-before-claim", owner: "owner-cancelled-before-claim" },
      { code: "run_cancelled", message: "The run was stopped before it started" },
      "stopped",
    )).toBe("terminalized");
    expect(sqlite.object.prepare(
      "SELECT status, terminalized_at FROM harness_runs WHERE id = ?",
    ).get(RUN_ONE)).toMatchObject({ status: "stopped" });
  });

  it("CAS-reaps stale ownership and records append-only inference accounting", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const automationRunId = seedAutomationRun(sqlite, "stale");
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
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
    sqlite.object.prepare(
      `INSERT INTO messages
         (id, client_message_id, workspace_id, workstream_id, author_type,
          message_type, text_content, structured_content_json, sequence_number,
          harness_run_id, created_at)
       VALUES (?, ?, ?, ?, 'agent', 'tool', '', ?, 1, ?, ?)`,
    ).run(
      "invocation-stale-parent",
      "tool:invocation-stale-parent",
      WORKSPACE_ID,
      WORKSTREAM_ID,
      JSON.stringify({ invocation: {
        id: "invocation-stale-parent",
        toolName: "terminal.execute",
        status: "started",
        outputSummary: null,
        completedAt: null,
        error: null,
      } }),
      RUN_ONE,
      "2026-08-03T00:00:00.000Z",
    );
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
      "UPDATE harness_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(RUN_ONE);

    expect(await reapStaleHarnessRuns(sqlite.binding, {
      receipts: () => sqlite.receipts,
      blocks: () => sqlite.blocks,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
    })).toEqual([RUN_ONE]);
    expect(sqlite.object.prepare("SELECT status, lease_owner FROM harness_runs WHERE id = ?").get(RUN_ONE))
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
      `SELECT tool_status,
              json_extract(structured_content_json, '$.invocation.status') AS visible_status,
              json_extract(structured_content_json, '$.invocation.error.code') AS visible_error_code
         FROM parts WHERE id = ?`,
    ).get("invocation-stale-parent")).toEqual({
      tool_status: "ambiguous",
      visible_status: "ambiguous",
      visible_error_code: "ambiguous_external_write",
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
    expect(sqlite.object.prepare(
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
    // D1 enforced append-only with an `inference_attempt_immutable` trigger;
    // the object enforces it structurally — the compat view has no update arm,
    // so every UPDATE against the ledger fails.
    expect(() => sqlite.object.prepare(
      "UPDATE inference_attempts SET outcome = 'success' WHERE id = 'inference-1'",
    ).run()).toThrow(/cannot modify _runtime_inference_attempts/u);
  });

  it("repairs a terminal root whose first receipt-reaper call failed", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const automationRunId = seedAutomationRun(sqlite, "stale-receipt-retry");
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
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
      toolName: "terminal_run_command",
      inputHash: "stale-receipt-retry-input",
      input: { command: "sleep 60" },
      plan: { operation: "command.run", mode: "write", idempotency: "record_before_execute" },
      mode: "write",
    });
    sqlite.object.prepare(
      "UPDATE harness_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
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

    // BlockDashboard has receipt authority but deliberately no automation
    // database. It must leave an ordinary automation root for Substream's
    // fully-authorized sweep, both before and after terminalization.
    expect(await reapStaleHarnessRuns(sqlite.binding, {
      receipts: () => flakyReceipts,
      blocks: () => sqlite.blocks,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      automationDatabase: null,
    })).toEqual([]);
    expect(sqlite.object.prepare(
      "SELECT status FROM harness_runs WHERE id = ?",
    ).get(RUN_ONE)).toEqual({ status: "running" });
    expect(settlementCalls).toBe(0);

    expect(await reapStaleHarnessRuns(sqlite.binding, {
      receipts: () => flakyReceipts,
      blocks: () => sqlite.blocks,
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
      "SELECT status, terminalized_at FROM harness_runs WHERE id = ?",
    ).get(RUN_ONE)).toMatchObject({ status: "failed" });
    expect(sqlite.object.prepare(
      "SELECT status FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-stale-receipt-retry")).toEqual({ status: "executing" });
    expect(sqlite.object.prepare(
      `SELECT COUNT(*) AS count FROM harness_run_lifecycle_events
        WHERE harness_run_id = ? AND event_key = 'residual_receipts_settled'`,
    ).get(RUN_ONE)).toEqual({ count: 0 });
    expect(sqlite.database.prepare(
      "SELECT status FROM automation_runs WHERE id = ?",
    ).get(automationRunId)).toEqual({ status: "running" });
    expect(await reapStaleHarnessRuns(sqlite.binding, {
      receipts: () => flakyReceipts,
      blocks: () => sqlite.blocks,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      automationDatabase: null,
    })).toEqual([]);
    expect(settlementCalls).toBe(1);

    expect(await reapStaleHarnessRuns(sqlite.binding, {
      receipts: () => flakyReceipts,
      blocks: () => sqlite.blocks,
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
      `SELECT COUNT(*) AS count FROM harness_run_lifecycle_events
        WHERE harness_run_id = ? AND event_key = 'residual_receipts_settled'`,
    ).get(RUN_ONE)).toEqual({ count: 1 });
    expect(sqlite.database.prepare(
      "SELECT status, result_summary FROM automation_runs WHERE id = ?",
    ).get(automationRunId)).toEqual({
      status: "failed",
      result_summary: "The harness executor lost its durable lease",
    });
    expect(settlementCalls).toBe(2);
  });

  it("lets a BlockDashboard-only sweep reap and reconcile a stale HyperSight root", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    sqlite.objectDatabase.prepare(
      "UPDATE runs SET origin = 'block_dashboard_block' WHERE run_id = ?",
    ).run(RUN_ONE);
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
      attemptId: "attempt-stale-hypersight",
      owner: "owner-stale-hypersight",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed HyperSight attempt");
    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      invocationId: "invocation-stale-hypersight",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-stale-hypersight",
      toolName: "terminal_run_command",
      inputHash: "stale-hypersight-input",
      input: { command: "sleep 60" },
      plan: { operation: "command.run", mode: "write", idempotency: "record_before_execute" },
      mode: "write",
    });
    sqlite.object.prepare(
      "UPDATE harness_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(RUN_ONE);

    expect(await reapStaleHarnessRuns(sqlite.binding, {
      receipts: () => sqlite.receipts,
      blocks: () => sqlite.blocks,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      automationDatabase: null,
    })).toEqual([RUN_ONE]);
    expect(sqlite.object.prepare(
      "SELECT status, terminalized_at FROM harness_runs WHERE id = ?",
    ).get(RUN_ONE)).toMatchObject({ status: "failed" });
    expect(sqlite.object.prepare(
      "SELECT status, error_json FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-stale-hypersight")).toEqual({
      status: "ambiguous",
      error_json: '{"code":"ambiguous_external_write","message":"The parent run lost its durable lease while an external write was in flight"}',
    });
    expect(sqlite.object.prepare(
      `SELECT COUNT(*) AS count FROM harness_run_lifecycle_events
        WHERE harness_run_id = ? AND event_key = 'residual_receipts_settled'`,
    ).get(RUN_ONE)).toEqual({ count: 1 });
  });

  it("steps over an unsettleable terminal repair and still reaps stale work behind it", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const stopped = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
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
    await expect(terminalizeHarnessAttempt(sqlite.binding, input(RUN_ONE), stopped.lease, {
      status: "stopped",
    }, failBeforeSettlement, sqlite.blocks)).rejects.toThrow("receipt_rpc_unavailable");

    const stale = await claimHarnessAttempt(sqlite.binding, input(RUN_TWO), {
      attemptId: "attempt-behind-unsettleable-repair",
      owner: "owner-behind-unsettleable-repair",
    });
    if (stale.state !== "claimed") throw new Error("expected claimed stale attempt");
    sqlite.object.prepare(
      "UPDATE harness_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
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
    expect(await reapStaleHarnessRuns(sqlite.binding, {
      receipts: () => refusingReceipts,
      blocks: () => sqlite.blocks,
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
      "SELECT status, terminalized_at FROM harness_runs WHERE id = ?",
    ).get(RUN_TWO)).toMatchObject({ status: "failed" });
    expect(sqlite.object.prepare(
      `SELECT harness_run_id, event_key FROM harness_run_lifecycle_events
        WHERE harness_run_id = ? AND event_key = 'residual_receipts_settled'`,
    ).get(RUN_TWO)).toEqual({
      harness_run_id: RUN_TWO,
      event_key: "residual_receipts_settled",
    });
  });

  it("does not let historical receipt repair fail a later automation elicitation", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const automationRunId = seedAutomationRun(sqlite, "receipt-repair-needs-input");
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
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
      toolName: "terminal_run_command",
      inputHash: "repair-before-needs-input",
      input: { command: "sleep 60" },
      plan: { operation: "command.run", mode: "write", idempotency: "record_before_execute" },
      mode: "write",
    });
    sqlite.object.prepare(
      "UPDATE harness_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
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
    expect(await reapStaleHarnessRuns(sqlite.binding, {
      receipts: () => flakyReceipts,
      blocks: () => sqlite.blocks,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
    })).toEqual([RUN_ONE]);
    sqlite.database.prepare(
      `UPDATE automation_runs
          SET status = 'needs_input', result_summary = 'Waiting for the member'
        WHERE id = ?`,
    ).run(automationRunId);

    expect(await reapStaleHarnessRuns(sqlite.binding, {
      receipts: () => flakyReceipts,
      blocks: () => sqlite.blocks,
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
      `SELECT COUNT(*) AS count FROM harness_run_lifecycle_events
        WHERE harness_run_id = ? AND event_key = 'residual_receipts_settled'`,
    ).get(RUN_ONE)).toEqual({ count: 1 });
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
      executionPrincipal: { type: "user", userId: asUserId("00000000-0000-4000-8000-00000000000a") },
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
    expect(sqlite.object.prepare(
      "SELECT COUNT(*) AS count FROM inference_attempts WHERE harness_run_id = ?",
    ).get(RUN_ONE)).toEqual({ count: requestedModels.length });
    expect(sqlite.object.prepare(
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
      providerIdempotencyKey: "avalon:run:call-write",
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
    ).get()).toEqual({ status: "ambiguous", provider_idempotency_key: "avalon:run:call-write" });
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
    expect(await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      ...coordinates,
      invocationId: "invocation-reused-coordinate",
      toolName: "load_plugin",
      inputHash: "terminal-plugin",
      input: { pluginId: "avalon_terminal" },
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
      input: { pluginId: "avalon_terminal" },
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
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
      attemptId: "attempt-receipt-dependents",
      owner: "owner-receipt-dependents",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");

    const readPlan = {
      pluginId: "avalon:workstream",
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
    sqlite.object.prepare(
      `INSERT INTO harness_runs
       (id, workspace_id, workstream_id, origin, execution_principal_json, status,
        created_at, parent_harness_run_id, parent_tool_call_id,
        chain_root_harness_run_id, chain_depth, delegated_task_hash)
       VALUES (?, ?, ?, 'inline_child', ?, 'completed', ?, ?, ?, ?, 1, 'first-objective')`,
    ).run(
      "00000000-0000-4000-8000-0000000000c1",
      WORKSPACE_ID,
      WORKSTREAM_ID,
      JSON.stringify({ type: "user", userId: "00000000-0000-4000-8000-000000000009" }),
      new Date().toISOString(),
      RUN_ONE,
      delegation.toolCallId,
      RUN_ONE,
    );
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
      const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
        attemptId: `attempt-replan-${dependentKind}-race`,
        owner: `owner-replan-${dependentKind}-race`,
      });
      if (claim.state !== "claimed") throw new Error("expected claimed attempt");

      const toolCallId = `${RUN_ONE}:turn:1:tool:0`;
      const readPlan = {
        pluginId: "avalon:workstream",
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
          sqlite.object.prepare(
            `INSERT INTO harness_runs
             (id, workspace_id, workstream_id, origin, execution_principal_json, status,
              created_at, parent_harness_run_id, parent_tool_call_id,
              chain_root_harness_run_id, chain_depth, delegated_task_hash)
             VALUES (?, ?, ?, 'inline_child', ?, 'completed', ?, ?, ?, ?, 1, ?)`,
          ).run(
            "00000000-0000-4000-8000-0000000000c2",
            WORKSPACE_ID,
            WORKSTREAM_ID,
            JSON.stringify({ type: "user", userId: "00000000-0000-4000-8000-000000000009" }),
            new Date().toISOString(),
            RUN_ONE,
            toolCallId,
            RUN_ONE,
            "raced-objective",
          );
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
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
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
        `UPDATE harness_runs
            SET attempt_id = 'attempt-upload-successor',
                lease_owner = 'owner-upload-successor',
                lease_expires_at = '2099-01-01T00:00:00.000Z'
          WHERE id = ?`,
      ).run(RUN_ONE);
    };

    await expect(__integrationTesting.persistSuccessfulToolResult(env, input(RUN_ONE), claim.lease, {
      invocationId: "invocation-upload-race",
      toolCallId: "call/upload race",
      output: { issue: { id: "AVA-3", title: "Immutable result" } },
      outputSummary: "Issue AVA-3",
    }, stealLeaseAfterUpload, sqlite.receipts)).rejects.toMatchObject({ code: "run_ownership_lost" });
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
    })).rejects.toMatchObject({ code: "run_ownership_lost" });
    expect(uploaded).toBe(false);
  });

  it("persists a returned tool result after a member stop while the attempt still owns settlement", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
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
      `UPDATE harness_runs
          SET cancellation_requested_at = '2026-08-03T00:00:00.000Z',
              cancellation_reason = 'member_stop'
        WHERE id = ?`,
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
    }, sqlite.receipts)).resolves.toContain("/tool-results/");
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
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
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
      toolName: "workstream_read_resource",
      inputHash: "stale-attachment-input",
      input: { resourceId: "00000000-0000-4000-8000-000000000099" },
      plan: { operation: "resource.read", mode: "read", idempotency: "safe" },
      mode: "read",
    });
    sqlite.object.prepare(
      `UPDATE harness_runs
          SET attempt_id = 'attempt-stale-attachment-successor',
              lease_owner = 'owner-stale-attachment-successor',
              lease_expires_at = '2099-01-01T00:00:00.000Z'
        WHERE id = ?`,
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
    )).rejects.toMatchObject({ code: "run_ownership_lost" });
    expect(uploaded).toBe(false);
    expect(sqlite.object.prepare(
      "SELECT COUNT(*) AS count FROM attachment_tool_receipts WHERE tool_invocation_id = ?",
    ).get("invocation-stale-attachment")).toEqual({ count: 0 });
  });

  it("refuses every failure and ambiguity fence, leaving the receipt untouched", async () => {
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
        mutate: () => sqlite.object.prepare(
          "UPDATE harness_runs SET attempt_id = 'attempt-other' WHERE id = ?",
        ).run(RUN_ONE),
        code: "run_ownership_lost",
      },
      {
        name: "owner",
        mutate: () => sqlite.object.prepare(
          "UPDATE harness_runs SET lease_owner = 'owner-other' WHERE id = ?",
        ).run(RUN_ONE),
        code: "run_ownership_lost",
      },
      {
        name: "state",
        mutate: () => sqlite.object.prepare(
          "UPDATE harness_runs SET status = 'needs_input' WHERE id = ?",
        ).run(RUN_ONE),
        code: "run_ownership_lost",
      },
      {
        name: "cancellation",
        mutate: () => sqlite.object.prepare(
          "UPDATE harness_runs SET cancellation_requested_at = '2026-08-03T00:00:00.000Z' WHERE id = ?",
        ).run(RUN_ONE),
        code: "run_cancelled",
      },
      {
        name: "db-time-expiry",
        mutate: () => sqlite.object.prepare(
          "UPDATE harness_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
        ).run(RUN_ONE),
        code: "run_ownership_lost",
      },
    ];

    for (const status of ["failed", "ambiguous"] as const) {
      for (const fence of fenceCases) {
        sqlite.object.prepare(
          `UPDATE harness_runs
              SET attempt_id = ?, lease_owner = ?, status = 'running',
                  cancellation_requested_at = NULL, terminalized_at = NULL,
                  lease_expires_at = '2099-01-01T00:00:00.000Z'
            WHERE id = ?`,
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
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
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
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
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
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
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
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
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
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
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
      toolName: "terminal_run_command",
      inputHash: "cancelled-write-input",
      input: { command: "sleep 60" },
      plan: {
        pluginId: "avalon:terminal",
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
      `UPDATE harness_runs
          SET cancellation_requested_at = '2026-08-03T00:00:00.000Z',
              cancellation_reason = 'member_stop'
        WHERE id IN (?, ?)`,
    ).run(RUN_ONE, RUN_TWO);

    await expect(heartbeatHarnessAttempt(sqlite.binding, RUN_ONE, claim.lease))
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
    expect(await terminalizeHarnessAttempt(sqlite.binding, input(RUN_ONE), claim.lease, {
      status: "stopped",
      error: { code: "run_cancelled", message: "The member stopped this run" },
      memberSafePayload: { code: "run_cancelled" },
    }, sqlite.receipts, sqlite.blocks)).toBe("terminalized");

    expect(sqlite.object.prepare(
      `SELECT status, cancellation_requested_at, terminalized_at, lease_owner
         FROM harness_runs WHERE id = ?`,
    ).get(RUN_ONE)).toMatchObject({
      status: "stopped",
      cancellation_requested_at: "2026-08-03T00:00:00.000Z",
      lease_owner: null,
    });
    expect(sqlite.object.prepare(
      "SELECT harness_status FROM workstreams WHERE id = ?",
    ).get(WORKSTREAM_ID)).toEqual({ harness_status: "idle" });
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
      "SELECT status, member_safe_payload_json FROM harness_run_lifecycle_events WHERE harness_run_id = ? AND event_key = 'terminal'",
    ).get(RUN_ONE)).toEqual({
      status: "stopped",
      member_safe_payload_json: '{"code":"run_cancelled"}',
    });
  });

  it("settles inherited receipts before a successor stops an expired run", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const expired = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
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
      toolName: "terminal_run_command",
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
      "UPDATE harness_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(RUN_ONE);
    const successor = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
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
    await expect(terminalizeHarnessAttempt(sqlite.binding, input(RUN_ONE), successor.lease, {
      status: "stopped",
      error: { code: "run_cancelled", message: "The member stopped this run" },
      memberSafePayload: { code: "run_cancelled" },
    }, sqlite.receipts, sqlite.blocks)).resolves.toBe("terminalized");
    expect(sqlite.object.prepare(
      "SELECT status, terminalized_at FROM harness_runs WHERE id = ?",
    ).get(RUN_ONE)).toMatchObject({ status: "stopped" });
    expect(sqlite.object.prepare(
      "SELECT COUNT(*) AS count FROM harness_run_lifecycle_events WHERE harness_run_id = ? AND event_key = 'terminal'",
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
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
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
      sqlite.binding,
      input(RUN_ONE),
      claim.lease,
      outcome,
      flakyReceipts,
      sqlite.blocks,
    )).rejects.toThrow("lost_receipt_rpc_response");
    expect(sqlite.object.prepare(
      "SELECT status, terminalized_at FROM harness_runs WHERE id = ?",
    ).get(RUN_ONE)).toMatchObject({ status: "stopped" });
    expect(sqlite.object.prepare(
      "SELECT status FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-stopped-receipt-retry")).toEqual({ status: "failed" });
    expect(sqlite.object.prepare(
      `SELECT COUNT(*) AS count FROM harness_run_lifecycle_events
        WHERE harness_run_id = ? AND event_key = 'residual_receipts_settled'`,
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
      sqlite.binding,
      input(RUN_ONE),
      claim.lease,
      outcome,
      flakyReceipts,
      sqlite.blocks,
    )).resolves.toBe("already_terminal");
    expect(sqlite.object.prepare(
      "SELECT status, error_json FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-stopped-receipt-retry")).toEqual({
      status: "failed",
      error_json: '{"code":"run_cancelled","message":"The run stopped before the tool produced a result"}',
    });
    expect(sqlite.object.prepare(
      `SELECT COUNT(*) AS count FROM harness_run_lifecycle_events
        WHERE harness_run_id = ? AND event_key = 'residual_receipts_settled'`,
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
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
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
      plan: { operation: "avalon.plugins.load", mode: "read", idempotency: "safe" },
      mode: "read",
    });
    seedPendingToolCard(sqlite, "invocation-direct-failure", "load_plugin");
    expect(sqlite.object.prepare(
      "SELECT tool_status FROM parts WHERE id = ?",
    ).get("invocation-direct-failure")).toEqual({ tool_status: "pending" });

    // The run dies between `tool_started` and the guard that reports
    // `tool_failed` — a required host port throwing, an evicted executor — so
    // the receipt is never settled by the tool's own path.
    expect(await terminalizeHarnessAttempt(sqlite.binding, input(RUN_ONE), claim.lease, {
      status: "failed",
      error: { code: "tool_receipt_persistence_failed", message: "A required host persistence port failed" },
      memberSafePayload: { code: "tool_receipt_persistence_failed" },
    }, sqlite.receipts)).toBe("terminalized");

    expect(sqlite.object.prepare(
      "SELECT status, error_json FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-direct-failure")).toEqual({
      status: "failed",
      // Not the reaper's "lost its durable lease": this run wrote its own
      // terminal row, so nothing here observed a lease being lost.
      error_json: '{"code":"run_terminated","message":"The run ended before the tool produced a result"}',
    });
    expect(sqlite.object.prepare(
      "SELECT tool_status FROM parts WHERE id = ?",
    ).get("invocation-direct-failure")).toEqual({ tool_status: "failed" });
    expect(sqlite.object.prepare(
      `SELECT COUNT(*) AS count FROM harness_run_lifecycle_events
        WHERE harness_run_id = ? AND event_key = 'residual_receipts_settled'`,
    ).get(RUN_ONE)).toEqual({ count: 1 });
  });

  it("closes the tool card of a run that answered while a receipt stayed open", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
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
      plan: { operation: "avalon.plugins.load", mode: "read", idempotency: "safe" },
      mode: "read",
    });
    seedPendingToolCard(sqlite, "invocation-completed-residual", "load_plugin");
    await persistHarnessFinalMessage(sqlite.binding, input(RUN_ONE), claim.lease, {
      id: "message-completed-residual",
      sequenceNumber: 1,
      text: "Here is what those teams use",
      createdAt: "2026-08-03T00:00:00.000Z",
    }, { status: "completed" });

    // The worst case of the two: Bind synthesizes a tool error for the call
    // whose terminal event never reached the host, the model answers anyway,
    // and the run reaches `completed` with the card still spinning.
    expect(await terminalizeHarnessAttempt(sqlite.binding, input(RUN_ONE), claim.lease, {
      status: "completed",
      finalMessageId: "message-completed-residual",
    }, sqlite.receipts)).toBe("terminalized");

    expect(sqlite.object.prepare(
      "SELECT status FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-completed-residual")).toEqual({ status: "failed" });
    expect(sqlite.object.prepare(
      "SELECT tool_status FROM parts WHERE id = ?",
    ).get("invocation-completed-residual")).toEqual({ tool_status: "failed" });
    expect(sqlite.object.prepare(
      `SELECT COUNT(*) AS count FROM harness_run_lifecycle_events
        WHERE harness_run_id = ? AND event_key = 'residual_receipts_settled'`,
    ).get(RUN_ONE)).toEqual({ count: 1 });
  });

  it("repairs a directly-failed root that lost its settlement response, sparing a live automation run", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const automationRunId = seedAutomationRun(sqlite, "direct-failure-repair");
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
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
      plan: { operation: "avalon.plugins.load", mode: "read", idempotency: "safe" },
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

    await expect(terminalizeHarnessAttempt(sqlite.binding, input(RUN_ONE), claim.lease, {
      status: "failed",
      error: { code: "harness_execution_failed", message: "The Avalon harness could not complete this run" },
      memberSafePayload: { code: "harness_execution_failed" },
    }, flakyReceipts)).rejects.toThrow("lost_receipt_rpc_response");
    expect(sqlite.object.prepare(
      "SELECT status FROM harness_runs WHERE id = ?",
    ).get(RUN_ONE)).toEqual({ status: "failed" });
    expect(sqlite.object.prepare(
      "SELECT tool_status FROM parts WHERE id = ?",
    ).get("invocation-direct-failure-repair")).toEqual({ tool_status: "pending" });

    // The dispatch does not retry a run whose terminal row already landed, so
    // the bounded sweep on the next dispatch is the only thing left that can
    // close this card.
    expect(await reapStaleHarnessRuns(sqlite.binding, {
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
      "SELECT tool_status FROM parts WHERE id = ?",
    ).get("invocation-direct-failure-repair")).toEqual({ tool_status: "failed" });
    expect(sqlite.object.prepare(
      `SELECT COUNT(*) AS count FROM harness_run_lifecycle_events
        WHERE harness_run_id = ? AND event_key = 'residual_receipts_settled'`,
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
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
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
      plan: { operation: "avalon.plugins.load", mode: "read", idempotency: "safe" },
      mode: "read",
    });
    seedPendingToolCard(sqlite, "invocation-needs-input-residual", "load_plugin");

    // The fourth terminal status, and the one whose safety the change argues
    // rather than demonstrates elsewhere: an elicitation returns a normal result
    // carrying `halt`, so its own receipt settles before the run suspends and a
    // receipt still open here belongs to some earlier call. Settling it is
    // therefore right, and a continuation gets a fresh run id, so nothing is
    // closed out from under a run that will resume.
    expect(await terminalizeHarnessAttempt(sqlite.binding, input(RUN_ONE), claim.lease, {
      status: "needs_input",
      memberSafePayload: {},
    }, sqlite.receipts)).toBe("terminalized");

    expect(sqlite.object.prepare(
      "SELECT status, error_json FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-needs-input-residual")).toEqual({
      status: "failed",
      error_json: '{"code":"run_terminated","message":"The run ended before the tool produced a result"}',
    });
    expect(sqlite.object.prepare(
      "SELECT tool_status FROM parts WHERE id = ?",
    ).get("invocation-needs-input-residual")).toEqual({ tool_status: "failed" });
    expect(sqlite.object.prepare(
      `SELECT COUNT(*) AS count FROM harness_run_lifecycle_events
        WHERE harness_run_id = ? AND event_key = 'residual_receipts_settled'`,
    ).get(RUN_ONE)).toEqual({ count: 1 });
    // Settling the receipt does not relabel the run itself: it is still waiting
    // on a person, not failed. (Asserted on the run rather than the work stream,
    // whose status is held back here by the fixture's second scheduled run --
    // an interaction this change has nothing to do with.)
    expect(sqlite.object.prepare(
      "SELECT status FROM harness_runs WHERE id = ?",
    ).get(RUN_ONE)).toEqual({ status: "needs_input" });
  });

  it("repairs a marker backfill without delaying the stale-lease reap behind it", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    // An ordinary completed run carrying no settlement marker — the shape every
    // row terminalized before settlement became universal has, and which the
    // repair walk now enrols. Terminalized by hand, so no marker is recorded.
    const backfill = await claimHarnessAttempt(sqlite.binding, input(RUN_TWO), {
      attemptId: "attempt-marker-backfill",
      owner: "owner-marker-backfill",
    });
    if (backfill.state !== "claimed") throw new Error("expected claimed attempt");
    sqlite.object.prepare(
      `UPDATE harness_runs
          SET status = 'completed', completed_at = '2026-08-01T00:00:00.000Z',
              terminalized_at = '2026-08-01T00:00:00.000Z',
              lease_owner = NULL, lease_expires_at = NULL
        WHERE id = ?`,
    ).run(RUN_TWO);

    // An executor that died without terminalizing at all. Its expired lease is
    // the only signal it leaves, and this reap is the only thing that will ever
    // close its card.
    const stale = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
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
      plan: { operation: "avalon.plugins.load", mode: "read", idempotency: "safe" },
      mode: "read",
    });
    seedPendingToolCard(sqlite, "invocation-stale-behind-backfill", "load_plugin");
    sqlite.object.prepare(
      "UPDATE harness_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(RUN_ONE);

    // One slot per pass. The backfill row fills the repair page; sharing a
    // budget would return here having reaped nothing.
    expect(await reapStaleHarnessRuns(sqlite.binding, {
      receipts: () => sqlite.receipts,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      limit: 1,
    })).toEqual([RUN_ONE]);
    expect(sqlite.object.prepare(
      "SELECT tool_status FROM parts WHERE id = ?",
    ).get("invocation-stale-behind-backfill")).toEqual({ tool_status: "failed" });
    // Both halves of the activation did their work, not one at the other's cost.
    expect(sqlite.object.prepare(
      `SELECT COUNT(*) AS count FROM harness_run_lifecycle_events
        WHERE harness_run_id = ? AND event_key = 'residual_receipts_settled'`,
    ).get(RUN_TWO)).toEqual({ count: 1 });
  });

  it("finishes a reaped root's lost settlement with the reaper's wording, not its own", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
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
      plan: { operation: "avalon.plugins.load", mode: "read", idempotency: "safe" },
      mode: "read",
    });
    sqlite.object.prepare(
      "UPDATE harness_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(RUN_ONE);

    // The reaper terminalizes the lapsed root but loses its settlement response,
    // so the row is terminal, unmarked, and its receipt still open.
    const losingReceipts = {
      ...sqlite.receipts,
      settleResidualReceipts: async () => { throw new Error("lost_receipt_rpc_response"); },
    } satisfies typeof sqlite.receipts;
    expect(await reapStaleHarnessRuns(sqlite.binding, {
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
    expect(await terminalizeHarnessAttempt(sqlite.binding, input(RUN_ONE), claim.lease, {
      status: "failed",
      error: { code: "harness_execution_failed", message: "The Avalon harness could not complete this run" },
      memberSafePayload: { code: "harness_execution_failed" },
    }, sqlite.receipts)).toBe("already_terminal");
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
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
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
        toolName: mode === "write" ? "terminal_run_command" : "linear_issue_get",
        inputHash: `residual-input-${index}`,
        input: { index },
        plan: { operation: `residual.${index}`, mode, idempotency: "record_before_execute" },
        mode,
      });
    }

    await expect(terminalizeHarnessAttempt(sqlite.binding, input(RUN_ONE), claim.lease, {
      status: "stopped",
      error: { code: "run_cancelled", message: "The run was steered" },
      memberSafePayload: { code: "run_cancelled" },
    }, sqlite.receipts, sqlite.blocks)).resolves.toBe("terminalized");

    expect(sqlite.object.prepare(
      `SELECT status, COUNT(*) AS count FROM tool_effects
        WHERE run_id = ? GROUP BY status ORDER BY status`,
    ).all(RUN_ONE)).toEqual([
      { status: "ambiguous", count: 30 },
      { status: "failed", count: 30 },
    ]);
    // Terminalization is four statements regardless of receipt count. The
    // object settles all receipts in one transaction of its own, then the
    // single-statement lifecycle marker makes that acknowledgment retryable.
    expect(sqlite.statementBatchSizes.slice(-2)).toEqual([4, 1]);
  });

  it("leaves a stopped run's receipts alone when its terminalization loses the lease", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
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
      toolName: "terminal_run_command",
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
    await expect(terminalizeHarnessAttempt(sqlite.binding, input(RUN_ONE), claim.lease, {
      status: "stopped",
      error: { code: "run_cancelled", message: "The member stopped this run" },
      memberSafePayload: { code: "run_cancelled" },
    }, sqlite.receipts, sqlite.blocks)).rejects.toThrow("durable attempt lease");
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
      "SELECT status, terminalized_at, lease_owner FROM harness_runs WHERE id = ?",
    ).get(RUN_ONE)).toEqual({
      status: "running",
      terminalized_at: null,
      lease_owner: claim.lease.owner,
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
    await persistToolExecutionPlan(sqlite.receipts, claim.lease, {
      invocationId: "invocation-obsolete-stop",
      harnessRunId: RUN_ONE,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-obsolete-stop",
      toolName: "terminal_run_command",
      inputHash: "obsolete-stop-input",
      input: { command: "sleep 60" },
      plan: { operation: "command.run", mode: "write", idempotency: "record_before_execute" },
      mode: "write",
    });

    sqlite.object.prepare(
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
      status: "stopped",
      error: { code: "obsolete", message: "An obsolete executor cannot terminalize" },
    }, sqlite.receipts, sqlite.blocks)).rejects.toMatchObject({ code: "run_ownership_lost" });

    expect(sqlite.object.prepare(
      "SELECT status, attempt_id, lease_owner, terminalized_at FROM harness_runs WHERE id = ?",
    ).get(RUN_ONE)).toEqual({
      status: "running",
      attempt_id: "attempt-successor",
      lease_owner: "owner-successor",
      terminalized_at: null,
    });
    expect(sqlite.object.prepare(
      "SELECT COUNT(*) AS count FROM harness_run_lifecycle_events WHERE harness_run_id = ? AND event_key = 'terminal'",
    ).get(RUN_ONE)).toEqual({ count: 0 });
    expect(sqlite.object.prepare(
      "SELECT status, checkpoint_index FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-obsolete-stop")).toEqual({ status: "executing", checkpoint_index: 0 });
    expect(sqlite.object.prepare(
      "SELECT COUNT(*) AS count FROM tool_effect_checkpoints WHERE effect_intent_id = ?",
    ).get("invocation-obsolete-stop")).toEqual({ count: 1 });
  });

  it("does not reap a stale-row snapshot whose lease is renewed before the CAS batch", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
      attemptId: "attempt-racing-reaper",
      owner: "owner-racing-reaper",
    });
    if (claim.state !== "claimed") throw new Error("expected claimed attempt");
    sqlite.object.prepare(
      "UPDATE harness_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(RUN_ONE);

    let intercepted = false;
    const racingBinding = createTestD1Database({
      prepare: sqlite.binding.prepare.bind(sqlite.binding),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!intercepted) {
          intercepted = true;
          sqlite.object.prepare(
            "UPDATE harness_runs SET heartbeat_at = '2026-08-03T00:00:00.000Z', lease_expires_at = '2099-01-01T00:00:00.000Z' WHERE id = ?",
          ).run(RUN_ONE);
        }
        return sqlite.binding.batch(statements);
      },
    });

    expect(await reapStaleHarnessRuns(racingBinding, {
      receipts: () => sqlite.receipts,
      blocks: () => sqlite.blocks,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
    })).toEqual([]);
    expect(intercepted).toBe(true);
    expect(sqlite.object.prepare(
      "SELECT status, attempt_id, lease_owner, lease_expires_at, terminalized_at FROM harness_runs WHERE id = ?",
    ).get(RUN_ONE)).toEqual({
      status: "running",
      attempt_id: "attempt-racing-reaper",
      lease_owner: "owner-racing-reaper",
      lease_expires_at: "2099-01-01T00:00:00.000Z",
      terminalized_at: null,
    });
    expect(sqlite.object.prepare(
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
    }, sqlite.receipts, sqlite.blocks)).rejects.toThrow("final_message_required");
    sqlite.object.prepare(
      `INSERT INTO messages
       (id, client_message_id, workspace_id, workstream_id, author_type, author_user_id,
        message_type, text_content, sequence_number, created_at)
       VALUES ('human-final', 'human-final', ?, ?, 'human', 'user-runtime', 'text', 'Not an agent result', 1, '2026-08-03')`,
    ).run(WORKSPACE_ID, WORKSTREAM_ID);
    await expect(terminalizeHarnessAttempt(sqlite.binding, input(RUN_ONE), claim.lease, {
      status: "completed",
      finalMessageId: "human-final",
    }, sqlite.receipts, sqlite.blocks)).rejects.toThrow("final_message_not_persisted");
    expect(sqlite.object.prepare(
      "SELECT terminalized_at FROM harness_runs WHERE id = ?",
    ).get(RUN_ONE)).toEqual({ terminalized_at: null });
    expect(sqlite.object.prepare(
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
    }, sqlite.receipts, sqlite.blocks)).resolves.toBe("terminalized");

    expect(sqlite.object.prepare(
      `SELECT text_content, harness_run_id, harness_attempt_id
         FROM messages WHERE id = 'message-realtime-outage'`,
    ).get()).toEqual({
      text_content: "Durable despite the realtime outage",
      harness_run_id: RUN_ONE,
      harness_attempt_id: "attempt-realtime-outage",
    });
    expect(sqlite.object.prepare(
      "SELECT status, final_message_id, terminalized_at FROM harness_runs WHERE id = ?",
    ).get(RUN_ONE)).toMatchObject({
      status: "completed",
      final_message_id: "message-realtime-outage",
    });
    expect(sqlite.object.prepare(
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

    expect(sqlite.object.prepare(
      "SELECT eligible_connection_ids_json, eligible_capabilities_json, memory_context_hash FROM harness_run_scopes WHERE harness_run_id = ?",
    ).get(RUN_ONE)).toEqual({
      eligible_connection_ids_json: '["connection-a","connection-b"]',
      eligible_capabilities_json: '["issues.read","issues.write"]',
      memory_context_hash: "memory-context-v1",
    });
    expect(sqlite.object.prepare(
      "SELECT COUNT(*) AS count FROM harness_run_plugin_activations WHERE harness_run_id = ? AND plugin_id = ?",
    ).get(RUN_ONE, plugin.pluginId)).toEqual({ count: 1 });
  });
});

describe("inline child-run durability", () => {
  it("keeps ordinary elicitation continuations in the normal queue", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const continuationId = asHarnessRunId("00000000-0000-4000-8000-000000000005");
    sqlite.object.prepare(
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
    expect(sqlite.object.prepare(
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
      sqlite.receipts,
      sqlite.blocks,
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
        childHarnessRunId: asHarnessRunId("00000000-0000-4000-8000-000000000101"),
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
    expect(sqlite.object.prepare(
      `SELECT eligible_connection_ids_json, eligible_capabilities_json,
              eligible_connection_capabilities_json, trigger_policy_json
         FROM harness_run_scopes WHERE harness_run_id = ?`,
    ).get(admitted.childInput.harnessRunId)).toEqual({
      eligible_connection_ids_json: '["connection-read"]',
      eligible_capabilities_json: '["documents.read"]',
      eligible_connection_capabilities_json: '{"connection-read":["documents.read"]}',
      trigger_policy_json: '{"kind":"sub_agent","readOnly":true}',
    });
    expect(sqlite.object.prepare(
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
      childHarnessRunId: asHarnessRunId("00000000-0000-4000-8000-000000000102"),
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
      attemptId: "another-attempt",
      owner: "another-owner",
    })).toMatchObject({ state: "busy", childInput: first.childInput });
    // The parent tool call is the replay key even when a retried executor
    // mints a FRESH child id: `runs_parent_tool_call_uq` (object schema v7)
    // turns that insert into the zero-change result that routes admission to
    // the existing child, exactly as D1's `harness_runs_parent_tool_call_idx`
    // did. Before v7 this admission inserted a second child through the port.
    expect(await admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, {
      ...options,
      childHarnessRunId: asHarnessRunId("00000000-0000-4000-8000-000000000112"),
      attemptId: "fresh-id-attempt",
      owner: "fresh-id-owner",
    })).toMatchObject({ state: "busy", childInput: first.childInput });
    expect(sqlite.object.prepare(
      `SELECT COUNT(*) AS n FROM harness_runs
        WHERE parent_harness_run_id = ? AND parent_tool_call_id = ?`,
    ).get(RUN_ONE, options.parentToolCallId)).toEqual({ n: 1 });

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
      attemptId: "attempt-after-completion",
      owner: "owner-after-completion",
    })).toEqual({ state: "replay", childInput: first.childInput, outcome });
    // A terminal child's settled result replays even to an executor that
    // minted a fresh child id: the v7 unique index parks the insert on the
    // existing receipt, whose terminal row carries the verified outcome.
    // Before v7 this admission started a second, competing child.
    expect(await admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, {
      ...options,
      childHarnessRunId: asHarnessRunId("00000000-0000-4000-8000-000000000113"),
      attemptId: "fresh-id-after-completion",
      owner: "fresh-id-owner-after-completion",
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
      childHarnessRunId: asHarnessRunId("00000000-0000-4000-8000-000000000103"),
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
    sqlite.object.prepare(
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
      childHarnessRunId: asHarnessRunId("00000000-0000-4000-8000-000000000104"),
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
    sqlite.object.prepare(
      "UPDATE harness_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(first.childInput.harnessRunId);

    expect(await admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, {
      parentToolCallId: "tool-live-capacity-holder",
      objective: "Occupy the only workspace child slot",
      childHarnessRunId: asHarnessRunId("00000000-0000-4000-8000-000000000105"),
      attemptId: "attempt-live-capacity-holder",
      owner: "owner-live-capacity-holder",
      maxActiveWorkspaceChildren: 1,
      maxChainRuns: 64,
    })).toMatchObject({ state: "claimed" });

    expect(await admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, {
      ...firstOptions,
      owner: "owner-reclaim-blocked-by-capacity",
    })).toEqual({ state: "refused", reason: "workspace_child_capacity" });
    expect(sqlite.object.prepare(
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
        childHarnessRunId: asHarnessRunId("00000000-0000-4000-8000-000000000106"),
        attemptId: "attempt-parallel-one",
        owner: "owner-parallel-one",
        maxChainRuns: 64,
        maxActiveWorkspaceChildren: 2,
      }),
      admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, {
        parentToolCallId: "tool-parallel-two",
        objective: "Investigate source two",
        childHarnessRunId: asHarnessRunId("00000000-0000-4000-8000-000000000107"),
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
    expect(sqlite.object.prepare(
      `SELECT COUNT(*) AS count FROM harness_runs
        WHERE parent_harness_run_id = ? AND status = 'running'`,
    ).get(RUN_ONE)).toEqual({ count: 2 });

    expect(await admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, {
      parentToolCallId: "tool-parallel-overflow",
      objective: "Investigate source three",
      childHarnessRunId: asHarnessRunId("00000000-0000-4000-8000-000000000108"),
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
      childHarnessRunId: asHarnessRunId("00000000-0000-4000-8000-000000000109"),
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
      childHarnessRunId: asHarnessRunId("00000000-0000-4000-8000-00000000010a"),
      attemptId: "attempt-chain-one",
      owner: "owner-chain-one",
      maxChainRuns: 2,
      maxActiveWorkspaceChildren: 64,
    })).toMatchObject({ state: "claimed" });
    expect(await admitInlineChildAttempt(chainSqlite.binding, input(RUN_ONE), chainParentLease, {
      parentToolCallId: "tool-chain-overflow",
      objective: "Exceed the chain budget",
      childHarnessRunId: asHarnessRunId("00000000-0000-4000-8000-00000000010b"),
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
      childHarnessRunId: asHarnessRunId("00000000-0000-4000-8000-00000000010c"),
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
      childHarnessRunId: asHarnessRunId("00000000-0000-4000-8000-00000000010d"),
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
      childHarnessRunId: asHarnessRunId("00000000-0000-4000-8000-00000000010e"),
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
      childHarnessRunId: asHarnessRunId("00000000-0000-4000-8000-00000000010f"),
      attemptId: "attempt-parent-lease-loss",
      owner: "owner-parent-lease-loss",
    });
    if (child.state !== "claimed") throw new Error("expected claimed child");
    sqlite.object.prepare(
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
    expect(sqlite.object.prepare(
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
      childHarnessRunId: asHarnessRunId("00000000-0000-4000-8000-000000000110"),
      attemptId: "attempt-child-stale-live-parent",
      owner: "owner-child-stale-live-parent",
    };
    const child = await admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, options);
    if (child.state !== "claimed") throw new Error("expected claimed child");
    sqlite.object.prepare(
      "UPDATE harness_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(child.childInput.harnessRunId);

    expect(await reapStaleHarnessRuns(sqlite.binding, {
      receipts: () => sqlite.receipts,
      blocks: () => sqlite.blocks,
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
      childHarnessRunId: asHarnessRunId("00000000-0000-4000-8000-000000000111"),
      attemptId: "attempt-child-stale",
      owner: "owner-child-stale",
    });
    if (child.state !== "claimed") throw new Error("expected claimed child");
    await persistToolExecutionPlan(sqlite.receipts, child.lease, {
      invocationId: "invocation-stale-child-write",
      harnessRunId: child.childInput.harnessRunId,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-stale-child-write",
      toolName: "terminal_run_command",
      inputHash: "stale-child-write-input",
      input: { command: "sleep 60" },
      plan: { operation: "command.run", mode: "write", idempotency: "record_before_execute" },
      mode: "write",
    });
    await persistToolExecutionPlan(sqlite.receipts, child.lease, {
      invocationId: "invocation-stale-child-read",
      harnessRunId: child.childInput.harnessRunId,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-stale-child-read",
      toolName: "linear_issue_get",
      inputHash: "stale-child-read-input",
      input: { issueId: "AVA-1" },
      plan: { operation: "issue.get", mode: "read", idempotency: "safe" },
      mode: "read",
    });
    sqlite.object.prepare(
      `INSERT INTO tool_effect_checkpoints
         (checkpoint_id, effect_intent_id, run_id, attempt_id, checkpoint_index,
          phase, member_safe_payload_json, created_at)
       VALUES (?, ?, ?, ?, 1, 'result_persisted', '{}', 1787000000000)`,
    ).run(
      "checkpoint-orphan-before-child-reap",
      "invocation-stale-child-write",
      child.childInput.harnessRunId,
      child.lease.attemptId,
    );
    sqlite.object.prepare(
      "UPDATE harness_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(child.childInput.harnessRunId);
    sqlite.object.prepare(
      `UPDATE harness_runs
          SET status = 'completed', completed_at = '2026-08-03T00:00:00.000Z',
              terminalized_at = '2026-08-03T00:00:00.000Z',
              lease_owner = NULL, lease_expires_at = NULL
        WHERE id = ?`,
    ).run(RUN_ONE);

    expect(await reapStaleHarnessRuns(sqlite.binding, {
      receipts: () => sqlite.receipts,
      blocks: () => sqlite.blocks,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
    })).toEqual([child.childInput.harnessRunId]);
    expect(sqlite.object.prepare(
      "SELECT harness_status FROM workstreams WHERE id = ?",
    ).get(WORKSTREAM_ID)).toEqual({ harness_status: "running" });
    expect(sqlite.database.prepare(
      "SELECT status, completed_at, result_summary FROM automation_runs WHERE id = 'automation-run-child'",
    ).get()).toEqual({ status: "running", completed_at: null, result_summary: null });
    expect(sqlite.object.prepare(
      `SELECT effect_intent_id, status, error_json FROM tool_effects
        WHERE run_id = ? ORDER BY effect_intent_id`,
    ).all(child.childInput.harnessRunId)).toEqual([
      {
        effect_intent_id: "invocation-stale-child-read",
        status: "failed",
        error_json: '{"code":"parent_run_unavailable","message":"The parent run no longer owns a live attempt"}',
      },
      {
        effect_intent_id: "invocation-stale-child-write",
        status: "ambiguous",
        error_json: '{"code":"ambiguous_external_write","message":"The child run ended while an external write was unresolved"}',
      },
    ]);
    expect(sqlite.object.prepare(
      `SELECT effect_intent_id, phase FROM tool_effect_checkpoints
        WHERE run_id = ? AND phase IN ('cancelled', 'failed', 'ambiguous_external_write')
        ORDER BY effect_intent_id`,
    ).all(child.childInput.harnessRunId)).toEqual([
      { effect_intent_id: "invocation-stale-child-read", phase: "failed" },
      { effect_intent_id: "invocation-stale-child-write", phase: "ambiguous_external_write" },
    ]);
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
    const persisted = sqlite.object.prepare(
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

    sqlite.object.prepare(
      `UPDATE harness_runs
          SET child_result_json = '{"status":"failed","error":{"code":"tampered","message":"tampered"}}'
        WHERE id = ?`,
    ).run(child.childInput.harnessRunId);
    await expect(loadInlineChildResult(sqlite.binding, RUN_ONE, "tool-stale-child"))
      .rejects.toThrow("inline_child_result_hash_mismatch");
  });

  it("repairs a terminal child whose first receipt settlement failed", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const parentLease = await claimScopedParent(sqlite);
    const child = await admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, {
      parentToolCallId: "tool-child-receipt-retry",
      objective: "Retry receipt settlement after terminalization",
      childHarnessRunId: asHarnessRunId("00000000-0000-4000-8000-000000000114"),
      attemptId: "attempt-child-receipt-retry",
      owner: "owner-child-receipt-retry",
    });
    if (child.state !== "claimed") throw new Error("expected claimed child");
    await persistToolExecutionPlan(sqlite.receipts, child.lease, {
      invocationId: "invocation-child-receipt-retry",
      harnessRunId: child.childInput.harnessRunId,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-child-receipt-retry",
      toolName: "terminal_run_command",
      inputHash: "child-receipt-retry-input",
      input: { command: "sleep 60" },
      plan: { operation: "command.run", mode: "write", idempotency: "record_before_execute" },
      mode: "write",
    });
    sqlite.object.prepare(
      "UPDATE harness_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(child.childInput.harnessRunId);
    sqlite.object.prepare(
      `UPDATE harness_runs
          SET status = 'completed', completed_at = '2026-08-03T00:00:00.000Z',
              terminalized_at = '2026-08-03T00:00:00.000Z',
              lease_owner = NULL, lease_expires_at = NULL
        WHERE id = ?`,
    ).run(RUN_ONE);
    // The parent is scaffolding here, and terminalizing it by hand skips the
    // settlement its own terminal path performs — which the repair walk would
    // otherwise, correctly, spend this test's one flaky call on. Record what
    // that path would have recorded so the child stays the subject.
    sqlite.object.prepare(
      `INSERT INTO harness_run_lifecycle_events
        (id, harness_run_id, workspace_id, workstream_id, attempt_id, event_key,
         event_type, status, member_safe_payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, 'residual_receipts_settled', 'receipt_reconciliation',
               'completed', '{}', '2026-08-03T00:00:00.000Z')`,
    ).run(
      "lifecycle-parent-receipts-settled",
      RUN_ONE,
      WORKSPACE_ID,
      WORKSTREAM_ID,
      parentLease.attemptId,
    );

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

    expect(await reapStaleHarnessRuns(sqlite.binding, {
      receipts: () => flakyReceipts,
      blocks: () => sqlite.blocks,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      onReceiptRepairFailure: (failure) => repairFailures.push(failure),
    })).toEqual([child.childInput.harnessRunId]);
    expect(repairFailures).toEqual([{
      phase: "stale_child",
      runId: child.childInput.harnessRunId,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      attemptId: child.lease.attemptId,
      reason: "transient_receipt_rpc_failure",
    }]);
    expect(sqlite.object.prepare(
      "SELECT status, terminalized_at FROM harness_runs WHERE id = ?",
    ).get(child.childInput.harnessRunId)).toMatchObject({ status: "failed" });
    expect(sqlite.object.prepare(
      "SELECT status FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-child-receipt-retry")).toEqual({ status: "executing" });
    expect(sqlite.object.prepare(
      `SELECT COUNT(*) AS count FROM harness_run_lifecycle_events
        WHERE harness_run_id = ? AND event_key = 'residual_receipts_settled'`,
    ).get(child.childInput.harnessRunId)).toEqual({ count: 0 });

    expect(await reapStaleHarnessRuns(sqlite.binding, {
      receipts: () => flakyReceipts,
      blocks: () => sqlite.blocks,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
    })).toEqual([]);
    expect(sqlite.object.prepare(
      "SELECT status, error_json FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-child-receipt-retry")).toEqual({
      status: "ambiguous",
      error_json: '{"code":"ambiguous_external_write","message":"The child run ended while an external write was unresolved"}',
    });
    expect(sqlite.object.prepare(
      `SELECT COUNT(*) AS count FROM harness_run_lifecycle_events
        WHERE harness_run_id = ? AND event_key = 'residual_receipts_settled'`,
    ).get(child.childInput.harnessRunId)).toEqual({ count: 1 });
    expect(settlementCalls).toBe(2);
  });

  it("cleans up an expired child after cancellation is requested", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const parentLease = await claimScopedParent(sqlite);
    const child = await admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, {
      parentToolCallId: "tool-cancelled-child-cleanup",
      objective: "Stop after cancellation",
      childHarnessRunId: asHarnessRunId("00000000-0000-4000-8000-000000000112"),
      attemptId: "attempt-child-cancelled-cleanup",
      owner: "owner-child-cancelled-cleanup",
    });
    if (child.state !== "claimed") throw new Error("expected claimed child");
    expect(await cancelDescendantHarnessRuns(sqlite.binding, RUN_ONE, "parent_cancelled"))
      .toBe(1);
    sqlite.object.prepare(
      "UPDATE harness_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(child.childInput.harnessRunId);

    expect(await reapStaleHarnessRuns(sqlite.binding, {
      receipts: () => sqlite.receipts,
      blocks: () => sqlite.blocks,
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
    expect(sqlite.object.prepare(
      "SELECT harness_status FROM workstreams WHERE id = ?",
    ).get(WORKSTREAM_ID)).toEqual({ harness_status: "running" });
  });

  it("repairs a HyperSight orphan while reaping a run that has no block of its own", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    // RUN_TWO's block was stranded: its run is terminal in the object, but the
    // settlement that would have closed the block never landed. Nothing finds
    // it again — the reaper selects `status = 'running' AND terminalized_at IS
    // NULL`, which a terminalized run no longer matches.
    sqlite.objectDatabase.exec(`
      INSERT INTO block_dashboard_configuration_versions
        (configuration_version_id, version_number, blocks_json, created_by_user_id, created_at)
      VALUES ('orphan-version', 1, '[{"id":"orphan","prompt":"Summarize"}]',
              'user-runtime', 1787000000000);
      INSERT INTO block_dashboard_block_runs
        (block_run_id, configuration_version_id, block_id, prompt,
         trigger_sequence, run_id, status, created_at)
      VALUES ('orphan-block-run', 'orphan-version', 'orphan', 'Summarize', 1,
              '${RUN_TWO}', 'running', 1787000000000);
      UPDATE runs SET origin = 'block_dashboard_block', status = 'failed',
                      terminalized_at = 1787000000000
       WHERE run_id = '${RUN_TWO}'
    `);
    const claim = await claimHarnessAttempt(sqlite.binding, input(RUN_ONE), {
      attemptId: "attempt-orphan-repair",
      owner: "owner-orphan-repair",
    });
    expect(claim.state).toBe("claimed");
    sqlite.object.prepare(
      "UPDATE harness_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(RUN_ONE);

    // RUN_ONE is an ordinary run with no block at all. The sweep still reaches
    // the block authority, because the repair is what needs reaching, not this
    // run's own block — a work stream whose later stale runs happen to be
    // ordinary ones would otherwise keep its orphan forever.
    expect(await reapStaleHarnessRuns(sqlite.binding, {
      receipts: () => sqlite.receipts,
      blocks: () => sqlite.blocks,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
    })).toEqual([RUN_ONE]);
    expect(sqlite.objectDatabase.prepare(
      `SELECT status, completed_at, json_extract(error_json, '$.code') AS code
         FROM block_dashboard_block_runs WHERE block_run_id = 'orphan-block-run'`,
    ).get()).toEqual({
      status: "failed",
      // Its own run's terminal instant, and the repair's own reason: nobody
      // established that *this* block's run lost a lease.
      completed_at: 1787000000000,
      code: "block_run_orphaned",
    });
  });

  it("does not clean up a child snapshot whose lease is renewed before the CAS batch", async () => {
    const sqlite = fixture();
    openDatabases.push(sqlite.database);
    const parentLease = await claimScopedParent(sqlite);
    const child = await admitInlineChildAttempt(sqlite.binding, input(RUN_ONE), parentLease, {
      parentToolCallId: "tool-child-reaper-race",
      objective: "Win the cleanup race",
      childHarnessRunId: asHarnessRunId("00000000-0000-4000-8000-000000000113"),
      attemptId: "attempt-child-reaper-race",
      owner: "owner-child-reaper-race",
    });
    if (child.state !== "claimed") throw new Error("expected claimed child");
    await persistToolExecutionPlan(sqlite.receipts, child.lease, {
      invocationId: "invocation-child-reaper-race",
      harnessRunId: child.childInput.harnessRunId,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      toolCallId: "call-child-reaper-race",
      toolName: "terminal_run_command",
      inputHash: "child-reaper-race-input",
      input: { command: "sleep 60" },
      plan: { operation: "command.run", mode: "write", idempotency: "record_before_execute" },
      mode: "write",
    });
    sqlite.object.prepare(
      "UPDATE harness_runs SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(child.childInput.harnessRunId);
    sqlite.object.prepare(
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
          sqlite.object.prepare(
            "UPDATE harness_runs SET heartbeat_at = '2026-08-03T00:00:00.000Z', lease_expires_at = '2099-01-01T00:00:00.000Z' WHERE id = ?",
          ).run(child.childInput.harnessRunId);
        }
        return sqlite.binding.batch(statements);
      },
    });

    expect(await reapStaleHarnessRuns(racingBinding, {
      receipts: () => sqlite.receipts,
      blocks: () => sqlite.blocks,
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
    })).toEqual([]);
    expect(intercepted).toBe(true);
    expect(sqlite.object.prepare(
      "SELECT status, lease_owner, lease_expires_at, terminalized_at FROM harness_runs WHERE id = ?",
    ).get(child.childInput.harnessRunId)).toEqual({
      status: "running",
      lease_owner: child.lease.owner,
      lease_expires_at: "2099-01-01T00:00:00.000Z",
      terminalized_at: null,
    });
    expect(sqlite.object.prepare(
      "SELECT status, checkpoint_index FROM tool_effects WHERE effect_intent_id = ?",
    ).get("invocation-child-reaper-race")).toEqual({ status: "executing", checkpoint_index: 0 });
    expect(sqlite.object.prepare(
      "SELECT COUNT(*) AS count FROM tool_effect_checkpoints WHERE effect_intent_id = ?",
    ).get("invocation-child-reaper-race")).toEqual({ count: 1 });
  });
});

function inferenceStreamResponse(events: unknown[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
