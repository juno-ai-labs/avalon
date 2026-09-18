import { z } from "zod";
import { deferredZodSchema } from "./deferred-zod-schema";

import { RegionSchema } from "./index";
import { AutomationIdSchema } from "./automation-agent";
import {
  ArtifactIdSchema,
  SubstreamIdSchema,
  WorkspaceIdSchema,
  WorkstreamIdSchema,
} from "./identifiers";

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

export const ListEngineeringWorkspacesInputSchema = z.strictObject({});
export type ListEngineeringWorkspacesInput = z.infer<typeof ListEngineeringWorkspacesInputSchema>;

export const ListEngineeringWorkspacesResultSchema = deferredZodSchema(() => z.strictObject({
  region: RegionSchema,
  items: z.array(EngineeringWorkspaceSchema),
}));
export type ListEngineeringWorkspacesResult = z.infer<typeof ListEngineeringWorkspacesResultSchema>;

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

export const SidekickInspectionInputSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: WorkspaceIdSchema,
  sidekickId: AutomationIdSchema,
}));
export type SidekickInspectionInput = z.infer<typeof SidekickInspectionInputSchema>;

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

export const EngineeringSidekickTargetSchema = deferredZodSchema(() => EngineeringWorkspaceTargetSchema.unwrap().extend({
  sidekickId: AutomationIdSchema,
}).strict());
export type EngineeringSidekickTarget = z.infer<typeof EngineeringSidekickTargetSchema>;

export const EngineeringArtifactTargetSchema = deferredZodSchema(() => EngineeringWorkspaceTargetSchema.unwrap().extend({
  artifactId: ArtifactIdSchema,
}).strict());
export type EngineeringArtifactTarget = z.infer<typeof EngineeringArtifactTargetSchema>;

export const WorkspaceSqlInspectionInputSchema = deferredZodSchema(() => WorkspaceInspectionInputSchema.unwrap().extend({
  authorityGeneration: AuthorityGenerationSchema,
  query: InspectionSqlRequestSchema,
}).strict());
export type WorkspaceSqlInspectionInput = z.infer<typeof WorkspaceSqlInspectionInputSchema>;

export const WorkstreamSqlInspectionInputSchema = deferredZodSchema(() => WorkstreamInspectionInputSchema.unwrap().extend({
  authorityGeneration: AuthorityGenerationSchema,
  query: InspectionSqlRequestSchema,
}).strict());
export type WorkstreamSqlInspectionInput = z.infer<typeof WorkstreamSqlInspectionInputSchema>;

export const SubstreamSqlInspectionInputSchema = deferredZodSchema(() => SubstreamInspectionInputSchema.unwrap().extend({
  authorityGeneration: AuthorityGenerationSchema,
  query: InspectionSqlRequestSchema,
}).strict());
export type SubstreamSqlInspectionInput = z.infer<typeof SubstreamSqlInspectionInputSchema>;

export const SidekickSqlInspectionInputSchema = deferredZodSchema(() => SidekickInspectionInputSchema.unwrap().extend({
  authorityGeneration: AuthorityGenerationSchema,
  query: InspectionSqlRequestSchema,
}).strict());
export type SidekickSqlInspectionInput = z.infer<typeof SidekickSqlInspectionInputSchema>;

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

export const EngineeringWorkstreamTargetLookupSchema = deferredZodSchema(() => lookupResultSchema(
  EngineeringWorkstreamTargetSchema,
));
export type EngineeringWorkstreamTargetLookup = z.infer<
  typeof EngineeringWorkstreamTargetLookupSchema
>;

export const EngineeringSubstreamTargetLookupSchema = deferredZodSchema(() => lookupResultSchema(
  EngineeringSubstreamTargetSchema,
));
export type EngineeringSubstreamTargetLookup = z.infer<
  typeof EngineeringSubstreamTargetLookupSchema
>;

export const EngineeringSidekickTargetLookupSchema = deferredZodSchema(() => lookupResultSchema(
  EngineeringSidekickTargetSchema,
));
export type EngineeringSidekickTargetLookup = z.infer<
  typeof EngineeringSidekickTargetLookupSchema
>;

export const EngineeringArtifactTargetLookupSchema = deferredZodSchema(() => lookupResultSchema(
  EngineeringArtifactTargetSchema,
));
export type EngineeringArtifactTargetLookup = z.infer<
  typeof EngineeringArtifactTargetLookupSchema
>;

export const EngineeringSqlLookupSchema = deferredZodSchema(() => lookupResultSchema(z.strictObject({
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema.nullable(),
  substreamId: SubstreamIdSchema.nullable(),
  sidekickId: AutomationIdSchema.nullable(),
  artifactId: ArtifactIdSchema.nullable(),
  result: InspectionSqlResultSchema,
})));
export type EngineeringSqlLookup = z.infer<typeof EngineeringSqlLookupSchema>;

/** The named regional WorkerEntrypoint surface bound only to the engineering MCP Worker. */
export interface EngineeringInspectionRpcBinding {
  listWorkspaces(input: ListEngineeringWorkspacesInput): Promise<ListEngineeringWorkspacesResult>;
  listWorkstreams(input: WorkspaceInspectionInput): Promise<EngineeringWorkstreamListLookup>;
  listSubstreams(input: WorkstreamInspectionInput): Promise<EngineeringSubstreamListLookup>;
  listSidekicks(input: WorkspaceInspectionInput): Promise<EngineeringSidekickListLookup>;
  listArtifacts(input: WorkspaceInspectionInput): Promise<EngineeringArtifactListLookup>;
  resolveWorkspace(input: WorkspaceInspectionInput): Promise<EngineeringWorkspaceTargetLookup>;
  resolveWorkstream(input: WorkstreamInspectionInput): Promise<EngineeringWorkstreamTargetLookup>;
  resolveSubstream(input: SubstreamInspectionInput): Promise<EngineeringSubstreamTargetLookup>;
  resolveSidekick(input: SidekickInspectionInput): Promise<EngineeringSidekickTargetLookup>;
  resolveArtifact(input: ArtifactInspectionInput): Promise<EngineeringArtifactTargetLookup>;
  runWorkspaceSql(input: WorkspaceSqlInspectionInput): Promise<EngineeringSqlLookup>;
  runWorkstreamSql(input: WorkstreamSqlInspectionInput): Promise<EngineeringSqlLookup>;
  runSubstreamSql(input: SubstreamSqlInspectionInput): Promise<EngineeringSqlLookup>;
  runSidekickSql(input: SidekickSqlInspectionInput): Promise<EngineeringSqlLookup>;
  runArtifactSql(input: ArtifactSqlInspectionInput): Promise<EngineeringSqlLookup>;
}
