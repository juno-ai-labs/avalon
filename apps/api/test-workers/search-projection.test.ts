import { nextResourceSearchDueAt, publishResourceSearch } from '../src/durable-objects/resource-search-projection';
import { drainSearchProjectionOutbox, nextSearchProjectionDueAt } from '../src/durable-objects/search-projection-outbox';
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asSubstreamId, asWorkspaceId } from '@rally/contracts';
import { applyDurableObjectSqliteMigrations } from '../src/durable-objects/sqlite-migrations';
import { WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS } from '../src/durable-objects/workstream-object-schema';
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from '../src/durable-objects/workspace-do';
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
  it('isolates failed captures and returned contents to the requested document', async () => {
    const capture = vi.fn(async () => Response.json({ success: false, errors: [{ code: 5006 }] }, { status: 422 }));
    const captureEnv: Env = { ...env, BROWSER: createCloudflareTestBinding<BrowserRun>({ quickAction: capture }) };
    const stub = env.MIGRATION_PROBE_DO!.getByName('search-isolated-capture');
    await stub.ping();
    await runInDurableObject(stub, async (_instance, state) => {
      applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
        component: 'substream_agent_do', workerVersionId: 'search', now: 2_000 });
      seedWorkstreamRoot(state);
      const transcript = new WorkstreamTranscriptStorage(state.storage);
      await transcript.appendParticipantMessage({ turnId: 'pages', actor: 'system', authorUserId: null,
        authorSnapshot: null, text: 'https://example.com/ready https://example.com/failed',
        createdAtUtc: '2026-09-05T00:00:00Z', attentionOrdinal: 1 });
      const identity = { workspaceId, parentId: resourceId, substreamId: '0', parentKind: 'canvas' as const };
      const read = () => transcript.participantTurn('pages');
      const initial = await prepareConversationLinks(state.storage.sql, captureEnv, identity, 'pages', read, false);
      const ready = initial.documents.find((document) => document.text?.includes('/ready'))!;
      const failed = initial.documents.find((document) => document.id !== ready.id)!;
      state.storage.sql.exec('UPDATE conversation_search_links SET markdown = ?, captured = 1 WHERE id = ?',
        'retained body', ready.id);
      const success = await prepareConversationLinks(state.storage.sql, captureEnv, identity, 'pages', read, true, ready.id);
      expect(success.retry).toBe(false);
      expect(success.documents.map((document) => document.id)).toEqual([ready.id]);
      expect(success.documents[0]?.text).toContain('retained body');
      expect(capture).not.toHaveBeenCalled();
      const failure = await prepareConversationLinks(state.storage.sql, captureEnv, identity, 'pages', read, true, failed.id);
      expect(failure.retry).toBe(true);
      expect(failure.documents.map((document) => document.id)).toEqual([failed.id]);
      expect(failure.documents[0]?.text).toContain('/failed');
      expect(capture).toHaveBeenCalledTimes(1);
      expect(readConversationSearchLink(state.storage.sql, ready.id, read())?.text).toContain('retained body');
    });
  });

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
      const identity = { workspaceId, parentId: resourceId, substreamId: '0', parentKind: 'canvas' as const };
      const read = () => transcript.participantTurn('captured-link');
      const uncaptured = await prepareConversationLinks(state.storage.sql, captureEnv, identity, 'captured-link', read, false);
      expect(capture).not.toHaveBeenCalled();
      expect(uncaptured.documents[0]?.text).toBe('Reference\nhttps://example.com/');
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
  it('waits out the backlog interval only while a backlog remains', async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName('resource-search-pace');
    await stub.ping();
    await runInDurableObject(stub, async (_instance, state) => {
      applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
        component: 'workspace_do', workerVersionId: 'pace', now: 1_000 });
      const sql = state.storage.sql;
      sql.exec("INSERT INTO workspace_identity VALUES (1, ?, 'global', 'wnam', 0, 0)", workspaceId);
      for (let index = 0; index < 150; index += 1) {
        sql.exec(`INSERT INTO resources (id, workspace_id, resource_type, provider, title, metadata_json, created_at, updated_at)
          VALUES (?, ?, 'generated_file', 'avalon_generated', 'Plan', '{}', '2026-09-26T00:00:00Z', '2026-09-26T00:00:00Z')`,
        `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`, workspaceId);
      }
      const sent: number[] = [];
      const configured = { ...env, TURBO_PUFFER_DEV_API_KEY: 'test-only', OPENROUTER_API_KEY: 'test-only',
        ACTIVITY_QUEUE: createCloudflareTestBinding<Queue>({ sendBatch: async (messages) => { sent.push(Array.from(messages).length); } }) };
      const pending = () => sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM resource_search_versions WHERE pending = 1').one().n;
      const pace = { nextBatchAt: 0 };
      await publishResourceSearch(sql, configured, workspaceId, pace);
      expect([sent, pending()]).toEqual([[100], 50]);
      // A backlog remains, so the next batch and the alarm both wait.
      await publishResourceSearch(sql, configured, workspaceId, pace);
      expect([sent, pending()]).toEqual([[100], 50]);
      expect(nextResourceSearchDueAt(sql, configured, pace)).toBe(pace.nextBatchAt);
      expect(pace.nextBatchAt).toBeGreaterThan(Date.now());
      // Once it has passed, the rest goes, and a partial batch sets no wait.
      pace.nextBatchAt = 0;
      await publishResourceSearch(sql, configured, workspaceId, pace);
      expect([sent, pending(), pace.nextBatchAt]).toEqual([[100, 50], 0, 0]);
      // A last batch that happens to be full leaves no backlog either.
      sql.exec("UPDATE resource_search_versions SET pending = 1 WHERE resource_id IN (SELECT resource_id FROM resource_search_versions ORDER BY resource_id LIMIT 100)");
      await publishResourceSearch(sql, configured, workspaceId, pace);
      expect([sent, pending(), pace.nextBatchAt]).toEqual([[100, 50, 100], 0, 0]);
    });
  });

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
      seedWorkstreamRoot(state, 1, { parentKind: 'automation' });
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

describe('conversation display projection', () => {
  const identity = { region: 'global' as const, workspaceId, parentId: '00000000-0000-7000-8000-000000009e03', substreamId: asSubstreamId('0') };
  const outboxRows = (sql: SqlStorage) => sql.exec<{ channel: string; state: string; not_before: number; attempts: number }>(
    `SELECT channel, state, not_before, attempts FROM durable_outbox WHERE channel = 'search_conversation_v1'`).toArray();

  it('queues one display job per conversation when its title or archive changes and drains it as a reference', async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName('search-display-projection');
    await stub.ping();
    await runInDurableObject(stub, async (_instance, state) => {
      applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
        component: 'substream_agent_do', workerVersionId: 'search', now: 2_000 });
      seedWorkstreamRoot(state, 1, { workspaceId, workstreamId: identity.parentId, parentKind: 'automation' });
      const sql = state.storage.sql;
      sql.exec(`DELETE FROM durable_outbox`);
      // Bookkeeping writes on the identity row are not display changes.
      sql.exec(`UPDATE workstream SET preview = 'quiet', updated_at = 3 WHERE id = 1`);
      expect(outboxRows(sql)).toEqual([]);
      sql.exec(`UPDATE workstream SET title = 'Renamed', updated_at = 4 WHERE id = 1`);
      sql.exec(`UPDATE workstream SET archived_at = 5, updated_at = 5 WHERE id = 1`);
      expect(outboxRows(sql)).toEqual([{ channel: 'search_conversation_v1', state: 'pending', not_before: 0, attempts: 0 }]);
      expect(nextSearchProjectionDueAt(sql)).toBe(0);
      const failing = createCloudflareTestBinding<Queue>({ sendBatch: vi.fn(async () => { throw new Error('queue unavailable'); }) });
      await expect(drainSearchProjectionOutbox(sql, failing, identity)).rejects.toThrow('queue unavailable');
      expect(outboxRows(sql)).toEqual([expect.objectContaining({ state: 'pending', attempts: 1 })]);
      expect(outboxRows(sql)[0]!.not_before).toBeGreaterThan(Date.now());
      sql.exec(`UPDATE durable_outbox SET not_before = 0 WHERE channel = 'search_conversation_v1'`);
      const queue = createCloudflareTestBinding<Queue>({ sendBatch: vi.fn(async () => undefined) });
      await drainSearchProjectionOutbox(sql, queue, identity);
      expect(queue.sendBatch).toHaveBeenCalledWith([{ body: { type: 'search_conversation_projection_v1', ...identity } }]);
      expect(outboxRows(sql)).toEqual([]);
      expect(nextSearchProjectionDueAt(sql)).toBeNull();
    });
  });

  it('requeues committed turns once when the display attributes arrive', async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName('search-display-upgrade-from-v51');
    await stub.ping();
    await runInDurableObject(stub, async (_instance, state) => {
      applyDurableObjectSqliteMigrations({ storage: state.storage,
        migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 51),
        component: 'substream_agent_do', workerVersionId: 'v51', now: 1_000 });
      seedWorkstreamRoot(state, 1, { workspaceId, workstreamId: identity.parentId, parentKind: "automation" });
      const transcript = new WorkstreamTranscriptStorage(state.storage);
      for (const [turnId, ordinal] of [['delivered-turn', 1], ['pending-turn', 2]] as const) {
        await transcript.appendParticipantMessage({ turnId, actor: 'system', authorUserId: null, authorSnapshot: null,
          text: `Searchable ${turnId}`, createdAtUtc: '2026-09-05T00:00:00Z', attentionOrdinal: ordinal });
      }
      // One reference already delivered, one still waiting: the upgrade must not fail on either.
      state.storage.sql.exec(`DELETE FROM durable_outbox WHERE message_id = 'search-turn:delivered-turn'`);
    });
    await runInDurableObject(stub, async (_instance, state) => {
      applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
        component: 'substream_agent_do', workerVersionId: 'display', now: 2_000 });
      const sql = state.storage.sql;
      expect(sql.exec<{ message_id: string; state: string }>(
        `SELECT message_id, state FROM durable_outbox WHERE channel = 'search_projection_v1' ORDER BY message_id`).toArray())
        .toEqual([{ message_id: 'search-turn:delivered-turn', state: 'pending' }, { message_id: 'search-turn:pending-turn', state: 'pending' }]);
      expect(sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'workstream_search_display_update'`).toArray())
        .toEqual([{ name: 'workstream_search_display_update' }]);
    });
  });
});

/**
 * Whole-fleet re-projections: once after the 2026-09-10 deploy dead-lettered
 * document jobs whose publish intent the source had already cleared (WorkspaceDO
 * 51, AgentLoopDO 53), and once so rows written before search audience carry
 * one (WorkspaceDO 77, AgentLoopDO 70). Each object re-projects on its next wake.
 */
describe.each([
  { pass: 'after the consumer version skew', workspaceFrom: 50, substreamFrom: 52, suffix: '1' },
  { pass: 'for search audience', workspaceFrom: 76, substreamFrom: 69, suffix: '2' },
])('re-projection $pass', ({ workspaceFrom, substreamFrom, suffix }) => {
  it('marks every resource pending again without touching its revision or a committed retry schedule', async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName(`search-reprojection-upgrade-from-workspace-v${workspaceFrom}`);
    await stub.ping();
    const [published, backoff] = [`00000000-0000-7000-8000-00000000c${suffix}01`, `00000000-0000-7000-8000-00000000c${suffix}02`];
    const watermarks = (sql: SqlStorage) => sql.exec<{ resource_id: string; revision: number; pending: number; not_before: number }>(
      'SELECT resource_id, revision, pending, not_before FROM resource_search_versions ORDER BY resource_id').toArray();
    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({ storage: state.storage,
        migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= workspaceFrom),
        component: 'workspace_do', workerVersionId: `v${workspaceFrom}`, now: 1_000 });
      const sql = state.storage.sql;
      sql.exec("INSERT INTO workspace_identity VALUES (1, ?, 'global', 'wnam', 0, 0)", workspaceId);
      for (const [id, title] of [[published, 'Published'], [backoff, 'Backoff']] as const) {
        sql.exec(`INSERT INTO resources (id, workspace_id, resource_type, provider, title, metadata_json, created_at, updated_at)
          VALUES (?, ?, 'generated_file', 'avalon_generated', ?, '{}', '2026-09-10T00:00:00Z', '2026-09-10T00:00:00Z')`, id, workspaceId, title);
      }
      // One row already published (pending cleared), one still waiting out a dispatch retry.
      sql.exec('UPDATE resource_search_versions SET revision = 7, pending = 0 WHERE resource_id = ?', published);
      sql.exec('UPDATE resource_search_versions SET revision = 3, pending = 1, not_before = 123 WHERE resource_id = ?', backoff);
    });
    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
        component: 'workspace_do', workerVersionId: 'reprojection', now: 2_000 });
      expect(watermarks(state.storage.sql)).toEqual([
        { resource_id: published, revision: 7, pending: 1, not_before: 0 },
        { resource_id: backoff, revision: 3, pending: 1, not_before: 123 },
      ]);
    });
  });

  it('requeues every committed turn at its current revision, recreating a drained reference and advancing a stale one', async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName(`search-reprojection-upgrade-from-substream-v${substreamFrom}`);
    await stub.ping();
    const identity = { workspaceId, workstreamId: `00000000-0000-7000-8000-000000009e0${suffix === '1' ? '4' : '5'}` };
    const outbox = (sql: SqlStorage) => sql.exec<{ message_id: string; source_version: number; state: string; not_before: number }>(
      `SELECT message_id, source_version, state, not_before FROM durable_outbox
       WHERE channel = 'search_projection_v1' ORDER BY message_id`).toArray();
    await runInDurableObject(stub, async (_instance, state) => {
      applyDurableObjectSqliteMigrations({ storage: state.storage,
        migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= substreamFrom),
        component: 'substream_agent_do', workerVersionId: `v${substreamFrom}`, now: 1_000 });
      seedWorkstreamRoot(state, 1, { ...identity, parentKind: 'automation' });
      const transcript = new WorkstreamTranscriptStorage(state.storage);
      for (const [turnId, ordinal] of [['lost-turn', 1], ['waiting-turn', 2]] as const) {
        await transcript.appendParticipantMessage({ turnId, actor: 'system', authorUserId: null, authorSnapshot: null,
          text: `Searchable ${turnId}`, createdAtUtc: '2026-09-10T00:00:00Z', attentionOrdinal: ordinal });
      }
      const sql = state.storage.sql;
      // Both turns have been edited past the revision a fresh append records.
      sql.exec(`UPDATE participant_transcript_turns SET revision = 4 WHERE turn_id = 'lost-turn'`);
      sql.exec(`UPDATE participant_transcript_turns SET revision = 5 WHERE turn_id = 'waiting-turn'`);
      // The lost turn's reference was drained; the waiting one still holds a
      // reference from before its latest edit, in dispatch backoff.
      sql.exec(`DELETE FROM durable_outbox WHERE message_id = 'search-turn:lost-turn'`);
      sql.exec(`UPDATE durable_outbox SET source_version = 2, not_before = 456 WHERE message_id = 'search-turn:waiting-turn'`);
    });
    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
        component: 'substream_agent_do', workerVersionId: 'reprojection', now: 2_000 });
      expect(outbox(state.storage.sql)).toEqual([
        { message_id: 'search-turn:lost-turn', source_version: 4, state: 'pending', not_before: 0 },
        { message_id: 'search-turn:waiting-turn', source_version: 5, state: 'pending', not_before: 0 },
      ]);
    });
  });
});
