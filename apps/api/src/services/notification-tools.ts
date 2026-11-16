import type { HarnessPlugin, HarnessTool, HarnessToolContext } from "@rally/agent-harness";
import type { WorkstreamWorkflowInput } from "@rally/contracts";
import { NOTIFICATIONS_SYSTEM_MESSAGE } from "@rally/prompts/api/notifications-plugin";
import { z } from "zod";

import type { WorkspaceDO } from "../durable-objects/workspace-do";
import { refusingTool, toolRefusal, TOOL_REFUSALS } from "./tool-refusal";

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
 * Which of the two tools this loop may use, from its host-derived fields
 * (docs/agent-loop-types.md, docs/PRDs/2026-11-14_canvas-notices): the
 * self-review, and a background agent it started, may use neither; a run and
 * a run's delegation worker may send but not turn notices on, since a run is
 * handed an event's content and turning them on changes the Canvas for
 * everyone; every other loop may use both. A wake-up is the loop it runs in.
 * Every loop is offered both: one it may not use refuses with a route
 * (docs/agent-tools.md, rule 14).
 */
export function notificationToolsAllowed(input: Pick<WorkstreamWorkflowInput,
  "automationRun" | "automationDelegation" | "backgroundAgentRootReason" | "reason">): { register: boolean; send: boolean; run: boolean } {
  const run = input.automationRun !== undefined || input.automationDelegation !== undefined;
  if (input.reason === "sidekick_review" || input.backgroundAgentRootReason === "sidekick_review") return { register: false, send: false, run };
  return { register: !run, send: true, run };
}

const RegisterInputSchema = z.strictObject({
  purpose: z.string().trim().min(1).describe("One sentence saying what this Canvas will notify about, shown to everyone in it, for example \"Tell you when a new newsletter becomes a podcast.\""),
});
const SendInputSchema = z.strictObject({
  title: z.string().trim().min(1).describe("What happened, short, for example \"New episode: Stratechery, November 14\"."),
  body: z.string().trim().min(1).describe("One or two sentences of detail. Plain text. It opens the Canvas, so add no link."),
});

/** What the tools ask of the Organization object, as a port a test can stand in for. */
export interface NotificationToolPorts {
  canvasNotices: WorkspaceDO["canvasNotices"];
  /** Whether this turn belongs to the Sidekick self-review, which `reason` alone does not always say. */
  turnIsSelfReview: () => Promise<boolean>;
}

/**
 * The refusals, one place: each says what happened, for the tool that was
 * called, and what this loop can do next.
 */
function refusal(code: string, tool: "register" | "send", available: { canvasId: string; title: string }[] | undefined,
  run: boolean): NotificationToolError {
  const undone = tool === "register" ? "Notices were not turned on." : "No notice was sent.";
  // A run reports to its result; a wizard or Chat turn can tell its person.
  const next = run ? "Continue, and say so in your result." : "Tell the person you work for.";
  // The sentence, or the record the Chat writes of it, is too long.
  if (code === "canvas_notices_purpose_too_long" || code.startsWith("append_host_record_invalid")) {
    return new NotificationToolError(code, "The Chat did not take the record of that sentence. Shorten what notices are about and register again.");
  }
  switch (code) {
    case "canvas_notices_not_registered":
      return new NotificationToolError(code, run
        ? "Notices are not on for this Canvas, and a run cannot turn them on. No notice was sent. Say in your result that a person who manages this Sidekick should turn them on from its wizard."
        : "Notices are not on for this Canvas. If a person in this conversation asked to be told about new results, or asked for something that keeps producing them while they are away, turn them on with notifications_register and send again; otherwise continue without sending a notice.");
    case "canvas_archived":
      return new NotificationToolError(code, `This Canvas is archived. ${undone} Continue without one.`);
    case "canvas_access_denied":
      return new NotificationToolError(code, `The person this turn acts for can no longer open this Canvas. ${undone} Continue without one.`);
    case "notifications_sidekick_has_several_canvases":
      return new NotificationToolError(code,
        `This Sidekick is attached to several Canvases (${(available ?? []).map((canvas) => canvas.title).join(", ")}), so it has no one Canvas for notices. ${undone} ${next}`,
        { available: (available ?? []).map((canvas) => canvas.title) });
    case "notifications_sidekick_has_no_canvas":
      return new NotificationToolError(code, `This Sidekick is not attached to a Canvas, so it has no Canvas for notices. ${undone} ${next}`);
    default:
      return new NotificationToolError(code, `${undone} Continue without one.`);
  }
}

function effectKey(context: HarnessToolContext): string {
  if (!context.effectIntentId) throw new Error("notification_effect_intent_missing");
  return context.effectIntentId;
}

/**
 * `rally:notifications`: turn on a Canvas's notices and send one. The Canvas
 * is always the host's: the loop's own Canvas for a Canvas's Chat, the
 * Sidekick's one attached Canvas for a Sidekick's loops. Every loop is
 * offered both tools; one this loop may not use refuses by name.
 */
export function createNotificationsPlugin(input: WorkstreamWorkflowInput, ports: NotificationToolPorts): HarnessPlugin {
  const allowed = notificationToolsAllowed(input);
  const { run } = allowed;
  const reachRunId = input.automationRun?.runId ?? input.automationDelegation?.runId;
  const loop = {
    parentKind: input.parentKind === "canvas" ? "canvas" as const : "automation" as const,
    parentId: input.parentId,
    ...(reachRunId ? { reachRunId } : {}),
    actingUserId: input.executionPrincipal.type === "user" ? input.executionPrincipal.userId : null,
  };
  const guard = async () => {
    // A wizard turn the self-review claims is known only once the turn runs.
    if (await ports.turnIsSelfReview()) {
      throw new NotificationToolError("notifications_not_for_self_review", TOOL_REFUSALS.notifications_not_for_self_review);
    }
  };
  const register: HarnessTool = {
      definition: {
        name: "register", capability: "rally.notifications.register",
        description: "Turn on notices for this Canvas, so agents can tell the people in it when something happens. Say in one sentence what it will notify about; that sentence is shown to the people in the Canvas. Calling again replaces the sentence, so call it only to turn notices on or when a person asks to change what they are about.",
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
        if (result.outcome === "refused") throw refusal(result.code, "register", result.available, run);
        if (result.outcome !== "registered") throw new Error("notification_register_unexpected_outcome");
        const output = { purpose: result.purpose, changed: result.changed };
        return { output, summary: result.changed ? "Turned on notices for this Canvas" : "Notices were already on" };
      },
  };
  const send: HarnessTool = {
      definition: {
        name: "send", capability: "rally.notifications.send",
        description: "Tell the people in this Canvas that something happened. They get it on their devices or by email, and it opens the Canvas. It says so if notices are off.",
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
        if (result.outcome === "refused") throw refusal(result.code, "send", result.available, run);
        if (result.outcome !== "sent") throw new Error("notification_send_unexpected_outcome");
        return { output: { canvasId: result.canvasId, recipients: result.recipients }, summary: `Sent a notice to ${result.recipients} people` };
      },
  };
  const review = toolRefusal("notifications_not_for_self_review");
  const tools = [
    allowed.register ? register : refusingTool(register, allowed.send ? toolRefusal("notifications_register_from_run") : review),
    allowed.send ? send : refusingTool(send, review),
  ];
  return {
    canonicalId: NOTIFICATIONS_PLUGIN_ID, modelId: "rally_notifications", shortWireName: NOTIFICATIONS_WIRE_PREFIX,
    displayName: "Notifications", description: "Tell the people in this Canvas when something happens.",
    preload: true, explicit: true,
    systemMessage: NOTIFICATIONS_SYSTEM_MESSAGE,
    tools,
  };
}
