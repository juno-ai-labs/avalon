/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { asWorkspaceId, ConnectorInstallationSchema } from '@rally/contracts';
import { workspaceDOName } from '../src/durable-objects/names';
import type { WorkspaceDO } from '../src/durable-objects/workspace-do';

beforeEach(async () => { await reset(); });

describe('connector installation claim generation', () => {
  it('rejects the old generation even when maintenance preserves the pending step identity', async () => {
    const workspaceId = asWorkspaceId(crypto.randomUUID());
    const connectionId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const stub = env.WORKSPACE_DOS.getByName(workspaceDOName(env.AVALON_REGION, workspaceId));
    await runInDurableObject(stub, (_instance: WorkspaceDO, state) => {
      state.storage.sql.exec(`INSERT INTO workspace_identity
        (id, workspace_id, region, placement_affinity, created_at, updated_at)
        VALUES (1, ?, 'global', 'wnam', ?, ?)`, workspaceId, Date.now(), Date.now());
    });
    const at = new Date().toISOString();
    const installation = ConnectorInstallationSchema.parse({
      workspaceId, connectionId, provider: 'ashby', attemptId: crypto.randomUUID(), generation: 1,
      desiredVersion: 1, appliedVersion: null, state: 'setting_up', selectedEvents: ['applicationSubmit'],
      createdAt: at, updatedAt: at, lastReceivedAt: null, error: null,
      registrations: [{ key: 'applicationSubmit', events: ['applicationSubmit'], providerId: null,
        destination: `https://ashby.rallywith.ai/ingest/ashby/${connectionId}`, enabled: null,
        state: 'pending', action: 'create', stepId, verifiedAt: null, error: null,
        rotation: 'stable', rotationGeneration: 0, activeSecretRef: 'signing', pendingSecretRef: null }],
    });
    await stub.createConnectorInstallation({ installation, userId: crypto.randomUUID(), inputHash: 'unchanged-step-generation-fixture',
      capability: 'ashby.workspace.events', credentials: { ciphertext: 'not-decrypted-by-claim', iv: 'unused-iv', keyVersion: 1 } });
    // A reviewed plan can retain a pending registration verbatim while moving
    // the installation generation. No state or step-ID check may mask its fence.
    const prepared = await stub.prepareConnectorInstallationMaintenance({ workspaceId, connectionId,
      operationId: crypto.randomUUID(), generation: installation.generation, version: 1,
      configuration: { selectedEvents: installation.selectedEvents, registrations: installation.registrations } });
    expect(prepared.generation).toBe(2);
    expect(prepared.maintenanceCancelled).toBe(false);
    expect(prepared.registrations[0]).toMatchObject({ stepId, state: 'pending', action: 'create', afterRegistrationKeys: [] });

    const stale = await stub.claimConnectorInstallationStep({ workspaceId, connectionId, generation: 1, stepId });
    expect(stale.claimed).toBe(false);
    expect(stale.installation?.registrations[0]).toMatchObject({ stepId, state: 'pending' });
    await runInDurableObject(stub, (_instance: WorkspaceDO, state) => {
      expect(state.storage.sql.exec('SELECT step_id FROM connector_installation_steps').toArray()).toEqual([]);
      expect(state.storage.sql.exec('SELECT status FROM connector_connections WHERE id = ?', connectionId).one()).toMatchObject({ status: 'healthy' });
    });
    const current = await stub.claimConnectorInstallationStep({ workspaceId, connectionId, generation: prepared.generation, stepId });
    expect(current.claimed).toBe(true);
    await runInDurableObject(stub, (_instance: WorkspaceDO, state) => {
      expect(state.storage.sql.exec('SELECT step_id, generation, state FROM connector_installation_steps').toArray()).toEqual([
        { step_id: stepId, generation: 2, state: 'dispatched' },
      ]);
    });
  });
});
