import { z } from "zod";

/**
 * What a person reviews of agent memory. Each review route answers
 * `MemoryReview` and its `DELETE …/:factId` answers `MemoryForgetResponse`
 * (404 `memory_fact_not_found`, 403 `memory_fact_not_removable`):
 *
 * - `/workspace/me/memory` — the caller's own facts;
 * - `/workspace/memory` — the Organization's facts;
 * - `/spaces/:id/memory` — a Channel's own facts;
 * - `/workstreams/:id/memory?substreamId=` — a Thread's (`"0"`) or a Breakout's own facts.
 *
 * Which facts reach a list, and who may remove them, is decided by
 * `WorkspaceDO`; `docs/agent-memory.md` owns that.
 */

/** The conversation a fact was first learned in. A Breakout names its Thread too, so it can be opened there. */
export const MemoryReviewSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("thread"), workstreamId: z.string().min(1), title: z.string().nullable() }),
  z.strictObject({ kind: z.literal("breakout"), workstreamId: z.string().min(1), substreamId: z.string().min(1), title: z.string().nullable() }),
  z.strictObject({ kind: z.literal("channel"), spaceId: z.string().min(1), title: z.string().nullable() }),
  z.strictObject({ kind: z.literal("sidekick"), automationId: z.string().min(1), title: z.string().nullable() }),
]);

export const MemoryReviewFactSchema = z.strictObject({
  factId: z.string().min(1),
  subjectKind: z.enum(["person", "organization", "channel", "thread", "breakout"]),
  /** The Channel's, Thread's or Breakout's title for a `channel`, `thread` or `breakout` fact; null otherwise. */
  subjectTitle: z.string().nullable(),
  kind: z.enum(["standing", "situational"]),
  text: z.string(),
  /**
   * RFC 3339 instants. Whether a fact is expired or upcoming is the client's
   * to judge against its own clock, so it stays right while the list is open.
   */
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  recordedAt: z.string(),
  conflict: z.boolean(),
  derivedFrom: z.enum(["person", "agent", "external", "mixed"]),
  /** The first source conversation, for the "from" link; its title is null when the caller may no longer open it. */
  source: MemoryReviewSourceSchema,
  /**
   * Whether the caller may remove this fact: their own always; a Thread's or
   * Breakout's for a participant; a Channel's or the Organization's only for an
   * administrator.
   */
  removable: z.boolean(),
});

export const MemoryReviewSchema = z.strictObject({
  /** The scope's facts the caller may see, newest first, expired included, retracted excluded. */
  facts: z.array(MemoryReviewFactSchema),
});

export const MemoryForgetResponseSchema = z.strictObject({ factId: z.string().min(1), retractedAt: z.string() });

export type MemoryReviewSource = z.infer<typeof MemoryReviewSourceSchema>;
export type MemoryReviewFact = z.infer<typeof MemoryReviewFactSchema>;
export type MemoryReview = z.infer<typeof MemoryReviewSchema>;
export type MemoryForgetResponse = z.infer<typeof MemoryForgetResponseSchema>;
