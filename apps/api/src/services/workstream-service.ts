import { conversationSidekickCandidateIds } from "./sidekick-skills";
import type { ExternalBindingClaim } from "../durable-objects/workspace-external-binding-protocol";
import { AutomationService } from "./automation-service";
import { readWorkspaceRelationship } from "./workspace-relationship-service";
import { ConversationService } from "./conversation-service";
import { forgetReviewedMemory, readMemoryReview } from "./memory-review-service";
import type { MemoryReviewScope } from "../durable-objects/workspace-memory-facts-protocol";
import { publishWorkspaceSync } from "./workspace-realtime-service";
import type { MemoryForgetResponse, MemoryReview, SidekickAttachment, SidekickRecommendationOptions } from "@rally/contracts";
import { newId, nowIso } from "@rally/db";
import { memberSafeHarnessFailureMessage } from "@rally/agent-harness";
import { HarnessFailureCodeSchema, asUserId, asHarnessRunId, asWorkspaceId, asWorkstreamId, asSubstreamId, type WorkspaceId, type WorkstreamId } from "@rally/contracts";
import type {
  AnswerElicitationRequestSchema,
  CreateMessageRequestSchema,
  CreateWorkstreamRequestSchema,
  ExecutionPrincipal,
  Scope,
  SlackOriginContext,
  SlackSearchAuthorization,
  SubstreamId,
  UpdateWorkstreamRequestSchema,
  WorkstreamDetail,
  WorkstreamWorkflowInput,
} from "@rally/contracts";
import type { ConversationParentKind } from "@rally/contracts/conversation-parent";
import type { z } from "zod";
import type { AuthContext, Env } from "../env";
import { conversationObjectName } from "../durable-objects/substream-agent";
import { substreamLoopId, workspaceDOName } from "../durable-objects/names";
import { WorkspaceOpportunityOriginEventsResultSchema } from "../durable-objects/workspace-opportunity-protocol";
import { ApiError } from "../lib/api-error";
import { publishAccessRevocation } from "./access-revocation";
import { loopActivationWasRecorded } from "../lib/loop-activation-signal";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { truncateUtf16Safe } from "../lib/text";
import { activateWorkstreamLoop, publishWorkstreamEvent } from "./integrations";
import { logStructuredEvent, logWarn } from "../observability/logger";
import { scheduledWorkstreamModelForExisting, conversationModelContext } from "./agent-model-flags";
import { issueWorkstreamControlSocketTicket } from "./socket-service";
import { WorkstreamDirectoryService } from "./workstream-directory-service";
import {
  activityOriginLocator,
  describeWorkstreamOrigin,
  resolveOriginResource,
  type OriginResourceDescriptor,
} from "./workstream-origin-resource";
import { emitCorrelatedRunOutcome } from "../telemetry/run-outcome";
import { activityIsWorkspaceVisible } from "../lib/activity-visibility";
import type { SchedulingObjectPort } from "../durable-objects/workstream-scheduling-protocol";
import { createHarnessRunObjectPort } from "../runtime/harness-run-port";
import { createMessageObjectPort } from "../runtime/message-port";
import {
  claimDueWorkstreamWakeup,
  releaseClaimedWorkstreamWakeup,
  wakeupExecutionPrincipal,
  type WorkstreamWakeupRow,
} from "./workstream-wakeup-service";
import { ChannelAccessService, publishChannelNarrowing } from "./channel-access-service";
import { hostedParentStub } from "./conversation-parent-client";
import { continueSidekickRun } from "./sidekick-run-continuation";
import { WorkstreamObjectClient } from "./workstream-object-client";
import { WorkstreamObjectCreationService } from "./workstream-object-creation-service";
import { rpcResultBody } from "../durable-objects/rpc-result";
import { createIdentityObjectPort } from "../runtime/identity-port";
import {
  AdmitExternalMessageInputSchema,
  AnswerExternalElicitationInputSchema,
  ExternalMessageAdmissionResultSchema,
  type AdmitExternalMessageInput,
  type AnswerExternalElicitationInput,
  type ExternalMessageAdmissionResult,
} from "../durable-objects/workstream-external-message-protocol";

/**
 * `descriptionSource` is the caller's assertion, never inferred from whether
 * `objective` is present. A supplied objective means "the caller had one", which
 * is true of every machine-derived path — a Slack mention slices its prompt into
 * the field, and reading that as authorship would tell the refresh loop to
 * protect exactly the descriptions it exists to fix. Only a caller that knows a
 * person typed the text says so, and the default is the honest one.
 */
type ParsedCreateWorkstreamInput = z.infer<typeof CreateWorkstreamRequestSchema>;
type CreateWorkstreamInput = Omit<ParsedCreateWorkstreamInput, "mentions" | "spaceIds"> & {
  /** Optional at this internal boundary because the schema fills the empty case. */
  mentions?: ParsedCreateWorkstreamInput["mentions"];
  /** Optional for the same reason; empty means General, which every connector means. */
  spaceIds?: ParsedCreateWorkstreamInput["spaceIds"];
  descriptionSource?: "authored" | "derived";
  /**
   * The connector place this work stream is being started from, when there is
   * one. Not part of `CreateWorkstreamRequestSchema` and deliberately so: a
   * caller on the wire cannot assert an origin, because an origin is something
   * an ingress *knows* — the Slack thread it read the mention out of — rather
   * than something a request may claim about itself.
   */
  originResource?: OriginResourceDescriptor;
  /** Validated request-header correlation injected by the API route. */
  telemetryOperationId?: string;
  /**
   * Who may read it from birth. Same reasoning as `originResource`: a request
   * on the wire cannot claim it, because it is decided by where the work stream
   * started — a private connector conversation opens a private work stream
   * whose room is that conversation's members. Omitted means `personal`, which
   * is what a work stream nobody has said anything about is; a caller says
   * `workspace` when it *knows* the audience is wider than the room.
   */
  scope?: Scope;
};
type UpdateWorkstreamInput = z.infer<typeof UpdateWorkstreamRequestSchema>;
type CreateMessageInput = z.infer<typeof CreateMessageRequestSchema> & {
  /** Validated request-header correlation injected by the API route. */
  telemetryOperationId?: string;
  /** Server-owned continuation metadata; never accepted from the message API. */
  forcedHarnessOrigin?: string;
  parentHarnessRunId?: string;
  expectedLatestHarnessRunId?: string;
  expectedToolInvocationId?: string;
};
type AnswerElicitationInput = z.infer<typeof AnswerElicitationRequestSchema>;
/**
 * How many of a suggestion's connector sources become attachments. A batched
 * opportunity can be built from a run of related events, and the rail is a
 * reading surface before it is an index; the cap is generous against what
 * admission actually produces and is stated in
 * `docs/workstream-origin-attachments.md` rather than left to be discovered.
 */
const MAX_OPPORTUNITY_ORIGIN_RESOURCES = 8;

// Codes that reach the same member surface without being harness failure codes —
// connector-layer and run-lifecycle outcomes.
//
// The model-facing entries were brought up to the two rules that govern
// `MEMBER_SAFE_HARNESS_FAILURE_MESSAGES` — name a next action, and use no word
// that only exists inside Avalon. `provider_error` is a *connector* provider,
// not the model one, and used to say "the model provider could not complete this
// run", a sentence a reader could not tell apart from the model codes beside it.
//
// **The lifecycle entries below do not meet those rules yet**, and the claim is
// scoped rather than stated over them: `run_ownership_lost` and
// `stale_run_reaped` still say "executor" and "execution lease", and neither
// they nor `provider_error` name a next action. They are left as they are
// because each needs a product answer about what a member should actually do
// when a run is superseded or its lease expires, which is not this change's to
// invent. Do not read the rules above as already enforced here.
const ADDITIONAL_MEMBER_SAFE_HARNESS_ERRORS = Object.freeze({
  empty_completion: "The model returned an empty response. Try again in a moment",
  model_output_invalid: "The model returned a response Rally could not read. Try again in a moment",
  provider_error: "A connected service returned an error, so this run stopped",
  run_admission_timeout: "This thread stayed busy too long to start the run",
  run_cancelled: "This run was cancelled",
  run_ownership_lost: "This run was superseded by another executor",
  stale_run_reaped: "This run stopped after its execution lease expired",
  workflow_unavailable: "Rally could not start this run",
} satisfies Readonly<Record<string, string>>);

const GENERIC_MEMBER_SAFE_HARNESS_ERROR = Object.freeze({
  code: "harness_execution_failed",
  message: "Rally could not complete this run. Retrying is unlikely to help — copy the request ID for support",
});

async function externalMessageAgent(
  env: Env,
  workspaceId: WorkspaceId,
  workstreamId: WorkstreamId,
  substreamId?: string,
) {
  return durableObjectStubForWorkspace(
    env,
    env.SUBSTREAM_AGENTS,
    workspaceId,
    conversationObjectName(
      env.AVALON_REGION,
      workspaceId,
      workstreamId,
      substreamId === undefined ? "0" : asSubstreamId(substreamId),
    ),
  );
}

export async function admitExternalWorkstreamMessage(
  env: Env,
  rawInput: AdmitExternalMessageInput,
): Promise<ExternalMessageAdmissionResult> {
  const input = AdmitExternalMessageInputSchema.parse(rawInput);
  const agent = await externalMessageAgent(env, input.workspaceId, input.workstreamId, input.substreamId);
  const response = await agent.admitExternalMessage(input);
  const body = rpcResultBody(response);
  if (response.status < 200 || response.status >= 300) {
    const error = body && typeof body === "object" && "error" in body
      ? String(body.error)
      : "external_message_admission_failed";
    throw new Error(error);
  }
  return ExternalMessageAdmissionResultSchema.parse(body);
}

export async function answerExternalWorkstreamElicitation(
  env: Env,
  rawInput: AnswerExternalElicitationInput,
): Promise<ExternalMessageAdmissionResult> {
  const input = AnswerExternalElicitationInputSchema.parse(rawInput);
  const agent = await externalMessageAgent(env, input.workspaceId, input.workstreamId);
  const response = await agent.answerExternalElicitation(input);
  const body = rpcResultBody(response);
  if (response.status < 200 || response.status >= 300) {
    const error = body && typeof body === "object" && "error" in body
      ? String(body.error)
      : "external_elicitation_answer_failed";
    throw new Error(error);
  }
  return ExternalMessageAdmissionResultSchema.parse(body);
}

export async function launchWorkstreamHarness(
  env: Env,
  input: {
    workspaceId: WorkspaceId;
    workstreamId: WorkstreamId;
    triggerMessageId: string | null;
    /**
     * The newest message the run may see, when that is not the trigger. Only
     * `retry` sets it; see the field's contract for why the two come apart.
     */
    transcriptFenceMessageId?: string | null;
    origin: string;
    executionPrincipal: ExecutionPrincipal;
    slackOrigin?: SlackOriginContext;
    slackSearchAuthorization?: SlackSearchAuthorization;
    parentHarnessRunId?: string;
    telemetryOperationId?: string;
    telemetrySubjectUserId?: string;
    /** Admit only while this is still the latest participant-facing run. */
    expectedLatestHarnessRunId?: string;
    scheduledWakeupId: string;
    /** The conversation to run in. */
    conversation: WakeupConversation;
    /** A Sidekick run child's run, as `continueSidekickRun` answered for it. */
    automationRun?: WorkstreamWorkflowInput["automationRun"];
    automationContinuation?: WorkstreamWorkflowInput["automationContinuation"];
  },
  publishEvent: typeof publishWorkstreamEvent = publishWorkstreamEvent,
): Promise<string> {
  const executionEnv = env;
  const { parentKind, substreamId, backgroundAgent } = input.conversation;
  const id = await stableActivationRunId(input);
  const at = nowIso();
  const executionPrincipalJson = JSON.stringify(input.executionPrincipal);
  const model = await scheduledWorkstreamModelForExisting(executionEnv, {
    workspaceId: input.workspaceId,
    workstreamId: input.workstreamId,
    ...conversationModelContext({ parentKind, backgroundAgent: backgroundAgent === true, automationRun: input.automationRun }, substreamId),
  });
  const runs = createHarnessRunObjectPort(
    executionEnv,
    input.workspaceId,
    input.workstreamId,
    undefined,
    substreamId,
  );
  const admission = await runs.admitRun({
    runId: id,
    origin: input.origin,
    executionPrincipalJson,
    status: "running",
    startedAt: Date.parse(at),
    model,
    // Stored, not merely passed to the Workflow: it is what `retry` replays
    // against, and reconstructing it later is a guess that gets the answer
    // wrong for every run whose trigger was not the newest human message.
    triggerPartId: input.triggerMessageId,
    parentRunId: input.parentHarnessRunId ?? null,
    expectedLatestRunId: input.expectedLatestHarnessRunId ?? null,
    now: Date.parse(at),
  });
  if (admission.outcome === "stale") {
    throw new ApiError(409, "terminal_repository_request_stale", "A newer run replaced this Terminal repository request. Reload the thread before continuing.");
  }
  if (admission.outcome === "exists") {
    const existing = await runs.run({ runId: id });
    if (!existing) throw new Error("substream_loop_execution_receipt_not_found");
    if (existing.origin !== input.origin
      || existing.execution_principal_json !== executionPrincipalJson
      || existing.trigger_part_id !== input.triggerMessageId
      || existing.parent_run_id !== (input.parentHarnessRunId ?? null)) {
      throw new Error("substream_loop_execution_replay_mismatch");
    }
    // The stable source receipt is the idempotency answer even after its loop
    // cycle finished. Re-arming a terminal receipt is both impossible and
    // unnecessary; the caller is retrying admission, not asking for a new turn.
    if (existing.terminalized_at !== null) return id;
  }
  const workflowInput: WorkstreamWorkflowInput = {
    region: env.AVALON_REGION,
    workspaceId: input.workspaceId,
    parentKind,
    parentId: input.workstreamId,
    ...(substreamId === "0" ? {} : { substreamId }),
    loopId: substreamLoopId(input.workstreamId, substreamId),
    harnessRunId: id,
    triggerMessageId: input.triggerMessageId,
    activityId: null,
    executionPrincipal: input.executionPrincipal,
    ...(input.transcriptFenceMessageId
      ? { transcriptFenceMessageId: input.transcriptFenceMessageId }
      : {}),
    ...(input.scheduledWakeupId ? { scheduledWakeupId: input.scheduledWakeupId } : {}),
    ...(input.automationRun ? { automationRun: input.automationRun } : {}),
    ...(input.automationContinuation ? { automationContinuation: input.automationContinuation } : {}),
    // As the message path derives it: a delegated worker's run uses its
    // owner's sandbox and reports to its owner rather than publishing.
    ...(backgroundAgent ? { backgroundAgent: true } : {}),
    ...(input.telemetryOperationId && input.telemetrySubjectUserId ? {
      telemetryOperationId: input.telemetryOperationId,
      telemetrySubjectUserId: input.telemetrySubjectUserId,
    } : {}),
    ...(input.slackOrigin ? { slackOrigin: input.slackOrigin } : {}),
    ...(input.slackSearchAuthorization
      ? { slackSearchAuthorization: input.slackSearchAuthorization }
      : {}),
    reason: input.origin,
  };
  try {
    await activateWorkstreamLoop(env, workflowInput);
  } catch (error) {
    const diagnosticMessage = error instanceof Error ? error.message : "Workflow start failed";
    logStructuredEvent(env, "error", "workstream_harness_launch_failed", {
      request_id: id,
      workspace_id: input.workspaceId,
      workstream_id: input.workstreamId,
      origin: input.origin,
      execution_principal_type: input.executionPrincipal.type,
      error_name: error instanceof Error ? error.name : "UnknownError",
      error_message: diagnosticMessage,
    });
    // Once the subordinate receipt commits, the caller must replay this same
    // stable activation. Terminalizing it here would race the alarm that may
    // already own it and recreate the exact split authority this cutover
    // removes.
    if (loopActivationWasRecorded(error)) throw error;
    const memberSafeError = memberSafeHarnessError({ code: "workflow_unavailable" })
      ?? GENERIC_MEMBER_SAFE_HARNESS_ERROR;
    // Through the object's own authority like the admission above: the run row
    // lives there, and the operation commits the sidebar's projection with the
    // failure rather than as a second statement that could be lost inside this
    // very catch handler.
    const failed = await createHarnessRunObjectPort(executionEnv, input.workspaceId, input.workstreamId,
      undefined, substreamId)
      .terminalizeQueuedRun({
        runId: id,
        attemptId: `unlaunched:${id}`,
        status: "failed",
        errorJson: JSON.stringify(memberSafeError),
        memberSafePayloadJson: JSON.stringify({ code: memberSafeError.code }),
        lifecycleEventId: newId(),
        loopExecutionFence: null,
        now: Date.now(),
      });
    if (failed.outcome === "not_found" || failed.outcome === "ownership_lost") {
      throw new Error("workstream_unlaunched_run_failure_fenced", { cause: error });
    }
    emitCorrelatedRunOutcome(executionEnv, {
      workspaceId: input.workspaceId,
      parentId: input.workstreamId,
      harnessRunId: id,
      telemetryOperationId: input.telemetryOperationId,
      telemetrySubjectUserId: input.telemetrySubjectUserId,
    });
    // The work stream and its run exist whatever the caller does with the 503,
    // so anyone already watching is told the run failed rather than left on a
    // `running` row that nothing will move.
    await publishEvent(env, input.workspaceId, input.workstreamId, {
      type: "harness_status_changed",
      status: "failed",
    }, substreamId);
    // Carried onto the member-safe error so a caller that cleans up after a
    // failed launch can tell "nothing started" from "started, and only the
    // record of it failed". The run row above is `failed` either way, so it
    // cannot answer that question and must not be read as if it could.
    // The member-safe error carries forward whether an instance is live, so a
    // caller undoing its own preparation is answering the right question.
    const memberSafe = new ApiError(503, "workflow_unavailable", "The Rally harness could not be started");
    throw memberSafe;
  }
  await publishEvent(env, input.workspaceId, input.workstreamId, {
    type: "harness_status_changed",
    status: "running",
  }, substreamId);
  return id;
}

async function stableActivationRunId(input: {
  workspaceId: WorkspaceId;
  workstreamId: WorkstreamId;
  scheduledWakeupId: string;
}): Promise<ReturnType<typeof asHarnessRunId>> {
  const source = ["scheduled_wakeup", input.scheduledWakeupId];
  const seed = new TextEncoder().encode(JSON.stringify([
    "rally-persistent-loop-activation-v1",
    input.workspaceId,
    input.workstreamId,
    ...source,
  ]));
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", seed));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes.slice(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return asHarnessRunId(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
}

/**
 * Which of a parent's conversations a wake-up belongs to.
 *
 * A wake-up lives in, and runs in, the conversation whose run scheduled it: a
 * Breakout's wake-up running in Main would write a private Breakout's prompt
 * into Main's transcript, and a Sidekick run's wake-up continues that run.
 */
export interface WakeupConversation {
  parentKind: ConversationParentKind;
  substreamId: SubstreamId | "0";
  /** This conversation's delegated-worker state, from its `background_agent` row. */
  backgroundAgent: "stopped" | boolean;
}

/**
 * Start the run one due wake-up asked for.
 *
 * Called by the owning conversation object's alarm. The order is deliberate:
 * claim the row, re-check the authority that scheduled it, note it in the
 * transcript, and only then launch. A claim that cannot reach a running
 * harness is released so the next alarm retries it; a claim that is refused
 * because the workspace has since revoked the principal stays consumed,
 * because retrying it would only fail again.
 */
export async function fireWorkstreamWakeup(
  env: Env,
  row: WorkstreamWakeupRow,
  /**
   * The scheduling authority to claim through.
   *
   * Passed in rather than derived from `env` so a test can stand where the
   * owning object stands. Every caller — including the object's own alarm —
   * hands it a port over the endpoint, because the endpoint is what commits the
   * claim together with the sidebar projection it invalidates.
   */
  scheduling: SchedulingObjectPort,
  /** The conversation the wake-up belongs to, and where its run starts. */
  conversation: WakeupConversation,
): Promise<{ fired: boolean; harnessRunId?: string }> {
  if (!await claimDueWorkstreamWakeup(scheduling, row)) return { fired: false };

  // Everything after the claim runs under one release-on-throw path. A claim is
  // only safe to hold if every way out of this function either starts a run or
  // hands the row back: once the row leaves `pending` the scheduler's own retry
  // gate is useless, because `refresh()` no longer sees it as a due target.
  // Returning `fired: false` below is the deliberate exception — those are
  // decisions, not failures, and retrying them would only reach the same answer.
  try {
    const principal = wakeupExecutionPrincipal(row);
    const workstream = await createIdentityObjectPort(
      env, row.workspace_id, row.workstream_id, undefined, conversation.substreamId,
    ).identity();
    if (!workstream || workstream.archived_at !== null) {
      // The work stream this wake-up belongs to is gone. Leave the row claimed:
      // there is nothing left to wake, and a retry cannot change that.
      return { fired: false };
    }
    if (!await wakeupPrincipalStillAuthorized(env, row.workspace_id, principal)) {
      return { fired: false };
    }
    // A stopped worker admits nothing new, and its wake-ups stay consumed.
    if (conversation.backgroundAgent === "stopped") return { fired: false };
    // A Sidekick run child runs only as its Sidekick allows, the same question
    // a member's message there asks. A refusal — paused, archived, run-as
    // changed — stays consumed like a revoked principal: a retry gets the same
    // answer.
    let continuation: Extract<Awaited<ReturnType<typeof continueSidekickRun>>, { outcome: "continue" }> | null = null;
    if (conversation.parentKind === "automation" && conversation.substreamId !== "0") {
      const decided = await continueSidekickRun(env, {
        region: env.AVALON_REGION,
        workspaceId: row.workspace_id,
        automationId: row.workstream_id,
        runId: conversation.substreamId,
      });
      if (decided.outcome === "refused") return { fired: false };
      continuation = decided;
    }

    await appendWakeupSystemMessage(env, row, conversation.substreamId);

    const harnessRunId = await launchWorkstreamHarness(env, {
      workspaceId: asWorkspaceId(row.workspace_id),
      workstreamId: asWorkstreamId(row.workstream_id),
      triggerMessageId: null,
      origin: "scheduled_wakeup",
      executionPrincipal: continuation?.executionPrincipal ?? principal,
      scheduledWakeupId: row.id,
      conversation,
      ...(continuation
        ? {
            automationRun: continuation.automationRun,
            automationContinuation: {
              stopGeneration: continuation.stopGeneration,
              senderName: "Rally",
              source: { kind: "run" as const },
            },
          }
        : {}),
    });
    return { fired: true, harnessRunId };
  } catch (error) {
    // Nothing durable ran, so the wake-up has not happened. Hand it back to the
    // scheduler's retry backoff rather than consuming it. A failure to release
    // must not replace the diagnosis of what actually went wrong.
    await releaseClaimedWorkstreamWakeup(scheduling, row).catch(() => undefined);
    throw error;
  }
}

/** The same membership rule the harness applies, checked again at fire time. */
async function wakeupPrincipalStillAuthorized(
  env: Pick<Env, "DB">,
  workspaceId: string,
  principal: ExecutionPrincipal,
): Promise<boolean> {
  if (principal.type === "workspace") {
    if (principal.workspaceId !== workspaceId) return false;
    const workspace = await env.DB.prepare("SELECT id FROM workspaces WHERE id = ?")
      .bind(workspaceId).first<{ id: string }>();
    return workspace !== null;
  }
  const member = await env.DB.prepare(
    `SELECT status FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
  ).bind(workspaceId, principal.userId).first<{ status: string }>();
  return member?.status === "active";
}

const WAKEUP_PROMPT_PREVIEW_LENGTH = 300;

/**
 * Shorten a wake-up prompt for its transcript row.
 *
 * Break on a word boundary and mark the cut. A hard slice ends mid-word, which
 * reads as a rendering bug rather than as a summary of something longer, and
 * the full prompt is the run's own trigger anyway.
 */
function wakeupPromptPreview(prompt: string): string {
  const collapsed = prompt.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= WAKEUP_PROMPT_PREVIEW_LENGTH) return collapsed;
  const clipped = truncateUtf16Safe(collapsed, WAKEUP_PROMPT_PREVIEW_LENGTH);
  const lastSpace = clipped.lastIndexOf(" ");
  const wordSafe = lastSpace > WAKEUP_PROMPT_PREVIEW_LENGTH / 2
    ? clipped.slice(0, lastSpace)
    : clipped;
  return `${wordSafe.replace(/[\s,.;:]+$/u, "")}…`;
}

/**
 * Put the wake-up in the human transcript.
 *
 * The model reads the prompt through the run's trigger context, not this row —
 * system rows are deliberately UI state — so this exists to answer the question
 * a person opening the work stream will have: why did this start on its own?
 */
async function appendWakeupSystemMessage(
  env: Env,
  row: WorkstreamWakeupRow,
  substreamId: SubstreamId | "0",
): Promise<void> {
  const clientMessageId = `wakeup:${row.id}`;
  const messages = createMessageObjectPort(env, row.workspace_id, row.workstream_id, undefined, substreamId);
  // The insert and the counter it consumed were a two-statement batch: one of
  // them advanced `next_attention_ordinal` inside the retired view's trigger
  // and the other advanced `next_sequence_number` here. One operation now.
  // The object port publishes the canonical turn only when this append wins;
  // a replay returns the same identity without broadcasting it a second time.
  await messages.appendMessage({
    messageId: newId(),
    clientMessageId,
    authorType: "system",
    authorUserId: null,
    externalActorJson: null,
    messageType: "system",
    text: `Rally woke this thread up as scheduled: ${wakeupPromptPreview(row.prompt)}`,
    structuredContentJson: null,
    producedByRunId: null,
    now: Date.now(),
  });
}

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** A Thread's Main or one of its Breakouts, as a review scope. */
function conversationMemoryScope(id: string, substreamId: string): MemoryReviewScope {
  return { kind: "conversation", conversation: { parentKind: "workstream", parentId: id, substreamId } };
}

/**
 * The regional face of the work-stream product surface.
 *
 * Every product-state method delegates to the Durable-Object authority: the
 * object client for an existing work stream, the object creation coordinator
 * for a new one. The pre-cutover D1 execution arms were removed once production
 * opened the authority in both regions — a stack that has not run
 * `pnpm db:open-authority` gets a 503 refusal, never legacy code.
 *
 * What legitimately remains on regional D1 here is routing and identity. The
 * cross-workstream directory, viewer state, and pins are WorkspaceDO product
 * state and are reached through {@link WorkstreamDirectoryService}.
 */
export class WorkstreamService {
  constructor(
    private readonly env: Env,
    private readonly auth: AuthContext,
    private readonly defer?: (promise: Promise<unknown>) => void,
  ) {}

  /** The object client for an existing Channel. */
  private async authoritativeClient(id: string): Promise<WorkstreamObjectClient> {
    return new WorkstreamObjectClient(this.env, this.auth, id);
  }

  async create(
    input: CreateWorkstreamInput,
    slackOrigin?: SlackOriginContext,
    slackSearchAuthorization?: SlackSearchAuthorization,
    /** The external thread this Channel is created for; see `CreateOptions.externalBinding`. */
    externalBinding?: ExternalBindingClaim,
  ) {
    // `input.scope` travels with the rest of the input rather than being read
    // off and re-stated: the connector ingresses decide it from the conversation
    // they read the prompt out of, and a public channel's thread seats no
    // participants — so a create that lost `workspace` on the way through would
    // hand that channel a work stream none of its members could open.
    const created = await new WorkstreamObjectCreationService(this.env, this.auth, this.defer).create(input, {
      executionPrincipal: { type: "user", userId: this.auth.userId },
      ...(slackOrigin ? { slackOrigin } : {}),
      ...(slackSearchAuthorization ? { slackSearchAuthorization } : {}),
      ...(input.telemetryOperationId ? { telemetryOperationId: input.telemetryOperationId } : {}),
      ...(externalBinding ? { externalBinding } : {}),
    });
    // The origin is a convenience on top of the work stream, never the reason
    // a create fails: the person's request has already produced a work stream
    // and a run, and a connection that vanished mid-flight must not turn that
    // success into an error. Same contract `attachWorkstreamOriginResource`
    // keeps for the ingress paths.
    if (input.originResource) {
      try {
        const resourceId = await resolveOriginResource(this.env, this.auth.workspaceId, input.originResource);
        if (resourceId) await new WorkstreamObjectClient(this.env, this.auth, created.workstream.id)
          .attachResource(resourceId);
      } catch (error) {
        logWarn(this.env, "workstream_origin_resource_attach_failed", {
          workspace_id: this.auth.workspaceId,
          workstream_id: created.workstream.id,
          provider: input.originResource.provider,
          resource_type: input.originResource.resourceType,
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
    }
    return created;
  }

  /**
   * `audienceScope` is the suggestion's own audience, carried onto the work
   * stream rather than left to the private default.
   *
   * A suggestion is shown before it is started, and a `workspace` one was shown
   * to everybody: whoever presses start claims it, and every other member who
   * was looking at it is answered `work_opportunity_already_claimed`. Landing
   * that on `personal` would take the work away from the people Avalon had just
   * offered it to — the same mistake as reading a public channel's thread as one
   * person's. A `personal` suggestion was only ever shown to its owner and stays
   * theirs.
   */
  async createFromOpportunity(input: {
    opportunityId: string;
    version: number;
    displayPrompt: string;
    executionPrompt: string;
    displayPromptHash: string;
    executionPromptHash: string;
    idempotencyKey: string;
    audienceScope: Scope;
  }) {
    const originResourceIds = await this.resolveDurableOpportunityOriginResources(input.opportunityId);
    return new WorkstreamObjectCreationService(this.env, this.auth, this.defer).create({
      objective: input.displayPrompt,
      openingMessage: input.executionPrompt,
      clientMessageId: `opportunity:${input.opportunityId}:v${input.version}`,
      participantUserIds: [],
      attachmentIds: [],
      descriptionSource: "derived",
      scope: input.audienceScope,
    }, {
      openingStructuredContent: {
        kind: "suggested_work_expansion",
        label: "Expanded by Avalon from suggested work",
        opportunityId: input.opportunityId,
        opportunityVersion: input.version,
      },
      opportunitySnapshot: {
        opportunityId: input.opportunityId,
        version: input.version,
        displayPromptHash: input.displayPromptHash,
        executionPromptHash: input.executionPromptHash,
      },
      originResourceIds,
      reason: "work_opportunity",
    });
  }

  private async requireSidekickParticipant(id: string, substreamId: string): Promise<void> {
    const participants = await createIdentityObjectPort(this.env, this.auth.workspaceId, id, undefined, substreamId).participants();
    if (!participants.some((person) => person.user_id === this.auth.userId)) {
      throw new ApiError(403, "sidekick_attachment_forbidden", "Only participants can change Sidekick attachments");
    }
  }

  async sidekickAttachments(id: string, removeId?: string, substreamId = "0"): Promise<{ items: SidekickAttachment[] }> {
    const conversation = new ConversationService(this.env, this.auth);
    if (removeId) await conversation.writableClient(id, substreamId);
    else await conversation.client(id, false, substreamId);
    if ((await conversation.resolveParent(id)).kind !== "workstream") {
      throw new ApiError(422, "sidekick_attachment_parent_kind_unsupported", "Sidekick attachments belong to threads");
    }
    if (removeId) await this.requireSidekickParticipant(id, substreamId);
    const agent = await durableObjectStubForWorkspace(this.env, this.env.SUBSTREAM_AGENTS,
      asWorkspaceId(this.auth.workspaceId), conversationObjectName(this.env.AVALON_REGION, asWorkspaceId(this.auth.workspaceId), id, asSubstreamId(substreamId)));
    const ids = await agent.sidekickAttachments({ workspaceId: this.auth.workspaceId, workstreamId: id, auth:{ sessionId:this.auth.sessionId,userId:this.auth.userId,
      workspaceId:this.auth.workspaceId,region:this.auth.region,role:this.auth.role,
      ...(this.auth.principal ? { principal:this.auth.principal } : {}),
    }, ...(removeId ? { removeId } : {}) });
    const items = await this.conversationSidekickSummaries(id,substreamId,{ automationIds:ids });
    await conversation.client(id,false,substreamId);
    if (removeId) await publishWorkspaceSync(this.env,this.auth.workspaceId,["automations"]);
    return { items };
  }

  /**
   * What Rally remembers about this Thread (`substreamId` `"0"`) or one of its
   * Breakouts, as this person may see it from inside. `WorkspaceDO` checks the
   * conversation is open to them in the same read and answers one they may not
   * open as not found, so there is no separate admission round trip.
   */
  getConversationMemory(id: string, substreamId = "0"): Promise<MemoryReview> {
    return readMemoryReview(this.env, this.auth, conversationMemoryScope(id, substreamId));
  }

  /** Anyone who may open the conversation removes its own facts; see `mayForget`. */
  forgetConversationMemory(id: string, factId: string, substreamId = "0"): Promise<MemoryForgetResponse> {
    return forgetReviewedMemory(this.env, this.auth, conversationMemoryScope(id, substreamId), factId);
  }

  /**
   * Rail metadata for the Sidekicks a conversation's audience may see. One
   * Organization call answers every Sidekick at once, by id or by the Channel
   * that recommends or owns them, after one read of who the audience is.
   */
  private async conversationSidekickSummaries(id: string, substreamId: string,
    selection: { automationIds?: readonly string[]; channelId?: string; onlyScope?: "workspace" }): Promise<SidekickAttachment[]> {
    if (selection.channelId === undefined && (selection.automationIds?.length ?? 0) === 0) return [];
    const port = createIdentityObjectPort(this.env,this.auth.workspaceId,id,undefined,substreamId);
    const [identity,participants,workspace] = await Promise.all([port.identity(),port.participants(),
      hostedParentStub(this.env,this.auth.workspaceId)]);
    if (!identity) throw new ApiError(404,"workstream_not_found","Conversation not found");
    return workspace.sidekickReadSkillSummaries({ workspaceId:asWorkspaceId(this.auth.workspaceId),
      ...(selection.automationIds ? { automationIds:[...selection.automationIds] } : {}),
      ...(selection.channelId ? { channelId:selection.channelId } : {}),
      ...(selection.onlyScope ? { onlyScope:selection.onlyScope } : {}),
      principalUserId:asUserId(this.auth.userId),conversationParentId:id,
      audienceScope:identity.scope === "workspace" ? "workspace" : "personal",
      audienceUserIds:participants.map((person) => asUserId(person.user_id)),
    });
  }

  async recommendedSidekicks(id: string, substreamId = "0"): Promise<{ items: SidekickAttachment[] }> {
    const conversation = new ConversationService(this.env,this.auth);
    const parent = await conversation.authorizeViewer(id, substreamId);
    if (parent.kind !== "workstream") {
      throw new ApiError(422,"sidekick_attachment_parent_kind_unsupported","Sidekick recommendations belong to threads");
    }
    const items = await this.conversationSidekickSummaries(id,substreamId,{ channelId:id });
    await conversation.client(id,false,substreamId);
    return { items };
  }

  /** Call after exact-conversation admission; these IDs do not themselves grant access. */
  private async conversationSidekickIds(id: string, substreamId: string) {
    const [workspace, child] = await Promise.all([
      hostedParentStub(this.env, this.auth.workspaceId),
      durableObjectStubForWorkspace(this.env, this.env.SUBSTREAM_AGENTS, this.auth.workspaceId,
        conversationObjectName(this.env.AVALON_REGION, this.auth.workspaceId, id, asSubstreamId(substreamId))),
    ]);
    const [recommended, owned, loaded] = await Promise.all([
      workspace.recommendedSidekickIds({ workspaceId: this.auth.workspaceId, parentId: id }),
      workspace.automationIdsOwnedByWorkstream({ workspaceId: this.auth.workspaceId, workstreamId: id }),
      child.sidekickAttachments({ workspaceId: this.auth.workspaceId, workstreamId: id }),
    ]);
    return conversationSidekickCandidateIds([...recommended, ...owned.automationIds], loaded);
  }


  /** One capability/catalog decision for browser controls and person-authorized tools. */
  async sidekickRecommendationOptions(id: string, substreamId = "0"): Promise<SidekickRecommendationOptions> {
    const conversation = new ConversationService(this.env, this.auth);
    const parent = await conversation.authorizeViewer(id, substreamId);
    if (parent.kind !== "workstream") {
      throw new ApiError(422, "sidekick_attachment_parent_kind_unsupported", "Sidekick recommendations belong to threads");
    }
    const relationship = await readWorkspaceRelationship(this.env.DB, this.auth.workspaceId, this.auth.userId);
    if (relationship?.status !== "active") throw new ApiError(403, "workspace_membership_required", "Workspace access is required");
    const room = await hostedParentStub(this.env, this.auth.workspaceId);
    // Both reads are of this Channel's own rows; neither waits on the other.
    const [recommended, management] = await Promise.all([
      room.recommendedSidekickIds({ workspaceId: this.auth.workspaceId, parentId: id }),
      room.readManagementAccess({ workspaceId: this.auth.workspaceId, parentId: id, userId: this.auth.userId }),
    ]);
    const explicit = new Set(recommended);
    let sources: SidekickAttachment[];
    if (relationship.accessClass === "member") {
      sources = (await new AutomationService(this.env, this.auth).listSidekicks()).items
        .filter((item) => item.scope === "workspace")
        .map((item) => ({ id: item.id, name: item.name, description: item.description,
          available: item.status === "active" && item.loadable }));
    } else {
      // A guest is offered only Organization Sidekicks already in reach of
      // this conversation: the Channel's own and the ones it has loaded.
      const child = await durableObjectStubForWorkspace(this.env, this.env.SUBSTREAM_AGENTS, this.auth.workspaceId,
        conversationObjectName(this.env.AVALON_REGION, this.auth.workspaceId, id, asSubstreamId(substreamId)));
      sources = await this.conversationSidekickSummaries(id, substreamId, {
        automationIds: await child.sidekickAttachments({ workspaceId: this.auth.workspaceId, workstreamId: id }),
        channelId: id, onlyScope: "workspace",
      });
    }
    await conversation.client(id, false, substreamId);
    const current = await readWorkspaceRelationship(this.env.DB, this.auth.workspaceId, this.auth.userId);
    if (current?.status !== "active" || current.incarnation !== relationship.incarnation || current.accessClass !== relationship.accessClass) {
      throw new ApiError(403, "workspace_membership_changed", "Workspace access changed. Refresh and try again.");
    }
    return { canManage: management.allowed && management.writable,
      items: sources.map((item) => ({ ...item, attached: explicit.has(item.id) })) };
  }

  async setSidekickRecommendation(id: string, sidekickId: string, attached: boolean, substreamId = "0",
    /** Host-supplied execution context only; never accepted from a REST request. */
    backgroundExecution?: Pick<WorkstreamWorkflowInput, "backgroundAgent" | "parentKind" | "workspaceId" | "parentId" | "substreamId" | "executionPrincipal">,
  ): Promise<{ items: SidekickAttachment[] }> {
    const visibleSubstreamId = backgroundExecution ? "0" : substreamId;
    await new ConversationService(this.env, this.auth).writableClient(id, visibleSubstreamId);
    const room = await hostedParentStub(this.env, this.auth.workspaceId);
    // Management access is checked once, by `room.setSidekickRecommendation`
    // below, in the same call that writes the recommendation. Asking the room
    // first as well cost a second round trip for the same answer.
    const backgroundAgent = backgroundExecution ? await durableObjectStubForWorkspace(this.env, this.env.SUBSTREAM_AGENTS,
      this.auth.workspaceId, conversationObjectName(this.env.AVALON_REGION, this.auth.workspaceId, id, asSubstreamId(substreamId))) : null;
    if (backgroundExecution && backgroundAgent) {
      const runtime = await backgroundAgent.agentRuntimeInfo();
      const identity = await createIdentityObjectPort(this.env, this.auth.workspaceId, id, undefined, substreamId).identity();
      if (!backgroundExecution.backgroundAgent || backgroundExecution.parentKind !== "workstream"
        || backgroundExecution.workspaceId !== this.auth.workspaceId || backgroundExecution.parentId !== id
        || backgroundExecution.substreamId !== substreamId || substreamId === "0"
        || backgroundExecution.executionPrincipal.type !== "user" || backgroundExecution.executionPrincipal.userId !== this.auth.userId
        || !runtime?.background || runtime.status === "stopped" || runtime.executionPrincipal?.type !== "user"
        || runtime.executionPrincipal.userId !== this.auth.userId || !identity || identity.archived_at !== null) {
        throw new ApiError(403, "sidekick_attachment_execution_forbidden", "This agent cannot change Sidekick attachments");
      }
    }
    // Check both authorities before the shared delete: a viewer of a child
    // must not remove the recommendation and then fail its local removal.
    if (backgroundExecution || (!attached && substreamId !== "0")) await this.requireSidekickParticipant(id, substreamId);
    if (attached) {
      const relationship = await readWorkspaceRelationship(this.env.DB, this.auth.workspaceId, this.auth.userId);
      if (relationship?.accessClass === "guest") {
        if (!(await this.conversationSidekickIds(id, visibleSubstreamId)).has(sidekickId)) {
          throw new ApiError(403, "sidekick_attachment_forbidden", "Choose a Sidekick already available in this conversation");
        }
      }
    }
    // The write checks the Sidekick too: it must exist and belong to the
    // Organization. Recommendation needs that eligibility, not permission to
    // read its authoring conversation or run history.
    try {
      await room.setSidekickRecommendation({ workspaceId: this.auth.workspaceId, parentId: id, userId: this.auth.userId, sidekickId, attached });
    } catch (error) {
      if (error instanceof Error && error.message === "sidekick_not_found") {
        throw new ApiError(404, "sidekick_not_found", "Sidekick not found");
      }
      if (error instanceof Error && error.message === "sidekick_attachment_scope_invalid") {
        throw new ApiError(422, "sidekick_attachment_scope_invalid", "Choose a workspace Sidekick");
      }
      if (error instanceof Error && error.message === "sidekick_attachment_participant_required") {
        throw new ApiError(403, "sidekick_attachment_forbidden", "Thread management access is required");
      }
      if (error instanceof Error && error.message === "sidekick_attachment_workstream_archived") {
        throw new ApiError(409, "sidekick_attachment_workstream_archived", "The thread is archived");
      }
      throw error;
    }
    if (!attached) {
      if (backgroundAgent) await backgroundAgent.sidekickAttachments({ workspaceId: this.auth.workspaceId, workstreamId: id, removeId: sidekickId });
      else await this.sidekickAttachments(id, sidekickId, substreamId);
    }
    // Both REST and agent tools use this service; every open rail needs the
    // same shared recommendation change, even on an idle sibling substream.
    // Local removal already publishes its refresh through sidekickAttachments.
    if (attached || backgroundAgent) await publishWorkspaceSync(this.env, this.auth.workspaceId, ["automations"]);
    return this.recommendedSidekicks(id, visibleSubstreamId);
  }

  async get(id: string): Promise<WorkstreamDetail> {
    return (await this.authoritativeClient(id)).get();
  }


  /**
   * Change the Channel. Its scope is its own to widen or narrow: a Space grants
   * no reader, so nothing else has to agree.
   */
  async update(id: string, input: UpdateWorkstreamInput) {
    const client = await this.authoritativeClient(id);
    if (input.scope === undefined) return client.update(input);
    // Read before the write: whether this narrows is a question about the
    // audience the Channel actually had, which only the conversation knows.
    const before = await client.get();
    const result = await client.update(input);
    // The room closes its own sockets for somebody it was told about, and a
    // narrowing tells it about nobody: the readers it drops are every member
    // who is not a participant. So the write publishes it, in the same
    // request, exactly as `removeParticipant` does, and only once the
    // canonical update took, because until then nothing has narrowed.
    //
    // Named rather than thrown: there is nothing durable to retry from, and a
    // send that does not leave is the open gap recorded in
    // `docs/access-revocation.md` rather than something half-built here.
    if (input.scope === "personal" && before.scope === "workspace"
      && !await publishChannelNarrowing(this.env, asWorkspaceId(this.auth.workspaceId), id)) {
      logWarn(this.env, "channel_narrowing_publish_unannounced", {
        workstream_id: id,
        workspace_id: this.auth.workspaceId,
      });
    }
    return result;
  }

  /** Main's read state, by hand, from the sidebar, where the row's dot is Main's. */
  async markUnread(id: string) {
    return (await this.authoritativeClient(id)).markUnread();
  }

  async createMessage(
    id: string,
    input: CreateMessageInput,
    slackOrigin?: SlackOriginContext,
    slackSearchAuthorization?: SlackSearchAuthorization,
  ) {
    return (await this.authoritativeClient(id)).createMessage({
      ...input,
      ...(slackOrigin ? { slackOrigin } : {}),
      ...(slackSearchAuthorization ? { slackSearchAuthorization } : {}),
    });
  }

  /** Add a reader on the Channel's own account; no Space withdraws one. */
  async addParticipant(id: string, userId: string) {
    return (await this.authoritativeClient(id)).addParticipant(userId);
  }

  /**
   * Take a reader out of the Channel.
   *
   * The `projectEffect` flag this used to take is gone with the rule it
   * selected: a Project owned its member work streams' audiences and had to
   * exempt its own fan-out from them. A Space supplies no reader, so a removal
   * here is simply the Channel losing one.
   */
  async removeParticipant(id: string, userId: string): Promise<void> {
    const accessLost = await new ChannelAccessService(this.env, this.auth)
      .removeDirectReader(id, userId);
    // The room closes its own sockets for the person it just removed. The
    // automations it owns admitted them through the room, and nothing in the
    // room reaches those objects, so this is where the retraction is
    // published: whoever writes the fact publishes it, in the same request.
    if (!accessLost) return;
    await publishAccessRevocation(this.env, {
      reason: "workstream_participant_removed",
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId,
      sessionId: null,
      target: { scope: "workstream_automations", workstreamId: id },
    });
  }

  async attachResource(id: string, resourceId: string) {
    return (await this.authoritativeClient(id)).attachResource(resourceId);
  }

  async detachResource(id: string, resourceId: string): Promise<void> {
    return (await this.authoritativeClient(id)).detachResource(resourceId);
  }

  async answerElicitation(
    id: string,
    elicitationId: string,
    input: AnswerElicitationInput,
    slackOrigin?: SlackOriginContext,
  ) {
    return (await this.authoritativeClient(id)).answerElicitation(elicitationId, input, slackOrigin);
  }

  async workstreamControlSocketTicket(id: string) {
    await this.requireVisibleWorkstream(id);
    const ticket = await issueWorkstreamControlSocketTicket(this.env, this.auth, id);
    const url = new URL(this.env.PUBLIC_API_BASE_URL);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/socket/workstreams/${id}`;
    url.search = "";
    return { url: url.toString(), ticket };
  }

  /** Gate socket credentials on WorkspaceDO's authoritative viewer state. */
  private async requireVisibleWorkstream(id: string): Promise<void> {
    if (!await new WorkstreamDirectoryService(this.env, this.auth).visible(id)) {
      throw new ApiError(404, "workstream_not_found", "Thread not found");
    }
  }

  /**
   * Resolve WorkspaceDO-owned provenance before initialize starts the first run.
   *
   * SubstreamAgent enqueues the Workflow inside the initialize RPC, so attaching
   * these after creation would race the run's first context read. WorkspaceDO
   * returns only roots visible to this member; this second check deliberately
   * keeps restricted connector objects out of a workspace-visible resource list.
   */
  private async resolveDurableOpportunityOriginResources(opportunityId: string): Promise<string[]> {
    try {
      const workspace = await durableObjectStubForWorkspace(
        this.env,
        this.env.WORKSPACE_DOS,
        this.auth.workspaceId,
        workspaceDOName(this.env.AVALON_REGION, this.auth.workspaceId),
      );
      const events = WorkspaceOpportunityOriginEventsResultSchema.parse(
        await workspace.opportunityOriginEvents({
          workspaceId: this.auth.workspaceId,
          userId: this.auth.userId,
          opportunityId,
          now: nowIso(),
          limit: MAX_OPPORTUNITY_ORIGIN_RESOURCES,
        }),
      );
      const resourceIds: string[] = [];
      for (const event of events) {
        const activity = event.activity;
        if (!activityIsWorkspaceVisible({
          connection_scope: activity.connectionScope,
          connection_owner_user_id: activity.connectionOwnerUserId,
          target_user_ids_json: JSON.stringify(activity.targetUserIds),
          visibility_json: JSON.stringify(activity.visibility),
        })) continue;
        const descriptor = await describeWorkstreamOrigin(this.env, {
          connectorType: event.connectorType,
          connectionId: activity.connectionId,
          provider: activity.provider,
          locator: activityOriginLocator({
            resource_type: activity.resourceType,
            provider_resource_id: activity.providerResourceId,
            title: activity.title,
            metadata_json: JSON.stringify(activity.metadata),
          }),
        });
        if (!descriptor) continue;
        const resourceId = await resolveOriginResource(this.env, this.auth.workspaceId, descriptor);
        if (resourceId && !resourceIds.includes(resourceId)) resourceIds.push(resourceId);
      }
      return resourceIds;
    } catch (error) {
      logWarn(this.env, "workstream_opportunity_origin_resolve_failed", {
        workspace_id: this.auth.workspaceId,
        opportunity_id: opportunityId,
        reason: error instanceof Error ? error.message : "unknown",
      });
      return [];
    }
  }
}

export const __workstreamServiceTesting = {
  memberSafeHarnessError,
};

/**
 * The run failure a member may be shown, or null when there is none.
 *
 * Exported because the work-stream room's snapshot has to describe the latest
 * run exactly as `GET /workstreams/:id` does. Two mappings would drift, and the
 * one that drifted would be the one deciding what an error says to a person.
 */
export function memberSafeHarnessError(value: unknown): { code: string; message: string } | null {
  if (value == null) return null;
  const parsed = typeof value === "string" ? json<unknown>(value, null) : value;
  const rawCode = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as { code?: unknown }).code
    : null;
  const code = typeof rawCode === "string" ? rawCode.trim() : "";
  const harnessFailureCode = HarnessFailureCodeSchema.safeParse(code);
  if (harnessFailureCode.success) {
    return {
      code: harnessFailureCode.data,
      message: memberSafeHarnessFailureMessage(harnessFailureCode.data),
    };
  }
  if (Object.hasOwn(ADDITIONAL_MEMBER_SAFE_HARNESS_ERRORS, code)) {
    return {
      code,
      message: ADDITIONAL_MEMBER_SAFE_HARNESS_ERRORS[
        code as keyof typeof ADDITIONAL_MEMBER_SAFE_HARNESS_ERRORS
      ],
    };
  }
  return { ...GENERIC_MEMBER_SAFE_HARNESS_ERROR };
}
