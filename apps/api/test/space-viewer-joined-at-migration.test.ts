/**
 * WorkspaceDO migration 134 rebuilds `space_viewers` to add a required
 * `joined_at`. This proves the SQL against the shipped schema: every existing
 * row is dated at its Channel's creation, a row without one is refused, and
 * the rebuild leaves the memory digest's participant triggers in place.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const JOINED_AT_MIGRATION_VERSION = 134;
const CHANNEL = "00000000-0000-7000-8000-000000134001";
const OTHER_CHANNEL = "00000000-0000-7000-8000-000000134002";
const ORPHAN_CHANNEL = "00000000-0000-7000-8000-000000134003";
const OWNER = "00000000-0000-7000-8000-000000134011";
const MEMBER = "00000000-0000-7000-8000-000000134012";

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

function seedSpace(database: DatabaseSync, spaceId: string, createdAt: number): void {
  database.prepare(
    `INSERT INTO spaces (
       space_id, title, scope, appearance_json, archived_at, created_by_user_id, system_role,
       authority_generation, source_version, payload_hash, revision, created_at, updated_at
     ) VALUES (?, 'Channel', 'workspace', NULL, NULL, ?, NULL, 1, 1, 'hash', 1, ?, ?)`,
  ).run(spaceId, OWNER, createdAt, createdAt);
}

function seedViewer(database: DatabaseSync, spaceId: string, userId: string, isParticipant: 0 | 1): void {
  database.prepare(
    `INSERT INTO space_viewers (space_id, user_id, is_participant, authority_generation, source_version, payload_hash)
     VALUES (?, ?, ?, 1, 1, 'hash')`,
  ).run(spaceId, userId, isParticipant);
}

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe("WorkspaceDO migration 134", () => {
  it("dates every existing Channel participant at the Channel's creation, and 0 where the Channel row is missing", () => {
    const database = openDatabase();
    apply(database, JOINED_AT_MIGRATION_VERSION - 1);
    seedSpace(database, CHANNEL, 1_700_000_000_000);
    seedSpace(database, OTHER_CHANNEL, 1_750_000_000_000);
    seedViewer(database, CHANNEL, OWNER, 1);
    seedViewer(database, CHANNEL, MEMBER, 0);
    seedViewer(database, OTHER_CHANNEL, MEMBER, 1);
    seedViewer(database, ORPHAN_CHANNEL, MEMBER, 1);

    apply(database, JOINED_AT_MIGRATION_VERSION, JOINED_AT_MIGRATION_VERSION - 1);

    expect(database.prepare(
      "SELECT space_id, user_id, is_participant, joined_at FROM space_viewers ORDER BY space_id, user_id",
    ).all()).toEqual([
      { space_id: CHANNEL, user_id: OWNER, is_participant: 1, joined_at: 1_700_000_000_000 },
      { space_id: CHANNEL, user_id: MEMBER, is_participant: 0, joined_at: 1_700_000_000_000 },
      { space_id: OTHER_CHANNEL, user_id: MEMBER, is_participant: 1, joined_at: 1_750_000_000_000 },
      { space_id: ORPHAN_CHANNEL, user_id: MEMBER, is_participant: 1, joined_at: 0 },
    ]);
  });

  it("refuses a row with no join time", () => {
    const database = openDatabase();
    apply(database, JOINED_AT_MIGRATION_VERSION);
    seedSpace(database, CHANNEL, 1_700_000_000_000);

    expect(() => seedViewer(database, CHANNEL, MEMBER, 1)).toThrow(/NOT NULL constraint failed: space_viewers\.joined_at/u);
  });

  it("keeps marking a Channel's memory digest holders when a participant joins", () => {
    const database = openDatabase();
    apply(database, JOINED_AT_MIGRATION_VERSION);
    seedSpace(database, CHANNEL, 1_700_000_000_000);
    database.prepare(
      `INSERT INTO memory_digest_holders (conversation, parent_kind, parent_id, substream_id, refreshed_at)
       VALUES ('space-holder', 'space', ?, '0', 0)`,
    ).run(CHANNEL);

    database.prepare(
      `INSERT INTO space_viewers (space_id, user_id, is_participant, authority_generation, source_version, payload_hash, joined_at)
       VALUES (?, ?, 1, 1, 1, 'hash', 1)`,
    ).run(CHANNEL, MEMBER);

    expect(database.prepare("SELECT conversation FROM memory_digest_sync").all()).toEqual([{ conversation: "space-holder" }]);
  });
});
