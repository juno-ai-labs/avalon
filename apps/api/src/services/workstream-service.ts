import { createDatabase, newId, nowIso } from "@avalon/db";
import { memberSafeHarnessFailureMessage } from "@avalon/agent-harness";
import { HarnessFailureCodeSchema } from "@avalon/contracts";
import type {
  AnswerElicitationRequestSchema,
  CreateMessageRequestSchema,
  CreateWorkstreamRequestSchema,
  Message,
  UpdateWorkstreamRequestSchema,
  Workstream,
  WorkstreamWorkflowInput,
} from "@avalon/contracts";
import type { z } from "zod";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
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
import { logStructuredEvent } from "../observability/logger";
import { issueSocketTicket } from "./socket-service";
import { WorkstreamEmailRoutingService } from "./workstream-email-routing-service";
import { ResourceService } from "./resource-service";
import { sendWorkstreamMentionEmail } from "./mention-email-service";

type CreateWorkstreamInput = z.infer<typeof CreateWorkstreamRequestSchema>;
type UpdateWorkstreamInput = z.infer<typeof UpdateWorkstreamRequestSchema>;
type CreateMessageInput = z.infer<typeof CreateMessageRequestSchema>;
type AnswerElicitationInput = z.infer<typeof AnswerElicitationRequestSchema>;

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
  ORDER BY COALESCE(hr.started_at, hr.created_at) DESC
  LIMIT 250`;

const WORKSTREAM_TOOL_TASKS_SQL = `SELECT ti.*, hr.created_at AS harness_created_at
  FROM tool_invocations ti
  JOIN harness_runs hr ON hr.id = ti.harness_run_id
  WHERE ti.workspace_id = ? AND ti.workstream_id = ?
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

  async list(limit: number, before?: string) {
    const cursorClause = before ? "AND w.last_activity_at < ?" : "";
    const statement = this.env.DB.prepare(
      `SELECT w.*, t.name AS origin_label
       FROM workstreams w
       LEFT JOIN automation_subscriptions s ON s.id = w.automation_subscription_id
       LEFT JOIN automation_templates t ON t.id = s.template_id
       WHERE w.workspace_id = ? AND w.archived_at IS NULL ${cursorClause}
         AND (
           w.automation_subscription_id IS NULL OR s.scope = 'workspace' OR s.owner_user_id = ?
           OR EXISTS (
             SELECT 1 FROM workstream_participants p
             WHERE p.workstream_id = w.id AND p.user_id = ? AND p.removed_at IS NULL
           )
         )
       ORDER BY w.last_activity_at DESC LIMIT ?`,
    );
    const result = before
      ? await statement.bind(this.auth.workspaceId, before, this.auth.userId, this.auth.userId, limit + 1).all<Record<string, unknown>>()
      : await statement.bind(this.auth.workspaceId, this.auth.userId, this.auth.userId, limit + 1).all<Record<string, unknown>>();
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

  async create(input: CreateWorkstreamInput) {
    await this.assertMembersExist(input.participantUserIds);
    const title = input.title ?? input.objective.split(/\r?\n/u)[0]?.trim().slice(0, 180) ?? "New work stream";
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
      objective: input.objective,
      emailAddress: emailRoute.emailAddress,
      creatorUserId: this.auth.userId,
      openingMessage: input.openingMessage,
      clientMessageId: input.clientMessageId,
      participantUserIds: input.participantUserIds,
    });
    await emailRouting.activateWorkstreamRoute(routeInput);
    const messages = await this.database.workstreams.listMessages(this.auth.workspaceId, created.workstream.id, 1);
    const message = messages[0];
    if (message) await publishWorkstreamEvent(this.env, this.auth.workspaceId, created.workstream.id, { type: "message_created", message });
    const harnessRunId = await this.launchHarness(created.workstream.id, created.messageId, "opening_message");
    return { ...created, harnessRunId };
  }

  async get(id: string) {
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
         ORDER BY created_at DESC LIMIT 1`,
      ).bind(this.auth.workspaceId, id).first<Record<string, unknown>>(),
    ]);
    return {
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
    };
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
    await this.requireWorkstreamForUpdate(id);
    if (Object.keys(input).length === 0) throw new ApiError(422, "empty_update", "No work-stream fields were provided");
    const at = nowIso();
    await this.env.DB.prepare(
      `UPDATE workstreams SET
       title = COALESCE(?, title), objective = COALESCE(?, objective),
       archived_at = CASE WHEN ? IS NULL THEN archived_at WHEN ? = 1 THEN ? ELSE NULL END,
       email_route_status = CASE WHEN ? IS NULL THEN email_route_status ELSE 'reserved' END,
       updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    )
      .bind(
        input.title ?? null,
        input.objective ?? null,
        input.archived == null ? null : Number(input.archived),
        Number(input.archived ?? false),
        at,
        input.archived == null ? null : Number(input.archived),
        at,
        id,
        this.auth.workspaceId,
      )
      .run();
    if (input.archived != null) {
      await new WorkstreamEmailRoutingService(this.env).ensureWorkstreamAddress({
        region: this.env.AVALON_REGION,
        workspaceId: this.auth.workspaceId,
        workstreamId: id,
      });
    }
    return toWorkstream(await this.requireWorkstreamForUpdate(id));
  }

  async messages(id: string, limit: number, before?: number) {
    await this.requireWorkstream(id);
    const items = await this.database.workstreams.listMessages(this.auth.workspaceId, id, limit + 1, before);
    const hasMore = items.length > limit;
    if (hasMore) items.shift();
    return { items, nextCursor: hasMore ? String(items[0]?.sequenceNumber ?? "") : null };
  }

  async createMessage(id: string, input: CreateMessageInput) {
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
    this.scheduleMentionNotifications(messageWithMentions, workstream);
    const connectorMentions = preparedInput.mentions
      .filter((mention) => mention.type === "connector" && mention.connectorType)
      .map((mention) => mention.connectorType!);
    const participantCount = await this.activeParticipantCount(id);
    let shouldInvoke = participantCount === 1 || attachmentIds.length > 0;
    if (!shouldInvoke) {
      const recentMessages = await this.recentAddressingMessages(id, message.sequenceNumber);
      const classification = await classifyWorkstreamMessage(this.env, {
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
    const harnessRunId = shouldInvoke ? await this.launchHarness(id, message.id, "human_message") : null;
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
    if (participant) await publishWorkstreamEvent(this.env, this.auth.workspaceId, id, { type: "participant_added", participant });
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
      `SELECT r.*, c.scope AS connection_scope, c.owner_user_id
       FROM resources r LEFT JOIN connector_connections c ON c.id = r.connection_id
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
    if (attached) await publishWorkstreamEvent(this.env, this.auth.workspaceId, id, { type: "resource_attached", resource: attached });
    return attached;
  }

  async detachResource(id: string, resourceId: string): Promise<void> {
    await this.requireWorkstream(id);
    await this.env.DB.batch([
      this.env.DB.prepare("DELETE FROM resource_watches WHERE workstream_id = ? AND resource_id = ?").bind(id, resourceId),
      this.env.DB.prepare("DELETE FROM workstream_resources WHERE workstream_id = ? AND resource_id = ?").bind(id, resourceId),
    ]);
  }

  async answerElicitation(id: string, elicitationId: string, input: AnswerElicitationInput) {
    await this.requireWorkstream(id);
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
        `elicitation-response:${elicitationId}`,
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
         last_activity_at = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ?
           AND EXISTS (SELECT 1 FROM messages WHERE id = ?)`,
      ).bind(at, at, id, this.auth.workspaceId, responseMessageId),
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
      harnessRunId = await this.launchHarness(id, null, "elicitation_answer", String(elicitation.harness_run_id));
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
    if (!suggestion) throw new ApiError(404, "suggestion_not_found", "Activity suggestion not found or already resolved");
    let resourceId: string | null = null;
    if (action === "accepted") {
      resourceId = await this.attachActivityResource(id, suggestion.activity_id);
    }
    const updated = (await this.loadSuggestions(id, true)).find((item) => item.id === suggestionId);
    if (updated) await publishWorkstreamEvent(this.env, this.auth.workspaceId, id, { type: "activity_suggestion_resolved", suggestion: updated });
    return { suggestion: updated, resourceId };
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
      `SELECT w.*, t.name AS origin_label FROM workstreams w
       LEFT JOIN automation_subscriptions s ON s.id = w.automation_subscription_id
       LEFT JOIN automation_templates t ON t.id = s.template_id
       WHERE w.id = ? AND w.workspace_id = ?
         ${includeArchived ? "" : "AND w.archived_at IS NULL"}
         AND (
         w.automation_subscription_id IS NULL OR s.scope = 'workspace' OR s.owner_user_id = ?
         OR EXISTS (
           SELECT 1 FROM workstream_participants p
           WHERE p.workstream_id = w.id AND p.user_id = ? AND p.removed_at IS NULL
         )
       )`,
    ).bind(id, this.auth.workspaceId, this.auth.userId, this.auth.userId).first<Record<string, unknown>>();
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
    const attachmentStatements = input.attachmentIds.flatMap((resourceId, position) => [
      this.env.DB.prepare(
        `INSERT INTO message_attachments (message_id, resource_id, position, attached_at)
         SELECT ?, r.id, ?, ? FROM resources r
         WHERE r.id = ? AND r.workspace_id = ? AND r.provider = 'avalon_upload'
           AND r.uploaded_by_user_id = ? AND r.attachment_status = 'draft'
           AND EXISTS (SELECT 1 FROM messages WHERE id = ?)
         ON CONFLICT(message_id, resource_id) DO NOTHING`,
      ).bind(messageId, position, at, resourceId, this.auth.workspaceId, this.auth.userId, messageId),
      this.env.DB.prepare(
        `INSERT INTO workstream_resources
         (workstream_id, resource_id, attached_by_user_id, watch_enabled, relationship_type, attached_at)
         SELECT ?, r.id, ?, 0, 'message_attachment', ? FROM resources r
         WHERE r.id = ? AND r.workspace_id = ? AND r.provider = 'avalon_upload'
           AND r.uploaded_by_user_id = ?
           AND EXISTS (SELECT 1 FROM messages WHERE id = ?)
         ON CONFLICT(workstream_id, resource_id) DO NOTHING`,
      ).bind(workstreamId, this.auth.userId, at, resourceId, this.auth.workspaceId, this.auth.userId, messageId),
      this.env.DB.prepare(
        `UPDATE resources SET attachment_status = 'attached', updated_at = ?
         WHERE id = ? AND workspace_id = ? AND uploaded_by_user_id = ?
           AND EXISTS (SELECT 1 FROM message_attachments WHERE message_id = ? AND resource_id = ?)`,
      ).bind(at, resourceId, this.auth.workspaceId, this.auth.userId, messageId, resourceId),
    ]);
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
         last_activity_at = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ?
           AND EXISTS (SELECT 1 FROM messages WHERE id = ?)`,
      ).bind(at, at, workstreamId, this.auth.workspaceId, messageId),
      ...attachmentStatements,
    ]);
    const inserted = Number(results[1]?.meta.changes ?? 0) > 0;
    const message = await this.loadMessageByClientId(workstreamId, input.clientMessageId);
    if (!message) throw new ApiError(500, "message_write_failed", "The message could not be stored");
    return { message, inserted };
  }

  private async loadMessageByClientId(workstreamId: string, clientMessageId: string): Promise<Message | null> {
    const row = await this.env.DB.prepare(
      `SELECT m.*, u.email AS author_email, u.name AS author_name,
         u.avatar_url AS author_avatar_url, u.timezone AS author_timezone, u.created_at AS author_created_at,
         COALESCE((SELECT json_group_array(json_object(
           'type', mm.mention_type,
           'userId', mm.mentioned_user_id,
           'connectorType', mm.connector_type,
           'displayName', mentioned_person.name,
           'avatarUrl', mentioned_person.avatar_url,
           'startOffset', mm.start_offset,
           'endOffset', mm.end_offset
         )) FROM message_mentions mm
           LEFT JOIN users mentioned_person ON mentioned_person.id = mm.mentioned_user_id
           WHERE mm.message_id = m.id), '[]') AS mentions_json,
         COALESCE((SELECT json_group_array(json_object(
           'id', attachment_resource.id,
           'fileName', attachment_resource.title,
           'mimeType', COALESCE(attachment_resource.mime_type, 'application/octet-stream'),
           'sizeBytes', COALESCE(json_extract(attachment_resource.metadata_json, '$.size'), 0),
           'contentAvailable', CASE WHEN attachment_resource.content_ref IS NULL THEN 0 ELSE 1 END,
           'createdAt', attachment_resource.created_at
         )) FROM message_attachments ma
           JOIN resources attachment_resource ON attachment_resource.id = ma.resource_id
           WHERE ma.message_id = m.id ORDER BY ma.position), '[]') AS attachments_json
       FROM messages m LEFT JOIN users u ON u.id = m.author_user_id
       WHERE m.workspace_id = ? AND m.workstream_id = ? AND m.client_message_id = ?`,
    ).bind(this.auth.workspaceId, workstreamId, clientMessageId).first<Record<string, unknown>>();
    if (!row) return null;
    const authorType = String(row.author_type);
    return {
      id: String(row.id),
      clientMessageId: row.client_message_id == null ? null : String(row.client_message_id),
      workspaceId: String(row.workspace_id),
      workstreamId: String(row.workstream_id),
      author: authorType === "human"
        ? {
            type: "human",
            user: {
              id: String(row.author_user_id),
              email: String(row.author_email),
              name: String(row.author_name),
              avatarUrl: row.author_avatar_url == null ? null : String(row.author_avatar_url),
              timezone: String(row.author_timezone),
              createdAt: String(row.author_created_at),
            },
          }
        : authorType === "agent" ? { type: "agent" } : { type: "system" },
      messageType: String(row.message_type) as Message["messageType"],
      textContent: String(row.text_content ?? ""),
      structuredContent: json(row.structured_content_json, null),
      mentions: json(row.mentions_json, []),
      attachments: json<Array<Record<string, unknown>>>(row.attachments_json, []).map((attachment) => ({
        id: String(attachment.id),
        fileName: String(attachment.fileName),
        mimeType: String(attachment.mimeType || "application/octet-stream"),
        sizeBytes: Math.max(0, Number(attachment.sizeBytes ?? 0)),
        contentAvailable: Number(attachment.contentAvailable ?? 0) === 1 || attachment.contentAvailable === true,
        createdAt: String(attachment.createdAt),
      })),
      sequenceNumber: Number(row.sequence_number),
      createdAt: String(row.created_at),
      editedAt: row.edited_at == null ? null : String(row.edited_at),
    };
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

  private async launchHarness(workstreamId: string, triggerMessageId: string | null, origin: string, parentHarnessRunId?: string): Promise<string> {
    const id = newId();
    const at = nowIso();
    const principal = { type: "user" as const, userId: this.auth.userId };
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO harness_runs
         (id, workspace_id, workstream_id, origin, execution_principal_json, parent_harness_run_id,
          status, started_at, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
      ).bind(id, this.auth.workspaceId, workstreamId, origin, JSON.stringify(principal), parentHarnessRunId ?? null, at, this.env.OPENROUTER_PRIMARY_MODEL, at),
      this.env.DB.prepare(
        `UPDATE workstreams SET harness_status = 'running', last_activity_at = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ?`,
      ).bind(at, at, workstreamId, this.auth.workspaceId),
    ]);
    const workflowInput: WorkstreamWorkflowInput = {
      region: this.env.AVALON_REGION,
      workspaceId: this.auth.workspaceId,
      workstreamId,
      harnessRunId: id,
      triggerMessageId,
      automationSubscriptionId: null,
      activityId: null,
      executionPrincipal: principal,
      reason: origin,
    };
    try {
      await startWorkstreamWorkflow(this.env, workflowInput);
    } catch (error) {
      const diagnosticMessage = error instanceof Error ? error.message : "Workflow start failed";
      logStructuredEvent(this.env, "error", "workstream_harness_launch_failed", {
        request_id: id,
        workspace_id: this.auth.workspaceId,
        workstream_id: workstreamId,
        origin,
        error_name: error instanceof Error ? error.name : "UnknownError",
        error_message: diagnosticMessage,
      });
      const memberSafeError = memberSafeHarnessError({ code: "workflow_unavailable" })
        ?? GENERIC_MEMBER_SAFE_HARNESS_ERROR;
      await this.env.DB.batch([
        this.env.DB.prepare("UPDATE harness_runs SET status = 'failed', completed_at = ?, error_json = ? WHERE id = ?").bind(nowIso(), JSON.stringify(memberSafeError), id),
        this.env.DB.prepare("UPDATE workstreams SET harness_status = 'failed', updated_at = ? WHERE id = ?").bind(nowIso(), workstreamId),
      ]);
      throw new ApiError(503, "workflow_unavailable", "The Avalon harness could not be started");
    }
    await publishWorkstreamEvent(this.env, this.auth.workspaceId, workstreamId, { type: "harness_status_changed", status: "running" });
    return id;
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

  private scheduleMentionNotifications(message: Message, workstream: Workstream): void {
    const task = this.sendMentionNotifications(message, workstream).catch((error: unknown) => {
      console.warn("Mention email delivery failed", {
        messageId: message.id,
        region: this.env.AVALON_REGION,
        reason: error instanceof ApiError ? error.code : "unknown_error",
      });
    });
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
    await Promise.all([...recipients.values()].map((recipient) => sendWorkstreamMentionEmail(this.env, {
      messageId: message.id,
      recipientUserId: recipient.person_id,
      recipientEmail: recipient.email,
      recipientName: recipient.name,
      authorName: author.user.name,
      workspaceName: recipient.workspace_name,
      workstreamId: message.workstreamId,
      workstreamTitle: String(workstream.title),
      workstreamEmailAddress: workstream.emailAddress,
      messageText: message.textContent,
      region: this.env.AVALON_REGION,
    })));
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
    return (result.results ?? []).map((row) => ({
      user: { id: String(row.id), email: String(row.email), name: String(row.name), avatarUrl: row.avatar_url == null ? null : String(row.avatar_url), timezone: String(row.timezone), createdAt: String(row.created_at) },
      participationReason: String(row.participation_reason),
      joinedAt: String(row.joined_at),
    }));
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
    ).bind(id).all<Record<string, unknown>>();
    return (result.results ?? []).map((row) => ({
      id: String(row.id), workspaceId: String(row.workspace_id), connectionId: row.connection_id == null ? null : String(row.connection_id),
      resourceType: String(row.resource_type), provider: String(row.provider), providerResourceId: row.provider_resource_id == null ? null : String(row.provider_resource_id),
      title: String(row.title), mimeType: row.mime_type == null ? null : String(row.mime_type), canonicalUrl: row.canonical_url == null ? null : String(row.canonical_url),
      watchEnabled: Number(row.watch_enabled) === 1, watchStatus: String(row.watch_status), lastHydratedAt: row.last_hydrated_at == null ? null : String(row.last_hydrated_at),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }));
  }

  private async loadConnections() {
    const result = await this.env.DB.prepare(
      `SELECT c.*, u.name AS owner_name FROM connector_connections c LEFT JOIN users u ON u.id = c.owner_user_id
       WHERE c.workspace_id = ? AND (c.scope = 'workspace' OR c.owner_user_id = ?) ORDER BY c.display_name`,
    ).bind(this.auth.workspaceId, this.auth.userId).all<Record<string, unknown>>();
    return (result.results ?? []).map((row) => ({
      id: String(row.id), workspaceId: String(row.workspace_id), connectorType: String(row.connector_type), scope: String(row.scope),
      ownerUserId: row.owner_user_id == null ? null : String(row.owner_user_id), ownerName: row.owner_name == null ? null : String(row.owner_name),
      displayName: String(row.display_name), grantedCapabilities: json<string[]>(row.granted_scopes_json, []), status: String(row.status),
      lastSyncAt: row.last_sync_at == null ? null : String(row.last_sync_at), createdAt: String(row.created_at),
    }));
  }

  private async loadArtifacts(id: string) {
    const result = await this.env.DB.prepare(WORKSTREAM_ARTIFACTS_SQL)
      .bind(this.auth.workspaceId, id).all<Record<string, unknown>>();
    return (result.results ?? []).map((row) => {
      const metadata = json<{ mimeType?: string }>(row.metadata_json, {});
      return {
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        workstreamId: String(row.workstream_id),
        harnessRunId: row.harness_run_id == null ? null : String(row.harness_run_id),
        artifactType: String(row.artifact_type),
        title: String(row.title),
        previewText: row.preview_text == null ? null : String(row.preview_text).slice(0, 4_000),
        status: String(row.status),
        mimeType: metadata.mimeType ?? mimeTypeForArtifact(String(row.artifact_type)),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
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
    const harnessTasks = (harnessResult.results ?? []).map((row) => {
      const usage = json<Record<string, unknown>>(row.usage_json, {});
      const promptTokens = numericTokenCount(usage.prompt_tokens ?? usage.input_tokens);
      const completionTokens = numericTokenCount(usage.completion_tokens ?? usage.output_tokens);
      const explicitTotal = numericTokenCount(usage.total_tokens);
      const tokenCount = explicitTotal ?? (promptTokens != null || completionTokens != null
        ? (promptTokens ?? 0) + (completionTokens ?? 0)
        : null);
      return {
        id: String(row.id),
        harnessRunId: String(row.id),
        title: harnessTaskTitle(String(row.origin)),
        taskType: "agent" as const,
        status: backgroundTaskStatus(String(row.status)),
        startedAt: String(row.started_at ?? row.created_at),
        completedAt: row.completed_at == null ? null : String(row.completed_at),
        tokenCount,
        toolUses: Number(row.tool_uses ?? 0),
        transcriptMessageId: row.transcript_message_id == null ? null : String(row.transcript_message_id),
      };
    });
    const toolTasks = (toolResult.results ?? []).map((row) => ({
      id: String(row.id),
      harnessRunId: String(row.harness_run_id),
      title: toolTaskTitle(String(row.tool_name)),
      taskType: row.connection_id == null ? "tool" as const : "connector" as const,
      status: backgroundTaskStatus(String(row.status)),
      startedAt: String(row.started_at ?? row.harness_created_at),
      completedAt: row.completed_at == null ? null : String(row.completed_at),
      tokenCount: null,
      toolUses: null,
      transcriptMessageId: null,
    }));
    return [...harnessTasks, ...toolTasks]
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  private async loadElicitations(id: string, includeResolved = false) {
    const result = await this.env.DB.prepare(
      `SELECT * FROM elicitations WHERE workstream_id = ? ${includeResolved ? "" : "AND status = 'open'"} ORDER BY created_at`,
    ).bind(id).all<Record<string, unknown>>();
    return (result.results ?? []).map((row) => ({
      id: String(row.id), workstreamId: String(row.workstream_id), harnessRunId: String(row.harness_run_id), prompt: String(row.prompt),
      responseType: String(row.response_type), options: json(row.options_json, []), minimumSelections: Number(row.minimum_selections),
      maximumSelections: row.maximum_selections == null ? null : Number(row.maximum_selections), targetUserId: row.target_user_id == null ? null : String(row.target_user_id),
      status: String(row.status), answer: json(row.answer_json, null), answeredByUserId: row.answered_by_user_id == null ? null : String(row.answered_by_user_id),
      createdAt: String(row.created_at), answeredAt: row.answered_at == null ? null : String(row.answered_at),
    }));
  }

  private async loadSuggestions(id: string, includeResolved = false) {
    const result = await this.env.DB.prepare(
      `SELECT s.*, a.title, a.summary FROM activity_suggestions s JOIN activities a ON a.id = s.activity_id
       WHERE s.workstream_id = ? ${includeResolved ? "" : "AND s.status = 'pending'"} ORDER BY s.created_at DESC`,
    ).bind(id).all<Record<string, unknown>>();
    return (result.results ?? []).map((row) => ({
      id: String(row.id), activityId: String(row.activity_id), workstreamId: String(row.workstream_id), title: String(row.title), summary: String(row.summary),
      confidence: Number(row.confidence), reason: String(row.reason), status: String(row.status), createdAt: String(row.created_at), resolvedAt: row.resolved_at == null ? null : String(row.resolved_at),
    }));
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
      ).bind(id, this.auth.workspaceId, activity.connection_id, activity.resource_type ?? "activity", activity.provider, activity.provider_resource_id, activity.title, activity.payload_ref, activity.metadata_json ?? "{}", at, at).run();
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

function memberSafeHarnessError(value: unknown): { code: string; message: string } | null {
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

function toWorkstream(row: Record<string, unknown>) {
  return {
    id: String(row.id), workspaceId: String(row.workspace_id), title: String(row.title), objective: String(row.objective ?? ""),
    emailAddress: row.email_address == null ? null : String(row.email_address),
    originType: row.origin_type === "automation" ? "automation" as const : "ad_hoc" as const,
    originLabel: row.origin_label == null ? null : String(row.origin_label), createdByUserId: row.created_by_user_id == null ? null : String(row.created_by_user_id),
    automationSubscriptionId: row.automation_subscription_id == null ? null : String(row.automation_subscription_id), automationRunId: row.automation_run_id == null ? null : String(row.automation_run_id),
    plannedFor: row.planned_for == null ? null : String(row.planned_for), harnessStatus: String(row.harness_status) as "scheduled" | "running" | "needs_input" | "completed" | "failed" | "idle",
    lastActivityAt: String(row.last_activity_at), createdAt: String(row.created_at), updatedAt: String(row.updated_at), archivedAt: row.archived_at == null ? null : String(row.archived_at),
  };
}
