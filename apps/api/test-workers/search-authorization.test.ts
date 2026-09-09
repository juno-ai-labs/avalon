/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { flushSearchAuthorizationPush } from '../src/durable-objects/search-authorization-projection';
import { createCloudflareTestBinding } from '../test/helpers/cloudflare-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asUserId, asWorkspaceId } from '@rally/contracts';
import { workspaceDOName } from '../src/durable-objects/names';
import { SearchAuthorizationResolver, searchAuthorizationKey } from '../src/services/search-authorization';
import type { AuthorizationDecision, AuthorizationResource, AuthorizationSubject } from '../src/services/authorization-policy';

const subject: AuthorizationSubject = { workspaceId: asWorkspaceId('00000000-0000-7000-8000-000000000b71'),
  userId: asUserId('00000000-0000-7000-8000-000000000b72'), delegation: null };
const resource: Extract<AuthorizationResource, { kind: 'resource' }> = { kind: 'resource', workspaceId: subject.workspaceId,
  resourceId: '00000000-0000-7000-8000-000000000b73' };
const allowed: AuthorizationDecision = { status: 'allowed', evidence: [{ owner: 'fixture', revision: '1', validatedAt: 1 }] };

afterEach(() => vi.restoreAllMocks());

describe('projected search authorization', () => {
  it('serves old KV decisions without contacting canonical authority', async () => {
    const key = await searchAuthorizationKey(subject, resource);
    await env.AUTHORIZATION_CACHE!.put(key, JSON.stringify({ version: 1, subject, resource, decision: allowed, observedAt: 1 }));
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

  it('persists regional snapshots independently of the legacy inert RPCs', async () => {
    const stub = env.WORKSPACE_DOS.getByName('search-authorization-regional-snapshots');
    await stub.initializeWorkspace(subject.workspaceId, 'wnam');
    const snapshot = { version: 1, subject, resource, decision: allowed, observedAt: 10 };
    await stub.writeSearchAuthorizationSnapshots([snapshot]);
    expect(await stub.readSearchAuthorizationSnapshots({ subject, resources: [resource] })).toEqual([snapshot]);
    await stub.writeSearchAuthorizationSnapshots([{ ...snapshot, observedAt: 9, decision: {
      status: 'denied', reason: 'not_participant', evidence: allowed.evidence,
    } }]);
    expect(await stub.readSearchAuthorizationSnapshots({ subject, resources: [resource] })).toEqual([snapshot]);
    expect(await stub.readSearchAuthorizationSnapshots({ subject: { ...subject, userId: asUserId('00000000-0000-7000-8000-000000000b74') },
      resources: [resource] })).toEqual([null]);
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
