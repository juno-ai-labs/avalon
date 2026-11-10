/**
 * The per-resource facts that decide who may read a resource, shared by the
 * canonical resource check (`WorkspaceDO.authorizationResourceFacts`) and the
 * search audience a resource's index rows carry (`search-audience.ts`). One
 * definition, so the two cannot drift.
 */
export interface ResourceReadRow {
  provider: string;
  resource_type: string;
  uploaded_by_user_id: string | null;
  attachment_status: string | null;
  connection_id: string | null;
}

/** An upload nobody has sent yet: only its uploader may read it. */
export function isDraftUpload(row: ResourceReadRow): boolean {
  return row.provider === 'avalon_upload' && row.attachment_status !== 'attached';
}

/**
 * Whether reading needs a readable conversation the resource is attached to.
 * An upload or a generated artifact needs one for everyone but its uploader;
 * a historical mail resource needs one for everyone. Every other provider is readable by
 * every member without one.
 */
export function requiresAttachment(row: ResourceReadRow, owned: boolean): boolean {
  return ((row.provider === 'avalon_upload' || row.provider === 'avalon_generated') && !owned)
    || (row.provider === 'resend' && row.resource_type === 'email');
}

/** Canvas ownership and archive are local facts, shared by direct reads and search. */
export function resourceCanvasState(sql: SqlStorage, resourceId: string, publicationParentId: string | null): {
  ownedByCanvas: boolean; archived: boolean;
} {
  const row = sql.exec<{ archived: number | null }>(
    `SELECT MAX(archived_at IS NOT NULL) AS archived FROM canvas_directory
      WHERE canvas_id IN (SELECT ? UNION SELECT canvas_id FROM canvas_artifacts WHERE resource_id = ? AND ? IS NULL)`,
    publicationParentId, resourceId, publicationParentId,
  ).one();
  return { ownedByCanvas: row.archived !== null, archived: row.archived === 1 };
}
