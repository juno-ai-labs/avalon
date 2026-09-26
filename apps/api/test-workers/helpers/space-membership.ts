import { runInDurableObject } from "cloudflare:test";

import type { SpaceId, SpaceSummary, UserId, WorkspaceId, WorkstreamId } from "@rally/contracts";

import type { WorkspaceDO } from "../../src/durable-objects/workspace-do";
import type { WorkspaceSpaceStorage } from "../../src/durable-objects/workspace-space-storage";

/** What these fixtures reach inside WorkspaceDO: its Space storage and the publications a membership change makes. */
interface SpaceInternals {
  spaceStorage(): WorkspaceSpaceStorage;
  publishSpaceSnapshot(): void;
  publishSpaceConversationsChanged(moved: { spaceIdsThroughChannel: Map<string, string[]> }): void;
  deferSpaceMembershipConvergence(workspaceId: string, workstreamId: string, includeDirectory: boolean): void;
}

interface MembershipAddress {
  workspaceId: WorkspaceId;
  userId: UserId;
  spaceId: SpaceId;
  workstreamId: WorkstreamId;
}

/**
 * Put a Channel in a Space's membership without asking the Channel's
 * conversation for the audience it implies.
 *
 * For suites whose subject is what the Organization does with a membership
 * (the directories, the dashboards, the reach it gives, the defaults it
 * stages) rather than how a Channel's audience changes; those suites address
 * Channels that have no conversation behind them. `space-routes.test.ts` proves
 * the product path, `addSpaceChannel`, end to end. This writes the rows that
 * path's settlement writes, through the same storage calls, and makes the same
 * publications.
 */
export async function placeMembership(
  stub: DurableObjectStub<WorkspaceDO>,
  address: MembershipAddress,
): Promise<{ space: SpaceSummary; membershipGeneration: number }> {
  return runInDurableObject(stub, (instance) => {
    const internals = instance as unknown as SpaceInternals;
    const storage = internals.spaceStorage();
    const plan = storage.prepareMembership(address);
    if (!plan.ok) throw new Error(`prepareMembership refused: ${plan.code}`);
    const space = storage.finalizeMembership({
      ...address, spaceRevision: plan.space.revision, membershipGeneration: plan.membershipGeneration,
    });
    if (space === "conflict" || space === false) throw new Error(`finalizeMembership refused: ${String(space)}`);
    storage.stageDefaultsForMember(address.spaceId, address.workstreamId, plan.membershipGeneration, address.userId);
    internals.publishSpaceSnapshot();
    internals.publishSpaceConversationsChanged({
      spaceIdsThroughChannel: new Map([[address.workstreamId, [address.spaceId]]]),
    });
    internals.deferSpaceMembershipConvergence(address.workspaceId, address.workstreamId, false);
    return { space, membershipGeneration: plan.membershipGeneration };
  });
}

/** Take a Channel out of a Space's membership the same way; refusals are thrown by code. */
export async function removeMembership(
  stub: DurableObjectStub<WorkspaceDO>,
  address: MembershipAddress,
): Promise<SpaceSummary> {
  return runInDurableObject(stub, (instance) => {
    const internals = instance as unknown as SpaceInternals;
    const storage = internals.spaceStorage();
    const plan = storage.prepareMembershipRemoval(address);
    if (!plan.ok) throw new Error(plan.code);
    const space = storage.finalizeMembershipRemoval({
      ...address, spaceRevision: plan.space.revision, membershipGeneration: plan.membershipGeneration,
    });
    if (space === false) throw new Error("space_not_found");
    internals.publishSpaceSnapshot();
    internals.publishSpaceConversationsChanged({
      spaceIdsThroughChannel: new Map([[address.workstreamId, [address.spaceId]]]),
    });
    internals.deferSpaceMembershipConvergence(address.workspaceId, address.workstreamId, true);
    return space;
  });
}

/** Run a callback against WorkspaceDO's Space storage, for staging a row a test is about. */
export async function withSpaceStorage<T>(
  stub: DurableObjectStub<WorkspaceDO>,
  fn: (storage: WorkspaceSpaceStorage) => T,
): Promise<T> {
  return runInDurableObject(stub, (instance) => fn((instance as unknown as SpaceInternals).spaceStorage()));
}
