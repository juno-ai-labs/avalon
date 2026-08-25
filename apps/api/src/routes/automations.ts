import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { zValidator } from "../middleware/validation";
import {
  AutomationDeliveryTargetSetSchema,
  AutomationDetailSchema,
  AutomationDraftSchema,
  AutomationDraftStateSchema,
  AutomationDraftStreamEventSchema,
  AutomationRunSchema,
  AutomationSummarySchema,
  ActivitySourceBindingKeySchema,
  ActivitySourcePluginIdsSchema,
  CompileAutomationRequestSchema,
  CreateAutomationRequestSchema,
  IdSchema,
  ModelPluginIdSchema,
  TimestampSchema,
  WorkstreamSchema,
} from "@rally/contracts";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { ApiError } from "../lib/api-error";
import { getAuth } from "../middleware/auth";
import { logEvent } from "../observability/logger";
import { AutomationService } from "../services/automation-service";

const idParam = z.object({ id: IdSchema });
const runHeaders = z.object({ "idempotency-key": z.string().min(8).max(120) });
const updateBody = z.object({ name: z.string().min(1).max(140).optional(), description: z.string().min(1).max(1200).optional(), instructions: z.string().min(1).max(12_000).optional(), defaultPluginIds: z.array(ModelPluginIdSchema).optional(), activitySourcePluginIds: ActivitySourcePluginIdsSchema.optional(), overrides: z.record(z.string(), z.unknown()).optional(), deliveryTargets: AutomationDeliveryTargetSetSchema.optional() });

/** Envelopes this route composes; the entities inside come from the contracts. */
const AutomationPageSchema = z.object({ items: z.array(AutomationSummarySchema) });
/** The non-streaming twin of the stream's `completed` event, down to the id of
 * the draft subscription the turn wrote. */
const CompiledDraftSchema = z.object({
  draftId: IdSchema,
  elicitationId: IdSchema.nullable().default(null),
  elicitationPresentedAt: TimestampSchema.nullable().default(null),
  draft: AutomationDraftSchema,
  assistantMessage: z.string().min(1),
});
const AutomationRunPageSchema = z.object({ items: z.array(AutomationRunSchema) });
const NextRunSchema = z.object({
  /** Null when the automation is paused or has no enabled schedule. */
  scheduledFor: TimestampSchema.nullable(),
  workstream: WorkstreamSchema.nullable(),
  automation: z.string(),
});
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
const SharedSubscriptionSchema = z.object({ templateId: IdSchema });
const TemplateVersionSchema = z.object({ id: IdSchema, versionNumber: z.number().int().positive() });

export const automationRoutes = new Hono<HonoAppEnv>();
automationRoutes.get("/", async (c) =>
  c.json(AutomationPageSchema.parse(await new AutomationService(c.env, getAuth(c)).list())));
automationRoutes.post("/draft/stream", zValidator("json", CompileAutomationRequestSchema), async (c) => {
  const input = c.req.valid("json");
  const requestId = c.get("requestId");
  const service = new AutomationService(c.env, getAuth(c));
  logEvent(c, "info", "automation_draft_compile_started", { draft_id: input.draftId });
  return streamSSE(c, async (stream) => {
    try {
      const compiled = await service.compile(input, requestId, {
        signal: c.req.raw.signal,
        onStreamEvent: async (event) => {
          if (event.type === "completed") return;
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(AutomationDraftStreamEventSchema.parse(event)),
          });
        },
      });
      const completed = AutomationDraftStreamEventSchema.parse({
        type: "completed",
        draftId: compiled.draftId,
        elicitationId: compiled.elicitationId,
        elicitationPresentedAt: compiled.elicitationPresentedAt,
        draft: compiled.draft,
        assistantMessage: compiled.assistantMessage,
      });
      await stream.writeSSE({ event: completed.type, data: JSON.stringify(completed) });
    } catch (error) {
      const apiError = error instanceof ApiError
        ? error
        : new ApiError(500, "internal_error", "An unexpected error occurred");
      const failed = AutomationDraftStreamEventSchema.parse({
        type: "error",
        error: {
          status: apiError.status,
          code: apiError.code,
          message: apiError.message,
          requestId,
          ...(apiError.details ? { details: apiError.details } : {}),
        },
      });
      await stream.writeSSE({ event: failed.type, data: JSON.stringify(failed) });
    }
  });
});
automationRoutes.post("/draft", zValidator("json", CompileAutomationRequestSchema), async (c) => {
  const input = c.req.valid("json");
  logEvent(c, "info", "automation_draft_compile_started", { draft_id: input.draftId });
  const compiled = await new AutomationService(c.env, getAuth(c)).compile(input, c.get("requestId"));
  return c.json(CompiledDraftSchema.parse({
    draftId: compiled.draftId,
    elicitationId: compiled.elicitationId,
    elicitationPresentedAt: compiled.elicitationPresentedAt,
    draft: AutomationDraftSchema.parse(compiled.draft),
    assistantMessage: compiled.assistantMessage,
  }));
});
automationRoutes.get("/:id/draft", zValidator("param", idParam), async (c) =>
  c.json(AutomationDraftStateSchema.parse(
    await new AutomationService(c.env, getAuth(c)).draftState(c.req.valid("param").id))));
automationRoutes.post("/", zValidator("json", CreateAutomationRequestSchema), async (c) =>
  c.json(AutomationDetailSchema.parse(await new AutomationService(c.env, getAuth(c)).create(c.req.valid("json"))), 201));
automationRoutes.get("/:id", zValidator("param", idParam), async (c) =>
  c.json(AutomationDetailSchema.parse(await new AutomationService(c.env, getAuth(c)).get(c.req.valid("param").id))));
automationRoutes.patch("/:id", zValidator("param", idParam), zValidator("json", updateBody), async (c) =>
  c.json(AutomationDetailSchema.parse(
    await new AutomationService(c.env, getAuth(c)).update(c.req.valid("param").id, c.req.valid("json")))));
automationRoutes.post("/:id/run", zValidator("param", idParam), zValidator("header", runHeaders), async (c) => c.json(
  StartedRunSchema.parse(await new AutomationService(c.env, getAuth(c)).runNow(
    c.req.valid("param").id,
    c.req.valid("header")["idempotency-key"],
  )),
  202,
));
automationRoutes.post("/:id/pause", zValidator("param", idParam), async (c) => { await new AutomationService(c.env, getAuth(c)).setPaused(c.req.valid("param").id, true); return c.body(null, 204); });
automationRoutes.post("/:id/resume", zValidator("param", idParam), async (c) => { await new AutomationService(c.env, getAuth(c)).setPaused(c.req.valid("param").id, false); return c.body(null, 204); });
automationRoutes.post("/:id/archive", zValidator("param", idParam), async (c) => { await new AutomationService(c.env, getAuth(c)).archiveDraft(c.req.valid("param").id); return c.body(null, 204); });
automationRoutes.delete("/:id", zValidator("param", idParam), async (c) => { await new AutomationService(c.env, getAuth(c)).deleteAutomation(c.req.valid("param").id); return c.body(null, 204); });
automationRoutes.get("/:id/runs", zValidator("param", idParam), async (c) =>
  c.json(AutomationRunPageSchema.parse(await new AutomationService(c.env, getAuth(c)).runs(c.req.valid("param").id))));
automationRoutes.get("/:id/next-run", zValidator("param", idParam), async (c) =>
  c.json(NextRunSchema.parse(await new AutomationService(c.env, getAuth(c)).nextRun(c.req.valid("param").id))));
automationRoutes.post("/:id/next-run/open", zValidator("param", idParam), async (c) =>
  c.json(StartedRunSchema.parse(await new AutomationService(c.env, getAuth(c)).openNextRun(c.req.valid("param").id)), 201));

const templateParam = z.object({ id: IdSchema });
const versionBody = z.object({ draft: AutomationDraftSchema });
const subscribeBody = z.object({ defaultPluginIds: z.array(ModelPluginIdSchema).default([]), activitySourcePluginIds: ActivitySourcePluginIdsSchema.default({}) });
const adoptParam = z.object({ id: IdSchema });
const adoptBody = z.object({ versionId: IdSchema, activitySourcePluginIds: ActivitySourcePluginIdsSchema.optional() });

export const templateRoutes = new Hono<HonoAppEnv>();
templateRoutes.get("/", async (c) =>
  c.json(TemplatePageSchema.parse(await new AutomationService(c.env, getAuth(c)).listTemplates())));
const publishTemplateBody = z.union([
  z.object({ automationSubscriptionId: IdSchema }),
  z.object({ name: z.string().min(1).max(140), description: z.string().min(1).max(1_200), draft: AutomationDraftSchema }),
]);
templateRoutes.post("/", zValidator("json", publishTemplateBody), async (c) => {
  const body = c.req.valid("json");
  const service = new AutomationService(c.env, getAuth(c));
  if ("automationSubscriptionId" in body) {
    return c.json(SharedSubscriptionSchema.parse(await service.shareSubscription(body.automationSubscriptionId)), 201);
  }
  const created = await service.publishTemplate(body);
  return c.json(PublishedTemplateSchema.parse({ templateId: created.id, latestVersionId: created.latestVersionId }), 201);
});
templateRoutes.post("/:id/versions", zValidator("param", templateParam), zValidator("json", versionBody), async (c) =>
  c.json(TemplateVersionSchema.parse(
    await new AutomationService(c.env, getAuth(c)).addTemplateVersion(c.req.valid("param").id, c.req.valid("json").draft)), 201));
templateRoutes.post("/:id/subscribe", zValidator("param", templateParam), zValidator("json", subscribeBody), async (c) =>
  c.json(AutomationDetailSchema.parse(
    await new AutomationService(c.env, getAuth(c)).subscribe(c.req.valid("param").id, c.req.valid("json"))), 201));

export const subscriptionRoutes = new Hono<HonoAppEnv>();
subscriptionRoutes.post("/:id/adopt-version", zValidator("param", adoptParam), zValidator("json", adoptBody), async (c) => {
  const body = c.req.valid("json");
  return c.json(AutomationDetailSchema.parse(await new AutomationService(c.env, getAuth(c)).adoptVersion(
    c.req.valid("param").id,
    body.versionId,
    body.activitySourcePluginIds,
  )));
});
