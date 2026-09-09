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

// The version that most recently rebuilt `projects`. Bumping this is part of
// changing that table: the harness stops here, so leaving it behind means these
// tests exercise a schema production no longer has — which is how a palette key
// the current contract offers came to be inserted against the v14 CHECK.
const PROJECT_SCHEMA_VERSION = 45;

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
  it("given an object on the previous schema, when the palette migration runs, then projects and everything cascading from them survive", () => {
    // v45 replaces `projects` to widen a CHECK vocabulary, and six tables
    // cascade from it. `DROP TABLE` fires those cascades for real — foreign keys
    // cannot be turned off inside a Durable Object event that has already
    // touched SQLite — so a child that is not copied out first is silently
    // emptied and nothing fails at the time.
    const database = new DatabaseSync(":memory:");
    apply(database, 44);

    insertProject(database, { colorKey: "teal" });
    database.prepare(
      `INSERT INTO project_participants (project_id, user_id, state, generation, created_at, updated_at)
       VALUES (?, ?, 'active', 1, 1, 1)`,
    ).run("00000000-0000-7000-8000-0000000000b1", "00000000-0000-7000-8000-0000000000b2");
    database.prepare(
      `INSERT INTO workspace_project_order (user_id, project_id, position, created_at, updated_at)
       VALUES (?, ?, 1, 1, 1)`,
    ).run("00000000-0000-7000-8000-0000000000b2", "00000000-0000-7000-8000-0000000000b1");

    apply(database, 45, 44);

    // The project itself, still holding the colour its owner chose before that
    // colour left the picker.
    const project = database.prepare(
      "SELECT icon_color_key FROM projects WHERE project_id = ?",
    ).get("00000000-0000-7000-8000-0000000000b1") as { icon_color_key: string } | undefined;
    expect(project?.icon_color_key).toBe("teal");

    // And the rows that would have gone with it.
    const participants = database.prepare("SELECT COUNT(*) AS n FROM project_participants").get() as { n: number };
    expect(participants.n).toBe(1);
    const order = database.prepare("SELECT COUNT(*) AS n FROM workspace_project_order").get() as { n: number };
    expect(order.n).toBe(1);

    // No scratch table left behind.
    const holds = database.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE '%\\_v45\\_hold' ESCAPE '\\'",
    ).get() as { n: number };
    expect(holds.n).toBe(0);

    // The widened vocabulary is what the object actually enforces now.
    expect(() => insertProject(database, {
      projectId: "00000000-0000-7000-8000-0000000000b9",
      normalizedName: "design",
      colorKey: "fuchsia",
    })).not.toThrow();
  });

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

  it("given the shared icon and color registries, when every choice is persisted, then the WorkspaceDO constraint accepts all of them", () => {
    const database = new DatabaseSync(":memory:");
    apply(database, PROJECT_SCHEMA_VERSION);
    for (const [index, iconKey] of PROJECT_ICON_KEYS.entries()) {
      expect(() => insertProject(database, {
        projectId: `icon-${index}`,
        iconKey,
        normalizedName: `icon-${index}`,
      })).not.toThrow();
    }
    for (const [index, colorKey] of PROJECT_COLOR_KEYS.entries()) {
      expect(() => insertProject(database, {
        projectId: `color-${index}`,
        colorKey,
        normalizedName: `color-${index}`,
      })).not.toThrow();
    }
    database.close();
  });

  it("given an existing project authority, when the publication outbox migration applies, then earlier state survives", () => {
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

  it("given private projects with separate audiences, when their names match, then no hidden name is leaked through a conflict", () => {
    const database = new DatabaseSync(":memory:");
    apply(database, PROJECT_SCHEMA_VERSION);
    insertProject(database);

    expect(() => insertProject(database, {
      projectId: "00000000-0000-7000-8000-0000000000b6",
      name: " HIRING ",
      normalizedName: "hiring",
      creatorUserId: "00000000-0000-7000-8000-0000000000b9",
    })).not.toThrow();
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
