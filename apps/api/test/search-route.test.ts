import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { HonoAppEnv } from '../src/env';
import { requireAuth } from '../src/middleware/auth';
import { errorHandler } from '../src/middleware/errors';
import { searchRoutes } from '../src/routes/search';
import { searchAudienceGroup, searchAudienceGroupIds } from '../src/services/search-audience';
import type { Env } from '../src/env';
import { createCloudflareTestBinding, createTestDurableObjectId, createTestEnv } from './helpers/cloudflare-test';
import { migratedSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';

const providerQuery = vi.hoisted(() => vi.fn());
vi.mock('@turbopuffer/turbopuffer', () => ({ Turbopuffer: class {
  namespace() { return { query: providerQuery }; }
} }));

const USER = '00000000-0000-7000-8000-000000000001';
const WORKSPACE = '00000000-0000-7000-8000-000000000002';
const opened: DatabaseSync[] = [];
afterEach(() => { providerQuery.mockReset(); for (const db of opened.splice(0)) db.close(); });
/**
 * The WorkspaceDO answers with the searcher's audience groups, which is all the
 * route reads from it; the person side itself is proven in
 * test-workers/search-audience-person.test.ts.
 */
function workspaceDurableObjects(readSearchAudience: () => Promise<string[]>): Env['WORKSPACE_DOS'] {
  const binding: Env['WORKSPACE_DOS'] = createCloudflareTestBinding<Env['WORKSPACE_DOS']>({
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: () => ({ readSearchAudience }),
    jurisdiction: (): Env['WORKSPACE_DOS'] => binding,
  });
  return binding;
}
/** Turbopuffer applies the query's audience clause; the double does too. */
function audienceClause(filter: unknown): string[] | null {
  if (!Array.isArray(filter)) return null;
  if (filter[0] === 'audience' && filter[1] === 'ContainsAny') return filter[2] as string[];
  for (const part of filter) { const found = audienceClause(part); if (found) return found; }
  return null;
}
function fixture(readSearchAudience: () => Promise<string[]> = async () => searchAudienceGroupIds([searchAudienceGroup.user(USER)])) {
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
    AVALON_REGION: 'global', TURBO_PUFFER_DEV_API_KEY: 'test-only', WORKSPACE_DOS: workspaceDurableObjects(readSearchAudience) });
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

  it('fails closed when the searcher\'s groups cannot be read', async () => {
    const { request } = fixture(async () => { throw new Error('workspace_unavailable'); });
    providerQuery.mockResolvedValue({ rows: [{ id: 'row' }] });
    const response = await request({ query: 'needle', category: 'all' });
    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty('results');
    expect(providerQuery).not.toHaveBeenCalled();
  });
});

describe('index-served member search', () => {
  it('renders results from the index and returns only what the searcher\'s groups reach, without saying so', async () => {
    const room = '00000000-0000-7000-8000-000000000003';
    const unread = '00000000-0000-7000-8000-000000000004';
    const connection = '00000000-0000-7000-8000-000000000005';
    const [roomGroup, unreadGroup, connectionGroup, uploaderGroup] = await searchAudienceGroupIds([
      searchAudienceGroup.conversation(room, '0'), searchAudienceGroup.conversation(unread, '0'),
      searchAudienceGroup.connection(connection), searchAudienceGroup.user('00000000-0000-7000-8000-000000000009')]);
    const { request } = fixture(async () => [roomGroup!, connectionGroup!]);
    const display = { substream_id: '0', title: 'Planning', source_label: 'Planning', archived: false,
      occurred_at: Date.parse('2026-09-05T00:00:00Z'), transcript_sequence: 4, url: null, mime_type: null };
    const file = { title: 'Brief', source_label: 'Brief', archived: false, occurred_at: null, transcript_sequence: null, url: null, mime_type: 'text/plain' };
    const rows = [
      { id: 'admitted', source: 'messages', scope_id: room, source_id: '0/turn-1', revision: 3, text: 'the needle sits here', ...display, audience: [roomGroup] },
      { id: 'archived', source: 'messages', scope_id: room, source_id: '0/turn-2', revision: 1, text: 'needle', ...display, archived: true, audience: [roomGroup] },
      // Indexed before the display attributes existed.
      { id: 'legacy', source: 'messages', scope_id: room, source_id: '0/turn-3', revision: 1, text: 'needle', audience: [roomGroup] },
      { id: 'unread', source: 'messages', scope_id: unread, source_id: '0/turn-4', revision: 1, text: 'needle', ...display, audience: [unreadGroup] },
      // A connector's rows carry their connection's group; an upload carries its uploader's and its locations'.
      { id: 'synced', source: 'files', scope_id: WORKSPACE, source_id: '00000000-0000-7000-8000-000000000006', connection_id: connection, revision: 1, text: 'needle in a synced file', ...file, audience: [connectionGroup] },
      { id: 'attached', source: 'files', scope_id: WORKSPACE, source_id: '00000000-0000-7000-8000-000000000007', revision: 1, text: 'needle in an upload', ...file, audience: [uploaderGroup] },
      // Written before `audience` existed.
      { id: 'unplaced', source: 'files', scope_id: WORKSPACE, source_id: '00000000-0000-7000-8000-000000000008', revision: 1, text: 'needle nowhere', ...file },
    ];
    providerQuery.mockImplementation(async (query: { filters: unknown }) => {
      const groups = audienceClause(query.filters) ?? [];
      return { rows: rows.filter((row) => row.audience?.some((group) => groups.includes(group!))) };
    });
    const response = await request({ query: 'needle', category: 'all', pageSize: 7 });
    expect(response.status).toBe(200);
    const body = await response.json() as { results: Array<{ id: string }> };
    expect(body).not.toHaveProperty('complete');
    expect(body).toMatchObject({ nextCursor: null, results: [{
      id: 'admitted', category: 'messages', title: 'Planning', sourceLabel: 'Planning', occurredAt: '2026-09-05T00:00:00.000Z',
      revision: '3', excerpt: 'the needle sits here', excerptStart: 0, highlights: [{ start: 4, end: 10 }],
      location: { kind: 'message', parentKind: 'canvas', workstreamId: room, substreamId: '0', turnId: 'turn-1', transcriptSequence: 4, range: { start: 4, end: 10 } },
    }, { id: 'synced', category: 'files', title: 'Brief', location: { kind: 'resource', resourceId: '00000000-0000-7000-8000-000000000006', mimeType: 'text/plain' } }] });
    expect(body.results.map((row) => row.id)).toEqual(['admitted', 'synced']);
    // The field older clients sent is still accepted, and still changes nothing.
    expect((await request({ query: 'needle', category: 'messages', pageSize: 7, supportsPartialResults: true })).status).toBe(200);
  });

  it('names a hit in a Sidekick\'s run as the Sidekick\'s, so it opens that conversation and not a missing Canvas', async () => {
    const sidekick = '00000000-0000-7000-8000-00000000000a';
    const run = '00000000-0000-7000-8000-00000000000b';
    const [sidekickGroup] = await searchAudienceGroupIds([searchAudienceGroup.sidekick(sidekick)]);
    const { request } = fixture(async () => [sidekickGroup!]);
    providerQuery.mockResolvedValue({ rows: [{ id: 'run-turn', source: 'messages', scope_id: sidekick, source_id: `${run}/turn-9`,
      substream_id: run, revision: 1, text: 'the needle in a run', title: 'Triage', source_label: 'Triage', archived: false,
      occurred_at: Date.parse('2026-11-09T00:00:00Z'), transcript_sequence: 2, url: null, mime_type: null, audience: [sidekickGroup] }] });
    const response = await request({ query: 'needle', category: 'messages', pageSize: 7 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ results: [{ id: 'run-turn', location: {
      kind: 'message', parentKind: 'automation', workstreamId: sidekick, substreamId: run, turnId: 'turn-9', transcriptSequence: 2,
    } }] });
  });
});
