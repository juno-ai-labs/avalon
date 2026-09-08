import { z } from 'zod';
import { IdSchema, SubstreamIdSchema, WorkspaceIdSchema } from '@rally/contracts';
import { authorizationResourceKey,
  type AuthorizationResource, type AuthorizationSubject } from '../services/authorization-policy';

export const AuthorizationLocationSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema, parentId: IdSchema, substreamId: SubstreamIdSchema,
  parentKind: z.enum(['workstream', 'automation']),
  revision: z.number().int().nonnegative(), validatedAt: z.number().int().nonnegative(),
  resourceIds: z.array(IdSchema),
});
export type AuthorizationLocation = z.infer<typeof AuthorizationLocationSchema>;

/** Routed only to typed WorkspaceDO methods, never to regional SQL or generic writes. */
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
      this.storage.sql.exec('DELETE FROM authorization_locations WHERE parent_id = ? AND substream_id = ?', input.parentId, input.substreamId);
      for (const resourceId of new Set(input.resourceIds)) this.storage.sql.exec(
        'INSERT INTO authorization_locations(parent_id, substream_id, parent_kind, resource_id) VALUES (?, ?, ?, ?)',
        input.parentId, input.substreamId, input.parentKind, resourceId);
      this.storage.sql.exec(`INSERT INTO authorization_inventories(parent_id, substream_id, revision, validated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(parent_id, substream_id) DO UPDATE SET revision = excluded.revision, validated_at = excluded.validated_at`,
      input.parentId, input.substreamId, input.revision, input.validatedAt);
    });
  }

  locations(resourceId: string) {
    return this.storage.sql.exec<{ parent_id: string; substream_id: string; parent_kind: 'workstream' | 'automation' }>(
      'SELECT parent_id, substream_id, parent_kind FROM authorization_locations WHERE resource_id = ? ORDER BY parent_id, substream_id',
      resourceId,
    ).toArray().map((row) => ({ parentId: row.parent_id, substreamId: row.substream_id, parentKind: row.parent_kind }));
  }
}
