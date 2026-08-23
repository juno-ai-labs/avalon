import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import type { WorkstreamRuntimeSqlResult } from "../src/durable-objects/workstream-runtime-sql";
import {
  __workstreamRuntimeDatabaseTesting,
  writeRegionalWorkstreamAnchorBatch,
  workstreamRuntimeDatabase,
} from "../src/services/workstream-runtime-database";
import { createTestD1Database, createTestEnv } from "./helpers/cloudflare-test";
import { openWorkstreamAuthorityForTest } from "./helpers/durable-authority";
import {
  migratedSqliteDatabase,
  preRetirementProductSqliteDatabase,
  sqliteD1,
} from "./helpers/sqlite-d1";

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000601";
const WORKSTREAM_ID = "00000000-0000-7000-8000-000000000602";

describe("work-stream runtime database routing", () => {
  it("routes elicitation persistence to the owning WorkstreamDO", () => {
    expect(__workstreamRuntimeDatabaseTesting.localStatement(
      "SELECT id FROM elicitations WHERE workstream_id = ?",
    )).toBe(true);
  });

  it("leaves a statement naming a table whose slice has landed for the parent router", () => {
    // `workstream_wakeups` left the routed set with the scheduling slice: it is
    // reached through `/internal/scheduling` now, and its compatibility view is
    // gone. A statement still naming it is a caller that missed the conversion,
    // and the honest answer is to stop claiming this router can serve it —
    // where it fails loudly against a regional database that has no such table
    // — rather than to route it at a view that no longer exists.
    expect(__workstreamRuntimeDatabaseTesting.localStatement(
      "SELECT id FROM workstream_wakeups WHERE workstream_id = ?",
    )).toBe(false);
  });

  it("routes a bare tool_effects write to the owning object, where the table lives", () => {
    // The dev seed writes the object's receipt table without naming any other
    // table. Classified regional, the statement reaches D1, which dropped its
    // product tables at migration 0090 — `no such table: tool_effects`.
    expect(__workstreamRuntimeDatabaseTesting.localStatement(
      "INSERT INTO tool_effects (effect_intent_id, run_id) VALUES (?, ?)",
    )).toBe(true);
  });

  it("classifies every table the dev seed writes as the object's", () => {
    // The seed route has no execution coverage, which is how a rename once
    // stranded one of these on regional D1. Each name it inserts into must
    // route local, or `pnpm db:open-authority` fails on a fresh state.
    for (const table of ["workstream_participants", "harness_runs", "tool_effects", "messages"]) {
      expect(__workstreamRuntimeDatabaseTesting.localStatement(
        `INSERT INTO ${table} (id) VALUES (?)`,
      ), table).toBe(true);
    }
  });

  it("leaves workspace-owned resource and identity reads for the underlying workspace router", () => {
    expect(__workstreamRuntimeDatabaseTesting.localStatement(
      "SELECT title FROM resources WHERE workspace_id = ?",
    )).toBe(false);
    expect(__workstreamRuntimeDatabaseTesting.localStatement(
      "SELECT name FROM users WHERE id = ?",
    )).toBe(false);
    expect(__workstreamRuntimeDatabaseTesting.localStatement(
      "SELECT 'messages are product data' AS description",
    )).toBe(false);
  });

  it("rejects a parent-authority mutation that only mentions a local table in a subquery", () => {
    expect(() => __workstreamRuntimeDatabaseTesting.localStatement(
      "UPDATE resources SET title = (SELECT text_content FROM messages LIMIT 1) WHERE id = ?",
    )).toThrow("workstream_runtime_cross_authority_statement");
  });

  it("rejects exec batches that span work-stream and parent authorities", async () => {
    const underlying = new DatabaseSync(":memory:");
    underlying.exec("CREATE TABLE resources (id TEXT PRIMARY KEY)");
    const local = async (
      statements: Array<{ sql: string; params: Array<string | number | null> }>,
    ): Promise<WorkstreamRuntimeSqlResult[]> => statements.map(() => ({
      columns: [], rows: [], changes: 0,
    }));
    const database = workstreamRuntimeDatabase(
      createTestEnv({ DB: sqliteD1(underlying), AVALON_REGION: "global" }),
      WORKSPACE_ID,
      WORKSTREAM_ID,
      "0",
      local,
    );
    try {
      await expect(database.exec(
        "SELECT id FROM messages; SELECT id FROM resources",
      )).rejects.toThrow("workstream_runtime_cross_authority_transaction");
    } finally {
      underlying.close();
    }
  });

  it("creates the same routing anchor before and after the destructive migration", async () => {
    const at = "2026-08-20T00:00:00.000Z";
    for (const [shape, database] of [
      ["through-0089", preRetirementProductSqliteDatabase()],
      ["final", migratedSqliteDatabase()],
    ] as const) {
      try {
        database.exec(`
          INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
          VALUES ('anchor-user', 'anchor-subject', 'anchor@example.com', 'Anchor', '${at}', '${at}');
          INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
          VALUES ('${WORKSPACE_ID}', 'Anchor', 'anchor', 'global', 'anchor-user', '${at}', '${at}');
        `);
        openWorkstreamAuthorityForTest(database, at);
        const env = createTestEnv({ DB: sqliteD1(database), AVALON_REGION: "global" });
        await writeRegionalWorkstreamAnchorBatch(
          env,
          { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, at },
          () => [],
        );

        expect(database.prepare(
          "SELECT id, workspace_id, do_identity_anchor FROM workstreams WHERE id = ?",
        ).get(WORKSTREAM_ID), shape).toEqual({
          id: WORKSTREAM_ID,
          workspace_id: WORKSPACE_ID,
          do_identity_anchor: 1,
        });
        if (shape === "through-0089") {
          expect(database.prepare(
            "SELECT title, objective FROM workstreams WHERE id = ?",
          ).get(WORKSTREAM_ID)).toEqual({
            title: `[WorkstreamDO] ${WORKSTREAM_ID}`,
            objective: "",
          });
        } else {
          expect((database.prepare("PRAGMA table_info(workstreams)").all() as Array<{ name: string }>)
            .map((column) => column.name)).toEqual([
            "id",
            "workspace_id",
            "do_identity_anchor",
          ]);
        }
      } finally {
        database.close();
      }
    }
  });

  it("retries the final anchor if 0090 commits between the shape probe and batch", async () => {
    const at = "2026-08-20T00:00:00.000Z";
    const database = preRetirementProductSqliteDatabase();
    try {
      database.exec(`
        INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
        VALUES ('anchor-user', 'anchor-subject', 'anchor@example.com', 'Anchor', '${at}', '${at}');
        INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
        VALUES ('${WORKSPACE_ID}', 'Anchor', 'anchor', 'global', 'anchor-user', '${at}', '${at}');
      `);
      openWorkstreamAuthorityForTest(database, at);
      const underlying = sqliteD1(database);
      let batchCalls = 0;
      const racingDatabase = createTestD1Database({
        prepare: underlying.prepare.bind(underlying),
        batch: async (statements: D1PreparedStatement[]) => {
          batchCalls += 1;
          if (batchCalls === 1) {
            database.exec(readFileSync(
              new URL(
                "../../../packages/db/migrations/0090_drop_legacy_product_tables.sql",
                import.meta.url,
              ),
              "utf8",
            ));
          }
          return underlying.batch(statements);
        },
      });
      const env = createTestEnv({ DB: racingDatabase, AVALON_REGION: "global" });

      await writeRegionalWorkstreamAnchorBatch(
        env,
        { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, at },
        () => [],
      );

      expect(batchCalls).toBe(2);
      expect(database.prepare(
        "SELECT id, workspace_id, do_identity_anchor FROM workstreams WHERE id = ?",
      ).get(WORKSTREAM_ID)).toEqual({
        id: WORKSTREAM_ID,
        workspace_id: WORKSPACE_ID,
        do_identity_anchor: 1,
      });
    } finally {
      database.close();
    }
  });
});
