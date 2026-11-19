import type { BillingAdminMutation, BillingCatalogMutation, BillingMutationResult, BillingCatalogInspection, OrgBillingResult, InspectOrgBillingSchema, InspectBillingCatalogSchema } from "./billing-admin";
import { GrantOverageCreditSchema, GrantTrialMonthsSchema, type TrialMonthsGrant, type BillingCredits, type OverageCredit } from "./billing";
import { OrganizationUsageSchema, PlanIdSchema } from "./usage";
import { z } from "zod";
import { deferredZodSchema } from "./deferred-zod-schema";

import { AddWorkspaceMemberRequestSchema, AddWorkspaceMemberResponseSchema, CreateMessageRequestSchema, RegionSchema, WorkspaceNameSchema, WorkstreamMessageAdmissionReceiptSchema } from "./index";
import { AutomationIdSchema } from "./automation-agent";
import {
  ArtifactIdSchema,
  IdSchema,
  SubstreamIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  WorkstreamIdSchema,
} from "./identifiers";
import { ReadTranscriptRequestSchema } from "./workstream-transcript";
import { WorkspaceRetirementResultSchema } from "./workspace-retirement";

/** Trusted Access identity supplied by the MCP Worker, never a tool argument. */
export const EngineeringOperatorSchema = z.strictObject({
  subject: z.string().min(1),
  email: z.string().nullable(),
  audience: z.string().min(1),
});
export type EngineeringOperator = z.infer<typeof EngineeringOperatorSchema>;

export const EngineeringPasswordUserInputSchema = deferredZodSchema(() => z.strictObject({
  userId: UserIdSchema.describe("Existing Global identity user ID from search_users; this never creates or links an account."),
}));
export type EngineeringPasswordUserInput = z.infer<typeof EngineeringPasswordUserInputSchema>;
export const EngineeringProvisionPasswordResultSchema = deferredZodSchema(() => z.strictObject({
  userId: UserIdSchema, email: z.string().email(), password: z.string(),
}));
export type EngineeringProvisionPasswordResult = z.infer<typeof EngineeringProvisionPasswordResultSchema>;
export const EngineeringRevokePasswordResultSchema = deferredZodSchema(() => z.strictObject({
  userId: UserIdSchema, passwordEnabled: z.literal(false),
}));
export type EngineeringRevokePasswordResult = z.infer<typeof EngineeringRevokePasswordResultSchema>;

const creationIdentity = {
  operationId: IdSchema.describe("A fresh UUID for this creation. Reuse it and the same arguments after an uncertain outcome."),
  creatorUserId: UserIdSchema.describe("Existing regional Rally user to create as. For an existing Organization, selects any active member or guest and enforces the app's permissions; no login session is minted."),
};

export const CreateEngineeringOrgInputSchema = deferredZodSchema(() => z.strictObject({
  ...creationIdentity,
  region: RegionSchema,
  name: WorkspaceNameSchema,
  userIds: z.array(UserIdSchema).describe("Existing users in this region to add as members. The creator is always included as owner."),
}));
export type CreateEngineeringOrgInput = z.infer<typeof CreateEngineeringOrgInputSchema>;
export const CreateEngineeringOrgResultSchema = deferredZodSchema(() => z.strictObject({
  region: RegionSchema,
  orgId: WorkspaceIdSchema,
  userIds: z.array(UserIdSchema),
}));
export type CreateEngineeringOrgResult = z.infer<typeof CreateEngineeringOrgResultSchema>;

const engineeringViewer = { orgId: WorkspaceIdSchema, userId: UserIdSchema };
export const SendEngineeringMessageInputSchema = deferredZodSchema(() => z.strictObject({
  text: CreateMessageRequestSchema.shape.text,
  mentions: CreateMessageRequestSchema.shape.mentions,
  confirmedParticipantUserIds: CreateMessageRequestSchema.shape.confirmedParticipantUserIds,
  attachmentIds: CreateMessageRequestSchema.shape.attachmentIds,
  annotations: CreateMessageRequestSchema.shape.annotations,
  runMode: CreateMessageRequestSchema.shape.runMode,
  ...engineeringViewer,
  operationId: IdSchema.describe("A fresh UUID for this message; reuse it after an uncertain outcome."),
  conversationId: IdSchema.describe("A Canvas ID (posts to its Chat) or a Sidekick ID (posts to its shared conversation)."),
  recordOnly: z.boolean().optional().describe("true posts for the conversation's readers without starting a Rally run, whatever addressing would decide. false or omitted uses normal addressing."),
}));
export type SendEngineeringMessageInput = z.infer<typeof SendEngineeringMessageInputSchema>;
export const SendEngineeringMessageResultSchema = deferredZodSchema(() => z.strictObject({
  receipt: WorkstreamMessageAdmissionReceiptSchema,
}));
export type SendEngineeringMessageResult = z.infer<typeof SendEngineeringMessageResultSchema>;

export const SetEngineeringSidekickPausedInputSchema = deferredZodSchema(() => z.strictObject({
  orgId: WorkspaceIdSchema,
  userId: UserIdSchema.describe("Existing Organization user to act as. They must be allowed to manage the Sidekick in the app: its author, its run-as user, a manager of its owning Thread, or an owner or admin for an Organization-wide one."),
  sidekickId: AutomationIdSchema,
  paused: z.boolean(),
}));
export type SetEngineeringSidekickPausedInput = z.infer<typeof SetEngineeringSidekickPausedInputSchema>;
export const SetEngineeringSidekickPausedResultSchema = deferredZodSchema(() => z.strictObject({
  region: RegionSchema,
  orgId: WorkspaceIdSchema,
  sidekickId: AutomationIdSchema,
  lifecycle: z.enum(["paused", "active"]),
}));
export type SetEngineeringSidekickPausedResult = z.infer<typeof SetEngineeringSidekickPausedResultSchema>;

export const ArchiveEngineeringSidekickInputSchema = deferredZodSchema(() => SetEngineeringSidekickPausedInputSchema.unwrap().omit({ paused: true }));
export type ArchiveEngineeringSidekickInput = z.infer<typeof ArchiveEngineeringSidekickInputSchema>;
export const ArchiveEngineeringSidekickResultSchema = deferredZodSchema(() => z.strictObject({
  region: RegionSchema,
  orgId: WorkspaceIdSchema,
  sidekickId: AutomationIdSchema,
  lifecycle: z.literal("deleted"),
}));
export type ArchiveEngineeringSidekickResult = z.infer<typeof ArchiveEngineeringSidekickResultSchema>;

export const AddEngineeringOrgMemberInputSchema = deferredZodSchema(() => z.strictObject({
  orgId: WorkspaceIdSchema,
  adminUserId: UserIdSchema.describe("An active owner or admin of the Organization to act as (use search_users). The email names them as the one who added the person."),
  email: AddWorkspaceMemberRequestSchema.shape.email.describe("The address to add. A person with no account gets one their first email sign-in lands on."),
  role: AddWorkspaceMemberRequestSchema.shape.role,
}));
export type AddEngineeringOrgMemberInput = z.infer<typeof AddEngineeringOrgMemberInputSchema>;
export const AddEngineeringOrgMemberResultSchema = deferredZodSchema(() => AddWorkspaceMemberResponseSchema.extend({
  region: RegionSchema,
  orgId: WorkspaceIdSchema,
}));
export type AddEngineeringOrgMemberResult = z.infer<typeof AddEngineeringOrgMemberResultSchema>;

export const RetireEngineeringOrgInputSchema = deferredZodSchema(() => z.strictObject({
  orgId: WorkspaceIdSchema.describe("The Organization to close for good. Retiring it again resumes an unfinished walk."),
}));
export type RetireEngineeringOrgInput = z.infer<typeof RetireEngineeringOrgInputSchema>;
/** Ace's retirement receipt, plus the region that answered. */
export const RetireEngineeringOrgResultSchema = deferredZodSchema(() => WorkspaceRetirementResultSchema.extend({
  region: RegionSchema,
}));
export type RetireEngineeringOrgResult = z.infer<typeof RetireEngineeringOrgResultSchema>;

/**
 * A conversation an operator reads as a user: a Canvas's Chat or a Sidekick's
 * shared conversation. `kind` is what the operator asked for; the region
 * refuses an id whose parent is the other kind (`conversation_kind_mismatch`).
 */
export const ReadEngineeringConversationInputSchema = deferredZodSchema(() => z.strictObject({
  ...engineeringViewer,
  kind: z.enum(["canvas", "sidekick"]),
  conversationId: IdSchema,
  ...ReadTranscriptRequestSchema.shape,
}));
export type ReadEngineeringConversationInput = z.infer<typeof ReadEngineeringConversationInputSchema>;
export const EngineeringTextResultSchema = deferredZodSchema(() => z.strictObject({ text: z.string() }));
export type EngineeringTextResult = z.infer<typeof EngineeringTextResultSchema>;

export const InspectionSqlBindingSchema = deferredZodSchema(() => z.union([
  z.string(),
  z.number().finite(),
  z.null(),
]));
export type InspectionSqlBinding = z.infer<typeof InspectionSqlBindingSchema>;

export const InspectionSqlRequestSchema = deferredZodSchema(() => z.strictObject({
  sql: z.string().min(1),
  bindings: z.array(InspectionSqlBindingSchema).default([]),
}));
export type InspectionSqlRequest = z.infer<typeof InspectionSqlRequestSchema>;

export const InspectionSqlValueSchema = deferredZodSchema(() => z.union([
  InspectionSqlBindingSchema,
  z.strictObject({ type: z.literal("blob"), base64: z.string() }),
]));
export type InspectionSqlValue = z.infer<typeof InspectionSqlValueSchema>;

export const InspectionSqlResultSchema = deferredZodSchema(() => z.strictObject({
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), InspectionSqlValueSchema)),
  rowsRead: z.number().int().nonnegative(),
  rowsWritten: z.number().int().nonnegative(),
}));
export type InspectionSqlResult = z.infer<typeof InspectionSqlResultSchema>;

export const EngineeringWorkspaceSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: WorkspaceIdSchema,
  name: z.string(),
  slug: z.string(),
  region: RegionSchema,
  placementAffinity: z.string(),
  authorityState: z.string().nullable(),
}));
export type EngineeringWorkspace = z.infer<typeof EngineeringWorkspaceSchema>;

/** One Canvas, read from the Organization's `canvas_directory`. */
export const EngineeringCanvasSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: WorkspaceIdSchema,
  canvasId: IdSchema,
  region: RegionSchema,
  title: z.string(),
  visibility: z.string(),
  createdByUserId: z.string(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}));
export type EngineeringCanvas = z.infer<typeof EngineeringCanvasSchema>;

/**
 * One Sidekick as its workspace's directory holds it.
 *
 * `sidekickId` is an `AutomationId` because that is the identifier the product
 * stores, names the object with, and keys every route by; only the operator's
 * vocabulary was renamed. `lifecycle` is reported rather than filtered on: a
 * paused or deleted Sidekick still has an object, and it is the one an operator
 * most often needs to open.
 */
export const EngineeringSidekickSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: WorkspaceIdSchema,
  sidekickId: AutomationIdSchema,
  region: RegionSchema,
  lifecycle: z.string(),
  scope: z.string(),
  owningWorkstreamId: WorkstreamIdSchema.nullable(),
  title: z.string(),
  // Not bounded below: the column carries no CHECK, and one odd timestamp
  // must not make a whole workspace's Sidekicks unlistable.
  nextRunAt: z.number().int().nullable(),
  projectedAt: z.number().int().nonnegative(),
}));
export type EngineeringSidekick = z.infer<typeof EngineeringSidekickSchema>;

/**
 * One reactive web artifact as its workspace's registry holds it.
 *
 * `stateful` is the artifact's own shape, not this object's: a stateful
 * artifact keeps its data in a Durable Object facet with its own SQLite
 * database, which the supervisor's inspection RPC does not reach. Reported so
 * an operator knows before querying that `run_artifact_sql` will show the
 * supervisor and not the artifact's tables.
 */
export const EngineeringArtifactSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: WorkspaceIdSchema,
  artifactId: ArtifactIdSchema,
  region: RegionSchema,
  workstreamId: WorkstreamIdSchema,
  resourceId: z.string(),
  mode: z.string(),
  stateful: z.boolean(),
  currentVersion: z.number().int().positive(),
  hostnameStub: z.string().nullable(),
  updatedAt: z.number().int().nonnegative(),
}));
export type EngineeringArtifact = z.infer<typeof EngineeringArtifactSchema>;


export const ListEngineeringWorkspacesInputSchema = z.strictObject({});
export type ListEngineeringWorkspacesInput = z.infer<typeof ListEngineeringWorkspacesInputSchema>;

export const ListEngineeringWorkspacesResultSchema = deferredZodSchema(() => z.strictObject({
  region: RegionSchema,
  items: z.array(EngineeringWorkspaceSchema),
}));
export type ListEngineeringWorkspacesResult = z.infer<typeof ListEngineeringWorkspacesResultSchema>;

/**
 * Filters for the Organization search. Every field narrows the result; none
 * given returns every Organization in the region. Ordering and paging are the
 * caller's, applied after the regions' answers are merged.
 */
export const SearchEngineeringOrganizationsInputSchema = deferredZodSchema(() => z.strictObject({
  /** Case-insensitive substring of the name, slug, or ID. */
  query: z.string().min(1).optional(),
  plan: z.string().min(1).optional(),
  /** `exclude` by default. */
  abandoned: z.enum(["exclude", "include", "only"]).optional(),
  createdAfter: z.string().datetime({ offset: true }).optional(),
  createdBefore: z.string().datetime({ offset: true }).optional(),
}));
export type SearchEngineeringOrganizationsInput = z.infer<typeof SearchEngineeringOrganizationsInputSchema>;

export const EngineeringOrganizationSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: WorkspaceIdSchema,
  name: z.string(),
  slug: z.string(),
  region: RegionSchema,
  plan: z.string(),
  createdAt: z.string(),
  abandonedAt: z.string().nullable(),
  /** Active members, guests excluded. */
  memberCount: z.number().int().nonnegative(),
  /** The latest `last_seen_at` of any active member or guest; null if none has been seen. */
  lastSeenAt: z.string().nullable(),
}));
export type EngineeringOrganization = z.infer<typeof EngineeringOrganizationSchema>;

export const SearchEngineeringOrganizationsResultSchema = deferredZodSchema(() => z.strictObject({
  region: RegionSchema,
  items: z.array(EngineeringOrganizationSchema),
}));
export type SearchEngineeringOrganizationsResult = z.infer<typeof SearchEngineeringOrganizationsResultSchema>;

/**
 * Filters for the user search. Every field narrows the result; none given
 * returns every user in the region. Ordering and paging are the caller's.
 */
export const SearchEngineeringUsersInputSchema = deferredZodSchema(() => z.strictObject({
  /** Case-insensitive substring of the name, email, or ID. */
  query: z.string().min(1).optional(),
  createdAfter: z.string().datetime({ offset: true }).optional(),
  createdBefore: z.string().datetime({ offset: true }).optional(),
}));
export type SearchEngineeringUsersInput = z.infer<typeof SearchEngineeringUsersInputSchema>;

export const EngineeringUserOrganizationSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: WorkspaceIdSchema,
  name: z.string(),
  slug: z.string(),
  /** Null for a guest. */
  role: z.string().nullable(),
  accessClass: z.string(),
  status: z.string(),
  lastSeenAt: z.string().nullable(),
}));
export type EngineeringUserOrganization = z.infer<typeof EngineeringUserOrganizationSchema>;

export const EngineeringUserSchema = deferredZodSchema(() => z.strictObject({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  region: RegionSchema,
  createdAt: z.string(),
  /** The latest `last_seen_at` across the user's active memberships; null if never seen. */
  lastSeenAt: z.string().nullable(),
  /** Every membership in this region, whatever its status. */
  organizations: z.array(EngineeringUserOrganizationSchema),
}));
export type EngineeringUser = z.infer<typeof EngineeringUserSchema>;

export const SearchEngineeringUsersResultSchema = deferredZodSchema(() => z.strictObject({
  region: RegionSchema,
  items: z.array(EngineeringUserSchema),
}));
export type SearchEngineeringUsersResult = z.infer<typeof SearchEngineeringUsersResultSchema>;

export const WorkspaceInspectionInputSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: WorkspaceIdSchema,
}));
export type WorkspaceInspectionInput = z.infer<typeof WorkspaceInspectionInputSchema>;

/**
 * A Canvas's or Sidekick's conversation object, by the parent's id: the
 * object is named by that id (a `workstream` id in storage) and, unless
 * `substreamId` names one of its registered children (a Sidekick run's or a
 * background agent's conversation), is its main conversation, substream 0.
 */
export const ConversationInspectionInputSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: WorkspaceIdSchema,
  conversationId: IdSchema,
  substreamId: SubstreamIdSchema.optional(),
}));
export type ConversationInspectionInput = z.infer<typeof ConversationInspectionInputSchema>;

export const ArtifactInspectionInputSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: WorkspaceIdSchema,
  artifactId: ArtifactIdSchema,
}));
export type ArtifactInspectionInput = z.infer<typeof ArtifactInspectionInputSchema>;

const AuthorityGenerationSchema = z.number().int().positive();

export const EngineeringWorkspaceTargetSchema = deferredZodSchema(() => z.strictObject({
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  authorityGeneration: AuthorityGenerationSchema,
}));
export type EngineeringWorkspaceTarget = z.infer<typeof EngineeringWorkspaceTargetSchema>;

export const EngineeringConversationTargetSchema = deferredZodSchema(() => EngineeringWorkspaceTargetSchema.unwrap().extend({
  conversationId: IdSchema,
}).strict());
export type EngineeringConversationTarget = z.infer<typeof EngineeringConversationTargetSchema>;

export const EngineeringArtifactTargetSchema = deferredZodSchema(() => EngineeringWorkspaceTargetSchema.unwrap().extend({
  artifactId: ArtifactIdSchema,
}).strict());
export type EngineeringArtifactTarget = z.infer<typeof EngineeringArtifactTargetSchema>;

export const WorkspaceSqlInspectionInputSchema = deferredZodSchema(() => WorkspaceInspectionInputSchema.unwrap().extend({
  authorityGeneration: AuthorityGenerationSchema,
  query: InspectionSqlRequestSchema,
}).strict());
export type WorkspaceSqlInspectionInput = z.infer<typeof WorkspaceSqlInspectionInputSchema>;

export const ConversationSqlInspectionInputSchema = deferredZodSchema(() => ConversationInspectionInputSchema.unwrap().extend({
  authorityGeneration: AuthorityGenerationSchema,
  query: InspectionSqlRequestSchema,
}).strict());
export type ConversationSqlInspectionInput = z.infer<typeof ConversationSqlInspectionInputSchema>;

export const ArtifactSqlInspectionInputSchema = deferredZodSchema(() => ArtifactInspectionInputSchema.unwrap().extend({
  authorityGeneration: AuthorityGenerationSchema,
  query: InspectionSqlRequestSchema,
}).strict());
export type ArtifactSqlInspectionInput = z.infer<typeof ArtifactSqlInspectionInputSchema>;

function lookupResultSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion("found", [
    z.strictObject({ found: z.literal(false) }),
    z.strictObject({ found: z.literal(true), value }),
  ]);
}

export const EngineeringCanvasListLookupSchema = deferredZodSchema(() => lookupResultSchema(z.strictObject({
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  items: z.array(EngineeringCanvasSchema),
})));
export type EngineeringCanvasListLookup = z.infer<typeof EngineeringCanvasListLookupSchema>;

export const EngineeringSidekickListLookupSchema = deferredZodSchema(() => lookupResultSchema(z.strictObject({
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  items: z.array(EngineeringSidekickSchema),
})));
export type EngineeringSidekickListLookup = z.infer<typeof EngineeringSidekickListLookupSchema>;


export const EngineeringArtifactListLookupSchema = deferredZodSchema(() => lookupResultSchema(z.strictObject({
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  items: z.array(EngineeringArtifactSchema),
})));
export type EngineeringArtifactListLookup = z.infer<typeof EngineeringArtifactListLookupSchema>;

export const EngineeringWorkspaceTargetLookupSchema = deferredZodSchema(() => lookupResultSchema(
  EngineeringWorkspaceTargetSchema,
));
export type EngineeringWorkspaceTargetLookup = z.infer<
  typeof EngineeringWorkspaceTargetLookupSchema
>;

export const EngineeringConversationTargetLookupSchema = deferredZodSchema(() => lookupResultSchema(
  EngineeringConversationTargetSchema,
));
export type EngineeringConversationTargetLookup = z.infer<
  typeof EngineeringConversationTargetLookupSchema
>;

export const EngineeringArtifactTargetLookupSchema = deferredZodSchema(() => lookupResultSchema(
  EngineeringArtifactTargetSchema,
));
export type EngineeringArtifactTargetLookup = z.infer<
  typeof EngineeringArtifactTargetLookupSchema
>;

/**
 * `sidekickId` and `artifactId` are **optional and omitted**, not nullable like
 * the two ids above them, and that asymmetry is load-bearing rather than
 * untidy.
 *
 * This object is `strict`, and the MCP Worker parses every regional SQL
 * response through it. `.github/workflows/deploy-api.yml` deploys the regional
 * Workers first and the MCP last, so mid-rollout an upgraded bridge answers an
 * MCP still running the previous build of this schema. A required key — even a
 * nullable one — is an unknown key to that build, and strict parsing would
 * reject it: every existing SQL tool would fail for the length of the window.
 * Omitting the key instead leaves the three pre-existing results byte-identical
 * to what the old schema expects, while an older region that does not send them
 * still parses here.
 *
 * So a result carries only the id naming the kind of object it ran against.
 * Making these required, or adding the next object kind's id as a required
 * field, reintroduces the same rollout break.
 */
export const EngineeringSqlLookupSchema = deferredZodSchema(() => lookupResultSchema(z.strictObject({
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema.nullable(),
  substreamId: SubstreamIdSchema.nullable(),
  sidekickId: AutomationIdSchema.optional(),
  artifactId: ArtifactIdSchema.optional(),
  result: InspectionSqlResultSchema,
})));
export type EngineeringSqlLookup = z.infer<typeof EngineeringSqlLookupSchema>;

/**
 * The regional API Worker's D1 bindings the console may reach, named as its
 * `Env` names them. `PLATFORM_DB` is one database shared by every region.
 *
 * `AUDIT_DB` is left out on purpose: it records privileged actions such as
 * impersonation and support access, D1 has no read-only binding to offer in
 * its place, and the console's own log never records the SQL it ran.
 */
export const ENGINEERING_D1_DATABASES = ["DB", "TELEMETRY_DB", "USAGE_DB", "PLATFORM_DB", "MESSAGE_ISSUES_DB"] as const;
export const EngineeringD1DatabaseSchema = z.enum(ENGINEERING_D1_DATABASES);
export type EngineeringD1Database = z.infer<typeof EngineeringD1DatabaseSchema>;

export const D1SqlInspectionInputSchema = deferredZodSchema(() => z.strictObject({
  database: EngineeringD1DatabaseSchema,
  query: InspectionSqlRequestSchema,
}));
export type D1SqlInspectionInput = z.infer<typeof D1SqlInspectionInputSchema>;

export const EngineeringD1SqlResultSchema = deferredZodSchema(() => z.strictObject({
  region: RegionSchema,
  database: EngineeringD1DatabaseSchema,
  result: InspectionSqlResultSchema,
}));
export type EngineeringD1SqlResult = z.infer<typeof EngineeringD1SqlResultSchema>;

export const InspectEngineeringOrgSettingsInputSchema = z.strictObject({ orgId: WorkspaceIdSchema });
export const UpdateEngineeringOrgSettingsInputSchema = InspectEngineeringOrgSettingsInputSchema.extend({
  modelSelectorVisible: z.boolean(),
});
export const EngineeringOrgSettingsResultSchema = z.strictObject({
  region: RegionSchema,
  orgId: WorkspaceIdSchema,
  modelSelectorVisible: z.boolean(),
});
export type InspectEngineeringOrgSettingsInput = z.infer<typeof InspectEngineeringOrgSettingsInputSchema>;
export type UpdateEngineeringOrgSettingsInput = z.infer<typeof UpdateEngineeringOrgSettingsInputSchema>;
export type EngineeringOrgSettingsResult = z.infer<typeof EngineeringOrgSettingsResultSchema>;

export const InspectEngineeringUsageInputSchema = z.strictObject({ orgId: WorkspaceIdSchema });
export const ChangeEngineeringPlanInputSchema = InspectEngineeringUsageInputSchema.extend({ plan: PlanIdSchema });
export const EngineeringUsageResultSchema = z.strictObject({ region: RegionSchema, orgId: WorkspaceIdSchema, usage: OrganizationUsageSchema });
export type InspectEngineeringUsageInput = z.infer<typeof InspectEngineeringUsageInputSchema>;
export type ChangeEngineeringPlanInput = z.infer<typeof ChangeEngineeringPlanInputSchema>;
export type EngineeringUsageResult = z.infer<typeof EngineeringUsageResultSchema>;

export const GrantEngineeringTrialMonthsInputSchema = GrantTrialMonthsSchema.extend({ orgId: WorkspaceIdSchema });
export type GrantEngineeringTrialMonthsInput = z.infer<typeof GrantEngineeringTrialMonthsInputSchema>;

export const InspectEngineeringCreditsInputSchema = z.strictObject({
  orgId: WorkspaceIdSchema,
  operationId: z.uuid().optional().describe('Look up only the grant for this previously accepted operation, including legacy grants without an expiration. Never issues credit; an empty grants list means no matching Stripe receipt was found.'),
});
export const GrantEngineeringCreditInputSchema = GrantOverageCreditSchema.extend({ orgId: WorkspaceIdSchema });
export const ExpireEngineeringCreditInputSchema = z.strictObject({ orgId: WorkspaceIdSchema, grantId: z.string().startsWith("credgr_") });
export type GrantEngineeringCreditInput = z.infer<typeof GrantEngineeringCreditInputSchema>;
export type ExpireEngineeringCreditInput = z.infer<typeof ExpireEngineeringCreditInputSchema>;

/** The named regional WorkerEntrypoint surface bound only to the engineering MCP Worker. */
export interface EngineeringInspectionRpcBinding {
  inspectOrgBilling(input: z.infer<typeof InspectOrgBillingSchema>): Promise<OrgBillingResult>;
  administerOrgBilling(input: BillingAdminMutation, operator: EngineeringOperator): Promise<BillingMutationResult>;
  inspectBillingCatalog(input: z.infer<typeof InspectBillingCatalogSchema>): Promise<BillingCatalogInspection>;
  administerBillingCatalog(input: BillingCatalogMutation, operator: EngineeringOperator): Promise<BillingMutationResult>;
  grantTrialMonths(input: GrantEngineeringTrialMonthsInput, operator: EngineeringOperator): Promise<TrialMonthsGrant>;
  inspectOverageCredits(input: z.infer<typeof InspectEngineeringCreditsInputSchema>): Promise<BillingCredits>;
  grantOverageCredit(input: GrantEngineeringCreditInput, operator: EngineeringOperator): Promise<OverageCredit>;
  expireOverageCredit(input: ExpireEngineeringCreditInput, operator: EngineeringOperator): Promise<OverageCredit>;
  inspectOrganizationSettings(input: InspectEngineeringOrgSettingsInput): Promise<EngineeringOrgSettingsResult>;
  updateOrganizationSettings(input: UpdateEngineeringOrgSettingsInput, operator: EngineeringOperator): Promise<EngineeringOrgSettingsResult>;
  inspectOrganizationUsage(input: InspectEngineeringUsageInput): Promise<EngineeringUsageResult>;
  changeOrganizationPlan(input: ChangeEngineeringPlanInput, operator: EngineeringOperator): Promise<EngineeringUsageResult>;
  provisionUserPassword(input: EngineeringPasswordUserInput, operator: EngineeringOperator): Promise<EngineeringProvisionPasswordResult>;
  revokeUserPassword(input: EngineeringPasswordUserInput, operator: EngineeringOperator): Promise<EngineeringRevokePasswordResult>;
  sendMessage(input: SendEngineeringMessageInput, operator: EngineeringOperator): Promise<SendEngineeringMessageResult>;
  setSidekickPaused(input: SetEngineeringSidekickPausedInput, operator: EngineeringOperator): Promise<SetEngineeringSidekickPausedResult>;
  archiveSidekick(input: ArchiveEngineeringSidekickInput, operator: EngineeringOperator): Promise<ArchiveEngineeringSidekickResult>;
  retireOrg(input: RetireEngineeringOrgInput, operator: EngineeringOperator): Promise<RetireEngineeringOrgResult>;
  addOrgMember(input: AddEngineeringOrgMemberInput, operator: EngineeringOperator): Promise<AddEngineeringOrgMemberResult>;
  readConversation(input: ReadEngineeringConversationInput): Promise<EngineeringTextResult>;
  createOrg(input: CreateEngineeringOrgInput, operator: EngineeringOperator): Promise<CreateEngineeringOrgResult>;
  listWorkspaces(input: ListEngineeringWorkspacesInput): Promise<ListEngineeringWorkspacesResult>;
  searchOrganizations(input: SearchEngineeringOrganizationsInput): Promise<SearchEngineeringOrganizationsResult>;
  searchUsers(input: SearchEngineeringUsersInput): Promise<SearchEngineeringUsersResult>;
  listCanvases(input: WorkspaceInspectionInput): Promise<EngineeringCanvasListLookup>;
  listSidekicks(input: WorkspaceInspectionInput): Promise<EngineeringSidekickListLookup>;
  listArtifacts(input: WorkspaceInspectionInput): Promise<EngineeringArtifactListLookup>;
  resolveWorkspace(input: WorkspaceInspectionInput): Promise<EngineeringWorkspaceTargetLookup>;
  resolveConversation(input: ConversationInspectionInput): Promise<EngineeringConversationTargetLookup>;
  resolveArtifact(input: ArtifactInspectionInput): Promise<EngineeringArtifactTargetLookup>;
  runWorkspaceSql(input: WorkspaceSqlInspectionInput): Promise<EngineeringSqlLookup>;
  runConversationSql(input: ConversationSqlInspectionInput): Promise<EngineeringSqlLookup>;
  runArtifactSql(input: ArtifactSqlInspectionInput): Promise<EngineeringSqlLookup>;
  runD1Sql(input: D1SqlInspectionInput): Promise<EngineeringD1SqlResult>;
}
