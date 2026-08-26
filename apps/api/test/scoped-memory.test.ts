import { asHarnessRunId, asUserId, asWorkstreamId } from "@rally/contracts";
import { asWorkspaceId } from "@rally/contracts";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkstreamWorkflowInput } from "@rally/contracts";
import type { Env } from "../src/env";
import {
  createMemoryTools,
  freezeRunMemoryContext,
  memorySearch,
  processMemoryIndexOutbox,
  resolveMemoryAccess,
} from "../src/services/memory-service";
import {
  buildAutomationMemoryTableStatements,
  createMemoryTableTools,
  loadAutomationMemoryTableContext,
} from "../src/services/memory-table-service";
import { withWorkstreamRuntimeDatabase } from "../src/services/workstream-runtime-database";
import { createCloudflareTestBinding, createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";
import {
  executeWorkstreamObjectSql,
  seedWorkstreamObjectRoot,
  testHarnessRunPort,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
  workstreamObjectRun,
  applyWorkstreamObjectRootFields,
} from "./helpers/durable-authority";
import { preRetirementProductSqliteDatabase } from "./helpers/sqlite-d1";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-000000000001");
const OWNER_ID = asUserId("00000000-0000-4000-8000-000000000002");
const MEMBER_ID = asUserId("00000000-0000-4000-8000-000000000003");
const WORKSTREAM_ONE = asWorkstreamId("00000000-0000-4000-8000-000000000011");
const WORKSTREAM_TWO = asWorkstreamId("00000000-0000-4000-8000-000000000012");
const AUTOMATION_WORKSTREAM_ONE = asWorkstreamId("00000000-0000-4000-8000-000000000013");
const AUTOMATION_WORKSTREAM_TWO = asWorkstreamId("00000000-0000-4000-8000-000000000014");
const RUN_ONE = asHarnessRunId("00000000-0000-4000-8000-000000000021");
const RUN_TWO = asHarnessRunId("00000000-0000-4000-8000-000000000022");
const AUTOMATION_RUN_ONE = asHarnessRunId("00000000-0000-4000-8000-000000000023");
const AUTOMATION_RUN_TWO = asHarnessRunId("00000000-0000-4000-8000-000000000024");
const AUTOMATION_FOLLOW_UP_RUN = asHarnessRunId("00000000-0000-4000-8000-000000000025");
const AUTOMATION_SUBSCRIPTION_ID = "00000000-0000-4000-8000-000000000031";

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

function sqliteD1(database: DatabaseSync): D1Database {
  return createTestD1Database({
    prepare: (sql: string) => createTestD1PreparedStatement(new SqliteD1Statement(database.prepare(sql))),
    batch: async (statements: D1PreparedStatement[]) => {
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
    },
  });
}

function embeddingFor(text: string): number[] {
  const normalized = text.toLowerCase();
  if (normalized.includes("crimson") || normalized.includes("red")) return [1, 0, 0];
  if (normalized.includes("azure") || normalized.includes("blue")) return [0, 1, 0];
  return [0, 0, 1];
}

class FakeAi {
  fail = false;

  async run(_model: string, input: { queries?: string[]; documents?: string[] }) {
    if (this.fail) throw new Error("embedding unavailable");
    const values = input.queries ?? input.documents ?? [];
    return { data: values.map(embeddingFor), shape: [values.length, 3] };
  }
}

class FakeVectorIndex {
  readonly vectors = new Map<string, { values: number[]; namespace?: string }>();
  readonly deleted: string[] = [];

  async query(values: number[], options?: { namespace?: string; topK?: number }) {
    const magnitude = (vector: number[]) => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    const matches = [...this.vectors.entries()]
      .filter(([, vector]) => vector.namespace === options?.namespace)
      .map(([id, vector]) => ({
        id,
        score: vector.values.reduce((sum, value, index) => sum + value * (values[index] ?? 0), 0)
          / Math.max(1e-9, magnitude(vector.values) * magnitude(values)),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, options?.topK ?? 10);
    return { matches, count: matches.length };
  }

  async upsert(vectors: Array<{ id: string; values: number[]; namespace?: string }>) {
    for (const vector of vectors) this.vectors.set(vector.id, vector);
    return { count: vectors.length, ids: vectors.map((vector) => vector.id) };
  }

  async deleteByIds(ids: string[]) {
    for (const id of ids) {
      this.vectors.delete(id);
      this.deleted.push(id);
    }
    return { count: ids.length, ids };
  }
}

const openDatabases: DatabaseSync[] = [];
/** Per-workstream object databases; run rows and run receipts live here. */
const objectStores = new Map<string, DatabaseSync>();

afterEach(() => {
  objectStores.clear();
  for (const database of openDatabases.splice(0)) database.close();
});

/**
 * The routed execution environment the harness hands a run's tools: run and
 * workstream authority statements travel the runtime SQL port into the run's
 * own object database, workspace memory tables stay regional.
 */
function routedEnv(env: Env, runInput: WorkstreamWorkflowInput): Env {
  const store = objectStores.get(runInput.workstreamId);
  if (!store) throw new Error(`no object store for ${runInput.workstreamId}`);
  return withWorkstreamRuntimeDatabase(
    env,
    runInput.workspaceId,
    runInput.workstreamId,
    "0",
    async (statements) => executeWorkstreamObjectSql(store, statements),
  );
}

function fixture(): {
  database: DatabaseSync;
  env: Env;
  ai: FakeAi;
  vector: FakeVectorIndex;
} {
  const database = preRetirementProductSqliteDatabase();
  openDatabases.push(database);
  // This snapshot stops at 0089, so it still carries the four owner-validation
  // triggers migration 0036 put on `memory_scopes` — and 0090 dropped them all
  // when memory moved into WorkspaceDO, whose `memory_scopes` has only an
  // immutability trigger. Leaving them here would let the fixture enforce rules
  // the code under test is now solely responsible for: remove the guard in
  // `resolveMemoryAccess` and a test would still fail, on
  // `memory_scope_workstream_owner_invalid` raised by a constraint production
  // retired, rather than on the union it asserts.
  database.exec(`
    DROP TRIGGER IF EXISTS memory_scopes_validate_workstream_owner;
    DROP TRIGGER IF EXISTS memory_scopes_validate_automation_owner;
    DROP TRIGGER IF EXISTS memory_scopes_validate_user_owner;
    DROP TRIGGER IF EXISTS memory_scopes_validate_workspace_owner;
  `);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at) VALUES
      ('${OWNER_ID}', 'memory-owner', 'owner@example.com', 'Owner', '2026-01-01', '2026-01-01'),
      ('${MEMBER_ID}', 'memory-member', 'member@example.com', 'Member', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces
      (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE_ID}', 'Memory', 'memory', 'global', '${OWNER_ID}', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at) VALUES
      ('${WORKSPACE_ID}', '${OWNER_ID}', 'owner', 'active', '2026-01-01'),
      ('${WORKSPACE_ID}', '${MEMBER_ID}', 'member', 'active', '2026-01-01');
    INSERT INTO automation_templates
      (id, workspace_id, owner_user_id, name, description, sharing_state,
       latest_version_number, created_at, updated_at)
    VALUES ('template-memory', '${WORKSPACE_ID}', '${OWNER_ID}', 'Memory automation',
            'Tests shared automation memory', 'workspace', 1, '2026-01-01', '2026-01-01');
    INSERT INTO automation_template_versions
      (id, template_id, version_number, instructions, trigger_definitions_json,
       required_capabilities_json, expected_outputs_json, default_behavior_json,
       created_by_user_id, created_at)
    VALUES ('version-memory', 'template-memory', 1, 'Remember', '[]', '[]', '[]', '{}',
            '${OWNER_ID}', '2026-01-01');
    INSERT INTO automation_subscriptions
      (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
       execution_principal_json, connector_bindings_json, overrides_json,
       status, created_at, updated_at)
    VALUES ('${AUTOMATION_SUBSCRIPTION_ID}', '${WORKSPACE_ID}', 'template-memory',
            'version-memory', 'workspace', NULL,
            '{"type":"workspace","workspaceId":"${WORKSPACE_ID}"}', '{}', '{}',
            'active', '2026-01-01', '2026-01-01');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       automation_subscription_id, harness_status, last_activity_at, created_at, updated_at)
    VALUES
      ('${WORKSTREAM_ONE}', '${WORKSPACE_ID}', 'Owner task', 'Remember preferences', 'ad_hoc',
       '${OWNER_ID}', NULL, 'running', '2026-01-01', '2026-01-01', '2026-01-01'),
      ('${WORKSTREAM_TWO}', '${WORKSPACE_ID}', 'Member task', 'Keep users isolated', 'ad_hoc',
       '${MEMBER_ID}', NULL, 'running', '2026-01-01', '2026-01-01', '2026-01-01'),
      ('${AUTOMATION_WORKSTREAM_ONE}', '${WORKSPACE_ID}', 'Automation one', 'First run', 'automation',
       NULL, '${AUTOMATION_SUBSCRIPTION_ID}', 'running', '2026-01-01', '2026-01-01', '2026-01-01'),
      ('${AUTOMATION_WORKSTREAM_TWO}', '${WORKSPACE_ID}', 'Automation two', 'Second run', 'automation',
       NULL, '${AUTOMATION_SUBSCRIPTION_ID}', 'running', '2026-01-01', '2026-01-01', '2026-01-01');
  `);
  // Since migration 0090 each run row lives only in its work stream's own
  // object; the fixture opens the four objects and writes the runs through
  // the same compat port the harness uses.
  const runsByWorkstream: Array<[string, string, string, string, string]> = [
    [WORKSTREAM_ONE, RUN_ONE, JSON.stringify({ type: "user", userId: OWNER_ID }), "attempt-owner", "lease-owner"],
    [WORKSTREAM_TWO, RUN_TWO, JSON.stringify({ type: "user", userId: MEMBER_ID }), "attempt-member", "lease-member"],
    [AUTOMATION_WORKSTREAM_ONE, AUTOMATION_RUN_ONE,
      JSON.stringify({ type: "workspace", workspaceId: WORKSPACE_ID }), "attempt-auto-one", "lease-auto-one"],
    [AUTOMATION_WORKSTREAM_TWO, AUTOMATION_RUN_TWO,
      JSON.stringify({ type: "workspace", workspaceId: WORKSPACE_ID }), "attempt-auto-two", "lease-auto-two"],
  ];
  for (const [workstreamId, runId, principalJson, attemptId, leaseOwner] of runsByWorkstream) {
    const store = testWorkstreamObjectStore();
    openDatabases.push(store);
    seedWorkstreamObjectRoot(store, { workstreamId, workspaceId: WORKSPACE_ID });
    const directory = database.prepare(
      "SELECT title, objective, origin_type, created_by_user_id, automation_subscription_id FROM workstreams WHERE id = ?",
    ).get(workstreamId) as {
      title: string;
      objective: string;
      origin_type: string;
      created_by_user_id: string | null;
      automation_subscription_id: string | null;
    };
    applyWorkstreamObjectRootFields(store, {
      title: directory.title,
      description: directory.objective,
      originType: directory.origin_type,
      createdByUserId: directory.created_by_user_id,
      automationSubscriptionId: directory.automation_subscription_id,
      exactState: "running",
    });
    workstreamObjectRun(
      store,
      `INSERT INTO harness_runs
        (id, workspace_id, workstream_id, origin, execution_principal_json, status,
         attempt_id, attempt_number, lease_owner, lease_expires_at, heartbeat_at, created_at)
       VALUES (?, ?, ?, 'test', ?, 'running', ?, 1, ?, '2099-01-01T00:00:00.000Z', '2026-01-01', '2026-01-01')`,
      runId,
      WORKSPACE_ID,
      workstreamId,
      principalJson,
      attemptId,
      leaseOwner,
    );
    objectStores.set(workstreamId, store);
  }
  const ai = new FakeAi();
  const vector = new FakeVectorIndex();
  return {
    database,
    ai,
    vector,
    env: createTestEnv({
      DB: sqliteD1(database),
      AI: createCloudflareTestBinding<Ai>(ai),
      MEMORY_INDEX: createCloudflareTestBinding<VectorizeIndex>(vector),
      // Freezing a run's recall now goes through the harness-run authority, so
      // this fixture needs the object namespace as well as the SQL callback
      // below. Both reach the same per-work-stream store.
      SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
      AVALON_REGION: "global",
      APP_ENV: "test",
    }),
  };
}

function input(
  user: "owner" | "member" | "workspace" = "owner",
  automationRun: 1 | 2 | null = null,
): WorkstreamWorkflowInput {
  if (automationRun) {
    return {
      region: "global",
      workspaceId: WORKSPACE_ID,
      workstreamId: automationRun === 1 ? AUTOMATION_WORKSTREAM_ONE : AUTOMATION_WORKSTREAM_TWO,
      harnessRunId: automationRun === 1 ? AUTOMATION_RUN_ONE : AUTOMATION_RUN_TWO,
      triggerMessageId: null,
      automationSubscriptionId: AUTOMATION_SUBSCRIPTION_ID,
      activityId: null,
      executionPrincipal: { type: "workspace", workspaceId: WORKSPACE_ID },
      reason: "memory automation test",
    };
  }
  const owner = user === "owner";
  return {
    region: "global",
    workspaceId: WORKSPACE_ID,
    workstreamId: owner ? WORKSTREAM_ONE : WORKSTREAM_TWO,
    harnessRunId: owner ? RUN_ONE : RUN_TWO,
    triggerMessageId: null,
    automationSubscriptionId: null,
    activityId: null,
    executionPrincipal: user === "workspace"
      ? { type: "workspace", workspaceId: WORKSPACE_ID }
      : { type: "user", userId: owner ? OWNER_ID : MEMBER_ID },
    reason: "memory test",
  };
}

function toolContext(runInput: WorkstreamWorkflowInput, receipt: string) {
  return {
    workspaceId: runInput.workspaceId,
    workstreamId: runInput.workstreamId,
    harnessRunId: runInput.harnessRunId,
    toolCallId: receipt,
    providerIdempotencyKey: receipt,
    executionPrincipal: runInput.executionPrincipal,
    signal: new AbortController().signal,
  };
}

function memoryTool(env: Env, runInput: WorkstreamWorkflowInput, name: string) {
  const tool = createMemoryTools(routedEnv(env, runInput), runInput)
    .find((candidate) => candidate.definition.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

function tableTool(env: Env, runInput: WorkstreamWorkflowInput, name: string) {
  const tool = createMemoryTableTools(routedEnv(env, runInput), runInput)
    .find((candidate) => candidate.definition.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

describe("scoped agent memory", () => {
  it("derives the complete scope union and never exposes search scope selectors", async () => {
    const { database, env } = fixture();
    const ownerScopes = await resolveMemoryAccess(routedEnv(env, input("owner")), input("owner"));
    expect(ownerScopes.map((scope) => scope.kind)).toEqual(["workspace", "user", "workstream"]);
    expect(ownerScopes.find((scope) => scope.kind === "workspace")?.ownerId).toBe(WORKSPACE_ID);

    const automationScopes = await resolveMemoryAccess(routedEnv(env, input("workspace", 1)), input("workspace", 1));
    expect(automationScopes.map((scope) => scope.kind)).toEqual(["workspace", "automation"]);

    database.prepare(
      `UPDATE automation_subscriptions
          SET scope = 'personal', owner_user_id = ?, execution_principal_json = ?
        WHERE id = ?`,
    ).run(OWNER_ID, JSON.stringify({ type: "user", userId: OWNER_ID }), AUTOMATION_SUBSCRIPTION_ID);
    // A run's principal is fixed at admission and the compat surface cannot
    // rewrite it; restate the fixture run the way a personal-automation
    // admission would have recorded it.
    objectStores.get(AUTOMATION_WORKSTREAM_ONE)!.prepare(
      "UPDATE runs SET execution_principal_json = ? WHERE run_id = ?",
    ).run(JSON.stringify({ type: "user", userId: OWNER_ID }), AUTOMATION_RUN_ONE);
    const personalAutomationInput = {
      ...input("workspace", 1),
      executionPrincipal: { type: "user" as const, userId: OWNER_ID },
    };
    const personalAutomationScopes = await resolveMemoryAccess(routedEnv(env, personalAutomationInput), personalAutomationInput);
    expect(personalAutomationScopes.map((scope) => scope.kind))
      .toEqual(["workspace", "user", "automation"]);

    const search = memoryTool(env, input("owner"), "search");
    expect(search.definition.inputSchema).toMatchObject({
      additionalProperties: false,
      properties: { query: expect.any(Object), memoryItemId: expect.any(Object) },
    });
    expect(Object.keys((search.definition.inputSchema as { properties: object }).properties))
      .toEqual(["query", "memoryItemId"]);
    // The choice between the two is exclusive, and the executor is where that
    // holds: a `oneOf` of bare `required` branches does not survive schema
    // sanitization, so the wire schema never carried it either. Asserted on the
    // parse rather than the declaration for that reason — see
    // `tool-schema-sanitization.test.ts`.
    // The message is asserted, not just the rejection: with the constraint gone
    // from the wire schema this is the model's only feedback, and a union's
    // default text ("Unrecognized key: …" from each branch) reads as though
    // neither parameter were allowed.
    await expect(search.execute(
      { query: "anything", memoryItemId: OWNER_ID },
      toolContext(input("owner"), "search-with-both"),
    )).rejects.toThrow(/exactly one of query or memoryItemId/);
    await expect(search.execute(
      {},
      toolContext(input("owner"), "search-with-neither"),
    )).rejects.toThrow(/exactly one of query or memoryItemId/);
    await expect(search.execute(
      { query: "anything", scopes: ["workspace"] },
      toolContext(input("owner"), "search-with-selector"),
    )).rejects.toThrow();
  });

  it("isolates user and workstream memory while sharing workspace memory", async () => {
    const { env } = fixture();
    const ownerInput = input("owner");
    const add = memoryTool(env, ownerInput, "add");
    await add.execute(
      { scopeKind: "user", text: "Owner prefers crimson reports", rationale: "Durable preference" },
      toolContext(ownerInput, "add-owner-user"),
    );
    await add.execute(
      { scopeKind: "workstream", text: "This task uses the zephyr codename", rationale: "Task continuity" },
      toolContext(ownerInput, "add-owner-workstream"),
    );
    await add.execute(
      { scopeKind: "workspace", text: "The workspace release day is Thursday", rationale: "Shared convention" },
      toolContext(ownerInput, "add-workspace"),
    );
    await add.execute(
      {
        scopeKind: "user",
        text: "Obsolete preference was chartreuse",
        expiresAt: "2020-01-01T00:00:00.000Z",
        rationale: "Time-limited preference",
      },
      toolContext(ownerInput, "add-expired"),
    );

    const memberInput = input("member");
    expect((await memorySearch(routedEnv(env, memberInput), memberInput, "crimson")).results).toEqual([]);
    expect((await memorySearch(routedEnv(env, memberInput), memberInput, "zephyr")).results).toEqual([]);
    expect((await memorySearch(routedEnv(env, memberInput), memberInput, "release Thursday")).results)
      .toEqual([expect.objectContaining({ scopeKind: "workspace" })]);
    expect((await memorySearch(routedEnv(env, ownerInput), ownerInput, "obsolete chartreuse")).results).toEqual([]);

    await expect(memoryTool(env, memberInput, "add").execute(
      { scopeKind: "workspace", text: "Members cannot write this", rationale: "Unauthorized" },
      toolContext(memberInput, "member-workspace-write"),
    // The refusal names what this run may write instead, because `scopeKind`
    // offers every kind and a bare code left the model nothing to retry with.
    )).rejects.toThrow(/may read workspace memory but not write it.*may write: user, workstream/);
  });

  it("shares one automation scope across every workstream from a subscription", async () => {
    const { env } = fixture();
    const first = input("workspace", 1);
    const second = input("workspace", 2);
    const added = await memoryTool(env, first, "add").execute(
      { scopeKind: "automation", text: "Use the crimson summary template", rationale: "Future runs need this" },
      toolContext(first, "add-automation"),
    );
    const results = (await memorySearch(routedEnv(env, second), second, "crimson template")).results;
    expect(results).toEqual([expect.objectContaining({
      memoryScopeId: (added.output as { memoryScopeId: string }).memoryScopeId,
      scopeKind: "automation",
    })]);
    expect((await resolveMemoryAccess(routedEnv(env, first), first)).find((scope) => scope.kind === "automation")?.memoryScopeId)
      .toBe((await resolveMemoryAccess(routedEnv(env, second), second)).find((scope) => scope.kind === "automation")?.memoryScopeId);
  });

  it("gives a run with no subscription the ordinary union in an automation work stream", async () => {
    const { env } = fixture();
    // The reply's own run, not the automation's rewritten: `admitRun` inserts a
    // new row for the trigger message once the run before it has terminalized —
    // `runs_mutating_substream_uq` permits one live run per substream — and the
    // work stream's origin stays `automation` underneath both.
    objectStores.get(AUTOMATION_WORKSTREAM_TWO)!.prepare(
      "UPDATE runs SET status = 'completed' WHERE run_id = ?",
    ).run(AUTOMATION_RUN_TWO);
    workstreamObjectRun(
      objectStores.get(AUTOMATION_WORKSTREAM_TWO)!,
      `INSERT INTO harness_runs
        (id, workspace_id, workstream_id, origin, execution_principal_json, status,
         attempt_id, attempt_number, lease_owner, lease_expires_at, heartbeat_at, created_at)
       VALUES (?, ?, ?, 'human_message', ?, 'running', 'attempt-follow-up', 1,
               'lease-follow-up', '2099-01-01T00:00:00.000Z', '2026-01-01', '2026-01-01')`,
      AUTOMATION_FOLLOW_UP_RUN,
      WORKSPACE_ID,
      AUTOMATION_WORKSTREAM_TWO,
      JSON.stringify({ type: "user", userId: MEMBER_ID }),
    );
    const reply: WorkstreamWorkflowInput = {
      region: "global",
      workspaceId: WORKSPACE_ID,
      workstreamId: AUTOMATION_WORKSTREAM_TWO,
      harnessRunId: AUTOMATION_FOLLOW_UP_RUN,
      triggerMessageId: null,
      automationSubscriptionId: null,
      activityId: null,
      executionPrincipal: { type: "user", userId: MEMBER_ID },
      reason: "human_message",
    };
    const scopes = await resolveMemoryAccess(routedEnv(env, reply), reply);
    // Workspace and the member's own memory, and neither of the two scopes this
    // work stream is not entitled to: not the subscription's automation memory,
    // which still takes a run that declares the subscription, and not a
    // work-stream scope, which only an ad-hoc work stream owns.
    expect(scopes.map((scope) => scope.kind)).toEqual(["workspace", "user"]);
    expect(scopes.find((scope) => scope.kind === "user")).toMatchObject({
      ownerId: MEMBER_ID,
      writable: true,
    });
    // Asserted rather than implied: this member is not an owner or admin, and
    // admitting the run must not have made workspace memory writable to them.
    expect(scopes.find((scope) => scope.kind === "workspace")?.writable).toBe(false);
    // And the automation's items stay unreachable through the search this run
    // does perform — the scope list above is the union, this is its effect.
    const planted = await memoryTool(env, input("workspace", 1), "add").execute(
      { scopeKind: "automation", text: "Vendor floor is chartreuse", rationale: "Future runs need this" },
      toolContext(input("workspace", 1), "plant-automation-memory"),
    );
    expect(planted.output).toMatchObject({ scopeKind: "automation" });
    expect((await memorySearch(routedEnv(env, reply), reply, "vendor floor chartreuse")).results)
      .toEqual([]);

    // The same branch admits a workspace principal, which is what an
    // automation's own continuation reaches it as — a scheduled wake-up or a
    // digest declares no subscription either. It gets workspace memory alone:
    // no person to own a user scope, and still no scope of its own.
    const wakeup = { ...input("workspace", 1), automationSubscriptionId: null };
    expect((await resolveMemoryAccess(routedEnv(env, wakeup), wakeup)).map((scope) => scope.kind))
      .toEqual(["workspace"]);

    // And the tool surface still offers a scope kind this run cannot reach —
    // `scopeKind` is the full static enum — so the model's recovery from
    // picking it is the executor's refusal, not a resolved scope.
    await expect(memoryTool(env, reply, "add").execute(
      { scopeKind: "workstream", text: "Reply thread note", rationale: "Should not resolve" },
      toolContext(reply, "add-workstream-under-automation"),
    )).rejects.toThrow(/cannot reach workstream memory.*scopes are: workspace, user/);
  });

  it("holds a run that declares a subscription to the work stream it names", async () => {
    const { env } = fixture();
    // `input("owner")` is WORKSTREAM_ONE, which is ad-hoc and belongs to no
    // subscription — so claiming this one is the mismatch, not a stale id.
    const borrowed: WorkstreamWorkflowInput = {
      ...input("owner"),
      automationSubscriptionId: AUTOMATION_SUBSCRIPTION_ID,
    };
    await expect(resolveMemoryAccess(routedEnv(env, borrowed), borrowed))
      .rejects.toThrow("memory_automation_workstream_mismatch");
  });

  it("replays receipts and uses revision CAS for updates and invalidation", async () => {
    const { database, env } = fixture();
    const runInput = input("owner");
    const add = memoryTool(env, runInput, "add");
    const args = { scopeKind: "user", text: "Favorite color is crimson", rationale: "Preference" };
    const first = await add.execute(args, toolContext(runInput, "receipt-add"));
    const replay = await add.execute(args, toolContext(runInput, "receipt-add"));
    expect(replay).toEqual(first);
    expect(database.prepare("SELECT COUNT(*) AS count FROM memory_items").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM memory_mutations").get()).toEqual({ count: 1 });

    const memoryItemId = (first.output as { memoryItemId: string }).memoryItemId;
    const update = memoryTool(env, runInput, "update");
    const updated = await update.execute(
      { memoryItemId, expectedRevision: 1, text: "Favorite color is azure", rationale: "Preference changed" },
      toolContext(runInput, "receipt-update"),
    );
    expect(updated.output).toMatchObject({ revision: 2, invalidated: false });
    await expect(update.execute(
      { memoryItemId, expectedRevision: 1, text: "Favorite color is green", rationale: "Stale writer" },
      toolContext(runInput, "receipt-stale-update"),
    )).rejects.toMatchObject({
      code: "memory_revision_conflict",
      message: "The durable memory changed after it was read. Read it again by memoryItemId, inspect the current text and revision, and rebuild the mutation.",
      details: { reason: expect.stringContaining("memory_search") },
    });

    expect(await memoryTool(env, runInput, "search").execute(
      { memoryItemId },
      toolContext(runInput, "read-memory-by-id"),
    )).toMatchObject({
      output: {
        memoryItemId,
        retrievalMode: "exact",
        results: [{ memoryItemId, revision: 2, text: "Favorite color is azure" }],
      },
    });

    await expect(memoryTool(env, runInput, "invalidate").execute(
      { memoryItemId, expectedRevision: 1, reason: "Stale invalidation" },
      toolContext(runInput, "receipt-stale-invalidate"),
    )).rejects.toMatchObject({
      code: "memory_revision_conflict",
      details: { reason: expect.stringContaining("memoryItemId") },
    });

    const invalidated = await memoryTool(env, runInput, "invalidate").execute(
      { memoryItemId, expectedRevision: 2, reason: "Preference is no longer valid" },
      toolContext(runInput, "receipt-invalidate"),
    );
    expect(invalidated.output).toMatchObject({ revision: 3, invalidated: true });
    expect((await memorySearch(routedEnv(env, runInput), runInput, "azure")).results).toEqual([]);
    expect(database.prepare(
      "SELECT invalidated_at, invalidation_reason, text FROM memory_items WHERE memory_item_id = ?",
    ).get(memoryItemId)).toMatchObject({
      invalidation_reason: "Preference is no longer valid",
      text: "Favorite color is azure",
    });
  });

  it("uses hybrid retrieval, rejects stale vectors, and degrades to FTS", async () => {
    const { database, env, ai, vector } = fixture();
    const runInput = input("owner");
    const added = await memoryTool(env, runInput, "add").execute(
      { scopeKind: "user", text: "The report palette is crimson", rationale: "Durable style" },
      toolContext(runInput, "vector-add"),
    );
    expect(await processMemoryIndexOutbox(env)).toBe(1);
    expect(database.prepare(
      "SELECT status FROM memory_index_outbox WHERE memory_item_id = ?",
    ).get((added.output as { memoryItemId: string }).memoryItemId)).toEqual({ status: "completed" });
    expect(await processMemoryIndexOutbox(env)).toBe(0);

    const semantic = await memorySearch(routedEnv(env, runInput), runInput, "red");
    expect(semantic.retrievalMode).toBe("hybrid");
    expect(semantic.results).toEqual([expect.objectContaining({ text: "The report palette is crimson" })]);

    const memoryItemId = (added.output as { memoryItemId: string }).memoryItemId;
    await memoryTool(env, runInput, "update").execute(
      { memoryItemId, expectedRevision: 1, text: "The report palette is azure", rationale: "Palette changed" },
      toolContext(runInput, "vector-update"),
    );
    expect(vector.vectors.has(`${memoryItemId}:1`)).toBe(true);
    expect((await memorySearch(routedEnv(env, runInput), runInput, "red")).results).toEqual([]);

    ai.fail = true;
    const degraded = await memorySearch(routedEnv(env, runInput), runInput, "azure palette");
    expect(degraded.retrievalMode).toBe("fts_only");
    expect(degraded.results).toEqual([expect.objectContaining({ revision: 2, text: "The report palette is azure" })]);
    expect(await processMemoryIndexOutbox(env)).toBe(0);
    expect(database.prepare(
      `SELECT status, attempt_count, last_error FROM memory_index_outbox
        WHERE memory_item_id = ? AND revision = 2`,
    ).get(memoryItemId)).toMatchObject({
      status: "pending",
      attempt_count: 1,
      last_error: "embedding unavailable",
    });

    ai.fail = false;
    database.prepare(
      "UPDATE memory_index_outbox SET available_at = '2020-01-01' WHERE memory_item_id = ? AND revision = 2",
    ).run(memoryItemId);
    expect(await processMemoryIndexOutbox(env)).toBe(1);
    expect(vector.vectors.has(`${memoryItemId}:2`)).toBe(true);
    expect(vector.vectors.has(`${memoryItemId}:1`)).toBe(false);
  });

  it("freezes recalled results and the context hash for deterministic retries", async () => {
    const { database, env } = fixture();
    const runInput = input("owner");
    await memoryTool(env, runInput, "add").execute(
      { scopeKind: "user", text: "Use the crimson dashboard", rationale: "Presentation preference" },
      toolContext(runInput, "snapshot-add"),
    );
    const first = await freezeRunMemoryContext(
      routedEnv(env, runInput),
      runInput,
      { attemptId: "attempt-owner", owner: "lease-owner" },
      "crimson dashboard",
    );
    expect(first.results).toHaveLength(1);

    database.prepare("UPDATE memory_items SET text = 'Changed after admission' WHERE memory_item_id = ?")
      .run(first.results[0]!.memoryItemId);
    const replay = await freezeRunMemoryContext(
      routedEnv(env, runInput),
      runInput,
      { attemptId: "attempt-owner", owner: "lease-owner" },
      "a different retry query",
    );
    expect(replay).toEqual(first);
    // The frozen context is immutable through its only write surface. That used
    // to be enforced by the compat view carrying an insert trigger and nothing
    // else, so a routed UPDATE was refused outright; the authority now enforces
    // it by answering `reused` and never writing, which is the same guarantee
    // stated as an outcome rather than as a missing trigger.
    const reFrozen = await testHarnessRunPort(objectStores.get(runInput.workstreamId)!)
      .persistMemoryContext({
        runId: RUN_ONE,
        attemptId: "attempt-owner",
        owner: "lease-owner",
        now: Date.now(),
        memoryScopeIdsJson: "[]",
        queryText: "mutated",
        retrievalMode: "fts_only",
        resultsJson: "[]",
        memoryContextHash: "mutated-hash",
      });
    expect(reFrozen).toMatchObject({ outcome: "reused" });
    expect(reFrozen.outcome === "reused" && reFrozen.row.query_text).not.toBe("mutated");
  });

  it("shares automation tables across runs and queries only matching projected rows", async () => {
    const { env } = fixture();
    const firstRun = input("workspace", 1);
    const secondRun = input("workspace", 2);
    const created = await tableTool(env, firstRun, "create").execute({
      scopeKind: "automation",
      name: "Seen blog entries",
      description: "One row per blog entry discovered by this automation.",
      usageInstructions: "Insert by canonical URL before reporting. Query only candidate URLs or pending rows.",
      columns: [
        { name: "itemKey", description: "Canonical URL", type: "url", required: true, searchable: false },
        { name: "site", description: "Source site", type: "string", required: true, searchable: true },
        { name: "title", description: "Entry title", type: "string", required: true, searchable: true },
        { name: "firstSeenAt", description: "First discovery time", type: "datetime", required: true, searchable: false },
        { name: "reported", description: "Whether delivery succeeded", type: "boolean", required: true, searchable: false },
      ],
      keyColumns: ["itemKey"],
      rationale: "Deduplicate blog entries across automation runs",
    }, toolContext(firstRun, "create-seen-entries"));
    const memoryTableId = (created.output as { memoryTableId: string }).memoryTableId;

    const insertArgs = {
      memoryTableId,
      rows: [
        {
          itemKey: "https://example.com/launch",
          site: "Example",
          title: "Launch notes",
          firstSeenAt: "2026-08-01T12:00:00-07:00",
          reported: false,
        },
        {
          itemKey: "https://example.com/archive",
          site: "Example",
          title: "Archive update",
          firstSeenAt: "2026-07-01T12:00:00-07:00",
          reported: true,
        },
      ],
      rationale: "Record fetched feed entries before reporting",
    };
    let contentionAttempts = 0;
    const contendedEnv = {
      ...env,
      DB: createTestD1Database({
        prepare: env.DB.prepare.bind(env.DB),
        batch: async (statements: D1PreparedStatement[]) => {
          contentionAttempts += 1;
          return statements.map(() => createTestD1Result({ success: true, meta: { changes: 0 } }));
        },
      }),
    };
    await expect(tableTool(contendedEnv, firstRun, "insert_rows").execute({
      memoryTableId,
      rows: [{
        itemKey: "https://example.com/contention",
        site: "Example",
        title: "Contended",
        firstSeenAt: "2026-08-01T12:00:00-07:00",
        reported: false,
      }],
      rationale: "Exercise bounded contention recovery",
    }, toolContext(firstRun, "insert-contention"))).rejects.toMatchObject({
      code: "memory_table_insert_contention",
      message: expect.stringContaining("natural-key values"),
      details: { reason: expect.stringContaining("table_insert_rows") },
    });
    expect(contentionAttempts).toBe(3);

    const inserted = await tableTool(env, firstRun, "insert_rows").execute(
      insertArgs,
      toolContext(firstRun, "insert-seen-entries"),
    );
    expect(inserted.output).toMatchObject({ insertedCount: 2, existingCount: 0 });
    expect(await tableTool(env, firstRun, "insert_rows").execute(
      insertArgs,
      toolContext(firstRun, "insert-seen-entries"),
    )).toEqual(inserted);

    const discovered = await tableTool(env, secondRun, "search").execute(
      { query: "blog entries" },
      toolContext(secondRun, "search-table"),
    );
    expect(discovered.output).toMatchObject({
      tables: [expect.objectContaining({ memoryTableId, scopeKind: "automation" })],
    });

    const queried = await tableTool(env, secondRun, "query").execute({
      memoryTableId,
      search: "launch",
      filter: {
        all: [
          { column: "site", op: "eq", value: "example" },
          { column: "firstSeenAt", op: "gte", value: "2026-08-01T00:00:00Z" },
          { column: "reported", op: "eq", value: false },
        ],
      },
      select: ["itemKey", "title"],
      pageSize: 10,
    }, toolContext(secondRun, "query-launch"));
    expect(queried.output).toMatchObject({
      memoryTableId,
      rows: [{
        revision: 1,
        values: {
          itemKey: "https://example.com/launch",
          title: "Launch notes",
        },
      }],
      nextCursor: null,
    });

    const launchRow = (queried.output as {
      rows: Array<{ memoryTableRowId: string; revision: number }>;
    }).rows[0]!;
    await tableTool(env, secondRun, "update_rows").execute({
      memoryTableId,
      rows: [{
        memoryTableRowId: launchRow.memoryTableRowId,
        expectedRevision: 1,
        values: { reported: true, title: "Launch notes revised" },
      }],
      rationale: "Delivery completed",
    }, toolContext(secondRun, "mark-reported"));
    await expect(tableTool(env, secondRun, "update_rows").execute({
      memoryTableId,
      rows: [{
        memoryTableRowId: launchRow.memoryTableRowId,
        expectedRevision: 1,
        values: { reported: false },
      }],
      rationale: "Stale update",
    }, toolContext(secondRun, "stale-update"))).rejects.toMatchObject({
      code: "memory_table_row_revision_conflict",
      message: "The durable table changed while the mutation was being applied. Query the affected rows again by memoryTableRowIds, copy their current revisions, and rebuild the mutation.",
      details: { reason: expect.stringContaining("table_query") },
    });

    expect(await tableTool(env, firstRun, "query").execute({
      memoryTableId,
      memoryTableRowIds: [launchRow.memoryTableRowId],
    }, toolContext(firstRun, "query-launch-by-id"))).toMatchObject({
      output: {
        rows: [{
          memoryTableRowId: launchRow.memoryTableRowId,
          revision: 2,
          values: { title: "Launch notes revised" },
        }],
      },
    });

    const updated = await tableTool(env, firstRun, "query").execute({
      memoryTableId,
      filter: { column: "reported", op: "eq", value: true },
      orderBy: [{ column: "firstSeenAt", direction: "desc" }],
      select: ["title", "reported"],
      pageSize: 1,
    }, toolContext(firstRun, "query-reported"));
    expect(updated.output).toMatchObject({
      rows: [{ revision: 2, values: { title: "Launch notes revised", reported: true } }],
    });
    const nextCursor = (updated.output as { nextCursor: string | null }).nextCursor;
    expect(nextCursor).toEqual(expect.any(String));
    const nextPage = await tableTool(env, firstRun, "query").execute({
      memoryTableId,
      filter: { column: "reported", op: "eq", value: true },
      orderBy: [{ column: "firstSeenAt", direction: "desc" }],
      select: ["itemKey"],
      pageSize: 1,
      cursor: nextCursor,
    }, toolContext(firstRun, "query-reported-page-two"));
    const archiveRow = (nextPage.output as {
      rows: Array<{ memoryTableRowId: string; revision: number }>;
    }).rows[0]!;
    await expect(tableTool(env, firstRun, "invalidate_rows").execute({
      memoryTableId,
      rows: [{ memoryTableRowId: archiveRow.memoryTableRowId, expectedRevision: archiveRow.revision + 1 }],
      reason: "Stale invalidation",
    }, toolContext(firstRun, "stale-invalidate-archive"))).rejects.toMatchObject({
      code: "memory_table_row_revision_conflict",
      details: { reason: expect.stringContaining("memoryTableRowIds") },
    });
    await tableTool(env, firstRun, "invalidate_rows").execute({
      memoryTableId,
      rows: [{
        memoryTableRowId: archiveRow.memoryTableRowId,
        expectedRevision: archiveRow.revision,
      }],
      reason: "Remove a retired feed entry",
    }, toolContext(firstRun, "invalidate-archive"));
    await expect(tableTool(env, firstRun, "query").execute({
      memoryTableId,
      filter: { column: "reported", op: "eq", value: true },
      pageSize: 1,
      cursor: nextCursor,
    }, toolContext(firstRun, "query-stale-cursor"))).rejects.toThrow("memory_table_cursor_stale");
    expect(await tableTool(env, secondRun, "query").execute({
      memoryTableId,
      filter: { column: "itemKey", op: "eq", value: "https://example.com/archive" },
      select: ["itemKey"],
    }, toolContext(secondRun, "query-invalidated"))).toMatchObject({ output: { rows: [] } });
  });

  it("keeps model-facing revision guidance tied to an exact producing read", () => {
    const { env } = fixture();
    const runInput = input("owner");
    const memoryTools = createMemoryTools(env, runInput);
    const tableTools = createMemoryTableTools(env, runInput);
    const memorySearchDefinition = memoryTools.find((tool) => tool.definition.name === "search")?.definition;
    const tableQueryDefinition = tableTools.find((tool) => tool.definition.name === "query")?.definition;

    expect(memorySearchDefinition?.description).toContain("memoryItemId");
    expect(tableQueryDefinition?.description).toContain("memoryTableRowIds");
    for (const name of ["update", "invalidate"]) {
      const definition = memoryTools.find((tool) => tool.definition.name === name)?.definition;
      expect(definition?.description).toContain("memory_search with memoryItemId");
      expect(JSON.stringify(definition?.inputSchema)).toContain("memory_search for this memoryItemId");
    }
    for (const name of ["update_rows", "invalidate_rows"]) {
      const definition = tableTools.find((tool) => tool.definition.name === name)?.definition;
      expect(definition?.description).toContain("table_query with memoryTableRowIds");
      expect(JSON.stringify(definition?.inputSchema)).toContain("table_query for this memoryTableRowId");
    }
  });

  it("normalizes post-read CAS races for memory and table mutations", async () => {
    const { database, env } = fixture();
    const runInput = input("owner");
    const add = memoryTool(env, runInput, "add");
    const updateItem = await add.execute({
      scopeKind: "user",
      text: "Update race source",
      rationale: "Create race fixture",
    }, toolContext(runInput, "race-memory-update-source"));
    const invalidateItem = await add.execute({
      scopeKind: "user",
      text: "Invalidate race source",
      rationale: "Create race fixture",
    }, toolContext(runInput, "race-memory-invalidate-source"));

    const withBatchRace = (mutate: () => void): Env => {
      let intercepted = false;
      return {
        ...env,
        DB: createTestD1Database({
          prepare: env.DB.prepare.bind(env.DB),
          batch: async (statements: D1PreparedStatement[]) => {
            if (!intercepted) {
              intercepted = true;
              mutate();
            }
            return env.DB.batch(statements);
          },
        }),
      };
    };

    const updateItemId = (updateItem.output as { memoryItemId: string }).memoryItemId;
    await expect(memoryTool(withBatchRace(() => {
      database.prepare("UPDATE memory_items SET revision = revision + 1 WHERE memory_item_id = ?")
        .run(updateItemId);
    }), runInput, "update").execute({
      memoryItemId: updateItemId,
      expectedRevision: 1,
      text: "Race should lose",
      rationale: "Exercise post-read CAS loss",
    }, toolContext(runInput, "race-memory-update"))).rejects.toMatchObject({
      code: "memory_revision_conflict",
      details: { reason: expect.stringContaining("memoryItemId") },
    });

    const invalidateItemId = (invalidateItem.output as { memoryItemId: string }).memoryItemId;
    await expect(memoryTool(withBatchRace(() => {
      database.prepare("UPDATE memory_items SET revision = revision + 1 WHERE memory_item_id = ?")
        .run(invalidateItemId);
    }), runInput, "invalidate").execute({
      memoryItemId: invalidateItemId,
      expectedRevision: 1,
      reason: "Race should lose",
    }, toolContext(runInput, "race-memory-invalidate"))).rejects.toMatchObject({
      code: "memory_revision_conflict",
      details: { reason: expect.stringContaining("memoryItemId") },
    });

    const created = await tableTool(env, runInput, "create").execute({
      scopeKind: "user",
      name: "Race rows",
      description: "Rows used to exercise post-read table races.",
      usageInstructions: "Insert by key and update only after a query.",
      columns: [
        { name: "key", description: "Stable key", type: "string", required: true, searchable: true },
        { name: "value", description: "Mutable value", type: "string", required: true, searchable: true },
      ],
      keyColumns: ["key"],
      rationale: "Create race table",
    }, toolContext(runInput, "race-table-create"));
    const memoryTableId = (created.output as { memoryTableId: string }).memoryTableId;
    const inserted = await tableTool(env, runInput, "insert_rows").execute({
      memoryTableId,
      rows: [{ key: "update", value: "before" }, { key: "invalidate", value: "before" }],
      rationale: "Create race rows",
    }, toolContext(runInput, "race-table-insert"));
    const rows = (inserted.output as {
      insertedRows: Array<{ memoryTableRowId: string; revision: number; values: { key: string } }>;
    }).insertedRows;
    const updateRow = rows.find((row) => row.values.key === "update")!;
    const invalidateRow = rows.find((row) => row.values.key === "invalidate")!;

    await expect(tableTool(withBatchRace(() => {
      database.prepare("UPDATE memory_table_rows SET revision = revision + 1 WHERE memory_table_row_id = ?")
        .run(updateRow.memoryTableRowId);
    }), runInput, "update_rows").execute({
      memoryTableId,
      rows: [{
        memoryTableRowId: updateRow.memoryTableRowId,
        expectedRevision: updateRow.revision,
        values: { value: "after" },
      }],
      rationale: "Exercise post-read row update race",
    }, toolContext(runInput, "race-table-update"))).rejects.toMatchObject({
      code: "memory_table_row_revision_conflict",
      details: { reason: expect.stringContaining("memoryTableRowIds") },
    });

    await expect(tableTool(withBatchRace(() => {
      database.prepare("UPDATE memory_table_rows SET revision = revision + 1 WHERE memory_table_row_id = ?")
        .run(invalidateRow.memoryTableRowId);
    }), runInput, "invalidate_rows").execute({
      memoryTableId,
      rows: [{
        memoryTableRowId: invalidateRow.memoryTableRowId,
        expectedRevision: invalidateRow.revision,
      }],
      reason: "Exercise post-read row invalidation race",
    }, toolContext(runInput, "race-table-invalidate"))).rejects.toMatchObject({
      code: "memory_table_row_revision_conflict",
      details: { reason: expect.stringContaining("memoryTableRowIds") },
    });
  });

  it("materializes draft-declared tables with stable runtime IDs and operating instructions", async () => {
    const { env } = fixture();
    const materialized = buildAutomationMemoryTableStatements(env, {
      workspaceId: WORKSPACE_ID,
      automationSubscriptionId: AUTOMATION_SUBSCRIPTION_ID,
      createdByUserId: OWNER_ID,
      createdAt: "2026-08-05T12:00:00.000Z",
      definitions: [{
        name: "Watch sources",
        description: "One row per feed watched by the automation.",
        usageInstructions: "Query active rows before fetching; update lastSuccessfulAccessAt only after parsing succeeds.",
        columns: [
          { name: "sourceKey", description: "Stable source key", type: "string", required: true, searchable: false },
          { name: "feedUrl", description: "Verified feed URL", type: "url", required: true, searchable: false },
          { name: "lastSuccessfulAccessAt", description: "Last successful parse", type: "datetime", required: false, searchable: false },
        ],
        keyColumns: ["sourceKey"],
      }],
    });
    await env.DB.batch(materialized.statements);
    const context = await loadAutomationMemoryTableContext(env, WORKSPACE_ID, AUTOMATION_SUBSCRIPTION_ID);
    expect(context).toEqual([expect.objectContaining({
      memoryTableId: materialized.tables[0]?.memoryTableId,
      memoryScopeId: materialized.tables[0]?.memoryScopeId,
      scopeKind: "automation",
      name: "Watch sources",
      keyColumns: ["sourceKey"],
      usageInstructions: expect.stringContaining("only after parsing succeeds"),
      columns: expect.arrayContaining([
        expect.objectContaining({ name: "feedUrl", type: "url" }),
      ]),
    })]);
  });

  it("keeps structured tables scope-authorized and exposes no read scope selector", async () => {
    const { env } = fixture();
    const owner = input("owner");
    const member = input("member");
    const search = tableTool(env, owner, "search");
    expect(Object.keys((search.definition.inputSchema as { properties: object }).properties)).toEqual(["query"]);
    const query = tableTool(env, owner, "query");
    expect(Object.keys((query.definition.inputSchema as { properties: object }).properties))
      .not.toContain("scopes");
    expect(query.definition.inputSchema).toMatchObject({
      $defs: { filterNode: { anyOf: expect.any(Array) } },
      properties: { filter: { $ref: "#/$defs/filterNode" } },
    });
    await expect(search.execute(
      { query: "private ledger", scopes: ["user"] },
      toolContext(owner, "table-search-with-scope"),
    )).rejects.toThrow();
    await tableTool(env, owner, "create").execute({
      scopeKind: "user",
      name: "Private ledger",
      description: "Owner-only structured state.",
      usageInstructions: "Use only for the owner's recurring work.",
      columns: [{ name: "key", description: "Stable key", type: "string", required: true, searchable: true }],
      keyColumns: ["key"],
      rationale: "Keep owner state isolated",
    }, toolContext(owner, "create-private-table"));
    expect(await tableTool(env, member, "search").execute(
      { query: "private ledger" },
      toolContext(member, "member-table-search"),
    )).toMatchObject({ output: { tables: [] } });
  });
});
