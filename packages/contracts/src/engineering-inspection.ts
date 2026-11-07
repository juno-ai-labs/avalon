import { z } from "zod";
import { deferredZodSchema } from "./deferred-zod-schema";

import { CreateMessageRequestSchema, RegionSchema, WorkspaceNameSchema, WorkstreamMessageAdmissionReceiptSchema, type SpaceChannelPage } from "./index";
import { AutomationIdSchema } from "./automation-agent";
import {
  ArtifactIdSchema,
  IdSchema,
  SubstreamIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  WorkstreamIdSchema,
} from "./identifiers";
import { SpaceIdSchema, SpaceSummarySchema, type SpaceDirectory } from "./spaces";
import { MESSAGE_MAX_CHARACTERS } from "./message-limits";
import { ReadTranscriptRequestSchema } from "./workstream-transcript";
import { WorkspaceRetirementResultSchema } from "./workspace-retirement";

/** Trusted Access identity supplied by the MCP Worker, never a tool argument. */
export const EngineeringOperatorSchema = z.strictObject({
  subject: z.string().min(1),
  email: z.string().nullable(),
  audience: z.string().min(1),
});
export type EngineeringOperator = z.infer<typeof EngineeringOperatorSchema>;

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

export const CreateEngineeringChannelInputSchema = deferredZodSchema(() => z.strictObject({
  ...creationIdentity,
  orgId: WorkspaceIdSchema,
  name: z.string().trim().min(1),
  participantUserIds: z.array(UserIdSchema).describe("Organization users to seat, subject to the app's audience permissions; the creator is always included. Channels are Organization-wide."),
}));
export type CreateEngineeringChannelInput = z.infer<typeof CreateEngineeringChannelInputSchema>;
export const CreateEngineeringChannelResultSchema = deferredZodSchema(() => z.strictObject({
  region: RegionSchema,
  orgId: WorkspaceIdSchema,
  channelId: SpaceIdSchema,
  channel: SpaceSummarySchema,
}));
export type CreateEngineeringChannelResult = z.infer<typeof CreateEngineeringChannelResultSchema>;

export const CreateEngineeringThreadInputSchema = deferredZodSchema(() => z.strictObject({
  ...creationIdentity,
  orgId: WorkspaceIdSchema,
  channelId: SpaceIdSchema,
  prompt: z.string().max(MESSAGE_MAX_CHARACTERS).refine((value) => value.trim().length > 0, "A starting prompt is required"),
}));
export type CreateEngineeringThreadInput = z.infer<typeof CreateEngineeringThreadInputSchema>;
export const CreateEngineeringThreadResultSchema = deferredZodSchema(() => z.strictObject({
  region: RegionSchema,
  orgId: WorkspaceIdSchema,
  channelId: SpaceIdSchema,
  threadId: WorkstreamIdSchema,
  turnId: IdSchema,
  harnessRunId: IdSchema.nullable(),
}));
export type CreateEngineeringThreadResult = z.infer<typeof CreateEngineeringThreadResultSchema>;

const engineeringViewer = { orgId: WorkspaceIdSchema, userId: UserIdSchema };
export const ListEngineeringUserChannelsInputSchema = deferredZodSchema(() => z.strictObject(engineeringViewer));
export type ListEngineeringUserChannelsInput = z.infer<typeof ListEngineeringUserChannelsInputSchema>;
export const SendEngineeringMessageInputSchema = deferredZodSchema(() => z.strictObject({
  text: CreateMessageRequestSchema.shape.text,
  mentions: CreateMessageRequestSchema.shape.mentions,
  confirmedParticipantUserIds: CreateMessageRequestSchema.shape.confirmedParticipantUserIds,
  attachmentIds: CreateMessageRequestSchema.shape.attachmentIds,
  annotations: CreateMessageRequestSchema.shape.annotations,
  runMode: CreateMessageRequestSchema.shape.runMode,
  ...engineeringViewer,
  operationId: IdSchema.describe("A fresh UUID for this message; reuse it after an uncertain outcome."),
  threadId: WorkstreamIdSchema,
  breakoutId: SubstreamIdSchema.optional().describe("Omit for the Thread's Main; a Breakout is authorized independently."),
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
 * One Organization's Threads, Breakouts and Channels, retired after the
 * cutover (docs/workspace-retirement.md#retiring-threads-breakouts-and-channels).
 * `confirm` is the Organization id again: the operation is refused unless it
 * names `orgId`, the consistency check Ace's workspace retirement makes.
 */
export const ThreadRetirementOperationInputSchema = deferredZodSchema(() => z.strictObject({
  orgId: WorkspaceIdSchema,
  confirm: z.string().describe("The orgId again, typed by the operator. The operation is refused unless it equals orgId."),
}));
export type ThreadRetirementOperationInput = z.infer<typeof ThreadRetirementOperationInputSchema>;

/** A Thread (`workstream`) or a Channel (`space`), the parents the Thread retirement walks. */
export const RetiredThreadParentKindSchema = z.enum(["workstream", "space"]);

/** One conversation or parent a pass could not finish, by a stable code. The next pass returns to it. */
export const ThreadRetirementFailureSchema = z.strictObject({
  parentKind: RetiredThreadParentKindSchema,
  parentId: z.string(),
  substreamId: z.string().nullable(),
  error: z.string(),
});

export const DumpThreadTranscriptsResultSchema = deferredZodSchema(() => z.strictObject({
  region: RegionSchema,
  orgId: WorkspaceIdSchema,
  /** Every conversation under a Thread or Channel the Organization still holds. */
  conversations: z.number().int().nonnegative(),
  /** Written by this pass. */
  dumped: z.number().int().nonnegative(),
  /** Already in R2 from an earlier pass, so not read again. */
  skipped: z.number().int().nonnegative(),
  failed: z.array(ThreadRetirementFailureSchema),
}));
export type DumpThreadTranscriptsResult = z.infer<typeof DumpThreadTranscriptsResultSchema>;

export const ReadEngineeringChannelInputSchema = deferredZodSchema(() => z.strictObject({
  ...engineeringViewer,
  channelId: SpaceIdSchema,
  cursor: z.string().min(1).optional(),
}));
export type ReadEngineeringChannelInput = z.infer<typeof ReadEngineeringChannelInputSchema>;
export const ListEngineeringUserConversationsInputSchema = deferredZodSchema(() => ReadEngineeringChannelInputSchema.unwrap().extend({
  kind: z.enum(["channel", "breakout"]),
}));
export type ListEngineeringUserConversationsInput = z.infer<typeof ListEngineeringUserConversationsInputSchema>;
export const ReadEngineeringConversationInputSchema = deferredZodSchema(() => z.strictObject({
  ...engineeringViewer,
  threadId: WorkstreamIdSchema,
  breakoutId: SubstreamIdSchema.optional(),
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

export const EngineeringWorkstreamSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  region: RegionSchema,
  title: z.string(),
  scope: z.string(),
  state: z.string(),
  systemKind: z.string().nullable(),
  lastActivityAt: z.number().int().nonnegative(),
  archivedAt: z.number().int().nonnegative().nullable(),
}));
export type EngineeringWorkstream = z.infer<typeof EngineeringWorkstreamSchema>;

export const EngineeringSubstreamSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  substreamId: SubstreamIdSchema,
  region: RegionSchema,
}));
export type EngineeringSubstream = z.infer<typeof EngineeringSubstreamSchema>;

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
 * One live web artifact as its workspace's registry holds it.
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

/**
 * One Space as its Organization holds it.
 *
 * Reported the way a Sidekick is, including an archived one: the object
 * outlives the row a product surface renders, and an archived Space is a
 * common inspection target.
 */
export const EngineeringSpaceSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: WorkspaceIdSchema,
  spaceId: SpaceIdSchema,
  region: RegionSchema,
  name: z.string(),
  scope: z.string(),
  status: z.string(),
  systemRole: z.string().nullable(),
  archivedAt: z.number().int().nonnegative().nullable(),
}));
export type EngineeringSpace = z.infer<typeof EngineeringSpaceSchema>;

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

export const WorkstreamInspectionInputSchema = deferredZodSchema(() => z.strictObject({
  workstreamId: WorkstreamIdSchema,
}));
export type WorkstreamInspectionInput = z.infer<typeof WorkstreamInspectionInputSchema>;

export const SubstreamInspectionInputSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  substreamId: SubstreamIdSchema,
}));
export type SubstreamInspectionInput = z.infer<typeof SubstreamInspectionInputSchema>;

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

export const EngineeringWorkstreamTargetSchema = deferredZodSchema(() => EngineeringWorkspaceTargetSchema.unwrap().extend({
  workstreamId: WorkstreamIdSchema,
}).strict());
export type EngineeringWorkstreamTarget = z.infer<typeof EngineeringWorkstreamTargetSchema>;

export const EngineeringSubstreamTargetSchema = deferredZodSchema(() => EngineeringWorkstreamTargetSchema.unwrap().extend({
  substreamId: SubstreamIdSchema,
}).strict());
export type EngineeringSubstreamTarget = z.infer<typeof EngineeringSubstreamTargetSchema>;

export const EngineeringArtifactTargetSchema = deferredZodSchema(() => EngineeringWorkspaceTargetSchema.unwrap().extend({
  artifactId: ArtifactIdSchema,
}).strict());
export type EngineeringArtifactTarget = z.infer<typeof EngineeringArtifactTargetSchema>;

export const WorkspaceSqlInspectionInputSchema = deferredZodSchema(() => WorkspaceInspectionInputSchema.unwrap().extend({
  authorityGeneration: AuthorityGenerationSchema,
  query: InspectionSqlRequestSchema,
}).strict());
export type WorkspaceSqlInspectionInput = z.infer<typeof WorkspaceSqlInspectionInputSchema>;

export const SubstreamSqlInspectionInputSchema = deferredZodSchema(() => SubstreamInspectionInputSchema.unwrap().extend({
  authorityGeneration: AuthorityGenerationSchema,
  query: InspectionSqlRequestSchema,
}).strict());
export type SubstreamSqlInspectionInput = z.infer<typeof SubstreamSqlInspectionInputSchema>;

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

export const EngineeringWorkstreamListLookupSchema = deferredZodSchema(() => lookupResultSchema(z.strictObject({
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  items: z.array(EngineeringWorkstreamSchema),
})));
export type EngineeringWorkstreamListLookup = z.infer<typeof EngineeringWorkstreamListLookupSchema>;

export const EngineeringSubstreamListLookupSchema = deferredZodSchema(() => lookupResultSchema(z.strictObject({
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  items: z.array(EngineeringSubstreamSchema),
})));
export type EngineeringSubstreamListLookup = z.infer<typeof EngineeringSubstreamListLookupSchema>;

export const EngineeringSidekickListLookupSchema = deferredZodSchema(() => lookupResultSchema(z.strictObject({
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  items: z.array(EngineeringSidekickSchema),
})));
export type EngineeringSidekickListLookup = z.infer<typeof EngineeringSidekickListLookupSchema>;

export const EngineeringSpaceListLookupSchema = deferredZodSchema(() => lookupResultSchema(z.strictObject({
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  items: z.array(EngineeringSpaceSchema),
})));
export type EngineeringSpaceListLookup = z.infer<typeof EngineeringSpaceListLookupSchema>;

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

export const EngineeringSubstreamTargetLookupSchema = deferredZodSchema(() => lookupResultSchema(
  EngineeringSubstreamTargetSchema,
));
export type EngineeringSubstreamTargetLookup = z.infer<
  typeof EngineeringSubstreamTargetLookupSchema
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
  spaceId: SpaceIdSchema.optional(),
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

/** The named regional WorkerEntrypoint surface bound only to the engineering MCP Worker. */
export interface EngineeringInspectionRpcBinding {
  listUserChannels(input: ListEngineeringUserChannelsInput): Promise<SpaceDirectory>;
  listUserConversations(input: ListEngineeringUserConversationsInput): Promise<SpaceChannelPage>;
  sendMessage(input: SendEngineeringMessageInput, operator: EngineeringOperator): Promise<SendEngineeringMessageResult>;
  setSidekickPaused(input: SetEngineeringSidekickPausedInput, operator: EngineeringOperator): Promise<SetEngineeringSidekickPausedResult>;
  retireOrg(input: RetireEngineeringOrgInput, operator: EngineeringOperator): Promise<RetireEngineeringOrgResult>;
  dumpThreadTranscripts(input: ThreadRetirementOperationInput, operator: EngineeringOperator): Promise<DumpThreadTranscriptsResult>;
  readChannel(input: ReadEngineeringChannelInput): Promise<EngineeringTextResult>;
  readConversation(input: ReadEngineeringConversationInput): Promise<EngineeringTextResult>;
  createOrg(input: CreateEngineeringOrgInput, operator: EngineeringOperator): Promise<CreateEngineeringOrgResult>;
  createChannel(input: CreateEngineeringChannelInput, operator: EngineeringOperator): Promise<CreateEngineeringChannelResult>;
  createThread(input: CreateEngineeringThreadInput, operator: EngineeringOperator): Promise<CreateEngineeringThreadResult>;
  listWorkspaces(input: ListEngineeringWorkspacesInput): Promise<ListEngineeringWorkspacesResult>;
  searchOrganizations(input: SearchEngineeringOrganizationsInput): Promise<SearchEngineeringOrganizationsResult>;
  searchUsers(input: SearchEngineeringUsersInput): Promise<SearchEngineeringUsersResult>;
  listWorkstreams(input: WorkspaceInspectionInput): Promise<EngineeringWorkstreamListLookup>;
  listSubstreams(input: WorkstreamInspectionInput): Promise<EngineeringSubstreamListLookup>;
  listSidekicks(input: WorkspaceInspectionInput): Promise<EngineeringSidekickListLookup>;
  listSpaces(input: WorkspaceInspectionInput): Promise<EngineeringSpaceListLookup>;
  listArtifacts(input: WorkspaceInspectionInput): Promise<EngineeringArtifactListLookup>;
  resolveWorkspace(input: WorkspaceInspectionInput): Promise<EngineeringWorkspaceTargetLookup>;
  resolveSubstream(input: SubstreamInspectionInput): Promise<EngineeringSubstreamTargetLookup>;
  resolveArtifact(input: ArtifactInspectionInput): Promise<EngineeringArtifactTargetLookup>;
  runWorkspaceSql(input: WorkspaceSqlInspectionInput): Promise<EngineeringSqlLookup>;
  runSubstreamSql(input: SubstreamSqlInspectionInput): Promise<EngineeringSqlLookup>;
  runArtifactSql(input: ArtifactSqlInspectionInput): Promise<EngineeringSqlLookup>;
  runD1Sql(input: D1SqlInspectionInput): Promise<EngineeringD1SqlResult>;
}
