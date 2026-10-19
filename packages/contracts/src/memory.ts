import { z } from "zod";

/**
 * What a person reviews of agent memory: `GET /workspace/me/memory` answers
 * `MemoryReview`, and `DELETE /workspace/me/memory/:factId` answers
 * `MemoryForgetResponse` (404 `memory_fact_not_found`, 403
 * `memory_fact_not_removable`). Which facts reach this list, and who may remove
 * them, is decided by `WorkspaceDO`; `docs/agent-memory.md` owns that.
 */

export const MEMORY_REVIEW_SUBJECT_KINDS = ["person", "organization", "channel"] as const;

/** The conversation a fact was first learned in. A Breakout names its Thread too, so it can be opened there. */
export const MemoryReviewSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("thread"), workstreamId: z.string().min(1), title: z.string().nullable() }),
  z.strictObject({ kind: z.literal("breakout"), workstreamId: z.string().min(1), substreamId: z.string().min(1), title: z.string().nullable() }),
  z.strictObject({ kind: z.literal("channel"), spaceId: z.string().min(1), title: z.string().nullable() }),
  z.strictObject({ kind: z.literal("sidekick"), automationId: z.string().min(1), title: z.string().nullable() }),
]);

export const MemoryReviewFactSchema = z.strictObject({
  factId: z.string().min(1),
  subjectKind: z.enum(MEMORY_REVIEW_SUBJECT_KINDS),
  /** The Channel's title for a `channel` fact; null otherwise. */
  subjectTitle: z.string().nullable(),
  kind: z.enum(["standing", "situational"]),
  text: z.string(),
  /** RFC 3339 instants. */
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  recordedAt: z.string(),
  expired: z.boolean(),
  upcoming: z.boolean(),
  conflict: z.boolean(),
  derivedFrom: z.enum(["person", "agent", "external", "mixed"]),
  /** The first source conversation, for the "from" link. */
  source: MemoryReviewSourceSchema,
  /** Whether the caller may remove this fact: their own always; a Channel's or the Organization's only for an administrator. */
  removable: z.boolean(),
});

export const MemoryReviewSchema = z.strictObject({
  /** The caller's own facts, newest first, expired included, retracted excluded. */
  own: z.array(MemoryReviewFactSchema),
  /** Organization facts, then Channel facts of Channels the caller may open, newest first. */
  shared: z.array(MemoryReviewFactSchema),
});

export const MemoryForgetResponseSchema = z.strictObject({ factId: z.string().min(1), retractedAt: z.string() });

export type MemoryReviewSubjectKind = (typeof MEMORY_REVIEW_SUBJECT_KINDS)[number];
export type MemoryReviewSource = z.infer<typeof MemoryReviewSourceSchema>;
export type MemoryReviewFact = z.infer<typeof MemoryReviewFactSchema>;
export type MemoryReview = z.infer<typeof MemoryReviewSchema>;
export type MemoryForgetResponse = z.infer<typeof MemoryForgetResponseSchema>;
