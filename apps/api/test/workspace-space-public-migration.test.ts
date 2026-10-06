/**
 * WorkspaceDO migration 93 makes every private Space Organization-wide and
 * stages the `audience` intent the alarm carries to each member Channel. This
 * proves the SQL against the shipped schema: which Spaces change, the revision
 * the intent is fenced on, who it runs as, and that its id is one the intent
 * RPCs accept. The walk itself is the existing resume path.
 */
import { DatabaseSync } from "node:sqlite";
import { IdSchema } from "@rally/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const PUBLIC_MIGRATION_VERSION = 93;
const WORKSPACE_ID = "00000000-0000-7000-8000-000000000930";
const GENERAL = "00000000-0000-7000-8000-000000000931";
const PRIVATE = "00000000-0000-7000-8000-000000000932";
const ARCHIVED = "00000000-0000-7000-8000-000000000933";
const ORPHANED = "00000000-0000-7000-8000-000000000934";
const CREATOR = "00000000-0000-7000-8000-000000000941";
const PARTICIPANT = "00000000-0000-7000-8000-000000000942";
// Sorts first, so a Space that picks the participant over it shows the preference.
const BYSTANDER = "00000000-0000-7000-8000-000000000940";
const DEPARTED = "00000000-0000-7000-8000-000000000944";

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
  spaceId: string; scope: "personal" | "workspace"; createdBy: string | null;
  systemRole?: "general"; archivedAt?: number; participants?: string[];
}): void {
  database.prepare(
    `INSERT INTO spaces (
       space_id, title, scope, appearance_json, archived_at, created_by_user_id, system_role,
       authority_generation, source_version, payload_hash, revision, created_at, updated_at
     ) VALUES (?, 'Space', ?, NULL, ?, ?, ?, 1, 1, 'hash', 4, 1, 1)`,
  ).run(input.spaceId, input.scope, input.archivedAt ?? null, input.createdBy, input.systemRole ?? null);
  for (const userId of input.participants ?? []) {
    database.prepare(
      `INSERT INTO space_viewers (space_id, user_id, is_participant, authority_generation, source_version, payload_hash)
       VALUES (?, ?, 1, 1, 1, 'hash')`,
    ).run(input.spaceId, userId);
  }
}

function seedMember(database: DatabaseSync, userId: string, status: "active" | "suspended"): void {
  database.prepare(
    `INSERT INTO workspace_member_status (user_id, relationship_json, removed_incarnation, active, sequence, updated_at)
     VALUES (?, ?, NULL, ?, 1, 1)`,
  ).run(userId, JSON.stringify({
    workspaceId: WORKSPACE_ID, userId, accessClass: "member", role: "member", status, incarnation: "i", revision: 1,
  }), status === "active" ? 1 : 0);
}

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe("WorkspaceDO migration 93", () => {
  it("widens every private Space and stages an audience walk as a member who owned it", () => {
    const database = openDatabase();
    apply(database, PUBLIC_MIGRATION_VERSION - 1);
    seedMember(database, CREATOR, "suspended");
    seedMember(database, PARTICIPANT, "active");
    seedMember(database, BYSTANDER, "active");
    seedSpace(database, { spaceId: GENERAL, scope: "workspace", createdBy: CREATOR, systemRole: "general" });
    // The creator has left, so the walk runs as the participant still here.
    seedSpace(database, { spaceId: PRIVATE, scope: "personal", createdBy: CREATOR, participants: [CREATOR, PARTICIPANT] });
    seedSpace(database, { spaceId: ARCHIVED, scope: "personal", createdBy: PARTICIPANT, archivedAt: 5, participants: [PARTICIPANT] });
    // Nobody who owned it is still here, so the first active member runs the walk.
    seedSpace(database, { spaceId: ORPHANED, scope: "personal", createdBy: DEPARTED, participants: [DEPARTED] });
    const waterline = (database.prepare("SELECT waterline FROM workspace_space_state").get() as { waterline: number }).waterline;

    apply(database, PUBLIC_MIGRATION_VERSION, PUBLIC_MIGRATION_VERSION - 1);

    expect(database.prepare("SELECT space_id, scope, revision FROM spaces ORDER BY space_id").all()).toEqual([
      { space_id: GENERAL, scope: "workspace", revision: 4 },
      { space_id: PRIVATE, scope: "workspace", revision: 5 },
      { space_id: ARCHIVED, scope: "workspace", revision: 5 },
      { space_id: ORPHANED, scope: "workspace", revision: 5 },
    ]);
    const intents = database.prepare(
      `SELECT operation_id, kind, space_id, workstream_id, space_revision, state, requested_by_user_id, not_before
         FROM space_intents ORDER BY space_id`,
    ).all() as Array<{ operation_id: string } & Record<string, unknown>>;
    expect(intents.map((intent) => ({ ...intent, operation_id: undefined }))).toEqual([
      {
        operation_id: undefined, kind: "audience", space_id: PRIVATE, workstream_id: null, space_revision: 5, state: "pending",
        requested_by_user_id: PARTICIPANT, not_before: 0,
      },
      {
        operation_id: undefined, kind: "audience", space_id: ORPHANED, workstream_id: null, space_revision: 5, state: "pending",
        requested_by_user_id: BYSTANDER, not_before: 0,
      },
    ]);
    for (const intent of intents) expect(IdSchema.safeParse(intent.operation_id).success).toBe(true);
    expect(intents[0]!.operation_id).not.toBe(intents[1]!.operation_id);
    expect(database.prepare("SELECT waterline FROM workspace_space_state").get()).toEqual({ waterline: waterline + 1 });
    expect(database.prepare("SELECT name FROM sqlite_schema WHERE name = '_space_public_v93'").all()).toEqual([]);
  });
});
