import type { Region } from "@rally/contracts/regions";

import { publishFencedTargets } from "./fenced-target-publication";
import {
  SpaceBootstrapQueueMessageSchema,
  SpaceDefaultQueueMessageSchema,
  type SpaceBootstrapQueueMessage,
  type SpaceDefaultQueueMessage,
} from "./workspace-space-protocol";
import type {
  SpaceBootstrapClaim,
  WorkspaceSpaceDefaultPublication,
} from "./workspace-space-storage";

export interface SpaceDefaultPublicationStorage {
  claimDefaultPublications(
    now: number,
    retryAt: (attempt: number) => number,
  ): WorkspaceSpaceDefaultPublication[];
  acceptDefaultPublications(
    publications: readonly WorkspaceSpaceDefaultPublication[],
    now?: number,
  ): void;
  claimBootstrap(now: number, retryAt: (attempt: number) => number): SpaceBootstrapClaim | null;
}

export interface SpacePublicationQueue {
  sendBatch(messages: Array<{ body: SpaceDefaultQueueMessage }>): Promise<unknown>;
}

export interface SpacePublicationInput {
  storage: SpaceDefaultPublicationStorage;
  queue: SpacePublicationQueue;
  workspaceId: string;
  region: Region;
  now: number;
  retryAt: (attempt: number) => number;
}

/** One batch of Space-default targets, claimed and published. */
export async function publishSpaceDefaultTargets(input: SpacePublicationInput): Promise<number> {
  return publishFencedTargets({
    claim: (now, retryAt) => input.storage.claimDefaultPublications(now, retryAt),
    accept: (publications, now) => input.storage.acceptDefaultPublications(publications, now),
    message: (publication) => SpaceDefaultQueueMessageSchema.parse({
      type: "space_default",
      region: input.region,
      workspaceId: input.workspaceId,
      requestedByUserId: publication.requestedByUserId,
      spaceId: publication.spaceId,
      kind: publication.kind,
      targetId: publication.targetId,
      defaultGeneration: publication.defaultGeneration,
      workstreamId: publication.workstreamId,
      membershipGeneration: publication.membershipGeneration,
    }),
    queue: input.queue,
    now: input.now,
    retryAt: input.retryAt,
  });
}

/**
 * Publish the next piece of the one-time Space cutover.
 *
 * The same claim/send shape as a default target, and deliberately so: the
 * cutover has to make progress on an Organization nobody is signed in to, and
 * the alarm is the only thing that wakes without a request. One claim per
 * alarm, because the phases are ordered and a page's cursor is only known once
 * the page before it has been reported.
 *
 * **The arithmetic for the fleet-wide pass, on the shared queue.** The
 * migration tracker's forced pass wakes every WorkspaceDO in a region at once,
 * and this is the only thing each of them sends. `claimBootstrap` takes one
 * page at a time and will not take another until the consumer has reported
 * that one, so in-flight cutover messages are bounded by the number of
 * *Organizations* rather than by Channels: one Organization is one message,
 * whatever its size. Against the published Queues limit of **5,000 messages
 * per second per queue** (`docs/choosing-queues-or-rpc.md`), a fleet at Rally's
 * size is three to four orders of magnitude under the ceiling, and being wrong
 * about the fleet by a hundredfold still leaves it under.
 *
 * That matters because this shares `ACTIVITY_QUEUE` with every other
 * projection and backfill. The burst it sees from a cutover is a
 * per-Organization trickle paced by round trips, not a per-Channel flood,
 * which is why no second queue is declared here, and what a future change has
 * to keep true if it ever claims more than one page per alarm. Work a person
 * is waiting on rides the interactive queue instead (docs/interactive-queue.md).
 */
export async function publishSpaceBootstrapWork(input: {
  storage: SpaceDefaultPublicationStorage;
  queue: { sendBatch(messages: Array<{ body: SpaceBootstrapQueueMessage }>): Promise<unknown> };
  workspaceId: string;
  region: Region;
  now: number;
  retryAt: (attempt: number) => number;
}): Promise<number> {
  return publishFencedTargets({
    claim: (now, retryAt) => {
      const claim = input.storage.claimBootstrap(now, retryAt);
      return claim === null ? [] : [claim];
    },
    // The claim already advanced the gate, and the work settles when the
    // consumer reports the page rather than when the Queue takes the message.
    accept: () => undefined,
    message: (claim) => SpaceBootstrapQueueMessageSchema.parse({
      type: "space_bootstrap",
      region: input.region,
      workspaceId: input.workspaceId,
      kind: claim.kind,
      cursor: claim.cursor,
    }),
    queue: input.queue,
    now: input.now,
    retryAt: input.retryAt,
  });
}
