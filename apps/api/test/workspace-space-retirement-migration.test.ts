/**
 * What retires a Project's undelivered effects, now that nothing asserts on them.
 *
 * WorkspaceDO migration 64 drops eight tables. The PRD makes "zero unsettled
 * Project effects" a cutover gate, and this is what meets it: the migration
 * settles every pending target and publication in the same transaction that
 * drops them, and the activity consumer keeps a tombstone leg so a message
 * published before the cutover is acknowledged rather than retried to the
 * dead-letter queue. There is no barrier between the two — one shipped, and it
 * counted rows the statements above it had just settled, so it could only ever
 * read zero. An undelivered Project default is *dropped*, which is what PRD
 * non-goal 5 asks for: Projects are deleted rather than converted.
 *
 * Against the checked-in ledger rather than a stub, because what is under test
 * is the statements themselves — the order the drops run in, whether a cascade
 * fires, and whether the settlement happens before either.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
import { consumeActivityQueue } from "../src/queues/activity-consumer";
import type { Env } from "../src/env";
import { createTestEnv } from "./helpers/cloudflare-test";

/**
 * The version that retires Projects. Bumping it is part of changing it: the
 * harness stops here, so leaving it behind exercises a ledger production no
 * longer has.
 */
const PROJECT_RETIREMENT_VERSION = 64;

const PROJECT_ID = "00000000-0000-7000-8000-0000000000d1";
const RESOURCE_ID = "00000000-0000-7000-8000-0000000000d2";
const CHANNEL_ID = "00000000-0000-7000-8000-0000000000d3";
const USER_ID = "00000000-0000-7000-8000-0000000000d4";
const WORKSPACE_ID = "00000000-0000-7000-8000-0000000000d5";

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
  vi.restoreAllMocks();
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

/** One Queue message, in the shape the consumer reads it. */
function queued(body: unknown) {
  const ack = vi.fn();
  const retry = vi.fn();
  const batch = {
    messages: [{ id: "project", timestamp: new Date(1), body, attempts: 1, ack, retry }],
    queue: "activity",
    metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
    retryAll: vi.fn(),
    ackAll: vi.fn(),
  } as unknown as MessageBatch<unknown>;
  return { batch, ack, retry };
}

describe("WorkspaceDO migration 64", () => {
  it("given a Project default still queued, when the migration runs, then it is settled in the same transaction that drops it", () => {
    const database = openDatabase();
    apply(database, PROJECT_RETIREMENT_VERSION - 1);
    seedProjectDefault(database, "pending");
    database.prepare(
      `INSERT INTO project_default_resource_publications
         (project_id, resource_id, default_generation, workstream_id, membership_generation,
          requested_by_user_id, state, attempts, next_attempt_at, created_at, updated_at, accepted_at)
       VALUES (?, ?, 1, ?, 1, ?, 'pending', 0, 0, 1, 1, NULL)`,
    ).run(PROJECT_ID, RESOURCE_ID, CHANNEL_ID, USER_ID);

    // The statements, stopped after the last settlement and before the first
    // drop. What the settlement is *for* is a message still in flight: it finds
    // nothing current and attaches nothing to a Channel whose audience the
    // Space cutover has just changed.
    const migration = WORKSPACE_DO_SCHEMA_MIGRATIONS
      .find((entry) => entry.version === PROJECT_RETIREMENT_VERSION);
    expect(migration).toBeDefined();
    const settlements = migration!.statements.filter((statement) => statement.startsWith("UPDATE "));
    expect(settlements).toHaveLength(2);
    for (const statement of settlements) database.exec(statement);

    expect(database.prepare(
      "SELECT state, last_error_code FROM project_default_resource_targets",
    ).get()).toMatchObject({ state: "terminal", last_error_code: "project_retired" });
    expect(database.prepare(
      "SELECT state FROM project_default_resource_publications",
    ).get()).toMatchObject({ state: "accepted" });

    for (const statement of migration!.statements.filter((statement) => !statement.startsWith("UPDATE "))) {
      database.exec(statement);
    }
    for (const table of PROJECT_TABLES) {
      expect(() => database.exec(`SELECT 1 FROM ${table}`), table).toThrow(/no such table/u);
    }
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

describe("the activity Queue's Project tombstone", () => {
  it("given a Project default published before the cutover, when it is redelivered, then it is acknowledged rather than retried", async () => {
    const env: Env = createTestEnv({ AVALON_REGION: "global", APP_ENV: "test" });
    const { batch, ack, retry } = queued({
      type: "project_default_resource",
      region: "global",
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      resourceId: RESOURCE_ID,
      defaultGeneration: 1,
      workstreamId: CHANNEL_ID,
      membershipGeneration: 1,
      requestedByUserId: USER_ID,
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await consumeActivityQueue(batch, env);

    // The whole handler. A retry would reach the same answer on every
    // redelivery until the message dead-lettered, which is a non-empty
    // dead-letter queue saying something that is not a failure.
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: "retired_queue_message_terminal",
      workspace_id: WORKSPACE_ID,
      message_type: "project_default_resource",
      outcome: "skipped",
      reason: "project_default_resource_retired",
    }));
  });

  it.each([
    ["thread_backfill", { job: "description_summary", workstreamId: CHANNEL_ID, attempt: 0 }],
    ["channel_color_sync", { workstreamId: CHANNEL_ID, revision: 2 }],
  ])("acknowledges a %s message published before its lane was retired", async (type, fields) => {
    const env: Env = createTestEnv({ AVALON_REGION: "global", APP_ENV: "test" });
    const { batch, ack, retry } = queued({ type, region: "global", workspaceId: WORKSPACE_ID, ...fields });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await consumeActivityQueue(batch, env);

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: "retired_queue_message_terminal", message_type: type, reason: `${type}_retired`,
    }));
  });
});
