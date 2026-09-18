import { z } from "zod";
import { WorkstreamAppearanceSchema } from "./workstream-appearance";
import { IdSchema, SubstreamIdSchema, UserIdSchema, WorkspaceIdSchema } from "./identifiers";

/** Guest is a workspace relationship, never a different kind of user identity. */
export const WorkspaceAccessClassSchema = z.enum(["member", "guest"]);
export type WorkspaceAccessClass = z.infer<typeof WorkspaceAccessClassSchema>;

export const WorkspaceRelationshipSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  userId: UserIdSchema,
  accessClass: WorkspaceAccessClassSchema,
  role: z.enum(["owner", "admin", "member"]).nullable(),
  status: z.enum(["active", "invited", "suspended"]),
  incarnation: z.string().min(1),
  revision: z.number().int().positive(),
});
export type WorkspaceRelationship = z.infer<typeof WorkspaceRelationshipSchema>;

export const PromoteWorkspaceGuestSchema = z.strictObject({
  incarnation: z.string().min(1),
  expectedRevision: z.number().int().positive(),
});

export const ScopeGrantTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("workstream"), workspaceId: WorkspaceIdSchema, parentId: IdSchema }),
  z.strictObject({ kind: z.literal("conversation"), workspaceId: WorkspaceIdSchema,
    parentId: IdSchema, substreamId: SubstreamIdSchema }),
]);
export type ScopeGrantTarget = z.infer<typeof ScopeGrantTargetSchema>;

export const ChildAudienceSchema = z.enum(["restricted", "inherits_workstream"]);
export type ChildAudience = z.infer<typeof ChildAudienceSchema>;

/** A revocation retains its revision; deleting a row would allow stale delivery to resurrect it. */
export const ScopeGrantSchema = z.strictObject({
  id: IdSchema,
  userId: UserIdSchema,
  target: ScopeGrantTargetSchema,
  membershipIncarnation: z.string().min(1).nullable().default(null),
  active: z.boolean(),
  revision: z.number().int().positive(),
});
export type ScopeGrant = z.infer<typeof ScopeGrantSchema>;

export const ScopeGrantMutationSchema = z.strictObject({
  operationId: IdSchema,
  actorUserId: UserIdSchema,
  userId: UserIdSchema,
  target: ScopeGrantTargetSchema,
  active: z.boolean(),
  /** Zero asserts absence. Revoked rows retain a positive revision. */
  expectedRevision: z.number().int().nonnegative(),
});
export type ScopeGrantMutation = z.infer<typeof ScopeGrantMutationSchema>;

/** Compatibility commands retain their operation receipt while the authority selects the revision. */
export const ParticipantGrantMutationSchema = ScopeGrantMutationSchema.omit({ expectedRevision: true });
export type ParticipantGrantMutation = z.infer<typeof ParticipantGrantMutationSchema>;

export const ScopeGrantMutationResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("denied"), reason: z.enum(["sharing_required", "recipient_relationship_required", "migration_pending", "participant_required", "inherited_access"]) }),
  z.strictObject({ status: z.literal("committed"), grant: ScopeGrantSchema }),
  z.strictObject({ status: z.literal("conflict"), current: ScopeGrantSchema.nullable() }),
]);
export type ScopeGrantMutationResult = z.infer<typeof ScopeGrantMutationResultSchema>;

export const ScopeAccessRequestSchema = z.strictObject({
  userId: UserIdSchema,
  target: ScopeGrantTargetSchema,
});
export type ScopeAccessRequest = z.infer<typeof ScopeAccessRequestSchema>;

export const ScopeAccessResultSchema = z.discriminatedUnion("allowed", [
  z.strictObject({ allowed: z.literal(false), reason: z.enum(["relationship_required", "not_found", "not_ready", "grant_required"]) }),
  z.strictObject({ allowed: z.literal(true), writable: z.boolean(), grantIds: z.array(IdSchema), workspaceMemberAccess: z.boolean() }),
]);
export type ScopeAccessResult = z.infer<typeof ScopeAccessResultSchema>;

/** An invitation is addressed to a verified mailbox; it is not a read capability. */
export const CreateScopeInvitationsSchema = z.strictObject({
  operationId: IdSchema,
  workspaceId: WorkspaceIdSchema,
  parentId: IdSchema,
  actorUserId: UserIdSchema,
  emails: z.array(z.string().trim().email().transform((email) => email.toLowerCase())).min(1),
  targets: z.array(ScopeGrantTargetSchema).min(1),
  completeWorkstream: z.boolean().optional(),
  // Null explicitly leaves expiry open until a team policy is configured.
  expiresAt: z.number().int().positive().nullable(),
}).refine((request) => request.targets.every((target) =>
  target.workspaceId === request.workspaceId && target.parentId === request.parentId),
{ message: "An invitation operation belongs to one workstream" });
export type CreateScopeInvitations = z.infer<typeof CreateScopeInvitationsSchema>;

export const ScopeInvitationSummarySchema = z.strictObject({
  id: IdSchema,
  email: z.string().email(),
  targets: z.array(ScopeGrantTargetSchema),
  expiresAt: z.number().int().positive().nullable(),
  status: z.enum(["pending", "accepted", "revoked"]),
  revision: z.number().int().positive(),
  acceptedByUserId: UserIdSchema.nullable(),
});
export type ScopeInvitationSummary = z.infer<typeof ScopeInvitationSummarySchema>;

export const AcceptScopeInvitationSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema, parentId: IdSchema, invitationId: IdSchema,
  userId: UserIdSchema, token: z.string().min(1),
});
export const RevokeScopeInvitationSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema, parentId: IdSchema, invitationId: IdSchema,
  actorUserId: UserIdSchema, expectedRevision: z.number().int().positive(),
});
export const ScopeInvitationResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("created"), invitations: z.array(ScopeInvitationSummarySchema) }),
  z.strictObject({ status: z.literal("accepted"), invitation: ScopeInvitationSummarySchema }),
  z.strictObject({ status: z.literal("revoked"), invitation: ScopeInvitationSummarySchema }),
  z.strictObject({ status: z.literal("denied"), reason: z.enum([
    "sharing_required", "invitation_unavailable", "verified_email_required",
    "relationship_required", "operation_conflict", "revision_conflict", "configuration_required", "migration_pending", "scope_changed",
  ]) }),
]);
export type ScopeInvitationResult = z.infer<typeof ScopeInvitationResultSchema>;


/** Navigation metadata is released by the grant owner, never by the candidate index. */
export const SharedWorkstreamRequestSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema, parentId: IdSchema, userId: UserIdSchema,
  membershipIncarnation: z.string().min(1),
});
export const SharedWorkstreamSchema = z.strictObject({
  parentId: IdSchema,
  // Main supplies the parent title; a child-only share does not expose it.
  title: z.string().nullable(),
  appearance: WorkstreamAppearanceSchema.optional(),
  conversations: z.array(z.strictObject({ substreamId: SubstreamIdSchema, title: z.string(), archived: z.boolean() })),
});
export const SharedDirectorySchema = z.strictObject({ workstreams: z.array(SharedWorkstreamSchema) });


export const ListScopeInvitationsSchema = z.strictObject({
  actorUserId: UserIdSchema, target: ScopeGrantTargetSchema,
});
export const ScopeInvitationsListSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ready"), invitations: z.array(ScopeInvitationSummarySchema) }),
  z.strictObject({ status: z.literal("denied"), reason: z.literal("sharing_required") }),
]);


export const ScopeSharingOptionsRequestSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema, parentId: IdSchema, actorUserId: UserIdSchema,
});
export const ScopeSharingOptionsSchema = z.strictObject({
  scopes: z.array(z.strictObject({ target: ScopeGrantTargetSchema, title: z.string() })),
  completeWorkstreamTargets: z.array(ScopeGrantTargetSchema).nullable(),
});


export const ScopeGrantManagementRequestSchema = z.strictObject({ actorUserId: UserIdSchema, target: ScopeGrantTargetSchema });
export const ManagedScopeGrantSchema = z.strictObject({ grant: ScopeGrantSchema, name: z.string().nullable(), email: z.string().nullable() });
export const ManagedScopeGrantsSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ready"), grants: z.array(ManagedScopeGrantSchema) }),
  z.strictObject({ status: z.literal("denied"), reason: z.literal("sharing_required") }),
]);
export const RevokeScopeGrantSchema = ScopeGrantMutationSchema.omit({ actorUserId: true, active: true });

/** Trusted connector ingress, never an end-user sharing command. */
export const ConnectorParticipantAdmissionSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  parentId: IdSchema,
  eventId: z.string().min(1),
  userIds: z.array(UserIdSchema),
  addedByUserId: UserIdSchema.nullable(),
});
