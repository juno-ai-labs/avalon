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
  SidekickRunContinuationRefusalCodeSchema,
  SidekickRunContinuationSchema,
  type SidekickConversationMessageRefusalCode,
  type SidekickConversationMessageRequest,
  type SidekickConversationMessageRoute,
  type SidekickRunContinuation,
  type SidekickRunContinuationRefusalCode,
  type SidekickRunContinuationSender,
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
  input: { region: Region; workspaceId: string; automationId: string; runId: string; sender: SidekickRunContinuationSender },
): Promise<SidekickRunContinuation> {
  const workspaceId = asWorkspaceId(input.workspaceId);
  const workspace = await hostedParentStub(env, workspaceId);
  return SidekickRunContinuationSchema.parse(await workspace.sidekickContinueRun({
    workspaceId,
    automationId: input.automationId,
    runId: input.runId,
    sender: input.sender,
  }));
}

const SenderAuthorizationSchema = z.looseObject({
  agentExchange: z.looseObject({ senderAgentId: z.string() }).optional(),
  senderExecutionPrincipal: z.unknown().optional(),
  executionPrincipal: z.unknown().optional(),
});
const UserPrincipalSchema = z.looseObject({ type: z.literal("user"), userId: z.string().min(1) });

/**
 * Who sent a queued input, as `continueSidekickRun` asks, from the input's
 * actor and its stored authorization:
 *
 * - a person's own message or answer names them;
 * - outside text from a bound provider thread is `external`, whoever wrote
 *   it: every binding a run child has is one the run's own outbound message
 *   made (Slack starts no conversation and binds no room), so a reply there
 *   is an answer the run itself asked for. It continues the run under the
 *   run's own principal, framed as evidence, not as a request;
 * - another agent's message names the person that agent acts for, so a
 *   reader's agent cannot do what the reader may not. The Sidekick's own
 *   wizard is no exception: its turn acts for whoever drove it, which for its
 *   answer to a run's change request is the run's own principal, so that
 *   answer continues the run and a wizard turn someone else drove does not.
 *   An agent acting for nobody (an Organization-authority turn) is
 *   `unattributed`: it continues only a run that itself acts for nobody, the
 *   Sidekick's own, and is refused everywhere else;
 * - anything else is Rally's own (`system`).
 */
export function continuationSender(
  pending: { actor: string; author_user_id: string | null },
  authorization: unknown,
): SidekickRunContinuationSender {
  if (pending.actor === "human" && pending.author_user_id !== null) return { kind: "person", userId: asUserId(pending.author_user_id) };
  const stored = SenderAuthorizationSchema.safeParse(authorization);
  const fields = stored.success ? stored.data : {};
  if (pending.actor === "external") return { kind: "external" };
  if (fields.agentExchange) {
    const principal = UserPrincipalSchema.safeParse(fields.senderExecutionPrincipal ?? fields.executionPrincipal);
    return principal.success ? { kind: "person", userId: asUserId(principal.data.userId) } : { kind: "unattributed" };
  }
  return { kind: "system" };
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
  run_continuation_requires_requester: "This message did not continue the run because the run acts for the person who started it, and only they can continue it.",
  run_continuation_requires_delegate: "This message did not continue the run because it acts with access shared with this Sidekick, and only people who share theirs can continue it.",
  run_continuation_requires_manager: "This message did not continue the run because it acts as the Sidekick itself, and only the people who manage this Sidekick can continue it.",
  run_continuation_requires_rally_user: "This message did not continue the run because the agent that sent it acts for nobody in Rally who may continue it.",
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

/**
 * The refusal a person's input to a run would get, asked by a run child
 * before it records an answer to a question the run asked, so that a person
 * who may not continue the run cannot close the question for one who may.
 */
export async function sidekickRunInputRefusal(
  env: Env,
  input: { workspaceId: string; automationId: string; runId: string; userId: string },
): Promise<SidekickRunContinuationRefusalCode | null> {
  const workspace = await hostedParentStub(env, asWorkspaceId(input.workspaceId));
  return SidekickRunContinuationRefusalCodeSchema.nullable().parse(await workspace.sidekickRunInputRefusal({
    workspaceId: asWorkspaceId(input.workspaceId),
    automationId: input.automationId,
    runId: input.runId,
    sender: { kind: "person", userId: asUserId(input.userId) },
  }));
}

/**
 * Whether this person manages a Sidekick, with the role their membership
 * gives them: the rule for who may drive its wizard, asked for an agent's
 * message both where it is sent and where the shared conversation takes it.
 * A guest has no role; somebody with no active membership manages nothing.
 */
export async function personManagesSidekick(
  env: Env,
  input: { workspaceId: string; automationId: string; userId: string },
): Promise<boolean> {
  const member = await env.DB.prepare(
    "SELECT role, access_class FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND status = 'active'",
  ).bind(input.workspaceId, input.userId).first<{ role: "owner" | "admin" | "member" | null; access_class: string | null }>();
  if (!member) return false;
  return sidekickAllowsManager(env, {
    workspaceId: input.workspaceId, automationId: input.automationId,
    actor: { userId: asUserId(input.userId), actorRole: member.access_class === "guest" ? null : member.role },
  });
}

/** What the shared conversation says when a message addressed to the Sidekick started no run. */
export const SIDEKICK_MESSAGE_REFUSAL_TEXT: Record<SidekickConversationMessageRefusalCode, string> = {
  sidekick_not_active: "This message did not start a run because the Sidekick is not active.",
  sidekick_not_runnable: "This message did not start a run because this Sidekick has no way to run; it is used as a skill in other conversations.",
  run_no_eligible_delegate: "This message did not start a run because this Sidekick cannot act for you yet.",
  sidekick_edit_requires_manager: "This message did not change the Sidekick because only the people who manage it can edit it.",
};
