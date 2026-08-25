/**
 * The WorkspaceDO migration ledger, one version at a time.
 *
 * A Durable Object's ledger is append-only and hashed: a released version's
 * statements can never change, and a version that inserts a row has to insert
 * it exactly once, for exactly the objects that need it. Both are claims about
 * SQL, so they are proved here against the checked-in statements rather than in
 * the workers suite. `docs/durable-object-alarms.md` is the module document.
 */
import { asWorkspaceId } from "@rally/contracts";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000000a1");

const SCHEDULE_ALARM_VERSION = 4;
const BOOTSTRAP_VERSION = 5;

/** Apply the ledger's versions in `(after, through]`, the way a deploy does. */
function apply(database: DatabaseSync, through: number, after = 0): void {
  for (const migration of WORKSPACE_DO_SCHEMA_MIGRATIONS) {
    if (migration.version <= after) continue;
    if (migration.version > through) break;
    for (const statement of migration.statements) database.exec(statement);
  }
}

function seedIdentity(database: DatabaseSync): void {
  database.prepare(
    `INSERT INTO workspace_identity
       (id, workspace_id, region, placement_affinity, created_at, updated_at)
     VALUES (1, ?, 'global', 'wnam', 0, 0)`,
  ).run(WORKSPACE_ID);
}

function bootstrapEntries(database: DatabaseSync): { alarm_key: string; due_at: number }[] {
  return database.prepare(
    `SELECT alarm_key, due_at FROM _internal_durable_alarms WHERE kind = 'schedule_bootstrap'`,
  ).all() as { alarm_key: string; due_at: number }[];
}

describe("the WorkspaceDO alarm migrations", () => {
  it("reconciles a workspace that already existed when the scheduler was deleted", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    const before = Date.now();
    // The order a deployed object actually sees: version 4 shipped in its own
    // release, so this object holds that release's identity row before the
    // bootstrap version exists at all.
    apply(database, SCHEDULE_ALARM_VERSION);
    seedIdentity(database);

    apply(database, BOOTSTRAP_VERSION, SCHEDULE_ALARM_VERSION);

    const entries = bootstrapEntries(database);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.alarm_key).toBe("workspace");
    // Immediate: the object it belongs to may have no other reason to wake.
    expect(entries[0]!.due_at).toBeGreaterThanOrEqual(before - 1_000);
    expect(entries[0]!.due_at).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it("leaves a workspace created after the deletion nothing to reconcile", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");

    // A new object runs its whole ledger before it has an identity, so there is
    // nothing for a reconcile to find and no wake-up to pay for.
    apply(database, BOOTSTRAP_VERSION);

    expect(bootstrapEntries(database)).toEqual([]);
  });

  it("keeps the bootstrap out of the version that shipped without it", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    apply(database, SCHEDULE_ALARM_VERSION - 1);
    seedIdentity(database);

    apply(database, SCHEDULE_ALARM_VERSION, SCHEDULE_ALARM_VERSION - 1);

    // Version 4 is released. Adding a statement to it changes the hash every
    // deployed object recorded, and each one then throws
    // `workspace_do_schema_hash_mismatch:4` in its constructor — for good.
    expect(bootstrapEntries(database)).toEqual([]);
  });
});
