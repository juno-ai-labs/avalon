import { IdSchema, UserIdSchema, WorkspaceIdSchema, WorkstreamIdSchema } from "@rally/contracts";
import { z } from "zod/v3";

const TimestampSchema = z.string().datetime({ offset: true });
const JsonStringSchema = z.string().refine((value) => {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}, "Expected valid JSON");

export const WorkspaceDraftAttachmentSchema = z.object({
  id: IdSchema,
  connectionId: IdSchema.nullable(),
  resourceType: z.string().min(1),
  provider: z.string().min(1),
  providerResourceId: z.string().nullable(),
  title: z.string(),
  mimeType: z.string().nullable(),
  contentRef: z.string().nullable(),
  contentSha256: z.string().nullable(),
  canonicalUrl: z.string().nullable(),
  metadataJson: JsonStringSchema,
  modelContentRef: z.string().nullable(),
  modelMimeType: z.string().nullable(),
  modelContentSha256: z.string().nullable(),
  modelMetadataJson: JsonStringSchema.nullable(),
  modelContentStatus: z.enum(["pending", "processing", "ready", "failed", "unsupported"]).nullable(),
  modelContentExtractorVersion: z.string().nullable(),
  modelContentErrorCode: z.string().nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();

export const WorkspaceReserveDraftAttachmentsRequestSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  inputId: IdSchema,
  userId: UserIdSchema,
  resourceIds: z.array(IdSchema),
}).strict();

export const WorkspaceReserveDraftAttachmentsResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.enum(["reserved", "replayed"]),
    resources: z.array(WorkspaceDraftAttachmentSchema),
  }).strict(),
  z.object({ outcome: z.literal("unavailable") }).strict(),
]);

export const WorkspaceReleaseDraftAttachmentsRequestSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  inputId: IdSchema,
}).strict();

export const WorkspaceReleaseDraftAttachmentsResultSchema = z.object({
  released: z.number().int().safe().nonnegative(),
}).strict();

export type WorkspaceReserveDraftAttachmentsRequest = z.infer<
  typeof WorkspaceReserveDraftAttachmentsRequestSchema
>;
export type WorkspaceReserveDraftAttachmentsResult = z.infer<
  typeof WorkspaceReserveDraftAttachmentsResultSchema
>;
export type WorkspaceReleaseDraftAttachmentsRequest = z.infer<
  typeof WorkspaceReleaseDraftAttachmentsRequestSchema
>;
export type WorkspaceReleaseDraftAttachmentsResult = z.infer<
  typeof WorkspaceReleaseDraftAttachmentsResultSchema
>;
