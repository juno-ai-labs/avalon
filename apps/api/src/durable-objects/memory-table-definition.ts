import { modelEnum, modelName, modelValues } from "@rally/contracts/model-names";
import type { WorkspaceMemoryTableColumn, WorkspaceMemoryTableCreateRequest, WorkspaceMemoryTableRow } from "./workspace-memory-protocol";

/** Metadata and declaration order do not change a table's stored row schema. */
export function memoryTableSchemaConflicts(
  table: WorkspaceMemoryTableRow,
  columns: readonly WorkspaceMemoryTableColumn[],
  request: WorkspaceMemoryTableCreateRequest,
): string[] {
  const fields: string[] = [];
  const byName = new Map(columns.map((column) => [column.name.toLocaleLowerCase(), column]));
  const requestedKeys = (JSON.parse(request.keyColumnIdsJson) as string[])
    .map((id) => request.columns.find((column) => column.memoryTableColumnId === id)?.name.toLocaleLowerCase());
  const storedKeys = (JSON.parse(table.keyColumnIdsJson) as string[])
    .map((id) => columns.find((column) => column.memoryTableColumnId === id)?.name.toLocaleLowerCase());
  // Key order participates in existing natural-key hashes, unlike column order.
  if (JSON.stringify(storedKeys) !== JSON.stringify(requestedKeys)) fields.push("keyColumns");
  if (columns.length !== request.columns.length) fields.push("columns.length");
  request.columns.forEach((column, index) => {
    const stored = byName.get(column.name.toLocaleLowerCase());
    if (!stored) { fields.push(`columns.${index}.name`); return; }
    for (const [field, property] of [
      ["type", "valueType"], ["required", "isRequired"], ["searchable", "isSearchable"],
    ] as const) {
      if (stored[property] !== column[property]) fields.push(`columns.${index}.${field}`);
    }
  });
  return fields;
}

/**
 * The scope kind a model reads and writes. A Canvas's scope is stored as
 * `workstream`, the conversation's storage name, and the Organization's as
 * `workspace`; a model is told about neither word, so it reads and writes
 * `canvas` and `organization`. A stored name is still accepted on the way in,
 * for a Sidekick whose saved instructions spell it, and never offered.
 */
export const STORED_MEMORY_SCOPE_KINDS = ["workstream", "sidekick", "user", "workspace"] as const satisfies readonly WorkspaceMemoryTableRow["scopeKind"][];
export const MEMORY_SCOPE_MODEL_NAMES = { workstream: "canvas", workspace: "organization" } as const;
export const MODEL_MEMORY_SCOPE_KINDS = modelValues(STORED_MEMORY_SCOPE_KINDS, MEMORY_SCOPE_MODEL_NAMES);
export type ModelMemoryScopeKind = typeof MODEL_MEMORY_SCOPE_KINDS[number];
export function modelMemoryScopeKind(kind: WorkspaceMemoryTableRow["scopeKind"]): ModelMemoryScopeKind {
  return modelName(MEMORY_SCOPE_MODEL_NAMES, kind);
}
/** The `scopeKind` parameter: offered under the model names, parsed to the stored kind. */
export const ModelMemoryScopeKindSchema = modelEnum(STORED_MEMORY_SCOPE_KINDS, MEMORY_SCOPE_MODEL_NAMES);

/** One public projection for create, reopen, describe and persisted receipts. */
export function publicMemoryTable(table: WorkspaceMemoryTableRow, columns: readonly WorkspaceMemoryTableColumn[]) {
  const keyIds = JSON.parse(table.keyColumnIdsJson) as string[];
  return {
    memoryTableId: table.memoryTableId,
    memoryScopeId: table.memoryScopeId,
    scopeKind: modelMemoryScopeKind(table.scopeKind),
    name: table.name,
    description: table.description,
    usageInstructions: table.usageInstructions,
    schemaRevision: table.schemaRevision,
    dataRevision: table.dataRevision,
    keyColumns: keyIds.map((id) => columns.find((column) => column.memoryTableColumnId === id)!.name),
    columns: columns.map((column) => ({
      memoryTableColumnId: column.memoryTableColumnId,
      name: column.name,
      description: column.description,
      type: column.valueType,
      required: column.isRequired,
      searchable: column.isSearchable,
      key: keyIds.includes(column.memoryTableColumnId),
    })),
  };
}

export function memoryTableSchemaRecovery(memoryTableId: string): string {
  return `Call table_describe with memoryTableId ${JSON.stringify(memoryTableId)}; reuse its columns and ordered keyColumns. Metadata may change. For a different schema, use a new table name and explicitly copy/transform rows. Do not retry unchanged or delete existing data.`;
}
