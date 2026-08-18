import { IdSchema } from "@avalon/contracts";
import { z } from "zod";

export const WORKSPACE_PRODUCT_IMPORT_STAGES = [
  "activity_events",
  "activity_event_targets",
  "opportunity_batch_windows",
  "opportunity_batch_events",
  "work_opportunities",
  "opportunity_provenance_nodes",
  "opportunity_provenance_edges",
  "work_opportunity_provenance_roots",
  "work_opportunity_user_links",
  "work_opportunity_user_states",
  "suggested_work_sets",
  "suggested_work_ranking_rounds",
  "work_opportunity_snapshots",
] as const;

export const WorkspaceProductImportStageSchema = z.enum(WORKSPACE_PRODUCT_IMPORT_STAGES);
const ScalarSchema = z.union([z.string(), z.number(), z.null()]);

export const WorkspaceProductImportRequestSchema = z.object({
  workspaceId: IdSchema,
  stage: WorkspaceProductImportStageSchema,
  rows: z.array(z.record(z.string(), ScalarSchema)).max(200),
}).strict();

export type WorkspaceProductImportStage = z.infer<typeof WorkspaceProductImportStageSchema>;
export type WorkspaceProductImportRequest = z.infer<typeof WorkspaceProductImportRequestSchema>;
export type WorkspaceProductImportRow = WorkspaceProductImportRequest["rows"][number];
