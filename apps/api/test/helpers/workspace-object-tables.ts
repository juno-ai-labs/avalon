import { DatabaseSync } from "node:sqlite";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../../src/durable-objects/workspace-do";

/**
 * Add one of the WorkspaceDO's own tables to a regional snapshot, from the
 * object's ledger rather than a hand-written `CREATE TABLE`.
 *
 * The workspace alarm's due-time queries run against the object's tables, and
 * a few of those — `workspace_workstream_resource_links` — have never had a
 * regional copy. A Node test that drives those queries over a regional
 * snapshot needs the table the query names, in the shape the object gives it;
 * copying the statement would let the two drift.
 */
export function createWorkspaceObjectTable(database: DatabaseSync, table: string): void {
  const definition = new RegExp(`^\\s*CREATE (?:TABLE|INDEX) \\S+\\s+(?:ON )?${table}\\b`, "u");
  const statements = WORKSPACE_DO_SCHEMA_MIGRATIONS
    .flatMap((migration) => migration.statements)
    .filter((statement) => definition.test(statement) || new RegExp(`^\\s*CREATE TABLE ${table}\\b`, "u").test(statement));
  if (statements.length === 0) throw new Error(`workspace_object_table_unknown:${table}`);
  for (const statement of statements) database.exec(statement);
}

/**
 * A Node database holding the WorkspaceDO's whole schema, from its ledger.
 *
 * The resource services run against `env.DB`, which in production is the
 * D1-shaped adapter over this object — so a fixture that hand-writes
 * `CREATE TABLE resources` is asserting against its own idea of the schema.
 * Version capture in particular lives entirely in the object's triggers, and a
 * fixture without them cannot tell a swap that records history from one that
 * silently does not.
 *
 * Foreign keys are on because workerd enforces them and `node:sqlite` does
 * not; `resource_versions` cascades from `resources`, and a fixture that left
 * them off would show a delete leaving history behind that production reaps.
 */
export function workspaceObjectSqliteDatabase(workspaceId: string): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of WORKSPACE_DO_SCHEMA_MIGRATIONS) {
    for (const statement of migration.statements) database.exec(statement);
  }
  // Every fenced table checks its `workspace_id` against this singleton, so a
  // fixture without it can write no product row at all.
  database.prepare(
    `INSERT INTO workspace_identity
       (id, workspace_id, region, placement_affinity, created_at, updated_at)
     VALUES (1, ?, 'global', 'wnam', 0, 0)`,
  ).run(workspaceId);
  return database;
}

/**
 * The WorkspaceDO ledger versions that grew `resources` past what D1 left it.
 *
 * A migration that adds to `resource_versions`, its capture triggers, the
 * provenance staged on `resources`, or the alias beside its UUID belongs here,
 * or a fixture below applies the shape before it and passes over behaviour
 * production no longer has.
 */
const RESOURCE_SCHEMA_MIGRATIONS = new Set([13, 18, 19]);

/**
 * Give a database that already holds `resources` the shape WorkspaceDO grew on
 * it, from the ledger.
 *
 * A fixture built from the regional snapshot has the resource table as D1 left
 * it, which is the table WorkspaceDO imported and then added history and
 * aliases to. Capture is the whole subject of a publish or re-fetch test, so
 * its triggers come from the migrations that ship them rather than a copy.
 */
export function applyWorkspaceResourceSchema(database: DatabaseSync, workspaceId: string): void {
  const identity = WORKSPACE_DO_SCHEMA_MIGRATIONS
    .flatMap((migration) => migration.statements)
    .filter((statement) => /^\s*CREATE TABLE workspace_identity\b/u.test(statement));
  // The capture triggers sit beside the identity fences, which read this
  // singleton on every insert; without it no resource row can be written.
  for (const statement of identity) database.exec(statement);
  database.prepare(
    `INSERT INTO workspace_identity
       (id, workspace_id, region, placement_affinity, created_at, updated_at)
     VALUES (1, ?, 'global', 'wnam', 0, 0)`,
  ).run(workspaceId);
  for (const migration of WORKSPACE_DO_SCHEMA_MIGRATIONS) {
    if (!RESOURCE_SCHEMA_MIGRATIONS.has(migration.version)) continue;
    for (const statement of migration.statements) database.exec(statement);
  }
}
