/**
 * The shutdown barrier in front of Project retirement.
 *
 * WorkspaceDO migration 62 drops eight tables, and the PRD makes "zero
 * unsettled Project effects" a cutover gate: a default still queued for
 * delivery is work aimed at a Channel whose audience the Space cutover has just
 * changed. So the migration invalidates what it can, asserts that nothing
 * unsettled is left, and only then drops anything.
 *
 * Against the checked-in ledger rather than a stub, because what is under test
 * is the statements themselves — a CHECK constraint's name, the order the
 * drops run in, and whether a cascade fires.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

/**
 * The version that retires Projects. Bumping it is part of changing it: the
 * harness stops here, so leaving it behind exercises a ledger production no
 * longer has.
 */
const PROJECT_RETIREMENT_VERSION = 62;

const PROJECT_ID = "00000000-0000-7000-8000-0000000000d1";
const RESOURCE_ID = "00000000-0000-7000-8000-0000000000d2";
const CHANNEL_ID = "00000000-0000-7000-8000-0000000000d3";
const USER_ID = "00000000-0000-7000-8000-0000000000d4";

const PROJECT_TABLES = [
  "projects",
  "project_participants",
  "workspace_project_order",
  "workspace_project_state",
  "project_workstream_memberships",
  "project_default_resources",
  "project_default_resource_targets",
  "project_default_resource_publications",
];

const openDatabases: DatabaseSync[] = [];

function openDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  openDatabases.push(database);
  return database;
}

afterEach(() => {
  while (openDatabases.length > 0) {
    try { openDatabases.pop()?.close(); } catch { /* already closed */ }
  }
});

function apply(database: DatabaseSync, through: number, after = 0): void {
  // On, not off: the drops are ordered children-before-parents precisely
  // because foreign keys stay enforced inside a Durable Object event, and a
  // harness that turned them off would prove the opposite of what production
  // does.
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of WORKSPACE_DO_SCHEMA_MIGRATIONS) {
    if (migration.version <= after) continue;
    if (migration.version > through) break;
    for (const statement of migration.statements) database.exec(statement);
  }
}

/** One Project with one default resource staged for one Channel. */
function seedProjectDefault(database: DatabaseSync, targetState: string): void {
  database.prepare(
    `INSERT INTO projects (
       project_id, name, normalized_name, icon_key, icon_color_key, scope, status,
       creator_user_id, archived_at, archived_by_user_id, created_at, updated_at)
     VALUES (?, 'Hiring', 'hiring', 'briefcase', 'blue', 'workspace', 'active', ?, NULL, NULL, 1, 1)`,
  ).run(PROJECT_ID, USER_ID);
  database.prepare(
    `INSERT INTO project_default_resources
       (project_id, resource_id, generation, state, created_at, updated_at, removed_at)
     VALUES (?, ?, 1, 'active', 1, 1, NULL)`,
  ).run(PROJECT_ID, RESOURCE_ID);
  database.prepare(
    `INSERT INTO project_default_resource_targets
       (project_id, resource_id, default_generation, workstream_id, membership_generation,
        state, attempts, created_at, updated_at, applied_at, last_error_code)
     VALUES (?, ?, 1, ?, 1, ?, 0, 1, 1, NULL, NULL)`,
  ).run(PROJECT_ID, RESOURCE_ID, CHANNEL_ID, targetState);
}

describe("WorkspaceDO migration 62", () => {
  it("given a Project default still queued, when the migration runs, then it is invalidated rather than dropped under", () => {
    const database = openDatabase();
    apply(database, PROJECT_RETIREMENT_VERSION - 1);
    seedProjectDefault(database, "pending");
    database.prepare(
      `INSERT INTO project_default_resource_publications
         (project_id, resource_id, default_generation, workstream_id, membership_generation,
          requested_by_user_id, state, attempts, next_attempt_at, created_at, updated_at, accepted_at)
       VALUES (?, ?, 1, ?, 1, ?, 'pending', 0, 0, 1, 1, NULL)`,
    ).run(PROJECT_ID, RESOURCE_ID, CHANNEL_ID, USER_ID);

    apply(database, PROJECT_RETIREMENT_VERSION, PROJECT_RETIREMENT_VERSION - 1);

    // The barrier read zero because the invalidation above it settled the row,
    // which is the order the PRD's "zero unsettled Project effects" gate needs:
    // the durable half of an at-least-once delivery is what stops a Queue
    // message still in flight from attaching to a Channel whose audience this
    // cutover has just changed.
    for (const table of PROJECT_TABLES) {
      expect(() => database.exec(`SELECT 1 FROM ${table}`), table).toThrow(/no such table/u);
    }
  });

  it("given a target in a state the invalidation does not cover, when the migration runs, then it fails by name and drops nothing", () => {
    const database = openDatabase();
    apply(database, PROJECT_RETIREMENT_VERSION - 1);
    seedProjectDefault(database, "pending");
    // The failure a future edit would introduce: an invalidation that stops
    // covering every unsettled row. Simulated by taking the statement out,
    // because the point of the barrier is that it does not trust the statement
    // above it.
    const migration = WORKSPACE_DO_SCHEMA_MIGRATIONS
      .find((entry) => entry.version === PROJECT_RETIREMENT_VERSION);
    expect(migration).toBeDefined();
    const withoutInvalidation = migration!.statements
      .filter((statement) => !statement.startsWith("UPDATE project_default_resource_targets"));

    expect(() => {
      for (const statement of withoutInvalidation) database.exec(statement);
    }).toThrow(/project_effects_pending/u);

    // Nothing is dropped: the barrier is in front of every drop, and a real
    // migration runs inside one `transactionSync`, so the abort takes the
    // whole attempt with it.
    expect(database.prepare("SELECT COUNT(*) AS rows FROM projects").get()).toEqual({ rows: 1 });
    expect(database.prepare(
      "SELECT COUNT(*) AS rows FROM project_default_resource_targets WHERE state = 'pending'",
    ).get()).toEqual({ rows: 1 });
  });

  it("given an applied Project default, when the migration runs, then the Channel's own attachment is untouched", () => {
    const database = openDatabase();
    apply(database, PROJECT_RETIREMENT_VERSION - 1);
    seedProjectDefault(database, "applied");
    // The Channel's directory row stands for the Channel state the PRD says
    // survives: what the retirement deletes is the Organization's record of
    // *why* a resource was delivered, never the delivery.
    database.prepare(
      `INSERT INTO workspace_workstream_directory (
         workstream_id, authority_generation, waterline, source_event_id, payload_hash,
         title, description, preview, scope, exact_state, system_kind, last_activity_at,
         completed_at, archived_at, email_address, origin_type, origin_label,
         created_by_user_id, automation_subscription_id, automation_run_id, planned_for,
         title_status, latest_attention_ordinal, unread_tracking_start_ordinal,
         next_wakeup_due_at, next_wakeup_prompt, next_terminal_action_at,
         source_created_at, source_updated_at, projected_at)
       VALUES (?, 1, 1, 'e', 'h', 'Room', '', '', 'workspace', 'idle', NULL, 1,
               NULL, NULL, NULL, 'ad_hoc', NULL, NULL, NULL, NULL, NULL,
               'settled', 0, 0, NULL, NULL, NULL, 1, 1, 1)`,
    ).run(CHANNEL_ID);

    apply(database, PROJECT_RETIREMENT_VERSION, PROJECT_RETIREMENT_VERSION - 1);

    expect(database.prepare(
      "SELECT COUNT(*) AS rows FROM workspace_workstream_directory",
    ).get()).toEqual({ rows: 1 });
    expect(() => database.exec("SELECT 1 FROM project_default_resources"))
      .toThrow(/no such table/u);
  });
});
