import { describe, expect, it } from "vitest";

import { CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V55 } from "../src/durable-objects/workspace-do";
import { workspaceObjectSqliteDatabase } from "./helpers/workspace-object-tables";

/**
 * The rebuild inventory, checked against the schema instead of against a
 * comment.
 *
 * Replacing `connector_connections` means holding every table that references
 * it in a scratch copy and putting the rows back afterwards, and the list of
 * those tables is written out by hand beside the migration. A table added later
 * without being declared there does not fail anything: the next parent rebuild
 * simply drops its rows, which is how a workspace lost its webhook receipts
 * once already. Deriving the truth from `PRAGMA foreign_key_list` makes that a
 * failing test on the day the table is added rather than on the day somebody
 * rebuilds the parent.
 */
describe("the connector_connections rebuild inventory", () => {
  it("names every table whose foreign key points at connector_connections", () => {
    const database = workspaceObjectSqliteDatabase("00000000-0000-4000-8000-000000000001");
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    const dependents = tables
      .filter((table) => (database.prepare(`PRAGMA foreign_key_list(${table.name})`).all() as { table: string }[])
        .some((key) => key.table === "connector_connections"))
      .map((table) => table.name);
    database.close();

    expect([...dependents].sort()).toEqual([...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V55].sort());
  });
});
