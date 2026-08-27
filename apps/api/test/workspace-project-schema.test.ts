/**
 * Behavior checks for the WorkspaceDO-owned project authority schema.
 *
 * These use the checked-in migration ledger because SQLite constraints and
 * upgrade behavior are properties of the real statements, not of a storage
 * mock. Runtime RPC behavior stays in the workerd suite.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { PROJECT_COLOR_KEYS, PROJECT_ICON_KEYS } from "@rally/contracts";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const PROJECT_SCHEMA_VERSION = 15;

function apply(database: DatabaseSync, through: number, after = 0): void {
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of WORKSPACE_DO_SCHEMA_MIGRATIONS) {
    if (migration.version <= after) continue;
    if (migration.version > through) break;
    for (const statement of migration.statements) database.exec(statement);
  }
}

function insertProject(database: DatabaseSync, overrides: Record<string, unknown> = {}): void {
  const row = {
    projectId: "00000000-0000-7000-8000-0000000000b1",
    name: "Hiring",
    normalizedName: "hiring",
    iconKey: PROJECT_ICON_KEYS[0],
    colorKey: PROJECT_COLOR_KEYS[0],
    scope: "personal",
    status: "active",
    creatorUserId: "00000000-0000-7000-8000-0000000000b2",
    ...overrides,
  };
  database.prepare(
    `INSERT INTO projects (
       project_id, name, normalized_name, icon_key, icon_color_key, scope, status,
       creator_user_id, created_at, updated_at, presentation_revision,
       audience_generation, lifecycle_generation
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 1, 1)`,
  ).run(
    row.projectId,
    row.name,
    row.normalizedName,
    row.iconKey,
    row.colorKey,
    row.scope,
    row.status,
    row.creatorUserId,
  );
}

describe("the WorkspaceDO project authority migration", () => {
  it("given a fresh object, when the ledger runs, then only approved presentation values persist", () => {
    const database = new DatabaseSync(":memory:");
    apply(database, PROJECT_SCHEMA_VERSION);

    expect(() => insertProject(database)).not.toThrow();
    expect(() => insertProject(database, {
      projectId: "00000000-0000-7000-8000-0000000000b3",
      normalizedName: "design",
      iconKey: "code",
    })).toThrow();
    expect(() => insertProject(database, {
      projectId: "00000000-0000-7000-8000-0000000000b4",
      normalizedName: "finance",
      colorKey: "chartreuse",
    })).toThrow();
  });

  it("given an existing workspace object, when version 13 applies, then earlier state survives", () => {
    const database = new DatabaseSync(":memory:");
    apply(database, PROJECT_SCHEMA_VERSION - 1);
    database.prepare(
      `INSERT INTO workspace_identity
         (id, workspace_id, region, placement_affinity, created_at, updated_at)
       VALUES (1, ?, 'global', 'wnam', 1, 1)`,
    ).run("00000000-0000-7000-8000-0000000000b5");

    apply(database, PROJECT_SCHEMA_VERSION, PROJECT_SCHEMA_VERSION - 1);
    insertProject(database);

    expect(database.prepare("SELECT workspace_id FROM workspace_identity WHERE id = 1").get())
      .toEqual({ workspace_id: "00000000-0000-7000-8000-0000000000b5" });
    expect(database.prepare("SELECT name FROM projects").all()).toEqual([{ name: "Hiring" }]);
  });

  it("given a normalized project name, when the same name differs only by case, then creation conflicts", () => {
    const database = new DatabaseSync(":memory:");
    apply(database, PROJECT_SCHEMA_VERSION);
    insertProject(database);

    expect(() => insertProject(database, {
      projectId: "00000000-0000-7000-8000-0000000000b6",
      name: " HIRING ",
      normalizedName: "hiring",
    })).toThrow();
  });

  it("given one work stream, when two historical project memberships exist, then the schema keeps both", () => {
    const database = new DatabaseSync(":memory:");
    apply(database, PROJECT_SCHEMA_VERSION);
    insertProject(database);
    insertProject(database, {
      projectId: "00000000-0000-7000-8000-0000000000b7",
      name: "Second",
      normalizedName: "second",
    });

    const insert = database.prepare(
      `INSERT INTO project_workstream_memberships
         (project_id, workstream_id, state, generation, joined_at, updated_at, removed_at)
       VALUES (?, ?, 'removed', 1, 1, 2, 2)`,
    );
    const workstreamId = "00000000-0000-7000-8000-0000000000b8";
    insert.run("00000000-0000-7000-8000-0000000000b1", workstreamId);
    insert.run("00000000-0000-7000-8000-0000000000b7", workstreamId);

    expect(database.prepare(
      "SELECT project_id FROM project_workstream_memberships WHERE workstream_id = ? ORDER BY project_id",
    ).all(workstreamId)).toHaveLength(2);
  });
});
