import type { HarnessPlugin, HarnessTool, HarnessToolContext } from "@rally/agent-harness";
import type { WorkstreamWorkflowInput } from "@rally/contracts";
import { NOTIFICATIONS_SYSTEM_MESSAGE } from "@rally/prompts/api/notifications-plugin";
import { z } from "zod";

import type { WorkspaceDO } from "../durable-objects/workspace-do";

export const NOTIFICATIONS_PLUGIN_ID = "rally:notifications";
export const NOTIFICATIONS_WIRE_PREFIX = "notifications";

/** A refusal the model can act on: a stable code, one sentence, allowlisted details only. */
export class NotificationToolError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "NotificationToolError";
  }
}

/**
 * Which of the two tools this loop is offered, from its host-derived fields
 * (docs/agent-loop-types.md, docs/PRDs/2026-11-14_canvas-notices): the
 * self-review, and a background agent it started, get neither; a run and a
 * run's delegation worker may send but not turn notices on, since a run is
 * handed an event's content and turning them on changes the Canvas for
 * everyone; every other loop gets both. A wake-up is the loop it runs in.
 */
export function notificationToolsOffered(input: Pick<WorkstreamWorkflowInput,
  "automationRun" | "automationDelegation" | "backgroundAgentRootReason" | "reason">): { register: boolean; send: boolean } {
  if (input.reason === "sidekick_review" || input.backgroundAgentRootReason === "sidekick_review") return { register: false, send: false };
  const run = input.automationRun !== undefined || input.automationDelegation !== undefined;
  return { register: !run, send: true };
}

const RegisterInputSchema = z.strictObject({
  purpose: z.string().trim().min(1).describe("One sentence saying what this Canvas will notify about, shown to everyone in it, for example \"Tell you when a new newsletter becomes a podcast.\""),
});
const SendInputSchema = z.strictObject({
  title: z.string().trim().min(1).describe("What happened, short, for example \"New episode: Stratechery, November 14\"."),
  body: z.string().trim().min(1).describe("One or two sentences of detail. Plain text."),
});

/** What the tools ask of the Organization object, as a port a test can stand in for. */
export interface NotificationToolPorts {
  canvasNotices: WorkspaceDO["canvasNotices"];
  /** Whether this turn belongs to the Sidekick self-review, which `reason` alone does not always say. */
  turnIsSelfReview: () => Promise<boolean>;
}

/** The refusals, one place: each says what happened and what to do next. */
function refusal(code: string, available: { canvasId: string; title: string }[] | undefined, run: boolean): NotificationToolError {
  switch (code) {
    case "canvas_notices_not_registered":
      return new NotificationToolError(code, run
        ? "Notices are not on for this Canvas, and a run cannot turn them on. Continue without sending a notice."
        : "Notices are not on for this Canvas. Turn them on with notifications_register, then send again.");
    case "canvas_archived":
      return new NotificationToolError(code, "This Canvas is archived, so it cannot send notices. Continue without sending a notice.");
    case "canvas_access_denied":
      return new NotificationToolError(code, "The person this runs for can no longer open this Canvas, so no notice was sent.");
    case "notifications_sidekick_has_several_canvases":
      return new NotificationToolError(code,
        `This Sidekick is attached to several Canvases (${(available ?? []).map((canvas) => canvas.title).join(", ")}), so it has no one Canvas to send notices from. No notice was sent.`,
        { available: (available ?? []).map((canvas) => canvas.title) });
    case "notifications_sidekick_has_no_canvas":
      return new NotificationToolError(code, "This Sidekick is not attached to a Canvas, so it has nowhere to send notices from. No notice was sent.");
    case "notifications_not_for_self_review":
      return new NotificationToolError(code, "A Sidekick's self-review does not send notices. Continue without sending one.");
    default:
      return new NotificationToolError(code, "The notice could not be sent. Continue without sending one.");
  }
}

function effectKey(context: HarnessToolContext): string {
  if (!context.effectIntentId) throw new Error("notification_effect_intent_missing");
  return context.effectIntentId;
}

/**
 * `rally:notifications`: turn on a Canvas's notices and send one. The Canvas
 * is always the host's: the loop's own Canvas for a Canvas's Chat, the
 * Sidekick's one attached Canvas for a Sidekick's loops. `null` for a loop
 * offered neither tool.
 */
export function createNotificationsPlugin(input: WorkstreamWorkflowInput, ports: NotificationToolPorts): HarnessPlugin | null {
  const offered = notificationToolsOffered(input);
  if (!offered.register && !offered.send) return null;
  const run = input.automationRun !== undefined || input.automationDelegation !== undefined;
  const loop = {
    parentKind: input.parentKind === "canvas" ? "canvas" as const : "automation" as const,
    parentId: input.parentId,
    ...((input.automationRun?.runId ?? input.automationDelegation?.runId) ? { reachRunId: input.automationRun?.runId ?? input.automationDelegation!.runId } : {}),
    actingUserId: input.executionPrincipal.type === "user" ? input.executionPrincipal.userId : null,
  };
  const guard = async () => {
    if (await ports.turnIsSelfReview()) throw refusal("notifications_not_for_self_review", undefined, run);
  };
  const tools: HarnessTool[] = [];
  if (offered.register) {
    tools.push({
      definition: {
        name: "register", capability: "rally.notifications.register",
        description: "Turn on notices for this Canvas, so agents can tell its participants when something happens. Say in one sentence what it will notify about; that sentence is shown to everyone in the Canvas. Calling again replaces the sentence.",
        mode: "write", idempotency: "record_before_execute", inputSchema: z.toJSONSchema(RegisterInputSchema),
      },
      serial: true,
      // Keyed on the receipt: a retry lands the record once and answers the same.
      reenterable: true,
      validateInput: (raw) => { const result = RegisterInputSchema.safeParse(raw); return result.success ? null : result.error; },
      execute: async (raw, context) => {
        const args = RegisterInputSchema.parse(raw);
        await guard();
        const result = await ports.canvasNotices({ workspaceId: input.workspaceId, loop,
          action: { kind: "register", purpose: args.purpose, operationId: effectKey(context) } });
        if (result.outcome === "refused") throw refusal(result.code, result.available, run);
        if (result.outcome !== "registered") throw new Error("notification_register_unexpected_outcome");
        const output = { canvasId: result.canvasId, purpose: result.purpose, changed: result.changed, recordMessageId: result.recordMessageId };
        return { output, summary: result.changed ? "Turned on notices for this Canvas" : "Notices were already on" };
      },
    });
  }
  if (offered.send) {
    tools.push({
      definition: {
        name: "send", capability: "rally.notifications.send",
        description: "Tell everyone in this Canvas that something happened. They get it on their devices or by email, and it opens the Canvas. Notices must be on (notifications_register).",
        mode: "write", idempotency: "record_before_execute", inputSchema: z.toJSONSchema(SendInputSchema),
      },
      serial: true,
      // Keyed on the receipt: a retry records nothing twice.
      reenterable: true,
      validateInput: (raw) => { const result = SendInputSchema.safeParse(raw); return result.success ? null : result.error; },
      execute: async (raw, context) => {
        const args = SendInputSchema.parse(raw);
        await guard();
        const result = await ports.canvasNotices({ workspaceId: input.workspaceId, loop,
          action: { kind: "send", title: args.title, body: args.body, sourceId: `canvas_notice:${input.harnessRunId}:${effectKey(context)}` } });
        if (result.outcome === "refused") throw refusal(result.code, result.available, run);
        if (result.outcome !== "sent") throw new Error("notification_send_unexpected_outcome");
        return { output: { canvasId: result.canvasId, recipients: result.recipients }, summary: `Sent a notice to ${result.recipients} people` };
      },
    });
  }
  return {
    canonicalId: NOTIFICATIONS_PLUGIN_ID, modelId: "rally_notifications", shortWireName: NOTIFICATIONS_WIRE_PREFIX,
    displayName: "Notifications", description: "Tell the people in this Canvas when something happens.",
    preload: true, explicit: true,
    systemMessage: NOTIFICATIONS_SYSTEM_MESSAGE,
    tools,
  };
}
