/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, expect, it } from 'vitest';
import { asUserId, asWorkspaceId } from '@rally/contracts';
import type { Env, HonoAppEnv } from '../src/env';
import { workspaceDOName } from '../src/durable-objects/names';
import { errorHandler } from '../src/middleware/errors';
import { requireIdentityAuth } from '../src/middleware/auth';
import { resourceRoutes } from '../src/routes/resources';
import { issueAccessToken } from '../src/services/auth-service';
import { countingEnv } from './helpers/counting-namespace';
import { seedWorkspaceControlPlane } from './helpers/substream-fixture';

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
