/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { asWorkspaceId, ConnectorInstallationSchema } from '@rally/contracts';
import { workspaceDOName } from '../src/durable-objects/names';
import type { WorkspaceDO } from '../src/durable-objects/workspace-do';
import { encryptString } from '../src/lib/crypto';
import {
  applyConnectorMaintenance,
  connectorMaintenanceStatus,
  previewConnectorMaintenance,
  runConnectorMaintenance,
} from '../src/services/connector-maintenance-service';

beforeEach(async () => { await reset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('resuming maintenance before Queue preparation', () => {
  it('applies the frozen destination when Resume arrives before the first delivery', async () => {
    const workspaceId = asWorkspaceId(crypto.randomUUID());
    const connectionId = crypto.randomUUID();
    const providerId = crypto.randomUUID();
    const key = 'maintenance-early-resume-envelope-key';
    const at = new Date().toISOString();
    const stub = env.WORKSPACE_DOS.getByName(workspaceDOName(env.AVALON_REGION, workspaceId));
    await runInDurableObject(stub, (_instance: WorkspaceDO, state) => {
      state.storage.sql.exec(`INSERT INTO workspace_identity
        (id, workspace_id, region, placement_affinity, created_at, updated_at)
        VALUES (1, ?, 'global', 'wnam', ?, ?)`, workspaceId, Date.now(), Date.now());
    });
    const originalDestination = `https://api.example.test/ingest/ashby/${connectionId}`;
    await stub.createConnectorInstallation({
      installation: ConnectorInstallationSchema.parse({
        workspaceId, connectionId, provider: 'ashby', attemptId: crypto.randomUUID(), generation: 1,
        desiredVersion: 1, appliedVersion: 1, state: 'current', selectedEvents: ['applicationSubmit'],
        createdAt: at, updatedAt: at, lastReceivedAt: null, error: null,
        registrations: [{ key: 'applicationSubmit', events: ['applicationSubmit'], providerId,
          destination: originalDestination, enabled: true, state: 'current', action: 'inspect',
          stepId: crypto.randomUUID(), verifiedAt: at, error: null, rotation: 'stable', rotationGeneration: 0,
          activeSecretRef: 'signing', pendingSecretRef: null }],
      }),
      userId: crypto.randomUUID(), inputHash: 'maintenance-early-resume-inputs', capability: 'ashby.workspace.events', displayName: 'Ashby workspace events',
      credentials: { ...await encryptString(JSON.stringify({ apiKey: 'provider-fixture-key', signing: 'retained-signing-key' }), key, connectionId), keyVersion: 1 },
    });
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE connector_maintenance_operations (
        id TEXT PRIMARY KEY, document_json TEXT NOT NULL CHECK (json_valid(document_json)))`),
      env.DB.prepare(`CREATE TABLE connector_ingress_routes (connection_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL, region TEXT NOT NULL, connector_type TEXT NOT NULL,
        scope TEXT NOT NULL, status TEXT NOT NULL)`),
      env.DB.prepare("INSERT INTO connector_ingress_routes VALUES (?, ?, 'global', 'ashby', 'workspace', 'active')").bind(connectionId, workspaceId),
    ]);
    const remote = { id: providerId, requestUrl: originalDestination, webhookType: 'applicationSubmit', enabled: true };
    const provider = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      expect(url.origin).toBe('https://api.ashbyhq.com');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Basic ${btoa('provider-fixture-key:')}`);
      const body: unknown = JSON.parse(String(init?.body));
      if (url.pathname === '/webhook.update') {
        const update = z.object({ webhookId: z.literal(providerId), requestUrl: z.string(), enabled: z.literal(true) }).parse(body);
        remote.requestUrl = update.requestUrl;
      } else {
        expect(url.pathname).toBe('/webhook.info');
        expect(body).toEqual({ webhookId: providerId });
      }
      return Response.json({ success: true, results: remote });
    });
    vi.stubGlobal('fetch', provider);
    const testEnv = { ...env, CONNECTOR_CREDENTIALS_KEY: key, CONNECTOR_CREDENTIALS_KEY_VERSION: '1' };
    const preview = await previewConnectorMaintenance(testEnv,
      { provider: 'ashby', region: 'global', version: 1 }, 'early-resume-test-operator');
    expect(preview.targets[0]?.steps).toEqual([{ key: 'applicationSubmit', action: 'update' }]);
    await applyConnectorMaintenance(testEnv, preview.id);

    // Apply has queued the operation, but no Queue delivery has prepared its
    // installation yet. Resume must not replace that preparation with repair.
    await applyConnectorMaintenance(testEnv, preview.id, true);
    await runConnectorMaintenance(testEnv, preview.id, new AbortController().signal);

    const final = await stub.connectorInstallation({ workspaceId, connectionId });
    expect(final).toMatchObject({ state: 'current', maintenanceOperationId: preview.id,
      registrations: [{ destination: preview.targets[0]?.configuration?.registrations[0]?.destination }] });
    expect(remote.requestUrl).not.toBe(originalDestination);
    expect(remote.requestUrl).toBe(preview.targets[0]?.configuration?.registrations[0]?.destination);
    expect(provider.mock.calls.map(([url]) => new URL(url instanceof Request ? url.url : url).pathname)).toEqual(['/webhook.update', '/webhook.info']);
    expect(await connectorMaintenanceStatus(testEnv, preview.id)).toMatchObject({ state: 'complete', targets: [{ state: 'current' }] });
  });
});
