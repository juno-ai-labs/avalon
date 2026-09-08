/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createCloudflareTestBinding } from '../test/helpers/cloudflare-test';
import { asSubstreamId, asUserId, asWorkspaceId } from '@rally/contracts';
import { AUTHORIZATION_PROJECTION_MIGRATION, flushAuthorizationDeliveries, flushAuthorizationProjection } from '../src/durable-objects/authorization-projection';
import { AuthorizationStorage } from '../src/durable-objects/authorization-storage';
import { type AuthorizationSnapshot } from '../src/services/authorization-policy';

const workspaceId = asWorkspaceId('00000000-0000-7000-8000-000000000b01');
const parentId = '00000000-0000-7000-8000-000000000b02';
const resourceId = '00000000-0000-7000-8000-000000000b03';

describe('authorization SQLite state', () => {
  it('tracks discovery completeness without an activation step', async () => {
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName('authorization-storage-coverage'));
    await stub.initializeWorkspace(workspaceId, 'wnam');
    expect(await stub.authorizationBackfillStatus({ workspaceId })).toMatchObject({ complete: true });
    await stub.registerAuthorizationChildren({ workspaceId, parentId, substreamIds: ['0'] });
    expect(await stub.authorizationBackfillStatus({ workspaceId })).toMatchObject({ complete: false, pendingChildren: 1 });
    await stub.applyAuthorizationLocations({ workspaceId, parentId, substreamId: '0', parentKind: 'workstream',
      revision: 1, validatedAt: Date.now(), resourceIds: [resourceId] });
    expect(await stub.authorizationBackfillStatus({ workspaceId })).toMatchObject({ complete: true, pendingChildren: 0 });
    await stub.registerAuthorizationChildren({ workspaceId, parentId, substreamIds: [] });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec('SELECT * FROM authorization_locations').toArray()).toEqual([]);
      expect(state.storage.sql.exec('SELECT * FROM authorization_inventories').toArray()).toEqual([]);
      expect(state.storage.sql.exec('SELECT * FROM authorization_delivery').toArray()).toEqual([]);
    });
  });

  it('preserves re-enqueued discovery during delivery and defers churn during Queue failures', async () => {
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName('authorization-storage-delivery'));
    await stub.initializeWorkspace(workspaceId, 'wnam');
    await stub.registerAuthorizationChildren({ workspaceId, parentId, substreamIds: ['0'] });
    await runInDurableObject(stub, async (instance, state) => {
      const queue = createCloudflareTestBinding<Queue>({ sendBatch: async () => {
        await instance.registerAuthorizationChildren({ workspaceId, parentId, substreamIds: ['0'] });
      } });
      await flushAuthorizationDeliveries(state.storage.sql, queue, Date.now());
      expect(state.storage.sql.exec('SELECT * FROM authorization_delivery').toArray()).toHaveLength(1);
      const failing = createCloudflareTestBinding<Queue>({ sendBatch: async () => {
        await instance.registerAuthorizationChildren({ workspaceId, parentId, substreamIds: ['0'] });
        throw new Error('queue unavailable');
      } });
      const now = Date.now();
      await expect(flushAuthorizationDeliveries(state.storage.sql, failing, now)).rejects.toThrow('queue unavailable');
      expect(state.storage.sql.exec<{ not_before: number }>('SELECT not_before FROM authorization_delivery').one().not_before).toBe(now + 5_000);
      await instance.registerAuthorizationChildren({ workspaceId, parentId, substreamIds: ['0'] });
      expect(state.storage.sql.exec<{ not_before: number }>('SELECT not_before FROM authorization_delivery').one().not_before).toBe(now + 5_000);
    });
  });

  it('keeps a changed source projection deferred after a Queue failure', async () => {
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName('authorization-storage-source-backoff'));
    await stub.initializeWorkspace(workspaceId, 'wnam');
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(AUTHORIZATION_PROJECTION_MIGRATION[0]!);
      state.storage.sql.exec('INSERT INTO authorization_projection_outbox VALUES (1, 1, 0)');
      const now = Date.now();
      const queue = createCloudflareTestBinding<Queue>({ send: async () => {
        state.storage.sql.exec('UPDATE authorization_projection_outbox SET revision = revision + 1');
        throw new Error('queue unavailable');
      } });
      await expect(flushAuthorizationProjection(state.storage.sql, queue, {
        type: 'authorization_projection_v1', region: 'global', workspaceId, parentId, substreamId: asSubstreamId('0'),
      })).rejects.toThrow('queue unavailable');
      expect(state.storage.sql.exec<{ not_before: number }>('SELECT not_before FROM authorization_projection_outbox').one().not_before).toBeGreaterThanOrEqual(now + 5_000);
    });
  });

  it('keeps exact child locations and prevents delayed snapshots resurrecting removed links', async () => {
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName('authorization-storage-locations'));
    // Invoking the object's migration inspection waits for the production migration runner.
    await stub.runInspectionSql({ sql: 'SELECT 1', bindings: [] });
    await runInDurableObject(stub, async (_instance, state) => {
      const storage = new AuthorizationStorage(state.storage);
      const base = { workspaceId, parentId, parentKind: 'workstream' as const, substreamId: asSubstreamId('00000000-0000-7000-8000-000000000b05'), validatedAt: Date.now() };
      storage.replaceLocations({ ...base, revision: 1, resourceIds: [resourceId] });
      expect(storage.locations(resourceId)).toEqual([{ parentId, parentKind: 'workstream', substreamId: '00000000-0000-7000-8000-000000000b05' }]);
      storage.replaceLocations({ ...base, substreamId: asSubstreamId('0'), revision: 1, resourceIds: [resourceId] });
      storage.replaceLocations({ ...base, revision: 2, resourceIds: [] });
      storage.replaceLocations({ ...base, validatedAt: base.validatedAt + 1, revision: 1, resourceIds: [resourceId] });
      expect(storage.locations(resourceId)).toEqual([{ parentId, parentKind: 'workstream', substreamId: '0' }]);
    });
  });

  it('ignores persisted grants after removing time-based snapshot reuse', async () => {
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName('authorization-storage-snapshots'));
    await stub.initializeWorkspace(workspaceId, 'wnam');
    const snapshot: AuthorizationSnapshot = { policyVersion: 1,
      subject: { workspaceId, userId: asUserId('00000000-0000-7000-8000-000000000b04'), delegation: null },
      resource: { kind: 'resource', workspaceId, resourceId },
      decision: { status: 'allowed', evidence: [{ owner: parentId, revision: '1', validatedAt: Date.now() }] } };
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('INSERT INTO authorization_snapshots VALUES (?, ?, ?)',
        JSON.stringify([workspaceId, snapshot.subject.userId, null, JSON.stringify([workspaceId, 'resource', resourceId])]),
        JSON.stringify(snapshot), Date.now());
    });
    expect(await stub.readAuthorizationSnapshots({ subject: snapshot.subject, resources: [snapshot.resource] })).toEqual([null]);
    await stub.writeAuthorizationSnapshots([snapshot]);
  });
});
