import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { zValidator } from "../middleware/validation";
import {
  AutomationDraftSchema,
  AutomationDraftStreamEventSchema,
  ActivitySourcePluginIdsSchema,
  CompileAutomationRequestSchema,
  CreateAutomationRequestSchema,
  IdSchema,
  ModelPluginIdSchema,
} from "@avalon/contracts";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { ApiError } from "../lib/api-error";
import { getAuth } from "../middleware/auth";
import { logEvent } from "../observability/logger";
import { AutomationService } from "../services/automation-service";

const idParam = z.object({ id: IdSchema });
const runHeaders = z.object({ "idempotency-key": z.string().min(8).max(120) });
const updateBody = z.object({ name: z.string().min(1).max(140).optional(), description: z.string().min(1).max(1200).optional(), instructions: z.string().min(1).max(12_000).optional(), defaultPluginIds: z.array(ModelPluginIdSchema).optional(), activitySourcePluginIds: ActivitySourcePluginIdsSchema.optional(), overrides: z.record(z.string(), z.unknown()).optional() });

export const automationRoutes = new Hono<HonoAppEnv>();
automationRoutes.get("/", async (c) => c.json(await new AutomationService(c.env, getAuth(c)).list()));
automationRoutes.post("/draft/stream", zValidator("json", CompileAutomationRequestSchema), async (c) => {
  const input = c.req.valid("json");
  const requestId = c.get("requestId");
  const service = new AutomationService(c.env, getAuth(c));
  logEvent(c, "info", "automation_draft_compile_started", { draft_id: input.draftId });
  return streamSSE(c, async (stream) => {
    try {
      const draft = await service.compile(input, requestId, {
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
        draft,
        assistantMessage: draft.elicitation?.prompt
          ?? draft.followUpQuestion
          ?? (draft.ready ? "The automation is ready to create." : "I need one more detail before I can create this automation."),
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
  return c.json(await new AutomationService(c.env, getAuth(c)).compile(input, c.get("requestId")));
});
automationRoutes.post("/", zValidator("json", CreateAutomationRequestSchema), async (c) => c.json(await new AutomationService(c.env, getAuth(c)).create(c.req.valid("json")), 201));
automationRoutes.get("/:id", zValidator("param", idParam), async (c) => c.json(await new AutomationService(c.env, getAuth(c)).get(c.req.valid("param").id)));
automationRoutes.patch("/:id", zValidator("param", idParam), zValidator("json", updateBody), async (c) => c.json(await new AutomationService(c.env, getAuth(c)).update(c.req.valid("param").id, c.req.valid("json"))));
automationRoutes.post("/:id/run", zValidator("param", idParam), zValidator("header", runHeaders), async (c) => c.json(
  await new AutomationService(c.env, getAuth(c)).runNow(
    c.req.valid("param").id,
    c.req.valid("header")["idempotency-key"],
  ),
  202,
));
automationRoutes.post("/:id/pause", zValidator("param", idParam), async (c) => { await new AutomationService(c.env, getAuth(c)).setPaused(c.req.valid("param").id, true); return c.body(null, 204); });
automationRoutes.post("/:id/resume", zValidator("param", idParam), async (c) => { await new AutomationService(c.env, getAuth(c)).setPaused(c.req.valid("param").id, false); return c.body(null, 204); });
automationRoutes.get("/:id/runs", zValidator("param", idParam), async (c) => c.json(await new AutomationService(c.env, getAuth(c)).runs(c.req.valid("param").id)));
automationRoutes.get("/:id/next-run", zValidator("param", idParam), async (c) => c.json(await new AutomationService(c.env, getAuth(c)).nextRun(c.req.valid("param").id)));
automationRoutes.post("/:id/next-run/open", zValidator("param", idParam), async (c) => c.json(await new AutomationService(c.env, getAuth(c)).openNextRun(c.req.valid("param").id), 201));

const templateParam = z.object({ id: IdSchema });
const versionBody = z.object({ draft: AutomationDraftSchema });
const subscribeBody = z.object({ defaultPluginIds: z.array(ModelPluginIdSchema).default([]), activitySourcePluginIds: ActivitySourcePluginIdsSchema.default({}) });
const adoptParam = z.object({ id: IdSchema });
const adoptBody = z.object({ versionId: IdSchema, activitySourcePluginIds: ActivitySourcePluginIdsSchema.optional() });

export const templateRoutes = new Hono<HonoAppEnv>();
templateRoutes.get("/", async (c) => c.json(await new AutomationService(c.env, getAuth(c)).listTemplates()));
const publishTemplateBody = z.union([
  z.object({ automationSubscriptionId: IdSchema }),
  z.object({ name: z.string().min(1).max(140), description: z.string().min(1).max(1_200), draft: AutomationDraftSchema }),
]);
templateRoutes.post("/", zValidator("json", publishTemplateBody), async (c) => {
  const body = c.req.valid("json");
  const service = new AutomationService(c.env, getAuth(c));
  if ("automationSubscriptionId" in body) {
    return c.json(await service.shareSubscription(body.automationSubscriptionId), 201);
  }
  const created = await service.publishTemplate(body);
  return c.json({ templateId: created.id, latestVersionId: created.latestVersionId }, 201);
});
templateRoutes.post("/:id/versions", zValidator("param", templateParam), zValidator("json", versionBody), async (c) => c.json(await new AutomationService(c.env, getAuth(c)).addTemplateVersion(c.req.valid("param").id, c.req.valid("json").draft), 201));
templateRoutes.post("/:id/subscribe", zValidator("param", templateParam), zValidator("json", subscribeBody), async (c) => c.json(await new AutomationService(c.env, getAuth(c)).subscribe(c.req.valid("param").id, c.req.valid("json")), 201));

export const subscriptionRoutes = new Hono<HonoAppEnv>();
subscriptionRoutes.post("/:id/adopt-version", zValidator("param", adoptParam), zValidator("json", adoptBody), async (c) => {
  const body = c.req.valid("json");
  return c.json(await new AutomationService(c.env, getAuth(c)).adoptVersion(
    c.req.valid("param").id,
    body.versionId,
    body.activitySourcePluginIds,
  ));
});
