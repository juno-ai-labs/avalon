import { asAutomationId, asWorkspaceId, asWorkstreamId, asSubstreamId } from '@rally/contracts';
import type { AuthContext, Env } from '../env';
import { durableObjectStubForWorkspace } from '../lib/durable-object-namespace';
import { automationDOName, workstreamDOName, workspaceDOName } from '../durable-objects/names';
import { authorizationSnapshotKey } from '../durable-objects/authorization-storage';
import { createResourceObjectPort } from '../runtime/resource-port';
import { createIdentityObjectPort } from '../runtime/identity-port';
import { ApiError } from '../lib/api-error';
import { logWarn } from '../observability/logger';
import type { AutomationDO } from '../durable-objects/automation-do';
import type { WorkstreamDO } from '../durable-objects/workstream-do';
import type { WorkstreamResourceStorage } from '../durable-objects/workstream-resource-storage';
import {
  AccessContext, evaluateReadPolicy,
  type AuthorizationDecision, type AuthorizationEvidence, type AuthorizationResource,
  type AuthorizationSubject, type ReadPolicy,
} from './authorization-policy';

const unavailable = (): AuthorizationDecision => ({ status: 'unavailable', reason: 'authority_unavailable', retryable: true });

async function ownerEvidence<T extends { validatedAt: number }>(cache: Map<string, Promise<T>>, key: string,
  load: () => Promise<T>): Promise<T> {
  const pending = cache.get(key);
  if (pending) return pending;
  const work = load();
  cache.set(key, work);
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
  constructor(private readonly env: Env) {}

  async checkMany(subject: AuthorizationSubject, resources: readonly AuthorizationResource[]): Promise<AuthorizationDecision[]> {
    if (resources.length === 0) return [];
    const unique = [...new Map(resources.map((resource) => [authorizationSnapshotKey(subject, resource), resource])).values()];
    // One observation batch per call: a later check must never join an earlier read.
    const decisions = await new AuthorizationBatch(this.env).checkMany(subject, unique);
    const byKey = new Map(unique.map((resource, index) => [authorizationSnapshotKey(subject, resource), decisions[index]!]));
    return resources.map((resource) => byKey.get(authorizationSnapshotKey(subject, resource))!);
  }
}

/** Owner observations, including settled reads, live for exactly one batch. */
class AuthorizationBatch {
  private readonly parents = new Map<string, Promise<Awaited<ReturnType<WorkstreamDO['readAuthorizationFacts']>>>>();
  private readonly automations = new Map<string, Promise<Awaited<ReturnType<AutomationDO['readAuthorizationFacts']>>>>();
  private readonly identities = new Map<string, Promise<Awaited<ReturnType<ReturnType<typeof createIdentityObjectPort>['readAuthorizationFacts']>>>>();
  private readonly attachments = new Map<string, Promise<ReturnType<WorkstreamResourceStorage['readAuthorizationFacts']>>>();
  private readonly memberships = new Map<string, Promise<{ active: boolean; validatedAt: number }>>();
  constructor(private readonly env: Env) {}

  async checkMany(subject: AuthorizationSubject, resources: readonly AuthorizationResource[]): Promise<AuthorizationDecision[]> {
    try { return await this.checkBatch(subject, resources); }
    catch {
      logWarn(this.env, 'authorization_authority_read_failed', { region: this.env.AVALON_REGION });
      return resources.map(() => unavailable());
    }
  }

  private async checkBatch(subject: AuthorizationSubject, resources: readonly AuthorizationResource[]): Promise<AuthorizationDecision[]> {
    const workspace = await authorizationWorkspace(this.env, subject.workspaceId);
    // Reuse owner observations within this batch only; no clock-based lease.
    const decisions: AuthorizationDecision[] = [];
    const requested = resources.map((resource, index) => ({ resource, index }));
    if (!subject.userId) return resources.map(() => ({ status: 'denied', reason: 'outside_delegation', evidence: [] }));
    const membership = await ownerEvidence(this.memberships, JSON.stringify([subject.workspaceId, subject.userId]), async () => {
      const validatedAt = Date.now();
      const row = await this.env.DB.prepare(
        "SELECT 1 AS active FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND status = 'active'",
      ).bind(subject.workspaceId, subject.userId).first<{ active: number }>();
      return { active: Boolean(row), validatedAt };
    });
    const membershipEvidence = { owner: `workspace:${subject.workspaceId}/member:${subject.userId}`,
      revision: membership.active ? 'active' : 'inactive', validatedAt: membership.validatedAt };
    const resourceIds = requested.flatMap((entry) => entry.resource.kind === 'resource' ? [entry.resource.resourceId] : []);
    const facts = membership.active && resourceIds.length
      ? await workspace.authorizationResourceFacts({ workspaceId: subject.workspaceId, userId: subject.userId, resourceIds }) : [];
    const factsById = new Map(facts.map((value) => [value.resourceId, value]));
    // Serialize distinct canonical owners rather than inventing another concurrency limit.
    // Resource facts above are batched for the whole page.
    for (const { resource, index } of requested) {
      let decision: AuthorizationDecision;
      try {
        decision = !membership.active ? evaluateReadPolicy(fact(false, 'workspace_membership_required', membershipEvidence), Date.now())
          : resource.kind === 'conversation' ? await this.conversation(subject, resource)
            : resource.kind === 'resource' ? await this.resource(subject, resource, factsById.get(resource.resourceId))
              : { status: 'denied', reason: 'memory_scope_not_accessible', evidence: [] };
        if (decision.status !== 'unavailable' && decision.evidence.length) decision = { ...decision, evidence: [membershipEvidence, ...decision.evidence] };
      } catch {
        logWarn(this.env, 'authorization_authority_read_failed', { region: this.env.AVALON_REGION, kind: resource.kind });
        decision = unavailable();
      }
      decisions[index] = decision;
    }
    return decisions as AuthorizationDecision[];
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
      if (!child?.exists || child.failed || !workstream.main.exists) return { status: 'not_found', resource, evidence: [mainEvidence, childEvidence] };
      if (!child.ready) return { status: 'unavailable', reason: 'projection_incomplete', retryable: true };
      return evaluateReadPolicy({ kind: 'all', policies: [
        fact(workstream.main.scope === 'workspace' || workstream.main.participant, 'not_participant', mainEvidence),
        fact(child.member, 'private_child_membership_required', childEvidence),
      ] }, Date.now());
    }
    const automation = await durableObjectStubForWorkspace(this.env, this.env.AUTOMATION_DOS, subject.workspaceId,
      automationDOName(this.env.AVALON_REGION, subject.workspaceId, asAutomationId(resource.parentId)));
    const facts = await ownerEvidence(this.automations, JSON.stringify([subject, resource.parentId, resource.substreamId]),
      () => automation.readAuthorizationFacts(request));
    if (!facts.exists) return { status: 'not_found', resource,
      evidence: [{ owner: resource.parentId, revision: 'absent', validatedAt: Math.min(workstream.validatedAt, facts.validatedAt) }] };
    const evidence = { owner: resource.parentId, revision: facts.revision, validatedAt: facts.validatedAt };
    if (!facts.children.includes(resource.substreamId)) return { status: 'not_found', resource, evidence: [evidence] };
    const policies = [fact(facts.scope === 'workspace' || facts.author || facts.executor, 'not_participant', evidence)];
    if (facts.scope === 'workstream' && facts.owningWorkstreamId) {
      const owningWorkstreamId = facts.owningWorkstreamId;
      const userId = subject.userId;
      const owner = await ownerEvidence(this.identities, JSON.stringify([subject, owningWorkstreamId]),
        () => createIdentityObjectPort(this.env, subject.workspaceId, owningWorkstreamId)
          .readAuthorizationFacts({ userId }));
      policies.push(fact(owner.exists && !owner.archived && owner.participant, 'not_participant', {
        owner: `${facts.owningWorkstreamId}/0`, revision: owner.revision, validatedAt: owner.validatedAt,
      }));
    }
    // Automation existence/scope must remain evidence even when another relationship grants access.
    return evaluateReadPolicy({ kind: 'all', policies: [fact(true, 'not_participant', evidence),
      { kind: 'any', policies, reason: 'not_participant' }] }, Date.now());
  }

  private async resource(subject: AuthorizationSubject, resource: Extract<AuthorizationResource, { kind: 'resource' }>,
    facts: Awaited<ReturnType<Awaited<ReturnType<typeof authorizationWorkspace>>['authorizationResourceFacts']>>[number] | undefined): Promise<AuthorizationDecision> {
    if (!subject.userId) return { status: 'denied', reason: 'outside_delegation', evidence: [] };
    const workspace = await authorizationWorkspace(this.env, subject.workspaceId);
    if (!facts) throw new Error('authorization_resource_facts_missing');
    const evidence = { owner: `resource:${resource.resourceId}`, revision: facts.exists ? facts.revision : 'absent', validatedAt: facts.validatedAt };
    if (!facts.exists) return { status: 'not_found', resource, evidence: [evidence] };
    const base: ReadPolicy = { kind: 'all', policies: [
      fact(facts.connectionAllowed, 'connection_not_accessible', evidence),
      fact(facts.noteAllowed && facts.draftAllowed, 'resource_not_shared', evidence),
    ] };
    const baseDecision = evaluateReadPolicy(base, Date.now());
    if (baseDecision.status !== 'allowed' || !facts.requiresAttachment) return baseDecision;
    let incomplete = false;
    for (const location of facts.locations) {
      // Do not await a top-level batch that may itself contain this conversation.
      const permission = await this.conversation(subject, { kind: 'conversation', workspaceId: subject.workspaceId,
        parentId: location.parentId, substreamId: asSubstreamId(location.substreamId) });
      if (permission.status === 'unavailable') { incomplete = true; continue; }
      if (permission.status !== 'allowed') continue;
      const attachment = await ownerEvidence(this.attachments, JSON.stringify([subject.workspaceId, location.parentId, location.substreamId]),
        () => createResourceObjectPort(this.env, subject.workspaceId, location.parentId, undefined, location.substreamId).readAuthorizationFacts());
      const policy = decisionPolicy(permission);
      if (policy && attachment.resourceIds.includes(resource.resourceId)) {
        const decision = evaluateReadPolicy({ kind: 'all', policies: [base, policy,
          fact(true, 'resource_not_shared', { owner: `${location.parentId}/${location.substreamId}/attachments`,
            revision: String(attachment.revision), validatedAt: attachment.validatedAt })] }, Date.now());
        if (decision.status === 'allowed') return decision;
        if (decision.status === 'unavailable') incomplete = true;
      }
    }
    if (!facts.projectionComplete) {
      await workspace.beginAuthorizationBackfill({ workspaceId: subject.workspaceId, refresh: false });
      return { status: 'unavailable', reason: 'projection_incomplete', retryable: true };
    }
    if (incomplete) return unavailable();
    return evaluateReadPolicy(fact(false, 'resource_not_shared', {
      owner: `workspace:${subject.workspaceId}/attachment-discovery`, revision: String(facts.discoveryAt), validatedAt: facts.discoveryAt,
    }), Date.now());
  }
}
