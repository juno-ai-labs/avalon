import { z } from "zod";
import { WorkstreamAppearanceSchema } from "./workstream-appearance";
import { IdSchema, SubstreamIdSchema, UserIdSchema, WorkspaceIdSchema } from "./identifiers";
import { SpaceColorKeySchema, SpaceIconKeySchema, SpaceIdSchema, SpaceSystemRoleSchema } from "./spaces";

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

/** ECMAScript's time-value range, the point past which an instant has no `Date` and no ISO string. */
const MAX_TIME_VALUE = 8_640_000_000_000_000;

/** A share addressed to a mailbox. Whoever signs in with that verified address holds it; nothing else does. */
export const CreateScopeInvitationsSchema = z.strictObject({
  operationId: IdSchema,
  workspaceId: WorkspaceIdSchema,
  parentId: IdSchema,
  actorUserId: UserIdSchema,
  emails: z.array(z.string().trim().email().transform((email) => email.toLowerCase())).min(1),
  targets: z.array(ScopeGrantTargetSchema).min(1),
  completeWorkstream: z.boolean().optional(),
  // Null explicitly leaves expiry open until a team policy is configured. The
  // ceiling is not a policy: it is the largest instant `Date` can represent, and
  // past it `new Date(value).toISOString()` throws `RangeError: Invalid time
  // value` somewhere downstream with nothing naming the field that caused it.
  expiresAt: z.number().int().positive().max(MAX_TIME_VALUE).nullable(),
}).refine((request) => request.targets.every((target) =>
  target.workspaceId === request.workspaceId && target.parentId === request.parentId),
{ message: "An invitation operation belongs to one workstream" });
export type CreateScopeInvitations = z.infer<typeof CreateScopeInvitationsSchema>;

export const ScopeInvitationSummarySchema = z.strictObject({
  id: IdSchema,
  email: z.string().email(),
  targets: z.array(ScopeGrantTargetSchema),
  expiresAt: z.number().int().positive().nullable(),
  // "accepted" means claimed: the recipient signed in and holds the grants.
  // The stored value predates automatic claiming and is kept as written.
  status: z.enum(["pending", "accepted", "revoked"]),
  revision: z.number().int().positive(),
  acceptedByUserId: UserIdSchema.nullable(),
});
export type ScopeInvitationSummary = z.infer<typeof ScopeInvitationSummarySchema>;

/** Server-internal: every address in `emails` is already verified for `userId`. */
export const ClaimScopeInvitationsSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema, parentId: IdSchema, userId: UserIdSchema,
  emails: z.array(z.string().trim().email().transform((email) => email.toLowerCase())).min(1),
});

export const RevokeScopeInvitationSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema, parentId: IdSchema, invitationId: IdSchema,
  actorUserId: UserIdSchema, expectedRevision: z.number().int().positive(),
});
export const ScopeInvitationResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("created"), invitations: z.array(ScopeInvitationSummarySchema) }),
  z.strictObject({ status: z.literal("revoked"), invitation: ScopeInvitationSummarySchema }),
  z.strictObject({ status: z.literal("denied"), reason: z.enum([
    "sharing_required", "invitation_unavailable", "relationship_required", "operation_conflict", "revision_conflict", "configuration_required", "migration_pending", "scope_changed",
  ]) }),
]);
export type ScopeInvitationResult = z.infer<typeof ScopeInvitationResultSchema>;


/** Navigation metadata is released by the grant owner, never by the candidate index. */
export const SharedWorkstreamRequestSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema, parentId: IdSchema, userId: UserIdSchema,
  membershipIncarnation: z.string().min(1),
  /** New navigation readers opt in; older strict response parsers keep their shape. */
  includeAttention: z.boolean().optional(),
  includeResolution: z.boolean().optional(),
});
export const SharedWorkstreamSchema = z.strictObject({
  parentId: IdSchema,
  // The Channel is the navigation parent even when only one Breakout is shared.
  title: z.string().nullable(),
  appearance: WorkstreamAppearanceSchema.optional(),
  archived: z.boolean().optional(),
  conversations: z.array(z.strictObject({
    substreamId: SubstreamIdSchema,
    title: z.string(),
    archived: z.boolean(),
  })),
});
export const SharedDirectorySchema = z.strictObject({ workstreams: z.array(SharedWorkstreamSchema) });

/** Associative presentation added only on the separately versioned navigation read. */
export const SharedNavigationWorkstreamSchema = SharedWorkstreamSchema.omit({ conversations: true }).extend({
  scope: z.enum(["personal", "workspace"]),
  conversations: z.array(z.strictObject({
    substreamId: SubstreamIdSchema,
    title: z.string(),
    appearance: WorkstreamAppearanceSchema.optional(),
    scope: z.enum(["personal", "workspace"]),
    archived: z.boolean(),
    needsAttention: z.boolean().optional(),
    resolved: z.boolean().optional(),
    /** A breakout's Main transcript turn it was branched through; null when not branched from one. */
    originTurnId: z.string().min(1).nullable().optional(),
  })),
});
export type SharedNavigationWorkstream = z.infer<typeof SharedNavigationWorkstreamSchema>;

/** The smallest Space projection needed to place shared Channels in browser navigation. */
export const SharedNavigationSpaceSchema = z.strictObject({
  id: SpaceIdSchema,
  name: z.string().trim().min(1),
  iconKey: SpaceIconKeySchema,
  colorKey: SpaceColorKeySchema,
  scope: z.enum(["personal", "workspace"]),
  /** `general` marks the Organization's General Space. */
  systemRole: SpaceSystemRoleSchema.nullable().optional(),
  workstreamIds: z.array(IdSchema),
});
export type SharedNavigationSpace = z.infer<typeof SharedNavigationSpaceSchema>;

/** Versioned separately from SharedDirectorySchema so strict older clients keep parsing. */
export const SharedNavigationDirectorySchema = z.strictObject({
  spaces: z.array(SharedNavigationSpaceSchema),
  workstreams: z.array(SharedNavigationWorkstreamSchema),
});
export type SharedNavigationDirectory = z.infer<typeof SharedNavigationDirectorySchema>;

export const SharedNavigationSpacesRequestSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  userId: UserIdSchema,
  membershipIncarnation: z.string().min(1),
  accessClass: z.enum(["member", "guest"]),
  workstreamIds: z.array(IdSchema),
});


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
