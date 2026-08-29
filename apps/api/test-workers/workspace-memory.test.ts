/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Scoped durable memory, against the object that owns it.
 *
 * The mutations here are the ones the facade ran as D1 batches: the receipt
 * read, the compare-and-set, and the audit and outbox inserts were separate
 * round trips racing each other, and the CAS was judged by a `changes`
 * counter that real workerd inflates with index maintenance. These tests run
 * on real workerd so a refusal proves the returned witness, not a Node
 * double's flattering `changes()`.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asWorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import {
  WorkspaceMemoryAddResultSchema,
  WorkspaceMemoryCandidateListSchema,
  WorkspaceMemoryOutboxClaimResultSchema,
  WorkspaceMemoryOutboxDueListSchema,
  WorkspaceMemoryTableCreateResultSchema,
  WorkspaceMemoryTableInsertRowsResultSchema,
  WorkspaceMemoryTableQueryResultSchema,
  WorkspaceMemoryWriteResultSchema,
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

function mutation(
  receiptId: string,
  overrides: { inputHash?: string | undefined; resultJson?: string | undefined } = {},
) {
  return {
    memoryMutationId: nextId(),
    receiptId,
    actorPrincipalJson: JSON.stringify({ type: "workspace", workspaceId: WORKSPACE_ID }),
    harnessRunId: RUN_ID,
    workstreamId: WORKSTREAM_ID,
    rationale: "test",
    inputHash: overrides.inputHash ?? "hash-1",
    mutationJson: "{}",
    resultJson: overrides.resultJson ?? JSON.stringify({ recorded: true }),
  };
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

async function addItem(input: {
  memoryItemId?: string;
  receiptId?: string;
  text?: string;
  inputHash?: string;
  resultJson?: string;
} = {}) {
  return WorkspaceMemoryAddResultSchema.parse(await workspace().addMemoryItem({
    workspaceId: WORKSPACE_ID,
    memoryItemId: input.memoryItemId ?? nextId(),
    memoryScopeId: SCOPE_ID,
    text: input.text ?? "The report palette is crimson",
    expiresAt: null,
    provenanceJson: JSON.stringify({ source: "test" }),
    mutation: mutation(input.receiptId ?? "receipt-add", {
      inputHash: input.inputHash,
      resultJson: input.resultJson,
    }),
    at: AT,
  }));
}

async function memoryCounts() {
  return runInDurableObject(workspace(), (_instance, state) => {
    const count = (table: string): number => Number(state.storage.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table}`,
    ).toArray()[0]?.n ?? 0);
    return {
      items: count("memory_items"),
      mutations: count("memory_mutations"),
      outbox: count("memory_index_outbox"),
    };
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
      "memory_index_outbox",
      "memory_mutations",
      "memory_items",
      "memory_scopes",
    ]) {
      state.storage.sql.exec(`DELETE FROM ${table}`);
    }
  });
  await ensureScope();
}, 30_000);

describe("workspace memory items", () => {
  it("adds the item, its audit record, and its outbox intent as one decision", async () => {
    const added = await addItem();
    expect(added).toEqual({ outcome: "added" });
    expect(await memoryCounts()).toEqual({ items: 1, mutations: 1, outbox: 1 });
    // The FTS shadow table is maintained by the object's own triggers, which
    // only real SQLite runs — a match here proves the virtual table took the
    // insert, not that a fixture said so.
    const found = WorkspaceMemoryCandidateListSchema.parse(
      await workspace().searchMemoryItemsFts({
        workspaceId: WORKSPACE_ID,
        match: '"crimson"',
        scopeIds: [SCOPE_ID],
        now: AT,
        limit: 20,
      }),
    );
    expect(found.candidates).toHaveLength(1);
  });

  it("answers a replayed receipt with the recorded result and writes nothing", async () => {
    await addItem({ resultJson: JSON.stringify({ first: true }) });
    const replay = await addItem({ resultJson: JSON.stringify({ second: true }) });
    expect(replay).toEqual({ outcome: "replayed", resultJson: JSON.stringify({ first: true }) });
    expect(await memoryCounts()).toEqual({ items: 1, mutations: 1, outbox: 1 });
  });

  it("names a receipt whose payload hash disagrees instead of writing under it", async () => {
    await addItem({ inputHash: "hash-1" });
    const mismatch = await addItem({ inputHash: "hash-2" });
    expect(mismatch).toEqual({ outcome: "receipt_mismatch" });
    expect(await memoryCounts()).toEqual({ items: 1, mutations: 1, outbox: 1 });
  });

  it("refuses a stale revision by witness and leaves no partial write behind", async () => {
    const memoryItemId = nextId();
    await addItem({ memoryItemId });
    const stale = WorkspaceMemoryWriteResultSchema.parse(await workspace().updateMemoryItem({
      workspaceId: WORKSPACE_ID,
      memoryItemId,
      memoryScopeId: SCOPE_ID,
      expectedRevision: 2,
      text: "The report palette is azure",
      expiresAt: null,
      mutation: mutation("receipt-update", { inputHash: "hash-update" }),
      at: AT,
    }));
    expect(stale).toEqual({ outcome: "revision_conflict" });
    // Nothing from the refused transaction may remain: not the text, not an
    // audit row, not an outbox intent.
    expect(await memoryCounts()).toEqual({ items: 1, mutations: 1, outbox: 1 });
    const current = WorkspaceMemoryWriteResultSchema.parse(await workspace().updateMemoryItem({
      workspaceId: WORKSPACE_ID,
      memoryItemId,
      memoryScopeId: SCOPE_ID,
      expectedRevision: 1,
      text: "The report palette is azure",
      expiresAt: null,
      mutation: mutation("receipt-update-2", { inputHash: "hash-update-2" }),
      at: AT,
    }));
    expect(current).toEqual({ outcome: "written" });
    expect(await memoryCounts()).toEqual({ items: 1, mutations: 2, outbox: 2 });
  });

  it("hands an outbox row to exactly one lease and settles it under that lease", async () => {
    await addItem();
    const due = WorkspaceMemoryOutboxDueListSchema.parse(await workspace().dueMemoryIndexOutbox({
      workspaceId: WORKSPACE_ID,
      now: "2026-08-29T01:00:00.000Z",
      limit: 50,
    }));
    expect(due.rows).toHaveLength(1);
    const outboxId = due.rows[0]!.outboxId;
    const winner = WorkspaceMemoryOutboxClaimResultSchema.parse(
      await workspace().claimMemoryIndexOutboxRow({
        workspaceId: WORKSPACE_ID,
        outboxId,
        leaseToken: "lease-a",
        leaseExpiresAt: "2026-08-29T02:00:00.000Z",
        now: "2026-08-29T01:00:00.000Z",
      }),
    );
    expect(winner).toEqual({ claimed: true });
    // The loser is told by the lease witness, on the runtime whose physical
    // write counters made `changes === 1` lie for exactly this shape of claim.
    const loser = WorkspaceMemoryOutboxClaimResultSchema.parse(
      await workspace().claimMemoryIndexOutboxRow({
        workspaceId: WORKSPACE_ID,
        outboxId,
        leaseToken: "lease-b",
        leaseExpiresAt: "2026-08-29T02:00:00.000Z",
        now: "2026-08-29T01:00:00.000Z",
      }),
    );
    expect(loser).toEqual({ claimed: false });
    await workspace().completeMemoryIndexOutboxRow({
      workspaceId: WORKSPACE_ID,
      outboxId,
      leaseToken: "lease-a",
      at: "2026-08-29T01:01:00.000Z",
    });
    const remaining = WorkspaceMemoryOutboxDueListSchema.parse(
      await workspace().dueMemoryIndexOutbox({
        workspaceId: WORKSPACE_ID,
        now: "2026-08-29T03:00:00.000Z",
        limit: 50,
      }),
    );
    expect(remaining.rows).toEqual([]);
  });

  it("refuses another workspace's id before touching memory", async () => {
    const outcome = await runInDurableObject(workspace(), async (instance) =>
      instance.addMemoryItem({
        workspaceId: "00000000-0000-7000-8000-000000000cee",
        memoryItemId: nextId(),
        memoryScopeId: SCOPE_ID,
        text: "Wrong room",
        expiresAt: null,
        provenanceJson: "{}",
        mutation: mutation("receipt-wrong-workspace"),
        at: AT,
      }).then(() => null, (error: unknown) => error));
    expect(String(outcome)).toContain("workspace_object_identity_mismatch");
  });
});

describe("the memory index alarm", () => {
  it("arms the workspace alarm for an embedding intent a write just left", async () => {
    // `memory_index_outbox` is an alarm source, so while these writes were
    // generic statements `executeRuntimeSql` re-derived the schedule for them.
    // A typed method gets nothing for free: without an explicit refresh a
    // memory written into a quiet workspace sits unprojected until an
    // unrelated mutation happens to reconcile.
    await runInDurableObject(workspace(), async (_instance, state) => {
      await state.storage.deleteAlarm();
      expect(await state.storage.getAlarm()).toBeNull();
    });
    await addItem({ receiptId: "receipt-alarm" });
    await runInDurableObject(workspace(), async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });
});

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
