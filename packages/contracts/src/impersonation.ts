import { z } from "zod";

import {
  IdSchema,
  SubstreamIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  WorkstreamIdSchema,
} from "./identifiers";
import { MESSAGE_MAX_CHARACTERS } from "./message-limits";
import { HttpUrlSchema } from "./url-schemas";

/** One directed workspace-scoped platform relationship. */
export const ImpersonationRelationshipSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  impersonatorUserId: UserIdSchema,
  representedUserId: UserIdSchema,
  authorityBasis: z.string().min(1).max(180),
  createdAt: z.string().datetime({ offset: true }),
  revokedAt: z.string().datetime({ offset: true }).nullable(),
});
export type ImpersonationRelationship = z.infer<typeof ImpersonationRelationshipSchema>;

export const UpsertImpersonationRelationshipsRequestSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  relationships: z.array(z.strictObject({
    impersonatorUserId: UserIdSchema,
    representedUserId: UserIdSchema,
    authorityBasis: z.string().min(1).max(180),
  })),
});
export type UpsertImpersonationRelationshipsRequest = z.infer<typeof UpsertImpersonationRelationshipsRequestSchema>;

export const RevokeImpersonationRelationshipsRequestSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  authorityBasis: z.string().min(1).max(180).optional(),
  impersonatorUserId: UserIdSchema.optional(),
  representedUserId: UserIdSchema.optional(),
}).refine(
  (value) => Boolean(value.authorityBasis || value.impersonatorUserId || value.representedUserId),
  { message: "At least one revocation filter is required" },
);
export type RevokeImpersonationRelationshipsRequest = z.infer<typeof RevokeImpersonationRelationshipsRequestSchema>;

export const SidelineDestinationSchema = z.strictObject({
  workstreamId: WorkstreamIdSchema,
  substreamId: SubstreamIdSchema,
  label: z.string().min(1).max(500),
  workstreamLabel: z.string().min(1).max(180),
});
export type SidelineDestination = z.infer<typeof SidelineDestinationSchema>;

export const SidelineParticipantSchema = z.strictObject({
  userId: UserIdSchema,
  name: z.string().min(1).max(500),
  avatarUrl: HttpUrlSchema.nullable(),
  destinations: z.array(SidelineDestinationSchema),
});
export type SidelineParticipant = z.infer<typeof SidelineParticipantSchema>;

export const SidelineCatalogSchema = z.strictObject({
  workspace: z.strictObject({ id: WorkspaceIdSchema, name: z.string().min(1).max(500) }),
  operator: z.strictObject({ userId: UserIdSchema, name: z.string().min(1).max(500) }),
  participants: z.array(SidelineParticipantSchema),
});
export type SidelineCatalog = z.infer<typeof SidelineCatalogSchema>;

export const SidelineSendRequestSchema = z.strictObject({
  representedUserId: UserIdSchema,
  workstreamId: WorkstreamIdSchema,
  substreamId: SubstreamIdSchema.optional().transform((value) => value ?? SubstreamIdSchema.parse("0")),
  message: z.string().min(1).max(MESSAGE_MAX_CHARACTERS),
  idempotencyKey: IdSchema,
  app: z.strictObject({
    name: z.literal("Sideline"),
    version: z.string().min(1).max(80),
    authMechanism: z.literal("rally_session"),
  }),
});
export type SidelineSendRequest = z.infer<typeof SidelineSendRequestSchema>;

export const SidelineSendResponseSchema = z.strictObject({
  messageId: IdSchema,
  createdAt: z.string().datetime({ offset: true }),
});
export type SidelineSendResponse = z.infer<typeof SidelineSendResponseSchema>;
