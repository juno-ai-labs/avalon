import { z } from 'zod';
import { IdSchema, SubstreamIdSchema, WorkspaceIdSchema } from '@rally/contracts';
import { authorizationResourceKey,
  type AuthorizationResource, type AuthorizationSubject } from '../services/authorization-policy';

export const AuthorizationLocationSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema, parentId: IdSchema, substreamId: SubstreamIdSchema,
  // Deliberately narrower than `ConversationParentKindSchema`: a Space's
  // hidden conversation has no place in the authorization universe, and
  // `projectAuthorization` refuses one before it reaches here. This is the
  // second fence, and the one that names the field if the first is ever removed.
  parentKind: z.enum(['workstream', 'automation']),
  mutationAt: z.number().int().nonnegative().optional(),
  revision: z.number().int().nonnegative(), validatedAt: z.number().int().nonnegative(),
  resourceIds: z.array(IdSchema),
});
export type AuthorizationLocation = z.infer<typeof AuthorizationLocationSchema>;

/** Typed-table guard includes inert snapshots until a later migration drops them. */
export const AUTHORIZATION_STORAGE_TABLES = [
  'authorization_snapshots', 'authorization_locations', 'authorization_inventories',
  'authorization_backfill', 'authorization_backfill_children', 'authorization_delivery',
] as const;

export const AUTHORIZATION_STORAGE_MIGRATION = [
  `CREATE TABLE authorization_snapshots (cache_key TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL, validated_at INTEGER NOT NULL) STRICT`,
  `CREATE INDEX authorization_snapshots_expiry_idx ON authorization_snapshots(validated_at)`,
  `CREATE TABLE authorization_locations (parent_id TEXT NOT NULL, substream_id TEXT NOT NULL,
     parent_kind TEXT NOT NULL, resource_id TEXT NOT NULL, PRIMARY KEY(parent_id, substream_id, resource_id)) STRICT`,
  `CREATE INDEX authorization_locations_resource_idx ON authorization_locations(resource_id, parent_id, substream_id)`,
  `CREATE TABLE authorization_inventories (parent_id TEXT NOT NULL, substream_id TEXT NOT NULL,
     revision INTEGER NOT NULL, validated_at INTEGER NOT NULL, PRIMARY KEY(parent_id, substream_id)) STRICT`,
  `CREATE TABLE authorization_backfill (parent_id TEXT PRIMARY KEY, parent_kind TEXT NOT NULL,
     completed INTEGER NOT NULL DEFAULT 0) STRICT`,
  `CREATE TABLE authorization_backfill_children (parent_id TEXT NOT NULL, substream_id TEXT NOT NULL,
     completed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(parent_id, substream_id)) STRICT`,
  `CREATE TABLE authorization_delivery (job_key TEXT PRIMARY KEY, payload_json TEXT NOT NULL, not_before INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1) STRICT`,
];

export function authorizationSnapshotKey(subject: AuthorizationSubject, resource: AuthorizationResource): string {
  return JSON.stringify([subject.workspaceId, subject.userId, subject.delegation, authorizationResourceKey(resource)]);
}

/** SQLite owns inventory revision ordering; delayed delivery cannot resurrect removed links. */
/**
 * Link resources to a Channel: everyone who can read the Channel, now or
 * later, can read them. The caller holds the transaction. Each new row
 * reindexes the resource's search rows (migration 76's triggers). Answers the
 * ids it newly linked.
 */
export function linkSpaceResources(sql: SqlStorage, spaceId: string, resourceIds: readonly string[]): string[] {
  return resourceIds.filter((resourceId) => sql.exec(
    `INSERT INTO authorization_locations(parent_id, substream_id, parent_kind, resource_id) VALUES (?, '0', 'space', ?)
     ON CONFLICT(parent_id, substream_id, resource_id) DO NOTHING`,
    spaceId, resourceId).rowsWritten > 0);
}

export class AuthorizationStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  replaceLocations(input: AuthorizationLocation): void {
    this.storage.transactionSync(() => {
      const current = this.storage.sql.exec<{ revision: number; validated_at: number }>(
        'SELECT revision, validated_at FROM authorization_inventories WHERE parent_id = ? AND substream_id = ?',
        input.parentId, input.substreamId,
      ).toArray()[0];
      if (current && (current.revision > input.revision
        || current.revision === input.revision && current.validated_at >= input.validatedAt)) return;
      // Write only what changed: each inserted or deleted row rewrites that
      // resource's search rows (migration 76), so an unchanged inventory must
      // not touch the rows it already holds.
      const next = new Set(input.resourceIds);
      const held = new Set(this.storage.sql.exec<{ resource_id: string }>(
        'SELECT resource_id FROM authorization_locations WHERE parent_id = ? AND substream_id = ?', input.parentId, input.substreamId,
      ).toArray().map((row) => row.resource_id));
      for (const resourceId of held) if (!next.has(resourceId)) this.storage.sql.exec(
        'DELETE FROM authorization_locations WHERE parent_id = ? AND substream_id = ? AND resource_id = ?',
        input.parentId, input.substreamId, resourceId);
      for (const resourceId of next) if (!held.has(resourceId)) this.storage.sql.exec(
        'INSERT INTO authorization_locations(parent_id, substream_id, parent_kind, resource_id) VALUES (?, ?, ?, ?)',
        input.parentId, input.substreamId, input.parentKind, resourceId);
      this.storage.sql.exec('UPDATE authorization_locations SET parent_kind = ? WHERE parent_id = ? AND substream_id = ? AND parent_kind <> ?',
        input.parentKind, input.parentId, input.substreamId, input.parentKind);
      this.storage.sql.exec(`INSERT INTO authorization_inventories(parent_id, substream_id, revision, validated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(parent_id, substream_id) DO UPDATE SET revision = excluded.revision, validated_at = excluded.validated_at`,
      input.parentId, input.substreamId, input.revision, input.validatedAt);
    });
  }

  locations(resourceId: string) {
    return authorizationLocations(this.storage.sql, resourceId);
  }
}

/**
 * Every place a resource is linked: the conversations the canonical
 * inventories place it in, and the Channels (`parent_kind = 'space'`) a merge
 * shared it with. A conversation's row is discovery, proved against that
 * conversation's own inventory; a Channel's row is written by WorkspaceDO,
 * which owns the Channel, in the same commit as the merge, so it is the record.
 */
export function authorizationLocations(sql: SqlStorage, resourceId: string) {
  return sql.exec<{ parent_id: string; substream_id: string; parent_kind: 'workstream' | 'automation' | 'space' }>(
    'SELECT parent_id, substream_id, parent_kind FROM authorization_locations WHERE resource_id = ? ORDER BY parent_id, substream_id',
    resourceId,
  ).toArray().map((row) => ({ parentId: row.parent_id, substreamId: row.substream_id, parentKind: row.parent_kind }));
}
