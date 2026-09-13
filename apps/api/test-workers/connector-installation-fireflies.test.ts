/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, reset, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { asUserId, asWorkspaceId, ConnectionSchema, ConnectorInstallationSchema, ConnectorManualRegistrationSchema } from '@rally/contracts';
import { createApp } from '../src/app';
import type { AuthContext, Env } from '../src/env';
import { workspaceDOName } from '../src/durable-objects/names';
import type { WorkspaceDO } from '../src/durable-objects/workspace-do';
import { WorkspaceConnectorEventQueueMessageSchema } from '../src/durable-objects/workspace-connector-event-protocol';
import { consumeActivityQueue } from '../src/queues/activity-consumer';
import { ConnectorInstallationQueueSchema } from '../src/services/connector-installation-service';
import { seedWorkspaceControlPlane } from './helpers/substream-fixture';

const envelopeKey = 'fireflies-installation-fixture-envelope-key';
const sessionKey = 'fireflies-installation-fixture-session-key';
// Low entropy on purpose: the repository's secret scan reads every branch.
const validApiKey = 'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk';
const SetupResponse = z.object({
  installation: ConnectorInstallationSchema,
  connection: ConnectionSchema,
  manualRegistration: ConnectorManualRegistrationSchema.nullable(),
});
const ApiFailure = z.object({ error: z.object({ code: z.string() }) });
const unexpectedProviderCalls: string[] = [];

beforeEach(async () => { await reset(); unexpectedProviderCalls.length = 0; });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(unexpectedProviderCalls).toEqual([]);
});

async function fixture(options: { connectorEnabled?: boolean } = {}) {
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
  ]);
  const testEnv = {
    ...env,
    SESSION_SIGNING_KEY: sessionKey,
    CONNECTOR_CREDENTIALS_KEY: envelopeKey,
    CONNECTOR_CREDENTIALS_KEY_VERSION: '1',
    // The rollout gate, set per fixture so the off case is exercised for real
    // rather than asserted about.
    ...(options.connectorEnabled === false ? {} : { FIREFLIES_CONNECTOR_ENABLED: 'true' }),
  } satisfies Env;
  const stub = env.WORKSPACE_DOS.getByName(workspaceDOName('global', workspaceId));
  await runInDurableObject(stub, (_instance: WorkspaceDO, state) => {
    state.storage.sql.exec(`INSERT INTO workspace_identity
      (id, workspace_id, region, placement_affinity, created_at, updated_at)
      VALUES (1, ?, 'global', 'wnam', ?, ?)`, workspaceId, Date.now(), Date.now());
  });
  const owner: AuthContext = { workspaceId, userId: ownerId, sessionId, role: 'owner', region: 'global' };
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

  let userReply: () => Response = () => Response.json({ data: { user: { user_id: 'u-1', email: 'bob@acme.test', name: 'Bob' } } });
  const provider = vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== 'https://api.fireflies.ai') {
      unexpectedProviderCalls.push(url.origin);
      throw new Error('Unexpected provider');
    }
    return userReply();
  });
  vi.stubGlobal('fetch', provider);

  const queue = vi.spyOn(env.ACTIVITY_QUEUE, 'send');

  async function deliver(connectionId: string, body: string, secret: string | null, signatureOverride?: string | null) {
    const bytes = new TextEncoder().encode(body);
    const headers: Record<string, string> = {};
    if (signatureOverride !== undefined && signatureOverride !== null) headers['X-Hub-Signature'] = signatureOverride;
    else if (signatureOverride === undefined && secret) {
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const digest = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
      headers['X-Hub-Signature'] = `sha256=${digest}`;
    }
    const ctx = createExecutionContext();
    const response = await app.request(`/ingest/fireflies/${connectionId}`, { method: 'POST', body: bytes, headers }, testEnv, ctx);
    const value: unknown = await response.json();
    await waitOnExecutionContext(ctx);
    return { status: response.status, body: value };
  }

  async function drainQueue(kind: 'installation' | 'event') {
    const schema = kind === 'installation' ? ConnectorInstallationQueueSchema : WorkspaceConnectorEventQueueMessageSchema;
    const bodies = queue.mock.calls.flatMap(([body]) => {
      const parsed = schema.safeParse(body);
      return parsed.success ? [parsed.data] : [];
    });
    if (bodies.length === 0) return;
    const batch = createMessageBatch('avalon-do-runtime-test-activity', bodies.map((body) => ({ id: crypto.randomUUID(), body, timestamp: new Date(), attempts: 1 })));
    await consumeActivityQueue(batch, testEnv);
    expect((await getQueueResult(batch, createExecutionContext())).retryMessages).toEqual([]);
    queue.mockClear();
  }

  async function activities() {
    return runInDurableObject(stub, (_instance: WorkspaceDO, state) => state.storage.sql.exec<{
      event_type: string; dedupe_key: string; provider_event_id: string;
    }>(`SELECT event_type, dedupe_key, provider_event_id FROM workspace_connector_events
          WHERE provider = 'fireflies' ORDER BY dedupe_key`).toArray());
  }

  async function installation(connectionId: string) {
    const read = await request(`/connections/${connectionId}/installation`, owner);
    expect(read.status).toBe(200);
    return z.object({ installation: ConnectorInstallationSchema.nullable() }).parse(read.body).installation;
  }

  async function setup() {
    const created = await request('/connections/fireflies/workspace', owner, {
      apiKey: validApiKey, idempotencyKey: crypto.randomUUID(), capabilities: ['fireflies.workspace.read'],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    // The installation runner is what settles a manual create into Action
    // required; in production the Queue delivers it moments after the response.
    await drainQueue('installation');
    return SetupResponse.parse(created.body);
  }

  return {
    workspaceId, owner, stub, request, deliver, drainQueue, activities, installation, setup, queue,
    rejectKey: () => { userReply = () => Response.json({ errors: [{ code: 'auth_failed' }] }); },
  };
}

function payload(event: string, meetingId = 'meeting-1', timestamp = Date.now()) {
  return JSON.stringify({ event, timestamp, meeting_id: meetingId });
}

describe('the Fireflies workspace installation', () => {
  it('reserves nothing when the provider rejects the pasted key', async () => {
    const f = await fixture();
    f.rejectKey();
    const created = await f.request('/connections/fireflies/workspace', f.owner, {
      apiKey: validApiKey, idempotencyKey: crypto.randomUUID(), capabilities: ['fireflies.workspace.read'],
    });
    expect(created.status).toBe(422);
    expect(ApiFailure.parse(created.body).error.code).toBe('connector_credential_rejected');
    const connections = await f.request('/connections', f.owner);
    expect(z.object({ items: z.array(ConnectionSchema) }).parse(connections.body).items).toEqual([]);
  });

  it('hands the administrator the endpoint, the secret, and the steps exactly once', async () => {
    const f = await fixture();
    const { installation, connection, manualRegistration } = await f.setup();
    // Settings names the account the key reads, which for a key-scoped
    // connector is the whole question of what the workspace can see.
    expect(connection.displayName).toBe('Fireflies · bob@acme.test');
    expect(installation.selectedEvents).toEqual(['meeting.transcribed', 'meeting.summarized']);
    expect(manualRegistration?.destination).toContain(`/ingest/fireflies/${connection.id}`);
    expect(manualRegistration?.events).toEqual(['meeting.transcribed', 'meeting.summarized']);
    expect(manualRegistration?.signingSecret).toMatch(/^[A-Za-z0-9_-]{16,}$/u);
    expect(manualRegistration?.instructions).toContain('https://app.fireflies.ai/integrations/api/webhook');

    // Neither the secret nor the key is readable back through the connection.
    const listed = await f.request('/connections', f.owner);
    expect(JSON.stringify(listed.body)).not.toContain(manualRegistration!.signingSecret);
    expect(JSON.stringify(listed.body)).not.toContain(validApiKey);
    const reread = await f.installation(connection.id);
    expect(JSON.stringify(reread)).not.toContain(manualRegistration!.signingSecret);
  });

  it('leaves the installation action required until a delivery proves the registration, then makes it current', async () => {
    const f = await fixture();
    const { connection, manualRegistration } = await f.setup();
    const secret = manualRegistration!.signingSecret;

    // Nothing but a delivery can verify this registration: the adapter declares
    // create manual and inspect unsupported, so the runner settles the step as
    // action required rather than calling a provider API that does not exist.
    const pending = await f.installation(connection.id);
    expect(pending?.state).toBe('action_required');
    expect(pending?.lastReceivedAt).toBeNull();
    expect(pending?.registrations[0]?.verifiedAt).toBeNull();

    const delivered = await f.deliver(connection.id, payload('meeting.transcribed'), secret);
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(202);

    const verified = await f.installation(connection.id);
    expect(verified?.state).toBe('current');
    expect(verified?.registrations[0]?.state).toBe('current');
    expect(verified?.registrations[0]?.verifiedAt).not.toBeNull();
    expect(verified?.registrations[0]?.error).toBeNull();
    expect(verified?.lastReceivedAt).not.toBeNull();
    expect(verified?.appliedVersion).toBe(verified?.desiredVersion);
  });

  it('rejects an unsigned, mis-signed, stale, or unsubscribed delivery without writing anything', async () => {
    const f = await fixture();
    const { connection, manualRegistration } = await f.setup();
    const secret = manualRegistration!.signingSecret;
    const body = payload('meeting.summarized');

    expect((await f.deliver(connection.id, body, secret, null)).status).toBe(401);
    expect((await f.deliver(connection.id, body, secret, `sha256=${'0'.repeat(64)}`)).status).toBe(401);
    expect((await f.deliver(connection.id, body, 'wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww')).status).toBe(401);
    // Correctly signed, but its in-body timestamp is hours old: the only replay
    // anchor Fireflies gives, since it signs the body and nothing else.
    expect((await f.deliver(connection.id, payload('meeting.summarized', 'meeting-1', Date.now() - 7_200_000), secret)).status).toBe(401);
    // Verified, and still refused: an event this connector does not handle.
    const botJoined = await f.deliver(connection.id, payload('meeting.bot_joined'), secret);
    expect(botJoined.status).toBe(400);
    expect(ApiFailure.parse(botJoined.body).error.code).toBe('unsupported_webhook_event');

    await f.drainQueue('event');
    expect(await f.activities()).toEqual([]);
    // None of them counted as the verifying delivery.
    const stillPending = await f.installation(connection.id);
    expect(stillPending?.state).toBe('action_required');
    expect(stillPending?.lastReceivedAt).toBeNull();
  });

  it('admits each handled event once and keeps the two apart', async () => {
    const f = await fixture();
    const { connection, manualRegistration } = await f.setup();
    const secret = manualRegistration!.signingSecret;
    const transcribed = payload('meeting.transcribed', 'meeting-7');
    const summarized = payload('meeting.summarized', 'meeting-7', Date.now() + 1_000);

    expect((await f.deliver(connection.id, transcribed, secret)).status).toBe(202);
    expect((await f.deliver(connection.id, summarized, secret)).status).toBe(202);
    // A byte-identical replay of a delivery Fireflies already made.
    const replay = await f.deliver(connection.id, summarized, secret);
    expect(replay.status).toBe(200);

    await f.drainQueue('event');
    expect(await f.activities()).toEqual([
      { event_type: 'meeting.summarized', dedupe_key: 'fireflies:meeting-7:meeting.summarized', provider_event_id: 'meeting-7' },
      { event_type: 'meeting.transcribed', dedupe_key: 'fireflies:meeting-7:meeting.transcribed', provider_event_id: 'meeting-7' },
    ]);
  });

  it('omits the connector entirely from a region whose gate is unset', async () => {
    const f = await fixture({ connectorEnabled: false });
    const catalog = await f.request('/connections/catalog', f.owner);
    expect(z.object({ availableConnectorTypes: z.array(z.string()) }).parse(catalog.body).availableConnectorTypes).not.toContain('fireflies');
    const created = await f.request('/connections/fireflies/workspace', f.owner, {
      apiKey: validApiKey, idempotencyKey: crypto.randomUUID(), capabilities: ['fireflies.workspace.read'],
    });
    expect(created.status).toBeGreaterThanOrEqual(400);
  });
});
