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
  // An ordinary member of the same workspace, added by hand: the control-plane
  // seed above creates the tables as well as the rows, so it runs exactly once.
  const memberId = asUserId(crypto.randomUUID());
  const memberSessionId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at)
      VALUES (?, 'second@example.com', 'Second', NULL, 'UTC', '2026-01-01T00:00:00.000Z')`).bind(memberId),
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', '2026-08-18T20:00:00.000Z')`).bind(workspaceId, memberId),
    env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`).bind(memberSessionId, memberId, workspaceId),
  ]);
  const member: AuthContext = { workspaceId, userId: memberId, sessionId: memberSessionId, role: 'member', region: 'global' };
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

  async function receipts() {
    return runInDurableObject(stub, (_instance: WorkspaceDO, state) =>
      state.storage.sql.exec<{ total: number }>('SELECT COUNT(*) AS total FROM webhook_receipts').toArray()[0]?.total ?? 0);
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

  async function setup(idempotencyKey?: string) {
    const created = await request('/connections/fireflies/workspace', owner, {
      apiKey: validApiKey, idempotencyKey: idempotencyKey ?? crypto.randomUUID(),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    // The installation runner is what settles a manual create into Action
    // required; in production the Queue delivers it moments after the response.
    await drainQueue('installation');
    return SetupResponse.parse(created.body);
  }

  return {
    workspaceId, owner, member, stub, request, deliver, drainQueue, activities, receipts, installation, setup, queue,
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
      apiKey: validApiKey, idempotencyKey: crypto.randomUUID(),
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
    expect(manualRegistration?.signingSecret).toMatch(/^[A-Za-z0-9_-]{16,}$/u);
    // The steps live on the settled registration rather than in the setup
    // response: one copy, which the management window is already reading.
    const settled = await f.installation(connection.id);
    expect(settled?.registrations[0]?.events).toEqual(['meeting.transcribed', 'meeting.summarized']);
    expect(settled?.registrations[0]?.error).toContain('https://app.fireflies.ai/integrations/api/webhook');

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
    // Verification precedes the receipt claim, so an unauthenticated caller who
    // knows the URL cannot make Rally write a per-connection row either.
    expect(await f.receipts()).toBe(0);
    // None of them counted as the verifying delivery.
    const stillPending = await f.installation(connection.id);
    expect(stillPending?.state).toBe('action_required');
    expect(stillPending?.lastReceivedAt).toBeNull();
  });

  it('refuses a signed delivery for an event the registration does not carry', async () => {
    const f = await fixture();
    const { connection, manualRegistration } = await f.setup();
    const secret = manualRegistration!.signingSecret;
    // Narrow the grant the way a later declaration would: the event is one the
    // connector handles, so this is an authorization answer rather than the
    // "Rally never subscribed to this" refusal above, and the two must not
    // collapse into one code.
    await runInDurableObject(f.stub, (_instance: WorkspaceDO, state) => {
      const row = state.storage.sql.exec<{ document_json: string }>(
        'SELECT document_json FROM connector_installations WHERE connection_id = ?', connection.id).toArray()[0]!;
      const document = JSON.parse(row.document_json) as { selectedEvents: string[]; registrations: { events: string[] }[] };
      document.selectedEvents = ['meeting.summarized'];
      document.registrations[0]!.events = ['meeting.summarized'];
      state.storage.sql.exec('UPDATE connector_installations SET document_json = ? WHERE connection_id = ?',
        JSON.stringify(document), connection.id);
    });

    const refused = await f.deliver(connection.id, payload('meeting.transcribed'), secret);
    expect(refused.status).toBe(401);
    expect(ApiFailure.parse(refused.body).error.code).toBe('event_not_authorized');
    await f.drainQueue('event');
    expect(await f.activities()).toEqual([]);
    expect(await f.receipts()).toBe(0);
  });

  it('reports a correctly signed but stale delivery as a timestamp problem, not a wrong key', async () => {
    const f = await fixture();
    const { connection, manualRegistration } = await f.setup();
    const stale = await f.deliver(connection.id,
      payload('meeting.summarized', 'meeting-1', Date.now() - 7_200_000), manualRegistration!.signingSecret);
    expect(stale.status).toBe(401);
    // The distinction is the whole point: telling an administrator their
    // signing secret is wrong when their clock or a replay is the cause sends
    // them to rotate a secret they cannot rotate without reconnecting.
    expect(ApiFailure.parse(stale.body).error.code).toBe('webhook_timestamp_outside_window');
  });

  it('rejects a delivery to a connection the administrator removed', async () => {
    const f = await fixture();
    const { connection, manualRegistration } = await f.setup();
    const secret = manualRegistration!.signingSecret;
    expect((await f.deliver(connection.id, payload('meeting.transcribed'), secret)).status).toBe(202);
    await f.drainQueue('event');
    const before = await f.activities();

    const disconnected = await f.request(`/connections/${connection.id}/installation`, f.owner, { action: 'disconnect' });
    expect(disconnected.status, JSON.stringify(disconnected.body)).toBe(200);

    // Fireflies has no delete API, so Rally cannot take the webhook down at the
    // provider; refusing its deliveries is the entire reason a webhook the
    // administrator left behind is harmless.
    const afterRemoval = await f.deliver(connection.id, payload('meeting.summarized', 'meeting-9'), secret);
    expect(afterRemoval.status).toBe(404);
    await f.drainQueue('event');
    expect(await f.activities()).toEqual(before);
  });

  it('refuses a delivery for a disabled connection even with its ingress route intact', async () => {
    const f = await fixture();
    const { connection, manualRegistration } = await f.setup();
    const secret = manualRegistration!.signingSecret;
    // Disable the row without going through disconnect, which also retires the
    // ingress route: that route is the outer control, and this is the one
    // underneath it. Removing either predicate has to fail a test on its own,
    // or "defence in depth" is one layer wearing two names.
    await runInDurableObject(f.stub, (_instance: WorkspaceDO, state) => {
      state.storage.sql.exec("UPDATE connector_connections SET status = 'disabled' WHERE id = ?", connection.id);
    });

    expect((await f.deliver(connection.id, payload('meeting.summarized', 'meeting-11'), secret)).status).toBe(404);
    await f.drainQueue('event');
    expect(await f.activities()).toEqual([]);
  });

  it('will not let a delivery revive an installation whose connection is disabled', async () => {
    const f = await fixture();
    const { connection } = await f.setup();
    const before = await f.installation(connection.id);
    await runInDurableObject(f.stub, (_instance: WorkspaceDO, state) => {
      state.storage.sql.exec("UPDATE connector_connections SET status = 'disabled' WHERE id = ?", connection.id);
    });

    await f.stub.receiveConnectorInstallationEvent({
      workspaceId: f.workspaceId, connectionId: connection.id, receivedAt: new Date().toISOString(),
      registrationKey: before!.registrations[0]!.key,
      registrationSupport: { create: 'manual', inspect: 'unsupported' },
    });

    const after = await f.installation(connection.id);
    expect(after?.registrations[0]?.state).toBe('action_required');
    expect(after?.registrations[0]?.verifiedAt).toBeNull();
    expect(after?.state).not.toBe('current');
  });

  it('does not let a delivery verify a registration for a provider that can be inspected', async () => {
    const f = await fixture();
    const { connection } = await f.setup();
    const before = await f.installation(connection.id);
    expect(before?.registrations[0]?.state).toBe('action_required');

    // The same hook, with the declaration an inspectable provider sends. Ashby
    // and Granola run this path on every delivery, so if the gate goes the
    // weaker claim "something signed correctly once" silently replaces reading
    // the webhook back and comparing its destination and events.
    const at = new Date().toISOString();
    await f.stub.receiveConnectorInstallationEvent({
      workspaceId: f.workspaceId, connectionId: connection.id, receivedAt: at,
      registrationKey: before!.registrations[0]!.key,
      registrationSupport: { create: 'automatic', inspect: 'automatic' },
    });

    const after = await f.installation(connection.id);
    expect(after?.registrations[0]?.state).toBe('action_required');
    expect(after?.registrations[0]?.verifiedAt).toBeNull();
    expect(after?.state).toBe('action_required');
    // The delivery still counts as one, which is the half that always applies.
    expect(after?.lastReceivedAt).toBe(at);
  });

  it('verifies only the registration whose secret signed the delivery', async () => {
    const f = await fixture();
    const { connection } = await f.setup();
    // A second registration, as a single_event provider would carry: the
    // delivery names one key, and must not vouch for a subscription the
    // administrator may never have ticked.
    await runInDurableObject(f.stub, (_instance: WorkspaceDO, state) => {
      const row = state.storage.sql.exec<{ document_json: string }>(
        'SELECT document_json FROM connector_installations WHERE connection_id = ?', connection.id).toArray()[0]!;
      const document = JSON.parse(row.document_json) as { registrations: Record<string, unknown>[] };
      document.registrations.push({ ...document.registrations[0]!, key: 'second', stepId: crypto.randomUUID() });
      state.storage.sql.exec('UPDATE connector_installations SET document_json = ? WHERE connection_id = ?',
        JSON.stringify(document), connection.id);
    });

    const before = await f.installation(connection.id);
    await f.stub.receiveConnectorInstallationEvent({
      workspaceId: f.workspaceId, connectionId: connection.id, receivedAt: new Date().toISOString(),
      registrationKey: before!.registrations[0]!.key,
      registrationSupport: { create: 'manual', inspect: 'unsupported' },
    });

    const after = await f.installation(connection.id);
    expect(after?.registrations.find((item) => item.key === before!.registrations[0]!.key)?.state).toBe('current');
    expect(after?.registrations.find((item) => item.key === 'second')?.state).toBe('action_required');
    expect(after?.registrations.find((item) => item.key === 'second')?.verifiedAt).toBeNull();
  });

  it('leaves a verified installation connected when Test finds nothing to repair', async () => {
    const f = await fixture();
    const { connection, manualRegistration } = await f.setup();
    expect((await f.deliver(connection.id, payload('meeting.transcribed'), manualRegistration!.signingSecret)).status).toBe(202);
    expect((await f.installation(connection.id))?.state).toBe('current');

    // Test runs a repair. For a provider whose registrations carry no provider
    // id there is nothing to inspect, so no step becomes pending and nothing
    // ever settles — which is why claiming "Updating" here used to strand a
    // working installation until the next real meeting arrived.
    const tested = await f.request(`/connections/${connection.id}/test`, f.owner, {});
    expect(tested.status, JSON.stringify(tested.body)).toBe(200);

    const after = await f.installation(connection.id);
    expect(after?.state).toBe('current');
    expect(after?.registrations[0]?.state).toBe('current');
  });

  it('refuses to adopt a webhook id for a provider that can never confirm one', async () => {
    const f = await fixture();
    const { connection } = await f.setup();
    const key = (await f.installation(connection.id))!.registrations[0]!.key;

    // Storing a fabricated provider id would make the registration read as one
    // Rally created: the cleanup advice would start offering to delete a
    // webhook through an API Fireflies does not have.
    const refused = await f.request(`/connections/${connection.id}/installation`, f.owner,
      { action: 'reconcile', key, providerId: 'invented-by-hand' });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(ApiFailure.parse(refused.body).error.code).toBe('connector_reconciliation_unsupported');
    expect((await f.installation(connection.id))?.registrations[0]?.providerId).toBeNull();
  });

  it('reveals the signing secret once, and never again for the same attempt', async () => {
    const f = await fixture();
    const idempotencyKey = crypto.randomUUID();
    const first = await f.setup(idempotencyKey);
    expect(first.manualRegistration).not.toBeNull();

    // The replay returns the same installation and no secret: a lost one is
    // replaced by reconnecting, which is the reason the desktop refuses to
    // close that dialog while it is on screen.
    const replay = await f.request('/connections/fireflies/workspace', f.owner, { apiKey: validApiKey, idempotencyKey });
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    const second = SetupResponse.parse(replay.body);
    expect(second.connection.id).toBe(first.connection.id);
    expect(second.manualRegistration).toBeNull();
  });

  it('admits only a workspace administrator, and only a body the contract accepts', async () => {
    const f = await fixture();
    const body = { apiKey: validApiKey, idempotencyKey: crypto.randomUUID() };
    expect((await f.request('/connections/fireflies/workspace', null, body)).status).toBe(401);
    const forbidden = await f.request('/connections/fireflies/workspace', f.member, body);
    expect(forbidden.status).toBe(403);
    expect(ApiFailure.parse(forbidden.body).error.code).toBe('workspace_admin_required');

    for (const invalid of [
      { idempotencyKey: crypto.randomUUID() },
      { apiKey: validApiKey },
      { apiKey: validApiKey, idempotencyKey: 'not-a-uuid' },
      { apiKey: '   ', idempotencyKey: crypto.randomUUID() },
      { ...body, capabilities: ['fireflies.workspace.read'] },
    ]) {
      expect((await f.request('/connections/fireflies/workspace', f.owner, invalid)).status,
        JSON.stringify(invalid)).toBe(400);
    }
  });

  it('starts a personal authorization only for the personal scope', async () => {
    const f = await fixture();
    expect((await f.request('/connections/fireflies/start', null, { scope: 'personal', capabilities: ['fireflies.personal.read'] })).status).toBe(401);
    for (const invalid of [
      { scope: 'workspace', capabilities: ['fireflies.workspace.read'] },
      { scope: 'personal', capabilities: [] },
      { scope: 'personal', capabilities: ['fireflies.workspace.read'] },
    ]) {
      expect((await f.request('/connections/fireflies/start', f.owner, invalid)).status, JSON.stringify(invalid)).toBe(400);
    }
  });

  it('answers an ingress for a connection it does not have without saying whether one exists elsewhere', async () => {
    const f = await fixture();
    expect((await f.deliver(crypto.randomUUID(), payload('meeting.summarized'), 'ssssssssssssssssssssssssssssssss')).status).toBe(404);
    const badId = await f.deliver('not-a-uuid', payload('meeting.summarized'), 'ssssssssssssssssssssssssssssssss');
    expect(badId.status).toBe(400);
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
      apiKey: validApiKey, idempotencyKey: crypto.randomUUID(),
    });
    // The exact refusal, not merely "some failure": an unmapped throw is a 500,
    // which would pass a `>= 400` assertion while telling the administrator
    // nothing and paging somebody.
    expect(created.status, JSON.stringify(created.body)).toBe(422);
    expect(ApiFailure.parse(created.body).error.code).toBe('unsupported_capability');
  });
});
