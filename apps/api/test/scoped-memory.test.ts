import { readFileSync } from 'node:fs';
import { asAutomationId, asHarnessRunId, asSubstreamId, asUserId, asWorkstreamId } from "@rally/contracts";
import { asWorkspaceId } from "@rally/contracts";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkstreamWorkflowInput } from "@rally/contracts";
import type { Env } from "../src/env";
import {
  createMemoryTools,
  resolveMemoryAccess,
  writableScope,
  type MemoryScope,
} from "../src/services/memory-service";
import { WorkspaceDO } from "../src/durable-objects/workspace-do";
import { createMemoryTableTools } from "../src/services/memory-table-service";
import { readStructuredFailure } from "@rally/contracts";
import { validateToolArguments } from "@rally/agent-harness";
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";
import { createTestWorkspaceDO, workspaceObjectRpcs } from "./helpers/workspace-object-rpcs";
import {
  seedWorkstreamObjectRoot,
  seedWorkstreamRun,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
  applyWorkstreamObjectRootFields,
} from "./helpers/durable-authority";
import { preRetirementProductSqliteDatabase } from "./helpers/sqlite-d1";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-000000000001");
const OWNER_ID = asUserId("00000000-0000-4000-8000-000000000002");
const MEMBER_ID = asUserId("00000000-0000-4000-8000-000000000003");
const WORKSTREAM_ONE = asWorkstreamId("00000000-0000-4000-8000-000000000011");
const WORKSTREAM_TWO = asWorkstreamId("00000000-0000-4000-8000-000000000012");
const AUTOMATION_ONE = asAutomationId("00000000-0000-4000-8000-000000000013");
const AUTOMATION_TWO = asAutomationId("00000000-0000-4000-8000-000000000014");
const RUN_ONE = asHarnessRunId("00000000-0000-4000-8000-000000000021");
const RUN_TWO = asHarnessRunId("00000000-0000-4000-8000-000000000022");
const AUTOMATION_RUN_ONE = asHarnessRunId("00000000-0000-4000-8000-000000000023");
const AUTOMATION_RUN_TWO = asHarnessRunId("00000000-0000-4000-8000-000000000024");
/** An automation run's id, which is also its child substream under the automation. */
const AUTOMATION_CHILD_ONE = "00000000-0000-4000-8000-000000000041";
const AUTOMATION_CHILD_TWO = "00000000-0000-4000-8000-000000000042";

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

const openDatabases: DatabaseSync[] = [];
/** Per-workstream object databases; run rows and run receipts live here. */
const objectStores = new Map<string, DatabaseSync>();

afterEach(() => {
  vi.unstubAllGlobals();
  objectStores.clear();
  for (const database of openDatabases.splice(0)) database.close();
});

/**
 * The execution environment the harness hands a run's tools. Run facts travel
 * through typed object ports while workspace memory tables stay regional.
 */
function routedEnv(env: Env, runInput: WorkstreamWorkflowInput): Env {
  const store = objectStores.get(runInput.parentId);
  if (!store) throw new Error(`no object store for ${runInput.parentId}`);
  return env;
}

/** The typed WorkspaceDO methods the memory services call. */
const MEMORY_OBJECT_METHODS = [
  "ensureMemoryScope",
  "memoryTableWithColumns",
  "searchMemoryTables",
  "queryMemoryTableRows",
  "memoryTableRowsById",
  "memoryTableMutationReceipt",
  "createMemoryTable",
  "insertMemoryTableRows",
  "updateMemoryTableRows",
  "invalidateMemoryTableRows",
] as const;

function fixture(): {
  database: DatabaseSync;
  /** The real WorkspaceDO's own database — where memory rows now live. */
  objectDatabase: DatabaseSync;
  env: Env;
  /**
   * An env whose named WorkspaceDO method runs `mutate` first, once — the
   * seam for racing a competing writer between the service's read and the
   * object's transactional compare-and-set.
   */
  withMethodRace: (method: (typeof MEMORY_OBJECT_METHODS)[number], mutate: () => void) => Env;
} {
  const database = preRetirementProductSqliteDatabase();
  // Product rows retain the legacy import dialect, but membership mutations
  // exercise today's regional authority, including incarnation fences.
  database.exec(readFileSync(new URL('../../../packages/db/migrations/0109_workspace_guest_relationships.sql', import.meta.url), 'utf8'));
  openDatabases.push(database);
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
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, last_activity_at, created_at, updated_at)
    VALUES
      ('${WORKSTREAM_ONE}', '${WORKSPACE_ID}', 'Owner task', 'Remember preferences', 'ad_hoc',
       '${OWNER_ID}', 'running', '2026-01-01', '2026-01-01', '2026-01-01'),
      ('${WORKSTREAM_TWO}', '${WORKSPACE_ID}', 'Member task', 'Keep users isolated', 'ad_hoc',
       '${MEMBER_ID}', 'running', '2026-01-01', '2026-01-01', '2026-01-01');
  `);
  // Since migration 0090 each run row lives only in its parent's own object;
  // the fixture opens the two work streams and writes the runs through the
  // same compat port the harness uses.
  const runsByWorkstream: Array<[string, string, string, string, string]> = [
    [WORKSTREAM_ONE, RUN_ONE, JSON.stringify({ type: "user", userId: OWNER_ID }), "attempt-owner", "lease-owner"],
    [WORKSTREAM_TWO, RUN_TWO, JSON.stringify({ type: "user", userId: MEMBER_ID }), "attempt-member", "lease-member"],
  ];
  for (const [workstreamId, runId, principalJson, attemptId, leaseOwner] of runsByWorkstream) {
    const store = testWorkstreamObjectStore();
    openDatabases.push(store);
    seedWorkstreamObjectRoot(store, { workstreamId, workspaceId: WORKSPACE_ID });
    const directory = database.prepare(
      "SELECT title, objective, origin_type, created_by_user_id FROM workstreams WHERE id = ?",
    ).get(workstreamId) as {
      title: string;
      objective: string;
      origin_type: string;
      created_by_user_id: string | null;
    };
    applyWorkstreamObjectRootFields(store, {
      title: directory.title,
      description: directory.objective,
      originType: directory.origin_type,
      createdByUserId: directory.created_by_user_id,
      exactState: "running",
    });
    seedWorkstreamRun(store, { id: runId, executionPrincipalJson: principalJson,
      attemptId, attemptEpoch: 1, leaseOwner,
      leaseExpiresAt: Date.parse("2099-01-01T00:00:00.000Z"),
      heartbeatAt: Date.parse("2026-01-01") });
    objectStores.set(workstreamId, store);
  }
  // An automation is a conversation parent of its own, and a run is a child
  // substream under it: the run row lives in the automation's object, keyed by
  // the run id the loop input names as its substream. The first automation
  // runs as its author, the second as the workspace, because the union has to
  // come out the same either way.
  const runsByAutomation: Array<[string, string, string, string, string, string]> = [
    [AUTOMATION_ONE, AUTOMATION_CHILD_ONE, AUTOMATION_RUN_ONE,
      JSON.stringify({ type: "user", userId: OWNER_ID }), "attempt-auto-one", "lease-auto-one"],
    [AUTOMATION_TWO, AUTOMATION_CHILD_TWO, AUTOMATION_RUN_TWO,
      JSON.stringify({ type: "workspace", workspaceId: WORKSPACE_ID }), "attempt-auto-two", "lease-auto-two"],
  ];
  for (const [automationId, childId, runId, principalJson, attemptId, leaseOwner] of runsByAutomation) {
    const store = testWorkstreamObjectStore();
    openDatabases.push(store);
    seedWorkstreamObjectRoot(store, {
      workstreamId: automationId,
      workspaceId: WORKSPACE_ID,
      title: automationId === AUTOMATION_ONE ? "Automation one" : "Automation two",
      description: "Remember across runs",
      exactState: "running",
    });
    seedWorkstreamRun(store, { id: runId, substreamId: childId, executionPrincipalJson: principalJson,
      attemptId, attemptEpoch: 1, leaseOwner,
      leaseExpiresAt: Date.parse("2099-01-01T00:00:00.000Z"),
      heartbeatAt: Date.parse("2026-01-01") });
    objectStores.set(automationId, store);
  }
  // Memory rows live in WorkspaceDO now, so the suite stands up the real
  // object over its own schema and exposes its typed methods as stub RPCs.
  // Only the transport is doubled; re-implementing a method here would move
  // the behaviour under test into the test.
  const workspaceObject = createTestWorkspaceDO({
    workspaceId: WORKSPACE_ID,
    regionalDatabase: database,
    register: (created) => { openDatabases.push(created); },
  });
  const memoryRpcs = workspaceObjectRpcs(workspaceObject.instance, [...MEMORY_OBJECT_METHODS, 'publishSync', 'listSearchAuthorizationSnapshots',
    'enumerateSearchAuthorization', 'registerSearchAuthorization', 'revokeSocketAccess', 'applyMemberStatus']);
  const envWith = (rpcs: Record<string, unknown>): Env => createTestEnv({
    DB: sqliteD1(database),
    ACCESS_REVOCATION_QUEUE: { send: async () => undefined, sendBatch: async () => undefined },
    // Scope resolution reads the run through the harness-run authority, so
    // this fixture needs the object namespace as well as the SQL callback
    // below. Both reach the same per-work-stream store.
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
    WORKSPACE_DOS: testSubstreamAgentsBinding(database, { extra: rpcs }),
    AVALON_REGION: "global",
    APP_ENV: "test",
    LOG_LEVEL: "error",
    PUBLIC_WEB_BASE_URL: "https://rallywith.ai",
    OPENROUTER_API_KEY: "test-openrouter-key",
  });
  return {
    database,
    objectDatabase: workspaceObject.objectDatabase,
    env: envWith(memoryRpcs),
    withMethodRace: (method, mutate) => {
      let intercepted = false;
      return envWith({
        ...memoryRpcs,
        [method]: (...args: unknown[]) => {
          if (!intercepted) {
            intercepted = true;
            mutate();
          }
          return (memoryRpcs[method] as (...called: unknown[]) => unknown)(...args);
        },
      });
    },
  };
}

function input(
  user: "owner" | "member" | "workspace" = "owner",
  automationRun: 1 | 2 | null = null,
): WorkstreamWorkflowInput {
  if (automationRun) {
    const automationId = automationRun === 1 ? AUTOMATION_ONE : AUTOMATION_TWO;
    const childId = automationRun === 1 ? AUTOMATION_CHILD_ONE : AUTOMATION_CHILD_TWO;
    return {
      region: "global",
      workspaceId: WORKSPACE_ID,
      parentKind: "automation",
      parentId: automationId,
      substreamId: asSubstreamId(childId),
      loopId: `workstream:${automationId}:substream:${childId}:loop`,
      harnessRunId: automationRun === 1 ? AUTOMATION_RUN_ONE : AUTOMATION_RUN_TWO,
      triggerMessageId: null,
      activityId: null,
      executionPrincipal: automationRun === 1
        ? { type: "user", userId: OWNER_ID }
        : { type: "workspace", workspaceId: WORKSPACE_ID },
      reason: "automation",
      automationRun: {
        schemaVersion: 1,
        automationId,
        runId: childId,
        definitionRevision: 1,
        trigger: { kind: "manual", requestedByUserId: OWNER_ID },
      },
    };
  }
  const owner = user === "owner";
  return {
    region: "global",
    workspaceId: WORKSPACE_ID,
    parentKind: "workstream",
    parentId: owner ? WORKSTREAM_ONE : WORKSTREAM_TWO,
    loopId: `workstream:${owner ? WORKSTREAM_ONE : WORKSTREAM_TWO}:substream:0:loop`,
    harnessRunId: owner ? RUN_ONE : RUN_TWO,
    triggerMessageId: null,
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
    workstreamId: runInput.parentId,
    harnessRunId: runInput.harnessRunId,
    toolCallId: receipt,
    providerIdempotencyKey: receipt,
    executionPrincipal: runInput.executionPrincipal,
    signal: new AbortController().signal,
  };
}

function tableTool(env: Env, runInput: WorkstreamWorkflowInput, name: string) {
  const tool = createMemoryTableTools(routedEnv(env, runInput), runInput)
    .find((candidate) => candidate.definition.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

describe("memory scopes and durable tables", () => {
  it("derives the complete scope union and never exposes search scope selectors", async () => {
    const { env } = fixture();
    const ownerScopes = await resolveMemoryAccess(routedEnv(env, input("owner")), input("owner"));
    expect(ownerScopes.map((scope) => scope.kind)).toEqual(["workspace", "user", "workstream"]);
    expect(ownerScopes.find((scope) => scope.kind === "workspace")?.ownerId).toBe(WORKSPACE_ID);

    // The run's tools never carry a scope selector: the three memory tools
    // take a query, a fact, or a fact id, and nothing that names where to look.
    for (const tool of createMemoryTools(routedEnv(env, input("owner")), input("owner"))) {
      expect(Object.keys((tool.definition.inputSchema as { properties: object }).properties)).not.toContain("scopes");
      expect(Object.keys((tool.definition.inputSchema as { properties: object }).properties)).not.toContain("scopeKind");
    }
  });

  it("gives an automation run the workspace scope and its automation's own, and nothing personal", async () => {
    const { env } = fixture();
    // Automation one runs as its author. The author's own memory stays out of
    // the union all the same: a run acts for the automation rather than as the
    // person, so what it learns belongs to every later run of that automation
    // and not to the person's other conversations.
    const runInput = input("owner", 1);
    const scopes = await resolveMemoryAccess(routedEnv(env, runInput), runInput);
    expect(scopes.map((scope) => [scope.kind, scope.ownerId, scope.writable])).toEqual([
      ["workspace", WORKSPACE_ID, true],
      ["sidekick", AUTOMATION_ONE, true],
    ]);
    // A work-stream run keeps the shape it had: the person's scope and the
    // work stream's, on top of the workspace's.
    const workstreamRun = input("owner");
    expect((await resolveMemoryAccess(routedEnv(env, workstreamRun), workstreamRun)).map((scope) => scope.kind))
      .toEqual(["workspace", "user", "workstream"]);
    // The table tools still offer every kind, so asking for the one this run
    // cannot reach is the resolver's refusal, naming what it can write.
    await expect(writableScope(routedEnv(env, runInput), runInput, "user")).rejects.toMatchObject({
      code: "memory_scope_not_available",
      message: expect.stringContaining("Its scopes are: sidekick, workspace"),
    });
  });
  });

  it("asks the WorkspaceDO for each scope once, and decides writability on every call", async () => {
    const ensure = vi.spyOn(WorkspaceDO.prototype, "ensureMemoryScope");
    try {
      const { env } = fixture();
      const workspaceScope = (scopes: readonly MemoryScope[]) => scopes.find((scope) => scope.kind === "workspace");
      const owner = await resolveMemoryAccess(env, input("owner"));
      expect(ensure).toHaveBeenCalledTimes(3);
      expect(await resolveMemoryAccess(env, input("owner"))).toEqual(owner);
      expect(ensure).toHaveBeenCalledTimes(3);
      // The member reads the same workspace scope, but only an owner may write it.
      const member = await resolveMemoryAccess(env, input("member"));
      expect(ensure).toHaveBeenCalledTimes(5);
      expect(workspaceScope(owner)?.writable).toBe(true);
      expect(workspaceScope(member)).toEqual({ ...workspaceScope(owner), writable: false });
    } finally {
      ensure.mockRestore();
    }
  });

  it("updates table metadata without touching rows and gives schema conflicts an actionable recovery", async () => {
    const { env } = fixture();
    const run = input("owner");
    const declaration = {
      scopeKind: "workspace", name: "Tracked URLs", description: "Original description",
      usageInstructions: "Original instructions", rationale: "Track sources",
      columns: [
        { name: "url", description: "Original URL description", type: "url", required: true, searchable: false },
        { name: "title", description: "Original title", type: "string", required: false, searchable: true },
      ],
      keyColumns: ["url"],
    };
    const created = await tableTool(env, run, "create").execute(declaration, toolContext(run, "metadata-create"));
    const memoryTableId = (created.output as { memoryTableId: string }).memoryTableId;
    const inserted = await tableTool(env, run, "insert_rows").execute({ memoryTableId,
      rows: [{ url: "https://example.com/kept", title: "Keep this row" }], rationale: "Retain evidence",
    }, toolContext(run, "metadata-insert"));
    const changed = { ...declaration, description: "Updated description", usageInstructions: "Updated instructions",
      columns: [...declaration.columns].reverse().map((column) => ({ ...column, description: "Updated column metadata" })),
    };
    const reopened = await tableTool(env, run, "create").execute(changed, toolContext(run, "metadata-update"));
    expect(reopened.output).toMatchObject({ memoryTableId, description: "Updated description",
      usageInstructions: "Updated instructions", schemaRevision: 1, dataRevision: 1,
      columns: [
        { name: "url", description: "Updated column metadata" },
        { name: "title", description: "Updated column metadata" },
      ],
    });
    expect(await tableTool(env, run, "create").execute(changed, toolContext(run, "metadata-update")))
      .toMatchObject({ output: reopened.output });
    const query = await tableTool(env, run, "query").execute({ memoryTableId }, toolContext(run, "metadata-query"));
    expect(query.output).toMatchObject({ rows: [{ values: { url: "https://example.com/kept", title: "Keep this row" }, revision: 1 }] });
    expect(inserted.output).toMatchObject({ insertedCount: 1 });
    const conflict = await tableTool(env, run, "create").execute({ ...changed,
      columns: [{ ...changed.columns[0], required: true }, changed.columns[1]],
    }, toolContext(run, "metadata-conflict")).catch((error: unknown) => error);
    expect(conflict).toMatchObject({
      code: "memory_table_name_schema_conflict",
      details: { field: "columns.0.required", retryable: false,
        reason: expect.stringContaining(JSON.stringify(memoryTableId)),
      },
    });
    // Assert the recovery envelope Bind actually forwards to the agent.
    expect(readStructuredFailure(conflict)).toEqual({ code: "memory_table_name_schema_conflict", details: {
      field: "columns.0.required", retryable: false,
      reason: `Call table_describe with memoryTableId "${memoryTableId}"; reuse its columns and ordered keyColumns. Metadata may change. For a different schema, use a new table name and explicitly copy/transform rows. Do not retry unchanged or delete existing data.`,
    } });
    for (const [suffix, columns, keyColumns, fields] of [
      ["type", [{ ...declaration.columns[0], type: "string" }, declaration.columns[1]], ["url"], ["columns.0.type"]],
      ["searchable", [{ ...declaration.columns[0], searchable: true }, declaration.columns[1]], ["url"], ["columns.0.searchable"]],
      ["keys", declaration.columns, ["title", "url"], ["keyColumns"]],
    ] as const) {
      const rejected = await tableTool(env, run, "create").execute({ ...declaration, columns, keyColumns }, toolContext(run, `schema-${suffix}`))
        .catch((error: unknown) => error);
      expect(readStructuredFailure(rejected)).toMatchObject({ code: "memory_table_name_schema_conflict", details: {
        field: fields[0], retryable: false, reason: expect.stringContaining(JSON.stringify(memoryTableId)),
      } });
    }
    const described = await tableTool(env, run, "describe").execute({ memoryTableId }, toolContext(run, "metadata-describe"));
    expect(described.output).toMatchObject({ description: "Updated description", dataRevision: 1,
      columns: [{ name: "url", required: true }, { name: "title", required: false }],
    });
  });

  it("shares workspace tables across runs and queries only matching projected rows", async () => {
    const { env } = fixture();
    // The owner's run creates and mutates; the member's run reads. Before the
    // automation cutover this test shared an automation scope across two runs
    // of one subscription; the workspace scope is the shared scope that
    // remains, and only an owner or admin may write it.
    const firstRun = input("owner");
    const secondRun = input("member");
    const created = await tableTool(env, firstRun, "create").execute({
      scopeKind: "workspace",
      name: "Seen blog entries",
      description: "One row per blog entry discovered by this workspace.",
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
    // `memory_table_insert_contention` is deliberately not exercised any more:
    // the insert is one WorkspaceDO transaction now, so the bounded-retry loop
    // that error named no longer exists to lose.
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
      tables: [expect.objectContaining({ memoryTableId, scopeKind: "workspace" })],
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
    });

    const launchRow = (queried.output as {
      rows: Array<{ memoryTableRowId: string; revision: number }>;
    }).rows[0]!;
    // Reading the shared table does not confer writing it: the member's run
    // holds the workspace scope read-only.
    await expect(tableTool(env, secondRun, "update_rows").execute({
      memoryTableId,
      rows: [{
        memoryTableRowId: launchRow.memoryTableRowId,
        expectedRevision: 1,
        values: { reported: true },
      }],
      rationale: "Member cannot write workspace tables",
    }, toolContext(secondRun, "member-mark-reported"))).rejects.toThrow("memory_scope_not_writable:workspace");
    await tableTool(env, firstRun, "update_rows").execute({
      memoryTableId,
      rows: [{
        memoryTableRowId: launchRow.memoryTableRowId,
        expectedRevision: 1,
        values: { reported: true, title: "Launch notes revised" },
      }],
      rationale: "Delivery completed",
    }, toolContext(firstRun, "mark-reported"));
    await expect(tableTool(env, firstRun, "update_rows").execute({
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
    const nextCursor = updated.pagination!.continuations[0]!.input.cursor;
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
    const tableTools = createMemoryTableTools(env, runInput);
    const tableQueryDefinition = tableTools.find((tool) => tool.definition.name === "query")?.definition;

    expect(tableQueryDefinition?.description).toContain("memoryTableRowIds");
    for (const name of ["update_rows", "invalidate_rows"]) {
      const definition = tableTools.find((tool) => tool.definition.name === name)?.definition;
      expect(definition?.description).toContain("table_query with memoryTableRowIds");
      expect(JSON.stringify(definition?.inputSchema)).toContain("table_query for this memoryTableRowId");
    }
  });

  it("normalizes post-read CAS races for table mutations", async () => {
    const { objectDatabase, env, withMethodRace } = fixture();
    const runInput = input("owner");

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

    await expect(tableTool(withMethodRace("updateMemoryTableRows", () => {
      objectDatabase.prepare("UPDATE memory_table_rows SET revision = revision + 1 WHERE memory_table_row_id = ?")
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

    await expect(tableTool(withMethodRace("invalidateMemoryTableRows", () => {
      objectDatabase.prepare("UPDATE memory_table_rows SET revision = revision + 1 WHERE memory_table_row_id = ?")
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

  it("tells the model table_search's query bound rather than only enforcing it", async () => {
    const { env } = fixture();
    const search = tableTool(env, input("owner"), "search");
    const tooLong = { query: "a".repeat(2_001) };

    // The bound the executor has always enforced, now also declared. Asserted
    // through `validateToolArguments` — the harness's own reader of the
    // published schema — because that is the function whose verdict decides
    // whether a rejected call is reported to the model as its arguments or
    // filed as the tool's own data problem. While the schema said only
    // `string`, it saw nothing wrong and the model was told to retry the same
    // 2001-character query.
    expect(validateToolArguments(tooLong, search.definition.inputSchema)).not.toBeNull();
    expect(validateToolArguments({ query: "a".repeat(2_000) }, search.definition.inputSchema)).toBeNull();
    // What the hook uniquely catches, now that the bound is declared: the
    // declared schema has no notion of `.trim()`, so whitespace satisfies
    // `minLength: 1` and is refused only by the executor's parse.
    const blank = { query: "   " };
    expect(validateToolArguments(blank, search.definition.inputSchema)).toBeNull();
    expect(search.validateInput?.(blank)).not.toBeNull();
    expect(search.validateInput?.(tooLong)).not.toBeNull();
    await expect(search.execute(tooLong, toolContext(input("owner"), "table-search-too-long"))).rejects.toThrow();
  });
