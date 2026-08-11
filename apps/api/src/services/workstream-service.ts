import { buildMessageAttachmentStatements, buildParticipantUpsertStatement, createDatabase, newId, nowIso } from "@avalon/db";
import { memberSafeHarnessFailureMessage } from "@avalon/agent-harness";
import { HarnessFailureCodeSchema, WorkstreamDetailSchema, workstreamCanonicalUrl } from "@avalon/contracts";
import type {
  AnswerElicitationRequestSchema,
  Connection,
  CreateMessageRequestSchema,
  CreateWorkstreamRequestSchema,
  ExecutionPrincipal,
  Message,
  SlackOriginContext,
  SlackSearchAuthorization,
  UpdateWorkstreamRequestSchema,
  Workstream,
  WorkstreamDetail,
  WorkstreamWorkflowInput,
} from "@avalon/contracts";
import { z } from "zod";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { truncateUtf16Safe } from "../lib/text";
import { connectionFromRow } from "../mappers/connection";
import {
  WORKSTREAM_VISIBILITY_SQL,
  workstreamVisibilityBindings,
} from "../lib/workstream-visibility";
import {
  toWorkstream,
  WORKSTREAM_VIEWER_COLUMNS_SQL,
  WORKSTREAM_VIEWER_JOINS_SQL,
} from "../mappers/workstream";
import {
  isCanonicalPersonMention,
  prepareMentionMarkdown,
  type MentionPerson,
} from "../lib/message-mentions";
import {
  classifyWorkstreamMessage,
  publishWorkstreamEvent,
  startWorkstreamWorkflow,
} from "./integrations";
import { logStructuredEvent, logWarn } from "../observability/logger";
import { scheduledWorkstreamModelForExisting } from "./agent-model-flags";
import { issueSocketTicket } from "./socket-service";
import { describeAuthoredDescriptionStatement } from "./workstream-description-service";
import { WorkstreamEmailRoutingService } from "./workstream-email-routing-service";
import {
  nameWorkstream,
  provisionalWorkstreamTitle,
  refreshWorkstreamName,
} from "./workstream-naming-service";
import { ResourceService } from "./resource-service";
import { sendWorkstreamMentionEmail } from "./mention-email-service";
import { sendWorkstreamMentionSlack } from "./slack-mention-service";
import { enqueueMentionOpportunities } from "./work-opportunity-batching";
import { recordActivityEvent } from "./activity-event-service";
import {
  claimDueWorkstreamWakeup,
  releaseClaimedWorkstreamWakeup,
  wakeupExecutionPrincipal,
  type WorkstreamWakeupRow,
} from "./workstream-wakeup-service";

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
};
type UpdateWorkstreamInput = z.infer<typeof UpdateWorkstreamRequestSchema>;
type CreateMessageInput = z.infer<typeof CreateMessageRequestSchema>;
type AnswerElicitationInput = z.infer<typeof AnswerElicitationRequestSchema>;
interface AcknowledgeReadInput {
  readThroughSequenceNumber: number;
  observedManualUnreadGeneration: number;
}

const ACTIVITY_RESOURCE_LOOKUP_SQL = `SELECT id FROM resources
  WHERE workspace_id = ?
    AND ((connection_id = ?) OR (connection_id IS NULL AND ? IS NULL))
    AND provider = ? AND provider_resource_id = ?`;

const ATTACH_RESOURCE_SQL = `INSERT INTO workstream_resources
  (workstream_id, resource_id, attached_by_user_id, watch_enabled, relationship_type, attached_at)
  VALUES (?, ?, ?, 0, 'attachment', ?)
  ON CONFLICT(workstream_id, resource_id) DO NOTHING`;

const WORKSTREAM_RESOURCES_SQL = `SELECT r.*,
    CASE WHEN rw.id IS NOT NULL THEN 1 ELSE 0 END AS watch_enabled,
    CASE WHEN r.connection_id IS NULL THEN 'unsupported'
         WHEN rw.id IS NOT NULL THEN 'watching'
         ELSE 'paused' END AS watch_status
  FROM workstream_resources wr
  JOIN resources r ON r.id = wr.resource_id
  LEFT JOIN resource_watches rw
   ON rw.workstream_id = wr.workstream_id
   AND rw.resource_id = wr.resource_id
   AND rw.enabled = 1
  WHERE wr.workstream_id = ?
    AND (r.provider != 'avalon_note' OR EXISTS (
      SELECT 1 FROM notes visible_note
      WHERE visible_note.resource_id = r.id
        AND visible_note.workspace_id = r.workspace_id
        AND visible_note.archived_at IS NULL
        AND (visible_note.scope = 'workspace' OR visible_note.owner_user_id = ?)
    ))
  ORDER BY wr.attached_at DESC`;

const WORKSTREAM_ARTIFACTS_SQL = `SELECT * FROM artifacts
  WHERE workspace_id = ? AND workstream_id = ?
  ORDER BY created_at DESC
  LIMIT 250`;

const WORKSTREAM_HARNESS_TASKS_SQL = `SELECT hr.*,
    m.id AS transcript_message_id,
    (SELECT COUNT(*) FROM tool_invocations ti WHERE ti.harness_run_id = hr.id) AS tool_uses
  FROM harness_runs hr
  LEFT JOIN messages m
    ON m.workstream_id = hr.workstream_id
   AND m.client_message_id = ('harness:' || hr.id)
  WHERE hr.workspace_id = ? AND hr.workstream_id = ?
    AND hr.origin != 'hypersight_block'
  ORDER BY COALESCE(hr.started_at, hr.created_at) DESC
  LIMIT 250`;

const WORKSTREAM_TOOL_TASKS_SQL = `SELECT ti.*, hr.created_at AS harness_created_at
  FROM tool_invocations ti
  JOIN harness_runs hr ON hr.id = ti.harness_run_id
  WHERE ti.workspace_id = ? AND ti.workstream_id = ?
    AND hr.origin != 'hypersight_block'
  ORDER BY COALESCE(ti.started_at, hr.created_at) DESC
  LIMIT 500`;

const ADDITIONAL_MEMBER_SAFE_HARNESS_ERRORS = Object.freeze({
  empty_completion: "The model provider returned an empty response",
  model_output_invalid: "The model provider returned an invalid response",
  provider_error: "The model provider could not complete this run",
  run_admission_timeout: "This work stream stayed busy too long to start the run",
  run_cancelled: "This run was cancelled",
  run_ownership_lost: "This run was superseded by another executor",
  stale_run_reaped: "This run stopped after its execution lease expired",
  workflow_unavailable: "Avalon could not start this run",
} satisfies Readonly<Record<string, string>>);

const GENERIC_MEMBER_SAFE_HARNESS_ERROR = Object.freeze({
  code: "harness_execution_failed",
  message: "The Avalon harness could not complete this run",
});

export async function launchWorkstreamHarness(
  env: Env,
  input: {
    workspaceId: string;
    workstreamId: string;
    triggerMessageId: string | null;
    origin: string;
    executionPrincipal: ExecutionPrincipal;
    slackOrigin?: SlackOriginContext;
    slackSearchAuthorization?: SlackSearchAuthorization;
    parentHarnessRunId?: string;
    supersedeActiveRun?: boolean;
    scheduledWakeupId?: string;
    digestDeliveryId?: string;
  },
): Promise<string> {
  const id = newId();
  const at = nowIso();
  const model = await scheduledWorkstreamModelForExisting(env, {
    workspaceId: input.workspaceId,
    workstreamId: input.workstreamId,
  });
  await env.DB.batch([
    ...(input.supersedeActiveRun ? [env.DB.prepare(
      `UPDATE harness_runs
          SET cancellation_requested_at = COALESCE(cancellation_requested_at, ?),
              cancellation_reason = COALESCE(cancellation_reason, 'superseded_by_follow_up')
        WHERE workspace_id = ? AND workstream_id = ?
          AND origin != 'hypersight_block'
          AND parent_tool_call_id IS NULL
          AND status IN ('scheduled', 'running') AND terminalized_at IS NULL`,
    ).bind(at, input.workspaceId, input.workstreamId)] : []),
    env.DB.prepare(
      `INSERT INTO harness_runs
       (id, workspace_id, workstream_id, origin, execution_principal_json, parent_harness_run_id,
        status, started_at, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
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
    ),
    env.DB.prepare(
      `UPDATE workstreams SET harness_status = 'running', last_activity_at = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    ).bind(at, at, input.workstreamId, input.workspaceId),
  ]);
  const workflowInput: WorkstreamWorkflowInput = {
    region: env.AVALON_REGION,
    workspaceId: input.workspaceId,
    workstreamId: input.workstreamId,
    harnessRunId: id,
    triggerMessageId: input.triggerMessageId,
    automationSubscriptionId: null,
    activityId: null,
    executionPrincipal: input.executionPrincipal,
    ...(input.scheduledWakeupId ? { scheduledWakeupId: input.scheduledWakeupId } : {}),
    ...(input.digestDeliveryId ? { digestDeliveryId: input.digestDeliveryId } : {}),
    ...(input.slackOrigin ? { slackOrigin: input.slackOrigin } : {}),
    ...(input.slackSearchAuthorization
      ? { slackSearchAuthorization: input.slackSearchAuthorization }
      : {}),
    reason: input.origin,
  };
  /*
   * The Workflows round trip stays on the caller's path, and it is the slowest
   * step in a create. Handing it to `waitUntil` was tried and reverted: the run
   * row above already says `running` while `attempt_id` and `lease_expires_at`
   * stay NULL until the Workflow admits the run, and nothing reaps that shape.
   * A dropped deferral therefore left a work stream permanently "working" —
   * `stop` only records a request a live workflow has to observe, `retry`
   * refuses a `running` stream, and no screen offers either. Losing the start
   * here instead fails loudly, in front of the person who asked for it.
   */
  try {
    await startWorkstreamWorkflow(env, workflowInput);
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
    // The work stream and its run exist whatever the caller does with the 503,
    // so anyone already watching is told the run failed rather than left on a
    // `running` row that nothing will move.
    await publishWorkstreamEvent(env, input.workspaceId, input.workstreamId, {
      type: "harness_status_changed",
      status: "failed",
    });
    throw new ApiError(503, "workflow_unavailable", "The Avalon harness could not be started");
  }
  await publishWorkstreamEvent(env, input.workspaceId, input.workstreamId, {
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
      workspaceId: row.workspace_id,
      workstreamId: row.workstream_id,
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
 * How much of a message body the activity log keeps. Long enough for a digest
 * to summarize from the log alone without re-reading `messages`, short enough
 * that the log does not become a second copy of the transcript.
 */
const ACTIVITY_EVENT_BODY_LIMIT = 2_000;

/**
 * Shorten a wake-up prompt for its transcript row.
 *
 * Break on a word boundary and mark the cut. A hard slice ends mid-word, which
 * reads as a rendering bug rather than as a summary of something longer, and
 * the full prompt is the run's own trigger anyway.
 */
/**
 * Row contracts for the reads behind a work-stream detail.
 *
 * The rest of this file used to hand-coerce every column — `String(row.title)`,
 * `String(row.harness_status) as "running" | …` — which converts anything at all
 * into something type-shaped. A row that did not match went undetected until the
 * response schema rejected it on the way out, where a mismatch is a 500 naming
 * neither the route nor the field. That is not hypothetical: an activity title
 * longer than `ActivitySuggestionSchema` allows made this work stream
 * unopenable for a whole workspace for 67 minutes, and identifying the field
 * afterwards took a deployment timeline and a database replay.
 *
 * Each schema below mirrors what the table already guarantees — the enums are
 * the columns' own CHECK constraints, not new invention — so parsing costs
 * nothing a correct row would fail. Where a column has *no* constraint and a
 * contract downstream does, the bound is applied here, at the read, which is the
 * only place that knows both.
 */
const rowText = z.string();
const rowId = z.string().min(1);
const rowTimestamp = z.string().min(1);
const rowCount = z.number().int().nonnegative();
/** SQLite has no boolean; the queries above project 1/0. */
const rowFlag = z.union([z.literal(0), z.literal(1)]);

/** Bounded for a contract downstream that the column itself does not enforce. */
const displayText = (max: number) => z.string().transform((value) => truncateUtf16Safe(value, max));


const ParticipantRowSchema = z.object({
  id: rowId,
  email: rowText,
  name: rowText,
  avatar_url: rowText.nullish(),
  timezone: rowText,
  created_at: rowTimestamp,
  participation_reason: z.enum(["creator", "explicit", "message", "elicitation", "action"]),
  joined_at: rowTimestamp,
});

const ResourceRowSchema = z.object({
  id: rowId,
  workspace_id: rowId,
  connection_id: rowId.nullish(),
  resource_type: rowText,
  provider: rowText,
  provider_resource_id: rowText.nullish(),
  // `resources.title` carries no length constraint, and `ResourceSchema` caps it.
  title: displayText(300),
  // Bounded for the same reason as `title`, and easier to miss: `mime_type` is
  // written from a client-supplied header, so it is the one an ordinary member
  // controls most directly.
  mime_type: displayText(160).nullish(),
  canonical_url: rowText.nullish(),
  watch_enabled: rowFlag,
  watch_status: z.enum(["unsupported", "watching", "paused"]),
  last_hydrated_at: rowText.nullish(),
  created_at: rowTimestamp,
  updated_at: rowTimestamp,
});

const ArtifactRowSchema = z.object({
  id: rowId,
  workspace_id: rowId,
  workstream_id: rowId,
  harness_run_id: rowId.nullish(),
  artifact_type: rowText,
  // Safe today only because `workstream_create_artifact` is the sole writer and
  // bounds it to 300. Bounding it here too makes the context panel structurally
  // safe against a second writer rather than conventionally safe.
  title: displayText(300),
  preview_text: rowText.nullish(),
  status: rowText,
  metadata_json: rowText.nullish(),
  created_at: rowTimestamp,
  updated_at: rowTimestamp,
});

const HarnessTaskRowSchema = z.object({
  id: rowId,
  origin: rowText,
  status: rowText,
  usage_json: rowText.nullish(),
  tool_uses: rowCount.nullish(),
  transcript_message_id: rowId.nullish(),
  started_at: rowTimestamp.nullish(),
  completed_at: rowText.nullish(),
  created_at: rowTimestamp,
});

const ToolTaskRowSchema = z.object({
  id: rowId,
  harness_run_id: rowId,
  tool_name: rowText,
  status: rowText,
  connection_id: rowId.nullish(),
  started_at: rowTimestamp.nullish(),
  completed_at: rowText.nullish(),
  harness_created_at: rowTimestamp,
});

const ElicitationRowSchema = z.object({
  id: rowId,
  workstream_id: rowId,
  harness_run_id: rowId,
  prompt: rowText,
  response_type: z.enum(["text", "radio", "single_select", "multi_select"]),
  options_json: rowText.nullish(),
  minimum_selections: rowCount,
  maximum_selections: rowCount.nullish(),
  target_user_id: rowId.nullish(),
  status: z.enum(["open", "answered", "cancelled"]),
  answer_json: rowText.nullish(),
  answered_by_user_id: rowId.nullish(),
  created_at: rowTimestamp,
  answered_at: rowText.nullish(),
});

const SuggestionRowSchema = z.object({
  id: rowId,
  activity_id: rowId,
  workstream_id: rowId,
  // Joined from `activities`, whose title and summary carry no length
  // constraint. A GitHub push title is the whole commit body, so these run past
  // what `ActivitySuggestionSchema` accepts as a matter of course.
  title: displayText(300),
  summary: displayText(2_000),
  confidence: z.number().min(0).max(1),
  reason: displayText(1_200),
  status: z.enum(["pending", "accepted", "dismissed"]),
  created_at: rowTimestamp,
  resolved_at: rowText.nullish(),
});

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

export class WorkstreamService {
  private readonly database;

  constructor(
    private readonly env: Env,
    private readonly auth: AuthContext,
    private readonly defer?: (promise: Promise<unknown>) => void,
  ) {
    this.database = createDatabase(env.DB);
  }

  async list(limit: number, before?: string, includeSystem = false) {
    const cursorClause = before ? "AND w.last_activity_at < ?" : "";
    // Two different questions. `system_kind` says this is machinery, which
    // decides whether it is listed at all; `scope` says who may read it, and is
    // enforced below whatever the caller asked to see.
    const systemClause = includeSystem ? "" : "AND w.system_kind IS NULL";
    const statement = this.env.DB.prepare(
      `SELECT w.*, ${WORKSTREAM_VIEWER_COLUMNS_SQL}
       FROM workstreams w
       ${WORKSTREAM_VIEWER_JOINS_SQL}
       WHERE w.workspace_id = ? AND w.archived_at IS NULL ${systemClause} ${cursorClause}
         AND ${WORKSTREAM_VISIBILITY_SQL}
       ORDER BY w.last_activity_at DESC LIMIT ?`,
    );
    const visibility = workstreamVisibilityBindings(this.auth.userId);
    const result = before
      ? await statement.bind(this.auth.userId, this.auth.workspaceId, before, ...visibility, limit + 1).all<Record<string, unknown>>()
      : await statement.bind(this.auth.userId, this.auth.workspaceId, ...visibility, limit + 1).all<Record<string, unknown>>();
    const rows = result.results ?? [];
    const unreconciledAddressRows = rows.filter((row) =>
      row.email_address == null || row.email_route_status !== "active");
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
    const items = rows.map(toWorkstream);
    const hasMore = items.length > limit;
    if (hasMore) items.pop();
    return { items, nextCursor: hasMore ? items.at(-1)?.lastActivityAt ?? null : null };
  }

  async create(
    input: CreateWorkstreamInput,
    slackOrigin?: SlackOriginContext,
    slackSearchAuthorization?: SlackSearchAuthorization,
  ) {
    const attachmentIds = [...new Set(input.attachmentIds)];
    // Two independent reads, and both return without touching D1 when there is
    // nothing to check — which is the common case, so this costs nothing there
    // and saves a round trip whenever a create names people or carries files.
    // They still run ahead of the reservation below: a create that is going to
    // be refused should not leave an email address reserved for a work stream
    // that never exists.
    //
    // Settled rather than raced, and rethrown in a fixed order: a request that
    // violates both would otherwise get whichever 422 happened to reject first,
    // so the code a client sees for one bad request would not be stable.
    const preflight = await Promise.allSettled([
      this.assertMembersExist(input.participantUserIds),
      this.assertDraftAttachments(attachmentIds),
    ]);
    for (const outcome of preflight) {
      if (outcome.status === "rejected") throw outcome.reason;
    }
    const objective = input.objective
      ?? (input.openingMessage.trim() || "Review the attached files");
    const title = input.title ?? provisionalWorkstreamTitle(objective, "New work stream");
    const workstreamId = newId();
    const emailRouting = new WorkstreamEmailRoutingService(this.env);
    const routeInput = {
      region: this.env.AVALON_REGION,
      workspaceId: this.auth.workspaceId,
      workstreamId,
    } as const;
    const emailRoute = await emailRouting.reserve(routeInput);
    const created = await this.database.workstreams.create({
      id: workstreamId,
      workspaceId: this.auth.workspaceId,
      title,
      // A caller-supplied title is a decision already made; anything derived
      // from the objective is a placeholder until the naming agent answers.
      titleStatus: input.title == null ? "naming" : "settled",
      objective,
      descriptionSource: input.descriptionSource ?? "derived",
      emailAddress: emailRoute.emailAddress,
      creatorUserId: this.auth.userId,
      openingAuthor: { type: "human", userId: this.auth.userId },
      openingMessage: input.openingMessage,
      clientMessageId: input.clientMessageId,
      participantUserIds: input.participantUserIds,
      attachmentIds,
      // Written before the harness is launched below, which is what lets the
      // run this create starts already resolve to the pinned model.
      modelOverride: input.modelOverride ?? null,
    });
    // Deferring this was tried and reverted. It costs a second hop to the
    // Global registry outside Global, but the create that would have saved it
    // immediately invalidates the work-stream list, and `list` backfills every
    // route that is not yet `active` — so the same hop was paid a moment later
    // by the refresh, against extra D1 reads, with two activations of one route
    // able to overlap and fail each other's reconcile.
    await emailRouting.activateWorkstreamRoute(routeInput);
    const messages = await this.database.workstreams.listMessages(this.auth.workspaceId, created.workstream.id, 1);
    const message = messages[0];
    // Ahead of the harness launch below rather than beside it: both land in the
    // same Durable Object log, and a client resyncing from a sequence must not
    // see the run start before the message that triggered it.
    if (message) await publishWorkstreamEvent(this.env, this.auth.workspaceId, created.workstream.id, { type: "message_created", message });
    const harnessRunId = await this.launchHarness(
      created.workstream.id,
      created.messageId,
      "opening_message",
      undefined,
      slackOrigin,
      slackSearchAuthorization,
    );
    // Only when the caller did not supply one: a title that arrived with the
    // request is a decision already made, not a placeholder to improve on.
    if (input.title == null) {
      await this.nameInBackground({
        workstreamId: created.workstream.id,
        objective,
        openingMessage: input.openingMessage,
        provisionalTitle: title,
      });
    }
    return { ...created, harnessRunId };
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
    const workstreamId = newId();
    const emailRouting = new WorkstreamEmailRoutingService(this.env);
    const routeInput = {
      region: this.env.AVALON_REGION,
      workspaceId: this.auth.workspaceId,
      workstreamId,
    } as const;
    const emailRoute = await emailRouting.reserve(routeInput);
    const created = await this.database.workstreams.create({
      id: workstreamId,
      workspaceId: this.auth.workspaceId,
      title: input.displayPrompt,
      titleStatus: "naming",
      objective: input.displayPrompt,
      emailAddress: emailRoute.emailAddress,
      creatorUserId: this.auth.userId,
      openingAuthor: { type: "agent" },
      openingMessage: input.executionPrompt,
      openingStructuredContent: {
        kind: "suggested_work_expansion",
        label: "Expanded by Avalon from suggested work",
        opportunityId: input.opportunityId,
        opportunityVersion: input.version,
      },
      clientMessageId: `opportunity:${input.opportunityId}:v${input.version}`,
      participantUserIds: [],
      attachmentIds: [],
      opportunitySnapshot: {
        opportunityId: input.opportunityId,
        version: input.version,
        displayPromptHash: input.displayPromptHash,
        executionPromptHash: input.executionPromptHash,
      },
    });
    await emailRouting.activateWorkstreamRoute(routeInput);
    const messages = await this.database.workstreams.listMessages(this.auth.workspaceId, created.workstream.id, 1);
    const message = messages[0];
    if (message) {
      await publishWorkstreamEvent(this.env, this.auth.workspaceId, created.workstream.id, {
        type: "message_created",
        message,
      });
    }
    const harnessRunId = await this.launchHarness(created.workstream.id, created.messageId, "suggested_work");
    await this.nameInBackground({
      workstreamId: created.workstream.id,
      objective: input.displayPrompt,
      openingMessage: input.executionPrompt,
      provisionalTitle: input.displayPrompt,
    });
    return { ...created, harnessRunId };
  }

  /**
   * Name the work stream after the response has gone out.
   *
   * The model call is deliberately outside the creation path: the person who
   * typed the request is waiting on that response, and a name is worth about a
   * second of latency to nobody. The work stream is created under its
   * provisional title, the run starts against the unchanged objective, and the
   * rename lands over the socket a moment later.
   *
   * A caller that supplied no way to defer gets the call awaited instead of
   * dropped. Those callers — Slack ingress, tests — are not the ones a person
   * is waiting on, and an unawaited promise in a Worker is not guaranteed to
   * finish once the response is sent.
   */
  private async nameInBackground(input: {
    workstreamId: string;
    objective: string;
    openingMessage: string;
    provisionalTitle: string;
  }): Promise<void> {
    const task = nameWorkstream(this.env, {
      workspaceId: this.auth.workspaceId,
      userId: this.auth.userId,
      ...input,
    });
    if (!this.defer) return task;
    this.defer(task);
  }

  async get(id: string): Promise<WorkstreamDetail> {
    const workstream = await this.requireWorkstream(id);
    const [participants, resources, connections, openElicitations, suggestions, latestHarness] = await Promise.all([
      this.loadParticipants(id),
      this.loadResources(id),
      this.loadConnections(),
      this.loadElicitations(id),
      this.loadSuggestions(id),
      this.env.DB.prepare(
        `SELECT id, origin, status, model, error_json, started_at, completed_at, created_at
         FROM harness_runs
         WHERE workspace_id = ? AND workstream_id = ?
           AND parent_tool_call_id IS NULL
           AND origin != 'hypersight_block'
         ORDER BY created_at DESC LIMIT 1`,
      ).bind(this.auth.workspaceId, id).first<Record<string, unknown>>(),
    ]);
    return WorkstreamDetailSchema.parse({
      ...workstream,
      participants,
      viewers: [],
      resources,
      connections,
      artifacts: [],
      backgroundTasks: [],
      openElicitations,
      suggestions,
      latestHarnessRunId: latestHarness?.id ?? null,
      latestHarnessRun: latestHarness ? {
        id: String(latestHarness.id),
        origin: String(latestHarness.origin),
        status: String(latestHarness.status),
        model: latestHarness.model == null ? null : String(latestHarness.model),
        error: memberSafeHarnessError(latestHarness.error_json),
        requestId: String(latestHarness.id),
        startedAt: latestHarness.started_at == null ? null : String(latestHarness.started_at),
        completedAt: latestHarness.completed_at == null ? null : String(latestHarness.completed_at),
        createdAt: String(latestHarness.created_at),
      } : null,
    });
  }

  async context(id: string) {
    await this.requireWorkstream(id);
    const [artifacts, backgroundTasks] = await Promise.all([
      this.loadArtifacts(id),
      this.loadBackgroundTasks(id),
    ]);
    return { artifacts, backgroundTasks };
  }

  async update(id: string, input: UpdateWorkstreamInput) {
    const before = await this.requireWorkstreamForUpdate(id);
    if (Object.keys(input).length === 0) throw new ApiError(422, "empty_update", "No work-stream fields were provided");
    const previousScope = before.scope === "personal" ? "personal" : "workspace";
    const scopeChanged = input.scope != null && input.scope !== previousScope;
    if (scopeChanged) this.assertScopeIsThisRowsToDecide(before);
    // Whoever makes a work stream private has to stay in the room they just
    // closed, and `personal` is enforced as "an active participant, and nobody
    // else" — so this is what stops the change from being the one action in
    // Avalon that locks its author out of its own result. It goes in the same
    // batch as the scope itself: a work stream that went private while the
    // upsert failed would be one nobody may read, and a participant added to a
    // work stream whose scope write then failed would be a permanent stray.
    const joining = scopeChanged && input.scope === "personal";
    // Whether the upsert will actually add them, rather than land on the row
    // they already have. Someone who has been in this work stream for weeks is
    // not joining it by closing it, and announcing that they were would refresh
    // every reader's participant list and HyperSight for nothing.
    const joined = joining && !(await this.isActiveParticipant(id, this.auth.userId));
    const at = nowIso();
    const write = this.env.DB.prepare(
      `UPDATE workstreams SET
       title = COALESCE(?, title), objective = COALESCE(?, objective),
       scope = COALESCE(?, scope),
       description_source = CASE WHEN ? IS NULL OR ? = objective THEN description_source ELSE 'authored' END,
       -- A person naming a work stream settles it: a naming pass still in
       -- flight must not overwrite what they chose.
       title_status = CASE WHEN ? IS NULL THEN title_status ELSE 'settled' END,
       archived_at = CASE WHEN ? IS NULL THEN archived_at WHEN ? = 1 THEN ? ELSE NULL END,
       email_route_status = CASE WHEN ? IS NULL THEN email_route_status ELSE 'reserved' END,
       updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    )
      .bind(
        input.title ?? null,
        input.objective ?? null,
        input.scope ?? null,
        input.objective ?? null,
        input.objective ?? null,
        input.title ?? null,
        input.archived == null ? null : Number(input.archived),
        Number(input.archived ?? false),
        at,
        input.archived == null ? null : Number(input.archived),
        at,
        id,
        this.auth.workspaceId,
      );
    // The person just answered the only question the refresh loop asks, so the
    // loop rests rather than spending a model call second-guessing them. It
    // lands in the same batch as the description itself: a refresh that read
    // between the two writes would see the new description with no rest
    // recorded, claim, and be free to overwrite it.
    // A PATCH that resubmits the description unchanged is not an authorship
    // event: it would flip the provenance and reset the loop's state without
    // anyone having said anything.
    const previousDescription = String(before.objective ?? "");
    const authored = input.objective != null && input.objective !== previousDescription;
    // The participant upsert comes first so that, batch or not, no reader can
    // observe the narrowed scope ahead of the person it has to keep.
    const statements = [
      ...(joining
        ? [buildParticipantUpsertStatement(this.env.DB, {
            workspaceId: this.auth.workspaceId,
            workstreamId: id,
            userId: this.auth.userId,
            addedByUserId: this.auth.userId,
            reason: "explicit",
          })]
        : []),
      write,
      ...(authored
        ? [await describeAuthoredDescriptionStatement(this.env, {
            workspaceId: this.auth.workspaceId,
            workstreamId: id,
            description: input.objective!,
            previousDescription,
          })]
        : []),
    ];
    if (statements.length > 1) await this.env.DB.batch(statements);
    else await write.run();
    if (input.archived != null) {
      await new WorkstreamEmailRoutingService(this.env).ensureWorkstreamAddress({
        region: this.env.AVALON_REGION,
        workspaceId: this.auth.workspaceId,
        workstreamId: id,
      });
    }
    const updated = toWorkstream(await this.requireWorkstreamForUpdate(id));
    // Everyone else looking at this work stream has its old title on screen —
    // in the header they are reading and in their sidebar. The same event the
    // naming agent publishes carries a human rename to them too.
    if (input.title != null) {
      await publishWorkstreamEvent(this.env, this.auth.workspaceId, id, {
        type: "workstream_renamed",
        title: updated.title,
        titleStatus: "settled",
      });
    }
    // Joining is a real membership change, not bookkeeping: without the event
    // the actor is a participant in D1 and absent from the right rail — their
    // own included — until something forces a reload, and nothing does.
    if (joined) {
      const participant = (await this.loadParticipants(id)).find((item) => item.user.id === this.auth.userId);
      if (participant) {
        await publishWorkstreamEvent(this.env, this.auth.workspaceId, id, {
          type: "participant_added",
          participant,
        });
      }
    }
    // The room is the only thing that knows who is reading this work stream
    // right now. It applies the new state to the people who may stay and closes
    // the sockets of those this change just excluded — a member who had it open
    // when it went private would otherwise keep receiving its transcript.
    if (scopeChanged) {
      const delivered = await publishWorkstreamEvent(this.env, this.auth.workspaceId, id, {
        type: "workstream_scope_changed",
        scope: updated.scope,
      });
      // For every other event this publisher's silence is fine. Here it is the
      // difference between an eviction that happened and one that did not, and
      // the caller has already been told the work stream is closed. The room
      // re-checks its own connected set within the interval either way, so this
      // is a delay to alert on rather than a failure to undo — but it must not
      // be invisible.
      if (!delivered && updated.scope === "personal") {
        logStructuredEvent(this.env, "error", "workstream_scope_retraction_undelivered", {
          workspace_id: this.auth.workspaceId,
          workstream_id: id,
        });
      }
    }
    return updated;
  }

  /**
   * Whether `scope` is the rule that actually decides who reads this row.
   *
   * For an ordinary work stream it is, and both directions mean what the menu
   * says. Two kinds of row are governed by something else, and moving their
   * scope would either do nothing or do harm:
   *
   * - **A subsystem's own work stream** (`system_kind`) is machinery. A digest
   *   is assembled from one person's private activity, so publishing it to the
   *   workspace would hand that activity to everyone.
   * - **A work stream an automation generated** takes its audience from that
   *   automation's scope, which is checked separately and independently of this
   *   column. Opening it would broaden nothing, and closing it would hide the
   *   row from the automation's owner, who is reached by that separate rule
   *   rather than by being a participant.
   */
  private assertScopeIsThisRowsToDecide(row: Record<string, unknown>): void {
    if (row.system_kind != null) {
      throw new ApiError(
        422,
        "scope_change_unsupported",
        "This work stream belongs to Avalon itself, so its visibility cannot be changed",
      );
    }
    if (row.automation_subscription_id != null) {
      throw new ApiError(
        422,
        "scope_change_unsupported",
        "This work stream is visible to whoever the automation that created it is visible to",
      );
    }
  }

  async messages(id: string, limit: number, before?: number, after?: number, around?: number) {
    await this.requireWorkstream(id);
    if (around !== undefined) {
      const olderLimit = Math.max(1, Math.min(50, Math.floor(limit / 4)));
      const newerLimit = Math.max(1, limit - olderLimit);
      const [older, newer] = await Promise.all([
        this.database.workstreams.listMessages(this.auth.workspaceId, id, olderLimit + 1, around + 1),
        this.database.workstreams.listMessagesAfter(this.auth.workspaceId, id, around, newerLimit + 1),
      ]);
      const hasOlder = older.length > olderLimit;
      const hasNewer = newer.length > newerLimit;
      if (hasOlder) older.shift();
      if (hasNewer) newer.pop();
      const items = [...older, ...newer];
      return {
        items,
        nextCursor: hasOlder ? String(items[0]?.sequenceNumber ?? "") : null,
        newerCursor: hasNewer ? String(items.at(-1)?.sequenceNumber ?? "") : null,
      };
    }
    if (after !== undefined) {
      const items = await this.database.workstreams.listMessagesAfter(this.auth.workspaceId, id, after, limit + 1);
      const hasMore = items.length > limit;
      if (hasMore) items.pop();
      return {
        items,
        nextCursor: null,
        newerCursor: hasMore ? String(items.at(-1)?.sequenceNumber ?? "") : null,
      };
    }
    const items = await this.database.workstreams.listMessages(this.auth.workspaceId, id, limit + 1, before);
    const hasMore = items.length > limit;
    if (hasMore) items.shift();
    return {
      items,
      nextCursor: hasMore ? String(items[0]?.sequenceNumber ?? "") : null,
      newerCursor: null,
    };
  }

  async acknowledgeRead(id: string, input: AcknowledgeReadInput) {
    const workstream = await this.requireWorkstream(id);
    if (input.readThroughSequenceNumber > workstream.latestAttentionSequenceNumber) {
      throw new ApiError(422, "invalid_read_sequence", "The read cursor is ahead of the latest message requiring attention");
    }
    const at = nowIso();
    await this.env.DB.prepare(
      `INSERT INTO workstream_read_states
       (workspace_id, workstream_id, user_id, read_through_sequence_number,
        manual_unread_from_sequence_number, manual_unread_generation, updated_at)
       VALUES (?, ?, ?, ?, NULL, 0, ?)
       ON CONFLICT(workstream_id, user_id) DO UPDATE SET
         read_through_sequence_number = MAX(
           workstream_read_states.read_through_sequence_number,
           excluded.read_through_sequence_number
         ),
         manual_unread_from_sequence_number = CASE
           WHEN workstream_read_states.manual_unread_generation = ?
             AND excluded.read_through_sequence_number >= COALESCE(
               workstream_read_states.manual_unread_from_sequence_number,
               excluded.read_through_sequence_number
             )
           THEN NULL
           ELSE workstream_read_states.manual_unread_from_sequence_number
         END,
         updated_at = excluded.updated_at`,
    ).bind(
      this.auth.workspaceId,
      id,
      this.auth.userId,
      input.readThroughSequenceNumber,
      at,
      input.observedManualUnreadGeneration,
    ).run();
    return this.requireWorkstream(id);
  }

  async markUnread(id: string) {
    const workstream = await this.requireWorkstream(id);
    if (workstream.latestAttentionSequenceNumber === 0) return workstream;
    const at = nowIso();
    await this.env.DB.prepare(
      `INSERT INTO workstream_read_states
       (workspace_id, workstream_id, user_id, read_through_sequence_number,
        manual_unread_from_sequence_number, manual_unread_generation, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(workstream_id, user_id) DO UPDATE SET
         manual_unread_from_sequence_number = excluded.manual_unread_from_sequence_number,
         manual_unread_generation = workstream_read_states.manual_unread_generation + 1,
         updated_at = excluded.updated_at`,
    ).bind(
      this.auth.workspaceId,
      id,
      this.auth.userId,
      workstream.readThroughSequenceNumber,
      workstream.latestAttentionSequenceNumber,
      at,
    ).run();
    return this.requireWorkstream(id);
  }

  async createMessage(
    id: string,
    input: CreateMessageInput,
    slackOrigin?: SlackOriginContext,
    slackSearchAuthorization?: SlackSearchAuthorization,
  ) {
    const workstream = await this.requireWorkstream(id);
    const replayed = await this.loadMessageByClientId(id, input.clientMessageId);
    if (replayed) {
      return { message: replayed, agentInvoked: false, harnessRunId: null };
    }
    const attachmentIds = [...new Set(input.attachmentIds)];
    await this.assertDraftAttachments(attachmentIds);
    const personIds = [...new Set(input.mentions
      .filter((mention) => mention.type === "person" && mention.userId)
      .map((mention) => mention.userId!))];
    const mentionPeople = await this.loadMentionPeople(personIds);
    if (mentionPeople.size !== personIds.length) {
      throw new ApiError(422, "invalid_workspace_member", "A mentioned person is not an active workspace member");
    }
    const preparedMention = prepareMentionMarkdown(input.text, input.mentions, mentionPeople);
    const preparedInput: CreateMessageInput = {
      ...input,
      attachmentIds,
      text: preparedMention.text,
      mentions: preparedMention.mentions,
    };
    const unconfirmed = await this.nonParticipantIds(id, personIds.filter((userId) => !input.confirmedParticipantUserIds.includes(userId)));
    if (unconfirmed.length > 0) {
      const people = await this.memberNames(unconfirmed);
      throw new ApiError(409, "participant_confirmation_required", "Confirm before mentioning a nonparticipant", {
        people,
      });
    }
    await this.assertMembersExist(input.confirmedParticipantUserIds);
    const persisted = await this.persistHumanMessage(id, preparedInput);
    if (!persisted.inserted) {
      return { message: persisted.message, agentInvoked: false, harnessRunId: null };
    }
    const message = persisted.message;
    await Promise.all(
      input.confirmedParticipantUserIds.map((userId) =>
        this.database.workstreams.addParticipant(this.auth.workspaceId, id, userId, this.auth.userId, "explicit"),
      ),
    );
    if (preparedInput.mentions.length > 0) {
      await this.env.DB.batch(
        preparedInput.mentions.map((mention) =>
          this.env.DB.prepare(
            `INSERT OR IGNORE INTO message_mentions
             (message_id, mention_type, mentioned_user_id, connector_type, start_offset, end_offset)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).bind(message.id, mention.type, mention.userId, mention.connectorType, mention.startOffset, mention.endOffset),
        ),
      );
    }
    const messageWithMentions = { ...message, mentions: preparedInput.mentions };
    await publishWorkstreamEvent(this.env, this.auth.workspaceId, id, { type: "message_created", message: messageWithMentions });
    const mentionedOtherUsers = personIds.filter((userId) => userId !== this.auth.userId);
    await this.recordMessageActivityEvent(messageWithMentions, workstream, mentionedOtherUsers);
    if (mentionedOtherUsers.length > 0) {
      await enqueueMentionOpportunities(
        this.env,
        this.auth.workspaceId,
        message.id,
        mentionedOtherUsers,
      ).catch((error: unknown) => {
        logWarn(this.env, "mention_work_opportunity_enqueue_failed", {
          workspace_id: this.auth.workspaceId,
          workstream_id: id,
          message_id: message.id,
          reason: error instanceof Error ? error.message : "unknown",
        });
      });
    }
    this.scheduleMentionNotifications(messageWithMentions, workstream);
    // A reply is where the detail a name was missing usually arrives, so this
    // is the moment to look at an Avalon-chosen title again. It stops on a
    // bounded count for every work stream that is not due one, and it handles
    // its own failures, which is what `deferTask` requires of anything it is
    // handed — on a path without an execution context the promise is dropped
    // rather than awaited, and a rejection would have nowhere to go.
    this.deferTask(refreshWorkstreamName(this.env, {
      workspaceId: this.auth.workspaceId,
      workstreamId: id,
      userId: this.auth.userId,
    }));
    const connectorMentions = preparedInput.mentions
      .filter((mention) => mention.type === "connector" && mention.connectorType)
      .map((mention) => mention.connectorType!);
    const participantCount = await this.activeParticipantCount(id);
    let shouldInvoke = participantCount === 1 || attachmentIds.length > 0;
    if (!shouldInvoke) {
      const recentMessages = await this.recentAddressingMessages(id, message.sequenceNumber);
      const classification = await classifyWorkstreamMessage(this.env, {
        workspaceId: this.auth.workspaceId,
        workstreamId: id,
        message: input.text,
        activeTask: workstream.harnessStatus === "running" || workstream.harnessStatus === "needs_input",
        connectorMentions,
        recentMessages,
      });
      shouldInvoke =
        classification.classification === "agent_action" ||
        classification.classification === "both" ||
        (classification.classification === "uncertain" && (workstream.harnessStatus === "running" || connectorMentions.length > 0));
    }
    const harnessRunId = shouldInvoke
      ? await this.launchHarness(
          id,
          message.id,
          "human_message",
          undefined,
          slackOrigin,
          slackSearchAuthorization,
        )
      : null;
    return { message: messageWithMentions, agentInvoked: shouldInvoke, harnessRunId };
  }

  private async recentAddressingMessages(id: string, beforeSequence: number) {
    const result = await this.env.DB.prepare(
      `SELECT m.author_type, u.name AS author_name, m.text_content
         FROM messages m
         LEFT JOIN users u ON u.id = m.author_user_id
        WHERE m.workspace_id = ?
          AND m.workstream_id = ?
          AND m.sequence_number < ?
          AND m.message_type = 'text'
          AND m.author_type IN ('human', 'agent')
        ORDER BY m.sequence_number DESC
        LIMIT 10`,
    ).bind(this.auth.workspaceId, id, beforeSequence).all<{
      author_type: "human" | "agent";
      author_name: string | null;
      text_content: string;
    }>();
    return (result.results ?? []).reverse().map((row) => ({
      authorType: row.author_type,
      authorName: row.author_type === "agent" ? "Avalon" : row.author_name,
      message: row.text_content,
    }));
  }

  async addParticipant(id: string, userId: string) {
    await this.requireWorkstream(id);
    await this.assertMembersExist([userId]);
    await this.database.workstreams.addParticipant(this.auth.workspaceId, id, userId, this.auth.userId, "explicit");
    const participant = (await this.loadParticipants(id)).find((item) => item.user.id === userId);
    // The reload can miss if the membership changed underneath this request.
    // The route parses this against `ParticipantSchema`, so returning undefined
    // produced an anonymous 500 on a path whose write had already committed.
    if (!participant) {
      throw new ApiError(409, "participant_reload_failed", "The participant was added but could not be read back");
    }
    await publishWorkstreamEvent(this.env, this.auth.workspaceId, id, { type: "participant_added", participant });
    return participant;
  }

  async removeParticipant(id: string, userId: string): Promise<void> {
    await this.requireWorkstream(id);
    if (userId !== this.auth.userId && this.auth.role !== "owner" && this.auth.role !== "admin") {
      throw new ApiError(403, "participant_removal_denied", "You can only remove yourself from this work stream");
    }
    await this.env.DB.prepare(
      `UPDATE workstream_participants SET removed_at = ?
       WHERE workstream_id = ? AND user_id = ?`,
    ).bind(nowIso(), id, userId).run();
    await publishWorkstreamEvent(this.env, this.auth.workspaceId, id, { type: "participant_removed", userId });
  }

  async attachResource(id: string, resourceId: string) {
    await this.requireWorkstream(id);
    // Inbound-email resources inherit work-stream visibility rather than a
    // connector scope. Authorize the source before allowing an attachment to
    // share it with another work stream.
    await new ResourceService(this.env, this.auth).get(resourceId);
    const resource = await this.env.DB.prepare(
      `SELECT r.*, c.scope AS connection_scope, c.owner_user_id,
          note.scope AS note_scope
       FROM resources r LEFT JOIN connector_connections c ON c.id = r.connection_id
       LEFT JOIN notes note ON note.resource_id = r.id AND note.archived_at IS NULL
       WHERE r.id = ? AND r.workspace_id = ?`,
    ).bind(resourceId, this.auth.workspaceId).first<Record<string, unknown>>();
    if (!resource) throw new ApiError(404, "resource_not_found", "Resource not found");
    if (resource.connection_scope === "personal" && resource.owner_user_id !== this.auth.userId) {
      throw new ApiError(403, "resource_access_denied", "This personal resource is not available to the work stream");
    }
    await this.env.DB.prepare(
      ATTACH_RESOURCE_SQL,
    ).bind(id, resourceId, this.auth.userId, nowIso()).run();
    const attached = (await this.loadResources(id)).find((item) => item.id === resourceId);
    // A private note is only visible to its creator. The attaching request
    // returns refreshed canonical state to that user, but broadcasting the
    // resource would expose its title to every socket in a shared work stream.
    // Same reason as `addParticipant`: `WORKSTREAM_RESOURCES_SQL` filters notes
    // archived since the authorization check, so the reload can legitimately
    // miss. A typed conflict beats a 500 whose log says only `internal_error`.
    if (!attached) {
      throw new ApiError(409, "resource_reload_failed", "The resource was attached but could not be read back");
    }
    if (resource.note_scope !== "personal") {
      await publishWorkstreamEvent(this.env, this.auth.workspaceId, id, { type: "resource_attached", resource: attached });
    }
    return attached;
  }

  async detachResource(id: string, resourceId: string): Promise<void> {
    await this.requireWorkstream(id);
    await this.env.DB.batch([
      this.env.DB.prepare("DELETE FROM resource_watches WHERE workstream_id = ? AND resource_id = ?").bind(id, resourceId),
      this.env.DB.prepare("DELETE FROM workstream_resources WHERE workstream_id = ? AND resource_id = ?").bind(id, resourceId),
    ]);
  }

  async answerElicitation(
    id: string,
    elicitationId: string,
    input: AnswerElicitationInput,
    clientMessageId = `elicitation-response:${elicitationId}`,
    slackOrigin?: SlackOriginContext,
    slackSearchAuthorization?: SlackSearchAuthorization,
  ) {
    await this.requireWorkstream(id);
    const duplicate = await this.loadMessageByClientId(id, clientMessageId);
    if (duplicate) return { elicitation: undefined, harnessRunId: null };
    const elicitation = await this.env.DB.prepare(
      `SELECT * FROM elicitations WHERE id = ? AND workstream_id = ? AND workspace_id = ? AND status = 'open'`,
    ).bind(elicitationId, id, this.auth.workspaceId).first<Record<string, unknown>>();
    if (!elicitation) throw new ApiError(404, "elicitation_not_found", "This question is no longer open");
    if (elicitation.target_user_id != null && elicitation.target_user_id !== this.auth.userId) {
      throw new ApiError(403, "elicitation_target_mismatch", "This question is targeted to another participant");
    }
    const skipped = "skipped" in input && input.skipped;
    const answer = skipped ? null : input.answer;
    if (!skipped) this.validateElicitationAnswer(elicitation, input.answer, input.customResponse);
    const at = nowIso();
    const responseMessageId = newId();
    const persistedElicitation = {
      id: elicitationId,
      workstreamId: id,
      harnessRunId: String(elicitation.harness_run_id),
      prompt: String(elicitation.prompt),
      responseType: String(elicitation.response_type),
      options: json(elicitation.options_json, []),
      minimumSelections: Number(elicitation.minimum_selections ?? 0),
      maximumSelections: elicitation.maximum_selections == null ? null : Number(elicitation.maximum_selections),
      targetUserId: elicitation.target_user_id == null ? null : String(elicitation.target_user_id),
      status: "answered",
      answer,
      answeredByUserId: this.auth.userId,
      createdAt: String(elicitation.created_at),
      answeredAt: at,
    };
    const responseWrites = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE elicitations SET status = 'answered', answer_json = ?, answered_by_user_id = ?, answered_at = ?
         WHERE id = ? AND workstream_id = ? AND workspace_id = ? AND status = 'open'`,
      ).bind(
        answer == null ? null : JSON.stringify(answer),
        this.auth.userId,
        at,
        elicitationId,
        id,
        this.auth.workspaceId,
      ),
      this.env.DB.prepare(
        `INSERT INTO messages
         (id, client_message_id, workspace_id, workstream_id, author_type, author_user_id,
          message_type, text_content, structured_content_json, sequence_number, created_at)
         SELECT ?, ?, ?, w.id, 'human', ?, 'elicitation', '', ?, w.next_sequence_number, ?
         FROM workstreams w WHERE w.id = ? AND w.workspace_id = ?
           AND EXISTS (
             SELECT 1 FROM elicitations e
             WHERE e.id = ? AND e.workstream_id = w.id AND e.workspace_id = w.workspace_id
               AND e.status = 'answered' AND e.answered_by_user_id = ? AND e.answered_at = ?
           )
         ON CONFLICT(workstream_id, client_message_id) DO NOTHING`,
      ).bind(
        responseMessageId,
        clientMessageId,
        this.auth.workspaceId,
        this.auth.userId,
        JSON.stringify({ kind: "elicitation_response", elicitation: persistedElicitation }),
        at,
        id,
        this.auth.workspaceId,
        elicitationId,
        this.auth.userId,
        at,
      ),
      this.env.DB.prepare(
        `UPDATE workstreams SET next_sequence_number = next_sequence_number + 1,
         latest_attention_sequence_number = next_sequence_number,
         last_activity_at = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ?
           AND EXISTS (SELECT 1 FROM messages WHERE id = ?)`,
      ).bind(at, at, id, this.auth.workspaceId, responseMessageId),
      this.env.DB.prepare(
        `INSERT INTO workstream_read_states
         (workspace_id, workstream_id, user_id, read_through_sequence_number,
          manual_unread_from_sequence_number, manual_unread_generation, updated_at)
         SELECT m.workspace_id, m.workstream_id, ?, m.sequence_number, NULL, 0, ?
         FROM messages m WHERE m.id = ? AND m.workspace_id = ? AND m.workstream_id = ?
         ON CONFLICT(workstream_id, user_id) DO UPDATE SET
           read_through_sequence_number = MAX(
             workstream_read_states.read_through_sequence_number,
             excluded.read_through_sequence_number
           ),
           manual_unread_from_sequence_number = NULL,
           updated_at = excluded.updated_at`,
      ).bind(this.auth.userId, at, responseMessageId, this.auth.workspaceId, id),
    ]);
    if (Number(responseWrites[0]?.meta.changes ?? 0) !== 1) {
      throw new ApiError(409, "elicitation_already_answered", "This question was answered by someone else");
    }
    if (Number(responseWrites[1]?.meta.changes ?? 0) !== 1) {
      throw new ApiError(500, "elicitation_response_write_failed", "The response could not be stored");
    }
    await this.database.workstreams.addParticipant(this.auth.workspaceId, id, this.auth.userId, this.auth.userId, "elicitation");
    const remaining = await this.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM elicitations WHERE workstream_id = ? AND status = 'open'",
    ).bind(id).first<{ count: number }>();
    let harnessRunId: string | null = null;
    if (Number(remaining?.count ?? 0) === 0) {
      harnessRunId = await this.launchHarness(
        id,
        responseMessageId,
        "elicitation_answer",
        String(elicitation.harness_run_id),
        slackOrigin,
        slackSearchAuthorization,
      );
    }
    const updated = (await this.loadElicitations(id, true)).find((item) => item.id === elicitationId);
    if (updated) await publishWorkstreamEvent(this.env, this.auth.workspaceId, id, { type: "elicitation_answered", elicitation: updated });
    return { elicitation: updated, harnessRunId };
  }

  async resolveSuggestion(id: string, suggestionId: string, action: "accepted" | "dismissed") {
    await this.requireWorkstream(id);
    const suggestion = await this.env.DB.prepare(
      `UPDATE activity_suggestions SET status = ?, resolved_at = ?, resolved_by_user_id = ?
       WHERE id = ? AND workstream_id = ? AND workspace_id = ? AND status = 'pending'
       RETURNING activity_id`,
    ).bind(action, nowIso(), this.auth.userId, suggestionId, id, this.auth.workspaceId).first<{ activity_id: string }>();
    // A suggestion card that outlives its resolution invites a second click, and
    // a duplicate click is a replay of a decision this work stream has already
    // recorded rather than an error to show someone. Repeating the same
    // resolution reports the state it already reached; only a genuinely
    // contradictory one is refused.
    const resolved = suggestion ?? await this.resolvedSuggestionReplay(id, suggestionId, action);
    let resourceId: string | null = null;
    if (action === "accepted") {
      // `accepted` records that the attachment already happened; it is not a
      // standing instruction to repeat it. Re-attaching on a replay would
      // silently restore a resource the user detached in between, which the
      // 404 this replaces at least left alone.
      resourceId = suggestion
        ? await this.attachActivityResource(id, resolved.activity_id)
        : await this.attachedActivityResourceId(id, resolved.activity_id);
    }
    const updated = (await this.loadSuggestions(id, true)).find((item) => item.id === suggestionId);
    // Only the request that moved the row announces it. A replay changed
    // nothing, and the room already carries the resolution from the request
    // that did; broadcasting it again would move the card, because the
    // transcript upsert prefers the incoming copy and orders it by the newer
    // room sequence that copy arrives with.
    if (suggestion && updated) {
      await publishWorkstreamEvent(this.env, this.auth.workspaceId, id, { type: "activity_suggestion_resolved", suggestion: updated });
    }
    return { suggestion: updated, resourceId };
  }

  private async resolvedSuggestionReplay(
    id: string,
    suggestionId: string,
    action: "accepted" | "dismissed",
  ): Promise<{ activity_id: string }> {
    const existing = await this.env.DB.prepare(
      `SELECT activity_id, status FROM activity_suggestions
       WHERE id = ? AND workstream_id = ? AND workspace_id = ?`,
    ).bind(suggestionId, id, this.auth.workspaceId).first<{ activity_id: string; status: string }>();
    if (!existing) throw new ApiError(404, "suggestion_not_found", "Activity suggestion not found");
    if (existing.status === action) return { activity_id: existing.activity_id };
    // The conditional UPDATE and this read are scoped identically apart from
    // the status predicate, so a row that is still pending here lost a race
    // rather than reaching a decision. Say that, instead of describing an open
    // suggestion as one somebody already resolved.
    if (existing.status === "pending") {
      throw new ApiError(409, "suggestion_resolution_conflict", "This suggestion could not be resolved. Try again.");
    }
    throw new ApiError(
      409,
      "suggestion_already_resolved",
      existing.status === "accepted"
        ? "This suggestion was already added to the work stream"
        : "This suggestion was already dismissed",
    );
  }

  /** The resource an accepted suggestion attached, or null once it is detached. */
  private async attachedActivityResourceId(workstreamId: string, activityId: string): Promise<string | null> {
    const attached = await this.env.DB.prepare(
      `SELECT wr.resource_id FROM workstream_resources wr
       JOIN resources r ON r.id = wr.resource_id
       JOIN activities a ON a.workspace_id = r.workspace_id
         AND a.provider = r.provider
         AND a.provider_resource_id = r.provider_resource_id
         AND ((a.connection_id = r.connection_id) OR (a.connection_id IS NULL AND r.connection_id IS NULL))
       WHERE wr.workstream_id = ? AND a.id = ? AND a.workspace_id = ?`,
    ).bind(workstreamId, activityId, this.auth.workspaceId).first<{ resource_id: string }>();
    return attached?.resource_id ?? null;
  }

  async stop(id: string): Promise<void> {
    await this.requireWorkstream(id);
    const at = nowIso();
    // Cancellation is a durable request, not a competing terminal write. The
    // leased workflow observes it through liveness, persists the final fenced
    // terminal lifecycle event, and only then publishes idle realtime state.
    // Terminating the Workflow here would bypass that durable boundary and
    // could leave a run permanently running.
    await this.env.DB.prepare(
      `UPDATE harness_runs
          SET cancellation_requested_at = COALESCE(cancellation_requested_at, ?),
              cancellation_reason = COALESCE(cancellation_reason, 'stopped_by_user')
        WHERE workstream_id = ? AND workspace_id = ?
          AND origin != 'hypersight_block'
          AND status IN ('scheduled', 'running') AND terminalized_at IS NULL`,
    ).bind(at, id, this.auth.workspaceId).run();
  }

  async retry(id: string): Promise<{ harnessRunId: string }> {
    const workstream = await this.requireWorkstream(id);
    if (workstream.harnessStatus === "running" || workstream.harnessStatus === "scheduled" || workstream.harnessStatus === "needs_input") {
      throw new ApiError(409, "harness_already_running", "This work stream already has an active run");
    }
    const latest = await this.env.DB.prepare(
      `SELECT status FROM harness_runs
       WHERE workspace_id = ? AND workstream_id = ?
         AND parent_tool_call_id IS NULL
         AND origin != 'hypersight_block'
       ORDER BY created_at DESC LIMIT 1`,
    ).bind(this.auth.workspaceId, id).first<{ status: string }>();
    if (!latest || (latest.status !== "failed" && latest.status !== "stopped")) {
      throw new ApiError(409, "harness_not_retryable", "The latest run is not retryable");
    }
    const trigger = await this.env.DB.prepare(
      `SELECT id FROM messages
       WHERE workspace_id = ? AND workstream_id = ? AND author_type = 'human'
       ORDER BY sequence_number DESC LIMIT 1`,
    ).bind(this.auth.workspaceId, id).first<{ id: string }>();
    return { harnessRunId: await this.launchHarness(id, trigger?.id ?? null, "manual_retry") };
  }

  async socketTicket(id: string) {
    await this.requireWorkstream(id);
    const ticket = await issueSocketTicket(this.env, this.auth, id);
    const url = new URL(this.env.PUBLIC_API_BASE_URL);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/socket/workstreams/${id}`;
    url.search = new URLSearchParams({ ticket }).toString();
    return { url: url.toString(), ticket };
  }

  async artifactContent(id: string, artifactId: string): Promise<{
    body: ReadableStream;
    contentType: string;
    fileName: string;
  }> {
    await this.requireWorkstream(id);
    const artifact = await this.env.DB.prepare(
      `SELECT id, title, artifact_type, content_ref, metadata_json
       FROM artifacts WHERE id = ? AND workspace_id = ? AND workstream_id = ?`,
    ).bind(artifactId, this.auth.workspaceId, id).first<Record<string, unknown>>();
    if (!artifact) throw new ApiError(404, "artifact_not_found", "Artifact not found");
    if (artifact.content_ref == null) throw new ApiError(409, "artifact_not_ready", "This artifact is not ready to download");
    const object = await this.env.PAYLOADS.get(String(artifact.content_ref));
    if (!object) throw new ApiError(404, "artifact_content_not_found", "Artifact content is no longer available");
    const metadata = json<{ mimeType?: string; fileName?: string }>(artifact.metadata_json, {});
    const contentType = object.httpMetadata?.contentType ?? metadata.mimeType ?? mimeTypeForArtifact(String(artifact.artifact_type));
    return {
      body: object.body,
      contentType,
      fileName: safeArtifactFileName(metadata.fileName ?? String(artifact.title), String(artifact.artifact_type)),
    };
  }

  private async requireWorkstream(id: string) {
    let row = await this.loadVisibleWorkstreamRow(id, false);
    const desiredEmailStatus = row.archived_at == null ? "active" : "disabled";
    if (row.email_address == null || row.email_route_status !== desiredEmailStatus) {
      await new WorkstreamEmailRoutingService(this.env).ensureWorkstreamAddress({
        region: this.env.AVALON_REGION,
        workspaceId: this.auth.workspaceId,
        workstreamId: id,
      });
      row = await this.loadVisibleWorkstreamRow(id, false);
    }
    return toWorkstream(row);
  }

  private async loadVisibleWorkstreamRow(id: string, includeArchived: boolean): Promise<Record<string, unknown>> {
    const row = await this.env.DB.prepare(
      `SELECT w.*, ${WORKSTREAM_VIEWER_COLUMNS_SQL}
       FROM workstreams w
       ${WORKSTREAM_VIEWER_JOINS_SQL}
       WHERE w.id = ? AND w.workspace_id = ?
         ${includeArchived ? "" : "AND w.archived_at IS NULL"}
         AND ${WORKSTREAM_VISIBILITY_SQL}`,
    ).bind(this.auth.userId, id, this.auth.workspaceId, ...workstreamVisibilityBindings(this.auth.userId))
      .first<Record<string, unknown>>();
    if (!row) throw new ApiError(404, "workstream_not_found", "Work stream not found");
    return row;
  }

  private async requireWorkstreamForUpdate(id: string): Promise<Record<string, unknown>> {
    return this.loadVisibleWorkstreamRow(id, true);
  }

  private async persistHumanMessage(
    workstreamId: string,
    input: CreateMessageInput,
  ): Promise<{ message: Message; inserted: boolean }> {
    const messageId = newId();
    const at = nowIso();
    const attachmentStatements = buildMessageAttachmentStatements(this.env.DB, {
      attachmentIds: input.attachmentIds,
      attachedAt: at,
      attachedByUserId: this.auth.userId,
      messageId,
      workspaceId: this.auth.workspaceId,
      workstreamId,
    });
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO workstream_participants
         (workstream_id, user_id, added_by_user_id, participation_reason, joined_at, removed_at)
         SELECT ?, ?, ?, 'message', ?, NULL
         WHERE EXISTS (SELECT 1 FROM workstreams WHERE id = ? AND workspace_id = ?)
         ON CONFLICT(workstream_id, user_id) DO UPDATE SET
           removed_at = NULL,
           added_by_user_id = CASE WHEN workstream_participants.removed_at IS NOT NULL
             THEN excluded.added_by_user_id ELSE workstream_participants.added_by_user_id END,
           participation_reason = CASE WHEN workstream_participants.removed_at IS NOT NULL
             THEN excluded.participation_reason ELSE workstream_participants.participation_reason END,
           joined_at = CASE WHEN workstream_participants.removed_at IS NOT NULL
             THEN excluded.joined_at ELSE workstream_participants.joined_at END`,
      ).bind(workstreamId, this.auth.userId, this.auth.userId, at, workstreamId, this.auth.workspaceId),
      this.env.DB.prepare(
        `INSERT INTO messages
         (id, client_message_id, workspace_id, workstream_id, author_type, author_user_id,
          message_type, text_content, structured_content_json, sequence_number, created_at)
         SELECT ?, ?, ?, w.id, 'human', ?, 'text', ?, NULL, w.next_sequence_number, ?
         FROM workstreams w WHERE w.id = ? AND w.workspace_id = ?
         ON CONFLICT(workstream_id, client_message_id) DO NOTHING`,
      ).bind(messageId, input.clientMessageId, this.auth.workspaceId, this.auth.userId, input.text, at, workstreamId, this.auth.workspaceId),
      this.env.DB.prepare(
        `UPDATE workstreams SET next_sequence_number = next_sequence_number + 1,
         latest_attention_sequence_number = next_sequence_number,
         last_activity_at = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ?
           AND EXISTS (SELECT 1 FROM messages WHERE id = ?)`,
      ).bind(at, at, workstreamId, this.auth.workspaceId, messageId),
      this.env.DB.prepare(
        `INSERT INTO workstream_read_states
         (workspace_id, workstream_id, user_id, read_through_sequence_number,
          manual_unread_from_sequence_number, manual_unread_generation, updated_at)
         SELECT m.workspace_id, m.workstream_id, ?, m.sequence_number, NULL, 0, ?
         FROM messages m WHERE m.id = ? AND m.workspace_id = ? AND m.workstream_id = ?
         ON CONFLICT(workstream_id, user_id) DO UPDATE SET
           read_through_sequence_number = MAX(
             workstream_read_states.read_through_sequence_number,
             excluded.read_through_sequence_number
           ),
           manual_unread_from_sequence_number = NULL,
           updated_at = excluded.updated_at`,
      ).bind(this.auth.userId, at, messageId, this.auth.workspaceId, workstreamId),
      ...attachmentStatements,
    ]);
    const inserted = Number(results[1]?.meta.changes ?? 0) > 0;
    const message = await this.loadMessageByClientId(workstreamId, input.clientMessageId);
    if (!message) throw new ApiError(500, "message_write_failed", "The message could not be stored");
    return { message, inserted };
  }

  private async loadMessageByClientId(workstreamId: string, clientMessageId: string): Promise<Message | null> {
    return this.database.workstreams.getMessageByClientId(
      this.auth.workspaceId,
      workstreamId,
      clientMessageId,
    );
  }

  private async assertDraftAttachments(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(", ");
    const result = await this.env.DB.prepare(
      `SELECT id FROM resources
       WHERE id IN (${placeholders}) AND workspace_id = ? AND provider = 'avalon_upload'
         AND uploaded_by_user_id = ? AND attachment_status = 'draft'`,
    ).bind(...ids, this.auth.workspaceId, this.auth.userId).all<{ id: string }>();
    if ((result.results ?? []).length !== ids.length) {
      throw new ApiError(422, "invalid_message_attachment", "One or more attachments are unavailable or already sent");
    }
  }

  private async launchHarness(
    workstreamId: string,
    triggerMessageId: string | null,
    origin: string,
    parentHarnessRunId?: string,
    slackOrigin?: SlackOriginContext,
    slackSearchAuthorization?: SlackSearchAuthorization,
  ): Promise<string> {
    return launchWorkstreamHarness(this.env, {
      workspaceId: this.auth.workspaceId,
      workstreamId,
      triggerMessageId,
      origin,
      executionPrincipal: { type: "user", userId: this.auth.userId },
      supersedeActiveRun: origin === "human_message",
      ...(slackOrigin ? { slackOrigin } : {}),
      ...(slackSearchAuthorization ? { slackSearchAuthorization } : {}),
      ...(parentHarnessRunId ? { parentHarnessRunId } : {}),
    });
  }

  private async isActiveParticipant(workstreamId: string, userId: string): Promise<boolean> {
    const row = await this.env.DB.prepare(
      `SELECT 1 FROM workstream_participants
        WHERE workstream_id = ? AND user_id = ? AND removed_at IS NULL LIMIT 1`,
    ).bind(workstreamId, userId).first();
    return row != null;
  }

  private async assertMembersExist(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const unique = [...new Set(ids)];
    const placeholders = unique.map(() => "?").join(",");
    const result = await this.env.DB.prepare(
      `SELECT user_id FROM workspace_members WHERE workspace_id = ? AND status = 'active' AND user_id IN (${placeholders})`,
    ).bind(this.auth.workspaceId, ...unique).all<{ user_id: string }>();
    if ((result.results?.length ?? 0) !== unique.length) throw new ApiError(422, "invalid_workspace_member", "A selected participant is not an active workspace member");
  }

  private async loadMentionPeople(ids: string[]): Promise<Map<string, MentionPerson>> {
    if (ids.length === 0) return new Map();
    const unique = [...new Set(ids)];
    const placeholders = unique.map(() => "?").join(",");
    const result = await this.env.DB.prepare(
      `SELECT u.id, u.name, u.avatar_url
       FROM users u JOIN workspace_members wm ON wm.user_id = u.id
       WHERE wm.workspace_id = ? AND wm.status = 'active' AND u.id IN (${placeholders})`,
    ).bind(this.auth.workspaceId, ...unique).all<{
      id: string;
      name: string;
      avatar_url: string | null;
    }>();
    return new Map((result.results ?? []).map((row) => [row.id, {
      id: row.id,
      name: row.name,
      avatarUrl: row.avatar_url,
    }]));
  }

  /**
   * Projects a posted human message into the first-party activity log. The
   * message itself stays canonical in `messages`; this is the notification-shaped
   * record of it, so a digest or any other feed reads one table instead of
   * re-deriving participants, mentions and visibility for itself.
   *
   * Events from a hidden system work stream never reach a reader — the reader
   * excludes them — so this path does not have to know about them.
   */
  private async recordMessageActivityEvent(
    message: Message,
    workstream: Workstream,
    mentionedUserIds: string[],
  ): Promise<void> {
    const author = message.author.type === "human" ? message.author.user.name : "";
    await recordActivityEvent(this.env, {
      workspaceId: this.auth.workspaceId,
      eventType: "workstream.message.posted",
      subjectType: "workstream",
      subjectId: workstream.id,
      subjectSequenceNumber: message.sequenceNumber,
      actorType: "user",
      actorUserId: this.auth.userId,
      actorLabel: author,
      title: workstream.title,
      body: truncateUtf16Safe(message.textContent, ACTIVITY_EVENT_BODY_LIMIT),
      canonicalUrl: this.workstreamLinkOrNull(workstream.id),
      audience: { kind: "workstream", workstreamId: workstream.id },
      occurredAt: message.createdAt,
      sourceKind: "message",
      sourceId: message.id,
      dedupeKey: `message:${message.id}`,
      metadata: { workstreamTitle: workstream.title },
      targets: mentionedUserIds.map((userId) => ({ userId, relation: "mentioned" })),
    });
  }

  /**
   * The event's link, or nothing. A deployment without a usable web base URL
   * still has a work stream worth recording; the link is a convenience on top of
   * it, and must never be the reason a message post fails.
   */
  private workstreamLinkOrNull(workstreamId: string): string | null {
    try {
      return workstreamCanonicalUrl(this.env.PUBLIC_WEB_BASE_URL, workstreamId);
    } catch {
      return null;
    }
  }

  private scheduleMentionNotifications(message: Message, workstream: Workstream): void {
    this.deferTask(this.sendMentionNotifications(message, workstream).catch((error: unknown) => {
      logWarn(this.env, "mention_notification_delivery_failed", {
        message_id: message.id,
        reason: error instanceof ApiError ? error.code : "unknown_error",
      });
    }));
  }

  /**
   * Keep a background task alive past the response where the caller gave us a
   * way to, and drop it otherwise — every task passed here has already handled
   * its own failures, so nothing is lost but the work itself.
   */
  private deferTask(task: Promise<unknown>): void {
    if (this.defer) {
      this.defer(task);
      return;
    }
    void task;
  }

  private async sendMentionNotifications(message: Message, workstream: Workstream): Promise<void> {
    const author = message.author;
    if (author.type !== "human") return;
    const result = await this.env.DB.prepare(
      `SELECT mm.mentioned_user_id AS person_id, mm.start_offset, mm.end_offset,
         u.email, u.name, ws.name AS workspace_name
       FROM message_mentions mm
       JOIN messages m ON m.id = mm.message_id
       JOIN users u ON u.id = mm.mentioned_user_id
       JOIN workspace_members wm ON wm.workspace_id = m.workspace_id AND wm.user_id = u.id
       JOIN workspaces ws ON ws.id = m.workspace_id
       WHERE mm.message_id = ? AND mm.mention_type = 'person'
         AND wm.status = 'active' AND u.id <> ?
       ORDER BY mm.start_offset`,
    ).bind(message.id, this.auth.userId).all<{
      person_id: string;
      start_offset: number;
      end_offset: number;
      email: string;
      name: string;
      workspace_name: string;
    }>();
    const recipients = new Map<string, NonNullable<typeof result.results>[number]>();
    for (const row of result.results ?? []) {
      if (!isCanonicalPersonMention(message.textContent, {
        type: "person",
        userId: row.person_id,
        startOffset: Number(row.start_offset),
        endOffset: Number(row.end_offset),
      })) continue;
      recipients.set(row.person_id, row);
    }
    await Promise.all([...recipients.values()].map(async (recipient) => {
      const common = {
        messageId: message.id,
        recipientUserId: recipient.person_id,
        recipientEmail: recipient.email,
        authorName: author.user.name,
        workspaceName: recipient.workspace_name,
        workstreamId: message.workstreamId,
        workstreamTitle: String(workstream.title),
        messageText: message.textContent,
      };
      const slack = await sendWorkstreamMentionSlack(this.env, {
        ...common,
        workspaceId: this.auth.workspaceId,
      });
      if (slack === "sent") return;
      await sendWorkstreamMentionEmail(this.env, {
        ...common,
        recipientName: recipient.name,
        workstreamEmailAddress: workstream.emailAddress,
        region: this.env.AVALON_REGION,
      });
    }));
  }

  private async nonParticipantIds(workstreamId: string, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const result = await this.env.DB.prepare(
      `SELECT user_id FROM workstream_participants
       WHERE workstream_id = ? AND removed_at IS NULL AND user_id IN (${placeholders})`,
    ).bind(workstreamId, ...ids).all<{ user_id: string }>();
    const participants = new Set((result.results ?? []).map((row) => row.user_id));
    return ids.filter((id) => !participants.has(id));
  }

  private async memberNames(ids: string[]) {
    await this.assertMembersExist(ids);
    const placeholders = ids.map(() => "?").join(",");
    const result = await this.env.DB.prepare(`SELECT id, name FROM users WHERE id IN (${placeholders})`).bind(...ids).all<{ id: string; name: string }>();
    return result.results ?? [];
  }

  private async loadParticipants(id: string) {
    const result = await this.env.DB.prepare(
      `SELECT u.*, p.participation_reason, p.joined_at
       FROM workstream_participants p JOIN users u ON u.id = p.user_id
       WHERE p.workstream_id = ? AND p.removed_at IS NULL ORDER BY p.joined_at`,
    ).bind(id).all<Record<string, unknown>>();
    return (result.results ?? []).map((input) => {
      const row = ParticipantRowSchema.parse(input);
      return {
        user: {
          id: row.id,
          email: row.email,
          name: row.name,
          avatarUrl: row.avatar_url ?? null,
          timezone: row.timezone,
          createdAt: row.created_at,
        },
        participationReason: row.participation_reason,
        joinedAt: row.joined_at,
      };
    });
  }

  private async activeParticipantCount(id: string): Promise<number> {
    const row = await this.env.DB.prepare(
      `SELECT COUNT(*) AS participant_count
       FROM workstream_participants
       WHERE workstream_id = ? AND removed_at IS NULL`,
    ).bind(id).first<{ participant_count: number }>();
    return Number(row?.participant_count ?? 0);
  }

  private async loadResources(id: string) {
    const result = await this.env.DB.prepare(
      WORKSTREAM_RESOURCES_SQL,
    ).bind(id, this.auth.userId).all<Record<string, unknown>>();
    return (result.results ?? []).map((input) => {
      const row = ResourceRowSchema.parse(input);
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        connectionId: row.connection_id ?? null,
        resourceType: row.resource_type,
        provider: row.provider,
        providerResourceId: row.provider_resource_id ?? null,
        title: row.title,
        mimeType: row.mime_type ?? null,
        canonicalUrl: row.canonical_url ?? null,
        watchEnabled: row.watch_enabled === 1,
        watchStatus: row.watch_status,
        lastHydratedAt: row.last_hydrated_at ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  private async loadConnections(): Promise<Connection[]> {
    const result = await this.env.DB.prepare(
      `SELECT c.*, u.name AS owner_name FROM connector_connections c LEFT JOIN users u ON u.id = c.owner_user_id
       WHERE c.workspace_id = ? AND (c.scope = 'workspace' OR c.owner_user_id = ?) ORDER BY c.display_name`,
    ).bind(this.auth.workspaceId, this.auth.userId).all<Record<string, unknown>>();
    return (result.results ?? []).map((row) => connectionFromRow(row));
  }

  private async loadArtifacts(id: string) {
    const result = await this.env.DB.prepare(WORKSTREAM_ARTIFACTS_SQL)
      .bind(this.auth.workspaceId, id).all<Record<string, unknown>>();
    return (result.results ?? []).map((input) => {
      const row = ArtifactRowSchema.parse(input);
      const metadata = json<{ mimeType?: string }>(row.metadata_json, {});
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        workstreamId: row.workstream_id,
        harnessRunId: row.harness_run_id ?? null,
        artifactType: row.artifact_type,
        title: row.title,
        previewText: row.preview_text == null ? null : row.preview_text.slice(0, 4_000),
        status: row.status,
        mimeType: metadata.mimeType ?? mimeTypeForArtifact(row.artifact_type),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  private async loadBackgroundTasks(id: string) {
    const [harnessResult, toolResult] = await Promise.all([
      this.env.DB.prepare(WORKSTREAM_HARNESS_TASKS_SQL)
        .bind(this.auth.workspaceId, id).all<Record<string, unknown>>(),
      this.env.DB.prepare(WORKSTREAM_TOOL_TASKS_SQL)
        .bind(this.auth.workspaceId, id).all<Record<string, unknown>>(),
    ]);
    const harnessTasks = (harnessResult.results ?? []).map((input) => {
      const row = HarnessTaskRowSchema.parse(input);
      const usage = json<Record<string, unknown>>(row.usage_json, {});
      const promptTokens = numericTokenCount(usage.prompt_tokens ?? usage.input_tokens);
      const completionTokens = numericTokenCount(usage.completion_tokens ?? usage.output_tokens);
      const explicitTotal = numericTokenCount(usage.total_tokens);
      const tokenCount = explicitTotal ?? (promptTokens != null || completionTokens != null
        ? (promptTokens ?? 0) + (completionTokens ?? 0)
        : null);
      return {
        id: row.id,
        harnessRunId: row.id,
        title: harnessTaskTitle(row.origin),
        taskType: "agent" as const,
        status: backgroundTaskStatus(row.status),
        startedAt: row.started_at ?? row.created_at,
        completedAt: row.completed_at ?? null,
        tokenCount,
        toolUses: row.tool_uses ?? 0,
        transcriptMessageId: row.transcript_message_id ?? null,
      };
    });
    const toolTasks = (toolResult.results ?? []).map((input) => {
      const row = ToolTaskRowSchema.parse(input);
      return {
        id: row.id,
        harnessRunId: row.harness_run_id,
        title: toolTaskTitle(row.tool_name),
        taskType: row.connection_id == null ? "tool" as const : "connector" as const,
        status: backgroundTaskStatus(row.status),
        startedAt: row.started_at ?? row.harness_created_at,
        completedAt: row.completed_at ?? null,
        tokenCount: null,
        toolUses: null,
        transcriptMessageId: null,
      };
    });
    return [...harnessTasks, ...toolTasks]
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  private async loadElicitations(id: string, includeResolved = false) {
    const result = await this.env.DB.prepare(
      `SELECT * FROM elicitations WHERE workstream_id = ? ${includeResolved ? "" : "AND status = 'open'"} ORDER BY created_at`,
    ).bind(id).all<Record<string, unknown>>();
    return (result.results ?? []).map((input) => {
      const row = ElicitationRowSchema.parse(input);
      return {
        id: row.id,
        workstreamId: row.workstream_id,
        harnessRunId: row.harness_run_id,
        prompt: row.prompt,
        responseType: row.response_type,
        options: json(row.options_json, []),
        minimumSelections: row.minimum_selections,
        maximumSelections: row.maximum_selections ?? null,
        targetUserId: row.target_user_id ?? null,
        status: row.status,
        answer: json(row.answer_json, null),
        answeredByUserId: row.answered_by_user_id ?? null,
        createdAt: row.created_at,
        answeredAt: row.answered_at ?? null,
      };
    });
  }

  private async loadSuggestions(id: string, includeResolved = false) {
    const result = await this.env.DB.prepare(
      `SELECT s.*, a.title, a.summary FROM activity_suggestions s JOIN activities a ON a.id = s.activity_id
       WHERE s.workstream_id = ? ${includeResolved ? "" : "AND s.status = 'pending'"} ORDER BY s.created_at DESC`,
    ).bind(id).all<Record<string, unknown>>();
    return (result.results ?? []).map((input) => {
      const row = SuggestionRowSchema.parse(input);
      return {
        id: row.id,
        activityId: row.activity_id,
        workstreamId: row.workstream_id,
        title: row.title,
        summary: row.summary,
        confidence: row.confidence,
        reason: row.reason,
        status: row.status,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at ?? null,
      };
    });
  }

  private validateElicitationAnswer(
    elicitation: Record<string, unknown>,
    answer: string | string[],
    customResponse?: string,
  ): void {
    const type = String(elicitation.response_type);
    if (type === "text" && typeof answer !== "string") throw new ApiError(422, "invalid_elicitation_answer", "This question requires text");
    if (type === "multi_select" && !Array.isArray(answer)) throw new ApiError(422, "invalid_elicitation_answer", "This question requires one or more selections");
    if (type !== "text" && type !== "multi_select" && Array.isArray(answer)) throw new ApiError(422, "invalid_elicitation_answer", "This question requires one selection");
    const values = Array.isArray(answer) ? answer : [answer];
    const options = json<Array<{ value: string }>>(elicitation.options_json, []);
    if (type !== "text") {
      const customMatches = customResponse == null
        ? 0
        : values.filter((value) => value === customResponse).length;
      if (customResponse != null && customMatches !== 1) {
        throw new ApiError(422, "invalid_custom_elicitation_answer", "The custom response is not part of the answer");
      }
      if (values.some((value) => !options.some((option) => option.value === value) && value !== customResponse)) {
        throw new ApiError(422, "invalid_elicitation_option", "An answer is not one of the available choices");
      }
    }
    const minimum = Number(elicitation.minimum_selections ?? 0);
    const maximum = elicitation.maximum_selections == null ? null : Number(elicitation.maximum_selections);
    if (values.length < minimum || (maximum != null && values.length > maximum)) throw new ApiError(422, "invalid_selection_count", "The answer has an invalid number of selections");
  }

  private async attachActivityResource(workstreamId: string, activityId: string): Promise<string | null> {
    const activity = await this.env.DB.prepare("SELECT * FROM activities WHERE id = ? AND workspace_id = ?")
      .bind(activityId, this.auth.workspaceId).first<Record<string, unknown>>();
    if (!activity || activity.provider_resource_id == null) return null;
    let resource = await this.env.DB.prepare(
      ACTIVITY_RESOURCE_LOOKUP_SQL,
    ).bind(
      this.auth.workspaceId,
      activity.connection_id,
      activity.connection_id,
      activity.provider,
      activity.provider_resource_id,
    ).first<{ id: string }>();
    if (!resource) {
      const id = newId();
      const at = nowIso();
      await this.env.DB.prepare(
        `INSERT INTO resources
         (id, workspace_id, connection_id, resource_type, provider, provider_resource_id, title,
          content_ref, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(id, this.auth.workspaceId, activity.connection_id, activity.resource_type ?? "activity", activity.provider, activity.provider_resource_id, truncateUtf16Safe(String(activity.title), 300), activity.payload_ref, activity.metadata_json ?? "{}", at, at).run();
      resource = await this.env.DB.prepare(ACTIVITY_RESOURCE_LOOKUP_SQL).bind(
        this.auth.workspaceId,
        activity.connection_id,
        activity.connection_id,
        activity.provider,
        activity.provider_resource_id,
      ).first<{ id: string }>();
      if (!resource) throw new ApiError(500, "resource_write_failed", "The suggested resource could not be stored");
    }
    await this.attachResource(workstreamId, resource.id);
    return resource.id;
  }
}

/** The row contracts, exposed so a test can hold them against real rows. */
export const workstreamRowSchemas = {
  participants: ParticipantRowSchema,
  resources: ResourceRowSchema,
  artifacts: ArtifactRowSchema,
  elicitations: ElicitationRowSchema,
  suggestions: SuggestionRowSchema,
} as const;

export const __workstreamServiceTesting = {
  activityResourceLookupSql: ACTIVITY_RESOURCE_LOOKUP_SQL,
  attachResourceSql: ATTACH_RESOURCE_SQL,
  workstreamResourcesSql: WORKSTREAM_RESOURCES_SQL,
  workstreamArtifactsSql: WORKSTREAM_ARTIFACTS_SQL,
  workstreamHarnessTasksSql: WORKSTREAM_HARNESS_TASKS_SQL,
  workstreamToolTasksSql: WORKSTREAM_TOOL_TASKS_SQL,
  backgroundTaskStatus,
  harnessTaskTitle,
  memberSafeHarnessError,
  mimeTypeForArtifact,
  safeArtifactFileName,
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

function numericTokenCount(value: unknown): number | null {
  const count = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function backgroundTaskStatus(status: string): "running" | "needs_input" | "completed" | "failed" {
  if (status === "completed") return "completed";
  if (status === "needs_input") return "needs_input";
  if (status === "failed" || status === "ambiguous" || status === "stopped") return "failed";
  return "running";
}

function harnessTaskTitle(origin: string): string {
  switch (origin) {
    case "opening_message": return "Start work stream";
    case "human_message": return "Respond to message";
    case "elicitation_answer": return "Continue after input";
    case "automation_schedule": return "Run scheduled automation";
    case "automation_manual": return "Run automation";
    default: return `Agent work · ${origin.replaceAll("_", " ")}`;
  }
}

function toolTaskTitle(toolName: string): string {
  const leaf = toolName.split(".").at(-1) ?? toolName;
  return leaf.replaceAll("_", " ").replace(/\b\w/gu, (character) => character.toUpperCase());
}

function mimeTypeForArtifact(artifactType: string): string {
  switch (artifactType.trim().toLowerCase()) {
    case "markdown":
    case "md": return "text/markdown; charset=utf-8";
    case "csv": return "text/csv; charset=utf-8";
    case "json": return "application/json; charset=utf-8";
    case "html": return "text/html; charset=utf-8";
    default: return "text/plain; charset=utf-8";
  }
}

function safeArtifactFileName(title: string, artifactType: string): string {
  const clean = Array.from(title, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f || '\\/:*?"<>|'.includes(character)
      ? "-"
      : character;
  }).join("").trim().replace(/^[.\s-]+/u, "").slice(0, 180) || "avalon-output";
  if (/\.[a-z0-9]{1,12}$/iu.test(clean)) return clean;
  const extension = ({ markdown: "md", md: "md", csv: "csv", json: "json", html: "html" } as Record<string, string>)[artifactType.trim().toLowerCase()] ?? "txt";
  return `${clean}.${extension}`;
}

