/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A Sidekick's declared memory tables are materialized at apply under a
 * receipt whose id is deterministic in the Sidekick, its revision, and the
 * table's position, and the publication alarm re-applies the same revision
 * until every effect has landed. The receipt's payload hash therefore has to
 * survive anything the platform renames: the scope kind and the rationale
 * moved from `automation` to `sidekick` once, and a hash that carried them
 * turned every same-revision re-apply into `memory_table_mutation_receipt_mismatch`
 * and the alarm into a permanent stall.
 *
 * On real workerd because the receipt decision is the object's, made inside
 * its own transaction, and a Node double's answer would be this test's own.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { asWorkspaceId, type AutomationMemoryTable } from "@rally/contracts";

import { sha256 } from "../src/lib/crypto";
import { workspaceDOName } from "../src/durable-objects/names";
import { WorkspaceMemoryScopeSchema, WorkspaceMemoryTableCreateResultSchema } from "../src/durable-objects/workspace-memory-protocol";
import { materializeAutomationMemoryTables } from "../src/services/memory-table-service";
import { createTestEnv } from "../test/helpers/cloudflare-test";

/** Its own workspace: a shared id makes this file queue behind its siblings. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000d10");
const AUTOMATION_ID = "00000000-0000-7000-8000-000000000d11";
const USER_ID = "00000000-0000-7000-8000-000000000d12";
const SCOPE_ID = "00000000-0000-7000-8000-000000000d13";
const REVISION = 3;
const AT = "2026-09-01T00:00:00.000Z";

const DECLARED: AutomationMemoryTable = {
  name: "Seen entries",
  description: "One row per discovered blog entry.",
  usageInstructions: "Query candidate URLs, insert by canonical URL, and report only newly inserted rows.",
  columns: [{ name: "url", description: "Canonical entry URL", type: "url", required: true, searchable: false }],
  keyColumns: ["url"],
};

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
}

/** The serialization the receipt hash has always used: keys sorted, all the way down. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The hash the apply wrote before the rename: the whole declaration, scope
 * kind and rationale included, under the names of the day. Spelled out here
 * rather than borrowed from the service, so this file is its own witness to
 * what a stored receipt carries.
 */
async function preRenameInputHash(): Promise<string> {
  return sha256(stableJson({
    operation: "create",
    args: {
      scopeKind: "automation",
      name: DECLARED.name,
      description: DECLARED.description,
      usageInstructions: DECLARED.usageInstructions,
      columns: DECLARED.columns,
      keyColumns: DECLARED.keyColumns,
      rationale: "Declared by the automation's definition",
    },
  }));
}

/** The bindings the apply path reaches the object through, and no others. */
function serviceEnv() {
  return createTestEnv({
    WORKSPACE_DOS: env.WORKSPACE_DOS,
    AVALON_REGION: env.AVALON_REGION,
    APP_ENV: env.APP_ENV,
    LOG_LEVEL: env.LOG_LEVEL,
  });
}

async function materialize(tables: readonly AutomationMemoryTable[] = [DECLARED], definitionRevision = REVISION) {
  return materializeAutomationMemoryTables(serviceEnv(), {
    workspaceId: WORKSPACE_ID,
    automationId: AUTOMATION_ID,
    definitionRevision,
    runAsUserId: USER_ID,
    tables,
  });
}

async function counts() {
  return runInDurableObject(workspace(), (_instance, state) => {
    const count = (table: string): number => Number(state.storage.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table}`,
    ).toArray()[0]?.n ?? 0);
    return { tables: count("memory_tables"), mutations: count("memory_table_mutations") };
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
});

describe("materializing a Sidekick's declared tables across the rename", () => {
  it("given a receipt the apply wrote before the rename, when the same revision is applied again, then it converges instead of stalling", async () => {
    // The scope as migration 50 leaves it, and the table and receipt the
    // pre-rename apply wrote into it: the deterministic receipt id, and the
    // hash of the whole declaration under the old names.
    const scope = WorkspaceMemoryScopeSchema.parse(await workspace().ensureMemoryScope({
      workspaceId: WORKSPACE_ID,
      proposedScopeId: SCOPE_ID,
      kind: "sidekick",
      ownerId: AUTOMATION_ID,
      at: AT,
    }));
    const harnessRunId = `automation-apply:${AUTOMATION_ID}:${REVISION}`;
    const seeded = WorkspaceMemoryTableCreateResultSchema.parse(await workspace().createMemoryTable({
      workspaceId: WORKSPACE_ID,
      memoryTableId: "table-seen-entries",
      memoryScopeId: scope.memoryScopeId,
      name: DECLARED.name,
      description: DECLARED.description,
      usageInstructions: DECLARED.usageInstructions,
      keyColumnIdsJson: JSON.stringify(["table-seen-entries:column:0"]),
      provenanceJson: JSON.stringify({ source: "automation_definition", automationId: AUTOMATION_ID, definitionRevision: REVISION }),
      columns: [{
        memoryTableColumnId: "table-seen-entries:column:0",
        name: "url",
        description: "Canonical entry URL",
        valueType: "url",
        isRequired: true,
        isSearchable: false,
        position: 0,
      }],
      mutation: {
        memoryTableMutationId: "mutation-pre-rename",
        receiptId: `${harnessRunId}:0`,
        operation: "create",
        actorPrincipalJson: JSON.stringify({ type: "user", userId: USER_ID }),
        harnessRunId,
        workstreamId: AUTOMATION_ID,
        rationale: "Declared by the automation's definition",
        inputHash: await preRenameInputHash(),
        mutationJson: "{}",
        resultJson: JSON.stringify({ memoryTableId: "table-seen-entries", name: DECLARED.name }),
      },
      at: AT,
    }));
    expect(seeded).toEqual({ outcome: "created" });

    // The publication alarm's re-apply: the same Sidekick, the same revision,
    // the same declaration, now hashed under the new names.
    await expect(materialize()).resolves.toEqual([
      { name: DECLARED.name, memoryTableId: "table-seen-entries", outcome: "opened" },
    ]);
    expect(await counts()).toEqual({ tables: 1, mutations: 1 });
  });

  it("given a table this apply materialized, when the same revision is applied again, then the receipt replays under the new hash", async () => {
    const first = await materialize();
    expect(first).toEqual([{ name: DECLARED.name, memoryTableId: expect.any(String), outcome: "created" }]);

    await expect(materialize()).resolves.toEqual([
      { name: DECLARED.name, memoryTableId: first[0]!.memoryTableId, outcome: "opened" },
    ]);
    expect(await counts()).toEqual({ tables: 1, mutations: 1 });
  });

  it("reconciles descriptions and instructions without changing durable row or column identities", async () => {
    const [created] = await materialize();
    const memoryTableId = created!.memoryTableId;
    await runInDurableObject(workspace(), (_instance, state) => {
      const table = state.storage.sql.exec<{ memory_scope_id: string; last_mutation_id: string }>(
        `SELECT memory_scope_id, last_mutation_id FROM memory_tables WHERE memory_table_id = ?`, memoryTableId,
      ).one();
      state.storage.sql.exec(`INSERT INTO memory_table_rows
        (memory_table_row_id, memory_table_id, memory_scope_id, workspace_id, natural_key_hash, data_json,
         revision, provenance_json, created_by_mutation_id, last_mutation_id, created_at, updated_at)
        VALUES ('kept-row', ?, ?, ?, 'key-hash', '{"url":"https://example.com/kept"}', 7, '{}', ?, ?, ?, ?)`,
        memoryTableId, table.memory_scope_id, WORKSPACE_ID, table.last_mutation_id, table.last_mutation_id, AT, AT);
      state.storage.sql.exec(`INSERT INTO memory_table_cells
        (memory_table_row_id, memory_table_id, memory_table_column_id, value_type, string_value)
        VALUES ('kept-row', ?, ?, 'url', 'https://example.com/kept')`, memoryTableId, `${memoryTableId}:column:0`);
    });
    expect(await materialize([{ ...DECLARED, description: "Updated description", usageInstructions: "Updated instructions",
      columns: [{ ...DECLARED.columns[0]!, description: "Updated URL description" }],
    }], REVISION + 1)).toEqual([{ name: "Seen entries", memoryTableId, outcome: "opened" }]);
    const actual = await workspace().memoryTableWithColumns({ workspaceId: WORKSPACE_ID, memoryTableId });
    expect(actual).toMatchObject({ outcome: "found", table: {
      description: "Updated description", usageInstructions: "Updated instructions", schemaRevision: 1, dataRevision: 0,
    }, columns: [{ memoryTableColumnId: `${memoryTableId}:column:0`, description: "Updated URL description" }] });
    const retained = await runInDurableObject(workspace(), (_instance, state) => ({
      rows: state.storage.sql.exec(`SELECT memory_table_row_id, data_json, revision FROM memory_table_rows`).toArray(),
      cells: state.storage.sql.exec(`SELECT memory_table_row_id, memory_table_column_id, string_value FROM memory_table_cells`).toArray(),
    }));
    expect(retained).toEqual({
      rows: [{ memory_table_row_id: "kept-row", data_json: '{"url":"https://example.com/kept"}', revision: 7 }],
      cells: [{ memory_table_row_id: "kept-row", memory_table_column_id: `${memoryTableId}:column:0`, string_value: "https://example.com/kept" }],
    });
    expect(await counts()).toEqual({ tables: 1, mutations: 2 });
  });

  it("names the offending field when a declaration is refused across the RPC boundary", async () => {
    // The publication alarm reaches this method one write after the
    // registration write `parseRpcInput` was introduced for. A `ZodError`
    // thrown here was reduced by the RPC serializer to a bare `Error` — no
    // issues, no message — so the alarm's failure row carried `code: ""`, its
    // operator notice `handler_error:Error`, and the Sidekick's
    // `applied_effects_revision` trailed with no reason on record.
    const scope = WorkspaceMemoryScopeSchema.parse(await workspace().ensureMemoryScope({
      workspaceId: WORKSPACE_ID,
      proposedScopeId: SCOPE_ID,
      kind: "sidekick",
      ownerId: AUTOMATION_ID,
      at: AT,
    }));
    const harnessRunId = `automation-apply:${AUTOMATION_ID}:${REVISION}`;
    const rejection = await workspace().createMemoryTable({
      workspaceId: WORKSPACE_ID,
      memoryTableId: "table-seen-entries",
      memoryScopeId: scope.memoryScopeId,
      name: DECLARED.name,
      description: DECLARED.description,
      usageInstructions: DECLARED.usageInstructions,
      keyColumnIdsJson: JSON.stringify(["table-seen-entries:column:0"]),
      provenanceJson: JSON.stringify({ source: "automation_definition", automationId: AUTOMATION_ID, definitionRevision: REVISION }),
      // The declaration's shape drifted: a column list where the object
      // expects column rows.
      columns: "url",
      mutation: {
        memoryTableMutationId: "mutation-drifted",
        receiptId: `${harnessRunId}:0`,
        operation: "create",
        actorPrincipalJson: JSON.stringify({ type: "user", userId: USER_ID }),
        harnessRunId,
        workstreamId: AUTOMATION_ID,
        rationale: "Declared by the Sidekick's definition",
        inputHash: await preRenameInputHash(),
        mutationJson: "{}",
        resultJson: JSON.stringify({ memoryTableId: "table-seen-entries", name: DECLARED.name }),
      },
      at: AT,
    } as never).then(() => null, (error: unknown) => error);

    expect(rejection).toBeInstanceOf(Error);
    const message = (rejection as Error).message;
    expect(message).toContain("create_memory_table_invalid");
    expect(message).toContain("columns");
    expect(await counts()).toEqual({ tables: 0, mutations: 0 });
  });
});
