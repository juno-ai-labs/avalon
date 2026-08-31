import { IdSchema, RegionSchema, ResourceRelationshipTypeSchema, WorkspaceIdSchema, WorkstreamIdSchema } from "@rally/contracts";
import { HttpUrlSchema } from "@rally/contracts/url-schemas";
import { z } from "zod";

const TimestampSchema = z.string().datetime({ offset: true });
const NullableTimestampSchema = TimestampSchema.nullable();
const ShortTextSchema = z.string().max(500);
export const WORKSTREAM_DIRECTORY_RESOURCE_LINK_LIMIT = 10_000;

export const WorkstreamDirectoryCommonEffectSchema = z.object({
  kind: z.literal("directory_common"),
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
  originType: z.enum(["ad_hoc", "automation"]).optional(),
  createdByUserId: IdSchema.nullable().optional(),
  automationSubscriptionId: IdSchema.nullable().optional(),
  automationRunId: IdSchema.nullable().optional(),
  plannedFor: NullableTimestampSchema.optional(),
  titleStatus: z.enum(["naming", "automatic", "settled"]).optional(),
  latestAttentionOrdinal: z.number().int().nonnegative().optional(),
  unreadTrackingStartOrdinal: z.number().int().nonnegative().optional(),
  nextWakeupDueAt: NullableTimestampSchema.optional(),
  nextWakeupPrompt: z.string().max(500).nullable().optional(),
  nextTerminalActionAt: NullableTimestampSchema.optional(),
  resourceLinks: z.array(z.object({
    resourceId: IdSchema,
    watchEnabled: z.boolean(),
    relationshipType: ResourceRelationshipTypeSchema,
  }).strict()).max(WORKSTREAM_DIRECTORY_RESOURCE_LINK_LIMIT).optional(),
  attachmentReservationReleases: z.array(z.object({
    inputId: IdSchema,
    resourceId: IdSchema,
  }).strict()).max(WORKSTREAM_DIRECTORY_RESOURCE_LINK_LIMIT).optional(),
  createdAt: TimestampSchema.optional(),
  updatedAt: TimestampSchema.optional(),
}).strict();

export const WorkstreamDirectoryUserEffectSchema = z.object({
  kind: z.literal("directory_user"),
  userId: IdSchema,
  isParticipant: z.boolean(),
  /**
   * When this person joined, copied from `participants.added_at`.
   *
   * Optional because effects written before this field existed are still in
   * flight and still parse; absent means the overlay should keep whatever
   * timestamp it already stored rather than treating the person as new.
   */
  participantAddedAt: TimestampSchema.nullable().optional(),
  unreadCount: z.number().int().nonnegative(),
  youAreMentioned: z.boolean(),
  /**
   * Added to the work stream and never opened it. Optional because effects
   * written before this field existed are still in flight and still parse;
   * absent reads as false, which is what every one of them meant.
   */
  unseen: z.boolean().optional(),
  listable: z.boolean(),
  seenAttentionOrdinal: z.number().int().nonnegative().optional(),
  manualUnreadFromOrdinal: z.number().int().nonnegative().nullable().optional(),
  manualUnreadGeneration: z.number().int().nonnegative().optional(),
  latestMentionAttentionOrdinal: z.number().int().nonnegative().optional(),
}).strict();

export const WorkstreamActivityEffectSchema = z.object({
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
  targets: z.array(z.object({
    userId: IdSchema,
    relation: z.string().min(1).max(80),
  }).strict()).max(100),
}).strict();

export const WorkstreamMentionNotificationEffectSchema = z.object({
  kind: z.literal("mention_notification"),
  intentId: z.string().min(1).max(300),
  messageId: IdSchema,
  recipientUserId: IdSchema,
  authorUserId: IdSchema,
  authorNameSnapshot: z.string().max(300),
  workstreamTitleSnapshot: ShortTextSchema,
  messageText: z.string().max(8_000),
  occurredAt: TimestampSchema,
}).strict();

/**
 * Somebody was added to a work stream and should be told.
 *
 * Deliberately a sibling of the mention effect rather than a field on it. The
 * two carry different facts — a mention has a message, this has an actor who
 * did the adding — and the envelope's payload hash is computed over the effect
 * object, so widening the mention schema would change the hash of every
 * mention effect already in an outbox.
 *
 * `sourceId` stands where a mention puts its message id: it is what the
 * intent's `(source_message_id, recipient_user_id, notification_kind)`
 * uniqueness is keyed on. It carries the participant epoch, so re-adding
 * somebody who was removed notifies them again while a redelivery of the same
 * add does not.
 */
export const WorkstreamParticipantNotificationEffectSchema = z.object({
  kind: z.literal("participant_notification"),
  intentId: z.string().min(1).max(300),
  sourceId: z.string().min(1).max(300),
  recipientUserId: IdSchema,
  actorUserId: IdSchema,
  actorNameSnapshot: z.string().max(300),
  workstreamTitleSnapshot: ShortTextSchema,
  workstreamObjectiveSnapshot: ShortTextSchema,
  /**
   * Whether the title above is a placeholder the naming agent has not replaced.
   *
   * A work stream created from the composer has no name yet: creation sets the
   * title to the opening message's first line cut at 180 characters, and the
   * naming pass runs after these effects are committed. Naming the work stream
   * by that string mid-sentence is what a notification must not do — every
   * other surface re-renders when the real name lands, and an inbox does not.
   *
   * Defaulted rather than required because the payload hash is computed over
   * this object: an effect enqueued by the previous deployment carries no such
   * field, and a required one would make it unparseable on arrival.
   */
  titleIsProvisional: z.boolean().default(false),
  occurredAt: TimestampSchema,
}).strict();

/**
 * Parse-only rolling-deployment tombstone. Previous SubstreamAgent and
 * WorkstreamDO isolates may still forward this envelope after the receiving
 * object has upgraded. Receivers acknowledge it without storing or applying
 * feedback; no current producer can create one.
 */
export const RetiredSuggestionFeedbackEffectSchema = z.object({
  kind: z.literal("suggestion_feedback"),
  actionId: IdSchema,
  activityId: IdSchema,
  source: z.enum(["contextual_routing", "suggested_work"]),
  status: z.enum(["accepted", "dismissed"]),
  resolvedAt: TimestampSchema,
  resolvedByUserId: IdSchema,
}).strict();

/** Effects current code may produce and persist. */
export const WorkstreamRegionalEffectSchema = z.discriminatedUnion("kind", [
  WorkstreamDirectoryCommonEffectSchema,
  WorkstreamDirectoryUserEffectSchema,
  WorkstreamActivityEffectSchema,
  WorkstreamMentionNotificationEffectSchema,
  WorkstreamParticipantNotificationEffectSchema,
]);
export type WorkstreamRegionalEffect = z.infer<typeof WorkstreamRegionalEffectSchema>;

/** Receiver-only union for envelopes committed by the previous deployment. */
export const WireWorkstreamRegionalEffectSchema = z.discriminatedUnion("kind", [
  WorkstreamDirectoryCommonEffectSchema,
  WorkstreamDirectoryUserEffectSchema,
  WorkstreamActivityEffectSchema,
  WorkstreamMentionNotificationEffectSchema,
  WorkstreamParticipantNotificationEffectSchema,
  RetiredSuggestionFeedbackEffectSchema,
]);
export type WireWorkstreamRegionalEffect = z.infer<typeof WireWorkstreamRegionalEffectSchema>;

export function isRetiredSuggestionFeedbackEffect(
  effect: WireWorkstreamRegionalEffect,
): effect is z.infer<typeof RetiredSuggestionFeedbackEffectSchema> {
  return effect.kind === "suggestion_feedback";
}

/**
 * The effects that tell one person something, and therefore may not be
 * delivered before that person's own directory projection has landed. Both are
 * gated on `requiredProjectionVersion`; see the refinement below.
 */
export function isPersonNotificationEffect(
  effect: WireWorkstreamRegionalEffect,
): effect is Extract<WorkstreamRegionalEffect, {
  kind: "mention_notification" | "participant_notification";
}> {
  return effect.kind === "mention_notification" || effect.kind === "participant_notification";
}

export const WorkstreamRegionalEffectEnvelopeSchema = z.object({
  kind: z.literal("workstream_regional_effect"),
  contractVersion: z.literal(1),
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  generation: z.number().int().positive(),
  messageId: z.string().min(1).max(500),
  partitionKey: z.string().min(1).max(300),
  sourceVersion: z.number().int().positive(),
  requiredProjectionVersion: z.number().int().positive().nullable(),
  payloadHash: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u),
  effect: WireWorkstreamRegionalEffectSchema,
}).strict().superRefine((envelope, context) => {
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
});

export type WorkstreamRegionalEffectEnvelope = z.infer<
  typeof WorkstreamRegionalEffectEnvelopeSchema
>;

/** Queue carries only an opaque wake-up; product/display data stays in the DO. */
export const WorkstreamRegionalEffectQueueMessageSchema = z.object({
  kind: z.literal("workstream_regional_effect_wakeup"),
  contractVersion: z.literal(1),
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  generation: z.number().int().positive(),
  messageId: z.string().min(1).max(500),
  payloadHash: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u),
}).strict();

export type WorkstreamRegionalEffectQueueMessage = z.infer<
  typeof WorkstreamRegionalEffectQueueMessageSchema
>;

export function workstreamRegionalEffectWakeMessage(
  envelope: WorkstreamRegionalEffectEnvelope,
): WorkstreamRegionalEffectQueueMessage {
  return WorkstreamRegionalEffectQueueMessageSchema.parse({
    kind: "workstream_regional_effect_wakeup",
    contractVersion: envelope.contractVersion,
    region: envelope.region,
    workspaceId: envelope.workspaceId,
    workstreamId: envelope.workstreamId,
    generation: envelope.generation,
    messageId: envelope.messageId,
    payloadHash: envelope.payloadHash,
  });
}

export const WorkstreamRegionalEffectAckSchema = z.object({
  messageId: z.string().min(1).max(500),
  payloadHash: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u),
}).strict();

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(",")}}`;
}

export function workstreamRegionalEffectHash(
  effect: WireWorkstreamRegionalEffect,
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
