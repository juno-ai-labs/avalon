
import { newId, nowIso } from "@rally/db";
import { memberSafeHarnessFailureMessage } from "@rally/agent-harness";
import { HarnessFailureCodeSchema, asHarnessRunId, asWorkspaceId, asWorkstreamId, asSubstreamId, type WorkspaceId, type WorkstreamId } from "@rally/contracts";
import type {
  ExecutionPrincipal,
  SlackOriginContext,
  SlackSearchAuthorization,
  SubstreamId,
  WorkstreamWorkflowInput,
} from "@rally/contracts";
import type { ConversationParentKind } from "@rally/contracts/conversation-parent";

import type { Env } from "../env";
import { conversationObjectName } from "../durable-objects/agent-loop-do";
import { substreamLoopId } from "../durable-objects/names";
import { ApiError } from "../lib/api-error";
import { loopActivationWasRecorded } from "../lib/loop-activation-signal";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { truncateUtf16Safe } from "../lib/text";
import { activateWorkstreamLoop, publishWorkstreamEvent } from "./integrations";
import { logStructuredEvent } from "../observability/logger";
import { scheduledWorkstreamModelForExisting, conversationModelContext } from "./agent-model-flags";
import { emitCorrelatedRunOutcome } from "../telemetry/run-outcome";
import type { SchedulingObjectPort } from "../durable-objects/workstream-scheduling-protocol";
import { createHarnessRunObjectPort } from "../runtime/harness-run-port";
import { createMessageObjectPort } from "../runtime/message-port";
import {
  claimDueWorkstreamWakeup,
  releaseClaimedWorkstreamWakeup,
  wakeupExecutionPrincipal,
  type WorkstreamWakeupRow,
} from "./workstream-wakeup-service";

import { continueSidekickRun } from "./sidekick-run-continuation";

import { rpcResultBody } from "../durable-objects/rpc-result";
import { createIdentityObjectPort } from "../runtime/identity-port";
import {
  AdmitExternalMessageInputSchema,
  ExternalMessageAdmissionResultSchema,
  type AdmitExternalMessageInput,
  type ExternalMessageAdmissionResult,
} from "../durable-objects/workstream-external-message-protocol";

/**
 * What survives of the Thread service once Threads are retired (plan step
 * C-2): starting a run on any conversation (`launchWorkstreamHarness`), firing
 * the generic agent timer (`fireWorkstreamWakeup`), admitting a message from
 * an external binding into a conversation, such as a Slack reply continuing a
 * Sidekick run (`admitExternalWorkstreamMessage`), and the member-safe failure
 * a run shows (`memberSafeHarnessError`).
 */

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
