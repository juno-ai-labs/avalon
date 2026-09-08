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
    documents.push({ id,
      source, sourceId: resourceId, scopeId: workspaceId, revision,
      text: source === category ? text : null });
  }
  return { documents, retry: false };
}
