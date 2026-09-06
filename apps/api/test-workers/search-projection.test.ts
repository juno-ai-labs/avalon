import { nextResourceSearchDueAt, publishResourceSearch } from '../src/durable-objects/resource-search-projection';
import { nextSearchProjectionDueAt } from '../src/durable-objects/search-projection-outbox';
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asWorkspaceId } from '@rally/contracts';
import { applyDurableObjectSqliteMigrations } from '../src/durable-objects/sqlite-migrations';
import { WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS } from '../src/durable-objects/workstream-object-schema';
import { WorkstreamTranscriptStorage } from '../src/durable-objects/workstream-transcript-storage';
import { seedWorkstreamRoot } from './helpers/substream-fixture';
import { workspaceDOName } from '../src/durable-objects/names';
import { prepareConversationLinks, readConversationSearchLink } from '../src/durable-objects/conversation-link-search';
import { createCloudflareTestBinding } from '../test/helpers/cloudflare-test';
import type { Env } from '../src/env';
import { resourceSearchText } from '../src/services/resource-search-text';

const workspaceId = asWorkspaceId('00000000-0000-7000-8000-000000009e01');
const resourceId = '00000000-0000-7000-8000-000000009e02';
afterEach(() => vi.unstubAllGlobals());

describe('resource searchable contents', () => {
  it('reads structured text originals and extracted derivatives without decoding binary originals', async () => {
    const originalRef = 'search-test/structured-original';
    const derivativeRef = 'search-test/extracted-text';
    await env.PAYLOADS.put(originalRef, 'unique structured body');
    await env.PAYLOADS.put(derivativeRef, 'unique extracted body');
    try {
      for (const mimeType of ['application/json', 'application/javascript', 'application/xml']) {
        expect(await resourceSearchText(env, { title: 'Source', mime_type: mimeType, content_ref: originalRef, metadata_json: '{broken' }))
          .toContain('unique structured body');
      }
      expect(await resourceSearchText(env, { title: 'misleading.txt', mime_type: 'image/png', content_ref: originalRef }))
        .toBe('misleading.txt');
      expect(await resourceSearchText(env, { title: 'Document', mime_type: 'application/pdf', content_ref: originalRef,
        model_mime_type: 'text/plain', model_content_ref: derivativeRef }))
        .toBe('Document\nunique extracted body');
    } finally {
      await env.PAYLOADS.delete([originalRef, derivativeRef]);
    }
  });
});

describe('conversation page capture', () => {
  it('persists captured contents, publishes them in the originating scope, and reuses the capture on retry', async () => {
    // Only external providers are doubled; canonical state runs in workerd.
    const writes: unknown[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (!new URL(request.url).hostname.endsWith('.turbopuffer.com')) throw new Error('unexpected_external_request');
      writes.push(await request.json());
      return Response.json({ rows_affected: 1 });
    });
    const capture = vi.fn(async () => Response.json({ success: true, result: 'Page body with searchable detail' }));
    const captureEnv: Env = { ...env, TURBO_PUFFER_DEV_API_KEY: 'test-only', APP_ENV: 'development',
      BROWSER: createCloudflareTestBinding<BrowserRun>({ quickAction: capture }) };
    const stub = env.MIGRATION_PROBE_DO!.getByName('search-browser-capture');
    await stub.ping();
    await runInDurableObject(stub, async (_instance, state) => {
      applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
        component: 'substream_agent_do', workerVersionId: 'search', now: 2_000 });
      seedWorkstreamRoot(state);
      const transcript = new WorkstreamTranscriptStorage(state.storage);
      await transcript.appendParticipantMessage({ turnId: 'captured-link', actor: 'system', authorUserId: null,
        authorSnapshot: null, text: '[Reference](https://example.com/)',
        createdAtUtc: '2026-09-05T00:00:00Z', attentionOrdinal: 1 });
      const identity = { workspaceId, parentId: resourceId, substreamId: '0' };
      const read = () => transcript.participantTurn('captured-link');
      const prepared = await prepareConversationLinks(state.storage.sql, captureEnv, identity, 'captured-link', read);
      const row = state.storage.sql.exec<{ id: string; captured: number }>('SELECT id, captured FROM conversation_search_links').one();
      expect(row.captured).toBe(1);
      expect(readConversationSearchLink(state.storage.sql, row.id, read())?.text)
        .toBe('Reference\nhttps://example.com/\nPage body with searchable detail');
      expect(prepared.retry).toBe(false);
      expect(prepared.documents[0]?.text).toContain('searchable detail');
      expect(prepared.documents[0]?.scopeId).toBe(resourceId);
      expect(writes).toHaveLength(0); // Source extraction never writes the index.
      await prepareConversationLinks(state.storage.sql, captureEnv, identity, 'captured-link', read);
      expect(capture).toHaveBeenCalledTimes(1);
    });
  });
});

describe('durable resource search projection', () => {
  it('records create, edits, and deletion with a retained monotonic watermark', async () => {
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName('global', workspaceId)));
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`INSERT OR IGNORE INTO workspace_identity
        (id, workspace_id, region, placement_affinity, created_at, updated_at)
        VALUES (1, ?, 'global', 'wnam', 0, 0)`, workspaceId);
      sql.exec(`INSERT INTO resources
        (id, workspace_id, resource_type, provider, provider_resource_id, title, mime_type,
         metadata_json, attachment_status, model_content_status, created_at, updated_at)
        VALUES (?, ?, 'generated_file', 'avalon_generated', 'terminal:plan.md', 'Plan',
          'text/markdown', '{}', 'attached', 'pending', '2026-09-05T00:00:00Z', '2026-09-05T00:00:00Z')`, resourceId, workspaceId);
      const revision = () => sql.exec<{ revision: number; pending: number }>(
        'SELECT revision, pending FROM resource_search_versions WHERE resource_id = ?', resourceId,
      ).one();
      const created = revision();
      expect(created.pending).toBe(1);
      expect(nextResourceSearchDueAt(sql, env)).toBeNull();
      await publishResourceSearch(sql, env, workspaceId);
      expect(revision().pending).toBe(1);
      expect(nextResourceSearchDueAt(sql, { ...env, TURBO_PUFFER_DEV_API_KEY: 'test-only',
        OPENROUTER_API_KEY: 'test-only' })).toBe(0);
      sql.exec('UPDATE resource_search_versions SET pending = 0 WHERE resource_id = ?', resourceId);
      sql.exec('UPDATE resources SET title = ? WHERE id = ?', 'Revised plan', resourceId);
      const edited = revision();
      expect(edited.revision).toBeGreaterThan(created.revision);
      expect(edited.pending).toBe(1);
      sql.exec('DELETE FROM resources WHERE id = ?', resourceId);
      expect(revision().revision).toBeGreaterThan(edited.revision);
      expect(revision().pending).toBe(1);
    });
  });
});

describe('transcript search migration', () => {
  it('rejects stale captured link labels and removed source links before projection catches up', async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName('search-link-source-fence');
    await stub.ping();
    await runInDurableObject(stub, async (_instance, state) => {
      applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
        component: 'substream_agent_do', workerVersionId: 'search', now: 2_000 });
      seedWorkstreamRoot(state);
      const transcript = new WorkstreamTranscriptStorage(state.storage);
      await transcript.appendParticipantMessage({ turnId: 'link-source', actor: 'system', authorUserId: null,
        authorSnapshot: null, text: '[Current label](https://example.com/)',
        createdAtUtc: '2026-09-05T00:00:00Z', attentionOrdinal: 1 });
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO conversation_search_links(id, turn_id, url, label, markdown, captured, revision)
        VALUES ('link', 'link-source', 'https://example.com/', 'Previous label', 'Captured content', 1, 1)`);
      expect(readConversationSearchLink(sql, 'link', transcript.participantTurn('link-source'))).toBeNull();
      sql.exec("UPDATE conversation_search_links SET label = 'Current label', revision = 2 WHERE id = 'link'");
      expect(readConversationSearchLink(sql, 'link', transcript.participantTurn('link-source'))?.text)
        .toBe('Current label\nhttps://example.com/\nCaptured content');
      const current = transcript.participantTurn('link-source')!;
      expect(readConversationSearchLink(sql, 'link', { ...current, blocks: [] })).toBeNull();
      expect(readConversationSearchLink(sql, 'link', null)).toBeNull();
    });
  });
  it('backfills committed history and makes new transcript writes atomic with search intent', async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName('search-upgrade-from-v41');
    await stub.ping();
    await runInDurableObject(stub, async (_instance, state) => {
      applyDurableObjectSqliteMigrations({ storage: state.storage,
        migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 41),
        component: 'substream_agent_do', workerVersionId: 'v41', now: 1_000 });
      seedWorkstreamRoot(state);
      await new WorkstreamTranscriptStorage(state.storage).appendParticipantMessage({
        turnId: 'historical-turn', actor: 'system', authorUserId: null, authorSnapshot: null,
        text: 'Historical searchable message', createdAtUtc: '2026-09-05T00:00:00Z', attentionOrdinal: 1,
      });
    });
    // The old graph commits before the new worker opens it.
    await runInDurableObject(stub, async (_instance, state) => {
      applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
        component: 'substream_agent_do', workerVersionId: 'search', now: 2_000 });
      const sql = state.storage.sql;
      expect(sql.exec<{ payload_json: string }>(`SELECT payload_json FROM durable_outbox WHERE channel = 'search_projection_v1'`).one().payload_json)
        .toBe(JSON.stringify({ turnId: 'historical-turn' }));
      expect(nextSearchProjectionDueAt(sql, env)).toBeNull();
      expect(nextSearchProjectionDueAt(sql)).toBe(0);
      sql.exec(`CREATE TRIGGER fail_search_delivery_intent BEFORE INSERT ON durable_outbox
        WHEN NEW.channel = 'search_projection_v1' BEGIN SELECT RAISE(ABORT, 'search_intent_rejected'); END`);
      await expect(new WorkstreamTranscriptStorage(state.storage).appendParticipantMessage({
        turnId: 'must-roll-back', actor: 'system', authorUserId: null, authorSnapshot: null,
        text: 'Must not commit without an index intent', createdAtUtc: '2026-09-05T00:00:01Z', attentionOrdinal: 2,
      })).rejects.toThrow('search_intent_rejected');
      expect(sql.exec('SELECT turn_id FROM participant_transcript_turns WHERE turn_id = ?', 'must-roll-back').toArray()).toEqual([]);
      expect(sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([]);
    });
  });
});
