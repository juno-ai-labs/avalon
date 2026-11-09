import { RegionSchema } from "@rally/contracts/regions";
import { z } from 'zod';
import type { Env } from '../env';
import { logInfo, logWarn, diagnosticErrorCode } from '../observability/logger';
import { AuthorizationService, authorizationWorkspace } from './authorization-service';
import { AuthorizationDecisionSchema, AuthorizationResourceSchema, AuthorizationSubjectSchema,
  type AuthorizationDecision, type AuthorizationResource, type AuthorizationSubject, type AuthorizationResolver } from './authorization-policy';

export const SearchAuthorizationTimingSchema = z.strictObject({ origin: z.enum(['source_mutation', 'workspace_mutation']).optional(), mutationAt: z.number().int().nonnegative(), enqueuedAt: z.number().int().nonnegative() });

export const SearchAuthorizationSnapshotSchema = z.strictObject({
  version: z.literal(1), generation: z.number().int().nonnegative(), timing: SearchAuthorizationTimingSchema.optional(), subject: AuthorizationSubjectSchema, resource: AuthorizationResourceSchema,
  decision: AuthorizationDecisionSchema, observedAt: z.number().int().nonnegative(),
});
export const SearchAuthorizationTargetSchema = z.strictObject({
  kind: z.enum(['resource', 'parent', 'connection', 'member']), id: z.string(),
});
export const SearchAuthorizationPushJobSchema = z.strictObject({
  type: z.literal('search_authorization_push_v1'), region: RegionSchema,
  timing: SearchAuthorizationTimingSchema.optional(),
  workspaceId: AuthorizationSubjectSchema.shape.workspaceId, target: SearchAuthorizationTargetSchema.optional(),
});

export async function searchAuthorizationKey(subject: AuthorizationSubject, resource: AuthorizationResource) {
  const bytes = new TextEncoder().encode(JSON.stringify([1, AuthorizationSubjectSchema.parse(subject), AuthorizationResourceSchema.parse(resource)]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `search-authz:v1:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * What a reader of a published decision acts on: the outcome and the owner
 * revisions behind it. Receipt times, the generation and job timing are left
 * out, so a push that re-derives the same decision matches what KV already holds.
 */
export function searchDecisionFingerprint(decision: AuthorizationDecision) {
  const evidence = decision.status === 'unavailable' ? [] : decision.evidence;
  return JSON.stringify([{ ...decision, evidence: undefined }, evidence.map((item) => [item.owner, item.revision])]);
}

type PublicationStats = { written: number; unchanged: number; superseded: number; kvWriteMs: number };
type ProjectionStats = PublicationStats & { resolveMs: number };

/** Work a request hands past its own response, typically `ExecutionContext.waitUntil`. */
export type DeferredWork = (work: Promise<unknown>) => void;

/** Search trusts regional projected decisions; canonical reads only populate misses or mutation jobs. */
export class SearchAuthorizationResolver implements AuthorizationResolver {
  constructor(private readonly env: Env, private readonly authority: AuthorizationResolver = new AuthorizationService(env),
    /**
     * Member search: a decision the projection does not hold yet is answered
     * unavailable and filled after the response, so no request waits for a
     * canonical owner. Callers without it keep the inline fill.
     */
    private readonly defer?: DeferredWork) {}

  private async write(snapshots: z.infer<typeof SearchAuthorizationSnapshotSchema>[]) {
    if (!snapshots.length) return { written: 0, unchanged: 0, superseded: 0, kvWriteMs: 0 };
    return (await authorizationWorkspace(this.env, snapshots[0]!.subject.workspaceId)).writeSearchAuthorizationSnapshots(snapshots);
  }

  /**
   * Resolve and publish decisions. A push claims every key it is given. A
   * search fill claims only keys nobody registered yet: a registered key
   * already belongs to a push, which retries on its own, so a fill that took
   * it over could drop that push's write and then fail with no retry behind it.
   */
  async project(subject: AuthorizationSubject, resources: readonly AuthorizationResource[], options: {
    stats?: ProjectionStats; timing?: z.infer<typeof SearchAuthorizationTimingSchema>; claim?: 'all' | 'unregistered';
  } = {}) {
    const { stats, timing } = options;
    const startedAt = Date.now();
    const generations = await (await authorizationWorkspace(this.env, subject.workspaceId)).registerSearchAuthorization({
      subject, resources, ...(options.claim === 'unregistered' ? { unregisteredOnly: true } : {}) });
    const observedAt = Date.now();
    const decisions = await this.authority.checkMany(subject, resources);
    // An unavailable owner does not revoke an existing projected decision.
    if (stats) stats.resolveMs += Date.now() - startedAt;
    const publication = await this.write(decisions.flatMap((decision, index) => {
      const generation = generations[index];
      return decision.status === 'unavailable' || generation === null || generation === undefined ? [] : [{
        version: 1 as const, generation, ...(timing ? { timing } : {}), subject, resource: resources[index]!, decision, observedAt,
      }];
    }));
    if (stats) {
      stats.written += publication.written; stats.unchanged += publication.unchanged;
      stats.superseded += publication.superseded; stats.kvWriteMs += publication.kvWriteMs;
    }
    return decisions;
  }

  async checkMany(subject: AuthorizationSubject, resources: readonly AuthorizationResource[]) {
    if (!resources.length) return [];
    subject = AuthorizationSubjectSchema.parse(subject);
    resources = resources.map((resource) => AuthorizationResourceSchema.parse(resource));
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
        ? parsed.data.decision : null;
    });
    const missedIndexes = resources.flatMap((_, index) => decisions[index] === null ? [index] : []);
    if (!missedIndexes.length) return decisions as AuthorizationDecision[];
    const fill = async (): Promise<Map<number, AuthorizationDecision>> => {
      const resolved = new Map<number, AuthorizationDecision>();
      let pending = missedIndexes;
      // KV caches negative lookups too. A miss is not evidence that the durable projection is absent.
      if (this.env.AVALON_REGION === 'global' && this.env.AUTHORIZATION_CACHE) {
        try {
          const workspace = await authorizationWorkspace(this.env, subject.workspaceId);
          const stored = await workspace.readSearchAuthorizationSnapshots({ subject, resources: pending.map((index) => resources[index]!) });
          for (const [offset, snapshot] of stored.entries()) {
            if (snapshot) resolved.set(pending[offset]!, snapshot.decision);
          }
          // Put the durable decision back into KV, under its generation fence,
          // so the next search reads it there instead of missing again. A
          // failed put is already queued for retry by the object.
          const republish = stored.filter((snapshot) => snapshot !== null);
          // KV missed, so it lacks the decision whatever the object last recorded.
          if (republish.length) await workspace.writeSearchAuthorizationSnapshots(republish, { republish: true }).catch(() => undefined);
        } catch {
          // An unavailable projection store must not trigger a more expensive authority walk.
          for (const index of pending) resolved.set(index, unavailable());
        }
        pending = pending.filter((index) => !resolved.has(index));
      }
      if (pending.length) {
        try {
          const loaded = await this.project(subject, pending.map((index) => resources[index]!), { claim: 'unregistered' });
          pending.forEach((index, offset) => resolved.set(index, loaded[offset]!));
        } catch { for (const index of pending) resolved.set(index, unavailable()); }
      }
      return resolved;
    };
    if (this.defer) {
      // The response never waits for an owner. The fill registers the key and
      // publishes through the projection, so the next search finds the decision.
      this.defer(fill().catch(() => undefined));
      return decisions.map((decision) => decision ?? unavailable());
    }
    const resolved = await fill();
    return decisions.map((decision, index) => decision ?? resolved.get(index)!);
  }
}

/**
 * Mutation-driven projection. Jobs contain only the workspace address and
 * reload current owners. A targeted job first registers every pair its target
 * reaches, so a decision exists before the first search that would need it;
 * the read path then never has to fill one.
 */
export async function pushSearchAuthorization(env: Env, job: z.infer<typeof SearchAuthorizationPushJobSchema>, attempt = 1) {
  if (job.region !== env.AVALON_REGION) throw new Error('search_authorization_region_mismatch');
  const startedAt = Date.now();
  const stats: ProjectionStats = { written: 0, unchanged: 0, superseded: 0, kvWriteMs: 0, resolveMs: 0 };
  let selected = 0;
  let registered = 0;
  let selectionMs = 0;
  let outcome = 'failed';
  let errorCode: string | undefined;
  try {
    const workspace = await authorizationWorkspace(env, job.workspaceId);
    if (job.target) {
      for (const pair of await workspace.enumerateSearchAuthorization({ workspaceId: job.workspaceId, target: job.target })) {
        registered += (await workspace.registerSearchAuthorization(pair)).length;
      }
    }
    const snapshots = await workspace.listSearchAuthorizationSnapshots({ workspaceId: job.workspaceId, ...(job.target ? { target: job.target } : {}) });
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
        const decisions = await new SearchAuthorizationResolver(env).project(subject, resources, { stats, ...(job.timing ? { timing: job.timing } : {}) });
        if (decisions.some((decision) => decision.status === 'unavailable')) failure = new Error('search_authorization_push_unavailable');
      } catch (error) { failure = error; }
    }
    // A superseded key belongs to a newer push, which read owners later and
    // retries its own failures. Only pushes claim registered keys, so
    // retrying here would only take the key back and supersede that push.
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
      kv_write_ms: stats.kvWriteMs, registered_keys: registered, selected_keys: selected, written_keys: stats.written, unchanged_keys: stats.unchanged, superseded_keys: stats.superseded };
    if (outcome === 'failed') logWarn(env, 'authz_push_timing', fields);
    else logInfo(env, 'authz_push_timing', fields);
  }
}
