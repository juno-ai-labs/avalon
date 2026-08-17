import { IdSchema, RegionSchema } from "@avalon/contracts";
import { HttpUrlSchema } from "@avalon/contracts/url-schemas";
import { z } from "zod";

const TimestampSchema = z.string().datetime({ offset: true });
const NullableTimestampSchema = TimestampSchema.nullable();
const ShortTextSchema = z.string().max(500);

export const WorkstreamDirectoryCommonEffectSchema = z.object({
  kind: z.literal("directory_common"),
  title: ShortTextSchema,
  description: z.string().max(4_000),
  preview: z.string().max(1_000),
  scope: z.enum(["personal", "workspace"]),
  state: z.string().min(1).max(80),
  systemKind: z.string().min(1).max(80).nullable(),
  lastActivityAt: TimestampSchema,
  completedAt: NullableTimestampSchema,
  archivedAt: NullableTimestampSchema,
}).strict();

export const WorkstreamDirectoryUserEffectSchema = z.object({
  kind: z.literal("directory_user"),
  userId: IdSchema,
  isParticipant: z.boolean(),
  unreadCount: z.number().int().nonnegative(),
  youAreMentioned: z.boolean(),
  listable: z.boolean(),
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

export const WorkstreamRegionalEffectSchema = z.discriminatedUnion("kind", [
  WorkstreamDirectoryCommonEffectSchema,
  WorkstreamDirectoryUserEffectSchema,
  WorkstreamActivityEffectSchema,
  WorkstreamMentionNotificationEffectSchema,
]);

export type WorkstreamRegionalEffect = z.infer<typeof WorkstreamRegionalEffectSchema>;

export const WorkstreamRegionalEffectEnvelopeSchema = z.object({
  kind: z.literal("workstream_regional_effect"),
  contractVersion: z.literal(1),
  region: RegionSchema,
  workspaceId: IdSchema,
  workstreamId: IdSchema,
  generation: z.number().int().positive(),
  messageId: z.string().min(1).max(500),
  partitionKey: z.string().min(1).max(300),
  sourceVersion: z.number().int().positive(),
  requiredProjectionVersion: z.number().int().positive().nullable(),
  payloadHash: z.string().regex(/^fnv1a64:[0-9a-f]{16}$/u),
  effect: WorkstreamRegionalEffectSchema,
}).strict().superRefine((envelope, context) => {
  const requiresViewer = envelope.effect.kind === "mention_notification";
  if (requiresViewer !== (envelope.requiredProjectionVersion !== null)) {
    context.addIssue({
      code: "custom",
      path: ["requiredProjectionVersion"],
      message: requiresViewer
        ? "mention notifications require a viewer projection version"
        : "only mention notifications may require a viewer projection version",
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
  workspaceId: IdSchema,
  workstreamId: IdSchema,
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
  effect: WorkstreamRegionalEffect,
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
