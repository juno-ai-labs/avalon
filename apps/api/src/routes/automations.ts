import { Hono } from "hono";
import { zValidator } from "../middleware/validation";
import {
  AutomationDeliveryTargetSetSchema,
  AutomationDetailSchema,
  AutomationDraftSchema,
  AutomationAgentSnapshotSchema,
  AutomationDraftTurnAdmissionResultSchema,
  AutomationRunSchema,
  AutomationSummarySchema,
  WorkstreamAutomationSummarySchema,
  ActivitySourceBindingKeySchema,
  CreateAutomationRequestSchema,
  IdSchema,
  ModelPluginIdSchema,
} from "@rally/contracts";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { getAuth } from "../middleware/auth";
import { AutomationService } from "../services/automation-service";
import {
  AutomationAgentService,
  AutomationDraftTurnRequestSchema,
} from "../services/automation-agent-service";

const idParam = z.object({ id: IdSchema });
const runHeaders = z.object({ "idempotency-key": z.string().min(8).max(120) });
const updateBody = z.strictObject({ deliveryTargets: AutomationDeliveryTargetSetSchema });
const AutomationSocketTicketSchema = z.strictObject({ url: z.string().min(1), ticket: z.string().min(1) });
const SharedTemplateSchema = z.strictObject({ templateId: IdSchema });

/** Envelopes this route composes; the entities inside come from the contracts. */
const AutomationPageSchema = z.object({ items: z.array(AutomationSummarySchema) });
const WorkstreamAutomationPageSchema = z.object({
  items: z.array(WorkstreamAutomationSummarySchema),
});
const AutomationRunPageSchema = z.object({ items: z.array(AutomationRunSchema) });
const StartedRunSchema = z.object({
  runId: IdSchema,
  workstreamId: IdSchema,
  harnessRunId: IdSchema.optional(),
  reused: z.boolean(),
});
/**
 * One connector an installer has to bind before a template can run — the shape
 * `AutomationService.listTemplates` derives from a version's stored triggers.
 *
 * This is deliberately not `ConnectorActivityTriggerDescriptorSchema`, which
 * names a *connector manifest's* event type (`eventType`, `label`,
 * `digestible`) and shares no field with a binding. Declaring that one here
 * failed the whole page's parse — a 500 for the entire catalog — the moment any
 * shared template carried an activity or webhook trigger.
 *
 * Each field is bounded by the same schema the write path already enforced:
 * `TriggerDefinitionSchema` validates `sourceBindingKey` and
 * `suggestedSourcePluginId` when a version is published, so the read boundary
 * can restate them without being able to reject a row publishing accepted.
 */
const TemplateActivitySourceSchema = z.object({
  bindingKey: ActivitySourceBindingKeySchema,
  connectorType: z.string().min(1),
  suggestedPluginId: ModelPluginIdSchema.optional(),
});
const TemplatePageSchema = z.object({
  items: z.array(z.object({
    id: IdSchema,
    name: z.string(),
    // Not nullable: the service coalesces a missing owner name to
    // "Unknown member", and the desktop parses this field as a plain string —
    // so a contract that permits `null` here licenses a change that would fail
    // the client's parse of the whole page. Same defect as the one below,
    // pointed the other way across the same wire.
    author: z.string(),
    description: z.string(),
    usedBy: z.number().int().nonnegative(),
    requiredCapabilities: z.array(z.string()),
    latestVersion: z.number().int().positive(),
    activitySources: z.array(TemplateActivitySourceSchema),
  })),
});
const PublishedTemplateSchema = z.object({ templateId: IdSchema, latestVersionId: IdSchema });
const TemplateVersionSchema = z.object({ id: IdSchema, versionNumber: z.number().int().positive() });

export const automationRoutes = new Hono<HonoAppEnv>();
automationRoutes.get("/", async (c) =>
  c.json(AutomationPageSchema.parse(await new AutomationAgentService(c.env, getAuth(c)).list())));
// A room's automations, for its rail. Under /automations rather than under the
// work stream: the resource is the automation, and the work stream is which
// ones — the same relationship the workspace list has to the workspace.
automationRoutes.get("/workstream/:workstreamId", zValidator("param", z.object({
  workstreamId: IdSchema,
})), async (c) => c.json(WorkstreamAutomationPageSchema.parse(
  await new AutomationAgentService(c.env, getAuth(c))
    .listForWorkstream(c.req.valid("param").workstreamId),
)));
automationRoutes.post("/agent/draft/turn", zValidator("json", AutomationDraftTurnRequestSchema.extend({
  clientCreationKey: IdSchema,
})), async (c) => c.json(AutomationDraftTurnAdmissionResultSchema.parse(
  await new AutomationAgentService(c.env, getAuth(c)).admitFirstTurn(c.req.valid("json")),
), 202));
automationRoutes.post("/:id/agent/draft/turn", zValidator("param", idParam),
  zValidator("json", AutomationDraftTurnRequestSchema), async (c) => c.json(
    AutomationDraftTurnAdmissionResultSchema.parse(await new AutomationAgentService(c.env, getAuth(c)).admitTurn(
      c.req.valid("param").id,
      c.req.valid("json"),
    )),
    202,
  ));
automationRoutes.get("/:id/agent/draft", zValidator("param", idParam), async (c) => c.json(
  AutomationAgentSnapshotSchema.parse(
    await new AutomationAgentService(c.env, getAuth(c)).snapshot(c.req.valid("param").id),
  ),
));
automationRoutes.post("/:id/agent/draft/:runId/stop", zValidator("param", z.strictObject({
  id: IdSchema,
  runId: IdSchema,
})), async (c) => {
  const params = c.req.valid("param");
  await new AutomationAgentService(c.env, getAuth(c)).cancel(params.id, params.runId);
  return c.body(null, 204);
});
automationRoutes.post("/:id/agent/draft/:runId/retry", zValidator("param", z.strictObject({
  id: IdSchema,
  runId: IdSchema,
})), async (c) => {
  const params = c.req.valid("param");
  await new AutomationAgentService(c.env, getAuth(c)).retry(params.id, params.runId);
  return c.body(null, 204);
});
automationRoutes.get("/:id/agent/socket", zValidator("param", idParam), async (c) =>
  c.json(AutomationSocketTicketSchema.parse(
    await new AutomationAgentService(c.env, getAuth(c)).socketTicket(c.req.valid("param").id),
  )));
automationRoutes.post("/", zValidator("json", CreateAutomationRequestSchema), async (c) => {
  const input = c.req.valid("json");
  const detail = await new AutomationAgentService(c.env, getAuth(c)).accept(input);
  return c.json(AutomationDetailSchema.parse(detail), 201);
});
automationRoutes.get("/:id", zValidator("param", idParam), async (c) =>
  c.json(AutomationDetailSchema.parse(
    await new AutomationAgentService(c.env, getAuth(c)).detail(c.req.valid("param").id),
  )));
automationRoutes.patch("/:id", zValidator("param", idParam), zValidator("json", updateBody), async (c) =>
  c.json(AutomationDetailSchema.parse(
    await new AutomationAgentService(c.env, getAuth(c)).updateDeliveryTargets(
      c.req.valid("param").id,
      c.req.valid("json").deliveryTargets,
    ))));
automationRoutes.post("/:id/run", zValidator("param", idParam), zValidator("header", runHeaders), async (c) => c.json(
  StartedRunSchema.parse(await new AutomationAgentService(c.env, getAuth(c)).runNow(
    c.req.valid("param").id,
    c.req.valid("header")["idempotency-key"],
  )),
  202,
));
automationRoutes.post("/:id/pause", zValidator("param", idParam), async (c) => { await new AutomationAgentService(c.env, getAuth(c)).pause(c.req.valid("param").id); return c.body(null, 204); });
automationRoutes.post("/:id/resume", zValidator("param", idParam), async (c) => { await new AutomationAgentService(c.env, getAuth(c)).resume(c.req.valid("param").id); return c.body(null, 204); });
automationRoutes.delete("/:id", zValidator("param", idParam), async (c) => { await new AutomationAgentService(c.env, getAuth(c)).delete(c.req.valid("param").id); return c.body(null, 204); });
automationRoutes.get("/:id/runs", zValidator("param", idParam), async (c) =>
  c.json(AutomationRunPageSchema.parse(await new AutomationAgentService(c.env, getAuth(c)).runs(c.req.valid("param").id))));

const templateParam = z.object({ id: IdSchema });
const versionBody = z.object({ draft: AutomationDraftSchema });
export const templateRoutes = new Hono<HonoAppEnv>();
templateRoutes.get("/", async (c) =>
  c.json(TemplatePageSchema.parse(await new AutomationService(c.env, getAuth(c)).listTemplates())));
const publishTemplateBody = z.union([
  z.strictObject({ automationSubscriptionId: IdSchema }),
  z.strictObject({
    name: z.string().min(1).max(140),
    description: z.string().min(1).max(1_200),
    draft: AutomationDraftSchema,
  }),
]);
templateRoutes.post("/", zValidator("json", publishTemplateBody), async (c) => {
  const body = c.req.valid("json");
  if ("automationSubscriptionId" in body) {
    return c.json(SharedTemplateSchema.parse(
      await new AutomationAgentService(c.env, getAuth(c)).share(body.automationSubscriptionId),
    ), 201);
  }
  const service = new AutomationService(c.env, getAuth(c));
  const created = await service.publishTemplate(body);
  return c.json(PublishedTemplateSchema.parse({ templateId: created.id, latestVersionId: created.latestVersionId }), 201);
});
templateRoutes.post("/:id/versions", zValidator("param", templateParam), zValidator("json", versionBody), async (c) =>
  c.json(TemplateVersionSchema.parse(
    await new AutomationService(c.env, getAuth(c)).addTemplateVersion(c.req.valid("param").id, c.req.valid("json").draft)), 201));
