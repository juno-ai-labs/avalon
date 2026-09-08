import { asAutomationId, asWorkspaceId, asWorkstreamId, asSubstreamId } from '@rally/contracts';
import type { AuthContext, Env } from '../env';
import { durableObjectStubForWorkspace } from '../lib/durable-object-namespace';
import { automationDOName, workstreamDOName, workspaceDOName } from '../durable-objects/names';
import { authorizationSnapshotKey } from '../durable-objects/authorization-storage';
import { createResourceObjectPort } from '../runtime/resource-port';
import { createIdentityObjectPort } from '../runtime/identity-port';
import { ApiError } from '../lib/api-error';
import { logWarn } from '../observability/logger';
import type { WorkstreamDO } from '../durable-objects/workstream-do';
import type { WorkstreamResourceStorage } from '../durable-objects/workstream-resource-storage';
import {
  AccessContext, AUTHORIZATION_FRESHNESS_MS, AUTHORIZATION_POLICY_VERSION, AuthorizationSnapshotSchema,
  decisionIsFresh, evaluateReadPolicy,
  type AuthorizationDecision, type AuthorizationEvidence, type AuthorizationResource,
  type AuthorizationSnapshot, type AuthorizationSubject, type ReadPolicy,
} from './authorization-policy';

const unavailable = (): AuthorizationDecision => ({ status: 'unavailable', reason: 'authority_unavailable', retryable: true });

async function ownerEvidence<T extends { validatedAt: number }>(cache: Map<string, Promise<T>>, key: string,
  load: () => Promise<T>): Promise<T> {
  const pending = cache.get(key);
  if (pending) {
    const value = await pending;
    if (value.validatedAt <= Date.now() && Date.now() < value.validatedAt + AUTHORIZATION_FRESHNESS_MS) return value;
  }
  const work = load();
  cache.set(key, work);
  void work.catch(() => { if (cache.get(key) === work) cache.delete(key); });
  return work;
}

export function authorizationWorkspace(env: Env, workspaceId: string) {
  return durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId,
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)));
}

function fact(granted: boolean, reason: Extract<ReadPolicy, { kind: 'fact' }>['reason'], evidence: AuthorizationEvidence): ReadPolicy {
  return { kind: 'fact', granted, reason, evidence };
}

function decisionPolicy(decision: AuthorizationDecision): ReadPolicy | null {
  if (decision.status === 'allowed' || decision.status === 'denied') return { kind: 'all', policies: decision.evidence.map((evidence) =>
    fact(decision.status === 'allowed', decision.status === 'denied' ? decision.reason : 'not_participant', evidence)) };
  return null;
}

/** Deliberate HTTP concealment belongs here, never in the internal evaluator. */
export function requireAuthorizedRead(decision: AuthorizationDecision): void {
  switch (decision.status) {
    case 'allowed': return;
    case 'denied':
    case 'not_found': throw new ApiError(404, 'resource_not_found', 'Resource not found');
    case 'unavailable': throw new ApiError(503, 'authorization_unavailable', 'Authorization could not be established. Retry the request.');
  }
}

/** Created once per trusted request; no model-provided or browser-provided grants. */
export function createAccessContext(env: Env, auth: AuthContext): AccessContext {
  return new AccessContext({ workspaceId: auth.workspaceId, userId: auth.userId, delegation: null }, new AuthorizationService(env));
}

export class AuthorizationService {
  private readonly pending = new Map<string, Promise<AuthorizationDecision>>();
  private readonly parents = new Map<string, Promise<Awaited<ReturnType<WorkstreamDO['readAuthorizationFacts']>>>>();
  private readonly attachments = new Map<string, Promise<ReturnType<WorkstreamResourceStorage['readAuthorizationFacts']>>>();
  private readonly memberships = new Map<string, Promise<{ active: boolean; validatedAt: number }>>();
  constructor(private readonly env: Env) {}

  async checkMany(subject: AuthorizationSubject, resources: readonly AuthorizationResource[]): Promise<AuthorizationDecision[]> {
    return Promise.all(resources.map((resource) => {
      const key = authorizationSnapshotKey(subject, resource);
      const existing = this.pending.get(key);
      if (existing) return existing.then((decision) => decisionIsFresh(decision, Date.now()) ? decision : this.safeCheck(subject, resource));
      const work = this.safeCheck(subject, resource);
      this.pending.set(key, work);
      // Unavailable evidence must be retryable within the same context too.
      void work.then((decision) => { if (decision.status === 'unavailable') this.pending.delete(key); }, () => this.pending.delete(key));
      return work;
    }));
  }

  private async safeCheck(subject: AuthorizationSubject, resource: AuthorizationResource): Promise<AuthorizationDecision> {
    try { return await this.check(subject, resource); }
    catch {
      logWarn(this.env, 'authorization_authority_read_failed', { region: this.env.AVALON_REGION, kind: resource.kind });
      return unavailable();
    }
  }

  private async cacheKey(subject: AuthorizationSubject, resource: AuthorizationResource): Promise<string> {
    const bytes = new TextEncoder().encode(authorizationSnapshotKey(subject, resource));
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((value) => value.toString(16).padStart(2, '0')).join('');
    return `authz:${this.env.APP_ENV}:${this.env.AVALON_REGION}:${AUTHORIZATION_POLICY_VERSION}:${hash}`;
  }

  private async check(subject: AuthorizationSubject, resource: AuthorizationResource): Promise<AuthorizationDecision> {
    if (resource.workspaceId !== subject.workspaceId) return { status: 'denied', reason: 'workspace_mismatch', evidence: [] };
    const kv = this.env.AVALON_REGION === 'global' ? this.env.AUTHORIZATION_CACHE : undefined;
    const key = kv ? await this.cacheKey(subject, resource) : null;
    if (kv && key) {
      try {
        const cached = AuthorizationSnapshotSchema.safeParse(await kv.get(key, 'json'));
        if (cached.success && authorizationSnapshotKey(cached.data.subject, cached.data.resource) === authorizationSnapshotKey(subject, resource)
          && decisionIsFresh(cached.data.decision, Date.now())) return cached.data.decision;
      } catch { logWarn(this.env, 'authorization_cache_read_failed', { region: this.env.AVALON_REGION }); }
    }
    const workspace = await authorizationWorkspace(this.env, subject.workspaceId);
    const [cached] = await workspace.readAuthorizationSnapshots({ subject, resources: [resource] });
    if (cached && decisionIsFresh(cached.decision, Date.now())) return cached.decision;
    if (!subject.userId) return { status: 'denied', reason: 'outside_delegation', evidence: [] };
    const membership = await ownerEvidence(this.memberships, JSON.stringify([subject.workspaceId, subject.userId]), async () => {
      // Capture before I/O: observing the result cannot renew an older authority read.
      const validatedAt = Date.now();
      const row = await this.env.DB.prepare(
        "SELECT 1 AS active FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND status = 'active'",
      ).bind(subject.workspaceId, subject.userId).first<{ active: number }>();
      return { active: Boolean(row), validatedAt };
    });
    const membershipEvidence = { owner: `workspace:${subject.workspaceId}/member:${subject.userId}`,
      revision: membership.active ? 'active' : 'inactive', validatedAt: membership.validatedAt };
    if (!membership.active) return evaluateReadPolicy(fact(false, 'workspace_membership_required', membershipEvidence), Date.now());
    let decision = resource.kind === 'conversation' ? await this.conversation(subject, resource)
      : resource.kind === 'resource' ? await this.resource(subject, resource)
        : { status: 'denied' as const, reason: 'memory_scope_not_accessible' as const, evidence: [] };
    if (decision.status === 'denied' && decision.evidence.length === 0) return decision;
    if (decision.status !== 'unavailable') decision = { ...decision, evidence: [membershipEvidence, ...decision.evidence] };
    if (!decisionIsFresh(decision, Date.now())) return decision.status === 'unavailable' ? decision
      : { status: 'unavailable', reason: 'evidence_expired', retryable: true };
    const snapshot: AuthorizationSnapshot = { policyVersion: AUTHORIZATION_POLICY_VERSION, subject, resource, decision };
    await workspace.writeAuthorizationSnapshots([snapshot]);
    if (kv && key) {
      try { await kv.put(key, JSON.stringify(snapshot), { expirationTtl: AUTHORIZATION_FRESHNESS_MS / 1_000 }); }
      catch { logWarn(this.env, 'authorization_cache_write_failed', { region: this.env.AVALON_REGION }); }
    }
    return decisionIsFresh(decision, Date.now()) ? decision
      : { status: 'unavailable', reason: 'evidence_expired', retryable: true };
  }

  private async conversation(subject: AuthorizationSubject, resource: Extract<AuthorizationResource, { kind: 'conversation' }>): Promise<AuthorizationDecision> {
    if (!subject.userId) return { status: 'denied', reason: 'outside_delegation', evidence: [] };
    const request = { workspaceId: subject.workspaceId, parentId: resource.parentId, userId: subject.userId, substreamIds: [resource.substreamId] };
    const parent = await durableObjectStubForWorkspace(this.env, this.env.WORKSTREAM_DOS, subject.workspaceId,
      workstreamDOName(this.env.AVALON_REGION, subject.workspaceId, asWorkstreamId(resource.parentId)));
    const workstream = await ownerEvidence(this.parents, JSON.stringify([subject, resource.parentId]), async () => {
      const facts = await parent.readAuthorizationFacts({ ...request, substreamIds: [] });
      return facts.exists ? { ...facts, validatedAt: Math.min(facts.validatedAt, facts.main.validatedAt) } : facts;
    });
    if (workstream.exists) {
      const child = workstream.children.find((value) => value.substreamId === resource.substreamId);
      const mainEvidence = { owner: `${resource.parentId}/0`, revision: workstream.main.revision, validatedAt: workstream.main.validatedAt };
      const childEvidence = { owner: resource.parentId, revision: JSON.stringify([workstream.generation, child?.version]), validatedAt: workstream.validatedAt };
      if (!child?.exists || !workstream.main.exists) return { status: 'not_found', resource, evidence: [mainEvidence, childEvidence] };
      if (!child.ready) return { status: 'unavailable', reason: 'projection_incomplete', retryable: true };
      return evaluateReadPolicy({ kind: 'all', policies: [
        fact(workstream.main.scope === 'workspace' || workstream.main.participant, 'not_participant', mainEvidence),
        fact(child.member, 'private_child_membership_required', childEvidence),
      ] }, Date.now());
    }
    const automation = await durableObjectStubForWorkspace(this.env, this.env.AUTOMATION_DOS, subject.workspaceId,
      automationDOName(this.env.AVALON_REGION, subject.workspaceId, asAutomationId(resource.parentId)));
    const facts = await automation.readAuthorizationFacts(request);
    if (!facts.exists) return { status: 'not_found', resource,
      evidence: [{ owner: resource.parentId, revision: 'absent', validatedAt: Math.min(workstream.validatedAt, facts.validatedAt) }] };
    const evidence = { owner: resource.parentId, revision: facts.revision, validatedAt: facts.validatedAt };
    if (!facts.children.includes(resource.substreamId)) return { status: 'not_found', resource, evidence: [evidence] };
    const policies = [fact(facts.scope === 'workspace' || facts.author || facts.executor, 'not_participant', evidence)];
    if (facts.scope === 'workstream' && facts.owningWorkstreamId) {
      const owner = await createIdentityObjectPort(this.env, subject.workspaceId, facts.owningWorkstreamId)
        .readAuthorizationFacts({ userId: subject.userId });
      policies.push(fact(owner.exists && owner.participant, 'not_participant', {
        owner: `${facts.owningWorkstreamId}/0`, revision: owner.revision, validatedAt: owner.validatedAt,
      }));
    }
    // Automation existence/scope must remain evidence even when another relationship grants access.
    return evaluateReadPolicy({ kind: 'all', policies: [fact(true, 'not_participant', evidence),
      { kind: 'any', policies, reason: 'not_participant' }] }, Date.now());
  }

  private async resource(subject: AuthorizationSubject, resource: Extract<AuthorizationResource, { kind: 'resource' }>): Promise<AuthorizationDecision> {
    if (!subject.userId) return { status: 'denied', reason: 'outside_delegation', evidence: [] };
    const workspace = await authorizationWorkspace(this.env, subject.workspaceId);
    const [facts] = await workspace.authorizationResourceFacts({ workspaceId: subject.workspaceId, userId: subject.userId, resourceIds: [resource.resourceId] });
    if (!facts) throw new Error('authorization_resource_facts_missing');
    const evidence = { owner: `resource:${resource.resourceId}`, revision: facts.exists ? facts.revision : 'absent', validatedAt: facts.validatedAt };
    if (!facts.exists) return { status: 'not_found', resource, evidence: [evidence] };
    const base: ReadPolicy = { kind: 'all', policies: [
      fact(facts.connectionAllowed, 'connection_not_accessible', evidence),
      fact(facts.noteAllowed && facts.draftAllowed, 'resource_not_shared', evidence),
    ] };
    const baseDecision = evaluateReadPolicy(base, Date.now());
    if (baseDecision.status !== 'allowed' || !facts.requiresAttachment) return baseDecision;
    const alternatives: ReadPolicy[] = [];
    let incomplete = false;
    await Promise.all(facts.locations.map(async (location) => {
      const [permission] = await this.checkMany(subject, [{ kind: 'conversation', workspaceId: subject.workspaceId,
        parentId: location.parentId, substreamId: asSubstreamId(location.substreamId) }]);
      if (!permission) throw new Error('authorization_location_decision_missing');
      if (permission.status === 'unavailable') { incomplete = true; return; }
      if (permission.status !== 'allowed') return;
      const attachment = await ownerEvidence(this.attachments, JSON.stringify([subject.workspaceId, location.parentId, location.substreamId]),
        () => createResourceObjectPort(this.env, subject.workspaceId, location.parentId, undefined, location.substreamId).readAuthorizationFacts());
      const policy = decisionPolicy(permission);
      if (policy && attachment.resourceIds.includes(resource.resourceId)) alternatives.push({ kind: 'all', policies: [policy,
        fact(true, 'resource_not_shared', { owner: `${location.parentId}/${location.substreamId}/attachments`,
          revision: String(attachment.revision), validatedAt: attachment.validatedAt })] });
    }));
    if (!alternatives.length && !facts.projectionComplete) {
      await workspace.beginAuthorizationBackfill({ workspaceId: subject.workspaceId, refresh: false });
      return { status: 'unavailable', reason: 'projection_incomplete', retryable: true };
    }
    if (!alternatives.length && incomplete) return unavailable();
    if (!alternatives.length) {
      const decision = evaluateReadPolicy(fact(false, 'resource_not_shared', {
        owner: `workspace:${subject.workspaceId}/attachment-discovery`, revision: String(facts.discoveryAt), validatedAt: facts.discoveryAt,
      }), Date.now());
      if (decision.status === 'unavailable') await workspace.beginAuthorizationBackfill({ workspaceId: subject.workspaceId });
      return decision;
    }
    return evaluateReadPolicy({ kind: 'all', policies: [base, { kind: 'any', policies: alternatives, reason: 'resource_not_shared' }] }, Date.now());
  }
}
