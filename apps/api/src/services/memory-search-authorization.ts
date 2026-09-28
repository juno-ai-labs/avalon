import { z } from 'zod';
import { ExecutionPrincipalSchema, HarnessRunIdSchema, IdSchema, WorkspaceIdSchema, type WorkstreamWorkflowInput } from '@rally/contracts';
import type { Env } from '../env';
import type { AuthorizationDecision, AuthorizationResource, AuthorizationSubject } from './authorization-policy';
import { resolveMemoryAccess, type MemoryScope } from './memory-service';

const ContextSchema = z.strictObject({ workspaceId: WorkspaceIdSchema, parentId: IdSchema,
  // No `space` arm: memory search runs inside an agent loop, and a Space never
  // starts one. Narrower than `ConversationParentKindSchema` so that a caller
  // that somehow reached here with one is named at the boundary rather than
  // silently searching a Channel's memory scope.
  parentKind: z.enum(['workstream', 'automation']), harnessRunId: HarnessRunIdSchema, executionPrincipal: ExecutionPrincipalSchema });
const PREFIX = 'memory-search:v1:';
/** What `resolveMemoryAccess` throws for a run that may read no memory. */
const MEMORY_ACCESS_DENIALS = ['memory_user_not_active_workspace_member', 'memory_run_context_not_found',
  'memory_run_principal_mismatch', 'memory_workspace_principal_mismatch'];

/**
 * The memory scopes a run may search: the canonical run check,
 * `resolveMemoryAccess`, once per search. Nothing is cached across runs and no
 * decision is stored; a run-keyed decision would never be reused (see
 * docs/PRDs/2026-09-26_search-audience-filtering/design.md#memory-search).
 * A run that no longer matches its principal or Organization searches nothing.
 */
export async function resolveMemorySearchAccess(env: Env, input: WorkstreamWorkflowInput): Promise<MemoryScope[]> {
  const context = ContextSchema.parse({ workspaceId: input.workspaceId, parentId: input.parentId,
    parentKind: input.parentKind, harnessRunId: input.harnessRunId, executionPrincipal: input.executionPrincipal });
  try { return await resolveMemoryAccess(env, context); }
  catch (error) {
    if (error instanceof Error && MEMORY_ACCESS_DENIALS.includes(error.message)) return [];
    throw error;
  }
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
    if (error instanceof Error && MEMORY_ACCESS_DENIALS.includes(error.message)) return resources.map(() => ({ status: 'denied', reason: 'memory_scope_not_accessible', evidence }));
    throw error;
  }
  const ids = new Set(scopes.map((scope) => scope.memoryScopeId));
  return resources.map((resource) => resource.kind === 'memory' && resource.workspaceId === context.workspaceId && resource.parentId === context.parentId && ids.has(resource.scopeId)
    ? { status: 'allowed', evidence } : { status: 'denied', reason: 'memory_scope_not_accessible', evidence });
}
