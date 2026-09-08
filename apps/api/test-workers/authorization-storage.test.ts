/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { asSubstreamId, asUserId, asWorkspaceId } from '@rally/contracts';
import { AuthorizationStorage } from '../src/durable-objects/authorization-storage';
import { AUTHORIZATION_FRESHNESS_MS, type AuthorizationSnapshot } from '../src/services/authorization-policy';

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

  it('expires evidence independently of storage and refuses delayed renewal', async () => {
    const stub = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName('authorization-storage-snapshots'));
    await stub.runInspectionSql({ sql: 'SELECT 1', bindings: [] });
    await runInDurableObject(stub, async (_instance, state) => {
      const storage = new AuthorizationStorage(state.storage);
      const now = Date.now();
      const snapshot: AuthorizationSnapshot = { policyVersion: 1,
        subject: { workspaceId, userId: asUserId('00000000-0000-7000-8000-000000000b04'), delegation: null },
        resource: { kind: 'resource', workspaceId, resourceId },
        decision: { status: 'allowed', evidence: [{ owner: parentId, revision: '1', validatedAt: now }] } };
      storage.write(snapshot);
      expect(storage.read(snapshot.subject, snapshot.resource, now)?.decision.status).toBe('allowed');
      expect(storage.read(snapshot.subject, snapshot.resource, now + AUTHORIZATION_FRESHNESS_MS)).toBeNull();
      storage.write({ ...snapshot, decision: { status: 'denied', reason: 'resource_not_shared', evidence: [{ owner: parentId, revision: '2', validatedAt: now + AUTHORIZATION_FRESHNESS_MS }] } });
      storage.write(snapshot);
      // Future timestamps cannot be published to bypass the expiration bound.
      expect(storage.read(snapshot.subject, snapshot.resource, now)?.decision.status).toBe('allowed');
      const older = { ...snapshot, decision: { status: 'allowed' as const,
        evidence: [{ owner: parentId, revision: '0', validatedAt: now - 1 }] } };
      storage.write(older);
      expect(storage.read(snapshot.subject, snapshot.resource, now)?.decision).toEqual(snapshot.decision);
    });
  });
});
