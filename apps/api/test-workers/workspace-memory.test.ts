/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Durable memory tables, against the object that owns them.
 *
 * The mutations here are the ones the facade ran as D1 batches: the receipt
 * read, the compare-and-set, and the audit inserts were separate round trips
 * racing each other, and the CAS was judged by a `changes` counter that real
 * workerd inflates with index maintenance. These tests run on real workerd so
 * a refusal proves the returned witness, not a Node double's flattering
 * `changes()`. The prose half of this store is `memory-facts.test.ts`.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asWorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import {
  WorkspaceMemoryTableCreateResultSchema,
  WorkspaceMemoryTableInsertRowsResultSchema,
  WorkspaceMemoryTableQueryResultSchema,
} from "../src/durable-objects/workspace-memory-protocol";

/** Its own workspace: a shared id makes this file queue behind its siblings. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000ce0");
const RUN_ID = "00000000-0000-7000-8000-000000000ce1";
const WORKSTREAM_ID = "00000000-0000-7000-8000-000000000ce2";
const SCOPE_ID = "00000000-0000-7000-8000-000000000ce3";
const AT = "2026-08-29T00:00:00.000Z";

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
}

let sequence = 0;
function nextId(): string {
  sequence += 1;
  return `00000000-0000-7000-8000-ce${String(sequence).padStart(10, "0")}`;
}

async function ensureScope() {
  await workspace().ensureMemoryScope({
    workspaceId: WORKSPACE_ID,
    proposedScopeId: SCOPE_ID,
    kind: "workspace",
    ownerId: WORKSPACE_ID,
    at: AT,
  });
}

beforeEach(async () => {
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
  await runInDurableObject(workspace(), (_instance, state) => {
    for (const table of [
      "memory_table_cells",
      "memory_table_rows",
      "memory_table_columns",
      "memory_table_mutations",
      "memory_tables",
      "memory_scopes",
    ]) {
      state.storage.sql.exec(`DELETE FROM ${table}`);
    }
  });
  await ensureScope();
}, 30_000);

describe("workspace memory tables", () => {
  const TABLE_ID = "mtt_test-table";

  async function createTable() {
    return WorkspaceMemoryTableCreateResultSchema.parse(await workspace().createMemoryTable({
      workspaceId: WORKSPACE_ID,
      memoryTableId: TABLE_ID,
      memoryScopeId: SCOPE_ID,
      name: "Seen entries",
      description: "One row per entry.",
      usageInstructions: "Insert by key.",
      keyColumnIdsJson: JSON.stringify([`${TABLE_ID}:column:0`]),
      provenanceJson: JSON.stringify({ source: "test" }),
      columns: [
        {
          memoryTableColumnId: `${TABLE_ID}:column:0`,
          name: "itemKey",
          description: "Stable key",
          valueType: "string",
          isRequired: true,
          isSearchable: true,
          position: 0,
        },
      ],
      mutation: {
        memoryTableMutationId: nextId(),
        receiptId: "receipt-create",
        operation: "create",
        actorPrincipalJson: "{}",
        harnessRunId: RUN_ID,
        workstreamId: WORKSTREAM_ID,
        rationale: "test",
        inputHash: "hash-create",
        mutationJson: "{}",
        resultJson: JSON.stringify({ memoryTableId: TABLE_ID }),
      },
      at: AT,
    }));
  }

  function insertRequest(receiptId: string, rows: Array<{ id: string; key: string }>) {
    return {
      workspaceId: WORKSPACE_ID,
      memoryTableId: TABLE_ID,
      rows: rows.map((row) => ({
        memoryTableRowId: row.id,
        naturalKeyHash: `key:${row.key}`,
        dataJson: JSON.stringify({ itemKey: row.key }),
        searchableText: `itemKey: ${row.key}`,
        cells: [{
          memoryTableColumnId: `${TABLE_ID}:column:0`,
          valueType: "string" as const,
          stringValue: row.key,
          numberValue: null,
          booleanValue: null,
          temporalValue: null,
        }],
      })),
      provenanceJson: "{}",
      duplicateInputCount: 0,
      mutation: {
        memoryTableMutationId: nextId(),
        receiptId,
        operation: "insert_rows" as const,
        actorPrincipalJson: "{}",
        harnessRunId: RUN_ID,
        workstreamId: WORKSTREAM_ID,
        rationale: "test",
        inputHash: `hash-${receiptId}`,
        mutationJson: "{}",
      },
      at: AT,
    };
  }

  it("reports only the rows this insert made new, from the insert's own witnesses", async () => {
    expect(await createTable()).toEqual({ outcome: "created" });
    const first = WorkspaceMemoryTableInsertRowsResultSchema.parse(
      await workspace().insertMemoryTableRows(insertRequest("receipt-i1", [
        { id: "mtr_a", key: "alpha" },
        { id: "mtr_b", key: "beta" },
      ])),
    );
    expect(first.outcome).toBe("inserted");
    const firstResult = JSON.parse((first as { resultJson: string }).resultJson) as {
      insertedCount: number;
      existingCount: number;
    };
    expect(firstResult).toMatchObject({ insertedCount: 2, existingCount: 0 });
    const second = WorkspaceMemoryTableInsertRowsResultSchema.parse(
      await workspace().insertMemoryTableRows(insertRequest("receipt-i2", [
        { id: "mtr_b", key: "beta" },
        { id: "mtr_c", key: "gamma" },
      ])),
    );
    expect(second.outcome).toBe("inserted");
    const secondResult = JSON.parse((second as { resultJson: string }).resultJson) as {
      insertedCount: number;
      existingCount: number;
      insertedRows: Array<{ memoryTableRowId: string }>;
    };
    expect(secondResult).toMatchObject({ insertedCount: 1, existingCount: 1 });
    expect(secondResult.insertedRows.map((row) => row.memoryTableRowId)).toEqual(["mtr_c"]);
    // The audit record and the answer are the same JSON, built inside the
    // transaction from the same witnesses.
    const audited = await runInDurableObject(workspace(), (_instance, state) =>
      state.storage.sql.exec<{ result_json: string }>(
        `SELECT result_json FROM memory_table_mutations WHERE receipt_id = 'receipt-i2'`,
      ).toArray()[0]?.result_json);
    expect(audited).toBe((second as { resultJson: string }).resultJson);
  });

  it("serves a page and the revision it was read under from one object event", async () => {
    await createTable();
    await workspace().insertMemoryTableRows(insertRequest("receipt-i1", [
      { id: "mtr_a", key: "alpha" },
      { id: "mtr_b", key: "beta" },
    ]));
    const byFts = WorkspaceMemoryTableQueryResultSchema.parse(
      await workspace().queryMemoryTableRows({
        workspaceId: WORKSPACE_ID,
        memoryTableId: TABLE_ID,
        exactRowIds: null,
        ftsMatch: '"alpha"',
        filter: null,
        orderBy: [],
        limit: 10,
        offset: 0,
      }),
    );
    expect(byFts.outcome).toBe("found");
    if (byFts.outcome !== "found") return;
    expect(byFts.dataRevision).toBe(1);
    expect(byFts.rows.map((row) => row.memoryTableRowId)).toEqual(["mtr_a"]);
    const byFilter = WorkspaceMemoryTableQueryResultSchema.parse(
      await workspace().queryMemoryTableRows({
        workspaceId: WORKSPACE_ID,
        memoryTableId: TABLE_ID,
        exactRowIds: null,
        ftsMatch: null,
        filter: {
          op: "compare",
          columnId: `${TABLE_ID}:column:0`,
          field: "string_value",
          comparison: "eq",
          value: "BETA",
        },
        orderBy: [{ columnId: `${TABLE_ID}:column:0`, field: "string_value", direction: "asc" }],
        limit: 10,
        offset: 0,
      }),
    );
    expect(byFilter.outcome).toBe("found");
    if (byFilter.outcome !== "found") return;
    expect(byFilter.rows.map((row) => row.memoryTableRowId)).toEqual(["mtr_b"]);
  });

  it("refuses a whole stale batch and writes none of it", async () => {
    await createTable();
    await workspace().insertMemoryTableRows(insertRequest("receipt-i1", [
      { id: "mtr_a", key: "alpha" },
      { id: "mtr_b", key: "beta" },
    ]));
    const outcome = await workspace().updateMemoryTableRows({
      workspaceId: WORKSPACE_ID,
      memoryTableId: TABLE_ID,
      rows: [
        {
          memoryTableRowId: "mtr_a",
          expectedRevision: 1,
          dataJson: JSON.stringify({ itemKey: "alpha" }),
          searchableText: "itemKey: alpha",
          cells: [],
        },
        {
          memoryTableRowId: "mtr_b",
          // Stale: the row is at revision 1, so the whole batch must refuse.
          expectedRevision: 2,
          dataJson: JSON.stringify({ itemKey: "beta" }),
          searchableText: "itemKey: beta",
          cells: [],
        },
      ],
      mutation: {
        memoryTableMutationId: nextId(),
        receiptId: "receipt-u1",
        operation: "update_rows",
        actorPrincipalJson: "{}",
        harnessRunId: RUN_ID,
        workstreamId: WORKSTREAM_ID,
        rationale: "test",
        inputHash: "hash-u1",
        mutationJson: "{}",
        resultJson: "{}",
      },
      at: AT,
    });
    expect(outcome).toEqual({ outcome: "row_revision_conflict" });
    const revisions = await runInDurableObject(workspace(), (_instance, state) =>
      state.storage.sql.exec<{ memory_table_row_id: string; revision: number }>(
        `SELECT memory_table_row_id, revision FROM memory_table_rows ORDER BY memory_table_row_id`,
      ).toArray().map((row) => [row.memory_table_row_id, Number(row.revision)]));
    // Neither row moved — including the one whose revision matched.
    expect(revisions).toEqual([["mtr_a", 1], ["mtr_b", 1]]);
  });
});
