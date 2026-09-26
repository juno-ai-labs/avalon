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
 * an inbound email needs one for everyone. Every other provider is readable by
 * every member without one.
 */
export function requiresAttachment(row: ResourceReadRow, owned: boolean): boolean {
  return ((row.provider === 'avalon_upload' || row.provider === 'avalon_generated') && !owned)
    || (row.provider === 'resend' && row.resource_type === 'email');
}
