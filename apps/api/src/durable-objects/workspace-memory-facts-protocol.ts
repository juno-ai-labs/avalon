import { IdSchema } from "@rally/contracts";
import { deferredZodSchema } from "@rally/contracts/deferred-zod-schema";
import { z } from "zod";

/**
 * Agent memory as questions to `WorkspaceDO`, rather than SQL.
 *
 * A fact is one sentence Rally learned from a conversation, filed under a
 * subject (the Organization, a Channel, a Thread, a Breakout, a person, a
 * Sidekick) and carrying the conversations it was learned from. Who may read
 * it is decided inside the object at call time from those sources and the
 * subject, never from a scope the caller names; see
 * `docs/agent-memory.md#visibility`.
 *
 * Instants are Unix milliseconds, the object's convention. The kept
 * `memory_scopes` and `memory_tables*` rows carry ISO strings from the D1
 * cutover; the two domains do not join.
 */

export const MEMORY_SUBJECT_KINDS = ["organization", "channel", "thread", "breakout", "person", "sidekick"] as const;
export const MemorySubjectKindSchema = z.enum(MEMORY_SUBJECT_KINDS);
export type MemorySubjectKind = z.infer<typeof MemorySubjectKindSchema>;

export const MemoryFactKindSchema = z.enum(["standing", "situational"]);
export type MemoryFactKind = z.infer<typeof MemoryFactKindSchema>;

/** The trust class of what a fact was derived from; `mixed` when an update joined two classes. */
export const MemoryDerivedFromSchema = z.enum(["person", "agent", "external", "mixed"]);
export type MemoryDerivedFrom = z.infer<typeof MemoryDerivedFromSchema>;

export const MemoryValidUntilBasisSchema = z.enum(["stated", "event", "assumed"]);

const InstantSchema = z.number().int().nonnegative();

/**
 * The conversation a call acts in: a Thread's Main (`substreamId` `"0"`), a
 * Breakout, a Sidekick's own conversation or run, or a Channel's own feed.
 * `memorySourceOf` renders it as the source string a fact stores.
 */
export const MemoryConversationSchema = z.strictObject({
  parentKind: z.enum(["workstream", "automation", "space"]),
  parentId: z.string().min(1),
  substreamId: z.string().min(1),
});
export type MemoryConversation = z.infer<typeof MemoryConversationSchema>;

export function memorySourceOf(conversation: MemoryConversation): string {
  switch (conversation.parentKind) {
    case "workstream":
      return conversation.substreamId === "0"
        ? conversation.parentId
        : `${conversation.parentId}/${conversation.substreamId}`;
    case "automation":
      return `sidekick:${conversation.parentId}`;
    case "space":
      return `space:${conversation.parentId}`;
  }
}

/**
 * Who is reading or writing. A person is resolved to their Organization
 * relationship inside the object; a Sidekick reads its own facts and its home
 * conversation's, and the Organization's only when its scope is `workspace`.
 */
export const MemoryReaderSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("person"), userId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("sidekick"), automationId: z.string().min(1) }),
  /** Nobody in particular: a workspace principal acting in a conversation reads what every participant may. */
  z.strictObject({ kind: z.literal("conversation") }),
]);
export type MemoryReader = z.infer<typeof MemoryReaderSchema>;

export const MemoryFactSchema = deferredZodSchema(() => z.strictObject({
  factId: z.string().min(1),
  subjectKind: MemorySubjectKindSchema,
  subjectId: z.string().min(1),
  kind: MemoryFactKindSchema,
  text: z.string(),
  validFrom: InstantSchema.nullable(),
  validUntil: InstantSchema.nullable(),
  validUntilBasis: MemoryValidUntilBasisSchema.nullable(),
  derivedFrom: MemoryDerivedFromSchema,
  conflict: z.boolean(),
  confidence: z.number().min(0).max(1).nullable(),
  /** Transcript sequence numbers in the first source conversation. */
  evidence: z.array(z.number().int().nonnegative()),
  sourceConversations: z.array(z.string().min(1)).min(1),
  supersedesFactId: z.string().min(1).nullable(),
  supersededByFactId: z.string().min(1).nullable(),
  retractedAt: InstantSchema.nullable(),
  confirmedAt: InstantSchema.nullable(),
  createdBy: z.string().min(1),
  createdAt: InstantSchema,
  updatedAt: InstantSchema,
}));
export type MemoryFact = z.infer<typeof MemoryFactSchema>;

// -- Recall -------------------------------------------------------------------

export const WorkspaceMemoryRecallRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  reader: MemoryReaderSchema,
  conversation: MemoryConversationSchema,
  /** Plain words; the object builds the FTS expression. Null lists the subjects' newest facts. */
  query: z.string().min(1).nullable(),
  now: InstantSchema,
  limit: z.number().int().positive(),
}));

export const WorkspaceMemoryRecallResultSchema = deferredZodSchema(() => z.strictObject({
  facts: z.array(MemoryFactSchema),
  /** Display titles for the facts' subjects (`<kind>:<id>`) and sources, so the model reads names, not ids. */
  titles: z.array(z.strictObject({ key: z.string().min(1), title: z.string() })),
}));

// -- Remember -----------------------------------------------------------------

export const WorkspaceMemoryRememberRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  reader: MemoryReaderSchema,
  conversation: MemoryConversationSchema,
  /** The harness's provider idempotency key; a replay answers from its receipt. */
  receiptId: z.string().min(1),
  harnessRunId: z.string().min(1),
  factId: z.string().min(1),
  text: z.string().min(1),
  kind: MemoryFactKindSchema,
  validUntil: InstantSchema.nullable(),
  about: z.enum(["me", "this conversation"]),
  derivedFrom: MemoryDerivedFromSchema,
  now: InstantSchema,
}));

export const WorkspaceMemoryRememberResultSchema = deferredZodSchema(() => z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("written"), fact: MemoryFactSchema }),
  /** The text matched an active fact on the same subject; that fact is answered. */
  z.strictObject({ outcome: z.literal("deduplicated"), fact: MemoryFactSchema }),
  z.strictObject({ outcome: z.literal("replayed"), fact: MemoryFactSchema, deduplicated: z.boolean() }),
  /** `about: "me"` from a Sidekick, which is nobody. */
  z.strictObject({ outcome: z.literal("personal_unavailable") }),
]));

// -- Forget -------------------------------------------------------------------

export const WorkspaceMemoryForgetRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  reader: MemoryReaderSchema,
  conversation: MemoryConversationSchema,
  receiptId: z.string().min(1),
  harnessRunId: z.string().min(1),
  factId: z.string().min(1),
  now: InstantSchema,
}));

export const WorkspaceMemoryForgetResultSchema = deferredZodSchema(() => z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("retracted"), fact: MemoryFactSchema }),
  z.strictObject({ outcome: z.literal("already_retracted"), fact: MemoryFactSchema }),
  z.strictObject({ outcome: z.literal("not_found") }),
  z.strictObject({ outcome: z.literal("not_visible") }),
  z.strictObject({ outcome: z.literal("not_forgettable"), subjectKind: MemorySubjectKindSchema }),
]));

// -- Sweep --------------------------------------------------------------------

/**
 * What the sweep model is told about where the conversation sits, so a fact
 * can rise no higher than its placement allows. Computed here, in the one
 * object that holds the directory, and handed to the prompt as data.
 */
export const MemorySweepPlacementSchema = deferredZodSchema(() => z.strictObject({
  conversation: MemoryConversationSchema,
  /** The conversation's own subject: the Thread, the Breakout, or the Sidekick. */
  subject: z.strictObject({ kind: MemorySubjectKindSchema, id: z.string().min(1), title: z.string() }),
  /** The Thread this Breakout sits in, when the conversation is a Breakout. */
  thread: z.strictObject({ id: z.string().min(1), title: z.string() }).nullable(),
  /** Every Channel the Thread is placed in today. */
  channels: z.array(z.strictObject({ id: z.string().min(1), title: z.string() })),
  /** Whether the conversation is open to every member, which is what an Organization fact needs. */
  organizationWide: z.boolean(),
  /** Current participants who may be the subject of a `person` fact. */
  people: z.array(z.strictObject({ id: z.string().min(1) })),
}));
export type MemorySweepPlacement = z.infer<typeof MemorySweepPlacementSchema>;

export const WorkspaceMemorySweepCandidatesRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  conversation: MemoryConversationSchema,
  /** Distinct words from the window; the object builds the FTS expression. */
  terms: z.array(z.string().min(1)),
  /** People who spoke in the window, so their standing facts are candidates too. */
  speakerIds: z.array(z.string().min(1)),
  now: InstantSchema,
  limit: z.number().int().positive(),
}));

export const WorkspaceMemorySweepCandidatesResultSchema = deferredZodSchema(() => z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("ready"),
    placement: MemorySweepPlacementSchema,
    candidates: z.array(MemoryFactSchema),
  }),
  /** The conversation is not in this object's directory: archived, deleted, or never projected. */
  z.strictObject({ outcome: z.literal("conversation_missing") }),
]));

const EvidenceSchema = z.array(z.number().int().nonnegative()).max(32);
const SweepTextSchema = z.string().trim().min(1).max(600);

/** One operation the sweep model may emit; the strict JSON schema the model is held to mirrors this. */
export const MemorySweepOperationSchema = deferredZodSchema(() => z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("add"),
    subjectKind: MemorySubjectKindSchema,
    /** Required for `channel` (a placement Channel id) and `person` (a placement person id); ignored otherwise. */
    subjectId: z.string().min(1).nullable(),
    kind: MemoryFactKindSchema,
    text: SweepTextSchema,
    validFrom: InstantSchema.nullable(),
    validUntil: InstantSchema.nullable(),
    validUntilBasis: MemoryValidUntilBasisSchema.nullable(),
    derivedFrom: z.enum(["person", "agent", "external"]),
    conflict: z.boolean(),
    confidence: z.number().min(0).max(1),
    evidence: EvidenceSchema,
  }),
  z.strictObject({
    op: z.literal("update"),
    factId: z.string().min(1),
    text: SweepTextSchema,
    validUntil: InstantSchema.nullable(),
    evidence: EvidenceSchema,
  }),
  z.strictObject({
    op: z.literal("retract"),
    factId: z.string().min(1),
    reason: z.string().trim().min(1).max(300),
    evidence: EvidenceSchema,
  }),
  z.strictObject({
    op: z.literal("confirm"),
    factId: z.string().min(1),
    evidence: EvidenceSchema,
  }),
]));
export type MemorySweepOperation = z.infer<typeof MemorySweepOperationSchema>;

export const WorkspaceMemoryApplySweepRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  conversation: MemoryConversationSchema,
  fromSeq: z.number().int().nonnegative(),
  toSeq: z.number().int().nonnegative(),
  operations: z.array(MemorySweepOperationSchema),
  model: z.string().min(1),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  /** One minted id per operation, by position; `add` and `update` consume theirs. */
  factIds: z.array(z.string().min(1)),
  now: InstantSchema,
}));

export const MemorySweepReceiptSchema = deferredZodSchema(() => z.strictObject({
  conversation: z.string().min(1),
  fromSeq: z.number().int().nonnegative(),
  toSeq: z.number().int().nonnegative(),
  appliedAt: InstantSchema,
  operationCount: z.number().int().nonnegative(),
}));
export type MemorySweepReceipt = z.infer<typeof MemorySweepReceiptSchema>;

/** Why one operation of a batch was skipped; the rest of the batch still applied. */
export const MEMORY_SWEEP_REFUSALS = [
  "subject_above_placement",
  "subject_id_not_in_placement",
  "fact_not_found",
  "fact_not_candidate",
  "fact_not_active",
  "horizon_required",
  "fact_id_missing",
] as const;
export const MemorySweepRefusalSchema = z.enum(MEMORY_SWEEP_REFUSALS);
export type MemorySweepRefusal = z.infer<typeof MemorySweepRefusalSchema>;

export const WorkspaceMemoryApplySweepResultSchema = deferredZodSchema(() => z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("applied"),
    receipt: MemorySweepReceiptSchema,
    refused: z.array(z.strictObject({ index: z.number().int().nonnegative(), code: MemorySweepRefusalSchema })),
  }),
  /** `fromSeq` is behind the stored `toSeq`: an earlier delivery applied this range. */
  z.strictObject({ outcome: z.literal("already_applied"), receipt: MemorySweepReceiptSchema }),
  /** `fromSeq` is ahead of the stored `toSeq`: a range was skipped; the lane re-reads from `toSeq`. */
  z.strictObject({ outcome: z.literal("cursor_ahead"), storedToSeq: z.number().int().nonnegative() }),
]));

export type WorkspaceMemoryRecallRequest = z.infer<typeof WorkspaceMemoryRecallRequestSchema>;
export type WorkspaceMemoryRecallResult = z.infer<typeof WorkspaceMemoryRecallResultSchema>;
export type WorkspaceMemoryRememberRequest = z.infer<typeof WorkspaceMemoryRememberRequestSchema>;
export type WorkspaceMemoryRememberResult = z.infer<typeof WorkspaceMemoryRememberResultSchema>;
export type WorkspaceMemoryForgetRequest = z.infer<typeof WorkspaceMemoryForgetRequestSchema>;
export type WorkspaceMemoryForgetResult = z.infer<typeof WorkspaceMemoryForgetResultSchema>;
export type WorkspaceMemorySweepCandidatesRequest = z.infer<typeof WorkspaceMemorySweepCandidatesRequestSchema>;
export type WorkspaceMemorySweepCandidatesResult = z.infer<typeof WorkspaceMemorySweepCandidatesResultSchema>;
export type WorkspaceMemoryApplySweepRequest = z.infer<typeof WorkspaceMemoryApplySweepRequestSchema>;
export type WorkspaceMemoryApplySweepResult = z.infer<typeof WorkspaceMemoryApplySweepResultSchema>;
