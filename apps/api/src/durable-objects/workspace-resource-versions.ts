import type { ResourceHead } from "@rally/contracts";

import { truncateUtf16Safe } from "@rally/contracts/text";

/**
 * Migration 114: a ledger of resources that have a new version, filled by a
 * trigger on `resource_versions` and drained after the write that filled it,
 * the way the pinned-artifact ledger is (`workspace-pin-storage.ts`). Versions
 * are only ever written by `resources` triggers, from every producer (a
 * Terminal republish, an image edit, a connector refetch, a rename), so this is
 * the one place each of them passes.
 *
 * Unlike that ledger it records every resource and every cause: it exists so
 * an open preview can move to the new version, and every open preview is
 * stale when any version lands. One row per resource, holding the newest
 * version, because a preview only ever wants the head.
 *
 * Version 1 is left out: a resource that has just been created has no preview
 * open on it yet, and its conversation's own socket announces it.
 *
 * The trigger reads only `resource_id` and `version`, so a later migration
 * that replaces another `resource_versions` column need not drop it.
 */
export const WORKSPACE_RESOURCE_VERSION_CHANGES_MIGRATION: readonly string[] = [
  `CREATE TABLE workspace_resource_version_changes (
    resource_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL CHECK (version > 1)
  ) STRICT`,
  `CREATE TRIGGER resource_versions_queue_version_change
     AFTER INSERT ON resource_versions
     WHEN NEW.version > 1
   BEGIN
     INSERT INTO workspace_resource_version_changes (resource_id, version)
       SELECT NEW.resource_id, NEW.version WHERE 1
       ON CONFLICT(resource_id) DO UPDATE SET version = max(version, excluded.version);
   END`,
];

/** Whether migration 114 has run in this object. */
export function resourceVersionLedgerReady(sql: SqlStorage): boolean {
  return sql.exec(
    `SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'workspace_resource_version_changes'`,
  ).toArray().length === 1;
}

/**
 * Empty the ledger, answering each resource's head as it stands now. A
 * resource deleted since its version was written has no head and is dropped:
 * there is nothing left to show.
 */
export function drainResourceVersionChanges(sql: SqlStorage): ResourceHead[] {
  const drained = sql.exec<{ resource_id: string }>(
    `DELETE FROM workspace_resource_version_changes RETURNING resource_id`,
  ).toArray().map((row) => row.resource_id);
  if (drained.length === 0) return [];
  return sql.exec<{
    id: string; current_version: number; title: string; mime_type: string | null;
    updated_at: string; content_ref: string | null; metadata_json: string | null;
  }>(
    `SELECT id, current_version, title, mime_type, updated_at, content_ref, metadata_json
       FROM resources WHERE id IN (SELECT value FROM json_each(?))`,
    JSON.stringify(drained),
  ).toArray().map((row) => ({
    resourceId: row.id,
    version: Math.max(1, Number(row.current_version)),
    // Bounded to `ResourceSchema`'s limits, as `toResource` bounds them: the
    // columns carry none.
    title: truncateUtf16Safe(row.title, 300),
    mimeType: row.mime_type === null ? null : truncateUtf16Safe(row.mime_type, 160),
    updatedAt: new Date(row.updated_at).toISOString(),
    contentAvailable: row.content_ref !== null,
    sizeBytes: metadataSize(row.metadata_json),
  }));
}

function metadataSize(metadataJson: string | null): number {
  try {
    const size = Number((JSON.parse(metadataJson ?? "{}") as { size?: unknown }).size ?? 0);
    return Number.isFinite(size) ? Math.max(0, Math.trunc(size)) : 0;
  } catch {
    return 0;
  }
}
