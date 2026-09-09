import { describe, expect, it } from "vitest";

import { PROJECT_COLOR_KEYS_STORABLE, PROJECT_ICON_KEYS } from "@rally/contracts";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

/**
 * The statement that most recently created the `projects` table. A CHECK
 * vocabulary lives in the text of that statement, so this is the only place
 * that says what an upgraded object will actually accept.
 */
function latestProjectsTableSql(): string {
  const created = WORKSPACE_DO_SCHEMA_MIGRATIONS
    .flatMap((migration) => migration.statements.map((statement) => ({ version: migration.version, statement })))
    .filter(({ statement }) => /CREATE TABLE projects(_v\d+)? \(/.test(statement))
    .sort((a, b) => a.version - b.version);
  expect(created.length, "no migration creates the projects table").toBeGreaterThan(0);
  return created[created.length - 1]!.statement;
}

function checkVocabulary(sql: string, column: string): string[] {
  const match = new RegExp(`${column} TEXT NOT NULL CHECK \\(${column} IN \\(([^)]*)\\)\\)`).exec(sql);
  expect(match, `no CHECK vocabulary for ${column}`).not.toBeNull();
  return [...(match as RegExpExecArray)[1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
}

describe("workspace project palette", () => {
  it("given the newest projects table, when its CHECK is read, then it accepts every storable colour", () => {
    // Adding a colour to the contract without a migration would pass typecheck,
    // pass every unit test, and then fail on the INSERT in production — for the
    // one workspace that picked it. This is the guard that turns that into a
    // build failure instead.
    const vocabulary = checkVocabulary(latestProjectsTableSql(), "icon_color_key");
    for (const key of PROJECT_COLOR_KEYS_STORABLE) {
      expect(vocabulary, `icon_color_key CHECK does not accept "${key}"; widen it in a new migration`).toContain(key);
    }
  });

  it("given the newest projects table, when its CHECK is read, then it accepts every icon", () => {
    const vocabulary = checkVocabulary(latestProjectsTableSql(), "icon_key");
    for (const key of PROJECT_ICON_KEYS) {
      expect(vocabulary, `icon_key CHECK does not accept "${key}"; widen it in a new migration`).toContain(key);
    }
  });

  it("given a shipped migration, when the palette moves, then its SQL text does not move with it", () => {
    // Migration 14 shipped with twelve colours. Interpolating the live constant
    // meant its text changed under it, so two objects created either side of a
    // palette edit disagreed about the schema with nothing recording it. Its
    // vocabulary is frozen now and must stay exactly what shipped.
    const fourteen = WORKSPACE_DO_SCHEMA_MIGRATIONS.find((migration) => migration.version === 14);
    expect(fourteen).toBeDefined();
    const create = fourteen!.statements.find((statement) => statement.startsWith("CREATE TABLE projects ("));
    expect(create).toBeDefined();
    expect(checkVocabulary(create as string, "icon_color_key")).toEqual([
      "gray", "brown", "red", "orange", "yellow", "green",
      "teal", "cyan", "blue", "indigo", "purple", "pink",
    ]);
  });

  it("given migration 45, when it replaces the parent, then every cascading child is held and restored", () => {
    // `DROP TABLE projects` fires ON DELETE CASCADE for real — foreign keys stay
    // enforced, because PRAGMA foreign_keys = OFF is a no-op inside an object
    // event that has already touched SQLite. A child that is not copied out
    // first is silently emptied.
    const migration = WORKSPACE_DO_SCHEMA_MIGRATIONS.find((entry) => entry.version === 45);
    expect(migration).toBeDefined();
    const statements = migration!.statements;

    const held = statements
      .map((statement) => /^CREATE TABLE (\w+)_v45_hold AS SELECT \* FROM \1$/.exec(statement)?.[1])
      .filter((table): table is string => table !== undefined);

    // Named rather than derived. Deriving the list from the migration makes this
    // test agree with whatever the migration happens to hold, so dropping a
    // table from PROJECT_CASCADE_DEPENDENTS would leave it green while that
    // table's rows cascade away. This is the closure of `projects`, written out.
    expect([...held].sort()).toEqual([
      "project_default_resource_publications",
      "project_default_resource_targets",
      "project_default_resources",
      "project_participants",
      "project_workstream_memberships",
      "workspace_project_order",
    ]);

    const dropIndex = statements.findIndex((statement) => statement === "DROP TABLE projects");
    expect(dropIndex).toBeGreaterThan(0);

    for (const table of held) {
      const copy = statements.findIndex((s) => s === `CREATE TABLE ${table}_v45_hold AS SELECT * FROM ${table}`);
      const restore = statements.findIndex((s) => s === `INSERT INTO ${table} SELECT * FROM ${table}_v45_hold`);
      const cleanup = statements.findIndex((s) => s === `DROP TABLE ${table}_v45_hold`);
      expect(copy, `${table} is not copied out`).toBeGreaterThanOrEqual(0);
      expect(copy, `${table} is copied after the parent is dropped`).toBeLessThan(dropIndex);
      expect(restore, `${table} is never restored`).toBeGreaterThan(dropIndex);
      expect(cleanup, `${table}'s scratch copy is left behind`).toBeGreaterThan(restore);
    }

    // Children are restored parents-first, or the insert hits a key that is not
    // there yet.
    const restoreOrder = held.map((table) => statements.findIndex((s) => s === `INSERT INTO ${table} SELECT * FROM ${table}_v45_hold`));
    expect([...restoreOrder].sort((a, b) => a - b)).toEqual(restoreOrder);
    const defaults = held.indexOf("project_default_resources");
    const targets = held.indexOf("project_default_resource_targets");
    const publications = held.indexOf("project_default_resource_publications");
    expect(defaults).toBeGreaterThanOrEqual(0);
    expect(targets).toBeGreaterThan(defaults);
    expect(publications).toBeGreaterThan(targets);
  });
});
