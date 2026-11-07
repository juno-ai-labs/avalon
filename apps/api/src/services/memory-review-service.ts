import {
  MemoryForgetResponseSchema,
  MemoryReviewSchema,
  type MemoryForgetResponse,
  type MemoryReview,
} from "@rally/contracts";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import type { MemoryFact, MemoryReviewScope } from "../durable-objects/workspace-memory-facts-protocol";
import { parseMemorySource } from "../durable-objects/workspace-memory-facts-storage";
import { hostedParentStub } from "./conversation-parent-client";

/**
 * The review surface's one read and one removal, for every scope: a person's
 * own facts, the Organization's, a Thread's or Breakout's, a Channel's.
 * `WorkspaceDO` decides which facts a scope lists and whether each is
 * removable; this names them for the client. A caller that admits the person
 * to a conversation first (the Thread and Breakout routes) does that before
 * calling here. See `docs/agent-memory.md#the-review-surface`.
 */
export async function readMemoryReview(env: Env, auth: AuthContext, scope: MemoryReviewScope): Promise<MemoryReview> {
  const review = await (await hostedParentStub(env, auth.workspaceId)).reviewMemoryFacts({
    workspaceId: auth.workspaceId,
    userId: auth.userId,
    scope,
  });
  if (review.outcome === "not_found") {
    // Only a conversation scope can be closed to the person.
    throw scope.kind === "conversation" && scope.conversation.parentKind === "space"
      ? new ApiError(404, "space_not_found", "That channel was not found")
      : new ApiError(404, "conversation_not_found", "Conversation not found");
  }
  const titles = new Map(review.titles.map((entry) => [entry.key, entry.title]));
  return MemoryReviewSchema.parse({
    facts: review.facts.map(({ fact, removable }) => memoryReviewFact(fact, titles, removable)),
  });
}

/** Remove one fact from a scope's review; a repeat answers as the first did. */
export async function forgetReviewedMemory(
  env: Env,
  auth: AuthContext,
  scope: MemoryReviewScope,
  factId: string,
): Promise<MemoryForgetResponse> {
  const result = await (await hostedParentStub(env, auth.workspaceId)).forgetReviewedMemoryFact({
    workspaceId: auth.workspaceId,
    userId: auth.userId,
    scope,
    factId,
    now: Date.now(),
  });
  switch (result.outcome) {
    case "not_found":
      throw new ApiError(404, "memory_fact_not_found", "That memory was not found");
    case "not_removable":
      throw new ApiError(403, "memory_fact_not_removable", "You may not remove this memory");
    case "retracted":
    case "already_retracted":
      return MemoryForgetResponseSchema.parse({
        factId: result.fact.factId,
        retractedAt: new Date(result.retractedAt).toISOString(),
      });
  }
}

/**
 * One reviewed fact as the client reads it: instants as RFC 3339, its
 * subject's title for a Channel, Thread or Breakout, and the first source
 * conversation as the "from" link, titled only when the store titled it.
 */
function memoryReviewFact(
  fact: MemoryFact,
  titles: ReadonlyMap<string, string>,
  removable: boolean,
): unknown {
  const first = fact.sourceConversations[0]!;
  const title = titles.get(first) ?? null;
  const parsed = parseMemorySource(first);
  // A Canvas's Chat is listed as the contract's `thread` source, which the
  // client opens as that Canvas: the review contract predates Canvases.
  const source = parsed.kind === "space"
    ? { kind: "channel", spaceId: parsed.spaceId, title }
    : parsed.kind === "canvas" ? { kind: "thread", workstreamId: parsed.canvasId, title } : { ...parsed, title };
  const titled = fact.subjectKind === "channel" || fact.subjectKind === "thread" || fact.subjectKind === "breakout";
  return {
    factId: fact.factId,
    subjectKind: fact.subjectKind,
    subjectTitle: titled ? titles.get(`${fact.subjectKind}:${fact.subjectId}`) ?? null : null,
    kind: fact.kind,
    text: fact.text,
    validFrom: fact.validFrom === null ? null : new Date(fact.validFrom).toISOString(),
    validUntil: fact.validUntil === null ? null : new Date(fact.validUntil).toISOString(),
    recordedAt: new Date(fact.createdAt).toISOString(),
    conflict: fact.conflict,
    derivedFrom: fact.derivedFrom,
    source,
    removable,
  };
}
