import { asWorkspaceId, type ExecutionPrincipal } from '@rally/contracts';
import { AccessContext, authorizationResourceKey, evaluateReadPolicy, type AuthorizationResource } from './authorization-policy';

/**
 * Adapter for host-owned memory/resource selections. The host has already validated
 * the execution principal and canonical scope; this does not accept model input.
 * Capture validatedAt BEFORE loading evidence so I/O cannot renew older facts.
 */
export function createHostAccessContext(input: {
  workspaceId: string;
  principal: ExecutionPrincipal;
  executionId: string;
  resources: readonly AuthorizationResource[];
  validatedAt: number;
}) {
  const admitted = new Set(input.principal.type === 'workspace' && input.principal.workspaceId !== input.workspaceId
    ? [] : input.resources.map(authorizationResourceKey));
  return new AccessContext({ workspaceId: asWorkspaceId(input.workspaceId),
    userId: input.principal.type === 'user' ? input.principal.userId : null,
    delegation: JSON.stringify([input.executionId, input.principal]),
  }, {
    checkMany: async (_subject, resources) => resources.map((resource) => evaluateReadPolicy({
      kind: 'fact', granted: admitted.has(authorizationResourceKey(resource)),
      reason: resource.kind === 'memory' ? 'memory_scope_not_accessible' : 'outside_delegation',
      evidence: { owner: input.executionId, revision: JSON.stringify(input.resources.map(authorizationResourceKey)), validatedAt: input.validatedAt },
    }, Date.now())),
  });
}
