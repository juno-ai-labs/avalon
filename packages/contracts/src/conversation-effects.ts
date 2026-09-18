import { ScopeGrantSchema } from "./scope-grants";
import { RegionSchema } from "@rally/contracts/regions";
import { z } from "zod";
import { WorkstreamAppearanceSchema } from "./workstream-appearance";
import { ConversationParentKindSchema } from "./conversation-parent";
import { IdSchema, SubstreamIdSchema, WorkspaceIdSchema } from "./identifiers";
import { ResourceRelationshipTypeSchema } from "./resource-relationships";
import { HttpUrlSchema } from "./url-schemas";

/**
 * What a conversation tells its parent, and what a parent tells the workspace.
 *
 * Every hop is a Cloudflare Queue message carrying its envelope inline. The
 * sender keeps the envelope in its own SQLite outbox until `sendBatch` accepts
 * it; from there retry belongs to the Queue, and the receiver's receipt makes a
 * redelivery a no-op. Nothing loads an envelope back from the sender and
 * nothing acknowledges one to it.
 */


const TimestampSchema = z.string().datetime({ offset: true });
const NullableTimestampSchema = TimestampSchema.nullable();
const ShortTextSchema = z.string().max(500);
export const WORKSTREAM_DIRECTORY_RESOURCE_LINK_LIMIT = 10_000;

/** A child's, or a parent's aggregated, common state. */
export const WorkstreamDirectoryCommonEffectSchema = z.strictObject({
  kind: z.literal("directory_common"),
  /** Internal classification for a parent's aggregate running-agent count. */
  backgroundAgent: z.boolean().optional(),
  appearance: WorkstreamAppearanceSchema.optional(),
  title: ShortTextSchema,
  description: z.string().max(4_000),
  preview: z.string().max(1_000),
  scope: z.enum(["personal", "workspace"]),
  state: z.string().min(1).max(80),
  // As narrow as the receiving column CHECKs: a value the parent's schema
  // would reject must fail envelope validation at the producer, not commit
  // into an outbox whose delivery can then never succeed.
  systemKind: z.enum(["digest"]).nullable(),
  lastActivityAt: TimestampSchema,
  completedAt: NullableTimestampSchema,
  archivedAt: NullableTimestampSchema,
  emailAddress: z.string().email().max(254).nullable().optional(),
  createdByUserId: IdSchema.nullable().optional(),
  titleStatus: z.enum(["naming", "automatic", "settled"]).optional(),
  latestAttentionOrdinal: z.number().int().nonnegative().optional(),
  unreadTrackingStartOrdinal: z.number().int().nonnegative().optional(),
  nextWakeupDueAt: NullableTimestampSchema.optional(),
  nextWakeupPrompt: z.string().max(500).nullable().optional(),
  nextTerminalActionAt: NullableTimestampSchema.optional(),
  resourceLinks: z.array(z.strictObject({
    resourceId: IdSchema,
    watchEnabled: z.boolean(),
    relationshipType: ResourceRelationshipTypeSchema,
  })).max(WORKSTREAM_DIRECTORY_RESOURCE_LINK_LIMIT).optional(),
  attachmentReservationReleases: z.array(z.strictObject({
    inputId: IdSchema,
    resourceId: IdSchema,
  })).max(WORKSTREAM_DIRECTORY_RESOURCE_LINK_LIMIT).optional(),
  createdAt: TimestampSchema.optional(),
  updatedAt: TimestampSchema.optional(),
});

export const WorkstreamDirectoryUserEffectSchema = z.strictObject({
  kind: z.literal("directory_user"),
  userId: IdSchema,
  isParticipant: z.boolean(),
  /** When this person joined, copied from `participants.added_at`. */
  participantAddedAt: TimestampSchema.nullable().optional(),
  unreadCount: z.number().int().nonnegative(),
  youAreMentioned: z.boolean(),
  /** Added to the work stream and never opened it. Absent reads as false. */
  unseen: z.boolean().optional(),
  listable: z.boolean(),
  seenAttentionOrdinal: z.number().int().nonnegative().optional(),
  manualUnreadFromOrdinal: z.number().int().nonnegative().nullable().optional(),
  manualUnreadGeneration: z.number().int().nonnegative().optional(),
  latestMentionAttentionOrdinal: z.number().int().nonnegative().optional(),
});

/**
 * An automation's own sidebar row, published by `AutomationDO` through the
 * same outbox its children's aggregates travel through.
 */
export const AutomationDirectoryEffectSchema = z.strictObject({
  kind: z.literal("directory_automation"),
  loadable: z.boolean().optional(),
  /**
   * The chosen icon and colour, absent until somebody picks one — and absent
   * from every effect an object queued before this field existed, which is why
   * it is optional rather than nullable. A row with no appearance renders the
   * mark derived from the automation's id, exactly as it did before.
   */
  appearance: WorkstreamAppearanceSchema.optional(),
  automationId: IdSchema,
  authorUserId: IdSchema,
  lifecycle: z.enum(["draft", "active", "paused", "deleted"]),
  scope: z.enum(["personal", "workspace", "workstream"]),
  owningWorkstreamId: IdSchema.nullable(),
  title: z.string().max(500),
  description: z.string().max(4_000),
  nextRunAt: NullableTimestampSchema,
}).superRefine((effect, context) => {
  if ((effect.scope === "workstream") !== (effect.owningWorkstreamId !== null)) {
    context.addIssue({
      code: "custom",
      path: ["owningWorkstreamId"],
      message: "a room-scoped automation names its room, and no other scope may",
    });
  }
});

export const WorkstreamActivityEffectSchema = z.strictObject({
  kind: z.literal("activity_event"),
  eventId: IdSchema,
  eventType: z.string().min(1).max(160),
  subjectSequenceNumber: z.number().int().nonnegative().nullable(),
  actorType: z.enum(["user", "agent", "system", "external"]),
  actorUserId: IdSchema.nullable(),
  actorLabel: z.string().max(300),
  title: ShortTextSchema,
  body: z.string().max(8_000),
  canonicalUrl: HttpUrlSchema.nullable(),
  digestible: z.boolean(),
  occurredAt: TimestampSchema,
  sourceKind: z.string().min(1).max(120),
  sourceId: z.string().min(1).max(300).nullable(),
  dedupeKey: z.string().min(1).max(300),
  metadata: z.record(z.string(), z.unknown()),
  targets: z.array(z.strictObject({
    userId: IdSchema,
    relation: z.string().min(1).max(80),
  })).max(100),
});

export const WorkstreamMentionNotificationEffectSchema = z.strictObject({
  kind: z.literal("mention_notification"),
  substreamId: SubstreamIdSchema.optional(),
  intentId: z.string().min(1).max(300),
  messageId: IdSchema,
  recipientUserId: IdSchema,
  authorUserId: IdSchema,
  authorNameSnapshot: z.string().max(300),
  workstreamTitleSnapshot: ShortTextSchema,
  messageText: z.string().max(8_000),
  occurredAt: TimestampSchema,
});

/**
 * Somebody was added to a work stream and should be told. A sibling of the
 * mention effect rather than a field on it: the two carry different facts, and
 * the payload hash is computed over the effect object.
 */
export const WorkstreamParticipantNotificationEffectSchema = z.strictObject({
  kind: z.literal("participant_notification"),
  substreamId: SubstreamIdSchema.optional(),
  intentId: z.string().min(1).max(300),
  sourceId: z.string().min(1).max(300),
  recipientUserId: IdSchema,
  actorUserId: IdSchema,
  actorNameSnapshot: z.string().max(300),
  workstreamTitleSnapshot: ShortTextSchema,
  workstreamObjectiveSnapshot: ShortTextSchema,
  /** Whether the title above is a placeholder the naming agent has not replaced. */
  titleIsProvisional: z.boolean().default(false),
  occurredAt: TimestampSchema,
});

/** Effects a conversation (child) may produce. */
export const ConversationEffectSchema = z.discriminatedUnion("kind", [
  WorkstreamDirectoryCommonEffectSchema,
  WorkstreamDirectoryUserEffectSchema,
  WorkstreamActivityEffectSchema,
  WorkstreamMentionNotificationEffectSchema,
  WorkstreamParticipantNotificationEffectSchema,
]);
export type ConversationEffect = z.infer<typeof ConversationEffectSchema>;

export const ScopeGrantDirectoryEffectSchema = z.strictObject({
  kind: z.literal("scope_grant_directory"),
  grant: ScopeGrantSchema,
});

/** Effects a parent may forward to the workspace: the child kinds plus its own row. */
export const ParentEffectSchema = z.discriminatedUnion("kind", [
  ScopeGrantDirectoryEffectSchema,
  WorkstreamDirectoryCommonEffectSchema,
  WorkstreamDirectoryUserEffectSchema,
  AutomationDirectoryEffectSchema,
  WorkstreamActivityEffectSchema,
  WorkstreamMentionNotificationEffectSchema,
  WorkstreamParticipantNotificationEffectSchema,
]);
export type ParentEffect = z.infer<typeof ParentEffectSchema>;

/**
 * The effects that tell one person something, and therefore may not be
 * delivered before that person's own directory projection has landed. Both are
 * gated on `requiredProjectionVersion`.
 */
export function isPersonNotificationEffect(
  effect: ParentEffect,
): effect is Extract<ParentEffect, {
  kind: "mention_notification" | "participant_notification";
}> {
  return effect.kind === "mention_notification" || effect.kind === "participant_notification";
}

export function isDirectoryEffect(
  effect: ParentEffect,
): effect is Extract<ParentEffect, { kind: "directory_common" | "directory_user" }> {
  return effect.kind === "directory_common" || effect.kind === "directory_user";
}

const HashSchema = z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u);

function requireViewerVersionForNotifications(
  envelope: { effect: ParentEffect; requiredProjectionVersion: number | null },
  context: z.RefinementCtx,
): void {
  const requiresViewer = isPersonNotificationEffect(envelope.effect);
  if (requiresViewer !== (envelope.requiredProjectionVersion !== null)) {
    context.addIssue({
      code: "custom",
      path: ["requiredProjectionVersion"],
      message: requiresViewer
        ? "person notifications require a viewer projection version"
        : "only person notifications may require a viewer projection version",
    });
  }
}

/** One child's versioned effect, addressed to its parent. */
export const ConversationEffectEnvelopeSchema = z.strictObject({
  kind: z.literal("conversation_effect"),
  contractVersion: z.literal(1),
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  parentKind: ConversationParentKindSchema,
  parentId: IdSchema,
  substreamId: SubstreamIdSchema,
  generation: z.number().int().positive(),
  messageId: z.string().min(1).max(500),
  partitionKey: z.string().min(1).max(300),
  sourceVersion: z.number().int().positive(),
  requiredProjectionVersion: z.number().int().positive().nullable(),
  payloadHash: HashSchema,
  effect: ConversationEffectSchema,
}).superRefine(requireViewerVersionForNotifications);
export type ConversationEffectEnvelope = z.infer<typeof ConversationEffectEnvelopeSchema>;

/** One parent's versioned effect, addressed to the workspace. */
export const ParentEffectEnvelopeSchema = z.strictObject({
  kind: z.literal("parent_effect"),
  contractVersion: z.literal(1),
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  parentKind: ConversationParentKindSchema,
  parentId: IdSchema,
  generation: z.number().int().positive(),
  messageId: z.string().min(1).max(500),
  partitionKey: z.string().min(1).max(300),
  sourceVersion: z.number().int().positive(),
  requiredProjectionVersion: z.number().int().positive().nullable(),
  payloadHash: HashSchema,
  effect: ParentEffectSchema,
}).superRefine(requireViewerVersionForNotifications);
export type ParentEffectEnvelope = z.infer<typeof ParentEffectEnvelopeSchema>;

/** Either envelope, as the activity Queue consumer sees it. */
export const EffectQueueMessageSchema = z.union([
  ConversationEffectEnvelopeSchema,
  ParentEffectEnvelopeSchema,
]);
export type EffectQueueMessage = z.infer<typeof EffectQueueMessageSchema>;

/**
 * The most bytes one effect message may carry: Cloudflare's per-message limit
 * is 128 KB, and the producer refuses an envelope over this rather than
 * enqueueing one the Queue will reject on every attempt.
 */
export const EFFECT_QUEUE_MESSAGE_MAX_BYTES = 120_000;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(",")}}`;
}

export function conversationEffectHash(
  effect: ParentEffect,
  requiredProjectionVersion: number | null = null,
): string {
  let hash = 0xcbf29ce484222325n;
  const payload = { effect, requiredProjectionVersion };
  for (const byte of new TextEncoder().encode(canonicalJson(payload))) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}
