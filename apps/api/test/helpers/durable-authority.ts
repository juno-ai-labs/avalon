import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";

import { applyWorkstreamObjectSchema } from "../../src/durable-objects/workstream-object-schema";
import {
  BLOCK_DASHBOARD_OPERATIONS,
  type BlockDashboardObjectPort,
  type BlockDashboardOperation,
} from "../../src/durable-objects/workstream-block-dashboard-protocol";
import { WorkstreamBlockDashboardStorage } from "../../src/durable-objects/workstream-block-dashboard-storage";
import {
  TOOL_RECEIPT_OPERATIONS,
  type ToolReceiptObjectPort,
  type ToolReceiptOperation,
} from "../../src/durable-objects/workstream-tool-receipt-protocol";
import { WorkstreamMessageStorage } from "../../src/durable-objects/workstream-message-storage";
import {
  MESSAGE_OPERATIONS,
  type MessageObjectPort,
} from "../../src/durable-objects/workstream-message-protocol";
import { WorkstreamHarnessRunStorage } from "../../src/durable-objects/workstream-harness-run-storage";
import {
  HARNESS_RUN_OPERATIONS,
  type HarnessRunObjectPort,
} from "../../src/durable-objects/workstream-harness-run-protocol";
import { WorkstreamIdentityStorage } from "../../src/durable-objects/workstream-identity-storage";
import { WorkstreamResourceStorage } from "../../src/durable-objects/workstream-resource-storage";
import {
  RESOURCE_OPERATIONS,
  type ResourceObjectPort,
  type ResourceOperation,
} from "../../src/durable-objects/workstream-resource-protocol";
import { WorkstreamSchedulingStorage } from "../../src/durable-objects/workstream-scheduling-storage";
import {
  SCHEDULING_OPERATIONS,
  type SchedulingObjectPort,
  type SchedulingOperation,
} from "../../src/durable-objects/workstream-scheduling-protocol";
import { WorkstreamToolReceiptStorage } from "../../src/durable-objects/workstream-tool-receipt-storage";
import { WorkstreamTerminalStorage } from "../../src/durable-objects/workstream-terminal-storage";
import {
  createTerminalPortFactory,
  type TerminalOperationExecutor,
  type TerminalPortFactory,
} from "../../src/services/terminal/object-port";
import {
  rewriteWorkstreamRuntimeSql,
  type WorkstreamRuntimeSqlResult,
} from "../../src/durable-objects/workstream-runtime-sql";
import { workstreamRuntimeDatabase } from "../../src/services/workstream-runtime-database";
import { createCloudflareTestBinding, createTestDurableObjectId, createTestEnv } from "./cloudflare-test";
import { createTestSqlStorage } from "./sql-storage";

/**
 * Walk the regional cutover ledger to `durable_object_open` the way the
 * campaign does — the phase transitions are trigger-enforced, so a test cannot
 * simply UPDATE straight to the open phase — and then disarm the post-cutover
 * D1 fences.
 *
 * The fences exist to abort object-owned statements that leak back to D1. A
 * unit test that pairs this helper with {@link testSubstreamAgentsBinding}
 * carries those statements through the runtime SQL port into a real object
 * database, so the fences would only re-refuse regional bookkeeping writes
 * (`artifacts`, effect receipts) that production performs from inside the
 * objects. Tests that arm the fences on purpose (to prove a statement does not
 * leak) should skip this helper's disarm, as `slack-thread-audience.test.ts`
 * does.
 */
export function openWorkstreamAuthorityForTest(
  database: DatabaseSync,
  at = "2026-01-02T00:00:00.000Z",
): void {
  database.exec(`
    UPDATE workstream_authority_control SET phase = 'maintenance_draining', generation = 1, updated_at = '${at}' WHERE id = 1;
    UPDATE workstream_authority_control SET phase = 'maintenance_importing', updated_at = '${at}' WHERE id = 1;
    UPDATE workstream_authority_routes SET state = 'verified', updated_at = '${at}';
    UPDATE workspace_product_authority_routes SET state = 'verified', updated_at = '${at}';
    UPDATE workstream_authority_control SET phase = 'maintenance_verified', updated_at = '${at}' WHERE id = 1;
    UPDATE workstream_authority_routes SET state = 'active', activated_at = '${at}', updated_at = '${at}';
    UPDATE workspace_product_authority_routes SET state = 'active', updated_at = '${at}';
    UPDATE workstream_authority_control SET phase = 'durable_object_open', serving_contract_version = 1, updated_at = '${at}' WHERE id = 1;
  `);
  const fences = database.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'trigger' AND (
       name LIKE '%reject_do_authority%'
       OR name LIKE '%reject_workspace_do%'
       OR name LIKE '%reject_post_cutover%'
     )`,
  ).all() as Array<{ name: string }>;
  for (const { name } of fences) database.exec(`DROP TRIGGER "${String(name)}"`);
}

/**
 * The workerd-shaped SqlStorage adapter for an object database, one per
 * DatabaseSync so cursor bookkeeping (`rowsWritten`) and the foreign-key
 * pragma are applied exactly once.
 */
const objectSqlStorages = new WeakMap<DatabaseSync, SqlStorage>();

function objectSqlStorage(database: DatabaseSync): SqlStorage {
  let sql = objectSqlStorages.get(database);
  if (!sql) {
    sql = createTestSqlStorage(database);
    objectSqlStorages.set(database, sql);
  }
  return sql;
}

/**
 * A real WorkstreamDO object database: the object schema (normalized tables
 * plus the `_runtime_*` compatibility views) applied over node:sqlite with
 * workerd semantics, including enforced foreign keys. This is the store the
 * runtime SQL port executes against in production; migration 0090 dropped the
 * D1 copies of every table the port serves, so tests can no longer stand a
 * migrated regional database in for it.
 *
 * The root identity row is not seeded here — {@link seedWorkstreamObjectRoot}
 * does that, and {@link testSubstreamAgentsBinding} seeds lazily from the ids
 * on each routed request. The caller owns closing the database, exactly like
 * every other test database.
 */
export function testWorkstreamObjectStore(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  const sql = objectSqlStorage(database);
  applyWorkstreamObjectSchema(
    createCloudflareTestBinding<DurableObjectStorage>({
      getAlarm: async () => null,
      setAlarm: async () => undefined,
      transactionSync: (body: () => unknown) => body(),
      sql,
    }),
    "durable-authority-test",
    Date.parse("2026-01-02T00:00:00.000Z"),
  );
  return database;
}

/**
 * What a fixture says a work stream *is*, in the object's own columns.
 *
 * Every field is optional and every name is the object's, not the retired
 * `_runtime_workstreams` view's: `description` rather than `objective`,
 * `exactState` rather than the `harnessStatus` bucket, unix milliseconds
 * rather than ISO-8601. A fixture that wants the published shape crosses at
 * its own assertion, which is where the two vocabularies meet everywhere else.
 */
export interface WorkstreamObjectRootFields {
  title?: string;
  description?: string;
  descriptionSource?: "authored" | "derived";
  titleStatus?: "naming" | "automatic" | "settled";
  scope?: "personal" | "workspace";
  exactState?: string;
  stateReasonCode?: string;
  originType?: string;
  systemKind?: string | null;
  createdByUserId?: string | null;
  automationSubscriptionId?: string | null;
  automationRunId?: string | null;
  createdFromOpportunityId?: string | null;
  plannedFor?: number | null;
  emailAddress?: string | null;
  emailRouteStatus?: string;
  modelOverride?: string | null;
  archivedAt?: number | null;
  nextSequenceNumber?: number;
  nextAttentionOrdinal?: number;
  lastPeopleActivityAt?: number;
}

/**
 * Give the object the identity root and main substream every operation
 * requires: the storage classes read `workstream` id = 1 for the workspace and
 * workstream keys, and run rows hang off substream '0'. Mirrors the workerd
 * fixture in `test-workers/helpers/substream-fixture.ts`, which cannot be
 * imported from the node-side suite.
 *
 * Product state is stated here rather than written by a second statement.
 * Fixtures used to seed this root and then `INSERT INTO workstreams (…)`,
 * letting the compatibility trigger translate the old vocabulary into an
 * `UPDATE` of the row that had just been created — two statements for one
 * fact, and the reason nineteen call sites named a view instead of a table.
 * With the view retired there is nothing to translate, so the fixture says
 * what it means. Same shape and same reasoning as {@link seedToolReceipt}.
 *
 * The identity keys stay idempotent: an existing root keeps its workspace and
 * workstream ids so a mismatch surfaces instead of being overwritten. Product
 * fields are applied on every call, because a fixture that states them is
 * describing the work stream it wants rather than racing another writer.
 */
export function seedWorkstreamObjectRoot(
  database: DatabaseSync,
  ids: { workstreamId: string; workspaceId: string } & WorkstreamObjectRootFields,
  now = Date.parse("2026-01-02T00:00:00.000Z"),
): void {
  database.prepare(
    `INSERT INTO workstream (
       id, workstream_key, parent_workspace_key, parent_do_id, parent_generation, region,
       authority_mode, authority_generation, title, description, preview, scope,
       exact_state, state_reason_code, next_sequence_number, next_attention_ordinal,
       unread_tracking_start_ordinal, authority_epoch, scope_epoch,
       source_authorization_floor, listing_epoch, deletion_epoch, run_revision,
       created_at, last_people_activity_at, state_changed_at, updated_at
     ) VALUES (
       1, ?, ?, NULL, 0, 'global',
       'authoritative', 1, 'Fixture', '', '', 'workspace',
       'idle', 'seeded', 1, 1,
       0, 0, 0,
       0, 0, 0, 0,
       ?, ?, ?, ?
     ) ON CONFLICT(id) DO NOTHING`,
  ).run(ids.workstreamId, ids.workspaceId, now, now, now, now);
  database.prepare(
    `INSERT INTO substreams
       (id, kind, inherit_mode, depth, return_mode, audience, tool_policy, status, created_at)
     VALUES ('0', 'main', 'none', 0, 'none', 'workspace', 'full', 'open', ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(now);
  database.prepare(
    `INSERT INTO substream_agent_identity (id, external_substream_id, created_at, updated_at)
     VALUES (1, '0', ?, ?) ON CONFLICT(id) DO NOTHING`,
  ).run(now, now);
  applyWorkstreamObjectRootFields(database, ids, now);
}

/** The object columns each fixture field writes, in one place. */
const ROOT_FIELD_COLUMNS: ReadonlyArray<[keyof WorkstreamObjectRootFields, string]> = [
  ["title", "title"],
  ["description", "description"],
  ["descriptionSource", "description_source"],
  ["titleStatus", "title_status"],
  ["scope", "scope"],
  ["exactState", "exact_state"],
  ["stateReasonCode", "state_reason_code"],
  ["originType", "origin_type"],
  ["systemKind", "system_kind"],
  ["createdByUserId", "created_by_user_id"],
  ["automationSubscriptionId", "automation_subscription_id"],
  ["automationRunId", "automation_run_id"],
  ["createdFromOpportunityId", "created_from_opportunity_id"],
  ["plannedFor", "planned_for"],
  ["emailAddress", "email_address"],
  ["emailRouteStatus", "email_route_status"],
  ["modelOverride", "model_override"],
  ["archivedAt", "archived_at"],
  ["nextSequenceNumber", "next_sequence_number"],
  ["nextAttentionOrdinal", "next_attention_ordinal"],
  ["lastPeopleActivityAt", "last_people_activity_at"],
];

/**
 * Write the product fields a fixture stated onto an already-seeded root.
 *
 * Exported so a test can move a work stream mid-run — a title settling, a work
 * stream being archived — without restating the identity it was seeded with.
 * `undefined` leaves a column alone; `null` writes NULL, which is the whole
 * point for the nullable ones.
 */
export function applyWorkstreamObjectRootFields(
  database: DatabaseSync,
  fields: WorkstreamObjectRootFields,
  now = Date.parse("2026-01-02T00:00:00.000Z"),
): void {
  const assignments: string[] = [];
  const values: Array<string | number | null> = [];
  for (const [field, column] of ROOT_FIELD_COLUMNS) {
    const value = fields[field];
    if (value === undefined) continue;
    assignments.push(`${column} = ?`);
    values.push(value);
  }
  if (assignments.length === 0) return;
  database.prepare(
    `UPDATE workstream SET ${assignments.join(", ")}, updated_at = ? WHERE id = 1`,
  ).run(...values, now);
}

/**
 * Seat one participant, in the object's own vocabulary.
 *
 * The retired `_runtime_workstream_participants` view renamed nothing but
 * `joined_at`, and invented `status` and `participant_epoch` — two `NOT NULL`
 * columns the old vocabulary never carried, which its trigger filled in. With
 * the view gone the invention happens here, once, where it can be read.
 */
export function seedWorkstreamObjectParticipant(
  database: DatabaseSync,
  participant: {
    userId: string;
    participationReason?: "creator" | "explicit" | "message" | "elicitation" | "action";
    addedByUserId?: string | null;
    addedAt?: number;
    removedAt?: number | null;
  },
  now = Date.parse("2026-01-02T00:00:00.000Z"),
): void {
  const addedAt = participant.addedAt ?? now;
  const removedAt = participant.removedAt ?? null;
  database.prepare(
    `INSERT INTO participants
       (user_id, participation_reason, added_by_user_id, status, participant_epoch,
        added_at, removed_at, first_opened_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, NULL, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       participation_reason = excluded.participation_reason,
       added_by_user_id = excluded.added_by_user_id,
       status = excluded.status,
       added_at = excluded.added_at,
       removed_at = excluded.removed_at,
       updated_at = excluded.updated_at`,
  ).run(
    participant.userId,
    participant.participationReason ?? "explicit",
    participant.addedByUserId ?? participant.userId,
    removedAt === null ? "active" : "removed",
    addedAt,
    removedAt,
    now,
  );
}

/** The root row a fixture wrote, in the object's own columns. */
export function workstreamObjectRootRow<T extends Record<string, string | number | null>>(
  database: DatabaseSync,
  columns: string,
): T {
  return database.prepare(`SELECT ${columns} FROM workstream WHERE id = 1`).get() as T;
}

/** The seated participants a fixture wrote, oldest first. */
export function workstreamObjectParticipantRows<
  T extends Record<string, string | number | null>,
>(database: DatabaseSync, columns = "user_id, participation_reason, added_by_user_id, added_at, removed_at"): T[] {
  return database.prepare(
    `SELECT ${columns} FROM participants ORDER BY added_at, user_id`,
  ).all() as T[];
}

/**
 * Seed one tool receipt in the object's own vocabulary.
 *
 * Fixtures used to write `tool_invocations` and let the compatibility trigger
 * translate — and invent the five `NOT NULL` columns the old vocabulary never
 * carried. With the view retired there is nothing to translate, so the
 * invention happens here, once, where it can be read. Note `status`: the view
 * spelled the first two `pending` and `started`; the object has only ever
 * stored `admitted` and `executing`.
 */
export function seedToolReceipt(
  database: DatabaseSync,
  receipt: {
    id: string;
    runId: string;
    toolCallId: string;
    toolName: string;
    status?: "admitted" | "executing" | "completed" | "failed" | "ambiguous";
    mode?: "read" | "write";
    position?: number;
    requestHash?: string;
    inputJson?: string;
    outputRef?: string | null;
    outputSummary?: string | null;
    executionPlanJson?: string | null;
    startedAt?: number | null;
    settledAt?: number | null;
    checkpointIndex?: number;
  },
): void {
  database.prepare(
    `INSERT INTO tool_effects
       (effect_intent_id, run_id, attempt_epoch, tool_position, occurrence_key, tool_name,
        mode, request_hash, authority_revision, status, tool_call_id, input_json,
        output_ref, output_summary, execution_plan_json, started_at, settled_at,
        checkpoint_index)
     VALUES (?, ?, 0, ?, ?, ?, ?, ?, 'runtime', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    receipt.id,
    receipt.runId,
    receipt.position ?? 0,
    `runtime:${receipt.id}`,
    receipt.toolName,
    receipt.mode ?? "read",
    receipt.requestHash ?? "hash",
    receipt.status ?? "executing",
    receipt.toolCallId,
    receipt.inputJson ?? "{}",
    receipt.outputRef ?? null,
    receipt.outputSummary ?? null,
    receipt.executionPlanJson ?? null,
    receipt.startedAt ?? null,
    receipt.settledAt ?? null,
    receipt.checkpointIndex ?? 0,
  );
}

export interface RuntimeStatement {
  sql: string;
  params: Array<string | number | null>;
}

/**
 * Execute one runtime SQL port request against an object database — the same
 * conversion `executeWorkstreamRuntimeSql` performs inside the Durable Object:
 * each statement is rewritten onto the `_runtime_*` compatibility views, the
 * batch commits atomically, and per-statement change counts come from the
 * `_runtime_statement_changes` bookkeeping the view triggers maintain (a view
 * write reports zero through the cursor, so `Math.max` with the trigger count
 * is what production reports too).
 */
export function executeWorkstreamObjectSql(
  database: DatabaseSync,
  statements: RuntimeStatement[],
  afterStatement?: (
    database: DatabaseSync,
    statement: RuntimeStatement,
    index: number,
    statements: RuntimeStatement[],
  ) => void,
): WorkstreamRuntimeSqlResult[] {
  const sql = objectSqlStorage(database);
  const results: WorkstreamRuntimeSqlResult[] = [];
  database.exec("BEGIN");
  try {
    for (const [index, statement] of statements.entries()) {
      sql.exec(`UPDATE _runtime_statement_changes SET changes = 0 WHERE id = 1`);
      let cursor: SqlStorageCursor<Record<string, SqlStorageValue>>;
      try {
        cursor = sql.exec<Record<string, SqlStorageValue>>(
          rewriteWorkstreamRuntimeSql(statement.sql),
          ...statement.params,
        );
      } catch (error) {
        // The statement is the diagnosis, exactly as in production: without it
        // a rewrite or compat-view defect surfaces as a bare SQLite error with
        // no way to tell which of a batch's statements produced it.
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `workstream_runtime_statement_failed: ${reason} :: ${statement.sql.slice(0, 300)}`,
          { cause: error },
        );
      }
      const rows = cursor.toArray() as Array<Record<string, string | number | null>>;
      const counted = Number(
        (sql.exec<{ changes: number }>(
          `SELECT changes FROM _runtime_statement_changes WHERE id = 1`,
        ).toArray()[0])?.changes ?? 0,
      );
      results.push({
        columns: rows.length === 0 ? [] : Object.keys(rows[0]!),
        rows,
        changes: Math.max(cursor.rowsWritten, counted),
      });
      afterStatement?.(database, statement, index, statements);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return results;
}

/** Read rows from an object database in the legacy table vocabulary. */
export function workstreamObjectAll<T extends Record<string, string | number | null>>(
  database: DatabaseSync,
  sql: string,
  ...params: Array<string | number | null>
): T[] {
  return executeWorkstreamObjectSql(database, [{ sql, params }])[0]!.rows as T[];
}

/** First row (or null) from an object database in the legacy vocabulary. */
export function workstreamObjectGet<T extends Record<string, string | number | null>>(
  database: DatabaseSync,
  sql: string,
  ...params: Array<string | number | null>
): T | null {
  return (workstreamObjectAll<T>(database, sql, ...params)[0]) ?? null;
}

/** Run one legacy-vocabulary mutation against an object database. */
export function workstreamObjectRun(
  database: DatabaseSync,
  sql: string,
  ...params: Array<string | number | null>
): { changes: number } {
  const [result] = executeWorkstreamObjectSql(database, [{ sql, params }]);
  return { changes: result!.changes };
}

/**
 * The production work-stream runtime router bound to test databases: regional
 * statements execute on the given D1 binding, object-owned statements travel
 * the local-executor port into the object database — the exact classification
 * and transport `workstreamRuntimeDatabase` gives the harness. Use this for
 * code under test that takes a D1Database directly (the harness runtime, the
 * terminal services); code that takes an Env goes through
 * {@link testSubstreamAgentsBinding} instead.
 */
export function testWorkstreamRuntimeD1(
  regional: D1Database,
  objectStore: DatabaseSync,
  ids: { workspaceId: string; workstreamId: string; substreamId?: string },
): D1Database {
  seedWorkstreamObjectRoot(objectStore, ids);
  return workstreamRuntimeDatabase(
    createTestEnv({ DB: regional }),
    ids.workspaceId,
    ids.workstreamId,
    ids.substreamId ?? "0",
    async (statements) => executeWorkstreamObjectSql(objectStore, statements),
  );
}

/**
 * A Terminal port backed by the test's own object database.
 *
 * The services take a `TerminalPortFactory` so this can hand them real
 * storage over `node:sqlite` running the checked-in object schema: the SQL,
 * the constraints, and the transactions are the real ones. What this cannot
 * prove is anything the runtime decides — serialization against a concurrent
 * caller, an alarm observing a committed row — which is why the Terminal
 * runtime tests live in `test-workers/` against real workerd.
 */
/**
 * The resident authority in the form an object installs it: an executor over
 * the real Terminal storage, which is what `withLocalWorkstreamAuthorities`
 * carries and what `createTerminalObjectPort` calls when it finds one.
 */
export function testTerminalOperationExecutor(objectStore: DatabaseSync): TerminalOperationExecutor {
  const storage = new WorkstreamTerminalStorage(createCloudflareTestBinding<DurableObjectStorage>({
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    transactionSync: (body: () => unknown) => body(),
    sql: objectSqlStorage(objectStore),
  }));
  return async (operation, args) => {
    const method = storage[operation] as (...rest: unknown[]) => unknown;
    return method.apply(storage, args) ?? null;
  };
}

export function testTerminalPortFactory(objectStore: DatabaseSync): TerminalPortFactory {
  const storage = createCloudflareTestBinding<DurableObjectStorage>({
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    transactionSync: (body: () => unknown) => body(),
    sql: objectSqlStorage(objectStore),
  });
  return createTerminalPortFactory(
    createTestEnv({}),
    new WorkstreamTerminalStorage(storage),
  );
}

export type RecordedDispatch = Record<string, unknown>;

/** A wire-shaped `WorkstreamSchema` object for fabricated product responses. */
export function testWorkstreamContract(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const at = "2026-01-02T00:00:00.000Z";
  return {
    id: "00000000-0000-4000-8000-00000000aaaa",
    workspaceId: "00000000-0000-4000-8000-00000000bbbb",
    title: "Test work stream",
    titleStatus: "settled",
    objective: "",
    emailAddress: null,
    originType: "ad_hoc",
    originLabel: null,
    createdByUserId: null,
    automationSubscriptionId: null,
    automationRunId: null,
    plannedFor: null,
    harnessStatus: "running",
    latestAttentionSequenceNumber: 1,
    readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0,
    hasUnread: false,
    firstUnreadSequenceNumber: null,
    lastActivityAt: at,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    scope: "workspace",
    ...overrides,
  };
}

interface SubstreamAgentsStubOptions {
  /** Every `dispatchRun` payload, in order. */
  dispatches?: RecordedDispatch[];
  /** Every `publishEvent` event, in order. */
  roomEvents?: Array<Record<string, unknown>>;
  /**
   * Throw or answer a failure for a dispatch instead of recording it. Return
   * `null` to fall through to the default 200 recording behavior, so a test
   * can fail the first dispatch and admit the second.
   */
  failDispatch?: (input: RecordedDispatch) => { status: number; bodyJson: string } | null;
  /**
   * Fabricated `handleProductRequest` responses by operation name. Any
   * operation without a handler throws, naming itself, so a test cannot lean
   * on product behavior it never modeled.
   */
  product?: Record<string, (request: Record<string, unknown>) => unknown>;
  /** Additional RPC methods merged onto the stub object. */
  extra?: Record<string, unknown>;
  /**
   * When the binding is built over the regional database, the per-workstream
   * object databases it creates land here, keyed by workstream id, so a test
   * can assert object state (through {@link workstreamObjectGet}) or close
   * them. Ignored when the binding is built over an object store directly.
   */
  objectStores?: Map<string, DatabaseSync>;
}

function isWorkstreamObjectStore(database: DatabaseSync): boolean {
  return database.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workstream'`,
  ).get() !== undefined;
}

/**
 * The agent stub's identity endpoint, over one object database.
 *
 * Exported so a test with its own hand-built agent stub gets the *real*
 * `WorkstreamIdentityStorage` for these operations rather than a second model
 * of the root row. The provision's write in particular is the whole point of
 * the operation, and a double that reproduced it by hand is the one that
 * drifts.
 */
export function testIdentityOperationStub(
  database: DatabaseSync,
): (input: { operation: string; args: unknown[] }) => { status: number; bodyJson: string } {
  return (input) => {
    const storage = new WorkstreamIdentityStorage(
      createCloudflareTestBinding<DurableObjectStorage>({
        getAlarm: async () => null,
        setAlarm: async () => undefined,
        transactionSync: (body: () => unknown) => body(),
        sql: objectSqlStorage(database),
      }),
    ) as unknown as Record<string, (...args: unknown[]) => unknown>;
    const value = storage[input.operation]!.apply(storage, input.args);
    return { status: 200, bodyJson: JSON.stringify({ ok: true, value: value ?? null }) };
  };
}

/**
 * A SUBSTREAM_AGENTS binding whose runtime SQL port mirrors production truth:
 * work-stream authority statements (the request carries a `workstreamId`)
 * execute against a real object database — created by
 * {@link testWorkstreamObjectStore} and root-seeded from the request ids, one
 * per workstream, or the given database itself when it already is an object
 * store — after the same identity and fence checks the Durable Object makes.
 * Workspace-authority requests (no `workstreamId`) execute against the given
 * through-0089 compatibility database so focused repository tests can preserve
 * their frozen SQL dialect. That is a test fixture, not current regional D1.
 * Run dispatch is recorded instead of executed. Pair with
 * {@link openWorkstreamAuthorityForTest}.
 */
export function testSubstreamAgentsBinding(
  database: DatabaseSync,
  options: SubstreamAgentsStubOptions = {},
): DurableObjectNamespace {
  const objectStoreMode = isWorkstreamObjectStore(database);
  const stores = options.objectStores ?? new Map<string, DatabaseSync>();
  const storeFor = (workstreamId: string, workspaceId: string): DatabaseSync => {
    if (objectStoreMode) {
      seedWorkstreamObjectRoot(database, { workstreamId, workspaceId });
      return database;
    }
    let store = stores.get(workstreamId);
    if (!store) {
      store = testWorkstreamObjectStore();
      stores.set(workstreamId, store);
    }
    seedWorkstreamObjectRoot(store, { workstreamId, workspaceId });
    return store;
  };
  const stub = {
    /**
     * The Terminal port's counterpart, run against the same object database
     * the SQL port uses. Real storage, real schema, real constraints — the
     * one thing standing in is the transport, because a Worker-to-object
     * round trip is what `test-workers/` exists to exercise.
     */
    executeTerminalOperation: vi.fn((input: {
      workspaceId: string;
      workstreamId: string;
      operation: string;
      args: unknown[];
    }) => {
      const store = storeFor(input.workstreamId, input.workspaceId);
      const storage = createCloudflareTestBinding<DurableObjectStorage>({
        getAlarm: async () => null,
        setAlarm: async () => undefined,
        transactionSync: (body: () => unknown) => body(),
        sql: objectSqlStorage(store),
      });
      const terminal = new WorkstreamTerminalStorage(storage) as unknown as
        Record<string, (...args: unknown[]) => unknown>;
      try {
        const value = terminal[input.operation]!.apply(terminal, input.args);
        return { status: 200, bodyJson: JSON.stringify({ ok: true, value: value ?? null }) };
      } catch (error) {
        return {
          status: 409,
          bodyJson: JSON.stringify({
            error: error instanceof Error ? error.message : "terminal_operation_failed",
          }),
        };
      }
    }),
    /**
     * The tool-receipt port's counterpart, on the same object database.
     *
     * Same shape and same reasoning as `executeTerminalOperation` above: real
     * storage, real schema, real constraints, with only the transport standing
     * in. A lost lease comes back as a 200 carrying `ownership_lost`, because
     * that is an ordinary end to a run rather than a fault — a stub that threw
     * for it would let a test pass against error handling production never
     * reaches.
     */
    executeToolReceiptOperation: vi.fn((input: {
      workspaceId: string;
      workstreamId: string;
      operation: string;
      args: unknown[];
    }) => {
      const store = storeFor(input.workstreamId, input.workspaceId);
      const storage = new WorkstreamToolReceiptStorage(
        createCloudflareTestBinding<DurableObjectStorage>({
          getAlarm: async () => null,
          setAlarm: async () => undefined,
          transactionSync: (body: () => unknown) => body(),
          sql: objectSqlStorage(store),
        }),
      ) as unknown as Record<string, (...args: unknown[]) => unknown>;
      try {
        const value = storage[input.operation]!.apply(storage, input.args);
        return { status: 200, bodyJson: JSON.stringify({ ok: true, value: value ?? null }) };
      } catch (error) {
        return {
          status: 409,
          bodyJson: JSON.stringify({
            error: error instanceof Error ? error.message : "tool_receipt_operation_failed",
          }),
        };
      }
    }),
    /**
     * The harness-run port's counterpart, on the same object database.
     *
     * Same shape and reasoning as its siblings. Refusals — a lost lease, a
     * stale admission, a run that is already terminal — come back as a 200
     * carrying the named outcome, because every one of them is an ordinary
     * answer this authority is designed to give rather than a fault.
     */
    executeHarnessRunOperation: vi.fn((input: {
      workspaceId: string;
      workstreamId: string;
      operation: string;
      args: unknown[];
    }) => {
      const store = storeFor(input.workstreamId, input.workspaceId);
      const storage = new WorkstreamHarnessRunStorage(
        createCloudflareTestBinding<DurableObjectStorage>({
          getAlarm: async () => null,
          setAlarm: async () => undefined,
          transactionSync: (body: () => unknown) => body(),
          sql: objectSqlStorage(store),
        }),
      ) as unknown as Record<string, (...args: unknown[]) => unknown>;
      try {
        const value = storage[input.operation]!.apply(storage, input.args);
        return { status: 200, bodyJson: JSON.stringify({ ok: true, value: value ?? null }) };
      } catch (error) {
        return {
          status: 409,
          bodyJson: JSON.stringify({
            error: error instanceof Error ? error.message : "harness_run_operation_failed",
          }),
        };
      }
    }),
    /**
     * The transcript port's counterpart, on the same object database.
     *
     * Same shape and reasoning as its siblings. A replayed append comes back as
     * a 200 carrying `replayed`, because a redelivery is the ordinary case for
     * every transcript write in this product rather than a fault.
     */
    executeMessageOperation: vi.fn((input: {
      workspaceId: string;
      workstreamId: string;
      operation: string;
      args: unknown[];
    }) => {
      const store = storeFor(input.workstreamId, input.workspaceId);
      const storage = new WorkstreamMessageStorage(
        createCloudflareTestBinding<DurableObjectStorage>({
          getAlarm: async () => null,
          setAlarm: async () => undefined,
          transactionSync: (body: () => unknown) => body(),
          sql: objectSqlStorage(store),
        }),
      ) as unknown as Record<string, (...args: unknown[]) => unknown>;
      try {
        const value = storage[input.operation]!.apply(storage, input.args);
        return { status: 200, bodyJson: JSON.stringify({ ok: true, value: value ?? null }) };
      } catch (error) {
        return {
          status: 409,
          bodyJson: JSON.stringify({
            error: error instanceof Error ? error.message : "message_operation_failed",
          }),
        };
      }
    }),
    /**
     * The resource-attachment port's counterpart, on the same object database.
     *
     * Same shape and reasoning as its siblings: real storage, real schema, real
     * constraints, with only the transport standing in.
     */
    executeResourceOperation: vi.fn((input: {
      workspaceId: string;
      workstreamId: string;
      operation: string;
      args: unknown[];
    }) => {
      const store = storeFor(input.workstreamId, input.workspaceId);
      const storage = new WorkstreamResourceStorage(
        createCloudflareTestBinding<DurableObjectStorage>({
          getAlarm: async () => null,
          setAlarm: async () => undefined,
          transactionSync: (body: () => unknown) => body(),
          sql: objectSqlStorage(store),
        }),
      ) as unknown as Record<string, (...args: unknown[]) => unknown>;
      try {
        const value = storage[input.operation]!.apply(storage, input.args);
        return { status: 200, bodyJson: JSON.stringify({ ok: true, value: value ?? null }) };
      } catch (error) {
        return {
          status: 409,
          bodyJson: JSON.stringify({
            error: error instanceof Error ? error.message : "resource_operation_failed",
          }),
        };
      }
    }),
    /**
     * The scheduling port's counterpart, on the same object database.
     *
     * Same shape and reasoning as the two above. A refused claim comes back as
     * a 200 carrying its own outcome, because a wake-up someone else took is an
     * ordinary answer rather than a fault.
     */
    executeSchedulingOperation: vi.fn((input: {
      workspaceId: string;
      workstreamId: string;
      operation: string;
      args: unknown[];
    }) => {
      const store = storeFor(input.workstreamId, input.workspaceId);
      const storage = new WorkstreamSchedulingStorage(
        createCloudflareTestBinding<DurableObjectStorage>({
          getAlarm: async () => null,
          setAlarm: async () => undefined,
          transactionSync: (body: () => unknown) => body(),
          sql: objectSqlStorage(store),
        }),
      ) as unknown as Record<string, (...args: unknown[]) => unknown>;
      try {
        const value = storage[input.operation]!.apply(storage, input.args);
        return { status: 200, bodyJson: JSON.stringify({ ok: true, value: value ?? null }) };
      } catch (error) {
        return {
          status: 409,
          bodyJson: JSON.stringify({
            error: error instanceof Error ? error.message : "scheduling_operation_failed",
          }),
        };
      }
    }),
    executeRuntimeSql: vi.fn((input: {
      workspaceId: string;
      workstreamId?: string;
      statements: RuntimeStatement[];
    }) => {
      if (input.workstreamId !== undefined) {
        const store = storeFor(input.workstreamId, input.workspaceId);
        const identity = store.prepare(
          `SELECT workstream_key, parent_workspace_key, authority_mode FROM workstream WHERE id = 1`,
        ).get() as {
          workstream_key: string;
          parent_workspace_key: string;
          authority_mode: string;
        } | undefined;
        if (
          !identity
          || identity.workstream_key !== input.workstreamId
          || identity.parent_workspace_key !== input.workspaceId
        ) throw new Error("workstream_runtime_identity_mismatch");
        if (identity.authority_mode !== "authoritative") {
          throw new Error("workstream_runtime_authority_fenced");
        }
        const results = executeWorkstreamObjectSql(store, input.statements);
        return { status: 200, bodyJson: JSON.stringify({ results }) };
      }
      if (objectStoreMode) {
        throw new Error("workspace runtime SQL routed to an object-store-backed binding");
      }
      // Workspace authority: those D1 tables were kept, so the migrated
      // regional database is still the store the WorkspaceDO port serves.
      const results: WorkstreamRuntimeSqlResult[] = [];
      database.exec("BEGIN");
      try {
        for (const { sql, params } of input.statements) {
          const statement = database.prepare(sql);
          if (/^\s*(?:SELECT|WITH)/iu.test(sql)) {
            const rows = statement.all(...params) as Array<Record<string, string | number | null>>;
            results.push({
              columns: rows.length > 0 ? Object.keys(rows[0]!) : [],
              rows,
              changes: 0,
            });
          } else if (/\bRETURNING\b/iu.test(sql)) {
            const rows = statement.all(...params) as Array<Record<string, string | number | null>>;
            results.push({
              columns: rows.length > 0 ? Object.keys(rows[0]!) : [],
              rows,
              changes: rows.length,
            });
          } else {
            try {
              const run = statement.run(...params);
              results.push({ columns: [], rows: [], changes: Number(run.changes) });
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              throw new Error(
                `workspace_runtime_statement_failed: ${reason} :: ${sql.slice(0, 300)}`,
                { cause: error },
              );
            }
          }
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return { status: 200, bodyJson: JSON.stringify({ results }) };
    }),
    readerAudience: vi.fn((input: { workspaceId: string; workstreamId: string }) => {
      const store = storeFor(input.workstreamId, input.workspaceId);
      const root = store.prepare(
        `SELECT scope FROM workstream WHERE id = 1`,
      ).get() as { scope: "personal" | "workspace" } | undefined;
      if (!root) return null;
      if (root.scope === "workspace") return { scope: "workspace" as const };
      const participants = store.prepare(
        `SELECT user_id FROM participants WHERE status = 'active' ORDER BY user_id`,
      ).all() as Array<{ user_id: string }>;
      return {
        scope: "personal" as const,
        userIds: participants.map((participant) => participant.user_id),
      };
    }),
    dispatchRun: vi.fn((input: RecordedDispatch) => {
      const failure = options.failDispatch?.(input);
      if (failure) return failure;
      options.dispatches?.push(input);
      return { status: 200, bodyJson: "{}" };
    }),
    publishEvent: vi.fn((input: { event: Record<string, unknown> }) => {
      options.roomEvents?.push(input.event);
      return { status: 204, bodyJson: "null" };
    }),
    bootstrapRuntime: vi.fn((input: { workspaceId: string; workstreamId: string }) => {
      // Production's bootstrap opens the object and writes its identity root;
      // seeding here is that same admission, so a creation flow's first routed
      // statement finds the root the way it would in the real object.
      const store = storeFor(input.workstreamId, input.workspaceId);
      // And it stamps the reason code, as `bootstrapRuntimeAuthority` does.
      // `provisionWorkstream` keys its replay guard on that value, so a double
      // that left the shared fixture's `seeded` in place would make every
      // provision look like a replay and write nothing.
      store.prepare(
        `UPDATE workstream
            SET authority_mode = 'authoritative', exact_state = 'idle',
                state_reason_code = 'runtime_bootstrap'
          WHERE id = 1 AND state_reason_code = 'seeded'`,
      ).run();
      return { status: 200, bodyJson: "{}" };
    }),
    executeIdentityOperation: vi.fn((input: {
      workspaceId: string;
      workstreamId: string;
      operation: string;
      args: unknown[];
    }) => testIdentityOperationStub(storeFor(input.workstreamId, input.workspaceId))(input)),
    refreshTimerAlarm: vi.fn(() => ({ status: 200, bodyJson: "{}" })),
    flushEffectsToWorkstreamDO: vi.fn(() => ({ status: 200, bodyJson: "{}" })),
    handleProductRequest: vi.fn((request: { operation: string } & Record<string, unknown>) => {
      const handler = options.product?.[request.operation];
      if (!handler) throw new Error(`unstubbed product operation: ${request.operation}`);
      return { status: 200, bodyJson: JSON.stringify(handler(request)) };
    }),
    ...options.extra,
  };
  const binding: DurableObjectNamespace = createCloudflareTestBinding<DurableObjectNamespace>({
    idFromName: vi.fn((name: string) => createTestDurableObjectId(name)),
    get: vi.fn(() => stub),
    jurisdiction: vi.fn((): DurableObjectNamespace => binding),
  });
  return binding;
}

/**
 * One in-isolate port over a real storage instance, for any of the authorities.
 *
 * The Node suite's stand-in for an `/internal/*` round trip: the real storage
 * class over the real object schema, so every statement and every fence is
 * exercised. What the *runtime* decides — that the operation is atomic against
 * a concurrent caller, that a lease cannot lapse mid-operation — is proved in
 * `test-workers/` instead.
 *
 * One helper rather than three, matching `createObjectPort`, which the three
 * production ports collapsed onto for the same reason. The three copies this
 * replaces had all drifted from production in the same way: none applied the
 * `?? null` coalesce the real seam applies, so a method returning `undefined` —
 * `wakeup`, `oldestOpenElicitation`, `descriptionRefreshState`,
 * `compactionCheckpoint`, and their receipt and block-dashboard counterparts —
 * answered the Node suite differently from the wire, where JSON has no
 * `undefined` and an absent `value` arrives as `null`.
 */
function testObjectPort<TStorage, TOperation extends keyof TStorage & string, TPort>(
  storage: TStorage,
  operations: readonly TOperation[],
): TPort {
  return Object.fromEntries(
    operations.map((operation) => [
      operation,
      async (...args: unknown[]) =>
        (storage[operation] as (...rest: unknown[]) => unknown).apply(storage, args) ?? null,
    ]),
  ) as TPort;
}

/**
 * A tool-receipt port backed by the same in-memory object database.
 *
 * Takes the two staging hooks the others do not need: receipt operations read
 * their fences and write their rows in one transaction, so a race that used to
 * fit between two D1 batches has to be staged from inside it.
 */
export function testToolReceiptPort(
  database: DatabaseSync,
  /**
   * Run inside `transactionSync`, immediately before the operation's body.
   *
   * The only way for a test to land competing state at the last instant an
   * operation could still observe it.
   */
  beforeTransaction?: () => void,
  /**
   * Run after each statement an operation executes, with that statement's SQL.
   *
   * The counterpart to `beforeTransaction` for the other half of an operation:
   * competing state that lands *after* a decision has been read, to prove the
   * decision is not re-derived from a source that has since moved.
   */
  afterStatement?: (sql: string) => void,
): ToolReceiptObjectPort {
  const objectSql = objectSqlStorage(database);
  const sql = afterStatement
    ? new Proxy(objectSql, {
      get(target, property, receiver) {
        if (property !== "exec") return Reflect.get(target, property, receiver) as unknown;
        return (statement: string, ...values: unknown[]) => {
          const result = (target.exec as (...rest: unknown[]) => unknown)(statement, ...values);
          afterStatement(statement);
          return result;
        };
      },
    })
    : objectSql;
  return testObjectPort<WorkstreamToolReceiptStorage, ToolReceiptOperation, ToolReceiptObjectPort>(
    new WorkstreamToolReceiptStorage(
      createCloudflareTestBinding<DurableObjectStorage>({
        getAlarm: async () => null,
        setAlarm: async () => undefined,
        transactionSync: (body: () => unknown) => {
          beforeTransaction?.();
          return body();
        },
        sql,
      }),
    ),
    TOOL_RECEIPT_OPERATIONS,
  );
}

/** A storage binding over one in-memory object database, with no staging hooks. */
function plainBinding(database: DatabaseSync): DurableObjectStorage {
  return createCloudflareTestBinding<DurableObjectStorage>({
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    transactionSync: (body: () => unknown) => body(),
    sql: objectSqlStorage(database),
  });
}

/**
 * A transcript port over a real storage instance in this isolate.
 *
 * The seam the other ports take. What the runtime decides for this one — that
 * an append and the directory projection showing its preview are one commit —
 * belongs in `test-workers/`.
 */
export function testMessagePort(database: DatabaseSync): MessageObjectPort {
  const storage = new WorkstreamMessageStorage(
    createCloudflareTestBinding<DurableObjectStorage>({
      getAlarm: async () => null,
      setAlarm: async () => undefined,
      transactionSync: (body: () => unknown) => body(),
      sql: objectSqlStorage(database),
    }),
  );
  return Object.fromEntries(
    MESSAGE_OPERATIONS.map((operation) => [
      operation,
      async (...args: unknown[]) =>
        (storage[operation] as (...rest: unknown[]) => unknown).apply(storage, args),
    ]),
  ) as MessageObjectPort;
}

/**
 * A scheduling port over a real storage instance in this isolate.
 *
 * One more use than the others have: the owning object fires its own wake-up
 * alarms, so this is also what a test uses to stand where the object stands,
 * with its storage in hand rather than a stub addressed to itself.
 */
export function testSchedulingPort(database: DatabaseSync): SchedulingObjectPort {
  return testObjectPort<WorkstreamSchedulingStorage, SchedulingOperation, SchedulingObjectPort>(
    new WorkstreamSchedulingStorage(plainBinding(database)),
    SCHEDULING_OPERATIONS,
  );
}

/**
 * A resource-attachment port over a real storage instance in this isolate.
 *
 * On the shared helper like its three siblings — this arrived as a fifth
 * hand-written copy, from a branch written before they were folded together.
 */
export function testResourcePort(database: DatabaseSync): ResourceObjectPort {
  return testObjectPort<WorkstreamResourceStorage, ResourceOperation, ResourceObjectPort>(
    new WorkstreamResourceStorage(plainBinding(database)),
    RESOURCE_OPERATIONS,
  );
}

/** A harness-run port over a real storage instance in this isolate. */
export function testHarnessRunPort(
  database: DatabaseSync,
  /**
   * Run inside `transactionSync`, immediately before the operation's body.
   *
   * `testToolReceiptPort`'s seam, for the reason it exists there: a claim, a
   * terminalization and a reap each read their fence and write their rows in
   * one transaction, so a race that used to be staged between two statements of
   * a D1 batch has to be staged from here instead.
   */
  beforeTransaction?: () => void,
): HarnessRunObjectPort {
  const storage = new WorkstreamHarnessRunStorage(
    createCloudflareTestBinding<DurableObjectStorage>({
      getAlarm: async () => null,
      setAlarm: async () => undefined,
      transactionSync: (body: () => unknown) => {
        beforeTransaction?.();
        return body();
      },
      sql: objectSqlStorage(database),
    }),
  );
  return Object.fromEntries(
    HARNESS_RUN_OPERATIONS.map((operation) => [
      operation,
      async (...args: unknown[]) =>
        (storage[operation] as (...rest: unknown[]) => unknown).apply(storage, args),
    ]),
  ) as HarnessRunObjectPort;
}

/** The same port as a factory, for a caller that takes one. */
export function testHarnessRunPortFactory(database: DatabaseSync): (
  workspaceId: string,
  workstreamId: string,
) => HarnessRunObjectPort {
  const port = testHarnessRunPort(database);
  return () => port;
}

/** The same port as a factory, for a caller that takes one. */
export function testResourcePortFactory(database: DatabaseSync): (
  workspaceId: string,
  workstreamId: string,
) => ResourceObjectPort {
  const port = testResourcePort(database);
  return () => port;
}

/** A block-dashboard port over a real storage instance in this isolate. */
export function testBlockDashboardPort(database: DatabaseSync): BlockDashboardObjectPort {
  return testObjectPort<
    WorkstreamBlockDashboardStorage, BlockDashboardOperation, BlockDashboardObjectPort
  >(
    new WorkstreamBlockDashboardStorage(plainBinding(database)),
    BLOCK_DASHBOARD_OPERATIONS,
  );
}
