import { planConnectorInstallation } from '../src/services/connector-installation-plan';
import { connectorRegistryForEnv } from '../src/lib/connector-registry';
import { previewConnectorMaintenance, applyConnectorMaintenance, runConnectorMaintenance, connectorMaintenanceStatus, cancelConnectorMaintenance } from '../src/services/connector-maintenance-service';
import AshbyIngressWorker from '../src/ashby-ingress-worker';
import { AshbyRoutingBridge } from '../src/ashby-routing-bridge';
import { AshbyRegionalBridge } from '../src/ashby-regional-bridge';
import { seedOpenWorkstreamAuthority } from './helpers/substream-fixture';
import { ConnectionService } from '../src/services/connection-service';
import { consumeActivityQueue } from '../src/queues/activity-consumer';
import { WorkspaceConnectorEventQueueMessageSchema } from '../src/durable-objects/workspace-connector-event-protocol';
import { applyDurableObjectSqliteMigrations } from '../src/durable-objects/sqlite-migrations';
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from '../src/durable-objects/workspace-do';
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { reset, createExecutionContext, createMessageBatch, getQueueResult, runInDurableObject } from 'cloudflare:test';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { encryptString, decryptString } from '../src/lib/crypto';
import { runConnectorInstallation } from '../src/services/connector-installation-service';
import { workspaceRuntimeDatabase } from '../src/services/workspace-runtime-database';
import { asUserId, asWorkspaceId, ConnectorInstallationSchema } from '@rally/contracts';
import type { WorkspaceDO } from '../src/durable-objects/workspace-do';
import { workspaceDOName } from '../src/durable-objects/names';
import type { InstallationCreate } from '../src/durable-objects/connector-installation-protocol';

beforeEach(async () => { await reset(); });

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function fixture(region: 'global' | 'eu' = env.AVALON_REGION) {
  const workspaceId = asWorkspaceId(crypto.randomUUID());
  const stub = env.WORKSPACE_DOS.getByName(workspaceDOName(region, workspaceId));
  await runInDurableObject(stub, (_instance: WorkspaceDO, state) => {
    state.storage.sql.exec(`INSERT INTO workspace_identity (id, workspace_id, region, placement_affinity, created_at, updated_at)
      VALUES (1, ?, ?, ?, ?, ?)`, workspaceId, region, region === 'eu' ? 'weur' : 'wnam', Date.now(), Date.now());
  });
  const connectionId = crypto.randomUUID();
  const at = new Date().toISOString();
  const input: InstallationCreate = {
    installation: ConnectorInstallationSchema.parse({
      workspaceId, connectionId, provider: 'ashby', attemptId: crypto.randomUUID(), generation: 1,
      desiredVersion: 1, appliedVersion: null, state: 'setting_up', selectedEvents: ['applicationSubmit'],
      createdAt: at, updatedAt: at, lastReceivedAt: null, error: null,
      registrations: [{ key: 'applicationSubmit', events: ['applicationSubmit'], providerId: null,
        destination: `https://api.example.test/ingest/ashby/${connectionId}`, enabled: null, state: 'pending', action: 'create',
        stepId: crypto.randomUUID(), verifiedAt: null, error: null, rotation: 'stable', rotationGeneration: 0,
        activeSecretRef: 'signing', pendingSecretRef: null }],
    }), userId: crypto.randomUUID(), inputHash: 'test-keyed-input-digest',
    credentials: { ciphertext: 'encrypted-provider-key', iv: 'iv', keyVersion: 1 }, capability: 'ashby.workspace.events', displayName: 'Ashby workspace events',
  };
  return { stub, input, workspaceId, connectionId };
}

describe('connector installation authority', () => {
  it('reserves one workspace installation across concurrent administrators and binds retries to inputs', async () => {
    const { stub, input } = await fixture();
    const competing = structuredClone(input);
    competing.installation.connectionId = crypto.randomUUID();
    competing.installation.attemptId = crypto.randomUUID();
    competing.userId = crypto.randomUUID();
    const results = await Promise.allSettled([stub.createConnectorInstallation(input), stub.createConnectorInstallation(competing)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const winner = results[0]!.status === 'fulfilled' ? input : competing;
    expect(await stub.createConnectorInstallation(winner)).toMatchObject({ connectionId: winner.installation.connectionId });
    expect(String(await stub.createConnectorInstallation({ ...winner, inputHash: 'different-inputs' }).then(() => null, (error: unknown) => error))).toContain('idempotency_conflict');
    await runInDurableObject(stub, (_instance: WorkspaceDO, state) => {
      expect(state.storage.sql.exec('SELECT id FROM connector_connections').toArray()).toHaveLength(1);
      expect(state.storage.sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([]);
    });
  });

  it('never grants deletion authority to an unverified administrator-supplied webhook ID', async () => {
    const { stub, input, workspaceId, connectionId } = await fixture();
    await stub.createConnectorInstallation(input);
    const registration = input.installation.registrations[0]!;
    const claim = { workspaceId, connectionId, generation: 1, stepId: registration.stepId };
    await stub.claimConnectorInstallationStep(claim);
    await stub.settleConnectorInstallationStep({ ...claim, registration: { ...registration, state: 'unknown' } });
    await stub.changeConnectorInstallation({ workspaceId, connectionId, action: 'reconcile', key: registration.key, providerId: crypto.randomUUID() });
    const disconnected = await stub.changeConnectorInstallation({ workspaceId, connectionId, action: 'disconnect' });
    const removal = disconnected.registrations[0]!;
    expect(removal.state).toBe('action_required');
    expect((await stub.claimConnectorInstallationStep({ workspaceId, connectionId, generation: disconnected.generation, stepId: removal.stepId })).claimed).toBe(false);
  });

  it('persists pending signing material before rotation and rejects unverified promotion', async () => {
    const { stub, input, workspaceId, connectionId } = await fixture();
    await stub.createConnectorInstallation(input);
    const registration = input.installation.registrations[0]!;
    const claim = { workspaceId, connectionId, generation: 1, stepId: registration.stepId };
    await stub.claimConnectorInstallationStep(claim);
    await stub.settleConnectorInstallationStep({ ...claim, registration: { ...registration, providerId: crypto.randomUUID(), state: 'current' } });
    const prepared = await stub.prepareConnectorInstallationRotation({ workspaceId, connectionId, generation: 1, key: registration.key,
      pendingSecretRef: 'pending-signing', verificationPolicy: 'active_and_pending', credentials: { ciphertext: 'encrypted-old-and-new', iv: 'iv', keyVersion: 1 } });
    await runInDurableObject(stub, (_instance: WorkspaceDO, state) => {
      expect(state.storage.sql.exec('SELECT encrypted_credentials FROM connector_connections WHERE id = ?', connectionId).one()).toMatchObject({ encrypted_credentials: 'encrypted-old-and-new' });
    });
    const pending = prepared.registrations[0]!;
    expect(pending).toMatchObject({ activeSecretRef: 'signing', pendingSecretRef: 'pending-signing', rotation: 'prepared' });
    const dispatch = { workspaceId, connectionId, generation: prepared.generation, stepId: pending.stepId };
    await stub.claimConnectorInstallationStep(dispatch);
    expect(String(await stub.settleConnectorInstallationStep({ ...dispatch, registration: { ...pending, state: 'current', rotation: 'verified' } }).then(() => null, (error: unknown) => error))).toContain('verification_required');
    expect((await stub.connectorInstallation({ workspaceId, connectionId }))?.registrations[0]?.activeSecretRef).toBe('signing');
    const verified = await stub.settleConnectorInstallationStep({ ...dispatch, registration: { ...pending, state: 'current', rotation: 'verified', rotationEvidence: 'synthetic-provider-confirmed-cutover' },
      credentials: { ciphertext: 'encrypted-new-only', iv: 'iv', keyVersion: 1 } });
    expect(verified?.registrations[0]).toMatchObject({ activeSecretRef: 'pending-signing', pendingSecretRef: null, verificationPolicy: 'active' });
  });

  it.each([true, false])('uses the shared rotation protocol and promotes signing material only after cutover evidence: %s', async (verified) => {
    const { stub, input, workspaceId, connectionId } = await fixture();
    const key = 'synthetic-rotation-envelope-key';
    input.installation.registrations[0]!.state = 'current'; input.installation.registrations[0]!.providerId = crypto.randomUUID();
    input.credentials = { ...await encryptString(JSON.stringify({ apiKey: 'test-key', signing: 'original-signing-key' }), key, connectionId), keyVersion: 1 };
    await stub.createConnectorInstallation(input);
    await stub.prepareConnectorInstallationRotation({ workspaceId, connectionId, generation: 1, key: 'applicationSubmit', pendingSecretRef: 'next-signing', verificationPolicy: 'active_and_pending',
      credentials: { ...await encryptString(JSON.stringify({ apiKey: 'test-key', signing: 'original-signing-key', 'next-signing': 'replacement-signing-key' }), key, connectionId), keyVersion: 1 } });
    const testEnv = { ...env, CONNECTOR_CREDENTIALS_KEY: key, CONNECTOR_CREDENTIALS_KEY_VERSION: '1' };
    const adapter = connectorRegistryForEnv(testEnv).get('ashby');
    const dispatch = vi.fn(async () => {
      const row = await workspaceRuntimeDatabase(testEnv, workspaceId).prepare('SELECT encrypted_credentials, credential_iv FROM connector_connections WHERE id = ?').bind(connectionId).first<{ encrypted_credentials: string; credential_iv: string }>();
      expect(JSON.parse(await decryptString(row!.encrypted_credentials, row!.credential_iv, key, connectionId))).toMatchObject({ signing: 'original-signing-key', 'next-signing': 'replacement-signing-key' });
    });
    adapter.installationManagement = { ...adapter.installationManagement!, support: { ...adapter.installationManagement!.support, rotate: 'automatic' }, rotation: {
      verificationPolicy: 'active_and_pending', dispatch, verify: async () => ({ verified, evidence: verified ? 'authenticated-synthetic-provider-cutover' : '' }),
    } };
    const result = await runConnectorInstallation(testEnv, workspaceId, connectionId, new AbortController().signal);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(result?.registrations[0]).toMatchObject(verified ? { state: 'current', activeSecretRef: 'next-signing', pendingSecretRef: null } : { state: 'unknown', activeSecretRef: 'signing', pendingSecretRef: 'next-signing' });
    const row = await workspaceRuntimeDatabase(testEnv, workspaceId).prepare('SELECT encrypted_credentials, credential_iv FROM connector_connections WHERE id = ?').bind(connectionId).first<{ encrypted_credentials: string; credential_iv: string }>();
    const stored = JSON.parse(await decryptString(row!.encrypted_credentials, row!.credential_iv, key, connectionId));
    expect(stored['next-signing']).toBe('replacement-signing-key');
    expect(stored.signing).toBe(verified ? undefined : 'original-signing-key');
    if (!verified) {
      const repaired = await stub.changeConnectorInstallation({ workspaceId, connectionId, action: 'repair' });
      expect(repaired.state).toBe('action_required');
      const afterRepair = await runConnectorInstallation(testEnv, workspaceId, connectionId, new AbortController().signal);
      expect(dispatch).toHaveBeenCalledOnce();
      expect(afterRepair?.registrations[0]).toMatchObject({ state: 'unknown', pendingSecretRef: 'next-signing', activeSecretRef: 'signing' });
    }
  });

  it('claims a provider step once and rejects stale settlements', async () => {
    const { stub, input, workspaceId, connectionId } = await fixture();
    await stub.createConnectorInstallation(input);
    const registration = input.installation.registrations[0]!;
    const claim = { workspaceId, connectionId, generation: 1, stepId: registration.stepId };
    const claims = await Promise.all([stub.claimConnectorInstallationStep(claim), stub.claimConnectorInstallationStep(claim)]);
    expect(claims.filter((value) => value.claimed)).toHaveLength(1);
    const changed = await stub.changeConnectorInstallation({ workspaceId, connectionId, action: 'repair' });
    expect(changed.registrations[0]?.state).toBe('unknown');
    const stale = await stub.settleConnectorInstallationStep({ ...claim, registration: { ...registration, state: 'current', verifiedAt: new Date().toISOString() } });
    expect(stale?.state).toBe('action_required');
    expect(stale?.registrations[0]?.verifiedAt).toBeNull();
  });

  it('disables locally before cleanup and retains a late remote create for exact removal', async () => {
    const { stub, input, workspaceId, connectionId } = await fixture();
    await stub.createConnectorInstallation(input);
    const registration = input.installation.registrations[0]!;
    const claim = { workspaceId, connectionId, generation: 1, stepId: registration.stepId };
    await stub.claimConnectorInstallationStep(claim);
    await stub.changeConnectorInstallation({ workspaceId, connectionId, action: 'disconnect' });
    await runInDurableObject(stub, (_instance: WorkspaceDO, state) => {
      expect(state.storage.sql.exec('SELECT status, encrypted_credentials FROM connector_connections WHERE id = ?', connectionId).one()).toMatchObject({ status: 'disabled', encrypted_credentials: null });
    });
    const providerId = crypto.randomUUID();
    const late = await stub.settleConnectorInstallationStep({ ...claim, registration: { ...registration, providerId, state: 'pending', action: 'inspect' } });
    expect(late?.registrations).toHaveLength(1);
    expect(late?.registrations[0]).toMatchObject({ providerId, action: 'remove', state: 'pending' });
    const cleanup = { workspaceId, connectionId, generation: late!.generation, stepId: late!.registrations[0]!.stepId };
    expect(String(await stub.connectorInstallationCleanup(cleanup).then(() => null, (error: unknown) => error))).toContain('not_authorized');
    await stub.claimConnectorInstallationStep(cleanup);
    expect(await stub.connectorInstallationCleanup(cleanup)).toMatchObject({ providerId, encrypted_credentials: 'encrypted-provider-key' });
    expect(String(await stub.connectorInstallationCleanup({ ...cleanup, generation: 1 }).then(() => null, (error: unknown) => error))).toContain('not_authorized');
    await stub.settleConnectorInstallationStep({ ...cleanup, registration: { ...late!.registrations[0]!, state: 'removed' } });
    await runInDurableObject(stub, (_instance: WorkspaceDO, state) => {
      expect(state.storage.sql.exec('SELECT cleanup_ciphertext FROM connector_installations WHERE connection_id = ?', connectionId).one()).toMatchObject({ cleanup_ciphertext: null });
    });
    expect((await stub.connectorInstallation({ workspaceId, connectionId }))?.state).toBe('disconnected');
  });

  it('cannot dispatch after forgetting cleanup', async () => {
    const { stub, input, workspaceId, connectionId } = await fixture();
    await stub.createConnectorInstallation(input);
    const registration = input.installation.registrations[0]!;
    const claim = { workspaceId, connectionId, generation: 1, stepId: registration.stepId };
    await stub.claimConnectorInstallationStep(claim);
    await stub.settleConnectorInstallationStep({ ...claim, registration: { ...registration, providerId: crypto.randomUUID(), state: 'current' } });
    const disabled = await stub.changeConnectorInstallation({ workspaceId, connectionId, action: 'disconnect' });
    await stub.changeConnectorInstallation({ workspaceId, connectionId, action: 'forget_cleanup' });
    expect((await stub.claimConnectorInstallationStep({ workspaceId, connectionId, generation: disabled.generation, stepId: disabled.registrations[0]!.stepId })).claimed).toBe(false);
  });
  it('runs Ashby create, verification, explicit repair and isolated removal without duplicate registrations', async () => {
    const { stub, input, workspaceId, connectionId } = await fixture();
    const key = 'installation-test-envelope-key';
    input.credentials = { ...await encryptString(JSON.stringify({ apiKey: 'provider-test-key', signing: 'test-signing-material' }), key, connectionId), keyVersion: 1 };
    await stub.createConnectorInstallation(input);
    const testEnv = { ...env, CONNECTOR_CREDENTIALS_KEY: key, CONNECTOR_CREDENTIALS_KEY_VERSION: '1' };
    const calls: string[] = [];
    const remote = { id: crypto.randomUUID(), requestUrl: input.installation.registrations[0]!.destination, webhookType: 'applicationSubmit', enabled: true };
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = new URL(url instanceof Request ? url.url : url);
      if (target.origin !== 'https://api.ashbyhq.com') throw new Error(`Unexpected provider ${target.origin}`);
      calls.push(target.pathname);
      const request = JSON.parse(String(init?.body));
      if (target.pathname === '/webhook.create') {
        expect(request).toEqual({ webhookType: 'applicationSubmit', requestUrl: remote.requestUrl, secretToken: 'test-signing-material' });
        const persisted = await stub.connectorInstallation({ workspaceId, connectionId });
        expect(persisted?.registrations[0]?.state).toBe('dispatched');
      }
      if (target.pathname === '/webhook.update') { expect(request.webhookId).toBe(remote.id); remote.enabled = true; }
      return Response.json({ success: true, results: target.pathname === '/apiKey.info' ? { title: 'Test', createdAt: new Date().toISOString(), scopes: [] }
        : target.pathname === '/webhook.delete' ? { webhookId: remote.id } : remote });
    }));
    expect((await runConnectorInstallation(testEnv, workspaceId, connectionId, new AbortController().signal))?.state).toBe('current');
    await runConnectorInstallation(testEnv, workspaceId, connectionId, new AbortController().signal);
    expect(calls.filter((path) => path === '/webhook.create')).toHaveLength(1);
    remote.enabled = false;
    await stub.changeConnectorInstallation({ workspaceId, connectionId, action: 'repair' });
    expect((await runConnectorInstallation(testEnv, workspaceId, connectionId, new AbortController().signal))?.state).toBe('current');
    expect(calls.filter((path) => path === '/webhook.update')).toHaveLength(1);
    await stub.changeConnectorInstallation({ workspaceId, connectionId, action: 'disconnect' });
    expect((await runConnectorInstallation(testEnv, workspaceId, connectionId, new AbortController().signal))?.state).toBe('disconnected');
    expect(calls.filter((path) => path === '/webhook.delete')).toHaveLength(1);
    expect(calls.filter((path) => path === '/webhook.create')).toHaveLength(1);
  });

  it('keeps an uncertain Ashby create unresolved across queue redelivery and explicit repair', async () => {
    const { stub, input, workspaceId, connectionId } = await fixture();
    const key = 'installation-test-envelope-key';
    input.credentials = { ...await encryptString(JSON.stringify({ apiKey: 'test-key', signing: 'test-signing-material' }), key, connectionId), keyVersion: 1 };
    await stub.createConnectorInstallation(input);
    let creates = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const path = new URL(url instanceof Request ? url.url : url).pathname;
      if (path === '/apiKey.info') return Response.json({ success: true, results: {} });
      creates += 1;
      throw new Error('Network response lost after remote commit');
    }));
    const testEnv = { ...env, CONNECTOR_CREDENTIALS_KEY: key, CONNECTOR_CREDENTIALS_KEY_VERSION: '1' };
    await runConnectorInstallation(testEnv, workspaceId, connectionId, new AbortController().signal);
    await stub.changeConnectorInstallation({ workspaceId, connectionId, action: 'repair' });
    const retried = await runConnectorInstallation(testEnv, workspaceId, connectionId, new AbortController().signal);
    expect(creates).toBe(1);
    expect(retried?.registrations[0]?.state).toBe('unknown');
  });

  it('creates Granola through the shared runner and stores its returned secret only in the encrypted envelope', async () => {
    const { stub, input, workspaceId, connectionId } = await fixture();
    const key = 'installation-test-envelope-key';
    const events = ['note.access_granted', 'note.edited', 'note.generated', 'note.regenerated'];
    input.installation.provider = 'granola'; input.installation.selectedEvents = events;
    input.installation.registrations[0]!.events = events;
    input.installation.registrations[0]!.destination = `https://api.example.test/ingest/granola/${connectionId}`;
    input.capability = 'granola.workspace.read';
    input.credentials = { ...await encryptString(JSON.stringify({ apiKey: `grn_${'a'.repeat(32)}` }), key, connectionId), keyVersion: 1 };
    await stub.createConnectorInstallation(input);
    let creates = 0;
    const remote = { id: 'whe_1234567890abcd', url: input.installation.registrations[0]!.destination, events, enabled: true };
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST') { creates += 1; return Response.json({ ...remote, signing_secret: 'whsec_dGVzdA==' }); }
      return Response.json({ webhook_endpoints: [remote] });
    }));
    const testEnv = { ...env, CONNECTOR_CREDENTIALS_KEY: key, CONNECTOR_CREDENTIALS_KEY_VERSION: '1' };
    const installed = await runConnectorInstallation(testEnv, workspaceId, connectionId, new AbortController().signal);
    expect(installed?.state).toBe('current');
    expect(creates).toBe(1);
    expect(JSON.stringify(installed)).not.toContain('whsec_dGVzdA==');
    const row = await workspaceRuntimeDatabase(testEnv, workspaceId).prepare('SELECT encrypted_credentials, credential_iv FROM connector_connections WHERE id = ?').bind(connectionId).first<{ encrypted_credentials: string; credential_iv: string }>();
    expect(JSON.parse(await decryptString(row!.encrypted_credentials, row!.credential_iv, key, connectionId))).toMatchObject({ webhookEndpointId: remote.id, webhookSigningSecret: 'whsec_dGVzdA==' });
  });

  it('adopts Granola without changing the existing credential, ID, legacy destination, or grouped subscription', async () => {
    const { stub, input, workspaceId, connectionId } = await fixture();
    const key = 'adoption-test-envelope-key';
    const events = ['note.access_granted', 'note.edited', 'note.generated', 'note.regenerated'];
    const providerId = 'whe_1234567890abcd';
    const destination = `https://api.with-avalon.com/ingest/granola/${connectionId}`;
    input.installation.provider = 'granola'; input.installation.selectedEvents = events;
    input.installation.registrations[0] = { ...input.installation.registrations[0]!, events, providerId,
      adoptingExistingDestination: true, destination: `https://api.rallywith.ai/ingest/granola/${connectionId}`,
      action: 'inspect', activeSecretRef: 'webhookSigningSecret' };
    input.capability = 'granola.workspace.read'; input.adopt = true;
    input.credentials = { ...await encryptString(JSON.stringify({ apiKey: `grn_${'a'.repeat(32)}`, webhookEndpointId: providerId, webhookSigningSecret: 'whsec_dGVzdA==' }), key, connectionId), keyVersion: 1 };
    await runInDurableObject(stub, (_object: WorkspaceDO, state) => {
      state.storage.sql.exec(`INSERT INTO connector_connections (id, workspace_id, connector_type, scope, display_name, encrypted_credentials, credential_iv, credential_key_version, granted_scopes_json, model_plugin_id, created_at, updated_at)
        VALUES (?, ?, 'granola', 'workspace', 'Existing Granola', ?, ?, 1, ?, 'plugin_existing_granola', ?, ?)`, connectionId, workspaceId, input.credentials.ciphertext, input.credentials.iv, JSON.stringify([input.capability]), input.installation.createdAt, input.installation.createdAt);
    });
    const provider = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method && init.method !== 'GET') throw new Error('Adoption must not mutate Granola');
      return Response.json({ webhook_endpoints: [{ id: providerId, url: destination, events, enabled: true }] });
    });
    vi.stubGlobal('fetch', provider);
    await stub.createConnectorInstallation(input);
    expect(provider).not.toHaveBeenCalled();
    const installed = await runConnectorInstallation({ ...env, CONNECTOR_CREDENTIALS_KEY: key, CONNECTOR_CREDENTIALS_KEY_VERSION: '1' }, workspaceId, connectionId, new AbortController().signal);
    expect(installed?.state).toBe('current');
    expect(installed?.registrations[0]).toMatchObject({ providerId, destination, events, activeSecretRef: 'webhookSigningSecret' });
    await runInDurableObject(stub, (_object: WorkspaceDO, state) => {
      expect(state.storage.sql.exec('SELECT encrypted_credentials, credential_iv, model_plugin_id FROM connector_connections WHERE id = ?', connectionId).one()).toEqual({ encrypted_credentials: input.credentials.ciphertext, credential_iv: input.credentials.iv, model_plugin_id: 'plugin_existing_granola' });
    });
    expect(provider).toHaveBeenCalled();
  });

  it('replaces credentials atomically, preserving unknown provider outcomes and rejecting stale or disabled replacements', async () => {
    const { stub, input, workspaceId, connectionId } = await fixture();
    await stub.createConnectorInstallation(input);
    const registration = input.installation.registrations[0]!;
    await stub.claimConnectorInstallationStep({ workspaceId, connectionId, generation: 1, stepId: registration.stepId });
    const replacement = { ciphertext: 'replacement-encrypted-api-key-and-original-signing-key', iv: 'replacement-iv', keyVersion: 1 };
    const changed = await stub.replaceConnectorInstallationCredentials({ workspaceId, connectionId, generation: 1, credentials: replacement });
    expect(changed.generation).toBe(2);
    expect(changed.registrations[0]?.state).toBe('unknown');
    await runInDurableObject(stub, (_object: WorkspaceDO, state) => {
      expect(state.storage.sql.exec('SELECT encrypted_credentials FROM connector_connections WHERE id = ?', connectionId).one()).toMatchObject({ encrypted_credentials: replacement.ciphertext });
    });
    expect(String(await stub.replaceConnectorInstallationCredentials({ workspaceId, connectionId, generation: 1, credentials: input.credentials }).then(() => null, (error: unknown) => error))).toContain('superseded');
    await stub.changeConnectorInstallation({ workspaceId, connectionId, action: 'disconnect' });
    expect(String(await stub.replaceConnectorInstallationCredentials({ workspaceId, connectionId, generation: 3, credentials: replacement }).then(() => null, (error: unknown) => error))).toContain('superseded');
  });

  it('plans only granted events and refuses retiring a subscription before its replacement is verified', async () => {
    const { stub, input, workspaceId, connectionId } = await fixture();
    const old = input.installation.registrations[0]!;
    old.state = 'current'; old.providerId = crypto.randomUUID();
    // A reviewed grouping change replaces the single registration. A newly
    // declared event is deliberately absent from the customer's existing grant.
    input.installation.selectedEvents = ['applicationSubmit', 'candidateStageChange'];
    await stub.createConnectorInstallation(input);
    const management = { ...connectorRegistryForEnv(env).get('ashby').installationManagement!, grouping: 'grouped' as const, events: ['applicationSubmit', 'candidateStageChange', 'new-unapproved-event'] };
    const plan = planConnectorInstallation(input.installation, management, old.destination);
    expect(plan.selectedEvents).toEqual(input.installation.selectedEvents);
    expect(plan.registrations.some((registration) => registration.events.includes('new-unapproved-event'))).toBe(false);
    const prepared = await stub.prepareConnectorInstallationMaintenance({ workspaceId, connectionId, generation: 1, operationId: crypto.randomUUID(), version: 1,
      configuration: { selectedEvents: plan.selectedEvents, registrations: plan.registrations } });
    const removal = prepared.registrations.find((registration) => registration.action === 'remove')!;
    const replacement = prepared.registrations.find((registration) => registration.action === 'create')!;
    expect((await stub.claimConnectorInstallationStep({ workspaceId, connectionId, generation: prepared.generation, stepId: removal.stepId })).claimed).toBe(false);
    const claim = { workspaceId, connectionId, generation: prepared.generation, stepId: replacement.stepId };
    await stub.claimConnectorInstallationStep(claim);
    await stub.settleConnectorInstallationStep({ ...claim, registration: { ...replacement, state: 'current', providerId: crypto.randomUUID() } });
    const repaired = await stub.changeConnectorInstallation({ workspaceId, connectionId, action: 'repair' });
    const cleanup = repaired.registrations.find((registration) => registration.key === removal.key)!;
    expect(cleanup.action).toBe('remove');
    expect(cleanup.afterRegistrationKeys).toEqual(removal.afterRegistrationKeys);
    // Repair re-inspects the replacement; deletion must still wait for that proof.
    expect((await stub.claimConnectorInstallationStep({ workspaceId, connectionId, generation: repaired.generation, stepId: cleanup.stepId })).claimed).toBe(false);
    const check = repaired.registrations.find((registration) => registration.key === replacement.key)!;
    const checkClaim = { workspaceId, connectionId, generation: repaired.generation, stepId: check.stepId };
    await stub.claimConnectorInstallationStep(checkClaim);
    await stub.settleConnectorInstallationStep({ ...checkClaim, registration: { ...check, state: 'current' } });
    const cleanupClaim = { workspaceId, connectionId, generation: repaired.generation, stepId: cleanup.stepId };
    expect((await stub.claimConnectorInstallationStep(cleanupClaim)).claimed).toBe(true);
    await stub.settleConnectorInstallationStep({ ...cleanupClaim, registration: { ...cleanup, state: 'removed' } });
    const again = await stub.changeConnectorInstallation({ workspaceId, connectionId, action: 'repair' });
    expect(again.registrations.find((registration) => registration.key === cleanup.key)?.state).toBe('removed');
  });

  it('surfaces a synthetic provider manual capability without dispatching or claiming readiness', async () => {
    const { stub, input, workspaceId, connectionId } = await fixture();
    await stub.createConnectorInstallation(input);
    const testEnv = { ...env };
    const adapter = connectorRegistryForEnv(testEnv).get('ashby');
    adapter.installationManagement = { ...adapter.installationManagement!, support: { ...adapter.installationManagement!.support, create: 'manual' }, manualInstructions: 'Create the exact recorded destination in the provider dashboard, then supply its ID for inspection.' };
    const provider = vi.fn(); vi.stubGlobal('fetch', provider);
    const result = await runConnectorInstallation(testEnv, workspaceId, connectionId, new AbortController().signal);
    expect(result?.state).toBe('action_required');
    expect(result?.registrations[0]?.error).toContain('exact recorded destination');
    expect(provider).not.toHaveBeenCalled();
  });

  it('recovers an undispatched version mismatch through Test after the matching Worker is available', async () => {
    const { stub, input, workspaceId, connectionId } = await fixture();
    const key = 'version-handoff-envelope-key';
    input.installation.desiredVersion = 2;
    input.credentials = { ...await encryptString(JSON.stringify({ apiKey: 'test-key', signing: 'signing-key' }), key, connectionId), keyVersion: 1 };
    await stub.createConnectorInstallation(input);
    const remote = { id: crypto.randomUUID(), requestUrl: input.installation.registrations[0]!.destination, webhookType: 'applicationSubmit', enabled: true };
    const provider = vi.fn(async (url: string | URL | Request) => Response.json({ success: true, results: String(url).endsWith('/apiKey.info') ? {} : remote }));
    vi.stubGlobal('fetch', provider);
    const testEnv = { ...env, CONNECTOR_CREDENTIALS_KEY: key };
    const result = await runConnectorInstallation(testEnv, workspaceId, connectionId, new AbortController().signal);
    expect(result?.registrations[0]?.error).toContain('configuration version');
    expect(provider).not.toHaveBeenCalled();
    const adapter = connectorRegistryForEnv(testEnv).get('ashby');
    adapter.installationManagement = { ...adapter.installationManagement!, version: 2 };
    await stub.changeConnectorInstallation({ workspaceId, connectionId, action: 'repair' });
    const recovered = await runConnectorInstallation(testEnv, workspaceId, connectionId, new AbortController().signal);
    expect(recovered?.state).toBe('current');
    expect(recovered?.appliedVersion).toBe(2);
    expect(provider.mock.calls.filter(([url]) => String(url).endsWith('/webhook.create'))).toHaveLength(1);
  });

  it('retirement refuses new dispatch and stale settlement without accessing the provider', async () => {
    const { stub, input, workspaceId, connectionId } = await fixture();
    await stub.createConnectorInstallation(input);
    const registration = input.installation.registrations[0]!;
    const claim = { workspaceId, connectionId, generation: 1, stepId: registration.stepId };
    await stub.claimConnectorInstallationStep(claim);
    await stub.beginWorkspaceRetirement({ retiredAt: Date.now(), operationId: crypto.randomUUID(), actorUserId: null, reason: 'operator_retirement' });
    const provider = vi.fn(); vi.stubGlobal('fetch', provider);
    const result = await runConnectorInstallation(env, workspaceId, connectionId, new AbortController().signal).then(() => null, (error: unknown) => error);
    expect(String(result)).toContain('retired');
    const settled = await stub.settleConnectorInstallationStep({ ...claim, registration: { ...registration, state: 'current', providerId: crypto.randomUUID() } }).then(() => null, (error: unknown) => error);
    expect(String(settled)).toContain('retired');
    expect(provider).not.toHaveBeenCalled();
  });

  it('checks all dedicated ingress dependencies before reporting healthy', async () => {
    await seedOpenWorkstreamAuthority(env.DB);
    const router = new AshbyRoutingBridge(createExecutionContext(), env);
    const globalBridge = new AshbyRegionalBridge(createExecutionContext(), { ...env, AVALON_REGION: 'global' });
    const euBridge = new AshbyRegionalBridge(createExecutionContext(), { ...env, AVALON_REGION: 'eu' });
    const bindings = { GLOBAL_ASHBY_ROUTER: router, GLOBAL_ASHBY_BRIDGE: globalBridge, EU_ASHBY_BRIDGE: euBridge };
    const worker = new AshbyIngressWorker(createExecutionContext(), bindings);
    const request = () => new Request('https://ashby.rallywith.ai/health');
    // Missing directory migration must fail readiness before any provider call.
    expect((await worker.fetch(request())).status).toBe(503);
    await env.DB.exec(`CREATE TABLE ashby_connection_routes (connection_id TEXT PRIMARY KEY, region TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    expect((await worker.fetch(request())).status).toBe(200);
    const miswired = new AshbyIngressWorker(createExecutionContext(), { ...bindings, EU_ASHBY_BRIDGE: globalBridge });
    expect((await miswired.fetch(request())).status).toBe(503);
  });

  it.each(['global', 'eu'] as const)('routes the dedicated Ashby host to %s authority with unchanged signed bytes', async (region) => {
    const { stub, input, workspaceId, connectionId } = await fixture(region);
    const key = 'regional-envelope-test-key';
    const secret = 'regional-signing-test-key';
    input.credentials = { ...await encryptString(JSON.stringify({ apiKey: 'test-key', signing: secret }), key, connectionId), keyVersion: 1 };
    await stub.createConnectorInstallation(input);
    await seedOpenWorkstreamAuthority(env.DB);
    await env.DB.exec(`CREATE TABLE ashby_connection_routes (connection_id TEXT PRIMARY KEY, region TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE connector_ingress_routes (connection_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, region TEXT NOT NULL, connector_type TEXT NOT NULL, scope TEXT NOT NULL, provider_account_id TEXT, provider_user_id TEXT, status TEXT NOT NULL, updated_at TEXT NOT NULL);`);
    await env.DB.prepare("INSERT INTO connector_ingress_routes VALUES (?, ?, ?, 'ashby', 'workspace', NULL, NULL, 'active', ?)").bind(connectionId, workspaceId, region, new Date().toISOString()).run();
    const router = new AshbyRoutingBridge(createExecutionContext(), env);
    expect(await router.registerRoute({ connectionId, region, status: 'active' })).toEqual({ ok: true, value: { registered: true } });
    // Each bridge holds a distinct credential key. Routing EU to Global cannot
    // accidentally verify using the target workspace's key in this test.
    const regionalEnv = { ...env, CONNECTOR_CREDENTIALS_KEY: key, CONNECTOR_CREDENTIALS_KEY_VERSION: '1' };
    const globalBridge = new AshbyRegionalBridge(createExecutionContext(), { ...regionalEnv, AVALON_REGION: 'global', ...(region === 'eu' ? { CONNECTOR_CREDENTIALS_KEY: 'wrong-global-key' } : {}) });
    const euBridge = new AshbyRegionalBridge(createExecutionContext(), { ...regionalEnv, AVALON_REGION: 'eu', ...(region === 'global' ? { CONNECTOR_CREDENTIALS_KEY: 'wrong-eu-key' } : {}) });
    const worker = new AshbyIngressWorker(createExecutionContext(), { GLOBAL_ASHBY_ROUTER: router, GLOBAL_ASHBY_BRIDGE: globalBridge, EU_ASHBY_BRIDGE: euBridge });
    const bytes = new TextEncoder().encode('{ "action": "ping", "data": { "webhookActionType": "ping" } }');
    const signing = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = 'sha256=' + Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', signing, bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const deliver = (signatureValue: string) => worker.fetch(new Request(`https://ashby.rallywith.ai/ingest/ashby/${connectionId}`, { method: 'POST', body: bytes, headers: { 'Ashby-Signature': signatureValue } }));
    const accepted = await deliver(signature);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ping: true });
    expect((await deliver('sha256=' + '0'.repeat(64))).status).toBe(401);
    expect((await worker.fetch(new Request('https://ashby.rallywith.ai/connections'))).status).toBe(404);
    await router.registerRoute({ connectionId, region, status: 'disabled' });
    expect((await deliver(signature)).status).toBe(404);
  });

  it('freezes maintenance targets, performs no provider work during preview, and resumes without duplicating creates', async () => {
    const { stub, input, workspaceId, connectionId } = await fixture();
    const key = 'maintenance-test-envelope-key';
    input.credentials = { ...await encryptString(JSON.stringify({ apiKey: 'test-key', signing: 'signing-key' }), key, connectionId), keyVersion: 1 };
    await stub.createConnectorInstallation(input);
    await env.DB.exec(`CREATE TABLE connector_maintenance_operations (id TEXT PRIMARY KEY, document_json TEXT NOT NULL CHECK(json_valid(document_json)));
      CREATE TABLE connector_ingress_routes (connection_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, region TEXT NOT NULL, connector_type TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL);`);
    await env.DB.prepare("INSERT INTO connector_ingress_routes VALUES (?, ?, 'global', 'ashby', 'workspace', 'active')").bind(connectionId, workspaceId).run();
    const remote = { id: crypto.randomUUID(), requestUrl: input.installation.registrations[0]!.destination, webhookType: 'applicationSubmit', enabled: true };
    const provider = vi.fn(async (url: string | URL | Request) => Response.json({ success: true, results: new URL(url instanceof Request ? url.url : url).pathname === '/apiKey.info' ? {} : remote }));
    vi.stubGlobal('fetch', provider);
    const testEnv = { ...env, ASHBY_INGRESS_BASE_URL: 'https://api.example.test', CONNECTOR_CREDENTIALS_KEY: key, CONNECTOR_CREDENTIALS_KEY_VERSION: '1' };
    const preview = await previewConnectorMaintenance(testEnv, { provider: 'ashby', region: 'global', version: 1 }, 'ace-test-operator');
    expect(provider).not.toHaveBeenCalled();
    expect(preview.targets).toHaveLength(1);
    expect(preview.targets[0]?.steps).toEqual([{ key: 'applicationSubmit', action: 'create' }]);
    const later = await fixture();
    later.input.credentials = { ...await encryptString(JSON.stringify({ apiKey: 'later-key', signing: 'later-signing-key' }), key, later.connectionId), keyVersion: 1 };
    await later.stub.createConnectorInstallation(later.input);
    await env.DB.prepare("INSERT INTO connector_ingress_routes VALUES (?, ?, 'global', 'ashby', 'workspace', 'active')").bind(later.connectionId, later.workspaceId).run();
    const sent = vi.spyOn(env.ACTIVITY_QUEUE, 'send');
    async function consumeAppliedMaintenance() {
      sent.mockClear();
      await applyConnectorMaintenance(testEnv, preview.id);
      const messages = sent.mock.calls.map(([body]) => body);
      const batch = createMessageBatch('avalon-do-runtime-test-activity', messages.map((body) => ({ id: crypto.randomUUID(), timestamp: new Date(), body, attempts: 1 })));
      await consumeActivityQueue(batch, testEnv);
      expect((await getQueueResult(batch, createExecutionContext())).retryMessages).toEqual([]);
    }
    await consumeAppliedMaintenance();
    await consumeAppliedMaintenance();
    const completed = await connectorMaintenanceStatus(testEnv, preview.id);
    expect(completed.state).toBe('complete');
    expect(completed.targets).toHaveLength(1);
    expect((await later.stub.connectorInstallation({ workspaceId: later.workspaceId, connectionId: later.connectionId }))?.registrations[0]?.state).toBe('pending');
    expect(completed.targets[0]?.state).toBe('current');
    expect(provider.mock.calls.filter(([url]) => String(url).endsWith('/webhook.create'))).toHaveLength(1);
  });

  it('refuses resume of an unapplied preview without changing its frozen configuration', async () => {
    const { stub, input, workspaceId, connectionId } = await fixture();
    await stub.createConnectorInstallation(input);
    await env.DB.exec(`CREATE TABLE connector_maintenance_operations (id TEXT PRIMARY KEY, document_json TEXT NOT NULL CHECK(json_valid(document_json)));
      CREATE TABLE connector_ingress_routes (connection_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, region TEXT NOT NULL, connector_type TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL);`);
    await env.DB.prepare("INSERT INTO connector_ingress_routes VALUES (?, ?, 'global', 'ashby', 'workspace', 'active')").bind(connectionId, workspaceId).run();
    const preview = await previewConnectorMaintenance(env, { provider: 'ashby', region: 'global', version: 1 }, 'ace-test-operator');
    await expect(applyConnectorMaintenance(env, preview.id, true)).rejects.toMatchObject({ code: 'connector_maintenance_not_applied', status: 409 });
    expect(await connectorMaintenanceStatus(env, preview.id)).toEqual(preview);
    expect((await stub.connectorInstallation({ workspaceId, connectionId }))?.generation).toBe(1);
  });

  it('settles maintenance when a failed replacement leaves dependency-blocked removal pending', async () => {
    const { stub, input, workspaceId, connectionId } = await fixture();
    const key = 'blocked-maintenance-envelope-key';
    input.credentials = { ...await encryptString(JSON.stringify({ apiKey: 'test-key', signing: 'old-signing-key' }), key, connectionId), keyVersion: 1 };
    input.installation.selectedEvents = ['applicationSubmit', 'candidateStageChange'];
    input.installation.state = 'current'; input.installation.appliedVersion = 1;
    const original = input.installation.registrations[0]!;
    original.key = input.installation.selectedEvents.join('+');
    original.events = input.installation.selectedEvents;
    original.state = 'current'; original.providerId = crypto.randomUUID();
    await stub.createConnectorInstallation(input);
    await env.DB.exec(`CREATE TABLE connector_maintenance_operations (id TEXT PRIMARY KEY, document_json TEXT NOT NULL CHECK(json_valid(document_json)));
      CREATE TABLE connector_ingress_routes (connection_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, region TEXT NOT NULL, connector_type TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL);`);
    await env.DB.prepare("INSERT INTO connector_ingress_routes VALUES (?, ?, 'global', 'ashby', 'workspace', 'active')").bind(connectionId, workspaceId).run();
    const provider = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/apiKey.info')) return Response.json({ success: true, results: {} });
      throw new Error('Provider create response lost');
    });
    vi.stubGlobal('fetch', provider);
    const testEnv = { ...env, CONNECTOR_CREDENTIALS_KEY: key };
    const preview = await previewConnectorMaintenance(testEnv, { provider: 'ashby', region: 'global', version: 1 }, 'ace-test-operator');
    await applyConnectorMaintenance(testEnv, preview.id);
    await runConnectorMaintenance(testEnv, preview.id, new AbortController().signal);
    const completed = await connectorMaintenanceStatus(testEnv, preview.id);
    expect(completed.state).toBe('complete');
    expect(completed.targets[0]?.state).toBe('action_required');
    const installation = (await stub.connectorInstallation({ workspaceId, connectionId }))!;
    expect(installation.registrations.some((registration) => registration.action === 'create' && registration.state === 'unknown')).toBe(true);
    expect(installation.registrations.find((registration) => registration.providerId === original.providerId)).toMatchObject({ action: 'remove', state: 'pending' });
    expect(provider.mock.calls.some(([url]) => String(url).endsWith('/webhook.delete'))).toBe(false);
  });

  it('previews and applies a destination update without recreating the subscription, even with concurrent Queue deliveries', async () => {
    const { stub, input, workspaceId, connectionId } = await fixture();
    const key = 'destination-maintenance-envelope-key';
    input.credentials = { ...await encryptString(JSON.stringify({ apiKey: 'test-key', signing: 'signing-key' }), key, connectionId), keyVersion: 1 };
    input.installation.state = 'current'; input.installation.appliedVersion = 1;
    input.installation.registrations[0]!.state = 'current'; input.installation.registrations[0]!.providerId = crypto.randomUUID();
    await stub.createConnectorInstallation(input);
    await env.DB.exec(`CREATE TABLE connector_maintenance_operations (id TEXT PRIMARY KEY, document_json TEXT NOT NULL CHECK(json_valid(document_json)));
      CREATE TABLE connector_ingress_routes (connection_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, region TEXT NOT NULL, connector_type TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL);`);
    await env.DB.prepare("INSERT INTO connector_ingress_routes VALUES (?, ?, 'global', 'ashby', 'workspace', 'active')").bind(connectionId, workspaceId).run();
    const remote = { id: input.installation.registrations[0]!.providerId, requestUrl: input.installation.registrations[0]!.destination, webhookType: 'applicationSubmit', enabled: true };
    const provider = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(url instanceof Request ? url.url : url).pathname;
      if (path === '/webhook.update') remote.requestUrl = JSON.parse(String(init?.body)).requestUrl;
      if (path === '/webhook.create' || path === '/webhook.delete') throw new Error('A destination update preserves the existing subscription');
      return Response.json({ success: true, results: path === '/apiKey.info' ? {} : remote });
    });
    vi.stubGlobal('fetch', provider);
    const testEnv = { ...env, CONNECTOR_CREDENTIALS_KEY: key, CONNECTOR_CREDENTIALS_KEY_VERSION: '1' };
    const preview = await previewConnectorMaintenance(testEnv, { provider: 'ashby', region: 'global', version: 1 }, 'ace-test-operator');
    expect(provider).not.toHaveBeenCalled();
    expect(preview.targets[0]?.steps).toEqual([{ key: 'applicationSubmit', action: 'update' }]);
    expect(preview.targets[0]?.configuration?.registrations[0]?.destination).toBe(`https://ashby.rallywith.ai/ingest/ashby/${connectionId}`);
    await applyConnectorMaintenance(testEnv, preview.id);
    await Promise.all([runConnectorMaintenance(testEnv, preview.id, new AbortController().signal), runConnectorMaintenance(testEnv, preview.id, new AbortController().signal)]);
    const completed = await connectorMaintenanceStatus(testEnv, preview.id);
    expect(completed.targets[0]?.state).toBe('current');
    expect(completed.state).toBe('complete');
    expect(provider.mock.calls.filter(([url]) => String(url).endsWith('/webhook.update'))).toHaveLength(1);
    expect(remote.requestUrl).toBe(`https://ashby.rallywith.ai/ingest/ashby/${connectionId}`);
  });

  it('cancels prepared maintenance and fences subsequent dispatch and stale in-flight completion', async () => {
    const { stub, input, workspaceId, connectionId } = await fixture();
    await stub.createConnectorInstallation(input);
    await env.DB.exec(`CREATE TABLE connector_maintenance_operations (id TEXT PRIMARY KEY, document_json TEXT NOT NULL CHECK(json_valid(document_json)));
      CREATE TABLE connector_ingress_routes (connection_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, region TEXT NOT NULL, connector_type TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL);`);
    await env.DB.prepare("INSERT INTO connector_ingress_routes VALUES (?, ?, 'global', 'ashby', 'workspace', 'active')").bind(connectionId, workspaceId).run();
    const preview = await previewConnectorMaintenance(env, { provider: 'ashby', region: 'global', version: 1 }, 'ace-test-operator');
    await applyConnectorMaintenance(env, preview.id);
    const prepared = await stub.prepareConnectorInstallationMaintenance({ workspaceId, connectionId, operationId: preview.id, generation: 1, version: 1 });
    const registration = prepared.registrations[0]!;
    const claim = { workspaceId, connectionId, generation: prepared.generation, stepId: registration.stepId };
    await stub.claimConnectorInstallationStep(claim);
    expect((await cancelConnectorMaintenance(env, preview.id)).state).toBe('cancelled');
    const late = await stub.settleConnectorInstallationStep({ ...claim, registration: { ...registration, providerId: crypto.randomUUID(), state: 'pending', action: 'inspect' } });
    expect(late?.maintenanceCancelled).toBe(true);
    expect((await stub.claimConnectorInstallationStep({ workspaceId, connectionId, generation: late!.generation, stepId: late!.registrations[0]!.stepId })).claimed).toBe(false);
    const provider = vi.fn(); vi.stubGlobal('fetch', provider);
    await runConnectorMaintenance(env, preview.id, new AbortController().signal);
    await runConnectorInstallation(env, workspaceId, connectionId, new AbortController().signal);
    expect(provider).not.toHaveBeenCalled();
  });

  it('loads only the owner personal MCP catalog while workspace inventory stays empty and cannot repair subscriptions', async () => {
    const { stub, input, workspaceId, connectionId } = await fixture();
    const key = 'inventory-envelope-key';
    input.credentials = { ...await encryptString(JSON.stringify({ apiKey: 'workspace-key', signing: 'workspace-signing-key' }), key, connectionId), keyVersion: 1 };
    await stub.createConnectorInstallation(input);
    const personalId = crypto.randomUUID();
    const encrypted = await encryptString(JSON.stringify({ accessToken: 'personal-access-token' }), key, personalId);
    await runInDurableObject(stub, (_object: WorkspaceDO, state) => {
      state.storage.sql.exec(`INSERT INTO connector_connections (id, workspace_id, connector_type, scope, owner_user_id, display_name, encrypted_credentials, credential_iv, granted_scopes_json, model_plugin_id, created_at, updated_at)
        VALUES (?, ?, 'ashby', 'personal', ?, 'Ashby personal', ?, ?, '["ashby.personal.mcp"]', 'plugin_ashby_inventory_personal', ?, ?)`, personalId, workspaceId, input.userId, encrypted.ciphertext, encrypted.iv, input.installation.createdAt, input.installation.createdAt);
    });
    const provider = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://mcp.ashbyhq.com/mcp/v1');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer personal-access-token');
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      const request = JSON.parse(String(init?.body));
      if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: '2.0', id: request.id, result: request.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: {} }
        : { tools: [{ name: 'fixture_live_tool', inputSchema: { type: 'object' } }] } });
    });
    vi.stubGlobal('fetch', provider);
    const testEnv = { ...env, CONNECTOR_CREDENTIALS_KEY: key, CONNECTOR_CREDENTIALS_KEY_VERSION: '1', PUBLIC_API_BASE_URL: 'https://api.example.test' };
    const auth = { workspaceId, userId: asUserId(input.userId), region: 'global' as const, role: 'member' as const, sessionId: 'fixture-session' };
    const service = new ConnectionService(testEnv, auth);
    expect(await service.getToolCount(connectionId, new AbortController().signal)).toEqual({ count: 0 });
    expect(provider).not.toHaveBeenCalled();
    expect(await service.getToolCount(personalId, new AbortController().signal)).toEqual({ count: 1 });
    const calls = provider.mock.calls.length;
    await expect(new ConnectionService(testEnv, { ...auth, userId: asUserId(crypto.randomUUID()) }).getToolCount(personalId, new AbortController().signal)).rejects.toMatchObject({ status: 404 });
    expect(provider).toHaveBeenCalledTimes(calls);
    provider.mockRejectedValue(new Error('MCP unavailable'));
    await expect(service.getToolCount(personalId, new AbortController().signal)).rejects.toThrow();
    expect(await service.getToolCount(connectionId, new AbortController().signal)).toEqual({ count: 0 });
    expect((await stub.connectorInstallation({ workspaceId, connectionId }))?.registrations[0]?.state).toBe('pending');
    await runInDurableObject(stub, (_object: WorkspaceDO, state) => {
      expect(state.storage.sql.exec('SELECT status FROM connector_connections WHERE id = ?', connectionId).one()).toMatchObject({ status: 'healthy' });
    });
  });

  it('admits authenticated Ashby retries through the real Queue into one canonical event and isolates pings', async () => {
    const { stub, input, workspaceId, connectionId } = await fixture();
    const key = 'ingress-test-envelope-key';
    const secret = 'ingress-test-signing-key';
    input.credentials = { ...await encryptString(JSON.stringify({ apiKey: 'test-key', signing: secret }), key, connectionId), keyVersion: 1 };
    await stub.createConnectorInstallation(input);
    await env.DB.exec(`CREATE TABLE IF NOT EXISTS connector_ingress_routes (connection_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, region TEXT NOT NULL, connector_type TEXT NOT NULL, scope TEXT NOT NULL, provider_account_id TEXT, provider_user_id TEXT, status TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    await env.DB.prepare(`INSERT INTO connector_ingress_routes VALUES (?, ?, 'global', 'ashby', 'workspace', NULL, NULL, 'active', ?)`)
      .bind(connectionId, workspaceId, new Date().toISOString()).run();
    const testEnv = { ...env, CONNECTOR_CREDENTIALS_KEY: key, CONNECTOR_CREDENTIALS_KEY_VERSION: '1' };
    const sent = vi.spyOn(env.ACTIVITY_QUEUE, 'send');
    const signingKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    async function deliver(payload: unknown, valid = true) {
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      const digest = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', signingKey, bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
      return new ConnectionService(testEnv).ingestAshbyWebhook(connectionId, bytes, new Headers({ 'Ashby-Signature': `sha256=${valid ? digest : '0'.repeat(64)}` }));
    }
    const ping = { action: 'ping', data: { webhookActionType: 'ping' } };
    expect(await deliver(ping)).toEqual({ ping: true });
    expect(sent).not.toHaveBeenCalled();
    const payload = { action: 'applicationSubmit', webhookActionId: 'stable-provider-id', data: { application: { id: 'application-id', candidate: { id: 'candidate-id', name: 'Sensitive' } } } };
    await expect(deliver(payload, false)).rejects.toMatchObject({ status: 401 });
    expect(sent).not.toHaveBeenCalled();
    await deliver(payload);
    await deliver(payload);
    const messages = sent.mock.calls.map(([body]) => WorkspaceConnectorEventQueueMessageSchema.safeParse(body)).filter((parsed) => parsed.success).map((parsed) => parsed.data);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.request.event.activity.occurredAt).toBe(messages[1]!.request.event.activity.occurredAt);
    const batch = createMessageBatch('avalon-do-runtime-test-activity', messages.map((body, index) => ({ id: `ashby-${index}`, timestamp: new Date(), body, attempts: 1 })));
    await consumeActivityQueue(batch, testEnv);
    const result = await getQueueResult(batch, createExecutionContext());
    expect(result.retryMessages).toEqual([]);
    await runInDurableObject(stub, (_instance: WorkspaceDO, state) => {
      const events = state.storage.sql.exec('SELECT provider_event_id, event_type FROM workspace_connector_events').toArray();
      expect(events).toEqual([{ provider_event_id: 'stable-provider-id', event_type: 'applicationSubmit' }]);
    });
    const changed = { ...payload, data: { application: { id: 'different-application' } } };
    await deliver(changed);
    const latest = sent.mock.calls.map(([body]) => WorkspaceConnectorEventQueueMessageSchema.safeParse(body)).filter((parsed) => parsed.success).at(-1)!.data;
    const conflictBatch = createMessageBatch('avalon-do-runtime-test-activity', [{ id: 'changed', timestamp: new Date(), body: latest, attempts: 1 }]);
    await consumeActivityQueue(conflictBatch, testEnv);
    expect((await getQueueResult(conflictBatch, createExecutionContext())).retryMessages).toEqual([]);
    await runInDurableObject(stub, (_instance: WorkspaceDO, state) => {
      expect(state.storage.sql.exec('SELECT provider_resource_id FROM workspace_connector_events').toArray()).toEqual([{ provider_resource_id: 'application-id' }]);
    });
    await stub.changeConnectorInstallation({ workspaceId, connectionId, action: 'disconnect' });
    await expect(deliver(payload)).rejects.toMatchObject({ status: 404 });
  });

  it('upgrades populated v52 connection state without changing Granola secrets, identities, or receipts', async () => {
    const probe = env.MIGRATION_PROBE_DO!.getByName(`ashby-upgrade-${crypto.randomUUID()}`);
    await probe.ping();
    const connectionId = crypto.randomUUID(); const workspaceId = crypto.randomUUID(); const at = new Date().toISOString();
    await runInDurableObject(probe, (_instance, state) => {
      applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 52), component: 'workspace_do', workerVersionId: 'before-ashby', now: Date.now() });
      state.storage.sql.exec(`INSERT INTO workspace_identity (id, workspace_id, region, placement_affinity, created_at, updated_at) VALUES (1, ?, 'global', 'wnam', ?, ?)`, workspaceId, Date.now(), Date.now());
      state.storage.sql.exec(`INSERT INTO connector_connections (id, workspace_id, connector_type, scope, display_name, encrypted_credentials, credential_iv, model_plugin_id, created_at, updated_at)
        VALUES (?, ?, 'granola', 'workspace', 'Existing Granola', 'original-ciphertext', 'original-iv', 'plugin_original', ?, ?)`, connectionId, workspaceId, at, at);
      state.storage.sql.exec(`INSERT INTO webhook_receipts (id, workspace_id, connection_id, signature_hash, received_at, expires_at) VALUES (?, ?, ?, 'existing-delivery', ?, ?)`, crypto.randomUUID(), workspaceId, connectionId, at, at);
    });
    await runInDurableObject(probe, (_instance, state) => {
      applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS, component: 'workspace_do', workerVersionId: 'after-ashby', now: Date.now() });
      expect(state.storage.sql.exec('SELECT id, encrypted_credentials, credential_iv, model_plugin_id FROM connector_connections').toArray()).toEqual([{ id: connectionId, encrypted_credentials: 'original-ciphertext', credential_iv: 'original-iv', model_plugin_id: 'plugin_original' }]);
      expect(state.storage.sql.exec('SELECT signature_hash FROM webhook_receipts').toArray()).toEqual([{ signature_hash: 'existing-delivery' }]);
      expect(state.storage.sql.exec('PRAGMA foreign_key_check').toArray()).toEqual([]);
    });
  });

});
