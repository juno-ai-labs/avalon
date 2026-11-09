/**
 * WorkspaceDO migration 94 makes every Space Organization-wide. A Space grants
 * no reader to its Channels, so the migration touches Spaces and nothing that
 * says who reads a Channel. This proves the SQL against the shipped schema:
 * which Spaces change, that no audience walk is staged, and that the client
 * waterline moves only when a Space did.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const PUBLIC_MIGRATION_VERSION = 94;
const GENERAL = "00000000-0000-7000-8000-000000000931";
const PRIVATE = "00000000-0000-7000-8000-000000000932";
const ARCHIVED = "00000000-0000-7000-8000-000000000933";
const CREATOR = "00000000-0000-7000-8000-000000000941";
const PARTICIPANT = "00000000-0000-7000-8000-000000000942";

const openDatabases: DatabaseSync[] = [];

function openDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  openDatabases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

function apply(database: DatabaseSync, through: number, after = 0): void {
  for (const migration of WORKSPACE_DO_SCHEMA_MIGRATIONS) {
    if (migration.version <= after) continue;
    if (migration.version > through) break;
    for (const statement of migration.statements) database.exec(statement);
  }
}

function seedSpace(database: DatabaseSync, input: {
  spaceId: string; scope: "personal" | "workspace"; systemRole?: "general"; archivedAt?: number;
  participants?: string[];
}): void {
  database.prepare(
    `INSERT INTO spaces (
       space_id, title, scope, appearance_json, archived_at, created_by_user_id, system_role,
       authority_generation, source_version, payload_hash, revision, created_at, updated_at
     ) VALUES (?, 'Space', ?, NULL, ?, ?, ?, 1, 1, 'hash', 4, 1, 1)`,
  ).run(input.spaceId, input.scope, input.archivedAt ?? null, CREATOR, input.systemRole ?? null);
  for (const userId of input.participants ?? []) {
    database.prepare(
      `INSERT INTO space_viewers (space_id, user_id, is_participant, authority_generation, source_version, payload_hash)
       VALUES (?, ?, 1, 1, 1, 'hash')`,
    ).run(input.spaceId, userId);
  }
}

function seedDefault(database: DatabaseSync, spaceId: string, kind: "resource" | "sidekick", targetId: string): void {
  database.prepare(
    `INSERT INTO space_defaults (space_id, kind, target_id, state, generation, created_at, updated_at, removed_at)
     VALUES (?, ?, ?, 'active', 2, 1, 1, NULL)`,
  ).run(spaceId, kind, targetId);
}

function waterline(database: DatabaseSync): number {
  return (database.prepare("SELECT waterline FROM workspace_space_state").get() as { waterline: number }).waterline;
}

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe("WorkspaceDO migration 94", () => {
  it("widens every private Space, archived ones too, and stages nothing for their Channels", () => {
    const database = openDatabase();
    apply(database, PUBLIC_MIGRATION_VERSION - 1);
    seedSpace(database, { spaceId: GENERAL, scope: "workspace", systemRole: "general" });
    seedSpace(database, { spaceId: PRIVATE, scope: "personal", participants: [CREATOR, PARTICIPANT] });
    seedSpace(database, { spaceId: ARCHIVED, scope: "personal", archivedAt: 5, participants: [PARTICIPANT] });
    const before = waterline(database);

    apply(database, PUBLIC_MIGRATION_VERSION, PUBLIC_MIGRATION_VERSION - 1);

    expect(database.prepare("SELECT space_id, scope, revision FROM spaces ORDER BY space_id").all()).toEqual([
      { space_id: GENERAL, scope: "workspace", revision: 4 },
      // The revision stays: a staged add is fenced on it.
      { space_id: PRIVATE, scope: "workspace", revision: 4 },
      { space_id: ARCHIVED, scope: "workspace", revision: 4 },
    ]);
    // Participants stay: they are who edits the Space, not who reads its Channels.
    expect(database.prepare(
      "SELECT space_id, user_id FROM space_viewers WHERE is_participant = 1 ORDER BY space_id, user_id",
    ).all()).toEqual([
      { space_id: PRIVATE, user_id: CREATOR },
      { space_id: PRIVATE, user_id: PARTICIPANT },
      { space_id: ARCHIVED, user_id: PARTICIPANT },
    ]);
    expect(database.prepare("SELECT COUNT(*) AS intents FROM space_intents").get()).toEqual({ intents: 0 });
    expect(waterline(database)).toBe(before + 1);
  });

  it("retires a private Space's resource defaults and keeps every other default", () => {
    const database = openDatabase();
    apply(database, PUBLIC_MIGRATION_VERSION - 1);
    seedSpace(database, { spaceId: GENERAL, scope: "workspace", systemRole: "general" });
    seedSpace(database, { spaceId: PRIVATE, scope: "personal", participants: [CREATOR] });
    seedDefault(database, PRIVATE, "resource", "private-resource");
    seedDefault(database, PRIVATE, "sidekick", "workspace-sidekick");
    seedDefault(database, GENERAL, "resource", "general-resource");

    apply(database, PUBLIC_MIGRATION_VERSION, PUBLIC_MIGRATION_VERSION - 1);

    expect(database.prepare(
      "SELECT space_id, target_id, state, generation FROM space_defaults ORDER BY target_id",
    ).all()).toEqual([
      { space_id: GENERAL, target_id: "general-resource", state: "active", generation: 2 },
      { space_id: PRIVATE, target_id: "private-resource", state: "removed", generation: 3 },
      { space_id: PRIVATE, target_id: "workspace-sidekick", state: "active", generation: 2 },
    ]);
  });

  it("drops the tables that recorded which Space supplied a Channel's readers", () => {
    const database = openDatabase();
    apply(database, PUBLIC_MIGRATION_VERSION - 1);
    database.prepare(
      `INSERT INTO parent_access_operations (parent_id, operation_id, request_json, result_json, created_at)
       VALUES ('channel', 'apply', ?, ?, 1)`,
    ).run(JSON.stringify({ kind: "apply_space_source", spaceId: PRIVATE }),
      JSON.stringify({ ok: true, plan: { widenScope: true, seatUserIds: [] } }));

    apply(database, PUBLIC_MIGRATION_VERSION, PUBLIC_MIGRATION_VERSION - 1);

    expect(database.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('parent_space_readers', 'parent_space_sources', 'parent_direct_audience', 'parent_access_operations')`,
    ).all()).toEqual([]);
  });

  it("leaves an Organization with no private Space exactly as it was", () => {
    const database = openDatabase();
    apply(database, PUBLIC_MIGRATION_VERSION - 1);
    seedSpace(database, { spaceId: GENERAL, scope: "workspace", systemRole: "general" });
    const before = waterline(database);

    apply(database, PUBLIC_MIGRATION_VERSION, PUBLIC_MIGRATION_VERSION - 1);

    expect(database.prepare("SELECT space_id, scope, revision FROM spaces").all()).toEqual([
      { space_id: GENERAL, scope: "workspace", revision: 4 },
    ]);
    expect(waterline(database)).toBe(before);
  });

});
