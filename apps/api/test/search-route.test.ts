import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { HonoAppEnv } from '../src/env';
import { requireAuth } from '../src/middleware/auth';
import { errorHandler } from '../src/middleware/errors';
import { searchRoutes } from '../src/routes/search';
import { searchAuthorizationKey } from '../src/services/search-authorization';
import { asSubstreamId, asUserId, asWorkspaceId } from '@rally/contracts';
import { createTestEnv } from './helpers/cloudflare-test';
import { migratedSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';

const providerQuery = vi.hoisted(() => vi.fn());
vi.mock('@turbopuffer/turbopuffer', () => ({ Turbopuffer: class {
  namespace() { return { query: providerQuery }; }
} }));

const USER = '00000000-0000-7000-8000-000000000001';
const WORKSPACE = '00000000-0000-7000-8000-000000000002';
const opened: DatabaseSync[] = [];
afterEach(() => { providerQuery.mockReset(); for (const db of opened.splice(0)) db.close(); });
const emptyCache = { get: async () => null } as unknown as KVNamespace;
function fixture(cache: KVNamespace = emptyCache) {
  const db = migratedSqliteDatabase();
  opened.push(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO users(id, google_subject, email, name, created_at, updated_at)
    VALUES (?, 'search-member', 'search@example.test', 'Search member', ?, ?)`).run(USER, now, now);
  db.prepare(`INSERT INTO workspaces(id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES (?, 'Search', 'search', 'global', ?, ?, ?)`).run(WORKSPACE, USER, now, now);
  db.prepare(`INSERT INTO workspace_members(workspace_id, user_id, role, status, joined_at)
    VALUES (?, ?, 'member', 'active', ?)`).run(WORKSPACE, USER, now);
  const env = createTestEnv({ DB: sqliteD1(db), APP_ENV: 'development', RALLY_DEV_AUTH: 'true',
    AVALON_REGION: 'global', TURBO_PUFFER_DEV_API_KEY: 'test-only', AUTHORIZATION_CACHE: cache });
  const app = new Hono<HonoAppEnv>();
  app.use('*', requireAuth);
  app.route('/search', searchRoutes);
  app.onError(errorHandler);
  const request = (body: unknown, authenticated = true) => app.request('/search', { method: 'POST',
    headers: { 'content-type': 'application/json', ...(authenticated
      ? { 'x-rally-dev-user-id': USER, 'x-rally-dev-workspace-id': WORKSPACE } : {}) },
    body: JSON.stringify(body) }, env);
  return { db, request };
}

describe('member search route', () => {
  it('accepts a valid member query and rejects malformed or unauthenticated requests', async () => {
    const { request } = fixture();
    // Only the external search provider is doubled; authentication uses real migrations.
    providerQuery.mockResolvedValue({ rows: [] });
    const response = await request({ query: 'needle', category: 'messages' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [] });
    expect((await request({ query: 'needle', category: 'invalid' })).status).toBe(400);
    expect((await request({ query: 'needle', category: 'messages' }, false)).status).toBe(401);
    expect(providerQuery).toHaveBeenCalledTimes(1);
  });

  it('validates pagination and returns timed resource pages at the HTTP boundary', async () => {
    const { request } = fixture();
    providerQuery.mockResolvedValue({ rows: [] });
    const response = await request({ query: 'needle', category: 'files', pageSize: 7, cursor: 'authorized-id' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [], nextCursor: null, timings: {
      scopeMs: expect.any(Number), retrievalMs: expect.any(Number), hydrationMs: expect.any(Number), serverMs: expect.any(Number),
    } });
    expect((await request({ query: 'needle', category: 'files', pageSize: 51 })).status).toBe(400);
  });

  it('refuses a member revoked while the external search is in flight', async () => {
    const { db, request } = fixture();
    providerQuery.mockImplementation(async () => {
      db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(WORKSPACE, USER);
      return { rows: [] };
    });
    const response = await request({ query: 'needle', category: 'messages' });
    expect(response.status).toBe(401);
    expect(await response.json()).not.toHaveProperty('results');
  });
});

describe('index-served member search', () => {
  it('renders an admitted result from the index and omits what the projection has not decided', async () => {
    const room = '00000000-0000-7000-8000-000000000003';
    const undecided = '00000000-0000-7000-8000-000000000004';
    const subject = { workspaceId: asWorkspaceId(WORKSPACE), userId: asUserId(USER), delegation: null };
    const resource = { kind: 'conversation' as const, workspaceId: asWorkspaceId(WORKSPACE), parentId: room, substreamId: asSubstreamId('0') };
    const snapshots = new Map([[await searchAuthorizationKey(subject, resource), { version: 1, generation: 1, subject, resource,
      decision: { status: 'allowed', evidence: [{ owner: 'fixture', revision: '1', validatedAt: 1 }] }, observedAt: 1 }]]);
    const cache = { get: vi.fn(async (key: string) => snapshots.get(key) ?? null) } as unknown as KVNamespace;
    const { request } = fixture(cache);
    const display = { substream_id: '0', title: 'Planning', source_label: 'Planning', archived: false,
      occurred_at: Date.parse('2026-09-05T00:00:00Z'), transcript_sequence: 4, url: null, mime_type: null };
    providerQuery.mockResolvedValue({ rows: [
      { id: 'admitted', source: 'messages', scope_id: room, source_id: '0/turn-1', revision: 3, text: 'the needle sits here', ...display },
      { id: 'archived', source: 'messages', scope_id: room, source_id: '0/turn-2', revision: 1, text: 'needle', ...display, archived: true },
      // Indexed before the display attributes existed.
      { id: 'legacy', source: 'messages', scope_id: room, source_id: '0/turn-3', revision: 1, text: 'needle' },
      { id: 'undecided', source: 'messages', scope_id: undecided, source_id: '0/turn-4', revision: 1, text: 'needle', ...display },
    ] });
    const response = await request({ query: 'needle', category: 'messages', pageSize: 7, supportsPartialResults: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ complete: false, nextCursor: null, results: [{
      id: 'admitted', category: 'messages', title: 'Planning', sourceLabel: 'Planning', occurredAt: '2026-09-05T00:00:00.000Z',
      revision: '3', excerpt: 'the needle sits here', excerptStart: 0, highlights: [{ start: 4, end: 10 }],
      location: { kind: 'message', workstreamId: room, substreamId: '0', turnId: 'turn-1', transcriptSequence: 4, range: { start: 4, end: 10 } },
    }] });
    expect(cache.get).toHaveBeenCalled();
    // Older clients cannot label a partial list and keep their retryable failure.
    expect((await request({ query: 'needle', category: 'messages', pageSize: 7 })).status).toBe(503);
  });
});
