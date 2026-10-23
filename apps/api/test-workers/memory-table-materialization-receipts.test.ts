/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A Sidekick's declared memory tables are materialized at apply under a
 * receipt whose id is deterministic in the Sidekick, its revision, and the
 * table's position, and legacy publication alarms replay the accepted revision.
 * These tests enter publication and legacy recovery through WorkspaceDO RPC/alarms.
 * The receipt's payload hash therefore has to
 * survive anything the platform renames: the scope kind and the rationale
 * moved from `automation` to `sidekick` once, and a hash that carried them
 * turned every same-revision re-apply into `memory_table_mutation_receipt_mismatch`
 * and the alarm into a permanent stall.
 *
 * On real workerd because the receipt decision is the object's, made inside
 * its own transaction, and a Node double's answer would be this test's own.
 */

import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { asWorkspaceId, asUserId, AutomationDetailSchema, AutomationDraftSchema, type AutomationMemoryTable } from "@rally/contracts";

import { sha256 } from "../src/lib/crypto";
import { workspaceDOName } from "../src/durable-objects/names";
import { WorkspaceMemoryScopeSchema, WorkspaceMemoryTableCreateResultSchema } from "../src/durable-objects/workspace-memory-protocol";
import { SIDEKICK_MEMORY_TABLES_ALARM_KIND } from "../src/durable-objects/hosted-sidekick";

/** Its own workspace: a shared id makes this file queue behind its siblings. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000d10");
const AUTOMATION_ID = "00000000-0000-7000-8000-000000000d11";
const USER_ID = asUserId("00000000-0000-7000-8000-000000000d12");
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

function draft(tables: readonly AutomationMemoryTable[]) {
  return AutomationDraftSchema.parse({
    definitionVersion: 2, name: "Receipt helper", description: "Tracks entries", overview: "Track sources",
    instructions: "Keep durable source records.", triggers: [{ type: "manual" }],
    requiredCapabilities: [], expectedOutputs: [], defaultBehavior: {}, recommendedPlugins: [],
    memoryTables: tables, suggestedScope: "personal", followUpQuestion: null, elicitation: null, ready: true,
  });
}

async function submit(tables: readonly AutomationMemoryTable[] = [DECLARED]) {
  return workspace().sidekickSubmitDefinition({ workspaceId: WORKSPACE_ID, automationId: AUTOMATION_ID,
    draft: draft(tables), evaluatorRules: null, submittedByRunId: null,
  });
}

async function apply() {
  return AutomationDetailSchema.parse(await workspace().sidekickApply({
    workspaceId: WORKSPACE_ID, automationId: AUTOMATION_ID,
    actor: { userId: USER_ID, actorRole: "member", participantOfOwningWorkstream: false },
  }));
}

async function tableIds() {
  return runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ memory_table_id: string }>(
    `SELECT memory_table_id FROM memory_tables ORDER BY name`,
  ).toArray().map((table) => table.memory_table_id));
}

/** Exercise the legacy alarm's real dispatch into HostedSidekick.commitMemoryTables. */
async function retryMaterialization() {
  await runInDurableObject(workspace(), async (_instance, state) => {
    state.storage.sql.exec(`INSERT INTO _internal_durable_alarms
      (kind, alarm_key, due_at, retry_at, attempt, created_at, updated_at) VALUES (?, ?, 0, 0, 0, 0, 0)`,
      SIDEKICK_MEMORY_TABLES_ALARM_KIND, `${AUTOMATION_ID}:${REVISION}`);
    await state.storage.setAlarm(Date.now());
  });
  await runDurableObjectAlarm(workspace());
  await expect.poll(() => runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ n: number }>(
    `SELECT COUNT(*) AS n FROM _internal_durable_alarms WHERE kind = ?`, SIDEKICK_MEMORY_TABLES_ALARM_KIND,
  ).one().n), { timeout: 10_000 }).toBe(0);
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
      "memory_scopes", "sidekick_revisions", "sidekick_schedules", "sidekick_children", "automation_directory",
    ]) {
      state.storage.sql.exec(`DELETE FROM ${table}`);
    }
    state.storage.sql.exec(`DELETE FROM _internal_durable_alarms WHERE kind = ?`, SIDEKICK_MEMORY_TABLES_ALARM_KIND);
  });
  await workspace().ensureMemoryScope({ workspaceId: WORKSPACE_ID, proposedScopeId: SCOPE_ID,
    kind: "sidekick", ownerId: AUTOMATION_ID, at: AT,
  });
  await workspace().sidekickCreate({ workspaceId: WORKSPACE_ID, automationId: AUTOMATION_ID,
    authorUserId: USER_ID, scope: "personal", owningWorkstreamId: null, owningSubstreamId: "0", authorityGeneration: 1,
  });
  for (let revision = 1; revision <= REVISION; revision += 1) await submit();
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
    await expect(apply()).resolves.toMatchObject({ acceptedDefinitionRevision: 3 });
    await retryMaterialization();
    expect(await tableIds()).toEqual(["table-seen-entries"]);
    expect(await counts()).toEqual({ tables: 1, mutations: 1 });
  });

  it("given a table this apply materialized, when the same revision is applied again, then the receipt replays under the new hash", async () => {
    expect((await apply()).acceptedDefinitionRevision).toBe(3);
    const first = await tableIds();
    expect(first).toHaveLength(1);
    await retryMaterialization();
    expect(await tableIds()).toEqual(first);
    expect(await counts()).toEqual({ tables: 1, mutations: 1 });
  });

  it("reconciles descriptions and instructions without changing durable row or column identities", async () => {
    await apply();
    const memoryTableId = (await tableIds())[0]!;
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
    await submit([{ ...DECLARED, description: "Updated description", usageInstructions: "Updated instructions",
      columns: [{ ...DECLARED.columns[0]!, description: "Updated URL description" }],
    }]);
    expect((await apply()).acceptedDefinitionRevision).toBe(4);
    expect(await tableIds()).toEqual([memoryTableId]);
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

  it("persists metadata for a Unicode case variant and records the same stored column identity", async () => {
    await submit([{ ...DECLARED,
      columns: [{ name: "État", description: "Original state", type: "string", required: true, searchable: true }],
      keyColumns: ["État"],
    }]);
    await apply();
    const memoryTableId = (await tableIds())[0]!;
    const before = await workspace().memoryTableWithColumns({ workspaceId: WORKSPACE_ID, memoryTableId });
    expect(before).toMatchObject({ outcome: "found", columns: [{ name: "État", description: "Original state" }] });
    await submit([{ ...DECLARED,
      columns: [{ name: "état", description: "Updated state", type: "string", required: true, searchable: true }],
      keyColumns: ["état"],
    }]);
    expect((await apply()).acceptedDefinitionRevision).toBe(5);
    const described = await workspace().memoryTableWithColumns({ workspaceId: WORKSPACE_ID, memoryTableId });
    expect(described).toMatchObject({ outcome: "found", columns: [{
      memoryTableColumnId: `${memoryTableId}:column:0`, name: "État", description: "Updated state",
    }] });
    const receipt = await workspace().memoryTableMutationReceipt({ workspaceId: WORKSPACE_ID,
      harnessRunId: `automation-apply:${AUTOMATION_ID}:5`, receiptId: `automation-apply:${AUTOMATION_ID}:5:0`,
    });
    expect(receipt.outcome).toBe("found");
    if (receipt.outcome !== "found") throw new Error("Expected metadata receipt");
    expect(JSON.parse(receipt.resultJson)).toMatchObject({ columns: [{
      memoryTableColumnId: `${memoryTableId}:column:0`, name: "État", description: "Updated state",
    }] });
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
