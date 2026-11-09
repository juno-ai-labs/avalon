import type { ChildAudience, ScopeGrant, ScopeGrantTarget, WorkspaceAccessClass, ScopeAccessResult } from "@rally/contracts/scope-grants";
import type { UserId, WorkspaceId } from "@rally/contracts";
import { admitsOrganizationWide } from "./authorization-policy";

export interface ScopedWorkspaceRelationship {
  workspaceId: WorkspaceId;
  userId: UserId;
  accessClass: WorkspaceAccessClass;
  incarnation: string;
  status: "active" | "invited" | "suspended";
}

export interface ScopedAccessFacts {
  /** These facts must come from their owners, not request-body claims or directory projections. */
  relationship: ScopedWorkspaceRelationship | null;
  userId: UserId;
  target: ScopeGrantTarget;
  parentExists: boolean;
  parentArchived: boolean;
  parentVisibility: "workspace" | "personal";
  /** Null means the addressed conversation does not exist. Main must also be registered. */
  conversation: {
    status: "reserved" | "ready" | "failed";
    archived: boolean;
    audience: ChildAudience;
  } | null;
  grants: readonly ScopeGrant[];
  /**
   * Whether this person takes part in a Channel (a stored Space) the parent is
   * placed in, read from the Organization's own Space tables
   * (`channelReaderSql`). One path to an Organization-wide parent, beside
   * membership and grants.
   */
  channelReader: boolean;
}

export type ScopedAccess = ScopeAccessResult;

function matchesParent(grant: ScopeGrant, facts: ScopedAccessFacts): boolean {
  return grant.active && grant.membershipIncarnation === facts.relationship?.incarnation
    && grant.userId === facts.userId
    && grant.target.workspaceId === facts.target.workspaceId
    && grant.target.parentId === facts.target.parentId;
}

/**
 * Evaluate one exact scope. This is a policy over authoritative facts, not a
 * serving strategy: callers still load membership, grants and lifecycle from
 * their owners. A child never needs a second grant to read Main.
 */
export function resolveScopedAccess(facts: ScopedAccessFacts): ScopedAccess {
  const { relationship, target, conversation } = facts;
  if (!relationship || relationship.status !== "active"
    || relationship.userId !== facts.userId || relationship.workspaceId !== target.workspaceId) {
    return { allowed: false, reason: "relationship_required" };
  }
  if (!facts.parentExists || (target.kind === "conversation" && !conversation)) {
    return { allowed: false, reason: "not_found" };
  }
  if (target.kind === "conversation" && conversation?.status !== "ready") {
    return { allowed: false, reason: "not_ready" };
  }

  const inherits = target.kind === "conversation"
    && (target.substreamId === "0" || conversation?.audience === "inherits_workstream");
  const grants = facts.grants.filter((grant) => {
    if (!matchesParent(grant, facts)) return false;
    if (target.kind === "workstream") return grant.target.kind === "workstream";
    return grant.target.kind === "workstream" ? inherits
      : grant.target.substreamId === target.substreamId;
  });
  // Implicit member discovery grants conversation collaboration, not parent
  // management. Existing owner/participant rules still govern parent mutations.
  // A Channel reader collaborates the same way a member does.
  const workspaceMemberAccess = facts.parentVisibility === "workspace"
    && (admitsOrganizationWide(relationship.accessClass) || facts.channelReader) && inherits;
  if (!grants.length && !workspaceMemberAccess) return { allowed: false, reason: "grant_required" };
  return {
    allowed: true,
    writable: !facts.parentArchived && (target.kind === "workstream" || !conversation?.archived),
    grantIds: [...new Set(grants.map((grant) => grant.id))],
    workspaceMemberAccess,
  };
}
