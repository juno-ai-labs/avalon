import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkstreamWorkflowInput } from "@avalon/contracts";
import type { Env } from "../src/env";
import {
  createMemoryTools,
  freezeRunMemoryContext,
  memorySearch,
  processMemoryIndexOutbox,
  resolveMemoryAccess,
} from "../src/services/memory-service";

const migrationsDirectory = new URL("../../../packages/db/migrations/", import.meta.url);
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const OWNER_ID = "00000000-0000-4000-8000-000000000002";
const MEMBER_ID = "00000000-0000-4000-8000-000000000003";
const WORKSTREAM_ONE = "00000000-0000-4000-8000-000000000011";
const WORKSTREAM_TWO = "00000000-0000-4000-8000-000000000012";
const AUTOMATION_WORKSTREAM_ONE = "00000000-0000-4000-8000-000000000013";
const AUTOMATION_WORKSTREAM_TWO = "00000000-0000-4000-8000-000000000014";
const RUN_ONE = "00000000-0000-4000-8000-000000000021";
const RUN_TWO = "00000000-0000-4000-8000-000000000022";
const AUTOMATION_RUN_ONE = "00000000-0000-4000-8000-000000000023";
const AUTOMATION_RUN_TWO = "00000000-0000-4000-8000-000000000024";
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
    return { success: true, meta: { changes: Number(result.changes) } } as unknown as D1Result<unknown>;
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values as SQLInputValue[]) as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return {
      success: true,
      results: this.statement.all(...this.values as SQLInputValue[]) as T[],
      meta: { changes: 0 },
    } as unknown as D1Result<T>;
  }
}

function sqliteD1(database: DatabaseSync): D1Database {
  return {
    prepare: (sql: string) => new SqliteD1Statement(database.prepare(sql)) as unknown as D1PreparedStatement,
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
  } as unknown as D1Database;
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

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

function fixture(): {
  database: DatabaseSync;
  env: Env;
  ai: FakeAi;
  vector: FakeVectorIndex;
} {
  const database = new DatabaseSync(":memory:");
  openDatabases.push(database);
  for (const fileName of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(new URL(fileName, migrationsDirectory), "utf8"));
  }
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
    INSERT INTO harness_runs
      (id, workspace_id, workstream_id, origin, execution_principal_json, status,
       attempt_id, attempt_number, lease_owner, lease_expires_at, heartbeat_at, created_at)
    VALUES
      ('${RUN_ONE}', '${WORKSPACE_ID}', '${WORKSTREAM_ONE}', 'test',
       '{"type":"user","userId":"${OWNER_ID}"}', 'running', 'attempt-owner', 1,
       'lease-owner', '2099-01-01T00:00:00.000Z', '2026-01-01', '2026-01-01'),
      ('${RUN_TWO}', '${WORKSPACE_ID}', '${WORKSTREAM_TWO}', 'test',
       '{"type":"user","userId":"${MEMBER_ID}"}', 'running', 'attempt-member', 1,
       'lease-member', '2099-01-01T00:00:00.000Z', '2026-01-01', '2026-01-01'),
      ('${AUTOMATION_RUN_ONE}', '${WORKSPACE_ID}', '${AUTOMATION_WORKSTREAM_ONE}', 'test',
       '{"type":"workspace","workspaceId":"${WORKSPACE_ID}"}', 'running', 'attempt-auto-one', 1,
       'lease-auto-one', '2099-01-01T00:00:00.000Z', '2026-01-01', '2026-01-01'),
      ('${AUTOMATION_RUN_TWO}', '${WORKSPACE_ID}', '${AUTOMATION_WORKSTREAM_TWO}', 'test',
       '{"type":"workspace","workspaceId":"${WORKSPACE_ID}"}', 'running', 'attempt-auto-two', 1,
       'lease-auto-two', '2099-01-01T00:00:00.000Z', '2026-01-01', '2026-01-01');
  `);
  const ai = new FakeAi();
  const vector = new FakeVectorIndex();
  return {
    database,
    ai,
    vector,
    env: {
      DB: sqliteD1(database),
      AI: ai as unknown as Ai,
      MEMORY_INDEX: vector as unknown as VectorizeIndex,
      AVALON_REGION: "global",
      APP_ENV: "test",
    } as Env,
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
  const tool = createMemoryTools(env, runInput).find((candidate) => candidate.definition.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

describe("scoped agent memory", () => {
  it("derives the complete scope union and never exposes search scope selectors", async () => {
    const { database, env } = fixture();
    const ownerScopes = await resolveMemoryAccess(env, input("owner"));
    expect(ownerScopes.map((scope) => scope.kind)).toEqual(["workspace", "user", "workstream"]);
    expect(ownerScopes.find((scope) => scope.kind === "workspace")?.ownerId).toBe(WORKSPACE_ID);

    const automationScopes = await resolveMemoryAccess(env, input("workspace", 1));
    expect(automationScopes.map((scope) => scope.kind)).toEqual(["workspace", "automation"]);

    database.prepare(
      `UPDATE automation_subscriptions
          SET scope = 'personal', owner_user_id = ?, execution_principal_json = ?
        WHERE id = ?`,
    ).run(OWNER_ID, JSON.stringify({ type: "user", userId: OWNER_ID }), AUTOMATION_SUBSCRIPTION_ID);
    database.prepare("UPDATE harness_runs SET execution_principal_json = ? WHERE id = ?")
      .run(JSON.stringify({ type: "user", userId: OWNER_ID }), AUTOMATION_RUN_ONE);
    const personalAutomationInput = {
      ...input("workspace", 1),
      executionPrincipal: { type: "user" as const, userId: OWNER_ID },
    };
    const personalAutomationScopes = await resolveMemoryAccess(env, personalAutomationInput);
    expect(personalAutomationScopes.map((scope) => scope.kind))
      .toEqual(["workspace", "user", "automation"]);

    const search = memoryTool(env, input("owner"), "avalon.memory_search");
    expect(search.definition.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["query"],
      properties: { query: expect.any(Object) },
    });
    expect(Object.keys((search.definition.inputSchema as { properties: object }).properties)).toEqual(["query"]);
    await expect(search.execute(
      { query: "anything", scopes: ["workspace"] },
      toolContext(input("owner"), "search-with-selector"),
    )).rejects.toThrow();
  });

  it("isolates user and workstream memory while sharing workspace memory", async () => {
    const { env } = fixture();
    const ownerInput = input("owner");
    const add = memoryTool(env, ownerInput, "avalon.memory_add");
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
    expect((await memorySearch(env, memberInput, "crimson")).results).toEqual([]);
    expect((await memorySearch(env, memberInput, "zephyr")).results).toEqual([]);
    expect((await memorySearch(env, memberInput, "release Thursday")).results)
      .toEqual([expect.objectContaining({ scopeKind: "workspace" })]);
    expect((await memorySearch(env, ownerInput, "obsolete chartreuse")).results).toEqual([]);

    await expect(memoryTool(env, memberInput, "avalon.memory_add").execute(
      { scopeKind: "workspace", text: "Members cannot write this", rationale: "Unauthorized" },
      toolContext(memberInput, "member-workspace-write"),
    )).rejects.toThrow("memory_scope_not_writable:workspace");
  });

  it("shares one automation scope across every workstream from a subscription", async () => {
    const { env } = fixture();
    const first = input("workspace", 1);
    const second = input("workspace", 2);
    const added = await memoryTool(env, first, "avalon.memory_add").execute(
      { scopeKind: "automation", text: "Use the crimson summary template", rationale: "Future runs need this" },
      toolContext(first, "add-automation"),
    );
    const results = (await memorySearch(env, second, "crimson template")).results;
    expect(results).toEqual([expect.objectContaining({
      memoryScopeId: (added.output as { memoryScopeId: string }).memoryScopeId,
      scopeKind: "automation",
    })]);
    expect((await resolveMemoryAccess(env, first)).find((scope) => scope.kind === "automation")?.memoryScopeId)
      .toBe((await resolveMemoryAccess(env, second)).find((scope) => scope.kind === "automation")?.memoryScopeId);
  });

  it("replays receipts and uses revision CAS for updates and invalidation", async () => {
    const { database, env } = fixture();
    const runInput = input("owner");
    const add = memoryTool(env, runInput, "avalon.memory_add");
    const args = { scopeKind: "user", text: "Favorite color is crimson", rationale: "Preference" };
    const first = await add.execute(args, toolContext(runInput, "receipt-add"));
    const replay = await add.execute(args, toolContext(runInput, "receipt-add"));
    expect(replay).toEqual(first);
    expect(database.prepare("SELECT COUNT(*) AS count FROM memory_items").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM memory_mutations").get()).toEqual({ count: 1 });

    const memoryItemId = (first.output as { memoryItemId: string }).memoryItemId;
    const update = memoryTool(env, runInput, "avalon.memory_update");
    const updated = await update.execute(
      { memoryItemId, expectedRevision: 1, text: "Favorite color is azure", rationale: "Preference changed" },
      toolContext(runInput, "receipt-update"),
    );
    expect(updated.output).toMatchObject({ revision: 2, invalidated: false });
    await expect(update.execute(
      { memoryItemId, expectedRevision: 1, text: "Favorite color is green", rationale: "Stale writer" },
      toolContext(runInput, "receipt-stale-update"),
    )).rejects.toThrow("memory_revision_conflict");

    const invalidated = await memoryTool(env, runInput, "avalon.memory_invalidate").execute(
      { memoryItemId, expectedRevision: 2, reason: "Preference is no longer valid" },
      toolContext(runInput, "receipt-invalidate"),
    );
    expect(invalidated.output).toMatchObject({ revision: 3, invalidated: true });
    expect((await memorySearch(env, runInput, "azure")).results).toEqual([]);
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
    const added = await memoryTool(env, runInput, "avalon.memory_add").execute(
      { scopeKind: "user", text: "The report palette is crimson", rationale: "Durable style" },
      toolContext(runInput, "vector-add"),
    );
    expect(await processMemoryIndexOutbox(env)).toBe(1);
    expect(database.prepare(
      "SELECT status FROM memory_index_outbox WHERE memory_item_id = ?",
    ).get((added.output as { memoryItemId: string }).memoryItemId)).toEqual({ status: "completed" });
    expect(await processMemoryIndexOutbox(env)).toBe(0);

    const semantic = await memorySearch(env, runInput, "red");
    expect(semantic.retrievalMode).toBe("hybrid");
    expect(semantic.results).toEqual([expect.objectContaining({ text: "The report palette is crimson" })]);

    const memoryItemId = (added.output as { memoryItemId: string }).memoryItemId;
    await memoryTool(env, runInput, "avalon.memory_update").execute(
      { memoryItemId, expectedRevision: 1, text: "The report palette is azure", rationale: "Palette changed" },
      toolContext(runInput, "vector-update"),
    );
    expect(vector.vectors.has(`${memoryItemId}:1`)).toBe(true);
    expect((await memorySearch(env, runInput, "red")).results).toEqual([]);

    ai.fail = true;
    const degraded = await memorySearch(env, runInput, "azure palette");
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
    await memoryTool(env, runInput, "avalon.memory_add").execute(
      { scopeKind: "user", text: "Use the crimson dashboard", rationale: "Presentation preference" },
      toolContext(runInput, "snapshot-add"),
    );
    const first = await freezeRunMemoryContext(
      env,
      runInput,
      { attemptId: "attempt-owner", owner: "lease-owner" },
      "crimson dashboard",
    );
    expect(first.results).toHaveLength(1);

    database.prepare("UPDATE memory_items SET text = 'Changed after admission' WHERE memory_item_id = ?")
      .run(first.results[0]!.memoryItemId);
    const replay = await freezeRunMemoryContext(
      env,
      runInput,
      { attemptId: "attempt-owner", owner: "lease-owner" },
      "a different retry query",
    );
    expect(replay).toEqual(first);
    expect(() => database.prepare(
      "UPDATE harness_run_memory_contexts SET query_text = 'mutated' WHERE harness_run_id = ?",
    ).run(RUN_ONE)).toThrow(/harness_run_memory_context_immutable/u);
  });
});
