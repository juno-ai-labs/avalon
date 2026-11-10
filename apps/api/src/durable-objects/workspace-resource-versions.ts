import { ResourceVersionCauseSchema, type ResourceHead, type ResourceVersionCause } from "@rally/contracts";

import { truncateUtf16Safe } from "@rally/contracts/text";

import { listedResourceVisibilitySql } from "../services/resource-listing";
import { isArtifactNewsCause } from "./workspace-pin-storage";

/**
 * Migration 114: one ledger of new resource versions, filled by a trigger on
 * `resource_versions` and drained after the write that filled it, the way the
 * Channel rail's ledger is (`channel-rails.ts`). Versions are only ever
 * written by `resources` triggers, from every producer (a Terminal republish,
 * an image edit, a connector refetch, a rename), so this is the one place each
 * of them passes.
 *
 * It records every resource and every cause, and each reader of the drain
 * takes what it needs: an open preview is stale whatever the cause, and a pin
 * counts only some causes as news (`isArtifactNewsCause`).
 *
 * Migration 111's pinned-artifact ledger is this table renamed: it already
 * had this shape, and a rename keeps any row queued but not yet drained. Its
 * trigger, which recorded only pinned artifacts' published or replaced
 * versions, gives way to one that records them all.
 *
 * Version 1 is left out: a resource that has just been created has no preview
 * open on it and no pinner, and its conversation's own socket announces it.
 * The table's `CHECK (version > 1)`, from migration 111, refuses it as well,
 * and `INSERT OR IGNORE` makes that refusal a skip rather than a failed write.
 *
 * The trigger reads only `resource_id` and `version`, so a later migration
 * that replaces another `resource_versions` column need not drop it.
 */
export const WORKSPACE_RESOURCE_VERSION_CHANGES_MIGRATION: readonly string[] = [
  `DROP TRIGGER resource_versions_queue_artifact_update`,
  `ALTER TABLE workspace_artifact_updates RENAME TO workspace_resource_version_changes`,
  `CREATE TRIGGER resource_versions_queue_version_change
     AFTER INSERT ON resource_versions
     WHEN NEW.version > 1
   BEGIN
     INSERT OR IGNORE INTO workspace_resource_version_changes (resource_id, version)
       VALUES (NEW.resource_id, NEW.version);
   END`,
];

/** Whether migration 114 has run in this object. */
export function resourceVersionLedgerReady(sql: SqlStorage): boolean {
  return sql.exec(
    `SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'workspace_resource_version_changes'`,
  ).toArray().length === 1;
}

/** One new version the ledger held, with why it was written. */
export interface ResourceVersionChange {
  resourceId: string;
  version: number;
  /** Null for a version whose producer names none. */
  cause: ResourceVersionCause | null;
}

/** Empty the ledger, answering what it held, oldest version first. */
export function drainResourceVersionChanges(sql: SqlStorage): ResourceVersionChange[] {
  const drained = sql.exec<{ resource_id: string; version: number }>(
    `DELETE FROM workspace_resource_version_changes RETURNING resource_id, version`,
  ).toArray();
  if (drained.length === 0) return [];
  const causes = new Map(sql.exec<{ resource_id: string; version: number; cause: string | null }>(
    `SELECT version.resource_id, version.version, version.cause
       FROM resource_versions version
       JOIN json_each(?) drained
         ON version.resource_id = json_extract(drained.value, '$[0]')
        AND version.version = json_extract(drained.value, '$[1]')`,
    JSON.stringify(drained.map((row) => [row.resource_id, Number(row.version)])),
  ).toArray().map((row) => [`${row.resource_id}:${Number(row.version)}`, row.cause]));
  return drained
    .map((row) => {
      const cause = ResourceVersionCauseSchema.safeParse(causes.get(`${row.resource_id}:${Number(row.version)}`));
      return { resourceId: row.resource_id, version: Number(row.version), cause: cause.success ? cause.data : null };
    })
    .sort((a, b) => a.resourceId.localeCompare(b.resourceId) || a.version - b.version);
}

/** Advance active Canvases that list a published or replaced artifact to its version date. */
export function advanceCanvasArtifactRecency(sql: SqlStorage, changes: readonly ResourceVersionChange[]): boolean {
  const published = changes.filter((change) => isArtifactNewsCause(change.cause));
  if (published.length === 0) return false;
  return sql.exec(
    `UPDATE canvas_directory AS canvas SET updated_at = activity.at
       FROM (
         SELECT artifact.canvas_id, MAX(CAST(ROUND(unixepoch(version.captured_at, 'subsec') * 1000) AS INTEGER)) AS at
           FROM json_each(?) changed
           JOIN resource_versions version ON version.resource_id = json_extract(changed.value, '$[0]')
             AND version.version = json_extract(changed.value, '$[1]')
           JOIN canvas_artifacts artifact ON artifact.resource_id = version.resource_id
           JOIN resources resource ON resource.id = version.resource_id
          WHERE ${listedResourceVisibilitySql("resource")}
          GROUP BY artifact.canvas_id
       ) activity
      WHERE canvas.canvas_id = activity.canvas_id AND canvas.archived_at IS NULL AND canvas.updated_at < activity.at
      RETURNING canvas_id`,
    JSON.stringify(published.map((change) => [change.resourceId, change.version])),
  ).toArray().length > 0;
}

/**
 * Each resource's head as it stands now. A resource deleted since its version
 * was written has no head and is left out: there is nothing left to show. So
 * is an unlisted one, as every advertising surface leaves it out
 * (`docs/agent-attachments.md`): no conversation lists it, so no preview of it
 * is open.
 */
export function readResourceHeads(sql: SqlStorage, resourceIds: readonly string[]): ResourceHead[] {
  if (resourceIds.length === 0) return [];
  return sql.exec<{
    id: string; current_version: number; title: string; mime_type: string | null;
    updated_at: string; content_ref: string | null; metadata_json: string | null;
  }>(
    `SELECT resource.id, resource.current_version, resource.title, resource.mime_type,
            resource.updated_at, resource.content_ref, resource.metadata_json
       FROM resources resource
      WHERE resource.id IN (SELECT value FROM json_each(?))
        AND ${listedResourceVisibilitySql("resource")}`,
    JSON.stringify([...new Set(resourceIds)]),
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
