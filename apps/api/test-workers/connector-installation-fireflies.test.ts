/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, reset, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { asUserId, asWorkspaceId, ConnectionSchema, ConnectorInstallationSchema } from '@rally/contracts';
import { createApp } from '../src/app';
import { ConnectionService } from '../src/services/connection-service';
import type { AuthContext, Env } from '../src/env';
import { workspaceDOName } from '../src/durable-objects/names';
import type { WorkspaceDO } from '../src/durable-objects/workspace-do';
import { WorkspaceConnectorEventQueueMessageSchema } from '../src/durable-objects/workspace-connector-event-protocol';
import { consumeActivityQueue } from '../src/queues/activity-consumer';
import { encryptString } from '../src/lib/crypto';
import { runConnectorInstallation } from '../src/services/connector-installation-service';
import { ConnectorInstallationQueueSchema } from '../src/services/connector-installation-service';
import { seedWorkspaceControlPlane } from './helpers/substream-fixture';

const envelopeKey = 'fireflies-installation-fixture-envelope-key';
const sessionKey = 'fireflies-installation-fixture-session-key';
// Low entropy on purpose: the repository's secret scan reads every branch.
const validApiKey = 'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk';
// The identifying fields of the refusal's log entry, and only those: the entry
// also carries a timestamp, region and build, which say nothing about which
// delivery was refused.
const RefusalLog = z.object({
  event: z.literal('connector_webhook_event_refused'),
  connector_type: z.string(),
  connection_id: z.string(),
  event_type: z.string(),
  code: z.string(),
});
const ApiFailure = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.object({ provider: z.string(), eventType: z.string() }).optional(),
  }),
});
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
    // `wrangler.test.jsonc` runs the suite at `error`, which drops every
    // `logWarn` — including the refusal diagnostic asserted below, whose
    // assertion would otherwise pass against an empty list forever.
    LOG_LEVEL: 'warn' as const,
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

  const userReply: () => Response = () => Response.json({ data: { user: { user_id: 'u-1', email: 'bob@acme.test', name: 'Bob' } } });
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

  /**
   * A Fireflies workspace installation of the shape `createWorkspaceInstallation`
   * left behind while the scope was open — the grouped registration, the
   * host-generated signing secret, the ingress route — written here because the
   * route that made one is gone. Everything below it is what such a connection
   * must keep doing: deliveries still arrive, verify, and become activity.
   */
  async function setup() {
    const connectionId = crypto.randomUUID();
    const registrationKey = 'meeting.transcribed+meeting.summarized';
    const secretRef = `webhook_secret:${registrationKey}`;
    const signingSecret = 'ssssssssssssssssssssssssssssssss';
    const destination = new URL(`/ingest/fireflies/${connectionId}`, testEnv.PUBLIC_API_BASE_URL).toString();
    const at = new Date().toISOString();
    const credentials = { apiKey: validApiKey, [secretRef]: signingSecret };
    await stub.createConnectorInstallation({
      installation: ConnectorInstallationSchema.parse({
        connectionId, workspaceId, provider: 'fireflies', attemptId: crypto.randomUUID(),
        generation: 1, desiredVersion: 1, appliedVersion: null, state: 'setting_up',
        selectedEvents: ['meeting.transcribed', 'meeting.summarized'],
        registrations: [{
          key: registrationKey, providerId: null,
          events: ['meeting.transcribed', 'meeting.summarized'], destination, enabled: null,
          state: 'pending', action: 'create', stepId: crypto.randomUUID(), verifiedAt: null, error: null,
          rotation: 'stable', rotationGeneration: 0, activeSecretRef: secretRef, pendingSecretRef: null,
        }],
        createdAt: at, updatedAt: at, lastReceivedAt: null, error: null,
      }),
      userId: owner.userId, inputHash: 'fireflies-legacy-workspace-installation',
      credentials: { ...await encryptString(JSON.stringify(credentials), envelopeKey, connectionId), keyVersion: 1 },
      capability: 'fireflies.workspace.read', displayName: 'Fireflies · bob@acme.test',
    });
    await env.DB.prepare(`INSERT INTO connector_ingress_routes (
      connection_id, workspace_id, region, connector_type, scope,
      provider_account_id, provider_user_id, status, updated_at
    ) VALUES (?, ?, 'global', 'fireflies', 'workspace', NULL, NULL, 'active', ?)`)
      .bind(connectionId, workspaceId, at).run();
    // The installation runner is what settles a manual create into Action
    // required; in production the Queue delivers it moments after setup.
    await runConnectorInstallation(testEnv, workspaceId, connectionId, new AbortController().signal);
    queue.mockClear();
    return { connectionId, signingSecret };
  }

  return {
    workspaceId, owner, member, stub, testEnv, request, deliver, drainQueue, activities, receipts, installation, setup, queue,
  };
}

function payload(event: string, meetingId = 'meeting-1', timestamp = Date.now()) {
  return JSON.stringify({ event, timestamp, meeting_id: meetingId });
}

describe('the Fireflies workspace installation', () => {
  it('leaves the installation action required until a delivery proves the registration, then makes it current', async () => {
    const f = await fixture();
    const { connectionId, signingSecret } = await f.setup();
    const secret = signingSecret;

    // Nothing but a delivery can verify this registration: the adapter declares
    // create manual and inspect unsupported, so the runner settles the step as
    // action required rather than calling a provider API that does not exist.
    const pending = await f.installation(connectionId);
    expect(pending?.state).toBe('action_required');
    expect(pending?.lastReceivedAt).toBeNull();
    expect(pending?.registrations[0]?.verifiedAt).toBeNull();

    const delivered = await f.deliver(connectionId, payload('meeting.transcribed'), secret);
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(202);

    const verified = await f.installation(connectionId);
    expect(verified?.state).toBe('current');
    expect(verified?.registrations[0]?.state).toBe('current');
    expect(verified?.registrations[0]?.verifiedAt).not.toBeNull();
    expect(verified?.registrations[0]?.error).toBeNull();
    expect(verified?.lastReceivedAt).not.toBeNull();
    expect(verified?.appliedVersion).toBe(verified?.desiredVersion);
  });

  it('lets the dashboard test event verify the registration without writing an activity', async () => {
    const f = await fixture();
    const { connectionId, signingSecret } = await f.setup();
    const secret = signingSecret;
    expect((await f.installation(connectionId))?.state).toBe('action_required');

    // A test event is still a delivery: unsigned, it proves nothing.
    expect((await f.deliver(connectionId, payload('test', 'test_00000000'), secret, null)).status).toBe(401);

    const tested = await f.deliver(connectionId, payload('test', 'test_00000000'), secret);
    expect(tested.status, JSON.stringify(tested.body)).toBe(200);
    expect(tested.body).toEqual({ ping: true });

    // The administrator pressed a button and the connection answered: that is
    // the verification, so Settings says Connected before any meeting exists.
    const verified = await f.installation(connectionId);
    expect(verified?.state).toBe('current');
    expect(verified?.registrations[0]?.verifiedAt).not.toBeNull();
    expect(verified?.lastReceivedAt).not.toBeNull();
    // Nothing to read back for a placeholder meeting, and nothing to dedupe.
    await f.drainQueue('event');
    expect(await f.activities()).toEqual([]);
    expect(await f.receipts()).toBe(0);
  });

  it('rejects an unsigned, mis-signed, stale, or unsubscribed delivery without writing anything', async () => {
    const f = await fixture();
    const { connectionId, signingSecret } = await f.setup();
    const secret = signingSecret;
    const body = payload('meeting.summarized');

    expect((await f.deliver(connectionId, body, secret, null)).status).toBe(401);
    expect((await f.deliver(connectionId, body, secret, `sha256=${'0'.repeat(64)}`)).status).toBe(401);
    expect((await f.deliver(connectionId, body, 'wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww')).status).toBe(401);
    // Correctly signed, but its in-body timestamp is hours old: the only replay
    // anchor Fireflies gives, since it signs the body and nothing else.
    expect((await f.deliver(connectionId, payload('meeting.summarized', 'meeting-1', Date.now() - 7_200_000), secret)).status).toBe(401);
    // Verified, and still refused: an event this connector does not handle.
    // The log line is the half that matters and the half the response cannot
    // prove: `request_failed` never records a refusal's message and withholds
    // its detail values, so without this entry an operator reading Workers Logs
    // sees `request_failed 400 unsupported_webhook_event` and cannot tell which
    // delivery it was. Asserted in-isolate, on the real `console.warn` the
    // logger writes through.
    const warnings = vi.spyOn(console, 'warn');
    const botJoined = await f.deliver(connectionId, payload('meeting.bot_joined'), secret);
    expect(botJoined.status).toBe(400);
    const refusal = ApiFailure.parse(botJoined.body).error;
    expect(refusal.code).toBe('unsupported_webhook_event');
    expect(refusal.message).toContain('meeting.bot_joined');
    expect(refusal.details).toEqual({ provider: 'fireflies', eventType: 'meeting.bot_joined' });
    expect(warnings.mock.calls.map(([entry]) => RefusalLog.safeParse(entry).data).filter(Boolean)).toEqual([{
      event: 'connector_webhook_event_refused',
      connector_type: 'fireflies',
      connection_id: connectionId,
      event_type: 'meeting.bot_joined',
      code: 'unsupported_webhook_event',
    }]);
    warnings.mockRestore();

    await f.drainQueue('event');
    expect(await f.activities()).toEqual([]);
    // Verification precedes the receipt claim, so an unauthenticated caller who
    // knows the URL cannot make Rally write a per-connection row either.
    expect(await f.receipts()).toBe(0);
    // None of them counted as the verifying delivery.
    const stillPending = await f.installation(connectionId);
    expect(stillPending?.state).toBe('action_required');
    expect(stillPending?.lastReceivedAt).toBeNull();
  });

  it('refuses a signed delivery for an event the registration does not carry', async () => {
    const f = await fixture();
    const { connectionId, signingSecret } = await f.setup();
    const secret = signingSecret;
    // Narrow the grant the way a later declaration would: the event is one the
    // connector handles, so this is an authorization answer rather than the
    // "Rally never subscribed to this" refusal above, and the two must not
    // collapse into one code.
    await runInDurableObject(f.stub, (_instance: WorkspaceDO, state) => {
      const row = state.storage.sql.exec<{ document_json: string }>(
        'SELECT document_json FROM connector_installations WHERE connection_id = ?', connectionId).toArray()[0]!;
      const document = JSON.parse(row.document_json) as { selectedEvents: string[]; registrations: { events: string[] }[] };
      document.selectedEvents = ['meeting.summarized'];
      document.registrations[0]!.events = ['meeting.summarized'];
      state.storage.sql.exec('UPDATE connector_installations SET document_json = ? WHERE connection_id = ?',
        JSON.stringify(document), connectionId);
    });

    const refused = await f.deliver(connectionId, payload('meeting.transcribed'), secret);
    expect(refused.status).toBe(401);
    expect(ApiFailure.parse(refused.body).error.code).toBe('event_not_authorized');
    await f.drainQueue('event');
    expect(await f.activities()).toEqual([]);
    expect(await f.receipts()).toBe(0);
  });

  it('reports a correctly signed but stale delivery as a timestamp problem, not a wrong key', async () => {
    const f = await fixture();
    const { connectionId, signingSecret } = await f.setup();
    const stale = await f.deliver(connectionId,
      payload('meeting.summarized', 'meeting-1', Date.now() - 7_200_000), signingSecret);
    expect(stale.status).toBe(401);
    // The distinction is the whole point: telling an administrator their
    // signing secret is wrong when their clock or a replay is the cause sends
    // them to rotate a secret they cannot rotate without reconnecting.
    expect(ApiFailure.parse(stale.body).error.code).toBe('webhook_timestamp_outside_window');
  });

  it('rejects a delivery to a connection the administrator removed', async () => {
    const f = await fixture();
    const { connectionId, signingSecret } = await f.setup();
    const secret = signingSecret;
    expect((await f.deliver(connectionId, payload('meeting.transcribed'), secret)).status).toBe(202);
    await f.drainQueue('event');
    const before = await f.activities();

    const disconnected = await f.request(`/connections/${connectionId}/installation`, f.owner, { action: 'disconnect' });
    expect(disconnected.status, JSON.stringify(disconnected.body)).toBe(200);

    // Fireflies has no delete API, so Rally cannot take the webhook down at the
    // provider; refusing its deliveries is the entire reason a webhook the
    // administrator left behind is harmless.
    const afterRemoval = await f.deliver(connectionId, payload('meeting.summarized', 'meeting-9'), secret);
    expect(afterRemoval.status).toBe(404);
    await f.drainQueue('event');
    expect(await f.activities()).toEqual(before);
  });

  it('refuses a delivery for a disabled connection even with its ingress route intact', async () => {
    const f = await fixture();
    const { connectionId, signingSecret } = await f.setup();
    const secret = signingSecret;
    // Disable the row without going through disconnect, which also retires the
    // ingress route: that route is the outer control, and this is the one
    // underneath it. Removing either predicate has to fail a test on its own,
    // or "defence in depth" is one layer wearing two names.
    await runInDurableObject(f.stub, (_instance: WorkspaceDO, state) => {
      state.storage.sql.exec("UPDATE connector_connections SET status = 'disabled' WHERE id = ?", connectionId);
    });

    expect((await f.deliver(connectionId, payload('meeting.summarized', 'meeting-11'), secret)).status).toBe(404);
    await f.drainQueue('event');
    expect(await f.activities()).toEqual([]);
  });

  it('will not let a delivery revive an installation whose connection is disabled', async () => {
    const f = await fixture();
    const { connectionId } = await f.setup();
    const before = await f.installation(connectionId);
    await runInDurableObject(f.stub, (_instance: WorkspaceDO, state) => {
      state.storage.sql.exec("UPDATE connector_connections SET status = 'disabled' WHERE id = ?", connectionId);
    });

    await f.stub.receiveConnectorInstallationEvent({
      workspaceId: f.workspaceId, connectionId: connectionId, receivedAt: new Date().toISOString(),
      registrationKey: before!.registrations[0]!.key,
      registrationSupport: { create: 'manual', inspect: 'unsupported' },
    });

    const after = await f.installation(connectionId);
    expect(after?.registrations[0]?.state).toBe('action_required');
    expect(after?.registrations[0]?.verifiedAt).toBeNull();
    expect(after?.state).not.toBe('current');
  });

  it('does not let a delivery verify a registration for a provider that can be inspected', async () => {
    const f = await fixture();
    const { connectionId } = await f.setup();
    const before = await f.installation(connectionId);
    expect(before?.registrations[0]?.state).toBe('action_required');

    // The same hook, with the declaration an inspectable provider sends. Ashby
    // and Granola run this path on every delivery, so if the gate goes the
    // weaker claim "something signed correctly once" silently replaces reading
    // the webhook back and comparing its destination and events.
    const at = new Date().toISOString();
    await f.stub.receiveConnectorInstallationEvent({
      workspaceId: f.workspaceId, connectionId: connectionId, receivedAt: at,
      registrationKey: before!.registrations[0]!.key,
      registrationSupport: { create: 'automatic', inspect: 'automatic' },
    });

    const after = await f.installation(connectionId);
    expect(after?.registrations[0]?.state).toBe('action_required');
    expect(after?.registrations[0]?.verifiedAt).toBeNull();
    expect(after?.state).toBe('action_required');
    // The delivery still counts as one, which is the half that always applies.
    expect(after?.lastReceivedAt).toBe(at);
  });

  it('verifies only the registration whose secret signed the delivery', async () => {
    const f = await fixture();
    const { connectionId } = await f.setup();
    // A second registration, as a single_event provider would carry: the
    // delivery names one key, and must not vouch for a subscription the
    // administrator may never have ticked.
    await runInDurableObject(f.stub, (_instance: WorkspaceDO, state) => {
      const row = state.storage.sql.exec<{ document_json: string }>(
        'SELECT document_json FROM connector_installations WHERE connection_id = ?', connectionId).toArray()[0]!;
      const document = JSON.parse(row.document_json) as { registrations: Record<string, unknown>[] };
      document.registrations.push({ ...document.registrations[0]!, key: 'second', stepId: crypto.randomUUID() });
      state.storage.sql.exec('UPDATE connector_installations SET document_json = ? WHERE connection_id = ?',
        JSON.stringify(document), connectionId);
    });

    const before = await f.installation(connectionId);
    await f.stub.receiveConnectorInstallationEvent({
      workspaceId: f.workspaceId, connectionId: connectionId, receivedAt: new Date().toISOString(),
      registrationKey: before!.registrations[0]!.key,
      registrationSupport: { create: 'manual', inspect: 'unsupported' },
    });

    const after = await f.installation(connectionId);
    expect(after?.registrations.find((item) => item.key === before!.registrations[0]!.key)?.state).toBe('current');
    expect(after?.registrations.find((item) => item.key === 'second')?.state).toBe('action_required');
    expect(after?.registrations.find((item) => item.key === 'second')?.verifiedAt).toBeNull();
  });

  it('leaves a verified installation connected when Test finds nothing to repair', async () => {
    const f = await fixture();
    const { connectionId, signingSecret } = await f.setup();
    expect((await f.deliver(connectionId, payload('meeting.transcribed'), signingSecret)).status).toBe(202);
    expect((await f.installation(connectionId))?.state).toBe('current');

    // Test runs a repair. For a provider whose registrations carry no provider
    // id there is nothing to inspect, so no step becomes pending and nothing
    // ever settles — which is why claiming "Updating" here used to strand a
    // working installation until the next real meeting arrived.
    const tested = await f.request(`/connections/${connectionId}/test`, f.owner, {});
    expect(tested.status, JSON.stringify(tested.body)).toBe(200);

    const after = await f.installation(connectionId);
    expect(after?.state).toBe('current');
    expect(after?.registrations[0]?.state).toBe('current');
  });

  it('refuses to adopt a webhook id for a provider that can never confirm one', async () => {
    const f = await fixture();
    const { connectionId } = await f.setup();
    const key = (await f.installation(connectionId))!.registrations[0]!.key;

    // Storing a fabricated provider id would make the registration read as one
    // Rally created: the cleanup advice would start offering to delete a
    // webhook through an API Fireflies does not have.
    const refused = await f.request(`/connections/${connectionId}/installation`, f.owner,
      { action: 'reconcile', key, providerId: 'invented-by-hand' });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(ApiFailure.parse(refused.body).error.code).toBe('connector_reconciliation_unsupported');
    expect((await f.installation(connectionId))?.registrations[0]?.providerId).toBeNull();
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
    const { connectionId, signingSecret } = await f.setup();
    const secret = signingSecret;
    const transcribed = payload('meeting.transcribed', 'meeting-7');
    const summarized = payload('meeting.summarized', 'meeting-7', Date.now() + 1_000);

    expect((await f.deliver(connectionId, transcribed, secret)).status).toBe(202);
    expect((await f.deliver(connectionId, summarized, secret)).status).toBe(202);
    // A byte-identical replay of a delivery Fireflies already made.
    const replay = await f.deliver(connectionId, summarized, secret);
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
    const started = await f.request('/connections/fireflies/start', f.owner, {
      scope: 'personal', capabilities: ['fireflies.personal.read'],
    });
    // The exact refusal, not merely "some failure": an unmapped throw is a 500,
    // which would pass a `>= 400` assertion while telling the administrator
    // nothing and paging somebody.
    expect(started.status, JSON.stringify(started.body)).toBe(422);
    expect(ApiFailure.parse(started.body).error.code).toBe('unsupported_capability');
  });

  it('accepts no new workspace connection, by route or by service', async () => {
    const f = await fixture();
    // The administrator's own setup route is gone with the flow it drove.
    expect((await f.request('/connections/fireflies/workspace', f.owner, {
      apiKey: validApiKey, idempotencyKey: crypto.randomUUID(),
    })).status).toBe(404);
    // And the service behind it refuses the scope rather than relying on the
    // route's absence: one workspace key reads every member's meetings, so a
    // caller that finds another way in is answered, not obliged.
    await expect(new ConnectionService(f.testEnv, f.owner).createWorkspaceInstallation({
      provider: 'fireflies', apiKey: validApiKey, idempotencyKey: crypto.randomUUID(),
    })).rejects.toMatchObject({ status: 422, code: 'connector_scope_not_connectable' });
    const connections = await f.request('/connections', f.owner);
    expect(z.object({ items: z.array(ConnectionSchema) }).parse(connections.body).items).toEqual([]);
  });
});
