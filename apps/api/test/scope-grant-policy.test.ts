import { describe, expect, it } from "vitest";
import { asSubstreamId, asUserId, asWorkspaceId } from "@rally/contracts";
import type { ScopeGrant, ScopeGrantTarget } from "@rally/contracts/scope-grants";
import { resolveScopedAccess, type ScopedAccessFacts } from "../src/services/scope-grant-policy";

const workspaceId = asWorkspaceId("00000000-0000-4000-8000-000000000001");
const userId = asUserId("00000000-0000-4000-8000-000000000002");
const parentId = "00000000-0000-4000-8000-000000000003";
const childId = asSubstreamId("00000000-0000-4000-8000-000000000004");
const siblingId = asSubstreamId("00000000-0000-4000-8000-000000000005");
const parent: ScopeGrantTarget = { kind: "workstream", workspaceId, parentId };
const child: ScopeGrantTarget = { kind: "conversation", workspaceId, parentId, substreamId: childId };
const main: ScopeGrantTarget = { ...child, substreamId: asSubstreamId("0") };

function grant(target: ScopeGrantTarget, id = "00000000-0000-4000-8000-000000000006"): ScopeGrant {
  return { id, userId, target, active: true, revision: 1, membershipIncarnation:"membership" };
}

function facts(overrides: Partial<ScopedAccessFacts> = {}): ScopedAccessFacts {
  return {
    relationship: { workspaceId, userId, incarnation:"membership", accessClass: "guest", status: "active" },
    userId, target: child, parentExists: true, parentArchived: false,
    parentVisibility: "workspace",
    conversation: { status: "ready", archived: false, audience: "restricted" },
    grants: [], channelReader: false, ...overrides,
  };
}

describe("scoped collaborator policy", () => {
  it("admits a child collaborator without Main access or parent management", () => {
    const grants = [grant(child)];
    expect(resolveScopedAccess(facts({ grants }))).toMatchObject({ allowed: true, writable: true });
    for (const target of [main, parent, { ...child, substreamId: siblingId }]) {
      expect(resolveScopedAccess(facts({ grants, target }))).toEqual({ allowed: false, reason: "grant_required" });
    }
  });

  it("keeps Main-only sharing separate from a workstream grant", () => {
    const grants = [grant(main)];
    expect(resolveScopedAccess(facts({ grants, target: main }))).toMatchObject({ allowed: true, writable: true });
    expect(resolveScopedAccess(facts({ grants, target: parent }))).toMatchObject({ allowed: false });
    expect(resolveScopedAccess(facts({ grants, conversation: { status: "ready", archived: false, audience: "inherits_workstream" } })))
      .toMatchObject({ allowed: false });
  });

  it("inherits a workstream grant into Main and inheriting children, never restricted children", () => {
    const grants = [grant(parent)];
    for (const target of [main, parent]) {
      expect(resolveScopedAccess(facts({ grants, target }))).toMatchObject({ allowed: true, writable: true });
    }
    expect(resolveScopedAccess(facts({ grants }))).toMatchObject({ allowed: false });
    expect(resolveScopedAccess(facts({ grants, conversation: { status: "ready", archived: false, audience: "inherits_workstream" } })))
      .toMatchObject({ allowed: true, writable: true });
  });

  it("retains independent access when an overlapping grant is revoked", () => {
    const direct = grant(child);
    const inherited = grant(parent, "00000000-0000-4000-8000-000000000007");
    const input = facts({ conversation: { status: "ready", archived: false, audience: "inherits_workstream" } });
    for (const [active, revoked] of [[direct, inherited], [inherited, direct]]) {
      expect(resolveScopedAccess({ ...input, grants: [active!, { ...revoked!, active: false, revision: 2 }] }))
        .toMatchObject({ allowed: true, grantIds: [active!.id] });
    }
    expect(resolveScopedAccess({ ...input, grants: [direct, inherited] }))
      .toMatchObject({ allowed: true, grantIds: [direct.id, inherited.id] });
  });

  it("uses promotion only to add member discovery, preserving direct grants and restricted children", () => {
    const guest = facts({ target: main });
    expect(resolveScopedAccess(guest)).toMatchObject({ allowed: false });
    const member = { workspaceId, userId, incarnation:"membership", accessClass: "member", status: "active" } as const;
    expect(resolveScopedAccess({ ...guest, relationship: member })).toMatchObject({ allowed: true, workspaceMemberAccess: true });
    expect(resolveScopedAccess(facts({ relationship: member }))).toMatchObject({ allowed: false });
    for (const accessClass of ["member", "guest"] as const) {
      expect(resolveScopedAccess(facts({ relationship: { ...member, accessClass }, grants: [grant(child)] })))
        .toMatchObject({ allowed: true, writable: true });
    }
  });

  it("admits a guest who takes part in a Channel holding an Organization-wide parent, as a member is", () => {
    const reader = facts({ target: main, channelReader: true });
    expect(resolveScopedAccess(reader)).toMatchObject({ allowed: true, workspaceMemberAccess: true, grantIds: [] });
    // A Channel lends an Organization-wide parent only, and a restricted child stays its own.
    expect(resolveScopedAccess({ ...reader, parentVisibility: "personal" })).toEqual({ allowed: false, reason: "grant_required" });
    expect(resolveScopedAccess(facts({ channelReader: true }))).toEqual({ allowed: false, reason: "grant_required" });
  });

  it("suspension and missing relationships override all scope grants", () => {
    for (const status of ["invited", "suspended"] as const) {
      expect(resolveScopedAccess(facts({ grants: [grant(child)], relationship: { workspaceId, userId, incarnation:"membership", accessClass: "guest", status } })))
        .toEqual({ allowed: false, reason: "relationship_required" });
    }
    expect(resolveScopedAccess(facts({ relationship: null, grants: [grant(child)] }))).toMatchObject({ allowed: false });
  });

  it("rejects grants from another identity, parent or workspace", () => {
    const otherId = "00000000-0000-4000-8000-000000000009";
    const grants = [
      { ...grant(child), userId: asUserId(otherId) },
      grant({ ...child, parentId: otherId }),
      grant({ ...child, workspaceId: asWorkspaceId(otherId) }),
    ];
    expect(resolveScopedAccess(facts({ grants }))).toEqual({ allowed: false, reason: "grant_required" });
  });

  it("preserves readable archives but refuses writes and unfinished or absent conversations", () => {
    const input = facts({ grants: [grant(child)] });
    expect(resolveScopedAccess({ ...input, parentArchived: true })).toMatchObject({ allowed: true, writable: false });
    expect(resolveScopedAccess({ ...input, conversation: { status: "ready", archived: true, audience: "restricted" } }))
      .toMatchObject({ allowed: true, writable: false });
    for (const status of ["reserved", "failed"] as const) {
      expect(resolveScopedAccess({ ...input, conversation: { status, archived: false, audience: "restricted" } }))
        .toEqual({ allowed: false, reason: "not_ready" });
    }
    expect(resolveScopedAccess({ ...input, parentExists: false })).toEqual({ allowed: false, reason: "not_found" });
    expect(resolveScopedAccess({ ...input, conversation: null })).toEqual({ allowed: false, reason: "not_found" });
  });
});
