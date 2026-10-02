/**
 * Behavior checks for the WorkspaceDO-owned Space authority schema.
 *
 * Against the checked-in migration ledger, because a CHECK, a partial unique
 * index and a table rebuild are properties of the real statements rather than
 * of a storage mock. Runtime RPC behavior stays in the workerd suite.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

/**
 * The version that introduced the Space tables. Bumping this is part of
 * changing them: the harness stops here, so leaving it behind means these tests
 * exercise a schema production no longer has.
 */
const SPACE_SCHEMA_VERSION = 63;

/** The version that let a person order the Pinned section under All. */
const PINNED_ORDER_VERSION = 87;

const SPACE_ID = "00000000-0000-7000-8000-0000000000c1";
const OTHER_SPACE_ID = "00000000-0000-7000-8000-0000000000c2";
const CHANNEL_ID = "00000000-0000-7000-8000-0000000000c3";
const USER_ID = "00000000-0000-7000-8000-0000000000c4";
const WORKSPACE_ID = "00000000-0000-7000-8000-0000000000c5";

/**
 * Handles opened by a test, closed from a hook rather than by the last line of
 * the case: a failing assertion throws past any close at the end of a body and
 * leaks the handle into the rest of the file.
 */
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
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of WORKSPACE_DO_SCHEMA_MIGRATIONS) {
    if (migration.version <= after) continue;
    if (migration.version > through) break;
    for (const statement of migration.statements) database.exec(statement);
  }
}

function insertSpace(
  database: DatabaseSync,
  overrides: { spaceId?: string; scope?: string; systemRole?: string | null } = {},
): void {
  database.prepare(
    `INSERT INTO workspace_space_directory (
       space_id, title, scope, appearance_json, archived_at,
       created_by_user_id, system_role, authority_generation, source_version,
       payload_hash, revision, created_at, updated_at, source_created_at, source_updated_at
     ) VALUES (?, 'Hiring', ?, NULL, NULL, ?, ?, 1, 0, '', 1, 1, 1, 1, 1)`,
  ).run(
    overrides.spaceId ?? SPACE_ID,
    overrides.scope ?? "workspace",
    USER_ID,
    overrides.systemRole ?? null,
  );
}

describe("WorkspaceDO space schema", () => {
  it("given the ledger, when it is applied, then the Space tables exist at version 63", () => {
    const database = openDatabase();
    apply(database, SPACE_SCHEMA_VERSION);

    const tables = new Set(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all().map((row) => String((row as { name: string }).name)));

    for (const table of [
      "workspace_space_directory",
      "workspace_space_viewers",
      "workspace_container_order",
      "workspace_space_state",
      "space_channel_memberships",
      "space_intents",
      "space_defaults",
      "space_default_targets",
      "space_default_publications",
      "space_bootstrap",
    ]) expect(tables.has(table)).toBe(true);
    // The scratch table the retirement-graph rebuild carries rows through is
    // dropped by the same migration; one left behind would be a second copy of
    // the graph that nothing reads and nothing keeps in step.
    expect(tables.has("_space_copy_workspace_retirement_graph")).toBe(false);
  });

  it("given a Space directory row, when its scope is not a known audience, then the insert is refused", () => {
    const database = openDatabase();
    apply(database, SPACE_SCHEMA_VERSION);

    expect(() => insertSpace(database, { scope: "everyone" }))
      .toThrow(/CHECK constraint failed/u);
  });

  it("given an intent, when its kind is one no operation stages, then the insert is refused", () => {
    const database = openDatabase();
    apply(database, SPACE_SCHEMA_VERSION);
    const insertIntent = (kind: string): void => {
      database.prepare(
        `INSERT INTO space_intents (
           operation_id, kind, space_id, workstream_id, space_revision,
           membership_generation, delivery_generation, state, cursor, last_error_code,
           receipts_json, requested_by_user_id, not_before, attempts, created_at, updated_at
         ) VALUES (?, ?, ?, NULL, 1, NULL, NULL, 'pending', NULL, NULL, '[]', ?, 0, 0, 1, 1)`,
      ).run(`${kind}-operation`, kind, SPACE_ID, USER_ID);
    };

    // The vocabulary is exactly what `recordIntent` stages. A default's
    // delivery and the cutover each have staging, a retry gate and a consumer
    // leg of their own, so admitting their names here described rows nothing
    // could write and a resume branch nothing could reach.
    for (const kind of ["add", "remove", "audience", "archive", "restore"]) {
      expect(() => insertIntent(kind)).not.toThrow();
    }
    expect(() => insertIntent("default")).toThrow(/CHECK constraint failed/u);
    expect(() => insertIntent("bootstrap")).toThrow(/CHECK constraint failed/u);
  });

  it("given a personal order row, when its container is not one of the three, then the insert is refused", () => {
    const database = openDatabase();
    apply(database, SPACE_SCHEMA_VERSION);
    const insertOrder = (kind: string, containerId: string, itemId: string): void => {
      database.prepare(
        `INSERT INTO workspace_container_order
           (user_id, container_kind, container_id, item_id, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, 1, 1)`,
      ).run(USER_ID, kind, containerId, itemId);
    };

    // Exactly the three containers a person can arrange by hand. A fourth name
    // would describe rows the client has no list to apply them to, and the
    // client is the only reader these rows have.
    expect(() => insertOrder("organization", WORKSPACE_ID, SPACE_ID)).not.toThrow();
    expect(() => insertOrder("space", SPACE_ID, CHANNEL_ID)).not.toThrow();
    expect(() => insertOrder("channel", CHANNEL_ID, OTHER_SPACE_ID)).not.toThrow();
    expect(() => insertOrder("workstream", CHANNEL_ID, SPACE_ID))
      .toThrow(/CHECK constraint failed/u);

    // Keyed by the container as well as the item, so the same Space can hold a
    // position in the Organization's list and one inside another container
    // without the two rows colliding.
    expect(() => insertOrder("organization", WORKSPACE_ID, SPACE_ID))
      .toThrow(/UNIQUE constraint failed/u);
  });

  it("given one General Space, when a second claims the role, then the unique index refuses it", () => {
    const database = openDatabase();
    apply(database, SPACE_SCHEMA_VERSION);
    insertSpace(database, { systemRole: "general" });

    expect(() => insertSpace(database, { spaceId: OTHER_SPACE_ID, systemRole: "general" }))
      .toThrow(/UNIQUE constraint failed/u);
    // The index is partial: an Organization has as many ordinary Spaces as
    // people make, and only the protected role is singular.
    expect(() => insertSpace(database, { spaceId: OTHER_SPACE_ID })).not.toThrow();
  });

  it("given a Channel in one Space, when it is added to another, then both memberships stand", () => {
    const database = openDatabase();
    apply(database, SPACE_SCHEMA_VERSION);
    insertSpace(database);
    insertSpace(database, { spaceId: OTHER_SPACE_ID });

    const insert = database.prepare(
      `INSERT INTO space_channel_memberships
         (space_id, workstream_id, state, generation, joined_at, updated_at, removed_at)
       VALUES (?, ?, 'active', 1, 1, 1, NULL)`,
    );
    insert.run(SPACE_ID, CHANNEL_ID);
    expect(() => insert.run(OTHER_SPACE_ID, CHANNEL_ID)).not.toThrow();
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM space_channel_memberships WHERE workstream_id = ?",
    ).get(CHANNEL_ID)).toMatchObject({ count: 2 });
  });

  it("given a default target, when no default registers it, then the foreign key refuses it", () => {
    const database = openDatabase();
    apply(database, SPACE_SCHEMA_VERSION);
    insertSpace(database);

    expect(() => database.prepare(
      `INSERT INTO space_default_targets
         (space_id, kind, target_id, default_generation, workstream_id,
          membership_generation, state, attempts, created_at, updated_at,
          applied_at, last_error_code)
       VALUES (?, 'resource', ?, 1, ?, 1, 'pending', 0, 1, 1, NULL, NULL)`,
    ).run(SPACE_ID, CHANNEL_ID, CHANNEL_ID)).toThrow(/FOREIGN KEY constraint failed/u);
  });

  it("given the bootstrap row, when the ledger is applied, then it is seeded pending", () => {
    const database = openDatabase();
    apply(database, SPACE_SCHEMA_VERSION);

    expect(database.prepare("SELECT phase, general_space_id, blocked_json FROM space_bootstrap").get())
      .toMatchObject({ phase: "pending", general_space_id: null, blocked_json: "[]" });
  });

  it("given a retirement graph with rows, when 63 widens its parent kinds, then the rows survive", () => {
    const database = openDatabase();
    apply(database, SPACE_SCHEMA_VERSION - 1);
    // One node already receipted and one still outstanding: the receipt is the
    // only record that a node was retired, so a rebuild that re-derived the
    // graph instead of carrying it would un-retire whatever the last pass
    // finished.
    database.prepare(
      `INSERT INTO workspace_retirement_graph (parent_kind, parent_id, recorded_at, retired_at)
       VALUES ('workstream', ?, 10, 20), ('automation', ?, 10, NULL)`,
    ).run(CHANNEL_ID, OTHER_SPACE_ID);
    expect(() => database.prepare(
      `INSERT INTO workspace_retirement_graph (parent_kind, parent_id, recorded_at, retired_at)
       VALUES ('space', ?, 10, NULL)`,
    ).run(SPACE_ID)).toThrow(/CHECK constraint failed/u);

    apply(database, SPACE_SCHEMA_VERSION, SPACE_SCHEMA_VERSION - 1);

    expect(database.prepare(
      "SELECT parent_kind, parent_id, recorded_at, retired_at FROM workspace_retirement_graph ORDER BY parent_kind",
    ).all()).toEqual([
      { parent_kind: "automation", parent_id: OTHER_SPACE_ID, recorded_at: 10, retired_at: null },
      { parent_kind: "workstream", parent_id: CHANNEL_ID, recorded_at: 10, retired_at: 20 },
    ]);
    expect(() => database.prepare(
      `INSERT INTO workspace_retirement_graph (parent_kind, parent_id, recorded_at, retired_at)
       VALUES ('space', ?, 10, NULL)`,
    ).run(SPACE_ID)).not.toThrow();
  });

  it("given personal order rows, when 87 widens their kinds, then the rows survive and All's pins are accepted", () => {
    const database = openDatabase();
    apply(database, PINNED_ORDER_VERSION - 1);
    const insertOrder = (kind: string, containerId: string, itemId: string, position = 0): void => {
      database.prepare(
        `INSERT INTO workspace_container_order
           (user_id, container_kind, container_id, item_id, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 2)`,
      ).run(USER_ID, kind, containerId, itemId, position);
    };
    insertOrder("organization", WORKSPACE_ID, SPACE_ID);
    insertOrder("space", SPACE_ID, CHANNEL_ID, 3);
    expect(() => insertOrder("pinned", WORKSPACE_ID, CHANNEL_ID)).toThrow(/CHECK constraint failed/u);

    apply(database, PINNED_ORDER_VERSION, PINNED_ORDER_VERSION - 1);

    // A person's arrangement of their Spaces and of a Space's Channels is
    // carried through the rebuild, positions and timestamps intact.
    expect(database.prepare(
      `SELECT container_kind, container_id, item_id, position, created_at, updated_at
         FROM workspace_container_order ORDER BY container_kind`,
    ).all()).toEqual([
      { container_kind: "organization", container_id: WORKSPACE_ID, item_id: SPACE_ID, position: 0, created_at: 1, updated_at: 2 },
      { container_kind: "space", container_id: SPACE_ID, item_id: CHANNEL_ID, position: 3, created_at: 1, updated_at: 2 },
    ]);
    expect(() => insertOrder("pinned", WORKSPACE_ID, CHANNEL_ID)).not.toThrow();
    expect(() => insertOrder("workstream", CHANNEL_ID, SPACE_ID)).toThrow(/CHECK constraint failed/u);
    // The rebuild brings back the ordering index the reads seek on.
    expect(database.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'workspace_container_order' AND name NOT LIKE 'sqlite_%'",
    ).all()).toEqual([{ name: "workspace_container_order_position_idx" }]);
  });
});
