import { describe, expect, it } from 'vitest';
import { asSubstreamId, asUserId, asWorkspaceId } from '@rally/contracts';
import { AccessContext, canvasAdmits, canvasManages, decisionHasValidEvidence, evaluateReadPolicy, sidekickAdmits,
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

  it('keeps observation age diagnostic and rejects future evidence', () => {
    const decision = evaluateReadPolicy(granted(true), 1000);
    expect(decisionHasValidEvidence(decision, 301_000)).toBe(true);
    expect(decisionHasValidEvidence(decision, 86_401_000)).toBe(true);
    expect(decisionHasValidEvidence(decision, 999)).toBe(false);
    expect(evaluateReadPolicy(granted(false), 86_401_000)).toMatchObject({ status: 'denied' });
    expect(evaluateReadPolicy(granted(true, 2000), 1000)).toMatchObject({ status: 'unavailable', reason: 'evidence_invalid' });
    expect(evaluateReadPolicy({ kind: 'all', policies: [] }, 2000)).toMatchObject({ status: 'unavailable' });
  });

  it('refuses a different workspace before consulting the resolver', async () => {
    const context = new AccessContext({ workspaceId, userId, delegation: null }, {
      checkMany: async () => { throw new Error('must not read another workspace'); },
    });
    expect(await context.check({ ...resource, workspaceId: asWorkspaceId('00000000-0000-7000-8000-000000000005') }))
      .toMatchObject({ status: 'denied', reason: 'workspace_mismatch' });
  });

  it('does not impose a deadline on a grant while the resolver completes its batch', async () => {
    const at = Date.now() - 86_400_000;
    const context = new AccessContext({ workspaceId, userId, delegation: null }, {
      checkMany: async () => [evaluateReadPolicy(granted(true, at), at)],
    });
    expect(await context.check(resource)).toMatchObject({ status: 'allowed' });
  });

  it('reports incomplete evaluation without hiding successful or failed checks', async () => {
    const context = new AccessContext({ workspaceId, userId, delegation: null }, {
      checkMany: async () => [{ status: 'unavailable', reason: 'authority_unavailable', retryable: true }],
    });
    const result = await context.readableScopes([resource]);
    expect(result).toMatchObject({ complete: false, items: [], decisions: [{ status: 'unavailable' }] });
  });
});

describe('who reads a Sidekick', () => {
  const sidekick = { scope: 'personal', author: false, executor: false, shared: false };
  it('admits the people a Sidekick is shared with, a guest among them', () => {
    expect(sidekickAdmits({ ...sidekick, shared: true }, false)).toBe(true);
    expect(sidekickAdmits(sidekick, true)).toBe(false);
  });
  it('admits any member, and no guest, through Organization scope', () => {
    expect(sidekickAdmits({ ...sidekick, scope: 'workspace' }, true)).toBe(true);
    expect(sidekickAdmits({ ...sidekick, scope: 'workspace' }, false)).toBe(false);
  });
  it('admits its author and the person it runs as', () => {
    expect(sidekickAdmits({ ...sidekick, author: true }, false)).toBe(true);
    expect(sidekickAdmits({ ...sidekick, executor: true }, true)).toBe(true);
  });
});

describe('who opens a Canvas', () => {
  const canvas = { visibility: 'creator', creator: false, participant: false, writerAudience: false };
  it('admits only its creator by default', () => {
    expect(canvasAdmits({ ...canvas, creator: true }, false)).toBe(true);
    expect(canvasAdmits(canvas, true)).toBe(false);
  });
  it('admits a participant, a guest among them, and nobody else', () => {
    expect(canvasAdmits({ ...canvas, visibility: 'participants', participant: true }, false)).toBe(true);
    expect(canvasAdmits({ ...canvas, visibility: 'participants' }, true)).toBe(false);
  });
  it('admits any member, and no guest, when it is open to the Organization', () => {
    expect(canvasAdmits({ ...canvas, visibility: 'workspace' }, true)).toBe(true);
    expect(canvasAdmits({ ...canvas, visibility: 'workspace' }, false)).toBe(false);
  });
  it('admits anyone its writer Sidekick is shared with', () => {
    expect(canvasAdmits({ ...canvas, writerAudience: true }, false)).toBe(true);
  });
  it('lets the creator, an owner or administrator, or its Sidekick\'s manager change who opens it', () => {
    expect(canvasManages({ creator: true, writerManager: false }, null)).toBe(true);
    expect(canvasManages({ creator: false, writerManager: true }, 'member')).toBe(true);
    expect(canvasManages({ creator: false, writerManager: false }, 'admin')).toBe(true);
    expect(canvasManages({ creator: false, writerManager: false }, 'owner')).toBe(true);
    expect(canvasManages({ creator: false, writerManager: false }, 'member')).toBe(false);
  });
});
