/**
 * WorkspaceDO migration 93 makes every Space Organization-wide. A Space grants
 * no reader to its Channels, so the migration touches Spaces and nothing that
 * says who reads a Channel. This proves the SQL against the shipped schema:
 * which Spaces change, that no audience walk is staged, and that the client
 * waterline moves only when a Space did.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const PUBLIC_MIGRATION_VERSION = 93;
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

function waterline(database: DatabaseSync): number {
  return (database.prepare("SELECT waterline FROM workspace_space_state").get() as { waterline: number }).waterline;
}

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe("WorkspaceDO migration 93", () => {
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
      { space_id: PRIVATE, scope: "workspace", revision: 5 },
      { space_id: ARCHIVED, scope: "workspace", revision: 5 },
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
