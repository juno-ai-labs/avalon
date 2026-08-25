import { newId, nowIso } from "@avalon/db";
import { memberSafeHarnessFailureMessage } from "@avalon/agent-harness";
import { HarnessFailureCodeSchema, asHarnessRunId, asSubstreamId, asWorkspaceId, asWorkstreamId, type WorkspaceId, type WorkstreamId } from "@avalon/contracts";
import type {
  AnswerElicitationRequestSchema,
  CreateMessageRequestSchema,
  CreateWorkstreamRequestSchema,
  ExecutionPrincipal,
  Scope,
  SlackOriginContext,
  SlackSearchAuthorization,
  UpdateWorkstreamRequestSchema,
  WorkstreamDetail,
  WorkstreamWorkflowInput,
} from "@avalon/contracts";
import type { z } from "zod";
import type { AuthContext, Env } from "../env";
import { substreamAgentName } from "../durable-objects/substream-agent";
import { workspaceDOName } from "../durable-objects/names";
import { WorkspaceOpportunityOriginEventsResultSchema } from "../durable-objects/workspace-opportunity-protocol";
import { ApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { truncateUtf16Safe } from "../lib/text";
import { publishWorkstreamEvent } from "./integrations";
import { logStructuredEvent, logWarn } from "../observability/logger";
import { scheduledWorkstreamModelForExisting } from "./agent-model-flags";
import {
  issueBlockDashboardBlockSocketTicket,
  issueSocketTicket,
  issueWorkstreamControlSocketTicket,
} from "./socket-service";
import { loadBlockDashboard } from "./block-dashboard-service";
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
import { readMessage } from "../runtime/message-projection";
import {
  claimDueWorkstreamWakeup,
  releaseClaimedWorkstreamWakeup,
  wakeupExecutionPrincipal,
  type WorkstreamWakeupRow,
} from "./workstream-wakeup-service";
import { requireOpenWorkstreamAuthority } from "./workstream-authority";
import { WorkstreamObjectClient } from "./workstream-object-client";
import { WorkstreamObjectCreationService } from "./workstream-object-creation-service";
import { withWorkstreamRuntimeDatabase } from "./workstream-runtime-database";
import { rpcResultBody } from "../durable-objects/rpc-result";
import { createIdentityObjectPort } from "../runtime/identity-port";

/**
 * `descriptionSource` is the caller's assertion, never inferred from whether
 * `objective` is present. A supplied objective means "the caller had one", which
 * is true of every machine-derived path — a Slack mention slices its prompt into
 * the field, and reading that as authorship would tell the refresh loop to
 * protect exactly the descriptions it exists to fix. Only a caller that knows a
 * person typed the text says so, and the default is the honest one.
 */
type CreateWorkstreamInput = z.infer<typeof CreateWorkstreamRequestSchema> & {
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
interface AcknowledgeReadInput {
  readThroughSequenceNumber: number;
  observedManualUnreadGeneration: number;
  entrypoint?: ('direct' | 'sidebar_new' | 'sidebar_pinned' | 'sidebar_recent' | 'sidebar_note' | 'sidebar_automation'
    | 'home_waiting' | 'home_suggested' | 'menu_bar' | 'command_shortcut' | 'deep_link' | 'notification'
    | 'automation_run_list' | 'in_app_link' | 'settings' | 'unknown') | undefined;
}

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
  model_output_invalid: "The model returned a response Avalon could not read. Try again in a moment",
  provider_error: "A connected service returned an error, so this run stopped",
  run_admission_timeout: "This work stream stayed busy too long to start the run",
  run_cancelled: "This run was cancelled",
  run_ownership_lost: "This run was superseded by another executor",
  stale_run_reaped: "This run stopped after its execution lease expired",
  workflow_unavailable: "Avalon could not start this run",
} satisfies Readonly<Record<string, string>>);

const GENERIC_MEMBER_SAFE_HARNESS_ERROR = Object.freeze({
  code: "harness_execution_failed",
  message: "Avalon could not complete this run. Retrying is unlikely to help — copy the request ID for support",
});

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
    supersedeActiveRun?: boolean;
    scheduledWakeupId?: string;
    digestDeliveryId?: string;
    telemetryOperationId?: string;
    telemetrySubjectUserId?: string;
    /** Admit only while this is still the latest participant-facing run. */
    expectedLatestHarnessRunId?: string;
  },
  publishEvent: typeof publishWorkstreamEvent = publishWorkstreamEvent,
): Promise<string> {
  // The Durable-Object authority is the only execution arm left; a stack that
  // has not opened it must refuse here, before the admission writes below.
  await requireOpenWorkstreamAuthority(env);
  const executionEnv = withWorkstreamRuntimeDatabase(
    env,
    input.workspaceId,
    input.workstreamId,
  );
  const id = asHarnessRunId(newId());
  const at = nowIso();
  const model = await scheduledWorkstreamModelForExisting(executionEnv, {
    workspaceId: input.workspaceId,
    workstreamId: input.workstreamId,
  });
  const admission = await createHarnessRunObjectPort(
    executionEnv,
    input.workspaceId,
    input.workstreamId,
  ).admitRun({
    runId: id,
    origin: input.origin,
    executionPrincipalJson: JSON.stringify(input.executionPrincipal),
    status: "running",
    startedAt: Date.parse(at),
    model,
    // Stored, not merely passed to the Workflow: it is what `retry` replays
    // against, and reconstructing it later is a guess that gets the answer
    // wrong for every run whose trigger was not the newest human message.
    triggerPartId: input.triggerMessageId,
    parentRunId: input.parentHarnessRunId ?? null,
    supersedeActive: input.supersedeActiveRun === true,
    expectedLatestRunId: input.expectedLatestHarnessRunId ?? null,
    now: Date.parse(at),
  });
  // Both refusals carry the same member-visible error, which is what the routed
  // version did: its staleness check and its swallowed UNIQUE collision were
  // both a zero-change insert, and neither could say which it had been. They
  // are different conditions — `stale` means someone else got here first,
  // `busy` means the run this one superseded has not stopped yet — and the
  // second is the common one on a follow-up into a live work stream. Splitting
  // what a member is told is a product decision rather than part of this
  // conversion.
  if (admission.outcome === "stale" || admission.outcome === "busy") {
    throw new ApiError(409, "terminal_repository_request_stale", "A newer run replaced this Terminal repository request. Reload the work stream before continuing.");
  }
  const workflowInput: WorkstreamWorkflowInput = {
    region: env.AVALON_REGION,
    workspaceId: input.workspaceId,
    workstreamId: input.workstreamId,
    harnessRunId: id,
    triggerMessageId: input.triggerMessageId,
    automationSubscriptionId: null,
    activityId: null,
    executionPrincipal: input.executionPrincipal,
    ...(input.transcriptFenceMessageId
      ? { transcriptFenceMessageId: input.transcriptFenceMessageId }
      : {}),
    ...(input.scheduledWakeupId ? { scheduledWakeupId: input.scheduledWakeupId } : {}),
    ...(input.digestDeliveryId ? { digestDeliveryId: input.digestDeliveryId } : {}),
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
  /*
   * The dispatch round trip stays on the caller's path, and it is the slowest
   * step in a create. Handing it to `waitUntil` was tried and reverted: the run
   * row above already says `running` while `attempt_id` and `lease_expires_at`
   * stay NULL until the agent admits the run, and nothing reaps that shape.
   * A dropped deferral therefore left a work stream permanently "working" —
   * `stop` only records a request a live run has to observe, `retry` refuses a
   * `running` stream, and no screen offers either. Losing the start here
   * instead fails loudly, in front of the person who asked for it.
   */
  try {
    const agent = await durableObjectStubForWorkspace(
      env,
      env.SUBSTREAM_AGENTS,
      input.workspaceId,
      substreamAgentName(
        env.AVALON_REGION,
        input.workspaceId,
        input.workstreamId,
      ),
    );
    const response = await agent.dispatchRun({ ...workflowInput, substreamId: asSubstreamId("0") });
    if (response.status < 200 || response.status >= 300) {
      const body = rpcResultBody(response) as { error?: unknown } | null;
      throw new Error(typeof body?.error === "string" ? body.error : "substream_agent_unavailable");
    }
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
    const memberSafeError = memberSafeHarnessError({ code: "workflow_unavailable" })
      ?? GENERIC_MEMBER_SAFE_HARNESS_ERROR;
    // Through the object's own authority like the admission above: the run row
    // lives there, and the operation commits the sidebar's projection with the
    // failure rather than as a second statement that could be lost inside this
    // very catch handler.
    await createHarnessRunObjectPort(executionEnv, input.workspaceId, input.workstreamId)
      .failUnlaunchedRun({
        runId: id,
        errorJson: JSON.stringify(memberSafeError),
        now: Date.now(),
      });
    await emitCorrelatedRunOutcome(executionEnv, {
      workspaceId: input.workspaceId,
      workstreamId: input.workstreamId,
      harnessRunId: id,
      telemetryOperationId: input.telemetryOperationId,
      telemetrySubjectUserId: input.telemetrySubjectUserId,
    }).catch(() => undefined);
    // The work stream and its run exist whatever the caller does with the 503,
    // so anyone already watching is told the run failed rather than left on a
    // `running` row that nothing will move.
    await publishEvent(env, input.workspaceId, input.workstreamId, {
      type: "harness_status_changed",
      status: "failed",
    });
    // Carried onto the member-safe error so a caller that cleans up after a
    // failed launch can tell "nothing started" from "started, and only the
    // record of it failed". The run row above is `failed` either way, so it
    // cannot answer that question and must not be read as if it could.
    // The member-safe error carries forward whether an instance is live, so a
    // caller undoing its own preparation is answering the right question.
    const memberSafe = new ApiError(503, "workflow_unavailable", "The Avalon harness could not be started");
    throw memberSafe;
  }
  await publishEvent(env, input.workspaceId, input.workstreamId, {
    type: "harness_status_changed",
    status: "running",
  });
  return id;
}

/**
 * Start the run one due wake-up asked for.
 *
 * Called by the workspace scheduler's alarm. The order is deliberate: claim the
 * row, re-check the authority that scheduled it, note it in the transcript, and
 * only then launch. A claim that cannot reach a running harness is released so
 * the next alarm retries it; a claim that is refused because the workspace has
 * since revoked the principal stays consumed, because retrying it would only
 * fail again.
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
    const workstream = await createIdentityObjectPort(env, row.workspace_id, row.workstream_id)
      .identity();
    if (!workstream || workstream.archived_at !== null) {
      // The work stream this wake-up belongs to is gone. Leave the row claimed:
      // there is nothing left to wake, and a retry cannot change that.
      return { fired: false };
    }
    if (!await wakeupPrincipalStillAuthorized(env, row.workspace_id, principal)) {
      return { fired: false };
    }

    await appendWakeupSystemMessage(env, row);

    const harnessRunId = await launchWorkstreamHarness(env, {
      workspaceId: asWorkspaceId(row.workspace_id),
      workstreamId: asWorkstreamId(row.workstream_id),
      triggerMessageId: null,
      origin: "scheduled_wakeup",
      executionPrincipal: principal,
      scheduledWakeupId: row.id,
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
async function appendWakeupSystemMessage(env: Env, row: WorkstreamWakeupRow): Promise<void> {
  const clientMessageId = `wakeup:${row.id}`;
  const messages = createMessageObjectPort(env, row.workspace_id, row.workstream_id);
  // The insert and the counter it consumed were a two-statement batch: one of
  // them advanced `next_attention_ordinal` inside the retired view's trigger
  // and the other advanced `next_sequence_number` here. One operation now.
  const appended = await messages.appendMessage({
    messageId: newId(),
    clientMessageId,
    authorType: "system",
    authorUserId: null,
    externalActorJson: null,
    messageType: "system",
    text: `Avalon woke this work stream up as scheduled: ${wakeupPromptPreview(row.prompt)}`,
    structuredContentJson: null,
    producedByRunId: null,
    now: Date.now(),
  });
  // A redelivered alarm names the wake-up it already announced. Publishing a
  // second `message_created` for a row that was already there would put the
  // same notice in front of a member twice.
  if (appended.outcome === "replayed") return;
  const message = await readMessage(
    messages,
    { workspaceId: row.workspace_id, workstreamId: row.workstream_id },
    clientMessageId,
  );
  if (message) {
    await publishWorkstreamEvent(env, row.workspace_id, row.workstream_id, {
      type: "message_created",
      message,
    });
  }
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

  /** The object client, or a 503 refusal on a stack that never opened the authority. */
  private async authoritativeClient(id: string): Promise<WorkstreamObjectClient> {
    await requireOpenWorkstreamAuthority(this.env);
    return new WorkstreamObjectClient(this.env, this.auth, id);
  }

  async create(
    input: CreateWorkstreamInput,
    slackOrigin?: SlackOriginContext,
    slackSearchAuthorization?: SlackSearchAuthorization,
  ) {
    await requireOpenWorkstreamAuthority(this.env);
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
    await requireOpenWorkstreamAuthority(this.env);
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

  async get(id: string): Promise<WorkstreamDetail> {
    return (await this.authoritativeClient(id)).get();
  }


  async update(id: string, input: UpdateWorkstreamInput) {
    return (await this.authoritativeClient(id)).update(input);
  }

  async messages(id: string, limit: number, before?: number, after?: number, around?: number) {
    return (await this.authoritativeClient(id)).messages(limit, before, after, around);
  }

  async acknowledgeRead(id: string, input: AcknowledgeReadInput) {
    return (await this.authoritativeClient(id)).acknowledgeRead(input);
  }

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

  async addParticipant(id: string, userId: string) {
    return (await this.authoritativeClient(id)).addParticipant(userId);
  }

  async removeParticipant(id: string, userId: string): Promise<void> {
    return (await this.authoritativeClient(id)).removeParticipant(userId);
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
  ) {
    return (await this.authoritativeClient(id)).answerElicitation(elicitationId, input);
  }

  async stop(id: string): Promise<void> {
    return (await this.authoritativeClient(id)).stop();
  }

  async retry(id: string): Promise<{ harnessRunId: string }> {
    return (await this.authoritativeClient(id)).retry();
  }

  async socketTicket(id: string, substreamId = "0") {
    await this.requireVisibleWorkstream(id);
    // Minted here rather than inside the issuer so the route can log the id the
    // room will report consuming; see `docs/performance-tracing.md`.
    const ticketId = newId();
    const ticket = await issueSocketTicket(this.env, this.auth, id, substreamId, ticketId);
    const url = new URL(this.env.PUBLIC_API_BASE_URL);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/socket/workstreams/${id}/substreams/${substreamId}`;
    url.search = new URLSearchParams({ ticket }).toString();
    return { url: url.toString(), ticket, ticketId };
  }

  async workstreamControlSocketTicket(id: string) {
    await this.requireVisibleWorkstream(id);
    const ticket = await issueWorkstreamControlSocketTicket(this.env, this.auth, id);
    const url = new URL(this.env.PUBLIC_API_BASE_URL);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/socket/workstreams/${id}`;
    url.search = new URLSearchParams({ ticket }).toString();
    return { url: url.toString(), ticket };
  }

  async blockDashboardBlockSocketTicket(id: string, blockId: string) {
    await this.requireVisibleWorkstream(id);
    const blockDashboard = await loadBlockDashboard(this.env, this.auth.workspaceId, id);
    if (!blockDashboard.blocks.some((block) => block.id === blockId)) {
      throw new ApiError(404, "block_dashboard_block_not_found", "HyperSight block not found");
    }
    const ticket = await issueBlockDashboardBlockSocketTicket(this.env, this.auth, id, blockId);
    const url = new URL(this.env.PUBLIC_API_BASE_URL);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/socket/workstreams/${id}/block-dashboard/blocks/${blockId}`;
    // This endpoint has no legacy desktop consumer. Unlike the older socket
    // issuers, it never puts the bearer in a URL that Cloudflare may log.
    url.search = "";
    return { url: url.toString(), ticket };
  }

  /** Gate socket credentials on WorkspaceDO's authoritative viewer state. */
  private async requireVisibleWorkstream(id: string): Promise<void> {
    if (!await new WorkstreamDirectoryService(this.env, this.auth).visible(id)) {
      throw new ApiError(404, "workstream_not_found", "Work stream not found");
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
