import { z } from "zod";

import { RegionSchema } from "./index";
import {
  SubstreamIdSchema,
  WorkspaceIdSchema,
  WorkstreamIdSchema,
} from "./identifiers";

export const InspectionSqlBindingSchema = z.union([
  z.string(),
  z.number().finite(),
  z.null(),
]);
export type InspectionSqlBinding = z.infer<typeof InspectionSqlBindingSchema>;

export const InspectionSqlRequestSchema = z.strictObject({
  sql: z.string().min(1),
  bindings: z.array(InspectionSqlBindingSchema).default([]),
});
export type InspectionSqlRequest = z.infer<typeof InspectionSqlRequestSchema>;

export const InspectionSqlValueSchema = z.union([
  InspectionSqlBindingSchema,
  z.strictObject({ type: z.literal("blob"), base64: z.string() }),
]);
export type InspectionSqlValue = z.infer<typeof InspectionSqlValueSchema>;

export const InspectionSqlResultSchema = z.strictObject({
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), InspectionSqlValueSchema)),
  rowsRead: z.number().int().nonnegative(),
  rowsWritten: z.number().int().nonnegative(),
});
export type InspectionSqlResult = z.infer<typeof InspectionSqlResultSchema>;

export const EngineeringWorkspaceSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  name: z.string(),
  slug: z.string(),
  region: RegionSchema,
  placementAffinity: z.string(),
  authorityState: z.string().nullable(),
});
export type EngineeringWorkspace = z.infer<typeof EngineeringWorkspaceSchema>;

export const EngineeringWorkstreamSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  region: RegionSchema,
  title: z.string(),
  scope: z.string(),
  state: z.string(),
  systemKind: z.string().nullable(),
  lastActivityAt: z.number().int().nonnegative(),
  archivedAt: z.number().int().nonnegative().nullable(),
});
export type EngineeringWorkstream = z.infer<typeof EngineeringWorkstreamSchema>;

export const EngineeringSubstreamSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  substreamId: SubstreamIdSchema,
  region: RegionSchema,
});
export type EngineeringSubstream = z.infer<typeof EngineeringSubstreamSchema>;

export const ListEngineeringWorkspacesInputSchema = z.strictObject({});
export type ListEngineeringWorkspacesInput = z.infer<typeof ListEngineeringWorkspacesInputSchema>;

export const ListEngineeringWorkspacesResultSchema = z.strictObject({
  region: RegionSchema,
  items: z.array(EngineeringWorkspaceSchema),
});
export type ListEngineeringWorkspacesResult = z.infer<typeof ListEngineeringWorkspacesResultSchema>;

export const WorkspaceInspectionInputSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
});
export type WorkspaceInspectionInput = z.infer<typeof WorkspaceInspectionInputSchema>;

export const WorkstreamInspectionInputSchema = z.strictObject({
  workstreamId: WorkstreamIdSchema,
});
export type WorkstreamInspectionInput = z.infer<typeof WorkstreamInspectionInputSchema>;

export const SubstreamInspectionInputSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  substreamId: SubstreamIdSchema,
});
export type SubstreamInspectionInput = z.infer<typeof SubstreamInspectionInputSchema>;

const AuthorityGenerationSchema = z.number().int().positive();

export const EngineeringWorkspaceTargetSchema = z.strictObject({
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  authorityGeneration: AuthorityGenerationSchema,
});
export type EngineeringWorkspaceTarget = z.infer<typeof EngineeringWorkspaceTargetSchema>;

export const EngineeringWorkstreamTargetSchema = EngineeringWorkspaceTargetSchema.extend({
  workstreamId: WorkstreamIdSchema,
}).strict();
export type EngineeringWorkstreamTarget = z.infer<typeof EngineeringWorkstreamTargetSchema>;

export const EngineeringSubstreamTargetSchema = EngineeringWorkstreamTargetSchema.extend({
  substreamId: SubstreamIdSchema,
}).strict();
export type EngineeringSubstreamTarget = z.infer<typeof EngineeringSubstreamTargetSchema>;

export const WorkspaceSqlInspectionInputSchema = WorkspaceInspectionInputSchema.extend({
  authorityGeneration: AuthorityGenerationSchema,
  query: InspectionSqlRequestSchema,
}).strict();
export type WorkspaceSqlInspectionInput = z.infer<typeof WorkspaceSqlInspectionInputSchema>;

export const WorkstreamSqlInspectionInputSchema = WorkstreamInspectionInputSchema.extend({
  authorityGeneration: AuthorityGenerationSchema,
  query: InspectionSqlRequestSchema,
}).strict();
export type WorkstreamSqlInspectionInput = z.infer<typeof WorkstreamSqlInspectionInputSchema>;

export const SubstreamSqlInspectionInputSchema = SubstreamInspectionInputSchema.extend({
  authorityGeneration: AuthorityGenerationSchema,
  query: InspectionSqlRequestSchema,
}).strict();
export type SubstreamSqlInspectionInput = z.infer<typeof SubstreamSqlInspectionInputSchema>;

function lookupResultSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion("found", [
    z.strictObject({ found: z.literal(false) }),
    z.strictObject({ found: z.literal(true), value }),
  ]);
}

export const EngineeringWorkstreamListLookupSchema = lookupResultSchema(z.strictObject({
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  items: z.array(EngineeringWorkstreamSchema),
}));
export type EngineeringWorkstreamListLookup = z.infer<typeof EngineeringWorkstreamListLookupSchema>;

export const EngineeringSubstreamListLookupSchema = lookupResultSchema(z.strictObject({
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  items: z.array(EngineeringSubstreamSchema),
}));
export type EngineeringSubstreamListLookup = z.infer<typeof EngineeringSubstreamListLookupSchema>;

export const EngineeringWorkspaceTargetLookupSchema = lookupResultSchema(
  EngineeringWorkspaceTargetSchema,
);
export type EngineeringWorkspaceTargetLookup = z.infer<
  typeof EngineeringWorkspaceTargetLookupSchema
>;

export const EngineeringWorkstreamTargetLookupSchema = lookupResultSchema(
  EngineeringWorkstreamTargetSchema,
);
export type EngineeringWorkstreamTargetLookup = z.infer<
  typeof EngineeringWorkstreamTargetLookupSchema
>;

export const EngineeringSubstreamTargetLookupSchema = lookupResultSchema(
  EngineeringSubstreamTargetSchema,
);
export type EngineeringSubstreamTargetLookup = z.infer<
  typeof EngineeringSubstreamTargetLookupSchema
>;

export const EngineeringSqlLookupSchema = lookupResultSchema(z.strictObject({
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema.nullable(),
  substreamId: SubstreamIdSchema.nullable(),
  result: InspectionSqlResultSchema,
}));
export type EngineeringSqlLookup = z.infer<typeof EngineeringSqlLookupSchema>;

/** The named regional WorkerEntrypoint surface bound only to the engineering MCP Worker. */
export interface EngineeringInspectionRpcBinding {
  listWorkspaces(input: ListEngineeringWorkspacesInput): Promise<ListEngineeringWorkspacesResult>;
  listWorkstreams(input: WorkspaceInspectionInput): Promise<EngineeringWorkstreamListLookup>;
  listSubstreams(input: WorkstreamInspectionInput): Promise<EngineeringSubstreamListLookup>;
  resolveWorkspace(input: WorkspaceInspectionInput): Promise<EngineeringWorkspaceTargetLookup>;
  resolveWorkstream(input: WorkstreamInspectionInput): Promise<EngineeringWorkstreamTargetLookup>;
  resolveSubstream(input: SubstreamInspectionInput): Promise<EngineeringSubstreamTargetLookup>;
  runWorkspaceSql(input: WorkspaceSqlInspectionInput): Promise<EngineeringSqlLookup>;
  runWorkstreamSql(input: WorkstreamSqlInspectionInput): Promise<EngineeringSqlLookup>;
  runSubstreamSql(input: SubstreamSqlInspectionInput): Promise<EngineeringSqlLookup>;
}
