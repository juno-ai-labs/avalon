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

export const InspectionSqlRequestSchema = z.object({
  sql: z.string().min(1),
  bindings: z.array(InspectionSqlBindingSchema).default([]),
}).strict();
export type InspectionSqlRequest = z.infer<typeof InspectionSqlRequestSchema>;

export const InspectionSqlValueSchema = z.union([
  InspectionSqlBindingSchema,
  z.object({ type: z.literal("blob"), base64: z.string() }).strict(),
]);
export type InspectionSqlValue = z.infer<typeof InspectionSqlValueSchema>;

export const InspectionSqlResultSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), InspectionSqlValueSchema)),
  rowsRead: z.number().int().nonnegative(),
  rowsWritten: z.number().int().nonnegative(),
}).strict();
export type InspectionSqlResult = z.infer<typeof InspectionSqlResultSchema>;

export const EngineeringWorkspaceSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  name: z.string(),
  slug: z.string(),
  region: RegionSchema,
  placementAffinity: z.string(),
  authorityState: z.string().nullable(),
}).strict();
export type EngineeringWorkspace = z.infer<typeof EngineeringWorkspaceSchema>;

export const EngineeringWorkstreamSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  region: RegionSchema,
  title: z.string(),
  scope: z.string(),
  state: z.string(),
  systemKind: z.string().nullable(),
  lastActivityAt: z.number().int().nonnegative(),
  archivedAt: z.number().int().nonnegative().nullable(),
}).strict();
export type EngineeringWorkstream = z.infer<typeof EngineeringWorkstreamSchema>;

export const EngineeringSubstreamSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  substreamId: SubstreamIdSchema,
  region: RegionSchema,
}).strict();
export type EngineeringSubstream = z.infer<typeof EngineeringSubstreamSchema>;

export const ListEngineeringWorkspacesInputSchema = z.object({}).strict();
export type ListEngineeringWorkspacesInput = z.infer<typeof ListEngineeringWorkspacesInputSchema>;

export const ListEngineeringWorkspacesResultSchema = z.object({
  region: RegionSchema,
  items: z.array(EngineeringWorkspaceSchema),
}).strict();
export type ListEngineeringWorkspacesResult = z.infer<typeof ListEngineeringWorkspacesResultSchema>;

export const WorkspaceInspectionInputSchema = z.object({
  workspaceId: WorkspaceIdSchema,
}).strict();
export type WorkspaceInspectionInput = z.infer<typeof WorkspaceInspectionInputSchema>;

export const WorkstreamInspectionInputSchema = z.object({
  workstreamId: WorkstreamIdSchema,
}).strict();
export type WorkstreamInspectionInput = z.infer<typeof WorkstreamInspectionInputSchema>;

export const SubstreamInspectionInputSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  substreamId: SubstreamIdSchema,
}).strict();
export type SubstreamInspectionInput = z.infer<typeof SubstreamInspectionInputSchema>;

export const WorkspaceSqlInspectionInputSchema = WorkspaceInspectionInputSchema.extend({
  query: InspectionSqlRequestSchema,
}).strict();
export type WorkspaceSqlInspectionInput = z.infer<typeof WorkspaceSqlInspectionInputSchema>;

export const WorkstreamSqlInspectionInputSchema = WorkstreamInspectionInputSchema.extend({
  query: InspectionSqlRequestSchema,
}).strict();
export type WorkstreamSqlInspectionInput = z.infer<typeof WorkstreamSqlInspectionInputSchema>;

export const SubstreamSqlInspectionInputSchema = SubstreamInspectionInputSchema.extend({
  query: InspectionSqlRequestSchema,
}).strict();
export type SubstreamSqlInspectionInput = z.infer<typeof SubstreamSqlInspectionInputSchema>;

function lookupResultSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion("found", [
    z.object({ found: z.literal(false) }).strict(),
    z.object({ found: z.literal(true), value }).strict(),
  ]);
}

export const EngineeringWorkstreamListLookupSchema = lookupResultSchema(z.object({
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  items: z.array(EngineeringWorkstreamSchema),
}).strict());
export type EngineeringWorkstreamListLookup = z.infer<typeof EngineeringWorkstreamListLookupSchema>;

export const EngineeringSubstreamListLookupSchema = lookupResultSchema(z.object({
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  items: z.array(EngineeringSubstreamSchema),
}).strict());
export type EngineeringSubstreamListLookup = z.infer<typeof EngineeringSubstreamListLookupSchema>;

export const EngineeringSqlLookupSchema = lookupResultSchema(z.object({
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema.nullable(),
  substreamId: SubstreamIdSchema.nullable(),
  result: InspectionSqlResultSchema,
}).strict());
export type EngineeringSqlLookup = z.infer<typeof EngineeringSqlLookupSchema>;

/** The named regional WorkerEntrypoint surface bound only to the engineering MCP Worker. */
export interface EngineeringInspectionRpcBinding {
  listWorkspaces(input: ListEngineeringWorkspacesInput): Promise<ListEngineeringWorkspacesResult>;
  listWorkstreams(input: WorkspaceInspectionInput): Promise<EngineeringWorkstreamListLookup>;
  listSubstreams(input: WorkstreamInspectionInput): Promise<EngineeringSubstreamListLookup>;
  runWorkspaceSql(input: WorkspaceSqlInspectionInput): Promise<EngineeringSqlLookup>;
  runWorkstreamSql(input: WorkstreamSqlInspectionInput): Promise<EngineeringSqlLookup>;
  runSubstreamSql(input: SubstreamSqlInspectionInput): Promise<EngineeringSqlLookup>;
}
