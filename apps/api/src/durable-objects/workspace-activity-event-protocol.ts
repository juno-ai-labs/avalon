import { IdSchema } from "@rally/contracts";
import { httpUrlSchema } from "@rally/contracts/url-schemas";
import { z } from "zod";

export const WorkspaceActivityAudienceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("workspace") }),
  z.strictObject({ kind: z.literal("user"), userId: IdSchema }),
  z.strictObject({ kind: z.literal("workstream"), workstreamId: IdSchema }),
]);

export const WorkspaceActivityEventInputSchema = z.strictObject({
  workspaceId: IdSchema,
  eventId: IdSchema.optional(),
  eventType: z.string().min(1).max(200),
  subjectType: z.string().min(1).max(200),
  subjectId: z.string().max(200).nullable(),
  subjectSequenceNumber: z.number().int().nonnegative().nullable().optional(),
  actorType: z.enum(["user", "agent", "system", "external"]),
  actorUserId: IdSchema.nullable().optional(),
  actorLabel: z.string().max(500),
  title: z.string().min(1).max(1_000),
  body: z.string().max(65_536).optional(),
  canonicalUrl: httpUrlSchema(2_000).nullable().optional(),
  audience: WorkspaceActivityAudienceSchema,
  digestible: z.boolean(),
  occurredAt: z.string().datetime(),
  sourceKind: z.string().min(1).max(120),
  sourceId: z.string().max(200).nullable().optional(),
  dedupeKey: z.string().min(1).max(1_000),
  metadata: z.record(z.string(), z.unknown()).optional(),
  targets: z.array(z.strictObject({
    userId: IdSchema,
    relation: z.string().min(1).max(120),
  })).max(1_000).optional(),
});

export const WorkspaceActivityEventSourceRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  sourceKind: z.string().min(1).max(120),
  sourceId: z.string().min(1).max(200),
});

export const WorkspaceActivityEventSourceSchema = z.strictObject({
  id: IdSchema,
  sourceId: z.string(),
  title: z.string(),
  body: z.string(),
  actorUserId: IdSchema.nullable(),
  actorLabel: z.string(),
  audienceWorkstreamId: IdSchema.nullable(),
  occurredAt: z.string().datetime(),
});

export type WorkspaceActivityEventInput = z.infer<typeof WorkspaceActivityEventInputSchema>;
export type WorkspaceActivityEventSourceRequest = z.infer<typeof WorkspaceActivityEventSourceRequestSchema>;
