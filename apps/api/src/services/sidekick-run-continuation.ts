import {
  asUserId,
  asWorkspaceId,
  ExternalActorSchema,
  type WorkstreamWorkflowInput,
} from "@rally/contracts";
import type { Region } from "@rally/contracts/regions";
import { truncateUtf16Safe } from "@rally/contracts/text";
import { z } from "zod";

import {
  type AutomationActorRequestSchema,
  SidekickConversationMessageRouteSchema,
  SidekickRunContinuationSchema,
  type SidekickConversationMessageRefusalCode,
  type SidekickConversationMessageRequest,
  type SidekickConversationMessageRoute,
  type SidekickRunContinuation,
  type SidekickRunContinuationRefusalCode,
} from "../durable-objects/automation-do-protocol";
import type { Env } from "../env";
import { hostedParentStub } from "./conversation-parent-client";

/**
 * Input to a Sidekick run child continues that run.
 *
 * A run child is an ordinary conversation with parent kind `automation` and
 * the run id as its substream. Its first activation is the Sidekick's own
 * (`provisionSidekickRun`), which carries the run's context in
 * `automationRun`; every later one starts from input somebody sent, and asks
 * the Sidekick here whether that input may continue the run and with what.
 * `docs/automation-lifecycle.md` owns the mechanism.
 */

/** Ask the Sidekick whether input may continue one of its runs. Replaces an unavailable coordinator when needed. */
export async function continueSidekickRun(
  env: Env,
  input: { region: Region; workspaceId: string; automationId: string; runId: string },
): Promise<SidekickRunContinuation> {
  const workspaceId = asWorkspaceId(input.workspaceId);
  const workspace = await hostedParentStub(env, workspaceId);
  return SidekickRunContinuationSchema.parse(await workspace.sidekickContinueRun({
    workspaceId,
    automationId: input.automationId,
    runId: input.runId,
  }));
}

/**
 * Who continued the run and where, for the note the model reads.
 *
 * Outside text reaches a run child only through a provider thread bound to
 * the run, so an external author names that provider. Everything else was
 * said in the run itself: a member's message or an answer to a question the
 * run asked.
 */
export function continuationSource(pending: {
  actor: string;
  author_user_id: string | null;
  author_name_snapshot: string | null;
  external_actor_json: string | null;
}): Omit<NonNullable<WorkstreamWorkflowInput["automationContinuation"]>, "stopGeneration"> {
  if (pending.actor === "external" && pending.external_actor_json) {
    const actor = ExternalActorSchema.safeParse(JSON.parse(pending.external_actor_json));
    if (actor.success) {
      return {
        senderName: boundedName(actor.data.displayName),
        source: { kind: "provider_thread", provider: actor.data.provider },
      };
    }
  }
  return {
    senderName: boundedName(pending.author_name_snapshot),
    ...(pending.actor === "human" && pending.author_user_id ? { senderUserId: asUserId(pending.author_user_id) } : {}),
    source: { kind: "run" },
  };
}

function boundedName(name: string | null): string {
  const trimmed = name?.replace(/\s+/gu, " ").trim() ?? "";
  return trimmed.length === 0 ? "Somebody" : truncateUtf16Safe(trimmed, 200);
}

/** What the run's transcript says when the Sidekick refused to continue it. */
export const SIDEKICK_RUN_REFUSAL_TEXT: Record<SidekickRunContinuationRefusalCode, string> = {
  sidekick_paused: "This message did not continue the run because its Sidekick is paused.",
  sidekick_deleted: "This message did not continue the run because its Sidekick was archived.",
  run_not_found: "This message did not continue the run because its Sidekick no longer knows the run.",
  run_no_eligible_delegate: "This message did not continue the run because no delegated user is available. Add a delegate with access to continue.",
};

/**
 * Ask the Sidekick who answers a message in its shared conversation: the
 * wizard, a run the message starts, or nobody. The shared conversation's loop
 * asks before it takes the message, as a run child asks `continueSidekickRun`.
 */
export async function routeSidekickConversationMessage(
  env: Env,
  input: SidekickConversationMessageRequest,
): Promise<SidekickConversationMessageRoute> {
  const workspace = await hostedParentStub(env, asWorkspaceId(input.workspaceId));
  return SidekickConversationMessageRouteSchema.parse(await workspace.sidekickAdmitConversationMessage(input));
}

/** Whether a person manages a Sidekick, asked by its shared conversation before it records a wizard answer. */
export async function sidekickAllowsManager(env: Env, input: z.input<typeof AutomationActorRequestSchema>): Promise<boolean> {
  const workspace = await hostedParentStub(env, asWorkspaceId(input.workspaceId));
  return z.boolean().parse(await workspace.sidekickAllowsManager(input));
}

/** What the shared conversation says when a message addressed to the Sidekick started no run. */
export const SIDEKICK_MESSAGE_REFUSAL_TEXT: Record<SidekickConversationMessageRefusalCode, string> = {
  sidekick_not_active: "This message did not start a run because the Sidekick is not active.",
  sidekick_not_runnable: "This message did not start a run because this Sidekick has no way to run; it is used as a skill in other conversations.",
  run_no_eligible_delegate: "This message did not start a run because this Sidekick cannot act for you yet.",
  sidekick_edit_requires_manager: "This message did not change the Sidekick because only the people who manage it can edit it.",
};
