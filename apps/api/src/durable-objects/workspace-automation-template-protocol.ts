import { IdSchema } from "@rally/contracts";
import { z } from "zod";

/**
 * The workspace's automation template gallery, as questions rather than SQL.
 *
 * Templates and their immutable versions are the last automation tables
 * WorkspaceDO still owns — AutomationAgent took lifecycle, runs, schedules and
 * delivery — and the service reached them through the workspace runtime
 * facade, which routes by table name and sends anything it does not recognise
 * to the regional database.
 */

const TimestampSchema = z.string().datetime({ offset: true });
const JsonArraySchema = z.string().min(2);

export const WorkspaceAutomationTemplateVersionInputSchema = z.object({
  versionId: IdSchema,
  overview: z.string(),
  instructions: z.string(),
  triggerDefinitionsJson: JsonArraySchema,
  requiredCapabilitiesJson: JsonArraySchema,
  expectedOutputsJson: JsonArraySchema,
  defaultBehaviorJson: z.string().min(2),
  recommendedPluginsJson: JsonArraySchema,
  memoryTablesJson: JsonArraySchema,
  createdByUserId: IdSchema,
  at: TimestampSchema,
}).strict();

export const WorkspaceAutomationTemplatePublishRequestSchema = z.object({
  workspaceId: IdSchema,
  templateId: IdSchema,
  ownerUserId: IdSchema,
  name: z.string(),
  description: z.string(),
  version: WorkspaceAutomationTemplateVersionInputSchema,
}).strict();

export const WorkspaceAutomationTemplateVersionRequestSchema = z.object({
  workspaceId: IdSchema,
  templateId: IdSchema,
  /** Only the owner may add a version; the object fences on this, not the caller. */
  ownerUserId: IdSchema,
  version: WorkspaceAutomationTemplateVersionInputSchema,
}).strict();

/**
 * The new version's number, or that there was no template to add one to.
 *
 * The number is read and bumped inside one transaction. As a read followed by
 * a batched write it was two round trips, and two people adding a version at
 * once both read the same `latest_version_number` and both wrote it — which
 * `UNIQUE (template_id, version_number)` turned into a 500 for whichever lost.
 */
export const WorkspaceAutomationTemplateVersionResultSchema = z.object({
  outcome: z.enum(["added", "template_not_found"]),
  versionNumber: z.number().int().positive().nullable(),
}).strict();

export const WorkspaceAutomationTemplateSchema = z.object({
  id: IdSchema,
  ownerUserId: IdSchema.nullable(),
  name: z.string(),
  description: z.string(),
  latestVersionNumber: z.number().int().positive(),
  requiredCapabilitiesJson: z.string(),
  triggerDefinitionsJson: z.string(),
}).strict();

export const WorkspaceAutomationTemplateListSchema = z.object({
  items: z.array(WorkspaceAutomationTemplateSchema),
}).strict();

export type WorkspaceAutomationTemplatePublishRequest = z.infer<
  typeof WorkspaceAutomationTemplatePublishRequestSchema
>;
export type WorkspaceAutomationTemplateVersionRequest = z.infer<
  typeof WorkspaceAutomationTemplateVersionRequestSchema
>;
export type WorkspaceAutomationTemplateVersionResult = z.infer<
  typeof WorkspaceAutomationTemplateVersionResultSchema
>;
export type WorkspaceAutomationTemplateList = z.infer<typeof WorkspaceAutomationTemplateListSchema>;
