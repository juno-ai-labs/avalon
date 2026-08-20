import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";

import { createCloudflareTestBinding, createTestDurableObjectId } from "./cloudflare-test";

const migrationsDirectory = fileURLToPath(new URL("../../../../packages/db/migrations/", import.meta.url));

/**
 * Walk the regional cutover ledger to `durable_object_open` the way the
 * campaign does — the phase transitions are trigger-enforced, so a test cannot
 * simply UPDATE straight to the open phase — and then disarm the post-cutover
 * D1 fences.
 *
 * Disarming the fences is what lets one sqlite database stand in for both the
 * regional index and the object store: in production the runtime SQL port
 * carries object-owned statements to the WorkstreamDO's own SQLite, and the
 * fences exist to abort anything that leaks back to D1. A unit test that pairs
 * this helper with {@link testSubstreamAgentsBinding} routes those statements
 * through the same port into the same database, so the fences would only
 * re-refuse writes the port has already accepted. Tests that arm the fences on
 * purpose (to prove a statement does not leak) should build their own object
 * store instead, as `slack-thread-audience.test.ts` does.
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
 * A stand-in for the WorkstreamDO's own SQLite store, for paths that *create*
 * work streams: creation writes the regional identity anchor and the object's
 * product row under the same id, which only coexist in separate stores. It
 * reuses the regional migrations for table shapes (the authority ledger it
 * carries stays at `legacy_open`, so none of the post-cutover fences arm) and
 * skips foreign-key enforcement the way the object's own schema does — the
 * object holds no `users`/`workspaces` rows to satisfy them.
 *
 * The caller owns closing it, exactly like every other test database.
 */
export function testWorkstreamObjectStore(): DatabaseSync {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const fileName of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(`${migrationsDirectory}/${fileName}`, "utf8"));
  }
  // The migrations turn enforcement back on for the regional database; the
  // object's schema has no cross-authority foreign keys to satisfy.
  database.exec("PRAGMA foreign_keys = OFF");
  return database;
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
}

/**
 * A SUBSTREAM_AGENTS binding whose runtime SQL port executes against the given
 * sqlite database — the same conversion the Durable Object performs — and whose
 * run dispatch is recorded instead of executed. Pair with
 * {@link openWorkstreamAuthorityForTest}.
 */
export function testSubstreamAgentsBinding(
  database: DatabaseSync,
  options: SubstreamAgentsStubOptions = {},
): DurableObjectNamespace {
  const stub = {
    executeRuntimeSql: vi.fn((input: {
      statements: Array<{ sql: string; params: Array<string | number | null> }>;
    }) => {
      const results: Array<{
        columns: string[];
        rows: Array<Record<string, string | number | null>>;
        changes: number;
      }> = [];
      database.exec("BEGIN");
      try {
        for (const { sql, params } of input.statements) {
          // When one sqlite database stands in for both stores, the regional
          // identity anchor (`INSERT OR IGNORE`, written by the bootstrap) and
          // the object's own product row share an id that in production lives
          // in two separate stores. Overlaying the anchor with the product
          // row's columns is the state reads observe there — product reads are
          // served by the object's copy — and an in-place upsert (never
          // REPLACE, whose delete would cascade through dependents) keeps the
          // rows that already reference the id.
          const anchorOverlay = /^\s*INSERT INTO workstreams\s*\(([^)]+)\)/iu.exec(sql);
          const effectiveSql = anchorOverlay
            ? `${sql} ON CONFLICT(id) DO UPDATE SET ${anchorOverlay[1]!
                .split(",")
                .map((column) => column.trim())
                .filter((column) => column !== "id")
                .map((column) => `${column} = excluded.${column}`)
                .join(", ")}`
            : sql;
          const statement = database.prepare(effectiveSql);
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
            const run = statement.run(...params);
            results.push({ columns: [], rows: [], changes: Number(run.changes) });
          }
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return { status: 200, bodyJson: JSON.stringify({ results }) };
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
    bootstrapRuntime: vi.fn(() => ({ status: 200, bodyJson: "{}" })),
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
