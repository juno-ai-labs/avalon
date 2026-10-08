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
 * Put a Channel in a Space's membership without the sidebar-visibility gate
 * `addSpaceChannel` takes.
 *
 * For suites whose subject is what the Organization does with a membership
 * (the directories, the dashboards, the reach it gives, the defaults it
 * stages); those suites address Channels that have no directory row behind
 * them. `space-routes.test.ts` and `space-authority.test.ts` prove the product
 * path, `addSpaceChannel`, end to end. This runs the same single-transaction
 * storage write that path runs and makes the same publications.
 */
export async function placeMembership(
  stub: DurableObjectStub<WorkspaceDO>,
  address: MembershipAddress,
): Promise<{ space: SpaceSummary }> {
  return runInDurableObject(stub, (instance) => {
    const internals = instance as unknown as SpaceInternals;
    const result = internals.spaceStorage().addMembership(address);
    if (!result.ok) throw new Error(`addMembership refused: ${result.code}`);
    internals.publishSpaceSnapshot();
    internals.publishSpaceConversationsChanged({
      spaceIdsThroughChannel: new Map([[address.workstreamId, [address.spaceId]]]),
    });
    internals.deferSpaceMembershipConvergence(address.workspaceId, address.workstreamId, false);
    return { space: result.space };
  });
}

/** Take a Channel out of a Space's membership the same way; refusals are thrown by code. */
export async function removeMembership(
  stub: DurableObjectStub<WorkspaceDO>,
  address: MembershipAddress,
): Promise<SpaceSummary> {
  return runInDurableObject(stub, (instance) => {
    const internals = instance as unknown as SpaceInternals;
    const result = internals.spaceStorage().removeMembership(address);
    if (!result.ok) throw new Error(result.code);
    internals.publishSpaceSnapshot();
    internals.publishSpaceConversationsChanged({
      spaceIdsThroughChannel: new Map([[address.workstreamId, [address.spaceId]]]),
    });
    internals.deferSpaceMembershipConvergence(address.workspaceId, address.workstreamId, true);
    return result.space;
  });
}

/** Run a callback against WorkspaceDO's Space storage, for staging a row a test is about. */
export async function withSpaceStorage<T>(
  stub: DurableObjectStub<WorkspaceDO>,
  fn: (storage: WorkspaceSpaceStorage) => T,
): Promise<T> {
  return runInDurableObject(stub, (instance) => fn((instance as unknown as SpaceInternals).spaceStorage()));
}
