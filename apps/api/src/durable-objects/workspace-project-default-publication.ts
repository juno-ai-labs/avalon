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
  region: "global" | "eu";
  now: number;
  retryAt: (attempt: number) => number;
}

/**
 * Publishes one bounded set of authoritative project-default targets.
 *
 * Claiming advances each row's durable retry gate before the external await.
 * A rejected or ambiguous Queue send therefore remains recoverable without
 * spinning the WorkspaceDO alarm, while a duplicate accepted send is harmless
 * because the consumer fences application on the target generations.
 */
export async function publishProjectDefaultResourceTargets(
  input: ProjectDefaultPublicationInput,
): Promise<number> {
  const publications = input.storage.claimDefaultPublications(input.now, input.retryAt);
  if (publications.length === 0) return 0;
  await input.queue.sendBatch(publications.map((publication) => ({
    body: ProjectDefaultResourceQueueMessageSchema.parse({
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
  })));
  input.storage.acceptDefaultPublications(publications, input.now);
  return publications.length;
}
