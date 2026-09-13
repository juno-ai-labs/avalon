/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { asWorkspaceId, ConnectorInstallationSchema } from '@rally/contracts';
import type { InstallationCreate } from '../src/durable-objects/connector-installation-protocol';
import type { WorkspaceDO } from '../src/durable-objects/workspace-do';
import { workspaceDOName } from '../src/durable-objects/names';
import { decryptString, encryptString } from '../src/lib/crypto';
import { runConnectorInstallation } from '../src/services/connector-installation-service';
import { workspaceRuntimeDatabase } from '../src/services/workspace-runtime-database';

beforeEach(async () => { await reset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const envelopeKey = 'installation-recovery-test-key';
const granolaEvents = ['note.access_granted', 'note.edited', 'note.generated', 'note.regenerated'];

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release: () => release() };
}

// Only WorkspaceDO installation authority is initialized. No agent run or
// inference is relevant to these provider-response and credential races.
async function fixture(provider: 'ashby' | 'granola' = 'ashby') {
  // The registry captures its provider fetch when first used for this Env.
  // A fresh Env keeps each test's provider barrier isolated from its siblings.
  const testEnv = { ...env, CONNECTOR_CREDENTIALS_KEY: envelopeKey, CONNECTOR_CREDENTIALS_KEY_VERSION: '1' };
  const workspaceId = asWorkspaceId(crypto.randomUUID());
  const stub = env.WORKSPACE_DOS.getByName(workspaceDOName(env.AVALON_REGION, workspaceId));
  await runInDurableObject(stub, (_object: WorkspaceDO, state) => {
    state.storage.sql.exec(`INSERT INTO workspace_identity (id, workspace_id, region, placement_affinity, created_at, updated_at)
      VALUES (1, ?, ?, ?, ?, ?)`, workspaceId, env.AVALON_REGION, env.AVALON_REGION === 'eu' ? 'weur' : 'wnam', Date.now(), Date.now());
  });
  const connectionId = crypto.randomUUID();
  const at = new Date().toISOString();
  const events = provider === 'ashby' ? ['applicationSubmit'] : granolaEvents;
  const credentials = provider === 'ashby'
    ? { apiKey: 'original-api-key', signing: 'original-signing-secret' }
    : { apiKey: `grn_${'a'.repeat(32)}` };
  const input: InstallationCreate = {
    installation: ConnectorInstallationSchema.parse({ workspaceId, connectionId, provider,
      attemptId: crypto.randomUUID(), generation: 1, desiredVersion: 1, appliedVersion: null,
      state: 'setting_up', selectedEvents: events, createdAt: at, updatedAt: at, lastReceivedAt: null, error: null,
      registrations: [{ key: events.join('+'), events, providerId: null,
        destination: `https://api.example.test/ingest/${provider}/${connectionId}`, enabled: null,
        state: 'pending', action: 'create', stepId: crypto.randomUUID(), verifiedAt: null, error: null,
        rotation: 'stable', rotationGeneration: 0, activeSecretRef: 'signing', pendingSecretRef: null }],
    }), userId: crypto.randomUUID(), inputHash: 'recovery-test-input-digest',
    credentials: { ...await encryptString(JSON.stringify(credentials), envelopeKey, connectionId), keyVersion: 1 },
    capability: provider === 'ashby' ? 'ashby.workspace.events' : 'granola.workspace.read',
  };
  await stub.createConnectorInstallation(input);
  const coordinates = { workspaceId, connectionId };
  return { stub, input, coordinates,
    run: () => runConnectorInstallation(testEnv, workspaceId, connectionId, new AbortController().signal),
    async readCredentials() {
      const row = await workspaceRuntimeDatabase(testEnv, workspaceId).prepare('SELECT encrypted_credentials, credential_iv FROM connector_connections WHERE id = ?')
        .bind(connectionId).first<{ encrypted_credentials: string; credential_iv: string }>();
      return z.record(z.string(), z.unknown()).parse(JSON.parse(await decryptString(row!.encrypted_credentials, row!.credential_iv, envelopeKey, connectionId)));
    },
  };
}

describe('connector installation recovery', () => {
  it.each(['repair', 'replace_credentials'] as const)('retains a late desired Ashby create after %s', async (action) => {
    const { stub, input, coordinates, run, readCredentials } = await fixture();
    const dispatched = barrier(); const response = barrier();
    const calls: string[] = [];
    const remote = { id: crypto.randomUUID(), enabled: true, webhookType: 'applicationSubmit', requestUrl: input.installation.registrations[0]!.destination };
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const path = new URL(url instanceof Request ? url.url : url).pathname;
      calls.push(path);
      if (path === '/webhook.create') { dispatched.release(); await response.promise; }
      return Response.json({ success: true, results: path === '/apiKey.info' ? {} : path === '/webhook.delete' ? { webhookId: remote.id } : remote });
    }));
    const running = run();
    await dispatched.promise;
    try {
      if (action === 'repair') await stub.changeConnectorInstallation({ ...coordinates, action });
      else await stub.replaceConnectorInstallationCredentials({ ...coordinates, generation: 1,
        credentials: { ...await encryptString(JSON.stringify({ apiKey: 'replacement-api-key', signing: 'original-signing-secret' }), envelopeKey, coordinates.connectionId), keyVersion: 1 } });
    } finally { response.release(); }
    const result = await running;
    expect(result).toMatchObject({ state: 'current', appliedVersion: 1, selectedEvents: ['applicationSubmit'], error: null });
    expect(result?.registrations).toHaveLength(1);
    expect(result?.registrations[0]).toMatchObject({ providerId: remote.id, state: 'current', events: ['applicationSubmit'] });
    expect(calls.filter((path) => path === '/webhook.create')).toHaveLength(1);
    expect(calls).toContain('/webhook.info');
    expect(calls).not.toContain('/webhook.delete');
    expect(await readCredentials()).toEqual({ apiKey: action === 'repair' ? 'original-api-key' : 'replacement-api-key', signing: 'original-signing-secret' });
  });

  it('retains a late Granola identity without restoring its stale credential envelope', async () => {
    const { stub, input, coordinates, run, readCredentials } = await fixture('granola');
    const dispatched = barrier(); const response = barrier();
    const remote = { id: 'whe_1234567890abcd', enabled: true, events: granolaEvents, url: input.installation.registrations[0]!.destination };
    const methods: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      if (init?.method === 'POST') {
        dispatched.release(); await response.promise;
        return Response.json({ ...remote, signing_secret: 'whsec_dGVzdA==' });
      }
      return Response.json({ webhook_endpoints: [remote] });
    }));
    const running = run();
    await dispatched.promise;
    const replacement = { apiKey: `grn_${'b'.repeat(32)}` };
    try {
      await stub.replaceConnectorInstallationCredentials({ ...coordinates, generation: 1,
        credentials: { ...await encryptString(JSON.stringify(replacement), envelopeKey, coordinates.connectionId), keyVersion: 1 } });
    } finally { response.release(); }
    const result = await running;
    expect(result?.state).toBe('action_required');
    expect(result?.registrations[0]).toMatchObject({ providerId: remote.id, providerIdVerified: true, state: 'action_required' });
    expect(await readCredentials()).toEqual(replacement);
    expect(methods).not.toContain('DELETE');
    await stub.changeConnectorInstallation({ ...coordinates, action: 'repair' });
    expect((await run())?.state).toBe('action_required');
    expect(await readCredentials()).toEqual(replacement);
  });

  it('requires Granola signing material after lost-response ID reconciliation and retains exact cleanup authority', async () => {
    const { stub, input, coordinates, run, readCredentials } = await fixture('granola');
    const remote = { id: 'whe_1234567890abcd', enabled: true, events: granolaEvents, url: input.installation.registrations[0]!.destination };
    const deletes: string[] = []; let creates = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(url instanceof Request ? url.url : url).pathname;
      if (init?.method === 'POST') { creates += 1; throw new Error('Response lost after Granola committed the endpoint'); }
      if (init?.method === 'DELETE') { deletes.push(path); return Response.json({}); }
      return Response.json({ webhook_endpoints: [remote] });
    }));
    expect((await run())?.registrations[0]?.state).toBe('unknown');
    await stub.changeConnectorInstallation({ ...coordinates, action: 'reconcile', key: input.installation.registrations[0]!.key, providerId: remote.id });
    const result = await run();
    expect(result).toMatchObject({ state: 'action_required', appliedVersion: null });
    expect(result?.registrations[0]).toMatchObject({ providerId: remote.id, providerIdVerified: true, state: 'action_required' });
    expect(result?.registrations[0]?.error).toContain('signing credential');
    expect(await readCredentials()).toEqual({ apiKey: `grn_${'a'.repeat(32)}` });
    await stub.changeConnectorInstallation({ ...coordinates, action: 'disconnect' });
    expect((await run())?.state).toBe('disconnected');
    expect(deletes).toEqual([`/v1/webhook-endpoints/${remote.id}`]);
    expect(creates).toBe(1);
  });

  it('preserves a removal receipt across repeated disconnect during dispatch and after completion', async () => {
    const { stub, input, coordinates, run } = await fixture();
    const dispatched = barrier(); const response = barrier();
    const remote = { id: crypto.randomUUID(), enabled: true, webhookType: 'applicationSubmit', requestUrl: input.installation.registrations[0]!.destination };
    let deletes = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const path = new URL(url instanceof Request ? url.url : url).pathname;
      if (path === '/webhook.delete') { deletes += 1; dispatched.release(); await response.promise; }
      return Response.json({ success: true, results: path === '/apiKey.info' ? {} : path === '/webhook.delete' ? { webhookId: remote.id } : remote });
    }));
    expect((await run())?.state).toBe('current');
    await stub.changeConnectorInstallation({ ...coordinates, action: 'disconnect' });
    const removing = run();
    await dispatched.promise;
    try {
      const pending = await stub.connectorInstallation(coordinates);
      expect(pending?.registrations[0]?.state).toBe('dispatched');
      expect(await stub.changeConnectorInstallation({ ...coordinates, action: 'disconnect' })).toEqual(pending);
      expect((await run())?.registrations[0]?.state).toBe('dispatched');
    } finally { response.release(); }
    const completed = await removing;
    expect(completed?.state).toBe('disconnected');
    expect(await stub.changeConnectorInstallation({ ...coordinates, action: 'disconnect' })).toEqual(completed);
    expect((await run())?.state).toBe('disconnected');
    expect(deletes).toBe(1);
    await runInDurableObject(stub, (_object: WorkspaceDO, state) => {
      expect(state.storage.sql.exec('SELECT cleanup_ciphertext, cleanup_iv FROM connector_installations WHERE connection_id = ?', coordinates.connectionId).one())
        .toEqual({ cleanup_ciphertext: null, cleanup_iv: null });
    });
  });

  it('fences an API-key replacement snapshot when create settlement adds Granola signing credentials', async () => {
    const { stub, input, coordinates, run, readCredentials } = await fixture('granola');
    const snapshot = await stub.connectorInstallation(coordinates);
    const oldCredentials = await readCredentials();
    const remote = { id: 'whe_1234567890abcd', enabled: true, events: granolaEvents, url: input.installation.registrations[0]!.destination };
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => Response.json(init?.method === 'POST'
      ? { ...remote, signing_secret: 'whsec_dGVzdA==' } : { webhook_endpoints: [remote] })));
    const installed = await run();
    expect(installed?.state).toBe('current');
    const replacement = { ...await encryptString(JSON.stringify({ ...oldCredentials, apiKey: `grn_${'b'.repeat(32)}` }), envelopeKey, coordinates.connectionId), keyVersion: 1 };
    const error = await stub.replaceConnectorInstallationCredentials({ ...coordinates, generation: snapshot!.generation, credentials: replacement })
      .then(() => null, (failure: unknown) => String(failure));
    expect(error).toContain('superseded');
    expect(await readCredentials()).toEqual({ apiKey: `grn_${'a'.repeat(32)}`, signing: 'whsec_dGVzdA==', webhookSigningSecret: 'whsec_dGVzdA==', webhookEndpointId: remote.id });
  });
});
