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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

beforeEach(async () => { await reset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('overlapping connector maintenance claims', () => {
  it('keeps a target pending when a stale claim observes the winning delivery ready to inspect', async () => {
    const workspaceId = asWorkspaceId(crypto.randomUUID());
    const connectionId = crypto.randomUUID();
    const providerId = crypto.randomUUID();
    const key = 'maintenance-claim-race-envelope-key';
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
      userId: crypto.randomUUID(), inputHash: 'maintenance-claim-race-inputs', capability: 'ashby.workspace.events', displayName: 'Ashby workspace events',
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
      { provider: 'ashby', region: 'global', version: 1 }, 'claim-race-test-operator');
    expect(preview.targets[0]?.steps).toEqual([{ key: 'applicationSubmit', action: 'update' }]);
    await applyConnectorMaintenance(testEnv, preview.id);

    const firstClaimEntered = deferred();
    const secondClaimEntered = deferred();
    const inspectionClaimEntered = deferred();
    const allowFirstClaim = deferred();
    const allowStaleClaim = deferred();
    const allowInspectionClaim = deferred();
    const requests: Array<{ stepId: string; generation: number }> = [];
    const results: Array<{ index: number; claimed: boolean; registrationStates: string[] }> = [];
    let restoreClaim: (() => void) | undefined;
    let firstDelivery = Promise.resolve();
    let secondDelivery = Promise.resolve();
    let whileInspectionPaused: Awaited<ReturnType<typeof connectorMaintenanceStatus>> | undefined;

    try {
      await runInDurableObject(stub, (instance: WorkspaceDO) => {
        const originalClaim = instance.claimConnectorInstallationStep.bind(instance);
        // workerd deliberately refuses own-instance RPC methods. Keep the
        // instrument on the real class prototype, where production dispatches.
        const prototype = Reflect.getPrototypeOf(instance);
        if (!prototype) throw new Error('WorkspaceDO claim prototype is missing');
        const claim = vi.spyOn(prototype as WorkspaceDO, 'claimConnectorInstallationStep').mockImplementation(async (request) => {
          const index = requests.length;
          requests.push({ stepId: request.stepId, generation: request.generation });
          if (index === 0) { firstClaimEntered.resolve(); await allowFirstClaim.promise; }
          if (index === 1) { secondClaimEntered.resolve(); await allowStaleClaim.promise; }
          if (index === 2) { inspectionClaimEntered.resolve(); await allowInspectionClaim.promise; }
          // Instrument only scheduling. Every claim and its returned outcome
          // still comes from the real WorkspaceDO transaction and SQLite state.
          const result = await originalClaim(request);
          results.push({ index, claimed: result.claimed,
            registrationStates: result.installation?.registrations.map((registration) => registration.state) ?? [] });
          return result;
        });
        restoreClaim = () => { claim.mockRestore(); };
      });

      firstDelivery = runConnectorMaintenance(testEnv, preview.id, new AbortController().signal);
      await Promise.race([firstClaimEntered.promise, firstDelivery.then(() => { throw new Error('First delivery completed without entering its claim'); })]);
      secondDelivery = runConnectorMaintenance(testEnv, preview.id, new AbortController().signal);
      await Promise.race([secondClaimEntered.promise, secondDelivery.then(() => { throw new Error('Second delivery completed without entering its claim'); })]);
      allowFirstClaim.resolve();
      // The winner has committed the update and is ready to inspect. The
      // duplicate still carries the old update step, so its real claim loses.
      await Promise.race([inspectionClaimEntered.promise, firstDelivery.then(() => { throw new Error('First delivery completed before inspection claim'); })]);
      allowStaleClaim.resolve();
      await secondDelivery;
      whileInspectionPaused = await connectorMaintenanceStatus(testEnv, preview.id);
    } finally {
      allowFirstClaim.resolve();
      allowStaleClaim.resolve();
      allowInspectionClaim.resolve();
      await Promise.allSettled([firstDelivery, secondDelivery]);
      restoreClaim?.();
    }
    await Promise.all([firstDelivery, secondDelivery]);

    expect(requests).toHaveLength(3);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[2]?.stepId).not.toBe(requests[0]?.stepId);
    expect(results.find((result) => result.index === 1)).toEqual({ index: 1, claimed: false, registrationStates: ['pending'] });
    expect(whileInspectionPaused).toMatchObject({ state: 'running', targets: [{ state: 'pending' }] });
    expect(await connectorMaintenanceStatus(testEnv, preview.id)).toMatchObject({ state: 'complete', targets: [{ state: 'current' }] });
    // The staged promises cross object I/O contexts. Resolve a fresh RPC stub
    // for this final observation instead of reusing the fixture's I/O handle.
    const finalStub = env.WORKSPACE_DOS.getByName(workspaceDOName(env.AVALON_REGION, workspaceId));
    expect((await finalStub.connectorInstallation({ workspaceId, connectionId }))?.state).toBe('current');
    expect(provider.mock.calls.map(([url]) => new URL(url instanceof Request ? url.url : url).pathname)).toEqual(['/webhook.update', '/webhook.info']);
  });
});
