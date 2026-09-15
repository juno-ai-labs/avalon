import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  __workspaceRuntimeDatabaseTesting,
  WORKSPACE_LOCAL_TABLES,
  workspaceRuntimeDatabase,
} from "../src/services/workspace-runtime-database";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
import type { WorkspaceRuntimeSqlResult } from "../src/durable-objects/workspace-runtime-sql";
import { createTestEnv } from "./helpers/cloudflare-test";
import { sqliteD1 } from "./helpers/sqlite-d1";

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000501";

describe("workspace runtime database routing", () => {
  it("reads the conflict clause as part of the verb, not as the table", () => {
    // The resource-alias allocator's statement. Reading `OR` as the table made
    // the router refuse it as cross-authority, so allocation threw at prepare
    // time on every path and the maintenance pass that owns the backfill was
    // due forever without ever naming a row.
    expect(__workspaceRuntimeDatabaseTesting.localStatement(
      `UPDATE OR IGNORE resources SET slug = ?
        WHERE id = ? AND workspace_id = ? AND slug IS NULL
        RETURNING slug`,
    )).toBe(true);
    // The same reading on the other verbs, and the refusal it must not lose:
    // a conflict clause is not a licence to write a table the object lacks.
    expect(__workspaceRuntimeDatabaseTesting.localStatement(
      "INSERT OR IGNORE INTO resources (id, workspace_id) VALUES (?, ?)",
    )).toBe(true);
    expect(() => __workspaceRuntimeDatabaseTesting.localStatement(
      `UPDATE OR REPLACE workspace_members SET role = ?
        WHERE user_id IN (SELECT uploaded_by_user_id FROM resources)`,
    )).toThrow("workspace_runtime_cross_authority_statement:workspace_members");
  });

  it("rejects a read that joins a local table to one only the region has", () => {
    // The statement `slackUserIsLinked` used to run. It named a local table, so
    // this router claimed it, and executed it inside an object with no
    // `workspace_members` — which surfaced in production as `no such table`
    // on every Slack run-outcome delivery, retried until the ingress budget
    // was spent, rather than as anything naming the boundary it crossed.
    expect(() => __workspaceRuntimeDatabaseTesting.localStatement(
      `SELECT 1 AS linked
         FROM slack_user_links l
         JOIN workspace_members wm
           ON wm.workspace_id = l.workspace_id AND wm.user_id = l.user_id
        WHERE l.connection_id = ? AND l.status = 'active' AND wm.status = 'active'`,
    )).toThrow("workspace_runtime_cross_authority_statement:workspace_members");

    // The halves each execute somewhere, and the router still says where.
    expect(__workspaceRuntimeDatabaseTesting.localStatement(
      "SELECT user_id FROM slack_user_links WHERE connection_id = ? AND status = 'active'",
    )).toBe(true);
    expect(__workspaceRuntimeDatabaseTesting.localStatement(
      "SELECT 1 AS linked FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
    )).toBe(false);
  });

  it("routes an automation's origin label to the object that holds the directory", () => {
    // The statement the work stream summary used to issue. It now calls
    // `automationOriginLabel` on WorkspaceDO instead, so nothing sends this
    // through the facade — but the routing entry stays, and this holds it
    // there. While `automation_directory` was missing from
    // `WORKSPACE_LOCAL_TABLES` the read took the regional fallthrough and
    // answered `no such table: automation_directory` from D1, a 500 on every
    // attempt to open an automation's run work stream.
    expect(__workspaceRuntimeDatabaseTesting.localStatement(
      `SELECT title AS name FROM automation_directory
        WHERE automation_id = ? AND workspace_id = ? AND lifecycle <> 'deleted'`,
    )).toBe(true);
  });

  it("keeps object tables that the local list does not name on the local side", () => {
    // WorkspaceDO holds more tables than `WORKSPACE_LOCAL_TABLES` enumerates,
    // so the guard above keys off a regional-only list rather than off
    // "anything unlisted". These would break if it did.
    expect(__workspaceRuntimeDatabaseTesting.localStatement(
      `SELECT directory.title FROM workspace_workstream_directory directory
         JOIN workspace_workstream_pins pin ON pin.workstream_id = directory.workstream_id`,
    )).toBe(true);
    // `workspaces` must not match inside `workspace_workstream_directory`, and
    // `sessions` must not match inside `slack_agent_sessions`.
    expect(__workspaceRuntimeDatabaseTesting.localStatement(
      "SELECT id FROM slack_agent_sessions WHERE workspace_id = ?",
    )).toBe(true);
  });

  it("rejects regional mutations that smuggle a WorkspaceDO table through a subquery", () => {
    expect(() => __workspaceRuntimeDatabaseTesting.localStatement(
      `INSERT INTO audit_events (id, workspace_id)
       SELECT 'audit', workspace_id FROM slack_agent_sessions WHERE id = 'session'`,
    )).toThrow("workspace_runtime_cross_authority_statement");
    expect(__workspaceRuntimeDatabaseTesting.localStatement(
      "INSERT INTO audit_events (id, workspace_id) VALUES ('audit', 'workspace')",
    )).toBe(false);
  });

  it("routes workspace product tables locally, leaves control rows in D1, and rejects mixed batches", async () => {
    const regional = new DatabaseSync(":memory:");
    regional.exec(`
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO workspaces (id, name) VALUES ('${WORKSPACE_ID}', 'Control plane');
    `);
    const calls: Array<Array<{ sql: string; params: Array<string | number | null> }>> = [];
    const local = async (
      statements: Array<{ sql: string; params: Array<string | number | null> }>,
    ): Promise<WorkspaceRuntimeSqlResult[]> => {
      calls.push(statements);
      return statements.map(() => ({
        columns: ["id", "title"],
        rows: [{ id: "resource-1", title: "Workspace authority" }],
        changes: 0,
      }));
    };
    const database = workspaceRuntimeDatabase(
      createTestEnv({ DB: sqliteD1(regional), AVALON_REGION: "global" }),
      WORKSPACE_ID,
      local,
    );
    try {
      await expect(database.prepare("SELECT id, title FROM resources WHERE workspace_id = ?")
        .bind(WORKSPACE_ID).first()).resolves.toEqual({
        id: "resource-1",
        title: "Workspace authority",
      });
      await expect(database.prepare("SELECT name FROM workspaces WHERE id = ?")
        .bind(WORKSPACE_ID).first("name")).resolves.toBe("Control plane");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual([{
        sql: "SELECT id, title FROM resources WHERE workspace_id = ?",
        params: [WORKSPACE_ID],
      }]);

      await expect(database.batch([
        database.prepare("SELECT id FROM resources WHERE workspace_id = ?").bind(WORKSPACE_ID),
        database.prepare("SELECT id FROM workspaces WHERE id = ?").bind(WORKSPACE_ID),
      ])).rejects.toThrow("workspace_runtime_cross_authority_transaction");
      await expect(database.exec(
        "SELECT id FROM resources; SELECT id FROM workspaces",
      )).rejects.toThrow("workspace_runtime_cross_authority_transaction");
      expect(calls).toHaveLength(1);
    } finally {
      regional.close();
    }
  });
});

/**
 * WorkspaceDO tables that deliberately do not route through the D1 facade.
 *
 * These are reached only by typed RPC from inside the object, so no statement
 * naming them is ever handed to `localStatement` and the router never has to
 * classify them. That is a decision per table, not a default: the test below
 * fails on any table a migration adds that appears in neither list, because
 * the router's fallthrough is "regional", and a workspace-owned table that
 * nobody routed is answered by D1 as `no such table` rather than as anything
 * naming the boundary it crossed.
 */
const DO_TABLES_NOT_ROUTED_THROUGH_THE_FACADE = [
  "agent_teams", // Agent communication uses typed WorkspaceDO RPC only.
  "agent_team_members",
  "agent_delegations",
  "agent_message_routes",
  "connector_installations", // Generation-fenced installation RPC only.
  "connector_installation_steps", // Exact provider-dispatch receipts; no facade access.
  "workspace_workstream_access", // Private WorkspaceDO visit state; no facade callers.
  "onboarding_journeys", // Owned by the typed onboardingJourney RPC only.
  "_internal_durable_alarms",
  // Retirement's two tables. Both are read and written only by the object
  // itself, through `ctx.storage.sql`, and the gate that reads the tombstone
  // runs before anything the facade could route — including during constructor
  // recovery, when there is no request to route on behalf of.
  "object_retirement",
  "workspace_retirement_graph",
  "opportunity_batch_events",
  "opportunity_batch_windows",
  "opportunity_provenance_edges",
  "opportunity_provenance_nodes",
  "project_default_resource_publications",
  "project_default_resource_targets",
  "project_default_resources",
  "project_participants",
  "project_workstream_memberships",
  "projects",
  "suggested_work_ranking_rounds",
  "suggested_work_sets",
  "work_opportunities",
  "work_opportunity_provenance_roots",
  "work_opportunity_snapshots",
  "work_opportunity_user_links",
  "work_opportunity_user_states",
  "workspace_activity_event_targets",
  "workspace_activity_events",
  "workspace_batch_dispatch_targets",
  "workspace_batch_dispatches",
  "workspace_directory_state",
  "workspace_external_event_registrations",
  "external_registration_generations", // Owned by typed registration RPC only.
  "retired_meeting_resources", // Operator-only cleanup manifest.
  "workspace_identity",
  "workspace_project_order",
  "workspace_project_state",
  "workspace_sidebar_list_state",
  "workspace_socket_ticket_receipts",
  "workspace_sync_events",
  "workspace_workstream_directory",
  "workspace_workstream_effect_receipts",
  "workspace_workstream_resource_links",
  "workspace_workstream_viewers",
] as const;

/** Every table WorkspaceDO's migrations leave standing, in application order. */
function workspaceObjectTables(): Set<string> {
  const live = new Set<string>();
  for (const migration of WORKSPACE_DO_SCHEMA_MIGRATIONS) {
    for (const statement of migration.statements) {
      for (const match of statement.matchAll(
        /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/giu,
      )) live.add(String(match[1]).toLowerCase());
      for (const match of statement.matchAll(
        /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`]?(\w+)/giu,
      )) live.delete(String(match[1]).toLowerCase());
      // A table rebuild is create-copy-drop-rename, so the name that survives
      // is the one the last statement renames *to*. Without this the scratch
      // name reads as a live undeclared table and the real one reads as gone —
      // the check would fail on every correct rebuild and pass on a wrong one.
      for (const match of statement.matchAll(
        /ALTER\s+TABLE\s+["`]?(\w+)["`]?\s+RENAME\s+TO\s+["`]?(\w+)/giu,
      )) {
        live.delete(String(match[1]).toLowerCase());
        live.add(String(match[2]).toLowerCase());
      }
    }
  }
  return live;
}

describe("workspace runtime database routing coverage", () => {
  it("makes every WorkspaceDO table a routing decision rather than a fallthrough", () => {
    const declared = new Set<string>([
      ...WORKSPACE_LOCAL_TABLES,
      ...DO_TABLES_NOT_ROUTED_THROUGH_THE_FACADE,
    ]);
    const undeclared = [...workspaceObjectTables()].filter((table) => !declared.has(table));
    // `automation_directory` failed exactly this way: WorkspaceDO migration 22
    // created it, nothing added it to `WORKSPACE_LOCAL_TABLES`, and the work
    // stream summary's read of an automation's title went to the regional
    // database — a 500 on every attempt to open an automation's run work
    // stream. A new table lands here until somebody says which side it is on.
    expect(undeclared).toEqual([]);
  });

  it("keeps the two lists disjoint, so a table has one answer and not two", () => {
    const local = new Set<string>(WORKSPACE_LOCAL_TABLES);
    expect(DO_TABLES_NOT_ROUTED_THROUGH_THE_FACADE.filter((table) => local.has(table)))
      .toEqual([]);
  });

  it("holds the unrouted list to tables the object still has", () => {
    // Otherwise it accumulates names that outlive their table and stops being
    // evidence that anybody looked at them.
    const live = workspaceObjectTables();
    expect(DO_TABLES_NOT_ROUTED_THROUGH_THE_FACADE.filter((table) => !live.has(table)))
      .toEqual([]);
  });
});
