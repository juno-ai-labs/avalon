/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asUserId, asWorkspaceId, ConnectorInstallationSchema } from '@rally/contracts';
import type { WorkspaceDO } from '../src/durable-objects/workspace-do';
import { workspaceDOName } from '../src/durable-objects/names';
import { encryptString } from '../src/lib/crypto';
import { ConnectionService } from '../src/services/connection-service';
import { runConnectorInstallation } from '../src/services/connector-installation-service';
import { seedWorkspaceControlPlane } from './helpers/substream-fixture';

beforeEach(async () => { await reset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function fixture(legacyGranola = false) {
  const workspaceId = asWorkspaceId(crypto.randomUUID());
  const userId = asUserId(crypto.randomUUID());
  const sessionId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const key = 'installation-teardown-envelope-key';
  await seedWorkspaceControlPlane(env.DB, { workspaceId, userId, sessionId });
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE connector_ingress_routes (connection_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
      region TEXT NOT NULL, connector_type TEXT NOT NULL, scope TEXT NOT NULL, provider_account_id TEXT,
      provider_user_id TEXT, status TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    env.DB.prepare('CREATE TABLE ashby_connection_routes (connection_id TEXT PRIMARY KEY, region TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL)'),
  ]);
  const stub = env.WORKSPACE_DOS.getByName(workspaceDOName(env.AVALON_REGION, workspaceId));
  await runInDurableObject(stub, (_instance: WorkspaceDO, state) => {
    state.storage.sql.exec(`INSERT INTO workspace_identity
      (id, workspace_id, region, placement_affinity, created_at, updated_at)
      VALUES (1, ?, ?, 'wnam', ?, ?)`, workspaceId, env.AVALON_REGION, Date.now(), Date.now());
  });
  const at = new Date().toISOString();
  if (legacyGranola) {
    await runInDurableObject(stub, (_instance: WorkspaceDO, state) => {
      state.storage.sql.exec(`INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, display_name, encrypted_credentials, credential_iv,
         credential_key_version, granted_scopes_json, model_plugin_id, created_at, updated_at)
        VALUES (?, ?, 'granola', 'workspace', 'Granola workspace', 'invalid-ciphertext', 'invalid-iv',
          1, '["granola.workspace.read"]', 'plugin_granola', ?, ?)`, connectionId, workspaceId, at, at);
    });
  } else {
    await stub.createConnectorInstallation({ installation: ConnectorInstallationSchema.parse({
      workspaceId, connectionId, provider: 'ashby', attemptId: crypto.randomUUID(), generation: 1,
      desiredVersion: 1, appliedVersion: 1, state: 'current', selectedEvents: ['applicationSubmit'],
      createdAt: at, updatedAt: at, lastReceivedAt: null, error: null,
      registrations: [{ key: 'applicationSubmit', events: ['applicationSubmit'], providerId: crypto.randomUUID(),
        destination: `https://ashby.rallywith.ai/ingest/ashby/${connectionId}`, enabled: true,
        state: 'current', action: 'inspect', stepId: crypto.randomUUID(), verifiedAt: at, error: null,
        rotation: 'stable', rotationGeneration: 0, activeSecretRef: 'signing', pendingSecretRef: null }],
    }), userId, inputHash: 'teardown-fixture',
    credentials: { ...await encryptString(JSON.stringify({ apiKey: 'fixture-api-key', signing: 'fixture-signing-secret' }), key, connectionId), keyVersion: 1 },
    capability: 'ashby.workspace.events', displayName: 'Ashby workspace events' });
  }
  await runInDurableObject(stub, (_instance: WorkspaceDO, state) => {
    state.storage.sql.exec(`INSERT INTO schedules
      (id, workspace_id, connector_connection_id, schedule_type, interval_seconds, timezone, next_run_at, enabled, version, created_at, updated_at)
      VALUES (?, ?, ?, 'interval', 60, 'UTC', ?, 1, 1, ?, ?)`, crypto.randomUUID(), workspaceId, connectionId, at, at, at);
  });
  const testEnv = { ...env, APP_ENV: 'development' as const, PUBLIC_API_BASE_URL: 'https://api.example.test', CONNECTOR_CREDENTIALS_KEY: key, CONNECTOR_CREDENTIALS_KEY_VERSION: '1' };
  const service = new ConnectionService(testEnv, { workspaceId, userId, sessionId, role: 'admin', region: env.AVALON_REGION });
  async function assertDisabled() {
    await runInDurableObject(stub, (_instance: WorkspaceDO, state) => {
      expect(state.storage.sql.exec('SELECT status, encrypted_credentials, credential_iv FROM connector_connections WHERE id = ?', connectionId).one())
        .toEqual({ status: 'disabled', encrypted_credentials: null, credential_iv: null });
      expect(state.storage.sql.exec('SELECT enabled FROM schedules WHERE connector_connection_id = ?', connectionId).one()).toEqual({ enabled: 0 });
    });
    expect(await env.DB.prepare('SELECT status FROM connector_ingress_routes WHERE connection_id = ?').bind(connectionId).first()).toEqual({ status: 'disabled' });
  }
  return { stub, workspaceId, userId, connectionId, service, testEnv, assertDisabled };
}

describe('connector installation teardown', () => {
  it('records setup telemetry once for a new reservation without counting idempotent retries', async () => {
    const f = await fixture();
    await f.stub.changeConnectorInstallation({ workspaceId: f.workspaceId, connectionId: f.connectionId, action: 'disconnect' });
    await env.DB.batch([
      env.DB.prepare('ALTER TABLE users ADD COLUMN analytics_person_id TEXT'),
      env.DB.prepare('ALTER TABLE users ADD COLUMN product_analytics_enabled INTEGER NOT NULL DEFAULT 1'),
      env.DB.prepare("ALTER TABLE workspaces ADD COLUMN name TEXT NOT NULL DEFAULT 'Test workspace'"),
      env.DB.prepare(`CREATE TABLE telemetry_profile_jobs (id TEXT PRIMARY KEY, subject_user_id TEXT, workspace_id TEXT,
        job_kind TEXT, destination_analytics_id TEXT, anonymous_epoch_id TEXT, properties_json TEXT, version INTEGER,
        state TEXT, created_at TEXT, delete_at TEXT)`),
      env.DB.prepare(`CREATE TABLE telemetry_accepted_events (event_id TEXT PRIMARY KEY, payload_hash TEXT, envelope_json TEXT,
        route TEXT, routing_basis TEXT, analytics_subject_id TEXT, workspace_analytics_id TEXT, subject_user_id TEXT,
        accepted_at TEXT, normalized_timestamp TEXT, delete_at TEXT, delivery_state TEXT, terminal_code TEXT)`),
      env.DB.prepare(`CREATE TABLE telemetry_delivery_receipts (event_id TEXT PRIMARY KEY, payload_hash TEXT, route TEXT,
        result_code TEXT, created_at TEXT, delete_at TEXT)`),
    ]);
    const input = { provider: 'ashby' as const, apiKey: 'new-workspace-key', idempotencyKey: crypto.randomUUID(), events: ['applicationSubmit'] };
    const first = await f.service.createWorkspaceInstallation(input);
    const retry = await f.service.createWorkspaceInstallation(input);
    expect(retry.installation.connectionId).toBe(first.installation.connectionId);
    const accepted = (await env.DB.prepare("SELECT envelope_json FROM telemetry_accepted_events WHERE json_extract(envelope_json, '$.name') = 'connector_setup_completed_v2'")
      .all<{ envelope_json: string }>()).results;
    expect(accepted).toHaveLength(1);
    expect(JSON.parse(accepted[0]!.envelope_json)).toMatchObject({ name: 'connector_setup_completed_v2',
      context: { operationId: first.installation.connectionId }, properties: { connector: 'ashby', scope: 'workspace', method: 'api_key', result: 'success' } });
    expect(JSON.stringify(accepted)).not.toContain(input.apiKey);
  });

  it('uses complete local teardown through the installation disconnect action', async () => {
    const f = await fixture();
    const disconnected = await f.service.changeInstallation(f.connectionId, { action: 'disconnect' });
    expect(disconnected.installation?.state).toBe('cleanup_pending');
    await f.assertDisabled();
    expect(await env.DB.prepare("SELECT actor_user_id FROM audit_events WHERE target_id = ? AND action = 'connector.disabled'").bind(f.connectionId).first())
      .toEqual({ actor_user_id: f.userId });
  });

  it('still clears local authority and schedules when legacy adoption cannot decrypt credentials', async () => {
    const f = await fixture(true);
    const provider = vi.fn(); vi.stubGlobal('fetch', provider);
    const result = await Promise.allSettled([f.service.disable(f.connectionId)]);
    await f.assertDisabled();
    expect(result[0]?.status).toBe('fulfilled');
    expect(provider).not.toHaveBeenCalled();
  });

  it('finishes local teardown when cleanup Queue submission fails', async () => {
    const f = await fixture();
    vi.spyOn(env.ACTIVITY_QUEUE, 'send').mockRejectedValueOnce(new Error('Injected Queue transport failure'));
    await f.service.disable(f.connectionId);
    await f.assertDisabled();
    const cleanup = await runInDurableObject(f.stub, (_instance: WorkspaceDO, state) =>
      state.storage.sql.exec('SELECT cleanup_ciphertext FROM connector_installations WHERE connection_id = ?', f.connectionId).one());
    expect(cleanup.cleanup_ciphertext).toBeTypeOf('string');
  });

  it('classifies cleanup decryption failure as failed before any provider dispatch', async () => {
    const f = await fixture();
    await f.stub.changeConnectorInstallation({ workspaceId: f.workspaceId, connectionId: f.connectionId, action: 'disconnect' });
    const provider = vi.fn(); vi.stubGlobal('fetch', provider);
    const result = await runConnectorInstallation({ ...f.testEnv, CONNECTOR_CREDENTIALS_KEY: 'wrong-key' }, f.workspaceId, f.connectionId, new AbortController().signal);
    expect(result?.registrations[0]?.state).toBe('failed');
    expect(result?.registrations[0]?.error).not.toContain('may have completed');
    expect(provider).not.toHaveBeenCalled();
  });

  it('returns stable domain refusals for invalid installation actions', async () => {
    const f = await fixture();
    await expect(f.service.changeInstallation(f.connectionId, { action: 'forget_cleanup' })).rejects.toMatchObject({ status: 409, code: 'connector_still_enabled' });
    await expect(f.service.changeInstallation(f.connectionId, { action: 'reconcile', key: 'missing', providerId: crypto.randomUUID() }))
      .rejects.toMatchObject({ status: 409, code: 'connector_reconciliation_invalid' });
    await f.service.changeInstallation(f.connectionId, { action: 'disconnect' });
    await f.service.changeInstallation(f.connectionId, { action: 'forget_cleanup' });
    await expect(f.service.changeInstallation(f.connectionId, { action: 'repair' })).rejects.toMatchObject({ status: 409, code: 'connector_cleanup_credential_unavailable' });
  });

  it('refuses an installation disconnect when the connection has no installation', async () => {
    const f = await fixture(true);
    await expect(f.service.changeInstallation(f.connectionId, { action: 'disconnect' }))
      .rejects.toMatchObject({ status: 404, code: 'connector_installation_not_found' });
    const connection = await runInDurableObject(f.stub, (_instance: WorkspaceDO, state) =>
      state.storage.sql.exec('SELECT status FROM connector_connections WHERE id = ?', f.connectionId).one());
    expect(connection.status).not.toBe('disabled');
  });
});
