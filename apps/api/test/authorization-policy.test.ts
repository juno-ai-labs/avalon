import { describe, expect, it } from 'vitest';
import { asSubstreamId, asUserId, asWorkspaceId } from '@rally/contracts';
import { AccessContext, AUTHORIZATION_FRESHNESS_MS, AuthorizedView, decisionIsFresh, evaluateReadPolicy,
  type ReadPolicy, type AuthorizationResource } from '../src/services/authorization-policy';

const workspaceId = asWorkspaceId('00000000-0000-7000-8000-000000000001');
const userId = asUserId('00000000-0000-7000-8000-000000000002');
const resource: AuthorizationResource = { kind: 'conversation', workspaceId,
  parentId: '00000000-0000-7000-8000-000000000003', substreamId: asSubstreamId('0') };
const granted = (value: boolean, validatedAt = 1000): ReadPolicy => ({ kind: 'fact', granted: value,
  reason: 'not_participant', evidence: { owner: 'parent', revision: '1', validatedAt } });

describe('authorization read policy', () => {
  it('requires both parent access and private-child membership', () => {
    expect(evaluateReadPolicy({ kind: 'all', policies: [granted(true), granted(false)] }, 1001)).toMatchObject({ status: 'denied' });
    expect(evaluateReadPolicy({ kind: 'all', policies: [granted(true), granted(true)] }, 1001)).toMatchObject({ status: 'allowed' });
  });

  it('retains an independent grant when another relationship is removed or unavailable', () => {
    expect(evaluateReadPolicy({ kind: 'any', reason: 'resource_not_shared', policies: [granted(false), granted(true)] }, 1001)).toMatchObject({ status: 'allowed' });
    expect(evaluateReadPolicy({ kind: 'any', reason: 'resource_not_shared', policies: [granted(true, 0), granted(true, 300_000)] }, 300_001)).toMatchObject({ status: 'allowed' });
  });

  it('expires at exactly five minutes and never renews stale or future evidence', () => {
    const decision = evaluateReadPolicy(granted(true), 1000);
    expect(decisionIsFresh(decision, 1000 + AUTHORIZATION_FRESHNESS_MS - 1)).toBe(true);
    expect(decisionIsFresh(decision, 1000 + AUTHORIZATION_FRESHNESS_MS)).toBe(false);
    expect(decisionIsFresh(decision, 999)).toBe(false);
    expect(evaluateReadPolicy(granted(false), 301_000)).toMatchObject({ status: 'unavailable', reason: 'evidence_expired' });
  });

  it('uses the earliest dependency and refuses an empty proof', () => {
    const decision = evaluateReadPolicy({ kind: 'all', policies: [granted(true, 1000), granted(true, 2000)] }, 2000);
    expect(decisionIsFresh(decision, 301_000)).toBe(false);
    expect(evaluateReadPolicy({ kind: 'all', policies: [] }, 2000)).toMatchObject({ status: 'unavailable' });
  });

  it('narrowing and source composition cannot expand authority', async () => {
    const second = { ...resource, parentId: '00000000-0000-7000-8000-000000000004' };
    const now = Date.now();
    const context = new AccessContext({ workspaceId, userId, delegation: null }, {
      checkMany: async (_subject, resources) => resources.map(() => evaluateReadPolicy(granted(true, now), now)),
    }).within([resource]);
    expect(await context.within([second]).check(second)).toMatchObject({ status: 'denied', reason: 'outside_delegation' });
    expect(await context.check({ ...resource, workspaceId: asWorkspaceId('00000000-0000-7000-8000-000000000005') })).toMatchObject({ status: 'denied', reason: 'workspace_mismatch' });
    const view = new AuthorizedView(context, [async () => [{ resource, value: 'first' }], async () => [{ resource: second, value: 'second' }]]);
    expect((await view.read()).items).toEqual(['first']);
    expect((await context.readableScopes([resource, second])).decisions).toEqual(await context.checkMany([resource, second]));
  });

  it('rejects a grant that expired while the resolver was completing its batch', async () => {
    const at = Date.now() - AUTHORIZATION_FRESHNESS_MS;
    const context = new AccessContext({ workspaceId, userId, delegation: null }, {
      checkMany: async () => [evaluateReadPolicy(granted(true, at), at)],
    });
    expect(await context.check(resource)).toMatchObject({ status: 'unavailable', reason: 'evidence_expired' });
  });

  it('reports incomplete evaluation without hiding successful or failed checks', async () => {
    const context = new AccessContext({ workspaceId, userId, delegation: null }, {
      checkMany: async () => [{ status: 'unavailable', reason: 'authority_unavailable', retryable: true }],
    });
    const result = await context.readableScopes([resource]);
    expect(result).toMatchObject({ complete: false, items: [], decisions: [{ status: 'unavailable' }] });
  });
});
