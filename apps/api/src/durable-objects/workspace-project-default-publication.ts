import type { Region } from "@rally/contracts/regions";

import { publishFencedTargets } from "./fenced-target-publication";
import {
  ProjectDefaultResourceQueueMessageSchema,
  type ProjectDefaultResourceQueueMessage,
} from "./workspace-project-protocol";
import type { WorkspaceProjectDefaultPublication } from "./workspace-project-storage";

export interface ProjectDefaultPublicationStorage {
  claimDefaultPublications(
    now: number,
    retryAt: (attempt: number) => number,
  ): WorkspaceProjectDefaultPublication[];
  acceptDefaultPublications(
    publications: readonly WorkspaceProjectDefaultPublication[],
    now?: number,
  ): void;
}

export interface ProjectDefaultPublicationQueue {
  sendBatch(messages: Array<{ body: ProjectDefaultResourceQueueMessage }>): Promise<unknown>;
}

export interface ProjectDefaultPublicationInput {
  storage: ProjectDefaultPublicationStorage;
  queue: ProjectDefaultPublicationQueue;
  workspaceId: string;
  region: Region;
  now: number;
  retryAt: (attempt: number) => number;
}

/**
 * Publishes one bounded set of authoritative project-default targets.
 *
 * The claim/send/accept mechanism itself lives in
 * {@link publishFencedTargets}, which the Space default publisher uses too;
 * this is the Project's three arguments to it — which rows, which body, which
 * Queue.
 */
export async function publishProjectDefaultResourceTargets(
  input: ProjectDefaultPublicationInput,
): Promise<number> {
  return publishFencedTargets({
    claim: (now, retryAt) => input.storage.claimDefaultPublications(now, retryAt),
    accept: (publications, now) => input.storage.acceptDefaultPublications(publications, now),
    message: (publication) => ProjectDefaultResourceQueueMessageSchema.parse({
      type: "project_default_resource",
      region: input.region,
      workspaceId: input.workspaceId,
      requestedByUserId: publication.requestedByUserId,
      projectId: publication.projectId,
      resourceId: publication.resourceId,
      defaultGeneration: publication.defaultGeneration,
      workstreamId: publication.workstreamId,
      membershipGeneration: publication.membershipGeneration,
    }),
    queue: input.queue,
    now: input.now,
    retryAt: input.retryAt,
  });
}
