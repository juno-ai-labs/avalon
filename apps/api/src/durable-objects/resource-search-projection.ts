import { searchIndexingConfigured } from '../services/search-embedding';
import { z } from 'zod';
import { IdSchema, WorkspaceIdSchema } from '@rally/contracts';
import type { Env } from '../env';
import { resourceSearchCategory, resourceSearchText } from '../services/resource-search-text';
import { searchDocumentId } from '../services/text-search';
import type { SearchDocumentBatch, SearchDocument } from '../services/search-document';

export const ResourceSearchProjectionSchema = z.strictObject({
  type: z.literal('resource_search_projection_v1'), region: z.enum(['global', 'eu']),
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

export function resourceSearchRevision(sql: SqlStorage, resourceId: string): number | null {
  return sql.exec<{ revision: number }>('SELECT revision FROM resource_search_versions WHERE resource_id = ?', resourceId)
    .toArray()[0]?.revision ?? null;
}
export function nextResourceSearchDueAt(sql: SqlStorage, env?: Env): number | null {
  if (env && !searchIndexingConfigured(env)) return null;
  return sql.exec<{ due_at: number | null }>('SELECT MIN(not_before) AS due_at FROM resource_search_versions WHERE pending = 1')
    .one().due_at;
}
export async function publishResourceSearch(sql: SqlStorage, env: Env, workspaceId: string): Promise<void> {
  if (!searchIndexingConfigured(env)) return;
  // The existing activity Queue accepts at most 100 messages in one batch.
  const rows = sql.exec<{ resource_id: string; revision: number }>(
    'SELECT resource_id, revision FROM resource_search_versions WHERE pending = 1 AND not_before <= ? ORDER BY not_before, resource_id LIMIT 100', Date.now(),
  ).toArray();
  if (!rows.length) return;
  try {
    await env.ACTIVITY_QUEUE.sendBatch(rows.map((row) => ({ body: ResourceSearchProjectionSchema.parse({
      type: 'resource_search_projection_v1', region: env.AVALON_REGION, workspaceId, resourceId: row.resource_id,
    }) })));
    for (const row of rows) sql.exec('UPDATE resource_search_versions SET pending = 0 WHERE resource_id = ? AND revision = ?', row.resource_id, row.revision);
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
  const category = row ? resourceSearchCategory(row.provider, row.canonical_url) : null;
  const categoryId = category ? await searchDocumentId(category, workspaceId, resourceId) : null;
  const text = row && category && (documentId === undefined || documentId === categoryId) ? await resourceSearchText(env, row) : null;
  if (resourceSearchRevision(sql, resourceId) !== revision) throw new Error('search_source_changed');
  const documents: SearchDocument[] = [];
  for (const source of ['files', 'artifacts', 'links'] as const) {
    const id = await searchDocumentId(source, workspaceId, resourceId);
    if (documentId !== undefined && documentId !== id) continue;
    const live = source === category && text !== null && row !== undefined;
    documents.push({ id,
      source, sourceId: resourceId, scopeId: workspaceId, revision,
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
