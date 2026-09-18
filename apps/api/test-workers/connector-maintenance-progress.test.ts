/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { asWorkspaceId, ConnectorInstallationSchema } from '@rally/contracts';
import type { WorkspaceDO } from '../src/durable-objects/workspace-do';
import { workspaceDOName } from '../src/durable-objects/names';
import {
  __connectorMaintenanceTesting,
  applyConnectorMaintenance,
  connectorMaintenanceStatus,
  previewConnectorMaintenance,
} from '../src/services/connector-maintenance-service';

beforeEach(async () => { await reset(); });

async function frozenOperation() {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE connector_maintenance_operations (
      id TEXT PRIMARY KEY, document_json TEXT NOT NULL CHECK (json_valid(document_json)))`),
    env.DB.prepare(`CREATE TABLE connector_ingress_routes (connection_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL, region TEXT NOT NULL, connector_type TEXT NOT NULL,
      scope TEXT NOT NULL, status TEXT NOT NULL)`),
  ]);
  for (let index = 0; index < 2; index += 1) {
    const workspaceId = asWorkspaceId(crypto.randomUUID());
    const connectionId = crypto.randomUUID();
    const stub = env.WORKSPACE_DOS.getByName(workspaceDOName(env.AVALON_REGION, workspaceId));
    await runInDurableObject(stub, (_instance: WorkspaceDO, state) => {
      state.storage.sql.exec(`INSERT INTO workspace_identity
        (id, workspace_id, region, placement_affinity, created_at, updated_at)
        VALUES (1, ?, ?, 'wnam', ?, ?)`, workspaceId, env.AVALON_REGION, Date.now(), Date.now());
    });
    const at = new Date().toISOString();
    await stub.createConnectorInstallation({
      installation: ConnectorInstallationSchema.parse({
        workspaceId, connectionId, provider: 'ashby', attemptId: crypto.randomUUID(), generation: 1,
        desiredVersion: 1, appliedVersion: null, state: 'setting_up', selectedEvents: ['applicationSubmit'],
        createdAt: at, updatedAt: at, lastReceivedAt: null, error: null,
        registrations: [{ key: 'applicationSubmit', events: ['applicationSubmit'], providerId: null,
          destination: `https://ashby.rallywith.ai/ingest/ashby/${connectionId}`,
          enabled: null, state: 'pending', action: 'create', stepId: crypto.randomUUID(),
          verifiedAt: null, error: null, rotation: 'stable', rotationGeneration: 0,
          activeSecretRef: 'signing', pendingSecretRef: null }],
      }),
      userId: crypto.randomUUID(), inputHash: `progress-fixture-${index}`,
      credentials: { ciphertext: 'unused-encrypted-key', iv: 'unused-iv', keyVersion: 1 },
      capability: 'ashby.workspace.events', displayName: 'Ashby workspace events',
    });
    await env.DB.prepare(`INSERT INTO connector_ingress_routes
      VALUES (?, ?, ?, 'ashby', 'workspace', 'active')`)
      .bind(connectionId, workspaceId, env.AVALON_REGION).run();
  }
  const preview = await previewConnectorMaintenance(env,
    { provider: 'ashby', region: env.AVALON_REGION, version: 1 }, 'progress-test-operator');
  expect(preview.targets).toHaveLength(2);
  expect(preview.targets.map((target) => target.state)).toEqual(['pending', 'pending']);
  await applyConnectorMaintenance(env, preview.id);
  return preview;
}

describe('connector maintenance target progress', () => {
  it('preserves both frozen targets when overlapping deliveries save different outcomes', async () => {
    const preview = await frozenOperation();
    // Both deliveries have read their operation before either writes progress.
    // Exercise the production persistence boundary directly: a full runner can
    // revisit the sibling afterward and conceal an intervening lost update.
    const [firstDelivery, secondDelivery] = await Promise.all([
      connectorMaintenanceStatus(env, preview.id),
      connectorMaintenanceStatus(env, preview.id),
    ]);
    const first = { ...firstDelivery.targets[0]!, state: 'current' as const, reason: null };
    const second = { ...secondDelivery.targets[1]!, state: 'action_required' as const,
      reason: 'The recorded provider registration needs customer action.' };
    await Promise.all([
      __connectorMaintenanceTesting.saveTarget(env, preview.id, 0, first),
      __connectorMaintenanceTesting.saveTarget(env, preview.id, 1, second),
    ]);
    const persisted = await connectorMaintenanceStatus(env, preview.id);
    expect(persisted.targets).toEqual([first, second]);
    // A later result from the same stale snapshot cannot replace a settled target.
    await __connectorMaintenanceTesting.saveTarget(env, preview.id, 0,
      { ...firstDelivery.targets[0]!, state: 'failed', reason: 'Late stale delivery' });
    expect((await connectorMaintenanceStatus(env, preview.id)).targets).toEqual([first, second]);
  });

  it('rejects stale completions after cancellation even before its target sweep', async () => {
    const preview = await frozenOperation();
    const delivery = await connectorMaintenanceStatus(env, preview.id);
    // Stage the durable interval in cancelConnectorMaintenance between its
    // regional cancellation write and the per-workspace cancellation sweep.
    // Targets remain pending, so their settled-target guard cannot mask a
    // missing operation-state check in the production progress write.
    await env.DB.prepare("UPDATE connector_maintenance_operations SET document_json = json_set(document_json, '$.state', 'cancelled') WHERE id = ?")
      .bind(preview.id).run();
    const cancelled = await connectorMaintenanceStatus(env, preview.id);
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.targets.map((target) => target.state)).toEqual(['pending', 'pending']);
    await Promise.all(delivery.targets.map((target, index) =>
      __connectorMaintenanceTesting.saveTarget(env, preview.id, index,
        { ...target, state: 'current', reason: null })));
    expect(await connectorMaintenanceStatus(env, preview.id)).toEqual(cancelled);
  });
});
