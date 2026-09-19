/**
 * Publishing a Space's staged work onto the activity Queue.
 *
 * The shape is the one every fenced fan-out in WorkspaceDO shares: claim rows
 * with their retry gate advanced *before* the external await, send one batch,
 * mark what the Queue took. What this file holds it to is the part that is only
 * visible when the send fails — the claim has already happened, the acceptance
 * has not, and the rows are therefore still pending for a later alarm rather
 * than lost or spun on.
 */
import { asSpaceId, asUserId, asWorkstreamId } from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  publishSpaceDefaultTargets,
  publishSpaceIntentResumes,
} from "../src/durable-objects/workspace-space-default-publication";
import type {
  WorkspaceSpaceDefaultPublication,
  WorkspaceSpaceIntentClaim,
} from "../src/durable-objects/workspace-space-storage";

const WORKSPACE_ID = "00000000-0000-7000-8000-0000000000e1";
const SPACE_ID = asSpaceId("00000000-0000-7000-8000-0000000000e2");
const CHANNEL_ID = asWorkstreamId("00000000-0000-7000-8000-0000000000e3");
const RESOURCE_ID = "00000000-0000-7000-8000-0000000000e4";
const SIDEKICK_ID = "00000000-0000-7000-8000-0000000000e5";
const OWNER = asUserId("00000000-0000-7000-8000-0000000000e6");
const OPERATION_ID = "00000000-0000-7000-8000-0000000000e7";

function publication(
  kind: "resource" | "sidekick",
  targetId: string,
): WorkspaceSpaceDefaultPublication {
  return {
    spaceId: SPACE_ID,
    kind,
    targetId,
    defaultGeneration: 2,
    workstreamId: CHANNEL_ID,
    membershipGeneration: 3,
    requestedByUserId: OWNER,
    attempts: 1,
  };
}

const INTENT: WorkspaceSpaceIntentClaim = {
  operationId: OPERATION_ID,
  kind: "audience",
  spaceId: SPACE_ID,
  workstreamId: null,
  spaceRevision: 5,
  membershipGeneration: null,
  requestedByUserId: OWNER,
};

function storageDouble(input: {
  publications?: WorkspaceSpaceDefaultPublication[];
  intents?: WorkspaceSpaceIntentClaim[];
}) {
  return {
    claimDefaultPublications: vi.fn(() => input.publications ?? []),
    acceptDefaultPublications: vi.fn(),
    claimIntentResumes: vi.fn(() => input.intents ?? []),
  };
}

describe("publishing Space default targets", () => {
  it("given a resource and a Sidekick default, when they are published, then one batch carries both kinds", async () => {
    const storage = storageDouble({
      publications: [publication("resource", RESOURCE_ID), publication("sidekick", SIDEKICK_ID)],
    });
    const sendBatch = vi.fn(async () => undefined);

    const published = await publishSpaceDefaultTargets({
      storage,
      queue: { sendBatch },
      workspaceId: WORKSPACE_ID,
      region: "global",
      now: 1_000,
      retryAt: (attempt) => 1_000 + attempt * 60_000,
    });

    expect(published).toBe(2);
    // One mechanism, two consumers: the kind rides on the message rather than
    // selecting a second publisher, a second table, or a second alarm phase.
    expect(sendBatch).toHaveBeenCalledWith([
      { body: expect.objectContaining({ type: "space_default", kind: "resource", targetId: RESOURCE_ID }) },
      { body: expect.objectContaining({ type: "space_default", kind: "sidekick", targetId: SIDEKICK_ID }) },
    ]);
    expect(storage.acceptDefaultPublications).toHaveBeenCalledOnce();
  });

  it("given nothing due, when the alarm publishes, then the Queue is not called", async () => {
    const storage = storageDouble({});
    const sendBatch = vi.fn(async () => undefined);

    await expect(publishSpaceDefaultTargets({
      storage,
      queue: { sendBatch },
      workspaceId: WORKSPACE_ID,
      region: "global",
      now: 1_000,
      retryAt: (attempt) => 1_000 + attempt * 60_000,
    })).resolves.toBe(0);
    expect(sendBatch).not.toHaveBeenCalled();
    expect(storage.acceptDefaultPublications).not.toHaveBeenCalled();
  });

  it("given a rejected send, when the batch fails, then the claim stands and nothing is accepted", async () => {
    const storage = storageDouble({ publications: [publication("resource", RESOURCE_ID)] });

    await expect(publishSpaceDefaultTargets({
      storage,
      queue: { sendBatch: async () => { throw new Error("queue_overloaded"); } },
      workspaceId: WORKSPACE_ID,
      region: "global",
      now: 1_000,
      retryAt: (attempt) => 1_000 + attempt * 60_000,
    })).rejects.toThrow(/queue_overloaded/u);

    // The claim advanced the durable retry gate before the await, so the rows
    // are still pending and a later alarm picks them up. Accepting them here
    // would have marked work the Queue never took.
    expect(storage.claimDefaultPublications).toHaveBeenCalledWith(1_000, expect.any(Function));
    expect(storage.acceptDefaultPublications).not.toHaveBeenCalled();
  });
});

describe("republishing unsettled Space intents", () => {
  it("given an unsettled intent, when the alarm runs, then it is put back on the Queue", async () => {
    const storage = storageDouble({ intents: [INTENT] });
    const sendBatch = vi.fn(async () => undefined);

    await expect(publishSpaceIntentResumes({
      storage,
      queue: { sendBatch },
      workspaceId: WORKSPACE_ID,
      region: "global",
      now: 2_000,
      retryAt: (attempt) => 2_000 + attempt * 60_000,
    })).resolves.toBe(1);

    // Everything the consumer needs to address the work travels on the message:
    // by the time it runs, the request that staged the intent is gone.
    expect(sendBatch).toHaveBeenCalledWith([{ body: {
      type: "space_intent_resume",
      region: "global",
      workspaceId: WORKSPACE_ID,
      operationId: OPERATION_ID,
      kind: "audience",
      spaceId: SPACE_ID,
      workstreamId: null,
      spaceRevision: 5,
      membershipGeneration: null,
      requestedByUserId: OWNER,
    } }]);
  });
});
