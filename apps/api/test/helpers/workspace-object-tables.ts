import type { DatabaseSync } from "node:sqlite";

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
