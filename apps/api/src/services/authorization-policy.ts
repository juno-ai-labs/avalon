import { z } from 'zod';
import { IdSchema, SubstreamIdSchema, WorkspaceIdSchema, UserIdSchema } from '@rally/contracts';
import { WorkspaceRelationshipSchema } from '@rally/contracts/scope-grants';

export const AUTHORIZATION_POLICY_VERSION = 1;

export const AuthorizationResourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('conversation'), workspaceId: WorkspaceIdSchema,
    parentId: IdSchema, substreamId: SubstreamIdSchema }),
  z.strictObject({ kind: z.literal('resource'), workspaceId: WorkspaceIdSchema, resourceId: IdSchema }),
  z.strictObject({ kind: z.literal('memory'), workspaceId: WorkspaceIdSchema, scopeId: IdSchema, parentId: IdSchema }),
  // A connector's resources are readable exactly when the connection is: one
  // decision per (subject, connection) admits every row the connection synced.
  z.strictObject({ kind: z.literal('connection'), workspaceId: WorkspaceIdSchema, connectionId: IdSchema }),
]);
export type AuthorizationResource = z.infer<typeof AuthorizationResourceSchema>;

export const AuthorizationSubjectSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  userId: UserIdSchema.nullable(),
  /** Host-owned execution identity; never a model-supplied user ID. */
  delegation: z.string().nullable(),
});
export type AuthorizationSubject = z.infer<typeof AuthorizationSubjectSchema>;

export const ConversationAuthorizationRequestSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema, parentId: IdSchema, userId: UserIdSchema,
  substreamIds: z.array(SubstreamIdSchema),
  /** Trusted internal admission proof; never populated from HTTP input. */
  relationship: WorkspaceRelationshipSchema.optional(),
});
export type ConversationAuthorizationRequest = z.infer<typeof ConversationAuthorizationRequestSchema>;

export const AuthorizationEvidenceSchema = z.strictObject({
  owner: z.string(),
  revision: z.string(),
  validatedAt: z.number().int().nonnegative(),
});
export type AuthorizationEvidence = z.infer<typeof AuthorizationEvidenceSchema>;

export const AuthorizationDenialReasonSchema = z.enum([
  'workspace_mismatch', 'workspace_membership_required', 'outside_delegation', 'not_participant', 'private_child_membership_required',
  'resource_not_shared', 'connection_not_accessible', 'memory_scope_not_accessible',
]);
export const AuthorizationDecisionSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('allowed'), evidence: z.array(AuthorizationEvidenceSchema).nonempty() }),
  z.strictObject({ status: z.literal('denied'), reason: AuthorizationDenialReasonSchema,
    evidence: z.array(AuthorizationEvidenceSchema) }),
  z.strictObject({ status: z.literal('not_found'), resource: AuthorizationResourceSchema,
    evidence: z.array(AuthorizationEvidenceSchema).nonempty() }),
  z.strictObject({ status: z.literal('unavailable'),
    reason: z.enum(['authority_unavailable', 'projection_incomplete', 'evidence_invalid']), retryable: z.literal(true) }),
]);
export type AuthorizationDecision = z.infer<typeof AuthorizationDecisionSchema>;

/**
 * Who reads a Sidekick's conversations: the people it is shared with. Its
 * author, the person it runs as and anyone on its `people` list read it
 * whatever their access class; a member also reads it through Organization
 * scope. The
 * one copy of this rule; canonical reads, the library and search all apply it.
 */
export function sidekickAdmits(
  sidekick: { scope: string; author: boolean; executor: boolean; shared: boolean },
  member: boolean,
): boolean {
  if (sidekick.shared || sidekick.author || sidekick.executor) return true;
  return member && sidekick.scope === 'workspace';
}

/** Who reads a connection's resources: its owner, or anyone for a workspace connection, while it is enabled. */
export function connectionAdmits(connection: { status: string; scope: string; ownerUserId: string | null }, userId: string): boolean {
  return connection.status !== 'disabled' && (connection.scope === 'workspace' || connection.ownerUserId === userId);
}

/** A small explicit policy algebra, not a user-programmable graph language. */
export type ReadPolicy =
  | { kind: 'fact'; granted: boolean; reason: z.infer<typeof AuthorizationDenialReasonSchema>; evidence: AuthorizationEvidence }
  | { kind: 'all'; policies: readonly ReadPolicy[] }
  | { kind: 'any'; policies: readonly ReadPolicy[]; reason: z.infer<typeof AuthorizationDenialReasonSchema> };

/** Observation age is diagnostic, not a permission timeout. Future evidence is invalid. */
export function decisionHasValidEvidence(decision: AuthorizationDecision, now: number): boolean {
  return decision.status !== 'unavailable' && decision.evidence.length > 0
    && decision.evidence.every((item) => item.validatedAt <= now);
}

/** Every serving strategy evaluates these same predicates. Alternative grants retain their own proof. */
export function evaluateReadPolicy(policy: ReadPolicy, now: number): AuthorizationDecision {
  if (policy.kind === 'fact') {
    const decision: AuthorizationDecision = policy.granted
      ? { status: 'allowed', evidence: [policy.evidence] }
      : { status: 'denied', reason: policy.reason, evidence: [policy.evidence] };
    return decisionHasValidEvidence(decision, now) ? decision
      : { status: 'unavailable', reason: 'evidence_invalid', retryable: true };
  }
  const decisions = policy.policies.map((item) => evaluateReadPolicy(item, now));
  if (policy.kind === 'any') {
    const granted = decisions.find((decision) => decision.status === 'allowed');
    if (granted) return granted;
    const unavailable = decisions.find((decision) => decision.status === 'unavailable');
    if (unavailable) return unavailable;
    return { status: 'denied', reason: policy.reason,
      evidence: decisions.flatMap((decision) => decision.status === 'denied' ? decision.evidence : []) };
  }
  const denied = decisions.find((decision) => decision.status === 'denied');
  if (denied) return denied;
  const unavailable = decisions.find((decision) => decision.status === 'unavailable');
  if (unavailable) return unavailable;
  const evidence = decisions.flatMap((decision) => decision.status === 'allowed' ? decision.evidence : []);
  // An empty conjunction must never become a grant without authority evidence.
  return evidence.length ? { status: 'allowed', evidence }
    : { status: 'unavailable', reason: 'projection_incomplete', retryable: true };
}

export function authorizationResourceKey(resource: AuthorizationResource): string {
  switch (resource.kind) {
    case 'conversation': return JSON.stringify([resource.workspaceId, resource.kind, resource.parentId, resource.substreamId]);
    case 'resource': return JSON.stringify([resource.workspaceId, resource.kind, resource.resourceId]);
    case 'memory': return JSON.stringify([resource.workspaceId, resource.kind, resource.scopeId, resource.parentId]);
    case 'connection': return JSON.stringify([resource.workspaceId, resource.kind, resource.connectionId]);
  }
}

export const AuthorizationSnapshotSchema = z.strictObject({
  policyVersion: z.literal(AUTHORIZATION_POLICY_VERSION),
  subject: AuthorizationSubjectSchema,
  resource: AuthorizationResourceSchema,
  decision: AuthorizationDecisionSchema,
});
export type AuthorizationSnapshot = z.infer<typeof AuthorizationSnapshotSchema>;

export interface AuthorizationResolver {
  checkMany(subject: AuthorizationSubject, resources: readonly AuthorizationResource[]): Promise<AuthorizationDecision[]>;
}

/** Trusted server context; the resolver establishes authority for each exact address. */
export class AccessContext {
  constructor(
    readonly subject: AuthorizationSubject,
    private readonly resolver: AuthorizationResolver,
  ) {}

  async check(resource: AuthorizationResource): Promise<AuthorizationDecision> {
    const [decision] = await this.checkMany([resource]);
    if (!decision) throw new Error('authorization_resolver_missing_decision');
    return decision;
  }

  async checkMany(resources: readonly AuthorizationResource[]): Promise<AuthorizationDecision[]> {
    const admitted: AuthorizationResource[] = [];
    const indices: number[] = [];
    const results: AuthorizationDecision[] = [];
    resources.forEach((resource, index) => {
      if (resource.workspaceId !== this.subject.workspaceId) {
        results[index] = { status: 'denied', reason: 'workspace_mismatch', evidence: [] };
      } else { admitted.push(resource); indices.push(index); }
    });
    if (admitted.length) {
      const decisions = await this.resolver.checkMany(this.subject, admitted);
      if (decisions.length !== admitted.length) throw new Error('authorization_resolver_cardinality_mismatch');
      const now = Date.now();
      decisions.forEach((decision, index) => {
        // Validate the evidence shape without turning its age into a read deadline.
        results[indices[index]!] = decision.status !== 'unavailable'
          && !(decision.status === 'denied' && decision.evidence.length === 0)
          && !decisionHasValidEvidence(decision, now)
          ? { status: 'unavailable', reason: 'evidence_invalid', retryable: true } : decision;
      });
    }
    return results;
  }

  /** Completeness is explicit: failures are never silently dropped into an empty list. */
  async readableScopes(resources: readonly AuthorizationResource[]) {
    const decisions = await this.checkMany(resources);
    return { complete: decisions.every((decision) => decision.status !== 'unavailable'),
      items: resources.flatMap((resource, index) => decisions[index]?.status === 'allowed' ? [resource] : []),
      decisions };
  }
}
