import { z } from 'zod';
import { ExecutionPrincipalSchema, HarnessRunIdSchema, IdSchema, WorkspaceIdSchema, type WorkstreamWorkflowInput } from '@rally/contracts';
import type { Env } from '../env';
import type { AuthorizationDecision, AuthorizationResource, AuthorizationSubject } from './authorization-policy';
import { SearchAuthorizationResolver } from './search-authorization';
import { ensureScope, resolveMemoryAccess, type MemoryScope } from './memory-service';
import { requireAuthorizedRead } from './authorization-service';

const ContextSchema = z.strictObject({ workspaceId: WorkspaceIdSchema, parentId: IdSchema,
  parentKind: z.enum(['workstream', 'automation']), harnessRunId: HarnessRunIdSchema, executionPrincipal: ExecutionPrincipalSchema });
const PREFIX = 'memory-search:v1:';

/** Scope selection is host-owned metadata; only misses and mutation jobs resolve run authority. */
export async function resolveMemorySearchAccess(env: Env, input: WorkstreamWorkflowInput): Promise<MemoryScope[]> {
  const context = ContextSchema.parse({ workspaceId: input.workspaceId, parentId: input.parentId,
    parentKind: input.parentKind, harnessRunId: input.harnessRunId, executionPrincipal: input.executionPrincipal });
  const subject: AuthorizationSubject = { workspaceId: context.workspaceId,
    userId: context.executionPrincipal.type === 'user' ? context.executionPrincipal.userId : null,
    delegation: PREFIX + JSON.stringify(context) };
  const selected: Array<Promise<MemoryScope>> = [ensureScope(env, input.workspaceId, 'workspace', input.workspaceId, false)];
  if (input.parentKind === 'automation') selected.push(ensureScope(env, input.workspaceId, 'sidekick', input.parentId, false));
  else {
    if (input.executionPrincipal.type === 'user') selected.push(ensureScope(env, input.workspaceId, 'user', input.executionPrincipal.userId, false));
    selected.push(ensureScope(env, input.workspaceId, 'workstream', input.parentId, false));
  }
  const scopes = await Promise.all(selected);
  const decisions = await new SearchAuthorizationResolver(env).checkMany(subject, scopes.map((scope) => ({
    kind: 'memory', workspaceId: context.workspaceId, parentId: context.parentId, scopeId: IdSchema.parse(scope.memoryScopeId),
  })));
  return scopes.filter((_, index) => {
    const decision = decisions[index]!;
    if (decision.status === 'unavailable') requireAuthorizedRead(decision);
    return decision.status === 'allowed';
  });
}

/** The same resolver runs for first fills and pushed mutations. */
export async function projectMemorySearchAccess(env: Env, subject: AuthorizationSubject,
  resources: readonly AuthorizationResource[]): Promise<AuthorizationDecision[]> {
  const denied = (): AuthorizationDecision => ({ status: 'denied', reason: 'memory_scope_not_accessible', evidence: [] });
  if (!subject.delegation?.startsWith(PREFIX)) return resources.map(denied);
  const context = ContextSchema.parse(JSON.parse(subject.delegation.slice(PREFIX.length)));
  if (context.workspaceId !== subject.workspaceId
    || (context.executionPrincipal.type === 'user' ? context.executionPrincipal.userId : null) !== subject.userId) return resources.map(denied);
  const evidence = [{ owner: context.parentId, revision: context.harnessRunId, validatedAt: Date.now() }];
  let scopes: MemoryScope[];
  try { scopes = await resolveMemoryAccess(env, context); }
  catch (error) {
    if (error instanceof Error && ['memory_user_not_active_workspace_member', 'memory_run_context_not_found',
      'memory_run_principal_mismatch', 'memory_workspace_principal_mismatch'].includes(error.message)) return resources.map(() => ({ status: 'denied', reason: 'memory_scope_not_accessible', evidence }));
    throw error;
  }
  const ids = new Set(scopes.map((scope) => scope.memoryScopeId));
  return resources.map((resource) => resource.kind === 'memory' && resource.workspaceId === context.workspaceId && resource.parentId === context.parentId && ids.has(resource.scopeId)
    ? { status: 'allowed', evidence } : { status: 'denied', reason: 'memory_scope_not_accessible', evidence });
}
