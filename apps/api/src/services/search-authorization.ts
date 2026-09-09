import { z } from 'zod';
import type { AuthContext, Env } from '../env';
import { logInfo, logWarn, diagnosticErrorCode } from '../observability/logger';
import { AuthorizationService, authorizationWorkspace } from './authorization-service';
import { AccessContext, AuthorizationDecisionSchema, AuthorizationResourceSchema, AuthorizationSubjectSchema,
  type AuthorizationDecision, type AuthorizationResource, type AuthorizationSubject, type AuthorizationResolver } from './authorization-policy';

export const SearchAuthorizationTimingSchema = z.strictObject({ origin: z.enum(['source_mutation', 'workspace_mutation']).optional(), mutationAt: z.number().int().nonnegative(), enqueuedAt: z.number().int().nonnegative() });

export const SearchAuthorizationSnapshotSchema = z.strictObject({
  version: z.literal(1), generation: z.number().int().nonnegative(), timing: SearchAuthorizationTimingSchema.optional(), subject: AuthorizationSubjectSchema, resource: AuthorizationResourceSchema,
  decision: AuthorizationDecisionSchema, observedAt: z.number().int().nonnegative(),
});
export const SearchAuthorizationTargetSchema = z.strictObject({
  kind: z.enum(['resource', 'parent', 'connection']), id: z.string(),
});
export const SearchAuthorizationPushJobSchema = z.strictObject({
  type: z.literal('search_authorization_push_v1'), region: z.enum(['global', 'eu']),
  timing: SearchAuthorizationTimingSchema.optional(),
  workspaceId: AuthorizationSubjectSchema.shape.workspaceId, target: SearchAuthorizationTargetSchema.optional(),
});

export async function searchAuthorizationKey(subject: AuthorizationSubject, resource: AuthorizationResource) {
  const bytes = new TextEncoder().encode(JSON.stringify([1, subject, resource]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `search-authz:v1:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Search trusts regional projected decisions; canonical reads only populate misses or mutation jobs. */
export class SearchAuthorizationResolver implements AuthorizationResolver {
  constructor(private readonly env: Env, private readonly authority: AuthorizationResolver = new AuthorizationService(env)) {}

  private async write(snapshots: z.infer<typeof SearchAuthorizationSnapshotSchema>[]) {
    if (!snapshots.length) return { written: 0, superseded: 0, kvWriteMs: 0 };
    return (await authorizationWorkspace(this.env, snapshots[0]!.subject.workspaceId)).writeSearchAuthorizationSnapshots(snapshots);
  }

  async project(subject: AuthorizationSubject, resources: readonly AuthorizationResource[], stats?: { written: number; superseded: number; kvWriteMs: number; resolveMs: number }, timing?: z.infer<typeof SearchAuthorizationTimingSchema>) {
    const startedAt = Date.now();
    const generations = await (await authorizationWorkspace(this.env, subject.workspaceId)).registerSearchAuthorization({ subject, resources });
    const observedAt = Date.now();
    const decisions = await this.authority.checkMany(subject, resources);
    // An unavailable owner does not revoke an existing projected decision.
    if (stats) stats.resolveMs += Date.now() - startedAt;
    const publication = await this.write(decisions.flatMap((decision, index) => decision.status === 'unavailable' ? [] : [{
      version: 1 as const, generation: generations[index]!, ...(timing ? { timing } : {}), subject, resource: resources[index]!, decision, observedAt,
    }]));
    if (stats) { stats.written += publication.written; stats.superseded += publication.superseded; stats.kvWriteMs += publication.kvWriteMs; }
    return decisions;
  }

  async checkMany(subject: AuthorizationSubject, resources: readonly AuthorizationResource[]) {
    if (!resources.length) return [];
    const unavailable = (): AuthorizationDecision => ({ status: 'unavailable', reason: 'authority_unavailable', retryable: true });
    let raw: PromiseSettledResult<unknown>[];
    if (this.env.AVALON_REGION === 'global' && this.env.AUTHORIZATION_CACHE) {
      raw = await Promise.allSettled(resources.map(async (resource) => this.env.AUTHORIZATION_CACHE!.get(
        await searchAuthorizationKey(subject, resource), 'json')));
    } else {
      try { raw = (await (await authorizationWorkspace(this.env, subject.workspaceId)).readSearchAuthorizationSnapshots({ subject, resources }))
        .map((value) => ({ status: 'fulfilled' as const, value })); }
      catch { return resources.map(unavailable); }
    }
    const decisions: (AuthorizationDecision | null)[] = raw.map((result, index) => {
      if (result.status === 'rejected') return unavailable();
      const parsed = SearchAuthorizationSnapshotSchema.safeParse(result.value);
      return parsed.success && JSON.stringify(parsed.data.subject) === JSON.stringify(subject)
        && JSON.stringify(parsed.data.resource) === JSON.stringify(resources[index])
        && parsed.data.decision.status !== 'unavailable' ? parsed.data.decision : null;
    });
    const missing = resources.filter((_, index) => decisions[index] === null);
    let loaded: AuthorizationDecision[];
    try { loaded = missing.length ? await this.project(subject, missing) : []; }
    catch { loaded = missing.map(unavailable); }
    let index = 0;
    return decisions.map((decision) => decision ?? loaded[index++]!);
  }
}

export function createSearchAccessContext(env: Env, auth: AuthContext) {
  return new AccessContext({ workspaceId: auth.workspaceId, userId: auth.userId, delegation: null }, new SearchAuthorizationResolver(env));
}

/** Mutation-driven projection. Jobs contain only the workspace address and reload current owners. */
export async function pushSearchAuthorization(env: Env, job: z.infer<typeof SearchAuthorizationPushJobSchema>, attempt = 1) {
  if (job.region !== env.AVALON_REGION) throw new Error('search_authorization_region_mismatch');
  const startedAt = Date.now();
  const stats = { written: 0, superseded: 0, kvWriteMs: 0, resolveMs: 0 };
  let selected = 0;
  let selectionMs = 0;
  let outcome = 'failed';
  let errorCode: string | undefined;
  try {
    const snapshots = await (await authorizationWorkspace(env, job.workspaceId)).listSearchAuthorizationSnapshots({ workspaceId: job.workspaceId, ...(job.target ? { target: job.target } : {}) });
    selected = snapshots.length;
    selectionMs = Date.now() - startedAt;
    const subjects = new Map<string, { subject: AuthorizationSubject; resources: AuthorizationResource[] }>();
    for (const snapshot of snapshots) {
      const key = JSON.stringify(snapshot.subject);
      const group = subjects.get(key) ?? { subject: snapshot.subject, resources: [] };
      group.resources.push(snapshot.resource);
      subjects.set(key, group);
    }
    let failure: unknown;
    for (const { subject, resources } of subjects.values()) {
      try {
        const decisions = await new SearchAuthorizationResolver(env).project(subject, resources, stats, job.timing);
        if (decisions.some((decision) => decision.status === 'unavailable')) failure = new Error('search_authorization_push_unavailable');
      } catch (error) { failure = error; }
    }
    // A newer attempt may itself fail before publication; do not retire the mutation's retry intent.
    if (stats.superseded > 0) failure ??= new Error('search_authorization_push_superseded');
    if (failure) throw failure;
    outcome = selected === 0 ? 'no_registered_keys' : 'completed';
  } catch (error) {
    errorCode = diagnosticErrorCode(error, 'search_authorization_push_failed');
    throw error;
  } finally {
    const completedAt = Date.now();
    const fields = { workspace_id: job.workspaceId, target_kind: job.target?.kind ?? 'workspace', target_id: job.target?.id ?? null,
      outcome, attempt, error_code: errorCode, store: env.AVALON_REGION === 'global' && env.AUTHORIZATION_CACHE ? 'kv' : 'regional_sqlite',
      timing_origin: job.timing?.origin ?? 'unspecified',
      mutation_at: job.timing?.mutationAt ?? null, enqueued_at: job.timing?.enqueuedAt ?? null, completed_at: completedAt,
      mutation_to_write_ack_ms: job.timing && outcome === 'completed' && stats.written > 0 ? completedAt - job.timing.mutationAt : null,
      elapsed_since_mutation_ms: job.timing ? completedAt - job.timing.mutationAt : null,
      outbox_ms: job.timing ? job.timing.enqueuedAt - job.timing.mutationAt : null,
      queue_ms: job.timing ? startedAt - job.timing.enqueuedAt : null,
      duration_ms: completedAt - startedAt, selection_ms: selectionMs, resolve_ms: stats.resolveMs,
      kv_write_ms: stats.kvWriteMs, selected_keys: selected, written_keys: stats.written, superseded_keys: stats.superseded };
    if (outcome === 'failed') logWarn(env, 'authz_push_timing', fields);
    else logInfo(env, 'authz_push_timing', fields);
  }
}
