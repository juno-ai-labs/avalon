import { asWorkspaceId, asSubstreamId } from '@rally/contracts';
import type { AuthContext, Env, RequestMembershipObservation } from '../env';
import { durableObjectStubForWorkspace } from '../lib/durable-object-namespace';
import { workspaceDOName } from '../durable-objects/names';
import { authorizationSnapshotKey } from '../durable-objects/authorization-storage';
import { createResourceObjectPort } from '../runtime/resource-port';
import { createIdentityObjectPort } from '../runtime/identity-port';
import { conversationParentStub } from './conversation-parent-client';
import { ApiError } from '../lib/api-error';
import { logWarn } from '../observability/logger';
import type { HostedSidekick } from '../durable-objects/hosted-sidekick';
import type { WorkspaceDO } from '../durable-objects/workspace-do';
import type { WorkstreamResourceStorage } from '../durable-objects/workstream-resource-storage';
import {
  AccessContext, evaluateReadPolicy, owningChannelAdmitsMember, sidekickAdmitsMember,
  type AuthorizationDecision, type AuthorizationEvidence, type AuthorizationResource,
  type AuthorizationSubject, type ReadPolicy,
} from './authorization-policy';

const unavailable = (): AuthorizationDecision => ({ status: 'unavailable', reason: 'authority_unavailable', retryable: true });

function atReceipt<T extends { validatedAt: number }>(value: T, validatedAt = Date.now()): T {
  return { ...value, validatedAt };
}

function atBatchReceipt<T extends { validatedAt: number }>(values: readonly T[]): T[] {
  const validatedAt = Date.now();
  return values.map((value) => atReceipt(value, validatedAt));
}

async function ownerEvidence<T extends { validatedAt: number }>(cache: Map<string, Promise<T>>, key: string,
  load: () => Promise<T>): Promise<T> {
  const pending = cache.get(key);
  if (pending) return pending;
  const work = load().then((value) => atReceipt(value));
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

/** Canonical context for callers without a separately proven request membership. */
export function createAccessContext(env: Env, auth: AuthContext): AccessContext {
  return new AccessContext(
    { workspaceId: auth.workspaceId, userId: auth.userId, delegation: null },
    new AuthorizationService(env),
  );
}

export class AuthorizationService {
  private readonly requestMembership: RequestMembershipObservation | null;

  constructor(private readonly env: Env, requestMembership?: RequestMembershipObservation) {
    this.requestMembership = requestMembership ?? null;
  }

  async checkMany(subject: AuthorizationSubject, resources: readonly AuthorizationResource[]): Promise<AuthorizationDecision[]> {
    if (resources.length === 0) return [];
    const unique = [...new Map(resources.map((resource) => [authorizationSnapshotKey(subject, resource), resource])).values()];
    // One observation batch per call: a later check must never join an earlier read.
    const decisions = await new AuthorizationBatch(this.env, this.requestMembership).checkMany(subject, unique);
    const byKey = new Map(unique.map((resource, index) => [authorizationSnapshotKey(subject, resource), decisions[index]!]));
    return resources.map((resource) => byKey.get(authorizationSnapshotKey(subject, resource))!);
  }
}

/** Owner observations, including settled reads, live for exactly one batch. */
class AuthorizationBatch {
  private readonly parents = new Map<string, Promise<Awaited<ReturnType<WorkspaceDO['readAuthorizationFacts']>>>>();
  private readonly automations = new Map<string, Promise<ReturnType<HostedSidekick['readAuthorizationFacts']>>>();
  private readonly automationViewers = new Map<string, Promise<Awaited<ReturnType<HostedSidekick['authorizeViewer']>> & { validatedAt: number }>>();
  private readonly identities = new Map<string, Promise<Awaited<ReturnType<ReturnType<typeof createIdentityObjectPort>['readAuthorizationFacts']>>>>();
  private readonly attachments = new Map<string, Promise<ReturnType<WorkstreamResourceStorage['readAuthorizationFacts']>>>();
  private readonly memberships = new Map<string, Promise<{ active: boolean; guest: boolean; validatedAt: number }>>();
  private guest = false;
  private readonly parentScopes = new Map<string, Set<string>>();
  constructor(
    private readonly env: Env,
    private readonly requestMembership: RequestMembershipObservation | null,
  ) {}

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
    const membership = this.requestMembership?.workspaceId === subject.workspaceId
      && this.requestMembership.userId === subject.userId
      ? {
          active: true,
          guest: this.requestMembership.accessClass === 'guest',
          validatedAt: this.requestMembership.validatedAt,
        }
      : await ownerEvidence(this.memberships, JSON.stringify([subject.workspaceId, subject.userId]), async () => {
          const row = await this.env.DB.prepare(
            "SELECT access_class FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND status = 'active'",
          ).bind(subject.workspaceId, subject.userId).first<{ access_class: "member" | "guest" }>();
          return { active: Boolean(row), guest: row?.access_class === "guest", validatedAt: Date.now() };
        });
    this.guest = membership.guest;
    const membershipEvidence = { owner: `workspace:${subject.workspaceId}/member:${subject.userId}`,
      revision: membership.active ? (membership.guest ? 'guest:active' : 'member:active') : 'inactive', validatedAt: membership.validatedAt };
    const resourceIds = requested.flatMap((entry) => entry.resource.kind === 'resource' ? [entry.resource.resourceId] : []);
    const facts = membership.active && resourceIds.length
      ? atBatchReceipt(await workspace.authorizationResourceFacts({ workspaceId: subject.workspaceId, userId: subject.userId, resourceIds })) : [];
    const factsById = new Map(facts.map((value) => [value.resourceId, value]));
    // Gather the whole batch before reading an owner, including attachment locations.
    const addScope = (parentId: string, substreamId: string) => {
      const scopes = this.parentScopes.get(parentId) ?? new Set<string>();
      scopes.add(substreamId);
      this.parentScopes.set(parentId, scopes);
    };
    for (const resource of resources) {
      if (resource.kind === 'conversation') addScope(resource.parentId, resource.substreamId);
    }
    for (const resourceFacts of facts) {
      if (resourceFacts.exists) {
        for (const location of resourceFacts.locations) addScope(location.parentId, location.substreamId);
      }
    }
    const connectionIds = requested.flatMap((entry) => entry.resource.kind === 'connection' ? [entry.resource.connectionId] : []);
    const connections = membership.active && connectionIds.length
      ? atBatchReceipt(await workspace.authorizationConnectionFacts({ workspaceId: subject.workspaceId, userId: subject.userId, connectionIds })) : [];
    const connectionsById = new Map(connections.map((value) => [value.connectionId, value]));
    // Serialize distinct canonical owners rather than inventing another concurrency limit.
    // Resource facts above are batched for the whole page.
    for (const { resource, index } of requested) {
      let decision: AuthorizationDecision;
      try {
        decision = !membership.active ? evaluateReadPolicy(fact(false, 'workspace_membership_required', membershipEvidence), Date.now())
          : resource.kind === 'conversation' ? await this.conversation(subject, resource)
            : resource.kind === 'resource' ? await this.resource(subject, resource, factsById.get(resource.resourceId))
              : resource.kind === 'connection' ? this.connection(resource, connectionsById.get(resource.connectionId))
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
    const request = { workspaceId: subject.workspaceId, parentId: resource.parentId, userId: subject.userId, substreamIds: [...(this.parentScopes.get(resource.parentId) ?? [resource.substreamId])].map(asSubstreamId) };
    const workstream = await ownerEvidence(this.parents, JSON.stringify([subject, resource.parentId]), async () => {
      // Through the one dispatch point, so the namespace a parent kind resolves
      // to is decided in exactly one place in the tree.
      const parent = await conversationParentStub(this.env, {
        workspaceId: subject.workspaceId, parentKind: 'workstream', parentId: resource.parentId,
      }) as DurableObjectStub<WorkspaceDO>;
      const facts = await parent.readAuthorizationFacts(request);
      return facts.exists && facts.authority === "legacy" ? { ...facts, validatedAt: Math.min(facts.validatedAt, facts.main.validatedAt) } : facts;
    });
    if (workstream.exists) {
      const scope = workstream.scopes.find((value) => value.substreamId === resource.substreamId);
      if (scope || workstream.authority === "grants") {
        if (!scope) return unavailable();
        const evidence = { owner:resource.parentId,revision:scope.revision,validatedAt:workstream.validatedAt };
        if (!scope.access.allowed && scope.access.reason === "not_found") return { status:"not_found",resource,evidence:[evidence] };
        if (!scope.access.allowed && scope.access.reason === "not_ready") return { status:"unavailable",reason:"projection_incomplete",retryable:true };
        return evaluateReadPolicy(fact(scope.access.allowed,"not_participant",evidence),Date.now());
      }
      if (workstream.authority !== "legacy") return unavailable();
      if (this.guest) return evaluateReadPolicy(fact(false,'not_participant',{
        owner:resource.parentId,revision:'legacy',validatedAt:workstream.validatedAt,
      }),Date.now());
      const child = workstream.children.find((value) => value.substreamId === resource.substreamId);
      const mainEvidence = { owner: `${resource.parentId}/0`, revision: workstream.main.revision, validatedAt: workstream.validatedAt };
      const childEvidence = { owner: resource.parentId, revision: JSON.stringify([workstream.generation, child?.version]), validatedAt: workstream.validatedAt };
      if (!child?.exists || child.failed || !workstream.main.exists) return { status: 'not_found', resource, evidence: [mainEvidence, childEvidence] };
      if (!child.ready) return { status: 'unavailable', reason: 'projection_incomplete', retryable: true };
      // Main is read through the work stream; a breakout through its own roster
      // alone, so a breakout member need not be able to read Main.
      if (resource.substreamId === '0') {
        return evaluateReadPolicy(fact(workstream.main.scope === 'workspace' || workstream.main.participant,
          'not_participant', mainEvidence), Date.now());
      }
      return evaluateReadPolicy(fact(child.member, 'private_child_membership_required', childEvidence), Date.now());
    }
    const automation = await conversationParentStub(this.env, {
      workspaceId: subject.workspaceId, parentKind: 'automation', parentId: resource.parentId,
    });
    const facts = await ownerEvidence(this.automations, JSON.stringify([subject, resource.parentId, resource.substreamId]),
      async () => await automation.sidekickReadAuthorizationFacts({ ...request, substreamIds: [resource.substreamId] }) as
        ReturnType<HostedSidekick['readAuthorizationFacts']>);
    if (!facts.exists) return { status: 'not_found', resource,
      evidence: [{ owner: resource.parentId, revision: 'absent', validatedAt: Math.min(workstream.validatedAt, facts.validatedAt) }] };
    const evidence = { owner: resource.parentId, revision: facts.revision, validatedAt: facts.validatedAt };
    if (!facts.children.includes(resource.substreamId)) return { status: 'not_found', resource, evidence: [evidence] };
    if (this.guest) {
      const userId = subject.userId;
      const admission = await ownerEvidence(this.automationViewers, JSON.stringify([subject, resource.parentId, resource.substreamId]),
        async () => ({ ...await automation.authorizeViewer({ workspaceId: subject.workspaceId, parentId: resource.parentId,
          userId, substreamId: resource.substreamId, requireGrantAuthority: true }), validatedAt: Date.now() }));
      return evaluateReadPolicy(fact(admission.authorized, 'not_participant', evidence), Date.now());
    }
    const policies = [fact(sidekickAdmitsMember(facts), 'not_participant', evidence)];
    if (facts.scope === 'workstream' && facts.owningWorkstreamId) {
      const owningWorkstreamId = facts.owningWorkstreamId;
      // A Breakout home narrows the Sidekick's audience to that Breakout's
      // members: its own conversation object holds its participants.
      const owningSubstreamId = facts.owningSubstreamId ?? '0';
      const userId = subject.userId;
      const owner = await ownerEvidence(this.identities, JSON.stringify([subject, owningWorkstreamId, owningSubstreamId]),
        () => createIdentityObjectPort(this.env, subject.workspaceId, owningWorkstreamId, undefined, owningSubstreamId)
          .readAuthorizationFacts({ userId }));
      policies.push(fact(owner.exists && owningChannelAdmitsMember(owner), 'not_participant', {
        owner: `${owningWorkstreamId}/${owningSubstreamId}`, revision: owner.revision, validatedAt: owner.validatedAt,
      }));
    }
    // Automation existence/scope must remain evidence even when another relationship grants access.
    return evaluateReadPolicy({ kind: 'all', policies: [fact(true, 'not_participant', evidence),
      { kind: 'any', policies, reason: 'not_participant' }] }, Date.now());
  }

  /** The same predicate `resource()` applies to a connector resource, decided once per connection. */
  private connection(resource: Extract<AuthorizationResource, { kind: 'connection' }>,
    facts: Awaited<ReturnType<Awaited<ReturnType<typeof authorizationWorkspace>>['authorizationConnectionFacts']>>[number] | undefined): AuthorizationDecision {
    if (!facts) throw new Error('authorization_connection_facts_missing');
    const evidence = { owner: `connection:${resource.connectionId}`, revision: facts.exists ? facts.revision : 'absent', validatedAt: facts.validatedAt };
    if (!facts.exists) return { status: 'not_found', resource, evidence: [evidence] };
    return evaluateReadPolicy(fact(facts.allowed, 'connection_not_accessible', evidence), Date.now());
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
    if (baseDecision.status !== 'allowed' || (!facts.requiresAttachment && (!this.guest || facts.owned))) return baseDecision;
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
      owner: `workspace:${subject.workspaceId}/attachment-discovery`, revision: String(facts.discoveryAt), validatedAt: facts.validatedAt,
    }), Date.now());
  }
}
