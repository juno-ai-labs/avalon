/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import type { Env } from '../src/env';
import { consumeActivityQueue } from '../src/queues/activity-consumer';
import { runInDurableObject } from 'cloudflare:test';
import { flushSearchAuthorizationPush } from '../src/durable-objects/search-authorization-projection';
import { createCloudflareTestBinding } from '../test/helpers/cloudflare-test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { asUserId, asWorkspaceId } from '@rally/contracts';
import { workspaceDOName } from '../src/durable-objects/names';
import { SearchAuthorizationResolver, searchAuthorizationKey } from '../src/services/search-authorization';
import type { AuthorizationDecision, AuthorizationResource, AuthorizationSubject } from '../src/services/authorization-policy';

const subject: AuthorizationSubject = { workspaceId: asWorkspaceId('00000000-0000-7000-8000-000000000b71'),
  userId: asUserId('00000000-0000-7000-8000-000000000b72'), delegation: null };
const resource: Extract<AuthorizationResource, { kind: 'resource' }> = { kind: 'resource', workspaceId: subject.workspaceId,
  resourceId: '00000000-0000-7000-8000-000000000b73' };
const allowed: AuthorizationDecision = { status: 'allowed', evidence: [{ owner: 'fixture', revision: '1', validatedAt: 1 }] };

// A push registers what its target reaches, which starts from the regional member list.
beforeAll(async () => {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
    status TEXT NOT NULL, role TEXT NOT NULL, last_seen_at TEXT, PRIMARY KEY (workspace_id, user_id))`).run();
});
afterEach(() => vi.restoreAllMocks());

describe('projected search authorization', () => {
  it('serves old KV decisions without contacting canonical authority', async () => {
    const key = await searchAuthorizationKey(subject, resource);
    await env.AUTHORIZATION_CACHE!.put(key, JSON.stringify({ version: 1, generation: 1, subject, resource, decision: allowed, observedAt: 1 }));
    const checkMany = vi.fn(async (): Promise<AuthorizationDecision[]> => { throw new Error('owner must not be read'); });
    const send = vi.spyOn(env.ACTIVITY_QUEUE, 'send');
    const resolver = new SearchAuthorizationResolver(env, { checkMany });
    expect(await resolver.checkMany(subject, [resource])).toEqual([allowed]);
    expect(checkMany).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('populates misses once, preserves decisions on unavailable push, and publishes revocation', async () => {
    const workspace = env.WORKSPACE_DOS.getByName(workspaceDOName('global', subject.workspaceId));
    await workspace.initializeWorkspace(subject.workspaceId, 'wnam');
    const key = await searchAuthorizationKey(subject, resource);
    await env.AUTHORIZATION_CACHE!.delete(key);
    const checkMany = vi.fn(async (): Promise<AuthorizationDecision[]> => [allowed]);
    const resolver = new SearchAuthorizationResolver(env, { checkMany });
    expect(await resolver.checkMany(subject, [resource])).toEqual([allowed]);
    expect(await resolver.checkMany(subject, [resource])).toEqual([allowed]);
    expect(checkMany).toHaveBeenCalledTimes(1);
    const unavailable: AuthorizationDecision = { status: 'unavailable', reason: 'authority_unavailable', retryable: true };
    checkMany.mockResolvedValueOnce([unavailable]);
    await resolver.project(subject, [resource]);
    expect(await resolver.checkMany(subject, [resource])).toEqual([allowed]);
    const denied: AuthorizationDecision = { status: 'denied', reason: 'not_participant', evidence: allowed.evidence };
    checkMany.mockResolvedValueOnce([denied]);
    await resolver.project(subject, [resource]);
    expect(await resolver.checkMany(subject, [resource])).toEqual([denied]);
  });

  it('reuses the durable projection when KV keeps returning a cached miss', async () => {
    const workspace = env.WORKSPACE_DOS.getByName(workspaceDOName('global', subject.workspaceId));
    await workspace.initializeWorkspace(subject.workspaceId, 'wnam');
    const resolver = new SearchAuthorizationResolver(env, { checkMany: async () => [allowed] });
    await resolver.project(subject, [resource]);
    await env.AUTHORIZATION_CACHE!.delete(await searchAuthorizationKey(subject, resource));
    const authority = vi.fn(async (): Promise<AuthorizationDecision[]> => { throw new Error('owner read'); });
    const cached = new SearchAuthorizationResolver(env, { checkMany: authority });
    expect(await cached.checkMany(subject, [resource])).toEqual([allowed]);
    expect(await cached.checkMany(subject, [resource])).toEqual([allowed]);
    expect(authority).not.toHaveBeenCalled();
  });

  it('does not repeat unavailable first fills on later searches', async () => {
    const pendingResource = { ...resource, resourceId: crypto.randomUUID() };
    const workspace = env.WORKSPACE_DOS.getByName(workspaceDOName('global', subject.workspaceId));
    await workspace.initializeWorkspace(subject.workspaceId, 'wnam');
    const authority = vi.fn(async (): Promise<AuthorizationDecision[]> => [{ status: 'unavailable', reason: 'authority_unavailable', retryable: true }]);
    const resolver = new SearchAuthorizationResolver(env, { checkMany: authority });
    expect(await resolver.checkMany(subject, [pendingResource])).toEqual([expect.objectContaining({ status: 'unavailable' })]);
    expect(await resolver.checkMany(subject, [pendingResource])).toEqual([expect.objectContaining({ status: 'unavailable' })]);
    expect(authority).toHaveBeenCalledTimes(1);
  });

  it('records retry intent before an initial authority lookup can fail', async () => {
    const stub = env.WORKSPACE_DOS.getByName('search-authorization-atomic-fill');
    await stub.initializeWorkspace(subject.workspaceId, 'wnam');
    await stub.registerSearchAuthorization({ subject, resources: [resource] });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec('SELECT target_id FROM search_authorization_push').toArray())
        .toContainEqual({ target_id: resource.resourceId });
    });
  });

  it('persists regional snapshots independently of the legacy inert RPCs', async () => {
    const stub = env.WORKSPACE_DOS.getByName('search-authorization-regional-snapshots');
    await stub.initializeWorkspace(subject.workspaceId, 'wnam');
    const [oldGeneration] = await stub.registerSearchAuthorization({ subject, resources: [resource] });
    const [generation] = await stub.registerSearchAuthorization({ subject, resources: [resource] });
    const snapshot = { version: 1, generation, subject, resource, decision: { status: 'denied', reason: 'not_participant', evidence: allowed.evidence }, observedAt: 10 };
    await stub.writeSearchAuthorizationSnapshots([snapshot]);
    expect(await stub.readSearchAuthorizationSnapshots({ subject, resources: [resource] })).toEqual([snapshot]);
    await stub.writeSearchAuthorizationSnapshots([{ ...snapshot, generation: oldGeneration, observedAt: 10, decision: allowed }]);
    expect(await stub.readSearchAuthorizationSnapshots({ subject, resources: [resource] })).toEqual([snapshot]);
    expect(await stub.readSearchAuthorizationSnapshots({ subject: { ...subject, userId: asUserId('00000000-0000-7000-8000-000000000b74') },
      resources: [resource] })).toEqual([null]);
  });
  it('keeps a failed KV read local to its candidate without rereading authority', async () => {
    const other = { ...resource, resourceId: '00000000-0000-7000-8000-000000000b75' };
    const otherKey = await searchAuthorizationKey(subject, other);
    await env.AUTHORIZATION_CACHE!.put(await searchAuthorizationKey(subject, resource), JSON.stringify({
      version: 1, generation: 1, subject, resource, decision: allowed, observedAt: 1 }));
    const originalGet = env.AUTHORIZATION_CACHE!.get.bind(env.AUTHORIZATION_CACHE!);
    vi.spyOn(env.AUTHORIZATION_CACHE!, 'get').mockImplementation(async (key, options) => {
      if (key.includes(otherKey)) throw new Error('kv unavailable');
      return originalGet(key, options);
    });
    const checkMany = vi.fn(async (): Promise<AuthorizationDecision[]> => { throw new Error('no owner read'); });
    const decisions = await new SearchAuthorizationResolver(env, { checkMany }).checkMany(subject, [resource, other]);
    expect(decisions[0]).toEqual(allowed);
    expect(decisions[1]).toMatchObject({ status: 'unavailable' });
    expect(checkMany).not.toHaveBeenCalled();
  });

  it('selects only a changed parent and current or prior resource dependencies', async () => {
    const stub = env.WORKSPACE_DOS.getByName('search-authorization-targets');
    await stub.initializeWorkspace(subject.workspaceId, 'wnam');
    const parent = resource.resourceId;
    const otherParent = '00000000-0000-7000-8000-000000000b76';
    const conversation = { kind: 'conversation', workspaceId: subject.workspaceId, parentId: parent, substreamId: '0' };
    const otherConversation = { ...conversation, parentId: otherParent };
    await stub.registerSearchAuthorization({ subject, resources: [conversation, otherConversation] });
    const [generation] = await stub.registerSearchAuthorization({ subject, resources: [resource] });
    await stub.writeSearchAuthorizationSnapshots([{ version: 1, generation, subject, resource, observedAt: 1,
      decision: { ...allowed, evidence: [{ owner: parent + '/0', revision: '1', validatedAt: 1 }] } }]);
    const pendingResource = { ...resource, resourceId: '00000000-0000-7000-8000-000000000b77' };
    await stub.applyAuthorizationLocations({ workspaceId: subject.workspaceId, parentId: parent, substreamId: '0',
      parentKind: 'workstream', revision: 1, validatedAt: 1, resourceIds: [pendingResource.resourceId] });
    await stub.registerSearchAuthorization({ subject, resources: [pendingResource] });
    await stub.applyAuthorizationLocations({ workspaceId: subject.workspaceId, parentId: parent, substreamId: '0',
      parentKind: 'workstream', revision: 2, validatedAt: 2, resourceIds: [] });
    const selected = await stub.listSearchAuthorizationSnapshots({ workspaceId: subject.workspaceId, target: { kind: 'parent', id: parent } });
    expect(selected.map((snapshot) => snapshot.resource)).toEqual(expect.arrayContaining([resource, conversation, pendingResource]));
    expect(selected).toHaveLength(3);
  });

  it('keeps the oldest source timestamp when discovery deliveries coalesce', async () => {
    const stub = env.WORKSPACE_DOS.getByName('search-authorization-discovery-timing');
    await stub.initializeWorkspace(subject.workspaceId, 'wnam');
    await runInDurableObject(stub, async (instance, state) => {
      const request = { workspaceId: subject.workspaceId, parentId: resource.resourceId, substreamIds: ['0'] };
      await instance.registerAuthorizationChildren({ ...request, mutationAt: 100 });
      await instance.registerAuthorizationChildren({ ...request, mutationAt: 200 });
      await instance.registerAuthorizationChildren(request);
      const row = state.storage.sql.exec<{ payload_json: string }>('SELECT payload_json FROM authorization_delivery').one();
      expect(JSON.parse(row.payload_json).mutationAt).toBe(100);
    });
  });

  it('retries a failed queue message without abandoning its sibling', async () => {
    const stub = env.WORKSPACE_DOS.getByName(workspaceDOName('global', subject.workspaceId));
    await stub.initializeWorkspace(subject.workspaceId, 'wnam');
    const retry = vi.fn();
    const ack = vi.fn();
    const body = { type: 'search_authorization_push_v1', workspaceId: subject.workspaceId, target: { kind: 'parent', id: 'unregistered-parent' } };
    const messages: Message<unknown>[] = [
      { id: 'bad', timestamp: new Date(), body: { ...body, region: 'eu' }, attempts: 1, ack: vi.fn(), retry },
      { id: 'good', timestamp: new Date(), body: { ...body, region: 'global' }, attempts: 1, ack, retry: vi.fn() },
    ];
    await consumeActivityQueue({ queue: 'test', messages, metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } }, ackAll: vi.fn(), retryAll: vi.fn() }, env);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it('preserves mutation timing on KV retry and excludes cache-fill retries', async () => {
    const stub = env.WORKSPACE_DOS.getByName('search-authorization-kv-failure');
    await stub.initializeWorkspace(subject.workspaceId, 'wnam');
    await runInDurableObject(stub, async (instance, state) => {
      const target = instance as unknown as { env: Env };
      const original = target.env;
      target.env = { ...original, AUTHORIZATION_CACHE: createCloudflareTestBinding<KVNamespace>({ put: async () => { throw new Error('kv unavailable'); } }) };
      try {
        const [generation] = await instance.registerSearchAuthorization({ subject, resources: [resource] });
        const snapshot = { version: 1, generation, subject, resource, decision: allowed, observedAt: 10 };
        await expect(instance.writeSearchAuthorizationSnapshots([snapshot])).rejects.toThrow('kv unavailable');
        expect(state.storage.sql.exec('SELECT first_mutated_at, timing_origin FROM search_authorization_push').one())
          .toEqual({ first_mutated_at: null, timing_origin: 'cache_fill' });
        await expect(instance.writeSearchAuthorizationSnapshots([{ ...snapshot,
          timing: { mutationAt: 100, enqueuedAt: 200, origin: 'source_mutation' } }])).rejects.toThrow('kv unavailable');
        expect(state.storage.sql.exec('SELECT first_mutated_at, timing_origin FROM search_authorization_push').one())
          .toEqual({ first_mutated_at: 100, timing_origin: 'source_mutation' });
      } finally { target.env = original; }
    });
  });

  it('allows unrelated object events while a key waits for KV publication', async () => {
    const stub = env.WORKSPACE_DOS.getByName('search-authorization-kv-gate');
    await stub.initializeWorkspace(subject.workspaceId, 'wnam');
    const [generation] = await stub.registerSearchAuthorization({ subject, resources: [resource] });
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    await runInDurableObject(stub, (instance) => {
      const target = instance as unknown as { env: Env };
      const original = target.env.AUTHORIZATION_CACHE!;
      target.env = { ...target.env, AUTHORIZATION_CACHE: createCloudflareTestBinding<KVNamespace>({ put: async (key, value) => {
        entered = true; await gate; await original.put(key, value);
      } }) };
    });
    const pending = stub.writeSearchAuthorizationSnapshots([{ version: 1, generation, subject, resource, decision: allowed, observedAt: 10 }]);
    let other: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      let answered = false;
      other = stub.registerSearchAuthorization({ subject, resources: [resource] }).then(() => { answered = true; });
      await vi.waitFor(() => expect(answered).toBe(true));
    } finally { release(); await pending; await other; }
  });

  it('reports committed SQL as successful when post-commit alarm arming fails', async () => {
    const stub = env.WORKSPACE_DOS.getByName('search-authorization-alarm-failure');
    await stub.initializeWorkspace(subject.workspaceId, 'wnam');
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(`INSERT INTO resources(id, workspace_id, resource_type, provider, title, metadata_json, created_at, updated_at)
        VALUES (?, ?, 'file', 'avalon_generated', 'Before', '{}', '2026-09-08', '2026-09-08')`, resource.resourceId, subject.workspaceId);
      const arm = vi.spyOn(instance as unknown as { armNextAlarm(): Promise<void> }, 'armNextAlarm').mockRejectedValue(new Error('alarm unavailable'));
      try {
        const result = await instance.executeRuntimeSql({ workspaceId: subject.workspaceId,
          requestId: '00000000-0000-7000-8000-000000000b79', statements: [{ sql: 'UPDATE resources SET title = ? WHERE id = ?', params: ['After', resource.resourceId] }] });
        expect(result.status).toBe(200);
        expect(state.storage.sql.exec('SELECT title FROM resources WHERE id = ?', resource.resourceId).one()).toEqual({ title: 'After' });
        expect(arm).toHaveBeenCalled();
      } finally { arm.mockRestore(); }
    });
  });

  it('carries source mutation time through the WorkspaceDO projection into the push job', async () => {
    const stub = env.WORKSPACE_DOS.getByName('search-authorization-source-timing');
    await stub.initializeWorkspace(subject.workspaceId, 'wnam');
    await runInDurableObject(stub, async (instance, state) => {
      const mutationAt = Date.now() - 20_000;
      await instance.applyAuthorizationLocations({ workspaceId: subject.workspaceId, parentId: resource.resourceId,
        parentKind: 'workstream', substreamId: '0', revision: 1, validatedAt: Date.now(), resourceIds: [], mutationAt });
      const jobs: unknown[] = [];
      const queue = createCloudflareTestBinding<Queue>({ sendBatch: async (messages) => {
        jobs.push(...Array.from(messages, (message) => message.body));
      } });
      await flushSearchAuthorizationPush(state.storage.sql, { ...env, ACTIVITY_QUEUE: queue }, subject.workspaceId);
      expect(jobs).toEqual([expect.objectContaining({ timing: {
        mutationAt, origin: 'source_mutation', enqueuedAt: expect.any(Number),
      } })]);
    });
  });

  it('records source mutations durably and keeps a newer push pending during dispatch', async () => {
    const stub = env.WORKSPACE_DOS.getByName('search-authorization-outbox');
    await stub.initializeWorkspace(subject.workspaceId, 'wnam');
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO resources(id, workspace_id, resource_type, provider, title, metadata_json, created_at, updated_at)
        VALUES (?, ?, 'file', 'avalon_generated', 'Fixture', '{}', '2026-09-08', '2026-09-08')`, resource.resourceId, subject.workspaceId);
      const mutationAt = state.storage.sql.exec<{ first_mutated_at: number }>('SELECT first_mutated_at FROM search_authorization_push').one().first_mutated_at;
      expect(mutationAt).toBeGreaterThan(0);
      const jobs: unknown[] = [];
      const queue = createCloudflareTestBinding<Queue>({ sendBatch: async (messages) => {
        jobs.push(...Array.from(messages, (message) => message.body));
        state.storage.sql.exec("UPDATE resources SET uploaded_by_user_id = ? WHERE id = ?", subject.userId, resource.resourceId);
      } });
      await flushSearchAuthorizationPush(state.storage.sql, { ...env, ACTIVITY_QUEUE: queue }, subject.workspaceId);
      expect(jobs).toEqual([{ type: 'search_authorization_push_v1', region: 'global', workspaceId: subject.workspaceId,
        target: { kind: 'resource', id: resource.resourceId }, timing: { mutationAt, origin: 'workspace_mutation', enqueuedAt: expect.any(Number) } }]);
      expect(state.storage.sql.exec('SELECT first_mutated_at FROM search_authorization_push').one()).toEqual({ first_mutated_at: mutationAt });
      expect(state.storage.sql.exec('SELECT revision FROM search_authorization_push').toArray()).toEqual([{ revision: 2 }]);
    });
  });

});

describe('deferred first fills', () => {
  it('answers a never-projected pair unavailable and fills it after the response', async () => {
    const fresh = { ...resource, resourceId: crypto.randomUUID() };
    const workspace = env.WORKSPACE_DOS.getByName(workspaceDOName('global', subject.workspaceId));
    await workspace.initializeWorkspace(subject.workspaceId, 'wnam');
    const authority = vi.fn(async (): Promise<AuthorizationDecision[]> => [allowed]);
    const deferred: Promise<unknown>[] = [];
    const resolver = new SearchAuthorizationResolver(env, { checkMany: authority }, (work) => { deferred.push(work); });
    expect(await resolver.checkMany(subject, [fresh])).toEqual([expect.objectContaining({ status: 'unavailable' })]);
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
    expect(authority).toHaveBeenCalledTimes(1);
    // The fill published through the projection; the next search reads it without an owner.
    expect(await resolver.checkMany(subject, [fresh])).toEqual([allowed]);
    expect(authority).toHaveBeenCalledTimes(1);
  });
});
