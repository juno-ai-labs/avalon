import { asProjectId, asWorkstreamId } from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";

import { publishProjectDefaultResourceTargets } from "../src/durable-objects/workspace-project-default-publication";
import type {
  ProjectDefaultPublicationQueue,
  ProjectDefaultPublicationStorage,
} from "../src/durable-objects/workspace-project-default-publication";
import type {
  WorkspaceProjectDefaultPublication,
} from "../src/durable-objects/workspace-project-storage";

const publication: WorkspaceProjectDefaultPublication = {
  projectId: asProjectId("019d3c99-63cc-7a88-8eb4-bf54b091be06"),
  resourceId: "00000000-0000-7000-8000-000000000003",
  defaultGeneration: 1,
  workstreamId: asWorkstreamId("00000000-0000-7000-8000-000000000004"),
  membershipGeneration: 1,
  requestedByUserId: "00000000-0000-7000-8000-000000000002",
  attempts: 1,
};

describe("durable project default publication", () => {
  it("given Queue rejects a claimed target, when a later alarm retries, then the target is delivered and accepted", async () => {
    let dueAt = 10;
    let accepted = false;
    let attempts = 0;
    const storage = {
      claimDefaultPublications: (now: number, retryAt: (attempt: number) => number) => {
        if (accepted || now < dueAt) return [];
        attempts += 1;
        dueAt = retryAt(attempts);
        return [{ ...publication, attempts }];
      },
      acceptDefaultPublications: () => {
        accepted = true;
      },
    } satisfies ProjectDefaultPublicationStorage;
    const sendBatch = vi.fn()
      .mockRejectedValueOnce(new Error("queue_unavailable"))
      .mockResolvedValueOnce(undefined);
    const input = {
      storage,
      queue: { sendBatch } satisfies ProjectDefaultPublicationQueue,
      workspaceId: "00000000-0000-7000-8000-000000000001",
      region: "global" as const,
      retryAt: (attempt: number) => 10 + attempt * 100,
    };

    await expect(publishProjectDefaultResourceTargets({ ...input, now: 10 }))
      .rejects.toThrow("queue_unavailable");
    expect(accepted).toBe(false);
    expect(await publishProjectDefaultResourceTargets({ ...input, now: 110 })).toBe(1);
    expect(sendBatch).toHaveBeenCalledTimes(2);
    expect(accepted).toBe(true);
  });
});
