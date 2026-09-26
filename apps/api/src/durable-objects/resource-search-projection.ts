import { RegionSchema } from "@rally/contracts/regions";
import { searchIndexingConfigured } from '../services/search-embedding';
import { z } from 'zod';
import { IdSchema, WorkspaceIdSchema } from '@rally/contracts';
import type { Env } from '../env';
import { resourceSearchCategory, resourceSearchText } from '../services/resource-search-text';
import { isUnlistedResourceMetadata } from '../services/resource-listing';
import { searchDocumentId } from '../services/text-search';
import type { SearchDocumentBatch, SearchDocument } from '../services/search-document';
import { resourceSearchAudience } from '../services/search-audience';
import { authorizationLocations } from './authorization-storage';

export const ResourceSearchProjectionSchema = z.strictObject({
  type: z.literal('resource_search_projection_v1'), region: RegionSchema,
  workspaceId: WorkspaceIdSchema, resourceId: IdSchema,
});
export const ResourceSearchRevisionRequestSchema = ResourceSearchProjectionSchema.pick({ workspaceId: true, resourceId: true });

/** Revision watermarks survive deletion. Triggers cover every canonical writer. */
export const RESOURCE_SEARCH_MIGRATION_STATEMENTS = [
  `CREATE TABLE resource_search_versions (
    resource_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK (revision > 0),
    pending INTEGER NOT NULL CHECK (pending IN (0, 1)), not_before INTEGER NOT NULL
  ) STRICT`,
  ...(['INSERT', 'UPDATE', 'DELETE'] as const).map((operation) => {
    const row = operation === 'DELETE' ? 'OLD' : 'NEW';
    return `CREATE TRIGGER resources_search_${operation.toLowerCase()} AFTER ${operation} ON resources
      BEGIN
        INSERT INTO resource_search_versions(resource_id, revision, pending, not_before)
        VALUES (${row}.id, 1, 1, 0)
        ON CONFLICT(resource_id) DO UPDATE SET revision = revision + 1, pending = 1, not_before = 0;
      END`;
  }),
  `INSERT INTO resource_search_versions(resource_id, revision, pending, not_before)
   SELECT id, 1, 1, 0 FROM resources`,
];

/** Migration 43: immutable once shipped; new extraction inputs need a new migration. */
export const RESOURCE_SEARCH_CONTENT_UPDATE_MIGRATION = [
  'DROP TRIGGER resources_search_update',
  `CREATE TRIGGER resources_search_update AFTER UPDATE ON resources
    WHEN OLD.provider IS NOT NEW.provider
      OR OLD.title IS NOT NEW.title
      OR OLD.canonical_url IS NOT NEW.canonical_url
      OR OLD.mime_type IS NOT NEW.mime_type
      OR OLD.content_ref IS NOT NEW.content_ref
      OR OLD.content_sha256 IS NOT NEW.content_sha256
      OR OLD.model_mime_type IS NOT NEW.model_mime_type
      OR OLD.model_content_ref IS NOT NEW.model_content_ref
      OR OLD.model_content_sha256 IS NOT NEW.model_content_sha256
      OR COALESCE((SELECT CASE WHEN type = 'text' THEN atom ELSE '' END
          FROM json_each(OLD.metadata_json) WHERE key = 'description' ORDER BY id DESC LIMIT 1), '')
        IS NOT COALESCE((SELECT CASE WHEN type = 'text' THEN atom ELSE '' END
          FROM json_each(NEW.metadata_json) WHERE key = 'description' ORDER BY id DESC LIMIT 1), '')
    BEGIN
      INSERT INTO resource_search_versions(resource_id, revision, pending, not_before)
      VALUES (NEW.id, 1, 1, 0)
      ON CONFLICT(resource_id) DO UPDATE SET revision = revision + 1, pending = 1, not_before = 0;
    END`,
];

/**
 * Migration 76: a resource's rows also carry who may read them (its search
 * audience, see `services/search-audience.ts`), so a change to any input of
 * that audience must rewrite them too. The update trigger additionally
 * watches the uploader, the attachment status (a draft becoming sent), a
 * Resend resource becoming or ceasing to be an email, and the connection. The
 * location triggers rewrite a resource when an inventory attaches it to, or
 * detaches it from, a conversation, or corrects whether that conversation
 * belongs to a Sidekick.
 * Immutable once shipped, like migration 43's statement it replaces.
 */
export const RESOURCE_SEARCH_AUDIENCE_MIGRATION = [
  'DROP TRIGGER resources_search_update',
  `CREATE TRIGGER resources_search_update AFTER UPDATE ON resources
    WHEN OLD.provider IS NOT NEW.provider
      OR OLD.title IS NOT NEW.title
      OR OLD.canonical_url IS NOT NEW.canonical_url
      OR OLD.mime_type IS NOT NEW.mime_type
      OR OLD.content_ref IS NOT NEW.content_ref
      OR OLD.content_sha256 IS NOT NEW.content_sha256
      OR OLD.model_mime_type IS NOT NEW.model_mime_type
      OR OLD.model_content_ref IS NOT NEW.model_content_ref
      OR OLD.model_content_sha256 IS NOT NEW.model_content_sha256
      OR OLD.uploaded_by_user_id IS NOT NEW.uploaded_by_user_id
      OR OLD.attachment_status IS NOT NEW.attachment_status
      OR (NEW.provider = 'resend' AND (OLD.resource_type = 'email') IS NOT (NEW.resource_type = 'email'))
      OR OLD.connection_id IS NOT NEW.connection_id
      OR COALESCE((SELECT CASE WHEN type = 'text' THEN atom ELSE '' END
          FROM json_each(OLD.metadata_json) WHERE key = 'description' ORDER BY id DESC LIMIT 1), '')
        IS NOT COALESCE((SELECT CASE WHEN type = 'text' THEN atom ELSE '' END
          FROM json_each(NEW.metadata_json) WHERE key = 'description' ORDER BY id DESC LIMIT 1), '')
    BEGIN
      INSERT INTO resource_search_versions(resource_id, revision, pending, not_before)
      VALUES (NEW.id, 1, 1, 0)
      ON CONFLICT(resource_id) DO UPDATE SET revision = revision + 1, pending = 1, not_before = 0;
    END`,
  ...(['INSERT', 'DELETE'] as const).map((operation) => {
    const row = operation === 'DELETE' ? 'OLD' : 'NEW';
    return `CREATE TRIGGER authorization_locations_search_${operation.toLowerCase()} AFTER ${operation} ON authorization_locations
      BEGIN
        INSERT INTO resource_search_versions(resource_id, revision, pending, not_before)
        VALUES (${row}.resource_id, 1, 1, 0)
        ON CONFLICT(resource_id) DO UPDATE SET revision = revision + 1, pending = 1, not_before = 0;
      END`;
  }),
  // A location's parent kind decides whether it admits a Sidekick's readers or a conversation's.
  `CREATE TRIGGER authorization_locations_search_update AFTER UPDATE OF parent_kind ON authorization_locations
    WHEN OLD.parent_kind IS NOT NEW.parent_kind
    BEGIN
      INSERT INTO resource_search_versions(resource_id, revision, pending, not_before)
      VALUES (NEW.resource_id, 1, 1, 0)
      ON CONFLICT(resource_id) DO UPDATE SET revision = revision + 1, pending = 1, not_before = 0;
    END`,
];

export function resourceSearchRevision(sql: SqlStorage, resourceId: string): number | null {
  return sql.exec<{ revision: number }>('SELECT revision FROM resource_search_versions WHERE resource_id = ?', resourceId)
    .toArray()[0]?.revision ?? null;
}
/**
 * How long the WorkspaceDO waits after dispatching a full batch before the next.
 *
 * Without it: a whole-workspace re-projection (migration 77) dispatched 100
 * resources, re-armed its alarm at once and dispatched 100 more. Each resource
 * becomes three document jobs, and each job calls `prepareResourceSearchDocument`
 * back on this object, so at Juno Labs (152k resources) the object answered
 * about 1,600 of those calls a minute on top of its own traffic and returned
 * `durable_object_overloaded` to 38,000 of them in 30 minutes, failing connector
 * events and search-authorization pushes with them. Only our own backfills
 * reach it; nothing else paces the loop, because the Queue accepts the batch
 * as soon as it is sent. A trip is a backlog that drains more slowly.
 * 30 seconds (200 resources a minute) was set by Adam on 2026-09-26.
 */
export const RESOURCE_SEARCH_BACKLOG_INTERVAL_MS = 30_000;
/** The activity Queue accepts at most 100 messages in one batch. */
const RESOURCE_SEARCH_BATCH = 100;

/** When the next batch may go. Held by the object, not stored: a restart dispatches one batch early. */
export interface ResourceSearchPace { nextBatchAt: number }

export function nextResourceSearchDueAt(sql: SqlStorage, env?: Env, pace?: ResourceSearchPace): number | null {
  if (env && !searchIndexingConfigured(env)) return null;
  const due = sql.exec<{ due_at: number | null }>('SELECT MIN(not_before) AS due_at FROM resource_search_versions WHERE pending = 1')
    .one().due_at;
  return due === null || !pace ? due : Math.max(due, pace.nextBatchAt);
}
export async function publishResourceSearch(sql: SqlStorage, env: Env, workspaceId: string,
  pace?: ResourceSearchPace, intervalMs = RESOURCE_SEARCH_BACKLOG_INTERVAL_MS): Promise<void> {
  if (!searchIndexingConfigured(env)) return;
  if (pace && Date.now() < pace.nextBatchAt) return;
  const rows = sql.exec<{ resource_id: string; revision: number }>(
    'SELECT resource_id, revision FROM resource_search_versions WHERE pending = 1 AND not_before <= ? ORDER BY not_before, resource_id LIMIT ?',
    Date.now(), RESOURCE_SEARCH_BATCH,
  ).toArray();
  if (!rows.length) return;
  try {
    await env.ACTIVITY_QUEUE.sendBatch(rows.map((row) => ({ body: ResourceSearchProjectionSchema.parse({
      type: 'resource_search_projection_v1', region: env.AVALON_REGION, workspaceId, resourceId: row.resource_id,
    }) })));
    for (const row of rows) sql.exec('UPDATE resource_search_versions SET pending = 0 WHERE resource_id = ? AND revision = ?', row.resource_id, row.revision);
    // Only a backlog is paced: once nothing due is left, the next edit goes at once.
    if (pace && rows.length === RESOURCE_SEARCH_BATCH && sql.exec(
      'SELECT 1 FROM resource_search_versions WHERE pending = 1 AND not_before <= ? LIMIT 1', Date.now(),
    ).toArray().length) pace.nextBatchAt = Date.now() + intervalMs;
  } catch (error) {
    // Use the regional-effect outbox dispatch retry interval.
    for (const row of rows) sql.exec('UPDATE resource_search_versions SET not_before = ? WHERE resource_id = ? AND revision = ?', Date.now() + 5_000, row.resource_id, row.revision);
    throw error;
  }
}
/** Extraction only: the Queue Worker owns all indexing and chunking. */
export async function prepareResourceSearch(sql: SqlStorage, env: Env, workspaceId: string, resourceId: string, documentId?: string): Promise<SearchDocumentBatch> {
  const revision = resourceSearchRevision(sql, resourceId);
  if (revision === null) return { documents: [], retry: false };
  const row = sql.exec('SELECT * FROM resources WHERE id = ?', resourceId).toArray()[0];
  // Search is an enumerating surface, so an unlisted resource has no category.
  // A null category also drives every source below to `live = false`, which
  // withdraws a row that was indexed before it was marked unlisted.
  const category = row && !isUnlistedResourceMetadata(row.metadata_json)
    ? resourceSearchCategory(row.provider, row.canonical_url)
    : null;
  const categoryId = category ? await searchDocumentId(category, workspaceId, resourceId) : null;
  const text = row && category && (documentId === undefined || documentId === categoryId) ? await resourceSearchText(env, row) : null;
  if (resourceSearchRevision(sql, resourceId) !== revision) throw new Error('search_source_changed');
  // Read after the revision check, with no await between: a location change
  // bumps the revision (migration 76), so these are the locations of this revision.
  const audience = row ? resourceSearchAudience(workspaceId, {
    provider: String(row.provider), resource_type: String(row.resource_type),
    uploaded_by_user_id: typeof row.uploaded_by_user_id === 'string' ? row.uploaded_by_user_id : null,
    attachment_status: typeof row.attachment_status === 'string' ? row.attachment_status : null,
    connection_id: typeof row.connection_id === 'string' ? row.connection_id : null,
  }, authorizationLocations(sql, resourceId)) : [];
  const documents: SearchDocument[] = [];
  for (const source of ['files', 'artifacts', 'links'] as const) {
    const id = await searchDocumentId(source, workspaceId, resourceId);
    if (documentId !== undefined && documentId !== id) continue;
    const live = source === category && text !== null && row !== undefined;
    documents.push({ id,
      source, sourceId: resourceId, scopeId: workspaceId, revision,
      // A connector resource is admitted by its connection's projected decision.
      ...(live && typeof row.connection_id === 'string' ? { connectionId: row.connection_id } : {}),
      ...(live ? { audience } : {}),
      text: live ? text : null,
      // The row is the canonical metadata the result used to reload; the index
      // now carries it so a hit renders without touching this object again.
      ...(live ? { display: {
        title: String(row.title ?? ''), sourceLabel: String(row.title ?? ''),
        occurredAt: resourceDisplayTime(row.updated_at), transcriptSequence: null, url: null,
        mimeType: typeof row.mime_type === 'string' ? row.mime_type : null, archived: false,
      } } : {}) });
  }
  return { documents, retry: false };
}

/** WorkspaceDO keeps ISO strings; the index stores Unix milliseconds or nothing. */
function resourceDisplayTime(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
