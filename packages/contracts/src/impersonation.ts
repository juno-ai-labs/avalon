import { z } from "zod";

import { UserIdSchema, WorkspaceIdSchema } from "./identifiers";

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
