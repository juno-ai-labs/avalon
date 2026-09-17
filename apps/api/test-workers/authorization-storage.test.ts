/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createCloudflareTestBinding } from '../test/helpers/cloudflare-test';
import { asSubstreamId, asUserId, asWorkspaceId } from '@rally/contracts';
import { AUTHORIZATION_PROJECTION_MIGRATION, AUTHORIZATION_PROJECTION_TIMING_MIGRATION, flushAuthorizationDeliveries, flushAuthorizationProjection } from '../src/durable-objects/authorization-projection';
import { AuthorizationStorage } from '../src/durable-objects/authorization-storage';
import type { WorkspaceDO } from '../src/durable-objects/workspace-do';
import { type AuthorizationSnapshot } from '../src/services/authorization-policy';

const workspaceId = asWorkspaceId('00000000-0000-7000-8000-000000000b01');
const parentId = '00000000-0000-7000-8000-000000000b02';
const siblingSubstreamId = '00000000-0000-7000-8000-000000000b07';
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
    await runInDurableObject(stub, async (instance, state) => state.blockConcurrencyWhile(async () => {
      // This test drives dispatch itself; keep the real alarm from racing the controlled Queue callback.
      await instance.registerAuthorizationChildren({ workspaceId, parentId, substreamIds: ['0'] });
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
    }));
  });

  it('keeps a changed source projection deferred after a Queue failure', async () => {
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName('authorization-storage-source-backoff'));
    await stub.initializeWorkspace(workspaceId, 'wnam');
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(AUTHORIZATION_PROJECTION_MIGRATION[0]!);
      for (const statement of AUTHORIZATION_PROJECTION_TIMING_MIGRATION) state.storage.sql.exec(statement);
      state.storage.sql.exec('INSERT INTO authorization_projection_outbox(id, revision, not_before) VALUES (1, 1, 0)');
      const mutationAt = state.storage.sql.exec<{ first_mutated_at: number }>('SELECT first_mutated_at FROM authorization_projection_outbox').one().first_mutated_at;
      const now = Date.now();
      const queue = createCloudflareTestBinding<Queue>({ send: async (job) => {
        expect(job).toMatchObject({ mutationAt });
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
    await stub.writeAuthorizationSnapshots([{ ...snapshot,
      resource: { kind: 'resource', workspaceId, resourceId: '00000000-0000-7000-8000-000000000b06' } }]);
    await runInDurableObject(stub, (_instance, state) => {
      const rows = state.storage.sql.exec<{ snapshot_json: string }>('SELECT snapshot_json FROM authorization_snapshots').toArray();
      expect(rows.map((row) => JSON.parse(row.snapshot_json))).toEqual([snapshot]);
    });
  });

  // Every case below drives the state itself; blockConcurrencyWhile keeps the object's real
  // alarm from draining authorization_delivery before the assertion reads it.
  const directoryParent = (stub: DurableObjectStub<WorkspaceDO>) => runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO workspace_workstream_directory
         (workstream_id, authority_generation, waterline, source_event_id, payload_hash,
          title, description, preview, scope, exact_state, last_activity_at,
          origin_type, title_status, latest_attention_ordinal,
          unread_tracking_start_ordinal, source_created_at, source_updated_at, projected_at)
       VALUES (?, 1, 1, ?, 'hash', 'Stuck', '', '', 'workspace', 'open', 0,
               'ad_hoc', 'settled', 0, 0, 0, 0, 0)`,
      parentId, `event:${parentId}`);
  });

  const deliveryKeys = (state: DurableObjectState) => state.storage.sql
    .exec<{ job_key: string }>('SELECT job_key FROM authorization_delivery').toArray().map((row) => row.job_key);

  it('re-enqueues a tracked parent whose discovery never completed', async () => {
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName('authorization-storage-stuck-parent'));
    await stub.initializeWorkspace(workspaceId, 'wnam');
    await directoryParent(stub);
    await runInDurableObject(stub, async (instance, state) => state.blockConcurrencyWhile(async () => {
      // The parent was discovered once, its projection job died, and the delivery row was drained.
      await instance.beginAuthorizationBackfill({ workspaceId, refresh: false });
      state.storage.sql.exec('DELETE FROM authorization_delivery');
      expect(await instance.authorizationBackfillStatus({ workspaceId })).toMatchObject({ complete: false, pendingParents: 1 });

      // This is what the unavailable read path calls; it must re-queue rather than skip the tracked parent.
      await instance.beginAuthorizationBackfill({ workspaceId, refresh: false });
      expect(deliveryKeys(state)).toEqual([JSON.stringify([parentId, null])]);
    }));
  });

  it('re-enqueues a child whose discovery died after its parent completed', async () => {
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName('authorization-storage-stuck-child'));
    await stub.initializeWorkspace(workspaceId, 'wnam');
    await directoryParent(stub);
    await runInDurableObject(stub, async (instance, state) => state.blockConcurrencyWhile(async () => {
      // Registering children is what completes the parent, so this is the state a dead-lettered
      // authorization_projection_conversation_not_ready leaves behind.
      await instance.beginAuthorizationBackfill({ workspaceId, refresh: false });
      await instance.registerAuthorizationChildren({ workspaceId, parentId, substreamIds: ['0', siblingSubstreamId] });
      await instance.applyAuthorizationLocations({ workspaceId, parentId, substreamId: siblingSubstreamId, parentKind: 'workstream',
        revision: 1, validatedAt: Date.now(), resourceIds: [] });
      state.storage.sql.exec('DELETE FROM authorization_delivery');
      expect(state.storage.sql.exec<{ completed: number }>(
        'SELECT completed FROM authorization_backfill').one().completed).toBe(1);
      expect(await instance.authorizationBackfillStatus({ workspaceId })).toMatchObject({ complete: false, pendingChildren: 1 });

      await instance.beginAuthorizationBackfill({ workspaceId, refresh: false });
      // Only the stuck child is re-queued: the completed sibling keeps its receipt.
      expect(deliveryKeys(state)).toEqual([JSON.stringify([parentId, '0'])]);
      expect(await instance.authorizationBackfillStatus({ workspaceId })).toMatchObject({ pendingChildren: 1 });
    }));
  });

  it('re-queues nothing for a complete workspace or for discovery already scheduled', async () => {
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName('authorization-storage-no-churn'));
    await stub.initializeWorkspace(workspaceId, 'wnam');
    await directoryParent(stub);
    await runInDurableObject(stub, async (instance, state) => state.blockConcurrencyWhile(async () => {
      await instance.beginAuthorizationBackfill({ workspaceId, refresh: false });
      await instance.registerAuthorizationChildren({ workspaceId, parentId, substreamIds: ['0'] });
      await instance.applyAuthorizationLocations({ workspaceId, parentId, substreamId: '0', parentKind: 'workstream',
        revision: 1, validatedAt: Date.now(), resourceIds: [] });
      state.storage.sql.exec('DELETE FROM authorization_delivery');
      expect(await instance.authorizationBackfillStatus({ workspaceId })).toMatchObject({ complete: true });

      // refresh:false must never redo finished work; without that half of the guard an operator
      // rebuild and an ordinary read become the same thing.
      await instance.beginAuthorizationBackfill({ workspaceId, refresh: false });
      expect(deliveryKeys(state)).toEqual([]);
      expect(await instance.authorizationBackfillStatus({ workspaceId })).toMatchObject({ complete: true });

      // A stuck child with delivery still pending is already scheduled; a retrying reader adds nothing.
      state.storage.sql.exec('UPDATE authorization_backfill_children SET completed = 0');
      await instance.beginAuthorizationBackfill({ workspaceId, refresh: false });
      const queued = state.storage.sql.exec<{ revision: number }>('SELECT revision FROM authorization_delivery').one().revision;
      await instance.beginAuthorizationBackfill({ workspaceId, refresh: false });
      expect(state.storage.sql.exec<{ revision: number }>('SELECT revision FROM authorization_delivery').one().revision).toBe(queued);
    }));
  });
});
