import "../../../tests/isolated-region";
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { asUserId, asWorkspaceId } from '@rally/contracts';
import type { HonoAppEnv } from '../src/env';
import { onboardingRoutes } from '../src/routes/onboarding';
import { workspaceDOName } from '../src/durable-objects/names';

const userId = asUserId('00000000-0000-7000-8000-000000000901');
const peerId = asUserId('00000000-0000-7000-8000-000000000902');
const workspaceId = asWorkspaceId('00000000-0000-7000-8000-000000000903');
beforeEach(async () => { await reset(); });

it('streams committed profile changes to another member even when enterprise discovery fails', async () => {
  // This lane proves D1 -> route -> real WorkspaceDO -> another member's socket.
  // Its D1 starts empty; these are the identity/auth tables this flow reads.
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE workstream_authority_control (id INTEGER PRIMARY KEY, phase TEXT, generation INTEGER, required_serving_contract_version INTEGER, serving_contract_version INTEGER)`),
    env.DB.prepare(`INSERT INTO workstream_authority_control VALUES (1, 'durable_object_open', 1, 1, 1)`),
    env.DB.prepare(`CREATE TABLE users (id TEXT PRIMARY KEY, google_subject TEXT, email TEXT, name TEXT, avatar_url TEXT, timezone TEXT, created_at TEXT, updated_at TEXT, platform_user_id TEXT, onboarding_eligible INTEGER, onboarding_introduced INTEGER, onboarding_revision INTEGER, presentation_json TEXT)`),
    env.DB.prepare(`INSERT INTO users VALUES (?, 'subject', 'alex@example.com', 'Alex Morgan', NULL, 'UTC', '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z', ?, 0, 1, 0, NULL)`).bind(userId, userId),
    env.DB.prepare(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, region TEXT, placement_affinity TEXT, analytics_workspace_id TEXT, abandoned_at TEXT)`),
    env.DB.prepare(`INSERT INTO workspaces VALUES (?, 'global', 'wnam', NULL, NULL)`).bind(workspaceId),
    env.DB.prepare(`CREATE TABLE workspace_members (workspace_id TEXT, user_id TEXT, role TEXT, status TEXT, last_seen_at TEXT)`),
    env.DB.prepare(`INSERT INTO workspace_members VALUES (?, ?, 'owner', 'active', NULL), (?, ?, 'member', 'active', NULL)`).bind(workspaceId, userId, workspaceId, peerId),
    env.DB.prepare(`INSERT INTO workspaces VALUES ('abandoned', 'global', 'invalid', NULL, '2026-09-08'), ('foreign', 'enterprise', 'invalid', NULL, NULL)`),
    env.DB.prepare(`INSERT INTO workspace_members VALUES ('abandoned', ?, 'owner', 'active', NULL), ('foreign', ?, 'owner', 'active', NULL)`).bind(userId, userId),
    env.DB.prepare(`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, workspace_id TEXT, region TEXT, revoked_at TEXT, expires_at TEXT)`),
    env.DB.prepare(`INSERT INTO sessions VALUES ('peer-session', ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`).bind(peerId, workspaceId),
  ]);
  const stub = env.WORKSPACE_DOS.getByName(workspaceDOName('global', workspaceId));
  await stub.initializeWorkspace(workspaceId, 'wnam');
  const response = await stub.fetch('https://workspace.test/socket', { headers: {
    Upgrade: 'websocket', 'x-rally-workspace-id': workspaceId, 'x-rally-placement-affinity': 'wnam',
    'x-rally-user-id': peerId, 'x-rally-session-id': 'peer-session',
    'x-rally-socket-ticket-id': '00000000-0000-7000-8000-000000000904',
    'x-rally-socket-ticket-expires-at': String(Math.floor(Date.now() / 1000) + 60),
  } });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const messages: Record<string, unknown>[] = [];
  socket.addEventListener('message', (event) => { messages.push(JSON.parse(String(event.data))); });
  const initial = new Promise<void>((resolve) => socket.addEventListener('message', () => resolve(), { once: true }));
  socket.send(JSON.stringify({ type: 'subscribe', afterWaterline: 0 }));
  await initial;
  messages.length = 0;
  const tasks: Promise<unknown>[] = [];
  const failures: unknown[] = [];
  let enterpriseRequested = false;
  const app = new Hono<HonoAppEnv>();
  app.use('*', async (c, next) => { c.set('auth', { sessionId: 'identity', userId, workspaceId: null, region: 'global', role: null }); await next(); });
  app.route('/', onboardingRoutes);
  try {
    const result = await app.request('/account', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 0, presentation: { displayName: 'Alex Rivera', initials: 'AR', color: 'violet', avatar: 'circle' } }),
    }, { ...env, REGION_ENTERPRISE_IDENTITY_BRIDGE: { discover: async () => { enterpriseRequested = true; throw new Error('enterprise unavailable'); } } }, {
      waitUntil: (task) => { tasks.push(task.catch((error: unknown) => { failures.push(error); })); },
      passThroughOnException: () => {}, props: {},
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ revision: 1, presentation: { displayName: 'Alex Rivera', initials: 'AR', color: 'violet' } });
    await Promise.all(tasks);
    expect(failures).toHaveLength(1);
    expect(enterpriseRequested).toBe(true);
    // The queue may deliver the WS frame just after publishSync resolves.
    await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({ type: 'workspace_sync', topics: ['workspace_profile', 'member_directory'] })), { timeout: 5_000 });
    const row = await env.DB.prepare('SELECT name, presentation_json FROM users WHERE id = ?').bind(userId).first<{ name: string; presentation_json: string }>();
    expect(row?.name).toBe('Alex Rivera');
    expect(JSON.parse(row!.presentation_json)).toMatchObject({ initials: 'AR', color: 'violet' });
  } finally { socket.close(1000, 'test complete'); }
});
