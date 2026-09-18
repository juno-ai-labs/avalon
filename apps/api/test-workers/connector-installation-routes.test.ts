import "../../../tests/isolated-region";
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, reset, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AshbyEventTypes, asUserId, asWorkspaceId, ConnectionSchema, ConnectorInstallationSchema, type ConnectorInstallation } from '@rally/contracts';
import { createApp } from '../src/app';
import AshbyIngressWorker from '../src/ashby-ingress-worker';
import { AshbyRoutingBridge } from '../src/ashby-routing-bridge';
import { AshbyRegionalBridge } from '../src/ashby-regional-bridge';
import type { AuthContext, Env } from '../src/env';
import { workspaceDOName } from '../src/durable-objects/names';
import type { WorkspaceDO } from '../src/durable-objects/workspace-do';
import { WorkspaceConnectorEventQueueMessageSchema } from '../src/durable-objects/workspace-connector-event-protocol';
import { decryptString } from '../src/lib/crypto';
import { consumeActivityQueue } from '../src/queues/activity-consumer';
import { ConnectorInstallationQueueSchema } from '../src/services/connector-installation-service';
import { seedWorkspaceControlPlane } from './helpers/substream-fixture';

const envelopeKey = 'installation-route-fixture-envelope-key';
const sessionKey = 'installation-route-fixture-session-key';
const events = ['applicationSubmit', 'candidateStageChange'] as const;
const SetupResponse = z.object({ installation: ConnectorInstallationSchema, connection: ConnectionSchema });
const InstallationResponse = z.object({ installation: ConnectorInstallationSchema });
const ApiFailure = z.object({ error: z.object({ code: z.string() }) });
const unexpectedProviderCalls: string[] = [];
type GranolaProvider = (url: URL, init?: RequestInit) => Promise<Response>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

beforeEach(async () => { await reset(); unexpectedProviderCalls.length = 0; });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(unexpectedProviderCalls).toEqual([]);
});

async function fixture() {
  const workspaceId = asWorkspaceId(crypto.randomUUID());
  const ownerId = asUserId(crypto.randomUUID());
  const sessionId = crypto.randomUUID();
  await seedWorkspaceControlPlane(env.DB, { workspaceId, userId: ownerId, sessionId });
  await env.DB.batch([
    env.DB.prepare('ALTER TABLE users ADD COLUMN analytics_person_id TEXT'),
    env.DB.prepare("UPDATE workspace_members SET role = 'owner' WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, ownerId),
    env.DB.prepare(`CREATE TABLE connector_ingress_routes (
      connection_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, region TEXT NOT NULL,
      connector_type TEXT NOT NULL, scope TEXT NOT NULL, provider_account_id TEXT,
      provider_user_id TEXT, status TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE ashby_connection_routes (
      connection_id TEXT PRIMARY KEY, region TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
  ]);
  const testEnv = { ...env, SESSION_SIGNING_KEY: sessionKey, CONNECTOR_CREDENTIALS_KEY: envelopeKey,
    CONNECTOR_CREDENTIALS_KEY_VERSION: '1' } satisfies Env;
  const stub = env.WORKSPACE_DOS.getByName(workspaceDOName('global', workspaceId));
  await runInDurableObject(stub, (_instance: WorkspaceDO, state) => {
    state.storage.sql.exec(`INSERT INTO workspace_identity
      (id, workspace_id, region, placement_affinity, created_at, updated_at)
      VALUES (1, ?, 'global', 'wnam', ?, ?)`, workspaceId, Date.now(), Date.now());
  });
  const owner: AuthContext = { workspaceId, userId: ownerId, sessionId, role: 'owner', region: 'global' };
  async function member(role: 'admin' | 'member', otherWorkspace = false): Promise<AuthContext> {
    const userId = asUserId(crypto.randomUUID());
    const memberWorkspace = otherWorkspace ? asWorkspaceId(crypto.randomUUID()) : workspaceId;
    const memberSession = crypto.randomUUID();
    if (otherWorkspace) {
      await env.DB.prepare("INSERT INTO workspaces(id, region) VALUES (?, 'global')").bind(memberWorkspace).run();
      const other = env.WORKSPACE_DOS.getByName(workspaceDOName('global', memberWorkspace));
      await runInDurableObject(other, (_instance: WorkspaceDO, state) => {
        state.storage.sql.exec(`INSERT INTO workspace_identity
          (id, workspace_id, region, placement_affinity, created_at, updated_at)
          VALUES (1, ?, 'global', 'wnam', ?, ?)`, memberWorkspace, Date.now(), Date.now());
      });
    }
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users(id, name) VALUES (?, 'Installation reviewer')").bind(userId),
      env.DB.prepare("INSERT INTO workspace_members(workspace_id, user_id, status, role) VALUES (?, ?, 'active', ?)").bind(memberWorkspace, userId, role),
      env.DB.prepare("INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at) VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')").bind(memberSession, userId, memberWorkspace),
    ]);
    return { userId, workspaceId: memberWorkspace, sessionId: memberSession, role, region: 'global' };
  }
  const app = createApp();
  async function request(path: string, auth: AuthContext | null, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    const token = auth ? await new SignJWT({ sid: auth.sessionId, wid: auth.workspaceId, region: auth.region })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setSubject(auth.userId)
      .setIssuer('avalon-api').setAudience('avalon-desktop').setExpirationTime(new Date('2099-01-01T00:00:00Z'))
      .sign(new TextEncoder().encode(sessionKey)) : null;
    const ctx = createExecutionContext();
    const response = await app.request(path, { method, headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, testEnv, ctx);
    const value: unknown = await response.json();
    await waitOnExecutionContext(ctx);
    return { status: response.status, body: value };
  }
  const queue = vi.spyOn(env.ACTIVITY_QUEUE, 'send');
  const remote = new Map<string, { id: string; requestUrl: string; webhookType: string; enabled: boolean }>();
  let validate: (apiKey: string) => Promise<Response> = async () => Response.json({ success: true, results: {} });
  let granola: GranolaProvider | null = null;
  let refusedEvent: string | null = null;
  const provider = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin === 'https://public-api.granola.ai' && granola) return granola(url, init);
    if (url.origin !== 'https://api.ashbyhq.com') {
      unexpectedProviderCalls.push(url.origin); throw new Error('Unexpected provider');
    }
    const authorization = new Headers(init?.headers).get('authorization') ?? '';
    const apiKey = atob(authorization.replace(/^Basic /u, '')).replace(/:$/u, '');
    if (url.pathname === '/apiKey.info') return validate(apiKey);
    const body: unknown = JSON.parse(String(init?.body));
    if (url.pathname === '/webhook.create') {
      const create = z.object({ requestUrl: z.string(), webhookType: z.enum(AshbyEventTypes), secretToken: z.string().min(1) }).parse(body);
      if (create.webhookType === refusedEvent) return Response.json({ success: false });
      const row = { id: crypto.randomUUID(), requestUrl: create.requestUrl, webhookType: create.webhookType, enabled: true };
      remote.set(row.id, row);
      return Response.json({ success: true, results: row });
    }
    const { webhookId } = z.object({ webhookId: z.string() }).parse(body);
    const row = remote.get(webhookId);
    if (url.pathname === '/webhook.info' && row) return Response.json({ success: true, results: row });
    if (url.pathname === '/webhook.delete' && row) {
      remote.delete(webhookId); return Response.json({ success: true, results: { webhookId } });
    }
    unexpectedProviderCalls.push(url.pathname); throw new Error('Unexpected provider operation');
  });
  vi.stubGlobal('fetch', provider);

  async function create(auth = owner) {
    const result = await request('/connections/ashby/workspace', auth, {
      apiKey: 'original-api-key', idempotencyKey: crypto.randomUUID(), events: [...events],
    });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    return SetupResponse.parse(result.body).installation;
  }
  async function consume(kind: 'installation' | 'event') {
    const bodies = queue.mock.calls.flatMap(([body]) => {
      const parsed = kind === 'installation' ? ConnectorInstallationQueueSchema.safeParse(body) : WorkspaceConnectorEventQueueMessageSchema.safeParse(body);
      return parsed.success ? [parsed.data] : [];
    });
    expect(bodies.length).toBeGreaterThan(0);
    const batch = createMessageBatch('avalon-do-runtime-test-activity', bodies.map((body) => ({ id: crypto.randomUUID(), body, timestamp: new Date(), attempts: 1 })));
    await consumeActivityQueue(batch, testEnv);
    expect((await getQueueResult(batch, createExecutionContext())).retryMessages).toEqual([]);
    queue.mockClear();
  }
  async function readEnvelope(connectionId: string) {
    const row = await runInDurableObject(stub, (_instance: WorkspaceDO, state) => state.storage.sql.exec<{
      encrypted_credentials: string | null; credential_iv: string | null; status: string;
    }>('SELECT encrypted_credentials, credential_iv, status FROM connector_connections WHERE id = ?', connectionId).one());
    const credentials = row.encrypted_credentials && row.credential_iv
      ? z.record(z.string(), z.unknown()).parse(JSON.parse(await decryptString(row.encrypted_credentials, row.credential_iv, envelopeKey, connectionId))) : null;
    return { ...row, credentials };
  }
  async function deliver(installation: ConnectorInstallation, eventType: typeof AshbyEventTypes[number], secret: string, delivery?: { id: string; data: unknown }) {
    const bytes = new TextEncoder().encode(JSON.stringify({ action: eventType, webhookActionId: delivery?.id ?? crypto.randomUUID(),
      data: delivery?.data ?? { application: { id: `application-${eventType}`, candidate: { id: 'candidate-id' }, job: { id: 'job-id' } } } }));
    const signingKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const digest = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', signingKey, bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const ctx = createExecutionContext();
    const response = await app.request(`/ingest/ashby/${installation.connectionId}`, { method: 'POST', body: bytes,
      headers: { 'Ashby-Signature': `sha256=${digest}` } }, testEnv, ctx);
    const body: unknown = await response.json();
    await waitOnExecutionContext(ctx);
    return { status: response.status, body };
  }
  return { workspaceId, stub, owner, member, request, queue, provider, create, consume, readEnvelope, deliver, testEnv,
    refuseEvent: (eventType: string) => { refusedEvent = eventType; },
    setGranola: (handler: GranolaProvider) => { granola = handler; },
    setValidation: (handler: typeof validate) => { validate = handler; } };
}

describe('public connector installation boundaries', () => {
  it('reserves every documented event once under concurrent automatic setup and admits signed notifications through the Queue', async () => {
    const f = await fixture();
    const admin = await f.member('admin');
    const results = await Promise.all([f.owner, admin].map((auth) => f.request('/connections/ashby/workspace', auth,
      { apiKey: 'original-api-key', idempotencyKey: crypto.randomUUID() })));
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    const installed = SetupResponse.parse(results.find((result) => result.status === 201)!.body).installation;
    expect(installed.registrations).toHaveLength(27);
    expect(installed.selectedEvents).toEqual([...AshbyEventTypes].sort());
    await f.consume('installation');
    const current = (await f.stub.connectorInstallation({ workspaceId: f.workspaceId, connectionId: installed.connectionId }))!;
    expect(current.state).toBe('current');
    const creates = f.provider.mock.calls.filter(([url]) => String(url).endsWith('/webhook.create'));
    expect(creates).toHaveLength(27);
    expect(new Set(creates.map(([, init]) => JSON.parse(String(init?.body)).webhookType)).size).toBe(27);
    const saved = (await f.readEnvelope(installed.connectionId)).credentials!;
    for (const eventType of AshbyEventTypes) {
      const registration = current.registrations.find((entry) => entry.events.includes(eventType))!;
      const result = await f.deliver(current, eventType, z.string().parse(saved[registration.activeSecretRef!]),
        { id: crypto.randomUUID(), data: eventType === 'candidateRecentEmailMessagesUpdated'
          ? { candidate: { id: 'candidate-id' }, watermark: 'opaque-first-watermark' } : {} });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
    }
    await f.consume('event');
    await runInDurableObject(f.stub, (_instance: WorkspaceDO, state) => {
      const rows = state.storage.sql.exec<{ event_type: string }>('SELECT event_type FROM workspace_connector_events ORDER BY event_type').toArray();
      expect(rows.map((row) => row.event_type)).toEqual([...AshbyEventTypes].sort());
    });
  });

  it('deduplicates a renewed email watermark while preserving raw deliveries and rejecting a changed candidate identity', async () => {
    const f = await fixture();
    const eventType = 'candidateRecentEmailMessagesUpdated';
    const setup = await f.request('/connections/ashby/workspace', f.owner,
      { apiKey: 'original-api-key', idempotencyKey: crypto.randomUUID(), events: [eventType] });
    const installed = SetupResponse.parse(setup.body).installation;
    await f.consume('installation');
    const secret = z.string().parse((await f.readEnvelope(installed.connectionId)).credentials![installed.registrations[0]!.activeSecretRef!]);
    const id = crypto.randomUUID();
    for (const watermark of ['opaque-first-watermark', 'opaque-renewed-watermark']) {
      expect((await f.deliver(installed, eventType, secret, { id, data: { candidate: { id: 'candidate-id' }, watermark } })).status).toBe(200);
      await f.consume('event');
    }
    expect((await env.PAYLOADS.list({ prefix: `global/${f.workspaceId}/` })).objects).toHaveLength(2);
    await runInDurableObject(f.stub, (_instance: WorkspaceDO, state) => {
      expect(state.storage.sql.exec('SELECT ingress_event_id FROM workspace_connector_event_ingress_receipts').toArray()).toHaveLength(2);
    });
    await runInDurableObject(f.stub, (_instance: WorkspaceDO, state) => {
      expect(state.storage.sql.exec('SELECT provider_resource_id FROM workspace_connector_events').toArray()).toEqual([{ provider_resource_id: 'candidate-id' }]);
    });
    expect((await f.deliver(installed, eventType, secret, { id, data: { candidate: { id: 'different-candidate' }, watermark: 'opaque-third-watermark' } })).status).toBe(200);
    await f.consume('event');
    await runInDurableObject(f.stub, (_instance: WorkspaceDO, state) => {
      expect(state.storage.sql.exec('SELECT ingress_event_id FROM workspace_connector_event_ingress_receipts').toArray()).toHaveLength(2);
    });
  });

  it('keeps other subscriptions working when the provider rejects the beta subscription without blindly retrying it', async () => {
    const f = await fixture();
    const beta = 'candidateRecentEmailMessagesUpdated';
    f.refuseEvent(beta);
    const setup = await f.request('/connections/ashby/workspace', f.owner, { apiKey: 'original-api-key', idempotencyKey: crypto.randomUUID() });
    const installed = SetupResponse.parse(setup.body).installation;
    await f.consume('installation');
    const current = (await f.stub.connectorInstallation({ workspaceId: f.workspaceId, connectionId: installed.connectionId }))!;
    expect(current.state).toBe('action_required');
    expect(current.registrations.filter((entry) => entry.state === 'current')).toHaveLength(26);
    expect(current.registrations.find((entry) => entry.events.includes(beta))?.state).toBe('unknown');
    const registration = current.registrations.find((entry) => entry.events.includes('jobCreate'))!;
    const secret = z.string().parse((await f.readEnvelope(installed.connectionId)).credentials![registration.activeSecretRef!]);
    expect((await f.deliver(installed, 'jobCreate', secret)).status).toBe(200);
    await f.consume('event');
    const repair = await f.request(`/connections/${installed.connectionId}/installation`, f.owner, { action: 'repair' });
    expect(repair.status).toBe(200);
    await f.consume('installation');
    expect(f.provider.mock.calls.filter(([url, init]) => String(url).endsWith('/webhook.create') && JSON.parse(String(init?.body)).webhookType === beta)).toHaveLength(1);
  });

  it('rejects an oversized streamed body before dedicated ingress routing or regional provider admission', async () => {
    const f = await fixture();
    const router = new AshbyRoutingBridge(createExecutionContext(), f.testEnv);
    const regional = new AshbyRegionalBridge(createExecutionContext(), f.testEnv);
    const lookup = vi.spyOn(router, 'lookupRoute');
    const admission = vi.spyOn(regional, 'ingest');
    const worker = new AshbyIngressWorker(createExecutionContext(), { PROVIDER_WEBHOOK_MAX_BYTES: '32',
      GLOBAL_ASHBY_ROUTER: router, GLOBAL_ASHBY_BRIDGE: regional, ENTERPRISE_ASHBY_BRIDGE: regional });
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(16)); controller.enqueue(new Uint8Array(17)); controller.close();
    } });
    const response = await worker.fetch(new Request(`https://ashby.rallywith.ai/ingest/ashby/${crypto.randomUUID()}`, { method: 'POST', body }));
    expect(response.status).toBe(413);
    await response.json();
    expect(lookup).not.toHaveBeenCalled();
    expect(admission).not.toHaveBeenCalled();
    expect(f.queue).not.toHaveBeenCalled();
    expect(f.provider).not.toHaveBeenCalled();
  });

  it('accepts the released Granola workspace request without an idempotency key', async () => {
    const f = await fixture();
    const result = await f.request('/connections/granola/workspace', f.owner, {
      apiKey: `grn_${'a'.repeat(32)}`, capabilities: ['granola.workspace.read'],
    });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    const { connection } = z.object({ connection: ConnectionSchema }).parse(result.body);
    const installation = await f.stub.connectorInstallation({ workspaceId: f.workspaceId, connectionId: connection.id });
    expect(installation).toMatchObject({ provider: 'granola', state: 'setting_up', selectedEvents: [
      'note.access_granted', 'note.edited', 'note.generated',
    ] });
    expect(f.provider).not.toHaveBeenCalled();
  });

  it('records setup once across retries and keeps provider credentials out of installation audits', async () => {
    const f = await fixture();
    const body = { apiKey: 'original-api-key', idempotencyKey: crypto.randomUUID(), events: [...events] };
    const first = await f.request('/connections/ashby/workspace', f.owner, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const installed = SetupResponse.parse(first.body).installation;
    const retry = await f.request('/connections/ashby/workspace', f.owner, body);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    expect(SetupResponse.parse(retry.body).installation.connectionId).toBe(installed.connectionId);
    const replaced = await f.request(`/connections/${installed.connectionId}/installation/api-key`, f.owner, { apiKey: 'replacement-api-key' });
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    const repaired = await f.request(`/connections/${installed.connectionId}/installation`, f.owner, { action: 'repair' });
    expect(repaired.status, JSON.stringify(repaired.body)).toBe(200);
    const rows = (await env.AUDIT_DB.prepare('SELECT action, actor_user_id, target_id, metadata_json FROM audit_events ORDER BY action').all<{
      action: string; actor_user_id: string; target_id: string; metadata_json: string;
    }>()).results;
    expect(rows.map((row) => row.action)).toEqual(['connector.authorized', 'connector.credentials.replaced', 'connector.installation.repair']);
    expect(rows.every((row) => row.actor_user_id === f.owner.userId && row.target_id === installed.connectionId)).toBe(true);
    const credentials = (await f.readEnvelope(installed.connectionId)).credentials!;
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(body.apiKey);
    for (const secret of Object.values(credentials)) if (typeof secret === 'string') expect(serialized).not.toContain(secret);
  });

  it.each(['owner', 'admin'] as const)('allows a signed %s session to reserve, read and repair workspace events', async (role) => {
    const f = await fixture();
    const auth = role === 'owner' ? f.owner : await f.member('admin');
    const installed = await f.create(auth);
    expect(f.provider).not.toHaveBeenCalled();
    expect(installed.selectedEvents).toEqual([...events]);
    expect(InstallationResponse.parse((await f.request(`/connections/${installed.connectionId}/installation`, auth)).body).installation.connectionId).toBe(installed.connectionId);
    await f.consume('installation');
    const repaired = await f.request(`/connections/${installed.connectionId}/installation`, auth, { action: 'repair' });
    expect(repaired.status, JSON.stringify(repaired.body)).toBe(200);
    expect(InstallationResponse.parse(repaired.body).installation.generation).toBeGreaterThan(installed.generation);
    await runInDurableObject(f.stub, (_instance: WorkspaceDO, state) => {
      expect(state.storage.sql.exec('SELECT connection_id, user_id FROM connector_installations').toArray()).toEqual([{ connection_id: installed.connectionId, user_id: auth.userId }]);
    });
  });

  it('rejects missing sessions, ordinary members, and another workspace before mutation or provider work', async () => {
    const f = await fixture();
    const member = await f.member('member');
    const outsider = await f.member('admin', true);
    const setup = { apiKey: 'unapproved-key', idempotencyKey: crypto.randomUUID(), events: [...events] };
    expect((await f.request('/connections/ashby/workspace', null, setup)).status).toBe(401);
    expect((await f.request('/connections/ashby/workspace', member, setup)).status).toBe(403);
    await runInDurableObject(f.stub, (_instance: WorkspaceDO, state) => {
      expect(state.storage.sql.exec('SELECT id FROM connector_connections').toArray()).toEqual([]);
    });
    expect(f.queue).not.toHaveBeenCalled();
    const installed = await f.create();
    const path = `/connections/${installed.connectionId}/installation`;
    f.queue.mockClear();
    const mutations = [
      { path: `${path}/api-key`, body: { apiKey: 'unapproved-key' } },
      ...['repair', 'disconnect', 'forget_cleanup', 'rotate'].map((action) => ({ path, body: { action } })),
      { path, body: { action: 'reconcile', key: events[0], providerId: crypto.randomUUID() } },
    ];
    for (const mutation of mutations) {
      expect((await f.request(mutation.path, null, mutation.body)).status).toBe(401);
      const denied = await f.request(mutation.path, member, mutation.body);
      expect(denied.status).toBe(403);
      expect(ApiFailure.parse(denied.body).error.code).toBe('workspace_admin_required');
      expect((await f.request(mutation.path, outsider, mutation.body)).status).toBe(404);
    }
    expect((await f.request(path, null)).status).toBe(401);
    expect((await f.request(path, outsider)).status).toBe(404);
    expect(await f.stub.connectorInstallation({ workspaceId: f.workspaceId, connectionId: installed.connectionId })).toEqual(installed);
    expect(f.provider).not.toHaveBeenCalled();
    expect(f.queue).not.toHaveBeenCalled();
  });

  it('rejects malformed identifiers, request bodies and event selections at the HTTP boundary', async () => {
    const f = await fixture();
    const installed = await f.create();
    f.queue.mockClear();
    const valid = { apiKey: 'api-key', idempotencyKey: crypto.randomUUID(), events: [...events] };
    for (const body of [
      { ...valid, apiKey: '' }, { ...valid, idempotencyKey: 'invalid' }, { ...valid, events: [] },
      { ...valid, events: ['applicationSubmit', 'applicationSubmit'] }, { ...valid, events: ['candidateUpdate'] },
      { ...valid, destination: 'https://unapproved.example.test' },
    ]) expect((await f.request('/connections/ashby/workspace', f.owner, body)).status).toBe(400);
    for (const [path, body] of [
      ['/connections/not-a-uuid/installation', { action: 'repair' }],
      [`/connections/${installed.connectionId}/installation`, { action: 'invented' }],
      [`/connections/${installed.connectionId}/installation/api-key`, { apiKey: '' }],
      [`/connections/${installed.connectionId}/installation/api-key`, { accessToken: 'wrong-field' }],
    ] as const) expect((await f.request(path, f.owner, body)).status).toBe(400);
    expect((await f.request('/connections/not-a-uuid/installation', f.owner)).status).toBe(400);
    expect(await f.stub.connectorInstallation({ workspaceId: f.workspaceId, connectionId: installed.connectionId })).toEqual(installed);
    expect(f.provider).not.toHaveBeenCalled();
    expect(f.queue).not.toHaveBeenCalled();
  });

  it('replaces the encrypted API key through the service while preserving both webhook signing secrets and identities', async () => {
    const f = await fixture();
    const installed = await f.create();
    await f.consume('installation');
    const before = await f.readEnvelope(installed.connectionId);
    const current = await f.stub.connectorInstallation({ workspaceId: f.workspaceId, connectionId: installed.connectionId });
    const result = await f.request(`/connections/${installed.connectionId}/installation/api-key`, f.owner, { apiKey: '  replacement-api-key  ' });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const updated = InstallationResponse.parse(result.body).installation;
    const after = await f.readEnvelope(installed.connectionId);
    expect(after.encrypted_credentials).not.toBe(before.encrypted_credentials);
    expect(after.credentials).toEqual({ ...before.credentials, apiKey: 'replacement-api-key' });
    expect(updated.registrations.map((registration) => registration.providerId)).toEqual(current!.registrations.map((registration) => registration.providerId));
    const validations = f.provider.mock.calls.filter(([url, init]) => String(url).endsWith('/apiKey.info') && new Headers(init?.headers).get('authorization') === `Basic ${btoa('replacement-api-key:')}`);
    expect(validations).toHaveLength(1);
    for (const event of events) {
      const registration = installed.registrations.find((item) => item.events.includes(event))!;
      const secret = z.string().parse(before.credentials![registration.activeSecretRef!]);
      const accepted = await f.deliver(installed, event, secret);
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    }
    await f.consume('event');
    await runInDurableObject(f.stub, (_instance: WorkspaceDO, state) => {
      expect(state.storage.sql.exec('SELECT event_type FROM workspace_connector_events ORDER BY event_type').toArray()).toEqual(events.map((event_type) => ({ event_type })));
    });
  });

  it.each([{ providerStatus: 200, apiStatus: 502 }, { providerStatus: 401, apiStatus: 401 }, { providerStatus: 403, apiStatus: 401 }])('keeps the original encrypted credential and generation when replacement validation is rejected with HTTP $providerStatus', async ({ providerStatus, apiStatus }) => {
    const f = await fixture();
    const installed = await f.create();
    const before = await f.readEnvelope(installed.connectionId);
    f.queue.mockClear();
    f.setValidation(async (apiKey) => {
      expect(apiKey).toBe('rejected-api-key');
      return Response.json({ success: false, errors: ['fixture-denial'] }, { status: providerStatus });
    });
    const denied = await f.request(`/connections/${installed.connectionId}/installation/api-key`, f.owner, { apiKey: 'rejected-api-key' });
    expect(denied.status, JSON.stringify(denied.body)).toBe(apiStatus);
    expect(await f.readEnvelope(installed.connectionId)).toEqual(before);
    expect(await f.stub.connectorInstallation({ workspaceId: f.workspaceId, connectionId: installed.connectionId })).toEqual(installed);
    expect(f.queue).not.toHaveBeenCalled();
  });

  it('preserves a provider-issued Granola signing secret committed while replacement validation is in flight', async () => {
    const f = await fixture();
    const originalKey = `grn_${'a'.repeat(32)}`;
    const replacementKey = `grn_${'b'.repeat(32)}`;
    const setup = await f.request('/connections/granola/workspace', f.owner, { apiKey: originalKey, capabilities: ['granola.workspace.read'] });
    expect(setup.status, JSON.stringify(setup.body)).toBe(201);
    const connectionId = z.object({ connection: ConnectionSchema }).parse(setup.body).connection.id;
    const initial = (await f.stub.connectorInstallation({ workspaceId: f.workspaceId, connectionId }))!;
    const entered = deferred();
    const release = deferred();
    const remote = { id: 'whe_1234567890abcd', url: initial.registrations[0]!.destination,
      events: initial.selectedEvents, enabled: true };
    let created = false;
    f.setGranola(async (url, init) => {
      expect(url.pathname).toBe('/v1/webhook-endpoints');
      const authorization = new Headers(init?.headers).get('authorization');
      if (authorization === `Bearer ${replacementKey}`) {
        entered.resolve(); await release.promise;
        return Response.json({ webhook_endpoints: created ? [remote] : [] });
      }
      expect(authorization).toBe(`Bearer ${originalKey}`);
      if (init?.method === 'POST') {
        created = true;
        return Response.json({ ...remote, signing_secret: 'whsec_cHJvdmlkZXItaXNzdWVkLXNlY3JldA==' });
      }
      return Response.json({ webhook_endpoints: created ? [remote] : [] });
    });
    const pending = f.request(`/connections/${connectionId}/installation/api-key`, f.owner, { apiKey: replacementKey });
    await entered.promise;
    try { await f.consume('installation'); }
    finally { release.resolve(); }
    const refused = await pending;
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    const retained = await f.readEnvelope(connectionId);
    expect(retained.credentials).toMatchObject({ apiKey: originalKey, webhookEndpointId: remote.id,
      webhookSigningSecret: 'whsec_cHJvdmlkZXItaXNzdWVkLXNlY3JldA==' });
    expect(retained.credentials![initial.registrations[0]!.activeSecretRef!]).toBe('whsec_cHJvdmlkZXItaXNzdWVkLXNlY3JldA==');
    expect((await f.stub.connectorInstallation({ workspaceId: f.workspaceId, connectionId }))?.state).toBe('current');
  });

  it('cannot restore ordinary credentials when disconnect wins during replacement validation', async () => {
    const f = await fixture();
    const installed = await f.create();
    await f.consume('installation');
    const before = await f.readEnvelope(installed.connectionId);
    const entered = deferred();
    const release = deferred();
    f.setValidation(async (apiKey) => {
      expect(apiKey).toBe('late-replacement-key'); entered.resolve();
      await release.promise;
      return Response.json({ success: true, results: {} });
    });
    const pending = f.request(`/connections/${installed.connectionId}/installation/api-key`, f.owner, { apiKey: 'late-replacement-key' });
    await entered.promise;
    try {
      const disconnected = await f.request(`/connections/${installed.connectionId}/installation`, f.owner, { action: 'disconnect' });
      expect(disconnected.status, JSON.stringify(disconnected.body)).toBe(200);
      expect(await f.readEnvelope(installed.connectionId)).toMatchObject({ status: 'disabled', encrypted_credentials: null, credential_iv: null });
    } finally { release.resolve(); }
    const refused = await pending;
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(await f.readEnvelope(installed.connectionId)).toMatchObject({ status: 'disabled', encrypted_credentials: null, credential_iv: null });
    const cleanup = await runInDurableObject(f.stub, (_instance: WorkspaceDO, state) => state.storage.sql.exec<{ cleanup_ciphertext: string; cleanup_iv: string }>(
      'SELECT cleanup_ciphertext, cleanup_iv FROM connector_installations WHERE connection_id = ?', installed.connectionId).one());
    expect(JSON.parse(await decryptString(cleanup.cleanup_ciphertext, cleanup.cleanup_iv, envelopeKey, installed.connectionId))).toEqual(before.credentials);
  });

  it('refuses a valid signature outside its registration event or the saved customer selection before storing or queueing content', async () => {
    const f = await fixture();
    const installed = await f.create();
    await f.consume('installation');
    const saved = await f.readEnvelope(installed.connectionId);
    const appSecret = z.string().parse(saved.credentials![installed.registrations[0]!.activeSecretRef!]);
    const stageSecret = z.string().parse(saved.credentials![installed.registrations[1]!.activeSecretRef!]);
    expect(appSecret).not.toBe(stageSecret);
    async function assertNothingAdmitted() {
      expect(f.queue).not.toHaveBeenCalled();
      expect((await env.PAYLOADS.list({ prefix: `global/${f.workspaceId}/` })).objects).toEqual([]);
      await runInDurableObject(f.stub, (_instance: WorkspaceDO, state) => {
        expect(state.storage.sql.exec('SELECT id FROM webhook_receipts').toArray()).toEqual([]);
        expect(state.storage.sql.exec('SELECT provider_event_id FROM workspace_connector_events').toArray()).toEqual([]);
      });
    }
    const wrongRegistration = await f.deliver(installed, 'candidateStageChange', appSecret);
    expect(wrongRegistration.status).toBe(401);
    await assertNothingAdmitted();
    expect(ApiFailure.parse(wrongRegistration.body).error.code).toBe('event_not_authorized');
    const current = (await f.stub.connectorInstallation({ workspaceId: f.workspaceId, connectionId: installed.connectionId }))!;
    // A reviewed maintenance change narrows the grant before the old remote
    // registration is removed. Its still-valid signing key must not widen it.
    await f.stub.prepareConnectorInstallationMaintenance({ workspaceId: f.workspaceId, connectionId: installed.connectionId,
      generation: current.generation, operationId: crypto.randomUUID(), version: 1,
      configuration: { selectedEvents: ['applicationSubmit'], registrations: current.registrations.map((registration) => registration.events.includes('candidateStageChange')
        ? { ...registration, action: 'remove', state: 'pending', stepId: crypto.randomUUID() } : registration) } });
    const outsideSelection = await f.deliver(installed, 'candidateStageChange', stageSecret);
    expect(outsideSelection.status).toBe(401);
    await assertNothingAdmitted();
    expect(ApiFailure.parse(outsideSelection.body).error.code).toBe('event_not_authorized');
  });
});
