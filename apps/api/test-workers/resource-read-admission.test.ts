/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, expect, it } from 'vitest';
import { asSubstreamId, asUserId, asWorkspaceId } from '@rally/contracts';
import type { Env, HonoAppEnv } from '../src/env';
import { conversationObjectName, workspaceDOName } from '../src/durable-objects/names';
import { errorHandler } from '../src/middleware/errors';
import { requireIdentityAuth } from '../src/middleware/auth';
import { resourceRoutes } from '../src/routes/resources';
import { issueAccessToken } from '../src/services/auth-service';
import { countingEnv } from './helpers/counting-namespace';
import { boot, seedWorkspaceControlPlane, seedWorkstreamRoot } from './helpers/substream-fixture';
import { insertChannelRow, withHostedParent } from './helpers/hosted-parent';

const workspaceId = asWorkspaceId('00000000-0000-7000-8000-00000000f401');
const userId = asUserId('00000000-0000-7000-8000-00000000f402');
const resourceId = '00000000-0000-7000-8000-00000000f403';
const artifactId = '00000000-0000-7000-8000-00000000f404';
const parentId = '00000000-0000-7000-8000-00000000f405';
const auth = { workspaceId, userId, sessionId: 'resource-read-session', region: 'global' as const, role: 'member' as const };
const workspace = () => env.WORKSPACE_DOS.getByName(workspaceDOName('global', workspaceId));
const app = new Hono<HonoAppEnv>().onError(errorHandler).use('*', requireIdentityAuth).route('/resources', resourceRoutes);

beforeEach(async () => {
  await reset();
  await seedWorkspaceControlPlane(env.DB, { workspaceId, userId, sessionId: auth.sessionId });
  await env.DB.batch([
    env.DB.prepare('ALTER TABLE users ADD COLUMN analytics_person_id TEXT'),
    env.DB.prepare("ALTER TABLE workspaces ADD COLUMN placement_affinity TEXT DEFAULT 'wnam'"),
  ]);
  await workspace().initializeWorkspace(workspaceId, 'wnam');
  await env.PAYLOADS.put('read-admission/image', 'PNG fixture bytes', { httpMetadata: { contentType: 'image/png' } });
  await runInDurableObject(workspace(), (_instance, state) => {
    const at = new Date().toISOString();
    state.storage.sql.exec(`INSERT INTO resources
      (id, workspace_id, provider, resource_type, title, mime_type, content_ref, attachment_status,
       uploaded_by_user_id, metadata_json, created_at, updated_at)
      VALUES (?, ?, 'avalon_upload', 'uploaded_file', 'Image.png', 'image/png', 'read-admission/image',
        'attached', ?, '{}', ?, ?)`, resourceId, workspaceId, userId, at, at);
    state.storage.sql.exec(`INSERT INTO artifact_registry
      (artifact_id, workspace_id, workstream_id, resource_id, mode, stateful, current_version, manifest_ref,
       hostname_stub, created_at, updated_at) VALUES (?, ?, ?, ?, 'static', 0, 1, 'manifest',
       'level-luminous-sequential-schrodinger', 1, 1)`, artifactId, workspaceId, parentId, resourceId);
  });
});

async function headers() {
  return { authorization: `Bearer ${await issueAccessToken(env, auth)}` };
}

/** Observes real D1 statements without replacing their execution. */
function observe(calls: string[], statements: string[]): Env {
  const base = countingEnv(calls);
  const database = new Proxy(env.DB, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => { statements.push(sql); return target.prepare(sql); };
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return new Proxy(base, { get: (target, property) => property === 'DB' ? database : property === 'ARTIFACT_SERVING_DOMAIN' ? 'rallyusercontent.test' : Reflect.get(target, property) });
}

it('serves a cold image with one admission RPC and one session/membership query', async () => {
  const calls: string[] = [], statements: string[] = [];
  const response = await app.request(`/resources/${resourceId}/preview`, { headers: await headers() }, observe(calls, statements));
  expect(response.status).toBe(200);
  expect(new TextDecoder().decode(await response.arrayBuffer())).toBe('PNG fixture bytes');
  expect(calls).toEqual(['authorizationResourceFacts']);
  expect(statements.filter((sql) => /^SELECT/u.test(sql) && sql.includes('workspace_members'))).toHaveLength(1);
});

it('validates cached image bytes through one fresh admission and refuses the next revoked request', async () => {
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec('UPDATE resources SET content_sha256 = ? WHERE id = ?', 'a'.repeat(64), resourceId);
  });
  const requestHeaders = await headers();
  const endpoint = `/resources/${resourceId}/preview`;
  const first = await app.request(endpoint, { headers: requestHeaders }, observe([], []));
  expect(first.status).toBe(200);
  expect(new TextDecoder().decode(await first.arrayBuffer())).toBe('PNG fixture bytes');
  // The digest update above advances the revision through the real resource trigger.
  const validator = '"image-preview-v1:2:' + 'a'.repeat(64) + '"';
  expect(first.headers.get('etag')).toBe(validator);
  // A matching validator must not require the object that supplied the bytes.
  await env.PAYLOADS.delete('read-admission/image');
  const calls: string[] = [], statements: string[] = [];
  const conditionalHeaders = { ...requestHeaders, 'if-none-match': validator };
  const unchanged = await app.request(endpoint, { headers: conditionalHeaders }, observe(calls, statements));
  expect(unchanged.status).toBe(304);
  expect(await unchanged.text()).toBe('');
  expect(calls).toEqual(['authorizationResourceFacts']);
  expect(statements.filter((sql) => /^SELECT/u.test(sql) && sql.includes('workspace_members'))).toHaveLength(1);
  await env.DB.prepare("UPDATE sessions SET revoked_at = '2026-10-21T00:00:00Z' WHERE id = ?").bind(auth.sessionId).run();
  expect((await app.request(endpoint, { headers: conditionalHeaders }, observe([], []))).status).toBe(401);
});

it.each(['', '/content', '/versions', '/versions/1', '/versions/1/content', '/versions/1/preview'])(
  'admits attachment %s once and refuses a revoked session on the next request', async (suffix) => {
    const calls: string[] = [], statements: string[] = [];
    const requestHeaders = await headers();
    const endpoint = `/resources/${resourceId}${suffix}`;
    expect((await app.request(endpoint, { headers: requestHeaders }, observe(calls, statements))).status).toBe(200);
    expect(calls.filter((method) => method === 'authorizationResourceFacts')).toHaveLength(1);
    expect(calls).not.toContain('executeRuntimeSql');
    expect(statements.filter((sql) => /^SELECT/u.test(sql) && sql.includes('workspace_members'))).toHaveLength(1);
    await env.DB.prepare("UPDATE sessions SET revoked_at = '2026-10-21T00:00:00Z' WHERE id = ?").bind(auth.sessionId).run();
    expect((await app.request(endpoint, { headers: requestHeaders }, observe(calls, statements))).status).toBe(401);
    expect(calls.filter((method) => method === 'authorizationResourceFacts')).toHaveLength(1);
  },
);

it.each(['/artifact/open', '/artifact/errors', '/artifact/data', '/artifact/data/entries'])(
  'combines artifact registry and admission on %s and observes membership revocation', async (suffix) => {
    const calls: string[] = [], statements: string[] = [];
    const requestHeaders = await headers();
    const request = { headers: requestHeaders, method: suffix === '/artifact/open' ? 'POST' : 'GET' };
    const testEnv = observe(calls, statements);
    const endpoint = `/resources/${resourceId}${suffix}`;
    const response = await app.request(endpoint, request, testEnv);
    expect(response.status, response.status === 200 ? '' : await response.clone().text()).toBe(200);
    // POST navigation also schedules the existing background sync publication.
    expect(calls.filter((method) => method !== 'publishSync')).toEqual(['authorizationResourceFacts']);
    expect(statements.filter((sql) => /^SELECT/u.test(sql) && sql.includes('workspace_members'))).toHaveLength(1);
    expect(statements.filter((sql) => sql.includes('SELECT placement_affinity FROM workspaces'))).toHaveLength(1);
    await env.DB.prepare("UPDATE workspace_members SET status = 'suspended' WHERE user_id = ?").bind(userId).run();
    expect((await app.request(endpoint, request, testEnv)).status).toBe(401);
  },
);

const target = { kind: 'conversation' as const, workspaceId, parentId, substreamId: asSubstreamId('0') };

async function shareWithGuest() {
  await env.DB.prepare("UPDATE workspace_members SET access_class = 'guest', role = NULL WHERE user_id = ?").bind(userId).run();
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec('UPDATE resources SET uploaded_by_user_id = NULL WHERE id = ?', resourceId);
    state.storage.sql.exec(`INSERT INTO parent_metadata
      (parent_id, parent_kind, workspace_id, region, authority_generation, created_at, updated_at)
      VALUES (?, 'workstream', ?, 'global', 1, 0, 0)`, parentId, workspaceId);
    insertChannelRow(state, parentId, 'Private attachment conversation');
    state.storage.sql.exec("INSERT INTO parent_children(parent_id, substream_id, kind, created_at) VALUES (?, '0', 'main', 0)", parentId);
    state.storage.sql.exec(`INSERT INTO parent_participant_migrations(parent_id, substream_id, transfer_id, phase)
      VALUES (?, '0', ?, 'complete')`, parentId, crypto.randomUUID());
    // This fixture has enumerated its only conversation. A negative decision
    // must be complete rather than scheduling production's discovery backfill.
    state.storage.sql.exec(`INSERT INTO authorization_backfill(parent_id, parent_kind, completed)
      VALUES (?, 'workstream', 1)`, parentId);
    state.storage.sql.exec(`INSERT INTO authorization_backfill_children(parent_id, substream_id, completed)
      VALUES (?, '0', 1)`, parentId);
  });
  await withHostedParent(workspace(), parentId, (parent) => {
    parent['scopeGrants'](target).mutate({ operationId: crypto.randomUUID(), actorUserId: userId, userId,
      target, active: true, expectedRevision: 0 }, 'existing-member');
  });
  const main = env.SUBSTREAM_AGENTS.getByName(conversationObjectName('global', workspaceId, parentId));
  await boot(main);
  await runInDurableObject(main, (_instance, state) => {
    seedWorkstreamRoot(state, Date.now(), { workspaceId, workstreamId: parentId });
    state.storage.sql.exec(`INSERT INTO workstream_resource_links
      (resource_id, attached_by_user_id, watch_enabled, relationship_type, resource_json, attached_at, updated_at)
      VALUES (?, ?, 0, 'attachment', '{}', 1, 1)`, resourceId, userId);
  });
  await workspace().applyAuthorizationLocations({ workspaceId, parentId, substreamId: asSubstreamId('0'),
    parentKind: 'workstream', revision: 1, validatedAt: Date.now(), resourceIds: [resourceId] });
}

it.each(['/preview', '/artifact/open'])(
  'reuses the authenticated relationship for a shared resource %s even when revocation arrives during admission', async (suffix) => {
    await shareWithGuest();
    const admittedApp = new Hono<HonoAppEnv>().onError(errorHandler).use('*', requireIdentityAuth);
    admittedApp.use('*', async (_c, next) => {
      await env.DB.prepare("UPDATE workspace_members SET status = 'suspended' WHERE user_id = ?").bind(userId).run();
      await next();
    });
    admittedApp.route('/resources', resourceRoutes);
    const request = { headers: await headers(), method: suffix === '/artifact/open' ? 'POST' : 'GET' };
    const response = await admittedApp.request(`/resources/${resourceId}${suffix}`, request, observe([], []));
    expect(response.status, response.status === 200 ? '' : await response.clone().text()).toBe(200);
    expect((await app.request(`/resources/${resourceId}${suffix}`, request, observe([], []))).status).toBe(401);
  },
);

it.each(['/preview', '/artifact/open'])(
  'observes grant revocation on the next shared-resource %s request', async (suffix) => {
    await shareWithGuest();
    const request = { headers: await headers(), method: suffix === '/artifact/open' ? 'POST' : 'GET' };
    const endpoint = `/resources/${resourceId}${suffix}`;
    expect((await app.request(endpoint, request, observe([], []))).status).toBe(200);
    await withHostedParent(workspace(), parentId, (parent) => {
      const store = parent['scopeGrants'](target);
      const current = store.read(userId, target)!;
      store.mutate({ operationId: crypto.randomUUID(), actorUserId: userId, userId, target,
        active: false, expectedRevision: current.revision }, 'existing-member');
    });
    expect((await app.request(endpoint, request, observe([], []))).status).toBe(404);
  },
);

it('does not revive an old resource grant for a new membership incarnation', async () => {
  await shareWithGuest();
  await env.DB.batch([
    env.DB.prepare("UPDATE workspace_members SET incarnation = 'new-membership', revision = 2 WHERE user_id = ?").bind(userId),
    env.DB.prepare("UPDATE sessions SET workspace_incarnation = 'new-membership' WHERE id = ?").bind(auth.sessionId),
  ]);
  const response = await app.request(`/resources/${resourceId}/preview`, { headers: await headers() }, observe([], []));
  expect(response.status).toBe(404);
});
