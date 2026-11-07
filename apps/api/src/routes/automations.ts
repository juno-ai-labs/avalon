import { Hono } from "hono";
import { zValidator } from "../middleware/validation";
import {
  AutomationDetailSchema,
  type AutomationDetail,
  AutomationRunSchema,
  AutomationExecutionPrincipalClaimSchema,
  AutomationSummarySchema,
  WorkstreamAppearancePatchSchema,
  SidekickAudienceUpdateSchema,
  IdSchema,
  SidekickDelegatesResultSchema, SidekickDelegationMutationResultSchema,
} from "@rally/contracts";
import { z } from "zod";
import type { HonoAppEnv } from "../env";
import { getAuth, getWorkspaceAuth, requireWorkspaceAuth } from "../middleware/auth";
import { workspaceRealtimeInvalidation } from "../middleware/workspace-realtime";
import { AutomationService } from "../services/automation-service";
import { CanvasService } from "../services/canvas-service";
import { SidebarPinRequestSchema } from "@rally/contracts/canvases";
import { SidekickDelegationService } from "../services/sidekick-delegation-service";

const idParam = z.object({ id: IdSchema });
const runHeaders = z.object({ "idempotency-key": z.string().min(8).max(120) });

/** Envelopes this route composes; the entities inside come from the contracts. */
const AutomationPageSchema = z.object({ items: z.array(AutomationSummarySchema) });
const AutomationRunPageSchema = z.object({ items: z.array(AutomationRunSchema) });
const CreatedAutomationSchema = z.object({ automationId: IdSchema });
const StartedRunSchema = z.object({ runId: IdSchema, reused: z.boolean() });

/** Older installed clients cannot parse empty or explicit-email trigger lists. */
export function legacyAutomationDetail(detail: AutomationDetail) {
  if (!detail.currentDefinition) return detail;
  const triggers = detail.currentDefinition.triggers.filter((trigger) => trigger.type !== "inbound_email");
  return { ...detail, currentDefinition: { ...detail.currentDefinition,
    triggers: triggers.length ? triggers : [{ type: "manual" as const }],
  } };
}

function createAutomationRoutes(sidekicks: boolean) {
const detailResponse = (detail: AutomationDetail) => sidekicks ? detail : legacyAutomationDetail(detail);
const automationRoutes = new Hono<HonoAppEnv>();
automationRoutes.use("*", requireWorkspaceAuth);
automationRoutes.use("*", workspaceRealtimeInvalidation);
automationRoutes.get("/", async (c) =>
  c.json(AutomationPageSchema.parse(await new AutomationService(c.env, getAuth(c))[sidekicks ? "listSidekicks" : "list"]())));
// "New automation": the object and its conversation, and nothing else. The
// draft is written in that conversation, so there is no body.
automationRoutes.post("/", async (c) =>
  c.json(CreatedAutomationSchema.parse(await new AutomationService(c.env, getAuth(c)).create()), 201));
automationRoutes.get("/:id", zValidator("param", idParam), async (c) =>
  c.json(AutomationDetailSchema.parse(detailResponse(
    await new AutomationService(c.env, getWorkspaceAuth(c)).detail(c.req.valid("param").id),
  ))));
automationRoutes.get("/:id/delegation", zValidator("param", idParam), async (c) => {
  const auth = getWorkspaceAuth(c);
  return c.json(SidekickDelegatesResultSchema.parse(await new SidekickDelegationService(c.env, auth.workspaceId, auth.userId)
    .listDelegates(c.req.valid("param").id)));
});
automationRoutes.post("/:id/delegation", zValidator("param", idParam), zValidator("json", z.strictObject({
  allowed: z.boolean(), operationId: IdSchema,
})), async (c) => {
  const auth = getWorkspaceAuth(c);
  const input = c.req.valid("json");
  return c.json(SidekickDelegationMutationResultSchema.parse(await new SidekickDelegationService(c.env, auth.workspaceId, auth.userId)
    .setOwn(c.req.valid("param").id, input.allowed, input.operationId, "self_service")));
});
automationRoutes.post("/:id/run", zValidator("param", idParam), zValidator("header", runHeaders), async (c) => c.json(
  StartedRunSchema.parse(await new AutomationService(c.env, getWorkspaceAuth(c)).runNow(
    c.req.valid("param").id,
    c.req.valid("header")["idempotency-key"],
  )),
  202,
));
// Apply the current ready revision: the first time this creates the
// automation, every later time it re-applies an edit. Takes no body: the
// definition is on the object, written by its conversation.
automationRoutes.post("/:id/accept", zValidator("param", idParam), async (c) =>
  c.json(AutomationDetailSchema.parse(detailResponse(
    await new AutomationService(c.env, getWorkspaceAuth(c)).apply(c.req.valid("param").id),
  ))));
// The claimant is always the caller, so this body is empty by design: a field
// naming somebody else would let one person lend a colleague's credentials to a
// standing automation.
automationRoutes.post("/:id/execution-principal", zValidator("param", idParam), async (c) =>
  c.json(AutomationExecutionPrincipalClaimSchema.parse(
    await new AutomationService(c.env, getWorkspaceAuth(c))
      .claimExecutionPrincipal(c.req.valid("param").id),
  )));
// The Sidekick's icon and colour: a partial choice, so two people picking at
// once change a field each. Parent-owned, so it is REST rather than a command
// on the authoring conversation's socket, and it answers with the whole detail
// so the person who picked never waits on the directory projection.
automationRoutes.post("/:id/appearance", zValidator("param", idParam),
  zValidator("json", WorkstreamAppearancePatchSchema), async (c) =>
  c.json(AutomationDetailSchema.parse(detailResponse(
    await new AutomationService(c.env, getWorkspaceAuth(c))
      .setAppearance(c.req.valid("param").id, c.req.valid("json")),
  ))));
// Who the Sidekick is shared with: its author alone, the Organization, or
// named people. A manager's; answers with the whole detail, as appearance does.
automationRoutes.post("/:id/audience", zValidator("param", idParam),
  zValidator("json", SidekickAudienceUpdateSchema), async (c) =>
  c.json(AutomationDetailSchema.parse(detailResponse(
    await new AutomationService(c.env, getWorkspaceAuth(c))
      .setAudience(c.req.valid("param").id, c.req.valid("json")),
  ))));
// Pin in, or out of, the Sidekick list's Pinned group; the viewer's own.
automationRoutes.post("/:id/pin", zValidator("param", idParam), zValidator("json", SidebarPinRequestSchema), async (c) => {
  await new CanvasService(c.env, getWorkspaceAuth(c)).pin("sidekick", c.req.valid("param").id, c.req.valid("json").pinned);
  return c.body(null, 204);
});
automationRoutes.post("/:id/pause", zValidator("param", idParam), async (c) => { await new AutomationService(c.env, getWorkspaceAuth(c)).pause(c.req.valid("param").id); return c.body(null, 204); });
automationRoutes.post("/:id/resume", zValidator("param", idParam), async (c) => { await new AutomationService(c.env, getWorkspaceAuth(c)).resume(c.req.valid("param").id); return c.body(null, 204); });
automationRoutes.post("/:id/archive", zValidator("param", idParam), async (c) => { await new AutomationService(c.env, getWorkspaceAuth(c)).archive(c.req.valid("param").id); return c.body(null, 204); });
// Compatibility for installed clients that shipped the earlier Delete wording.
automationRoutes.delete("/:id", zValidator("param", idParam), async (c) => { await new AutomationService(c.env, getWorkspaceAuth(c)).delete(c.req.valid("param").id); return c.body(null, 204); });
automationRoutes.get("/:id/runs", zValidator("param", idParam), async (c) =>
  c.json(AutomationRunPageSchema.parse(await new AutomationService(c.env, getWorkspaceAuth(c)).runs(c.req.valid("param").id))));

return automationRoutes;
}
export const automationRoutes = createAutomationRoutes(false);
export const sidekickRoutes = createAutomationRoutes(true);
