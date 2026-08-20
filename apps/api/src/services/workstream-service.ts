import { createDatabase, newId, nowIso } from "@avalon/db";
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
import {
  WORKSTREAM_VISIBILITY_SQL,
  workstreamVisibilityBindings,
} from "../lib/workstream-visibility";
import {
  toWorkstream,
  WORKSTREAM_VIEWER_COLUMNS_SQL,
  WORKSTREAM_VIEWER_JOINS_SQL,
  workstreamViewerBindings,
} from "../mappers/workstream";
import { publishWorkstreamEvent } from "./integrations";
import { logStructuredEvent, logWarn } from "../observability/logger";
import { scheduledWorkstreamModelForExisting } from "./agent-model-flags";
import {
  issueBlockDashboardBlockSocketTicket,
  issueSocketTicket,
  issueWorkstreamControlSocketTicket,
} from "./socket-service";
import { loadBlockDashboard } from "./block-dashboard-service";
import { WorkstreamEmailRoutingService } from "./workstream-email-routing-service";
import {
  activityOriginLocator,
  describeWorkstreamOrigin,
  resolveOriginResource,
  type OriginResourceDescriptor,
} from "./workstream-origin-resource";
import { emitCorrelatedRunOutcome } from "../telemetry/run-outcome";
import { activityIsWorkspaceVisible } from "../lib/activity-visibility";
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
   * whose room is that conversation's members. Omitted means `workspace`.
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
  const statements = [
    ...(input.supersedeActiveRun ? [executionEnv.DB.prepare(
      `UPDATE harness_runs
          SET cancellation_requested_at = COALESCE(cancellation_requested_at, ?),
              cancellation_reason = COALESCE(cancellation_reason, 'superseded_by_follow_up')
        WHERE workspace_id = ? AND workstream_id = ?
          AND origin != 'block_dashboard_block'
          AND parent_tool_call_id IS NULL
          AND status IN ('scheduled', 'running') AND terminalized_at IS NULL`,
    ).bind(at, input.workspaceId, input.workstreamId)] : []),
    executionEnv.DB.prepare(
      `INSERT INTO harness_runs
       (id, workspace_id, workstream_id, origin, execution_principal_json, parent_harness_run_id,
        status, started_at, model, created_at, trigger_message_id)
       SELECT ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?
        WHERE ? IS NULL OR ? = (
          SELECT latest.id FROM harness_runs latest
           WHERE latest.workspace_id = ? AND latest.workstream_id = ?
             AND latest.parent_tool_call_id IS NULL
             AND latest.origin != 'block_dashboard_block'
           ORDER BY latest.created_at DESC, latest.id DESC
           LIMIT 1
        )`,
    ).bind(
      id,
      input.workspaceId,
      input.workstreamId,
      input.origin,
      JSON.stringify(input.executionPrincipal),
      input.parentHarnessRunId ?? null,
      at,
      model,
      at,
      // Stored, not merely passed to the Workflow: it is what `retry` replays
      // against, and reconstructing it later is a guess that gets the answer
      // wrong for every run whose trigger was not the newest human message.
      input.triggerMessageId,
      input.expectedLatestHarnessRunId ?? null,
      input.expectedLatestHarnessRunId ?? null,
      input.workspaceId,
      input.workstreamId,
    ),
    executionEnv.DB.prepare(
      `UPDATE workstreams SET harness_status = 'running', last_activity_at = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?
         AND EXISTS (SELECT 1 FROM harness_runs WHERE id = ?)`,
    ).bind(at, at, input.workstreamId, input.workspaceId, id),
  ];
  const insertIndex = input.supersedeActiveRun ? 1 : 0;
  const admission = await executionEnv.DB.batch(statements);
  if (Number(admission[insertIndex]?.meta.changes ?? 0) !== 1) {
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
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE harness_runs SET status = 'failed', completed_at = ?, error_json = ? WHERE id = ?",
      ).bind(nowIso(), JSON.stringify(memberSafeError), id),
      env.DB.prepare(
        "UPDATE workstreams SET harness_status = 'failed', updated_at = ? WHERE id = ?",
      ).bind(nowIso(), input.workstreamId),
    ]);
    await emitCorrelatedRunOutcome(env, {
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
): Promise<{ fired: boolean; harnessRunId?: string }> {
  if (!await claimDueWorkstreamWakeup(env, row)) return { fired: false };

  // Everything after the claim runs under one release-on-throw path. A claim is
  // only safe to hold if every way out of this function either starts a run or
  // hands the row back: once the row leaves `pending` the scheduler's own retry
  // gate is useless, because `refresh()` no longer sees it as a due target.
  // Returning `fired: false` below is the deliberate exception — those are
  // decisions, not failures, and retrying them would only reach the same answer.
  try {
    const principal = wakeupExecutionPrincipal(row);
    const workstream = await env.DB.prepare(
      `SELECT archived_at FROM workstreams WHERE id = ? AND workspace_id = ?`,
    ).bind(row.workstream_id, row.workspace_id).first<{ archived_at: string | null }>();
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
    await releaseClaimedWorkstreamWakeup(env, row).catch(() => undefined);
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
  const messageId = newId();
  const clientMessageId = `wakeup:${row.id}`;
  const at = nowIso();
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages
       (id, client_message_id, workspace_id, workstream_id, author_type, author_user_id,
        message_type, text_content, structured_content_json, sequence_number, created_at)
       SELECT ?, ?, ?, w.id, 'system', NULL, 'system', ?, NULL, w.next_sequence_number, ?
       FROM workstreams w WHERE w.id = ? AND w.workspace_id = ?
       ON CONFLICT(workstream_id, client_message_id) DO NOTHING`,
    ).bind(
      messageId,
      clientMessageId,
      row.workspace_id,
      `Avalon woke this work stream up as scheduled: ${wakeupPromptPreview(row.prompt)}`,
      at,
      row.workstream_id,
      row.workspace_id,
    ),
    env.DB.prepare(
      `UPDATE workstreams
       SET next_sequence_number = next_sequence_number + 1,
           last_activity_at = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?
         AND EXISTS (SELECT 1 FROM messages WHERE id = ?)`,
    ).bind(at, at, row.workstream_id, row.workspace_id, messageId),
  ]);
  if (Number(results[0]?.meta.changes ?? 0) === 0) return;
  const message = await createDatabase(env.DB).workstreams.getMessageByClientId(
    row.workspace_id,
    row.workstream_id,
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
 * What legitimately remains on regional D1 here is the control plane: the
 * `workstreams` directory index (`list`, visibility checks behind socket
 * tickets), the caller's own `workstream_pins` rows, and email-route
 * reconciliation.
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

  async list(limit: number, before?: string, includeSystem = false) {
    const cursorClause = before ? "AND w.last_activity_at < ?" : "";
    // Two different questions. `system_kind` says this is machinery, which
    // decides whether it is listed at all; `scope` says who may read it, and is
    // enforced below whatever the caller asked to see.
    //
    // Machinery is paged with everything else rather than lifted out and
    // bounded. Digest work streams accumulate one per occurrence and nothing
    // reaps them, so with Debug enabled they do take the newest pages — but the
    // sidebar follows `nextCursor` as it scrolls, so that costs a scroll rather
    // than the rows themselves, and the alternative was a second population
    // inside this method with its own cap and its own ordering rules. One list,
    // one order.
    const systemClause = includeSystem ? "" : "AND w.system_kind IS NULL";
    // A pinned work stream leaves the recency order altogether rather than
    // being paged with everything else, which is the same thing the sidebar
    // does when it lifts one out of the recent list into the Pinned section.
    // Being in both would mean being returned twice — once appended to the
    // first page below, and again on whichever cursor page its own
    // `last_activity_at` falls in.
    const statement = this.env.DB.prepare(
      `SELECT w.*, ${WORKSTREAM_VIEWER_COLUMNS_SQL}
       FROM workstreams w
       ${WORKSTREAM_VIEWER_JOINS_SQL}
       WHERE w.workspace_id = ? AND w.archived_at IS NULL AND pin.user_id IS NULL
         ${systemClause} ${cursorClause}
         AND ${WORKSTREAM_VISIBILITY_SQL}
       ORDER BY w.last_activity_at DESC LIMIT ?`,
    );
    const visibility = workstreamVisibilityBindings(this.auth.userId);
    const viewer = workstreamViewerBindings(this.auth.userId);
    const result = before
      ? await statement.bind(...viewer, this.auth.workspaceId, before, ...visibility, limit + 1).all<Record<string, unknown>>()
      : await statement.bind(...viewer, this.auth.workspaceId, ...visibility, limit + 1).all<Record<string, unknown>>();
    const rows = result.results ?? [];
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    const nextCursor = hasMore ? String(rows.at(-1)?.last_activity_at ?? "") || null : null;
    // Every pin arrives on the first page, whatever its activity, because it is
    // rendered in a section the recency order does not reach: one that has gone
    // quiet would otherwise fall past `limit` and vanish from the one place the
    // reader deliberately put it. They are appended after the paged rows and
    // are excluded from the query above, so each work stream is returned
    // exactly once across the whole pagination. The first page can therefore
    // hold more than `limit` items — one more per pin, and nothing caps how
    // many a person has — which is why `nextCursor` comes from the paged rows
    // rather than from the last item returned.
    if (!before) rows.push(...await this.loadPinnedWorkstreamRows(includeSystem));
    // Machinery is never given an inbound address. Reserving one activates a
    // route in the global registry — a cross-region RPC from the EU — and
    // nothing reclaims it, so with one work stream per digest occurrence this
    // would mint a permanent mailbox per occurrence, hundreds a year per person.
    // It would also make a work stream emailable whose entire point is that its
    // context is exactly one frozen window. A digest work stream carries no
    // address and needs none: nobody writes to a run.
    const unreconciledAddressRows = rows.filter((row) =>
      row.system_kind == null && (row.email_address == null || row.email_route_status !== "active"));
    if (unreconciledAddressRows.length > 0) {
      const routes = await new WorkstreamEmailRoutingService(this.env).backfillWorkstreamAddresses(
        unreconciledAddressRows.map((row) => ({
          region: this.env.AVALON_REGION,
          workspaceId: this.auth.workspaceId,
          workstreamId: String(row.id),
        })),
      );
      const addressesByWorkstreamId = new Map(routes.map((route) => [route.workstreamId, route.emailAddress]));
      for (const row of unreconciledAddressRows) {
        row.email_address = addressesByWorkstreamId.get(String(row.id)) ?? null;
        row.email_route_status = "active";
      }
    }
    return { items: rows.map(toWorkstream), nextCursor };
  }

  async create(
    input: CreateWorkstreamInput,
    slackOrigin?: SlackOriginContext,
    slackSearchAuthorization?: SlackSearchAuthorization,
  ) {
    await requireOpenWorkstreamAuthority(this.env);
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

  async createFromOpportunity(input: {
    opportunityId: string;
    version: number;
    displayPrompt: string;
    executionPrompt: string;
    displayPromptHash: string;
    executionPromptHash: string;
    idempotencyKey: string;
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

  async context(id: string) {
    return (await this.authoritativeClient(id)).context();
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

  /**
   * Pin a work stream for the calling user, at the end of their pinned list.
   *
   * The end rather than the top: the list is arranged by hand, so the only
   * position Avalon can pick without overruling that arrangement is the one
   * that disturbs none of it. Pinning something already pinned changes nothing,
   * so a second window acting on a stale menu cannot move a row.
   *
   * There is no limit on how many a person may pin. A cap here was tried and
   * removed: counting stored rows let pins whose work streams had gone out of
   * sight spend slots nobody could free, and counting only the visible ones
   * meant the list could legitimately grow past the number the reorder request
   * would accept, which left it unreorderable. Both failures came from the cap
   * rather than from the size of anyone's list.
   */
  async pin(id: string) {
    // Only a work stream this person may read may be pinned. Everything after
    // this point is the viewer's own row, and is not gated again.
    await this.requireWorkstream(id);
    const at = nowIso();
    // The position is chosen inside the statement rather than read out first
    // and bound back in. A read-then-write hands the same number to two pins
    // made at once, and it also collides with a hole — a work stream deleted
    // outright takes its pin with it by cascade, leaving a run whose length is
    // no longer its next free position.
    await this.env.DB.prepare(
      `INSERT INTO workstream_pins
       (workspace_id, workstream_id, user_id, position, created_at, updated_at)
       SELECT ?, ?, ?, COALESCE(
         (SELECT MAX(existing.position) + 1 FROM workstream_pins existing
           WHERE existing.workspace_id = ? AND existing.user_id = ?), 0), ?, ?
       ON CONFLICT(workstream_id, user_id) DO NOTHING`,
    ).bind(
      this.auth.workspaceId,
      id,
      this.auth.userId,
      this.auth.workspaceId,
      this.auth.userId,
      at,
      at,
    ).run();
    return this.pinnedList();
  }

  /**
   * Unpin a work stream for the calling user and close the gap it leaves, so
   * the surviving positions stay the dense run every other path assumes.
   *
   * Deliberately not gated on `requireWorkstream`: a pin is the viewer's own
   * row, so removing one is never a question about the work stream. A pin whose
   * work stream has gone out of sight renders nothing and cannot be reached
   * from the sidebar at all — the way to be rid of it is a caller that already
   * knows the id, and refusing them a 404 would be refusing the only route left.
   */
  async unpin(id: string) {
    const removed = await this.env.DB.prepare(
      "DELETE FROM workstream_pins WHERE workstream_id = ? AND user_id = ? AND workspace_id = ?",
    ).bind(id, this.auth.userId, this.auth.workspaceId).run();
    if ((removed.meta?.changes ?? 0) > 0) await this.rewritePinPositions(await this.loadPinnedWorkstreamIds());
    return this.pinnedList();
  }

  /**
   * Rearrange the caller's pinned list into the order they dropped it in.
   *
   * Tolerant by construction, because a client sending an arrangement is
   * describing a list it painted some moments ago: an id it names that is no
   * longer pinned is dropped, and a pin it does not name is appended behind the
   * ones it did, keeping its position relative to its unnamed neighbours.
   * Rejecting the whole call instead would turn a pin made in another window
   * into a failed drag here, which is the one outcome that loses an
   * arrangement the person can see.
   */
  async reorderPins(workstreamIds: string[]) {
    const current = await this.loadPinnedWorkstreamIds();
    const pinned = new Set(current);
    const requested = [...new Set(workstreamIds)].filter((id) => pinned.has(id));
    const requestedSet = new Set(requested);
    await this.rewritePinPositions([...requested, ...current.filter((id) => !requestedSet.has(id))]);
    return this.pinnedList();
  }

  /**
   * What every pin mutation answers with: the caller's whole pinned list, in
   * order. One shape for all three, because a client that replaces its pinned
   * list wholesale cannot end up holding a position the server disagrees with —
   * which is exactly what a response describing only the row that moved would
   * let it do after a concurrent change from another window.
   */
  private async pinnedList() {
    return { items: await this.loadPinnedWorkstreams() };
  }

  /**
   * The caller's pins, in their stored order — every row, including any whose
   * work stream this person can no longer see, because a rewrite that skipped
   * those would strand them at positions the visible run is about to reuse.
   *
   * The `workstream_id` tiebreak matches {@link loadPinnedWorkstreamRows}. Two
   * readers of one list that break a tie differently disagree about the order,
   * and the disagreement only becomes visible when a rewrite silently swaps a
   * pair the reader never touched.
   */
  private async loadPinnedWorkstreamIds(): Promise<string[]> {
    const result = await this.env.DB.prepare(
      `SELECT workstream_id FROM workstream_pins
        WHERE workspace_id = ? AND user_id = ?
        ORDER BY position, workstream_id`,
    ).bind(this.auth.workspaceId, this.auth.userId).all<{ workstream_id: string }>();
    return (result.results ?? []).map((row) => row.workstream_id);
  }

  /**
   * The caller's pinned work streams, as work streams.
   *
   * Filtered by the same visibility rule every other read applies, so a pin
   * left behind by a work stream that has been archived, or made private
   * without this person in it, contributes a row to nothing. The pin itself
   * survives, because the work stream may come back and its place with it,
   * which is also why `unpin` refuses to check visibility.
   */
  private async loadPinnedWorkstreams(includeSystem = true) {
    return (await this.loadPinnedWorkstreamRows(includeSystem)).map(toWorkstream);
  }

  /** {@link loadPinnedWorkstreams} before mapping, for callers that merge rows. */
  private async loadPinnedWorkstreamRows(includeSystem: boolean): Promise<Record<string, unknown>[]> {
    const result = await this.env.DB.prepare(
      `SELECT w.*, ${WORKSTREAM_VIEWER_COLUMNS_SQL}
       FROM workstreams w
       ${WORKSTREAM_VIEWER_JOINS_SQL}
       WHERE w.workspace_id = ? AND w.archived_at IS NULL AND pin.user_id IS NOT NULL
         ${includeSystem ? "" : "AND w.system_kind IS NULL"}
         AND ${WORKSTREAM_VISIBILITY_SQL}
       ORDER BY pin.position, pin.workstream_id`,
    ).bind(
      ...workstreamViewerBindings(this.auth.userId),
      this.auth.workspaceId,
      ...workstreamVisibilityBindings(this.auth.userId),
    ).all<Record<string, unknown>>();
    return result.results ?? [];
  }

  /** Write `ids` as positions `0..n-1`. The caller decides the order. */
  private async rewritePinPositions(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const at = nowIso();
    await this.env.DB.batch(ids.map((id, position) => this.env.DB.prepare(
      `UPDATE workstream_pins SET position = ?, updated_at = ?
        WHERE workstream_id = ? AND user_id = ? AND workspace_id = ?`,
    ).bind(position, at, id, this.auth.userId, this.auth.workspaceId)));
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
    await this.requireWorkstream(id);
    const ticket = await issueSocketTicket(this.env, this.auth, id, substreamId);
    const url = new URL(this.env.PUBLIC_API_BASE_URL);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/socket/workstreams/${id}/substreams/${substreamId}`;
    url.search = new URLSearchParams({ ticket }).toString();
    return { url: url.toString(), ticket };
  }

  async workstreamControlSocketTicket(id: string) {
    await this.requireWorkstream(id);
    const ticket = await issueWorkstreamControlSocketTicket(this.env, this.auth, id);
    const url = new URL(this.env.PUBLIC_API_BASE_URL);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/socket/workstreams/${id}`;
    url.search = new URLSearchParams({ ticket }).toString();
    return { url: url.toString(), ticket };
  }

  async blockDashboardBlockSocketTicket(id: string, blockId: string) {
    await this.requireWorkstream(id);
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

  /**
   * The regional directory row this viewer may see, as a work stream, with its
   * email route reconciled. This is a control-plane read over the `workstreams`
   * index — the gate in front of pinning and socket-ticket issuance — not a
   * product read; product state lives in the object.
   */
  private async requireWorkstream(id: string) {
    let row = await this.loadVisibleWorkstreamRow(id);
    const desiredEmailStatus = row.archived_at == null ? "active" : "disabled";
    if (row.email_address == null || row.email_route_status !== desiredEmailStatus) {
      await new WorkstreamEmailRoutingService(this.env).ensureWorkstreamAddress({
        region: this.env.AVALON_REGION,
        workspaceId: this.auth.workspaceId,
        workstreamId: id,
      });
      row = await this.loadVisibleWorkstreamRow(id);
    }
    return toWorkstream(row);
  }

  private async loadVisibleWorkstreamRow(id: string): Promise<Record<string, unknown>> {
    const row = await this.env.DB.prepare(
      `SELECT w.*, ${WORKSTREAM_VIEWER_COLUMNS_SQL}
       FROM workstreams w
       ${WORKSTREAM_VIEWER_JOINS_SQL}
       WHERE w.id = ? AND w.workspace_id = ?
         AND w.archived_at IS NULL
         AND ${WORKSTREAM_VISIBILITY_SQL}`,
    ).bind(
      ...workstreamViewerBindings(this.auth.userId),
      id,
      this.auth.workspaceId,
      ...workstreamVisibilityBindings(this.auth.userId),
    ).first<Record<string, unknown>>();
    if (!row) throw new ApiError(404, "workstream_not_found", "Work stream not found");
    return row;
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
