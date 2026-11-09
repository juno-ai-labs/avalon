import { z } from "zod";
import { deferredZodSchema } from "./deferred-zod-schema";

import { CreateMessageRequestSchema, RegionSchema, WorkspaceNameSchema, WorkstreamMessageAdmissionReceiptSchema } from "./index";
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

export const RetireThreadsResultSchema = deferredZodSchema(() => z.strictObject({
  region: RegionSchema,
  orgId: WorkspaceIdSchema,
  /** Threads and Channels the Organization still held when this pass started; a finished retirement reruns at 0. */
  parents: z.number().int().nonnegative(),
  conversations: z.number().int().nonnegative(),
  /** Closed by this pass: each parent's conversations retired and its rows deleted. */
  retiredParents: z.number().int().nonnegative(),
  retiredConversations: z.number().int().nonnegative(),
  /** Effects the retired conversations still hold and will never publish. */
  retainedOutbox: z.number().int().nonnegative(),
  failed: z.array(ThreadRetirementFailureSchema),
}));
export type RetireThreadsResult = z.infer<typeof RetireThreadsResultSchema>;

/**
 * One Organization's Threads that have artifacts, each made a Canvas in place
 * with the same id (docs/workspace-retirement.md#converting-threads-that-have-artifacts).
 * A dry run, the default, only lists them; an apply needs `confirm` naming
 * `orgId`, the consistency check the retirement makes.
 */
export const ConvertThreadsToCanvasesInputSchema = deferredZodSchema(() => z.strictObject({
  orgId: WorkspaceIdSchema,
  dryRun: z.boolean().default(true).describe("true (the default) lists the Threads that would become Canvases and changes nothing."),
  confirm: z.string().optional().describe("The orgId again, typed by the operator. Required, and must equal orgId, when dryRun is false."),
}));
export type ConvertThreadsToCanvasesInput = z.input<typeof ConvertThreadsToCanvasesInputSchema>;

export const ThreadConversionCandidateSchema = z.strictObject({
  threadId: z.string(),
  title: z.string(),
  /** Artifacts the Thread's conversations made (`artifact_registry`). */
  artifactCount: z.number().int().nonnegative(),
  /** Artifacts another conversation made that the Thread linked. */
  linkedArtifactCount: z.number().int().nonnegative(),
  /** Who becomes a participant of the Canvas: every viewer of a personal Thread, the participants of a Workspace-scoped one. */
  participantCount: z.number().int().nonnegative(),
  /** Its conversations, Main and Breakouts, and how many have no transcript dump yet. */
  conversations: z.number().int().nonnegative(),
  undumped: z.number().int().nonnegative(),
});

export const ConvertThreadsToCanvasesResultSchema = deferredZodSchema(() => z.strictObject({
  region: RegionSchema,
  orgId: WorkspaceIdSchema,
  dryRun: z.boolean(),
  /** Every Thread with an artifact the Organization still holds; a finished conversion reruns with none. */
  candidates: z.array(ThreadConversionCandidateSchema),
  /** Made a Canvas by this pass. */
  converted: z.number().int().nonnegative(),
  /** Already a Canvas from an interrupted earlier pass, finished by this one. */
  alreadyConverted: z.number().int().nonnegative(),
  failed: z.array(z.strictObject({ threadId: z.string(), substreamId: z.string().nullable(), error: z.string() })),
  /** Artifacts whose conversation names no Thread, Canvas or Sidekick: left alone. */
  artifactsWithoutThread: z.number().int().nonnegative(),
}));
export type ConvertThreadsToCanvasesResult = z.infer<typeof ConvertThreadsToCanvasesResultSchema>;

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

/** The named regional WorkerEntrypoint surface bound only to the engineering MCP Worker. */
export interface EngineeringInspectionRpcBinding {
  sendMessage(input: SendEngineeringMessageInput, operator: EngineeringOperator): Promise<SendEngineeringMessageResult>;
  setSidekickPaused(input: SetEngineeringSidekickPausedInput, operator: EngineeringOperator): Promise<SetEngineeringSidekickPausedResult>;
  dumpThreadTranscripts(input: ThreadRetirementOperationInput, operator: EngineeringOperator): Promise<DumpThreadTranscriptsResult>;
  retireThreads(input: ThreadRetirementOperationInput, operator: EngineeringOperator): Promise<RetireThreadsResult>;
  convertThreadsToCanvases(input: ConvertThreadsToCanvasesInput, operator: EngineeringOperator): Promise<ConvertThreadsToCanvasesResult>;
  retireOrg(input: RetireEngineeringOrgInput, operator: EngineeringOperator): Promise<RetireEngineeringOrgResult>;
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
