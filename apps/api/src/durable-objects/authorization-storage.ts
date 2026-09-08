import { z } from 'zod';
import { IdSchema, SubstreamIdSchema, WorkspaceIdSchema } from '@rally/contracts';
import { AUTHORIZATION_FRESHNESS_MS, AuthorizationSnapshotSchema, authorizationResourceKey, decisionIsFresh,
  type AuthorizationSnapshot, type AuthorizationResource, type AuthorizationSubject } from '../services/authorization-policy';

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
  `CREATE TABLE authorization_locations (parent_id TEXT NOT NULL, substream_id TEXT NOT NULL,
     parent_kind TEXT NOT NULL, resource_id TEXT NOT NULL, PRIMARY KEY(parent_id, substream_id, resource_id)) STRICT`,
  `CREATE INDEX authorization_locations_resource_idx ON authorization_locations(resource_id, parent_id, substream_id)`,
  `CREATE TABLE authorization_inventories (parent_id TEXT NOT NULL, substream_id TEXT NOT NULL,
     revision INTEGER NOT NULL, validated_at INTEGER NOT NULL, PRIMARY KEY(parent_id, substream_id)) STRICT`,
  `CREATE TABLE authorization_backfill (parent_id TEXT PRIMARY KEY, parent_kind TEXT NOT NULL,
     completed INTEGER NOT NULL DEFAULT 0) STRICT`,
  `CREATE TABLE authorization_backfill_children (parent_id TEXT NOT NULL, substream_id TEXT NOT NULL,
     completed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(parent_id, substream_id)) STRICT`,
  `CREATE TABLE authorization_delivery (job_key TEXT PRIMARY KEY, payload_json TEXT NOT NULL, not_before INTEGER NOT NULL) STRICT`,
];

export function authorizationSnapshotKey(subject: AuthorizationSubject, resource: AuthorizationResource): string {
  return JSON.stringify([subject, authorizationResourceKey(resource)]);
}

/** SQLite owns snapshot publication ordering; cache delivery can never renew evidence. */
export class AuthorizationStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  read(subject: AuthorizationSubject, resource: AuthorizationResource, now: number): AuthorizationSnapshot | null {
    const row = this.storage.sql.exec<{ snapshot_json: string }>(
      'SELECT snapshot_json FROM authorization_snapshots WHERE cache_key = ?', authorizationSnapshotKey(subject, resource),
    ).toArray()[0];
    if (!row) return null;
    const parsed = AuthorizationSnapshotSchema.safeParse(JSON.parse(row.snapshot_json));
    return parsed.success && decisionIsFresh(parsed.data.decision, now) ? parsed.data : null;
  }

  write(snapshot: AuthorizationSnapshot): void {
    if (!decisionIsFresh(snapshot.decision, Date.now()) || snapshot.decision.status === 'unavailable') return;
    const validatedAt = Math.min(...snapshot.decision.evidence.map((evidence) => evidence.validatedAt));
    this.storage.sql.exec('DELETE FROM authorization_snapshots WHERE validated_at <= ?', Date.now() - AUTHORIZATION_FRESHNESS_MS);
    this.storage.sql.exec(`INSERT INTO authorization_snapshots(cache_key, snapshot_json, validated_at) VALUES (?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET snapshot_json = excluded.snapshot_json, validated_at = excluded.validated_at
      WHERE excluded.validated_at > authorization_snapshots.validated_at`,
    authorizationSnapshotKey(snapshot.subject, snapshot.resource), JSON.stringify(snapshot), validatedAt);
  }

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
