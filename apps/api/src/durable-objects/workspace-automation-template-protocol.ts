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

export const WorkspaceAutomationTemplateVersionInputSchema = z.strictObject({
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
});

export const WorkspaceAutomationTemplatePublishRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  templateId: IdSchema,
  ownerUserId: IdSchema,
  name: z.string(),
  description: z.string(),
  version: WorkspaceAutomationTemplateVersionInputSchema,
});

/**
 * Does this person own an active template with this id?
 *
 * Asked before the draft's connectors are validated, so a template that is
 * missing, archived, or somebody else's answers 404 rather than a connector
 * error. The write below fences on ownership again — this preflight decides
 * what a caller is told, not what they are allowed to write.
 */
export const WorkspaceAutomationTemplateOwnershipRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  templateId: IdSchema,
  ownerUserId: IdSchema,
});

export const WorkspaceAutomationTemplateOwnershipSchema = z.strictObject({
  owned: z.boolean(),
});

export const WorkspaceAutomationTemplateVersionRequestSchema = z.strictObject({
  workspaceId: IdSchema,
  templateId: IdSchema,
  /** Only the owner may add a version; the object fences on this, not the caller. */
  ownerUserId: IdSchema,
  version: WorkspaceAutomationTemplateVersionInputSchema,
});

/**
 * The new version's number, or that there was no template to add one to.
 *
 * A union rather than a number beside an outcome, so `added` without a number
 * is unrepresentable: the pairing is a fact, and a storage bug that broke it
 * should fail at this parse rather than reach a response as a null typed as a
 * number.
 *
 * What ended the version-number race is that the read and the bump became one
 * RPC. They were a read here and a batch afterwards, so two people adding a
 * version at once both read the same `latest_version_number` and both wrote it,
 * and `UNIQUE (template_id, version_number)` turned that into a 500 for
 * whichever lost.
 */
export const WorkspaceAutomationTemplateVersionResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("added"),
    versionNumber: z.number().int().positive(),
  }),
  z.strictObject({ outcome: z.literal("template_not_found") }),
]);

export const WorkspaceAutomationTemplateSchema = z.strictObject({
  id: IdSchema,
  ownerUserId: IdSchema.nullable(),
  name: z.string(),
  description: z.string(),
  latestVersionNumber: z.number().int().positive(),
  requiredCapabilitiesJson: z.string(),
  triggerDefinitionsJson: z.string(),
});

export const WorkspaceAutomationTemplateListSchema = z.strictObject({
  items: z.array(WorkspaceAutomationTemplateSchema),
});

export type WorkspaceAutomationTemplatePublishRequest = z.infer<
  typeof WorkspaceAutomationTemplatePublishRequestSchema
>;
export type WorkspaceAutomationTemplateOwnershipRequest = z.infer<
  typeof WorkspaceAutomationTemplateOwnershipRequestSchema
>;
export type WorkspaceAutomationTemplateOwnership = z.infer<
  typeof WorkspaceAutomationTemplateOwnershipSchema
>;
export type WorkspaceAutomationTemplateVersionRequest = z.infer<
  typeof WorkspaceAutomationTemplateVersionRequestSchema
>;
export type WorkspaceAutomationTemplateVersionResult = z.infer<
  typeof WorkspaceAutomationTemplateVersionResultSchema
>;
export type WorkspaceAutomationTemplateList = z.infer<typeof WorkspaceAutomationTemplateListSchema>;
