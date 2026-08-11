import {
  acknowledgeConnectorAgentActivation,
  ConnectorError,
  joinAllSlackPublicChannels,
  type SlackPublicChannelSyncResult,
  joinSlackPublicChannel,
  normalizeSlackActivity,
  parseSlackAgentInvocation,
  parseSlackEventEnvelope,
  slackApi,
  slackActivityEventType,
  type ConnectorConnectionContext,
  type SlackAgentInvocation,
  type SlackIngressEnvelope,
} from "@avalon/connectors";
import {
  ExternalActorSchema,
  SlackIngressQueueMessageSchema,
  SlackOriginContextSchema,
  SlackSearchAuthorizationSchema,
  TriggerDefinitionSchema,
  isWorkstreamId,
  parseWorkstreamLink,
  workstreamCanonicalUrl,
  type ExternalActor,
  type SlackOriginAttachment,
  type SlackOriginContext,
  type SlackOriginNearbyMessage,
  type SlackSearchAuthorization,
} from "@avalon/contracts";
import { HttpsUrlSchema, httpsUrlSchema } from "@avalon/contracts/url-schemas";
import { newId, nowIso } from "@avalon/db";
import {
  SLACK_UNFURL_MAX_LINKS,
  TERMINAL_UNFURL_REASONS,
  workstreamUnfurlCardHash,
  WORKSTREAM_UNFURL_COLUMNS,
  WORKSTREAM_UNFURL_JOINS,
  slackChannelIsExternallyShared,
  workstreamUnfurlBlocks,
  workstreamUnfurlSummary,
  type WorkstreamUnfurlSummary,
} from "./slack-workstream-card";
import { z } from "zod";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { logError, logInfo, logWarn, type LogEnv } from "../observability/logger";
import { withDeadline } from "../lib/deadline";
import { randomToken, sha256 } from "../lib/crypto";
import { connectorRegistryForEnv } from "../lib/connector-registry";
import {
  recordConnectorActorIdentity,
  resolveConnectorActorIdentity,
  type ConnectorActorVerification,
} from "./connector-actor-identity";
import { ensureFreshConnectorCredentials } from "./connector-credential-refresh";
import { decryptVersionedConnectorCredentials } from "./connector-credential-envelope";
import { persistNormalizedActivity } from "./normalized-activity-service";
import { SlackWorkspaceWorkstreamService } from "./slack-workspace-workstream-service";
import { WorkstreamService } from "./workstream-service";

interface SlackConnectionRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  provider_account_id: string;
  encrypted_credentials: string;
  credential_iv: string;
  credential_key_version?: number;
  granted_scopes_json: string;
  status: string;
}

interface SlackLinkedAccount {
  auth: AuthContext;
  connection: SlackConnectionRow;
  slackUserId: string;
  teamId: string;
}

interface SlackIdentity extends SlackLinkedAccount {
  token: string;
}

interface SlackSessionRow {
  id: string;
  workspace_id: string;
  connection_id: string;
  linked_user_id: string | null;
  execution_scope: "user" | "workspace";
  slack_team_id: string;
  slack_user_id: string;
  slack_channel_id: string;
  slack_thread_ts: string;
  slack_stream_ts: string | null;
  workstream_id: string;
  last_delivery_key: string | null;
  opening_client_message_id: string;
  invocation_kind: SlackPromptSource["kind"];
  channel_type: SlackPromptSource["channelType"];
  assigned_user_id: string | null;
}

type SlackPromptSource = {
  kind: "app_mention" | "direct_message" | "slash_command" | "shortcut";
  channelType: "public" | "private" | "im" | "unknown";
  channelResolutionFailure: "missing_scope" | "lookup_failed" | null;
  channelId: string | null;
  channelName: string | null;
  threadTs: string | null;
  messageTs: string | null;
  attachments: SlackOriginAttachment[];
};

const SlackModalContextSchema = z.object({
  kind: z.enum(["shortcut", "slash_command"]),
  channelType: z.enum(["public", "private", "im", "unknown"]),
  channelResolutionFailure: z.enum(["missing_scope", "lookup_failed"]).nullable().optional().default(null),
  channelId: z.string().min(1).nullable(),
  channelName: z.string().min(1).max(255).nullable().optional().default(null),
  threadTs: z.string().min(1).nullable(),
  messageTs: z.string().min(1).nullable().optional().default(null),
  attachments: z.array(z.object({
    id: z.string().min(1).max(255).nullable(),
    name: z.string().min(1).max(500),
    title: z.string().max(500).nullable(),
    mimeType: z.string().max(255).nullable(),
    fileType: z.string().max(120).nullable(),
    permalink: httpsUrlSchema(2000).nullable(),
  }).strict()).max(10).optional().default([]),
}).strict();

const SLACK_PENDING_PROMPT_TTL_MS = 24 * 60 * 60_000;
const SLACK_CONNECTION_DENIAL_TEXT = "Avalon’s Slack workspace connection needs attention, so it did not start this task. Ask an Avalon workspace admin to reconnect or test Slack in Avalon Settings, then reply `try again` in this thread.";
const SLACK_RETRY_PROMPT_MISSING_TEXT = "I couldn’t find the original request for this retry. Mention `@Avalon` again and restate what you want me to do.";
const SLACK_RETRYABLE_DENIAL_PREFIXES = [
  "Avalon’s Slack workspace connection needs attention",
  "Avalon workspace tasks are not enabled for this Slack surface",
  "Avalon needs updated Slack permissions before it can start workspace tasks here",
  "Avalon couldn’t verify whether this Slack channel is public or private",
] as const;

type SlackPendingDenialReason = "connection" | "channel_resolution" | "policy";
const SlackQueuedJobRowSchema = z.object({
  id: z.string().min(1),
  workspace_id: z.string().uuid(),
  connection_id: z.string().uuid(),
  team_id: z.string().min(1),
  body_hash: z.string().min(1),
  kind: z.enum(["event", "interaction", "command"]),
  payload_json: z.string(),
  lease_id: z.string().min(1),
});

const SlackInteractionPayloadSchema = z.record(z.string(), z.unknown());
const SlackCommandFormSchema = z.object({
  team_id: z.string().min(1),
  user_id: z.string().min(1),
  command: z.string().min(1),
  text: z.string().default(""),
  channel_id: z.string().min(1),
  trigger_id: z.string().min(1),
  response_url: HttpsUrlSchema.optional(),
}).catchall(z.string());
const SlackAutomationTargetSchema = z.object({
  id: z.string().min(1),
  workspace_id: z.string().min(1),
  connection_id: z.string().min(1),
  slack_user_id: z.string().min(1),
  connection_status: z.string().min(1),
  encrypted_credentials: z.string().min(1),
  credential_iv: z.string().min(1),
  last_delivered_workstream_id: z.string().nullable().optional(),
}).passthrough();

export class SlackAgentService {
  constructor(private readonly env: Env) {}

  /** Durably schedule a full public-channel join after install or reconnect. */
  async schedulePublicChannelSync(connectionId: string, retryAfterMs = 0): Promise<void> {
    const connection = await this.connectionById(connectionId);
    const eventId = `avalon-channel-sync:${crypto.randomUUID()}`;
    const envelope: SlackIngressEnvelope = {
      type: "event_callback",
      team_id: connection.provider_account_id,
      ...(this.env.SLACK_APP_ID ? { api_app_id: this.env.SLACK_APP_ID } : {}),
      event_id: eventId,
      event: { type: "avalon_public_channel_sync" },
    };
    await this.enqueueIngressJob({
      id: `event:${eventId}`,
      teamId: connection.provider_account_id,
      bodyHash: await sha256(JSON.stringify(envelope)),
      kind: "event",
      payload: envelope,
      ...(retryAfterMs > 0 ? {
        queueDelaySeconds: Math.min(43_200, Math.max(1, Math.ceil(retryAfterMs / 1_000))),
      } : {}),
      recoverQueueSendFailure: true,
    });
  }

  async maintainIngress(limit = 100): Promise<void> {
    await this.prewarmWorkspaceCredentials();
    const at = nowIso();
    const staleBefore = new Date(Date.now() - 2 * 60_000).toISOString();
    const recoverable = await this.env.DB.prepare(
      `SELECT id, workspace_id FROM slack_ingress_jobs
       WHERE payload_json IS NOT NULL AND attempt_count < 20
         AND ((status IN ('queued', 'failed') AND updated_at < ?)
           OR (status = 'processing' AND lease_expires_at < ?))
       ORDER BY received_at ASC LIMIT ?`,
    ).bind(staleBefore, at, limit).all<{ id: string; workspace_id: string }>();
    for (const job of recoverable.results) {
      try {
        await this.env.ACTIVITY_QUEUE.send(SlackIngressQueueMessageSchema.parse({
          kind: "slack_ingress",
          region: this.env.AVALON_REGION,
          workspaceId: job.workspace_id,
          jobId: job.id,
        }));
      } catch (error) {
        logWarn(this.env, "slack_ingress_recovery_enqueue_failed", {
          job_id: job.id,
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
    }
    const retentionCutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
    await this.env.DB.batch([
      this.env.DB.prepare(
        "DELETE FROM slack_ingress_jobs WHERE status = 'completed' AND completed_at < ?",
      ).bind(retentionCutoff),
      this.env.DB.prepare(
        `DELETE FROM slack_link_challenges
         WHERE (consumed_at IS NOT NULL AND consumed_at < ?) OR expires_at < ?`,
      ).bind(retentionCutoff, retentionCutoff),
      this.env.DB.prepare(
        "DELETE FROM slack_agent_thread_claims WHERE lease_expires_at < ?",
      ).bind(at),
      this.env.DB.prepare(
        "DELETE FROM slack_agent_pending_prompts WHERE expires_at < ?",
      ).bind(at),
      this.env.DB.prepare(
        `DELETE FROM slack_ingress_jobs
         WHERE status = 'failed' AND attempt_count >= 20 AND updated_at < ?`,
      ).bind(retentionCutoff),
    ]);
    const exhausted = await this.env.DB.prepare(
      `SELECT id, workspace_id, error_code FROM slack_ingress_jobs
       WHERE status = 'failed' AND attempt_count >= 20
       ORDER BY updated_at DESC LIMIT ?`,
    ).bind(limit).all<{ id: string; workspace_id: string; error_code: string | null }>();
    for (const job of exhausted.results) {
      logError(this.env, "slack_ingress_retry_budget_exhausted", {
        job_id: job.id,
        workspace_id: job.workspace_id,
        error_code: job.error_code,
      });
    }
  }

  private async prewarmWorkspaceCredentials(): Promise<void> {
    let afterId = "";
    while (true) {
      const page = await this.env.DB.prepare(
        `SELECT id, workspace_id, provider_account_id, encrypted_credentials, credential_iv, credential_key_version,
                granted_scopes_json, status
         FROM connector_connections
         WHERE connector_type = 'slack' AND scope = 'workspace' AND status = 'healthy' AND id > ?
         ORDER BY id ASC LIMIT 100`,
      ).bind(afterId).all<SlackConnectionRow>();
      for (let index = 0; index < page.results.length; index += 10) {
        await Promise.all(page.results.slice(index, index + 10).map(async (connection) => {
          try {
            // Cron runs every five minutes. Keep more than one cron interval
            // of token validity so a one-shot trigger never waits for refresh.
            await this.tokenFromEncrypted(connection, AbortSignal.timeout(10_000), 6 * 60_000);
          } catch (error) {
            logWarn(this.env, "slack_credential_prewarm_failed", {
              connection_id: connection.id,
              reason: error instanceof Error ? error.message : "unknown",
            });
          }
        }));
      }
      if (page.results.length < 100) return;
      afterId = page.results.at(-1)!.id;
    }
  }

  async processEvent(rawPayload: unknown, bodyHash: string): Promise<{ ok: true; duplicate?: boolean }> {
    const envelope = parseSlackEventEnvelope(rawPayload, this.env.SLACK_APP_ID);
    if (envelope.type === "url_verification") return { ok: true };
    const invocation = parseSlackAgentInvocation({ kind: "event", envelope });
    if (invocation.kind !== "event") throw new ApiError(422, "slack_event_invalid", "Slack event identity is missing");
    const activityEventType = slackActivityEventType(envelope);
    if (invocation.event.type === "message"
      && !await this.shouldEnqueueSlackMessage(
        invocation.teamId,
        invocation.event,
        authorizedBotUserId(envelope),
        activityEventType,
      )) {
      return { ok: true };
    }
    if (activityEventType
      && invocation.event.type !== "message"
      && invocation.event.type !== "app_mention") {
      const connection = await this.connectionForTeam(invocation.teamId);
      const botUserId = authorizedBotUserId(envelope) ?? await this.botUserId(connection);
      if (botUserId && slackEventActorUserIds(invocation.event).includes(botUserId)) return { ok: true };
      if (invocation.event.type !== "channel_created"
        && !await this.hasSubscribedSlackActivity(connection, activityEventType)) return { ok: true };
    }
    return this.enqueueIngressJob({
      id: `event:${invocation.eventId}`,
      teamId: invocation.teamId,
      bodyHash,
      kind: "event",
      payload: envelope,
    });
  }

  async processInteraction(payload: Record<string, unknown>, bodyHash: string): Promise<Record<string, unknown>> {
    const invocation = parseSlackAgentInvocation({ kind: "interaction", payload });
    if (invocation.kind !== "interaction") throw new ApiError(422, "slack_interaction_invalid", "Slack interaction identity is missing");
    const { teamId, userId: slackUserId } = invocation;
    const type = String(payload.type ?? "");
    const triggerId = typeof payload.trigger_id === "string" ? payload.trigger_id : null;

    if (type === "view_submission") {
      const view = asRecord(payload.view);
      if (view.callback_id === "avalon_start_task_submit") {
        const prompt = modalPrompt(view.state);
        if (!prompt) return { response_action: "errors", errors: { prompt: "Describe what Avalon should do." } };
        if (!modalPromptSource(view.private_metadata)) {
          return {
            response_action: "errors",
            errors: { prompt: "This Slack task context expired. Close this window and start the task again." },
          };
        }
        await this.enqueueIngressJob({ id: `interaction:${bodyHash}`, teamId, bodyHash, kind: "interaction", payload });
        return { response_action: "clear" };
      }
      if (view.callback_id === "avalon_preferences_submit") {
        if (!await this.linkedAccount(teamId, slackUserId)) return { response_action: "errors", errors: { delivery: "Connect your Avalon account first." } };
        await this.enqueueIngressJob({ id: `interaction:${bodyHash}`, teamId, bodyHash, kind: "interaction", payload });
        return { response_action: "clear" };
      }
      if (view.callback_id === "avalon_feedback_submit") {
        const identity = await this.linkedAccount(teamId, slackUserId);
        const workstreamId = typeof view.private_metadata === "string" ? view.private_metadata : "";
        const rating = modalSelectedValues(view.state, "rating", "value")[0];
        if (!identity || !workstreamId || (rating !== "helpful" && rating !== "needs_improvement")) return { response_action: "errors", errors: { rating: "Choose a feedback rating." } };
        const session = await this.env.DB.prepare(
          `SELECT id FROM slack_agent_sessions WHERE workspace_id = ? AND workstream_id = ? AND linked_user_id = ? AND connection_id = ?`,
        ).bind(identity.auth.workspaceId, workstreamId, identity.auth.userId, identity.connection.id).first<{ id: string }>();
        if (!session) return { response_action: "errors", errors: { rating: "This task is no longer available." } };
        await this.enqueueIngressJob({ id: `interaction:${bodyHash}`, teamId, bodyHash, kind: "interaction", payload });
        return { response_action: "clear" };
      }
      return {};
    }

    const connection = await this.connectionForTeam(teamId);
    const token = await this.botTokenForTrigger(connection);
    const action = Array.isArray(payload.actions) && payload.actions[0] && typeof payload.actions[0] === "object"
      ? payload.actions[0] as Record<string, unknown>
      : null;
    const callbackId = String(payload.callback_id ?? action?.action_id ?? "");
    if (type === "block_actions" && callbackId === "avalon_claim_workstream") {
      if (typeof action?.value !== "string" || !action.value) {
        throw new ApiError(422, "slack_claim_invalid", "The Slack task claim is invalid");
      }
      await this.enqueueIngressJob({
        id: `interaction:${bodyHash}`,
        teamId,
        bodyHash,
        kind: "interaction",
        payload,
      });
      return {};
    }
    if ((type === "shortcut" || type === "message_action" || type === "block_actions") && triggerId) {
      if (callbackId.startsWith("avalon_open_") || callbackId === "avalon_connect" || callbackId === "avalon_create_automation") return {};
      if (callbackId === "avalon_preferences") {
        const preferences = await this.env.DB.prepare(
          `SELECT notify_needs_input, notify_automation_completed
           FROM slack_delivery_preferences pref
           JOIN slack_user_links l ON l.connection_id = pref.connection_id AND l.user_id = pref.user_id
           WHERE pref.connection_id = ? AND l.slack_user_id = ? AND l.status = 'active'`,
        ).bind(connection.id, slackUserId).first<{ notify_needs_input: number; notify_automation_completed: number }>();
        await slackApi(token, "views.open", {
          trigger_id: triggerId,
          view: preferencesModal(preferences?.notify_needs_input !== 0, preferences?.notify_automation_completed !== 0),
        }, AbortSignal.timeout(1_500));
        return {};
      }
      if (callbackId === "avalon_feedback") {
        await slackApi(token, "views.open", { trigger_id: triggerId, view: feedbackModal(String(action?.value ?? "")) }, AbortSignal.timeout(1_500));
        return {};
      }
      const shortcutMessage = asRecord(payload.message);
      const sourceText = type === "message_action" && shortcutMessage.text
        ? String(shortcutMessage.text)
        : "";
      const shortcutChannelId = nestedString(payload, "channel", "id");
      const shortcutThreadTs = type === "message_action"
        ? String(shortcutMessage.thread_ts ?? shortcutMessage.ts ?? "") || null
        : null;
      const shortcutMessageTs = type === "message_action" && shortcutMessage.ts
        ? String(shortcutMessage.ts)
        : null;
      const shortcutChannelResolution = shortcutChannelId
        ? await resolveSlackChannelType(this.env, token, shortcutChannelId, nestedString(payload, "channel", "type"))
        : { channelType: "unknown" as const, channelName: null, failure: null };
      await slackApi(token, "views.open", {
        trigger_id: triggerId,
        view: startTaskModal(sourceText, {
          kind: "shortcut",
          channelType: shortcutChannelResolution.channelType,
          channelResolutionFailure: shortcutChannelResolution.failure,
          channelId: shortcutChannelId || null,
          channelName: nestedString(payload, "channel", "name") ?? shortcutChannelResolution.channelName,
          threadTs: shortcutThreadTs,
          messageTs: shortcutMessageTs,
          attachments: slackOriginAttachments(shortcutMessage),
        }),
      }, AbortSignal.timeout(1_500));
      return {};
    }
    return {};
  }

  async processCommand(form: Record<string, string>, bodyHash: string): Promise<Record<string, unknown>> {
    const parsed = SlackCommandFormSchema.safeParse(form);
    if (!parsed.success) throw new ApiError(422, "slack_command_invalid", "Slack command payload is invalid");
    const commandForm = parsed.data;
    const invocation = parseSlackAgentInvocation({ kind: "command", payload: commandForm });
    if (invocation.kind !== "command") throw new ApiError(422, "slack_command_invalid", "Slack command payload is invalid");
    const { teamId } = invocation;
    if (!commandForm.text.trim()) {
      const connection = await this.connectionForTeam(teamId);
      await slackApi(await this.botTokenForTrigger(connection), "views.open", {
        trigger_id: commandForm.trigger_id,
        view: startTaskModal("", {
          kind: "slash_command",
          channelType: slackChannelType(commandForm.channel_name || commandForm.channel_id),
          channelResolutionFailure: null,
          channelId: commandForm.channel_id,
          channelName: commandForm.channel_name || null,
          threadTs: null,
          messageTs: null,
          attachments: [],
        }),
      }, AbortSignal.timeout(1_500));
      return { response_type: "ephemeral", text: "Opening Avalon…" };
    }
    if (/^help$/iu.test(commandForm.text.trim())) {
      return { response_type: "ephemeral", text: "Ask Avalon to investigate, summarize, coordinate, or create an automation. Run /avalon without text to open the task modal, or open App Home to connect and manage notifications." };
    }
    await this.enqueueIngressJob({ id: `command:${bodyHash}`, teamId, bodyHash, kind: "command", payload: commandForm });
    return { response_type: "ephemeral", text: "Avalon queued your request. I’ll continue in your Agent conversation." };
  }

  async processQueuedIngress(jobId: string): Promise<void> {
    const leaseId = crypto.randomUUID();
    const at = nowIso();
    const claimed = await this.env.DB.prepare(
      `UPDATE slack_ingress_jobs SET
         status = 'processing', attempt_count = attempt_count + 1,
         lease_id = ?, lease_expires_at = ?, error_code = NULL, updated_at = ?
       WHERE id = ? AND workspace_id IN (SELECT id FROM workspaces WHERE region = ?)
         AND (status IN ('queued', 'failed') OR (status = 'processing' AND lease_expires_at < ?))
       RETURNING id, workspace_id, connection_id, team_id, body_hash, kind, payload_json, lease_id`,
    ).bind(leaseId, new Date(Date.now() + 5 * 60_000).toISOString(), at, jobId, this.env.AVALON_REGION, at).first<Record<string, unknown>>();
    if (!claimed) return;
    const job = SlackQueuedJobRowSchema.parse(claimed);
    try {
      const rawPayload: unknown = JSON.parse(job.payload_json);
      if (job.kind === "event") {
        const envelope = parseSlackEventEnvelope(rawPayload, this.env.SLACK_APP_ID);
        await this.dispatchEvent(job.team_id, envelope, job.body_hash);
      } else if (job.kind === "interaction") {
        await this.dispatchQueuedInteraction(SlackInteractionPayloadSchema.parse(rawPayload), job.id);
      } else {
        await this.dispatchQueuedCommand(SlackCommandFormSchema.parse(rawPayload));
      }
      await this.env.DB.prepare(
        `UPDATE slack_ingress_jobs SET status = 'completed', payload_json = NULL,
           lease_id = NULL, lease_expires_at = NULL, error_code = NULL,
           completed_at = ?, updated_at = ?
         WHERE id = ? AND lease_id = ?`,
      ).bind(nowIso(), nowIso(), job.id, leaseId).run();
    } catch (error) {
      const retryable = slackIngressRetryable(error);
      if (slackReconnectRequired(error)) {
        await this.markSlackReconnectRequired(job.connection_id, slackErrorReason(error));
      }
      await this.env.DB.prepare(
        `UPDATE slack_ingress_jobs SET status = 'failed', lease_id = NULL,
           lease_expires_at = NULL, error_code = ?,
           attempt_count = CASE WHEN ? THEN attempt_count ELSE 20 END, updated_at = ?
         WHERE id = ? AND lease_id = ?`,
      ).bind(slackIngressErrorCode(error), retryable ? 1 : 0, nowIso(), job.id, leaseId).run();
      throw error;
    }
  }

  private async enqueueIngressJob(input: {
    id: string;
    teamId: string;
    bodyHash: string;
    kind: "event" | "interaction" | "command";
    payload: unknown;
    queueDelaySeconds?: number;
    recoverQueueSendFailure?: boolean;
  }): Promise<{ ok: true; duplicate?: boolean }> {
    const connection = await this.connectionForTeam(input.teamId);
    const at = nowIso();
    const inserted = await this.env.DB.prepare(
      `INSERT INTO slack_ingress_jobs
       (id, workspace_id, connection_id, team_id, body_hash, kind, payload_json,
        status, attempt_count, received_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).bind(input.id, connection.workspace_id, connection.id, input.teamId, input.bodyHash, input.kind, JSON.stringify(input.payload), at, at).run();
    const duplicate = Number(inserted.meta.changes ?? 0) === 0;
    if (duplicate) {
      const prior = await this.env.DB.prepare(
        "SELECT body_hash, status FROM slack_ingress_jobs WHERE id = ?",
      ).bind(input.id).first<{ body_hash: string; status: string }>();
      if (!prior || prior.body_hash !== input.bodyHash) throw new ApiError(409, "slack_ingress_conflict", "Slack reused an ingress identity with different content");
      if (prior.status === "completed") return { ok: true, duplicate: true };
    }
    const message = SlackIngressQueueMessageSchema.parse({
      kind: "slack_ingress",
      region: this.env.AVALON_REGION,
      workspaceId: connection.workspace_id,
      jobId: input.id,
    });
    try {
      if (input.queueDelaySeconds != null) {
        await this.env.ACTIVITY_QUEUE.send(message, { delaySeconds: input.queueDelaySeconds });
      } else {
        await this.env.ACTIVITY_QUEUE.send(message);
      }
    } catch (error) {
      if (!input.recoverQueueSendFailure) throw error;
      logWarn(this.env, "slack_ingress_publish_deferred", {
        job_id: input.id,
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
    return { ok: true, ...(duplicate ? { duplicate: true } : {}) };
  }

  private async dispatchQueuedInteraction(payload: Record<string, unknown>, jobId: string): Promise<void> {
    const teamId = nestedString(payload, "team", "id");
    const slackUserId = nestedString(payload, "user", "id");
    if (!teamId || !slackUserId) throw new ApiError(422, "slack_interaction_invalid", "Slack interaction identity is missing");
    if (payload.type === "block_actions") {
      const action = Array.isArray(payload.actions) && payload.actions[0] && typeof payload.actions[0] === "object"
        ? payload.actions[0] as Record<string, unknown>
        : null;
      if (action?.action_id === "avalon_claim_workstream" && typeof action.value === "string") {
        await this.handleWorkspaceClaim(teamId, slackUserId, action.value);
      }
      return;
    }
    if (payload.type !== "view_submission") return;
    const view = asRecord(payload.view);
    if (view.callback_id === "avalon_start_task_submit") {
      const prompt = modalPrompt(view.state);
      if (!prompt) throw new ApiError(422, "slack_prompt_missing", "The Slack task prompt is missing");
      const source = modalPromptSource(view.private_metadata);
      if (!source) throw new ApiError(422, "slack_modal_context_invalid", "The Slack task context is invalid");
      await this.startFromPrompt(
        teamId,
        slackUserId,
        source.kind === "slash_command" ? null : source.channelId,
        source.kind === "slash_command" ? null : source.threadTs,
        prompt,
        `view:${String(view.id ?? jobId)}`,
        source,
      );
      return;
    }
    const identity = await this.linkedAccount(teamId, slackUserId);
    if (!identity) throw new ApiError(409, "slack_link_missing", "The Slack user link is no longer active");
    if (view.callback_id === "avalon_preferences_submit") {
      const selected = modalSelectedValues(view.state, "delivery", "value");
      await this.env.DB.prepare(
        `INSERT INTO slack_delivery_preferences
         (connection_id, user_id, slack_user_id, notify_needs_input, notify_automation_completed, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(connection_id, user_id) DO UPDATE SET
           notify_needs_input = excluded.notify_needs_input,
           notify_automation_completed = excluded.notify_automation_completed,
           updated_at = excluded.updated_at`,
      ).bind(identity.connection.id, identity.auth.userId, slackUserId, selected.includes("needs_input") ? 1 : 0, selected.includes("automation_completed") ? 1 : 0, nowIso()).run();
      await this.publishHome(teamId, slackUserId);
      return;
    }
    if (view.callback_id === "avalon_feedback_submit") {
      const workstreamId = typeof view.private_metadata === "string" ? view.private_metadata : "";
      const rating = modalSelectedValues(view.state, "rating", "value")[0];
      if (!workstreamId || (rating !== "helpful" && rating !== "needs_improvement")) throw new ApiError(422, "slack_feedback_invalid", "Slack feedback is invalid");
      await this.env.DB.prepare(
        `INSERT INTO slack_agent_feedback
         (id, ingress_job_id, workspace_id, workstream_id, user_id, connection_id, rating, comment, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ingress_job_id) DO NOTHING`,
      ).bind(newId(), jobId, identity.auth.workspaceId, workstreamId, identity.auth.userId, identity.connection.id, rating, modalTextValue(view.state, "comment", "value"), nowIso()).run();
    }
  }

  private async dispatchQueuedCommand(form: z.infer<typeof SlackCommandFormSchema>): Promise<void> {
    await this.startFromPrompt(
      form.team_id,
      form.user_id,
      null,
      null,
      form.text.trim(),
      `command:${form.trigger_id}`,
      {
        kind: "slash_command",
        channelType: slackChannelType(form.channel_name || form.channel_id),
        channelResolutionFailure: null,
        channelId: form.channel_id,
        channelName: form.channel_name || null,
        threadTs: null,
        messageTs: null,
        attachments: [],
      },
    );
    if (form.response_url) {
      try {
        await postSlackResponse(form.response_url, {
          response_type: "ephemeral",
          replace_original: false,
          text: "Avalon processed your request. Check your Agent conversation for the task or any required action.",
        });
      } catch (error) {
        logWarn(this.env, "slack_command_follow_up_failed", { reason: error instanceof Error ? error.message : "unknown" });
      }
    }
  }

  async linkUser(auth: AuthContext, token: string): Promise<{ linked: true; teamId: string; slackUserId: string }> {
    const tokenHash = await sha256(token);
    const challenge = await this.loadLinkChallenge(auth, tokenHash);
    const at = nowIso();
    let results: D1Result<unknown>[];
    try {
      results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE slack_link_challenges SET consumed_at = ?, consumed_by_user_id = ?
         WHERE token_hash = ? AND consumed_at IS NULL`,
      ).bind(at, auth.userId, tokenHash),
      this.env.DB.prepare(
        `INSERT INTO slack_user_links
         (id, workspace_id, connection_id, user_id, slack_team_id, slack_user_id, status, created_at, updated_at)
         SELECT ?, cc.workspace_id, c.connection_id, ?, c.slack_team_id, c.slack_user_id, 'active', ?, ?
         FROM slack_link_challenges c
         JOIN connector_connections cc ON cc.id = c.connection_id
         WHERE c.token_hash = ? AND c.consumed_at = ? AND c.consumed_by_user_id = ?
           AND cc.workspace_id = ? AND cc.connector_type = 'slack'
           AND cc.scope = 'workspace' AND cc.status = 'healthy'
         ON CONFLICT(workspace_id, connection_id, user_id) DO UPDATE SET
           slack_team_id = excluded.slack_team_id,
           slack_user_id = excluded.slack_user_id,
           status = 'active',
           updated_at = excluded.updated_at`,
      ).bind(newId(), auth.userId, at, at, tokenHash, at, auth.userId, auth.workspaceId),
      ]);
    } catch (error) {
      if (error instanceof Error && /(?:UNIQUE|constraint)/iu.test(error.message)) {
        throw new ApiError(409, "slack_identity_already_linked", "This Slack identity is already connected to another Avalon user");
      }
      throw error;
    }
    const [claimed, linked] = results;
    if (!claimed || !linked) throw new ApiError(500, "slack_link_failed", "Slack could not be connected");
    if (Number(claimed.meta.changes ?? 0) !== 1 || Number(linked.meta.changes ?? 0) !== 1) {
      throw new ApiError(409, "slack_link_consumed", "This Slack link has already been used; open Avalon Home in Slack for a new link");
    }
    await this.assignWorkspaceSessions(
      String(challenge.connection_id),
      String(challenge.slack_team_id),
      String(challenge.slack_user_id),
      auth.userId,
      "explicit_link",
    );
    await this.publishHome(String(challenge.slack_team_id), String(challenge.slack_user_id));
    return { linked: true, teamId: String(challenge.slack_team_id), slackUserId: String(challenge.slack_user_id) };
  }

  /**
   * Adopts ownerless workstreams created by this Slack identity after the
   * matching person joins Avalon. Email lookup identifies the Slack member;
   * it does not create a personal Slack connection or rewrite prior runs.
   */
  async assignWorkspaceWorkstreamsForMember(
    workspaceId: string,
    userId: string,
    verifiedEmail: string,
  ): Promise<number> {
    const membership = await this.env.DB.prepare(
      `SELECT 1 AS active FROM workspace_members
       WHERE workspace_id = ? AND user_id = ? AND status = 'active'`,
    ).bind(workspaceId, userId).first<{ active: number }>();
    if (!membership) return 0;
    const rawConnections = await this.env.DB.prepare(
      `SELECT id, workspace_id, provider_account_id, encrypted_credentials, credential_iv, credential_key_version,
              granted_scopes_json, status
       FROM connector_connections
       WHERE workspace_id = ? AND connector_type = 'slack' AND scope = 'workspace'
         AND status = 'healthy' ORDER BY id`,
    ).bind(workspaceId).all<SlackConnectionRow>();
    let assigned = 0;
    for (const connection of rawConnections.results ?? []) {
      try {
        const result = await slackApi(
          await this.botToken(connection),
          "users.lookupByEmail",
          { email: verifiedEmail.trim().toLowerCase() },
          AbortSignal.timeout(10_000),
        );
        if (!validSlackHuman(result.user, connection.provider_account_id)) continue;
        // Publish the mapping to the shared connector directory so every other
        // surface resolves this Slack identity without repeating the lookup.
        await recordConnectorActorIdentity(
          this.env,
          workspaceId,
          {
            provider: "slack",
            providerAccountId: connection.provider_account_id,
            providerUserId: result.user.id,
            displayName: slackHumanDisplayName(result.user),
            avatarUrl: null,
          },
          { userId, verification: "verified_email" },
          verifiedEmail,
        );
        assigned += await this.assignWorkspaceSessions(
          connection.id,
          connection.provider_account_id,
          result.user.id,
          userId,
          "verified_email",
        );
      } catch (error) {
        if (slackErrorReason(error) === "users_not_found") continue;
        if (slackReconnectRequired(error)) {
          await this.markSlackReconnectRequired(connection.id, slackErrorReason(error));
        }
        logWarn(this.env, "slack_member_assignment_lookup_failed", {
          workspace_id: workspaceId,
          connection_id: connection.id,
          user_id: userId,
          reason: slackErrorReason(error),
        });
      }
    }
    return assigned;
  }

  private async assignWorkspaceSessions(
    connectionId: string,
    teamId: string,
    slackUserId: string,
    userId: string,
    method: "verified_email" | "explicit_link",
  ): Promise<number> {
    const at = nowIso();
    const assignmentGuard = method === "explicit_link"
      ? ""
      : "AND (s.assigned_user_id IS NULL OR s.assigned_user_id = ?)";
    const guardBindings = method === "explicit_link" ? [] : [userId];
    const assignmentMetadata = method === "explicit_link"
      ? "assigned_at = ?, assignment_method = 'explicit_link'"
      : "assigned_at = COALESCE(assigned_at, ?), assignment_method = COALESCE(assignment_method, 'verified_email')";
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO workstream_participants
         (workstream_id, user_id, added_by_user_id, participation_reason, joined_at, removed_at)
         SELECT s.workstream_id, ?, ?, 'explicit', ?, NULL
         FROM slack_agent_sessions s
         WHERE s.connection_id = ? AND s.slack_team_id = ? AND s.slack_user_id = ?
           AND s.execution_scope = 'workspace'
           ${assignmentGuard}
         ON CONFLICT(workstream_id, user_id) DO UPDATE SET
           removed_at = NULL,
           joined_at = COALESCE(workstream_participants.joined_at, excluded.joined_at)`,
      ).bind(userId, userId, at, connectionId, teamId, slackUserId, ...guardBindings),
      // A work stream this Slack member started before the mapping existed was
      // recorded as ownerless. Now that the identity resolves, credit them as
      // its creator.
      //
      // A creator recorded by another path is never rewritten. The single
      // exception is an explicit account link correcting a creator that this
      // same session's own verified-email guess produced: the link is the
      // stronger statement about who the Slack member is, and the address it
      // disagrees with can belong to somebody else. The session row still
      // carries its previous `assignment_method` here, because the statement
      // that overwrites it runs later in this batch.
      this.env.DB.prepare(
        `UPDATE workstreams
         SET created_by_user_id = ?, updated_at = ?
         WHERE id IN (
           SELECT s.workstream_id FROM slack_agent_sessions s
           WHERE s.connection_id = ? AND s.slack_team_id = ? AND s.slack_user_id = ?
             AND s.execution_scope = 'workspace'
             AND (
               workstreams.created_by_user_id IS NULL
               ${method === "explicit_link"
                 ? `OR (s.assignment_method = 'verified_email'
                        AND workstreams.created_by_user_id = s.assigned_user_id)`
                 : ""}
             )
             ${assignmentGuard}
         )`,
      ).bind(userId, at, connectionId, teamId, slackUserId, ...guardBindings),
      this.env.DB.prepare(
        `UPDATE slack_agent_sessions
         SET assigned_user_id = ?, ${assignmentMetadata}, updated_at = ?
         WHERE connection_id = ? AND slack_team_id = ? AND slack_user_id = ?
           AND execution_scope = 'workspace'
           ${assignmentGuard.replaceAll("s.", "")}`,
      ).bind(userId, at, at, connectionId, teamId, slackUserId, ...guardBindings),
      // The participation row above records how they were added; once they are
      // the creator it should say so, or the People rail subtitles a creator
      // with "explicit".
      this.env.DB.prepare(
        `UPDATE workstream_participants
         SET participation_reason = 'creator'
         WHERE user_id = ? AND participation_reason <> 'creator'
           AND workstream_id IN (
             SELECT s.workstream_id FROM slack_agent_sessions s
             JOIN workstreams w ON w.id = s.workstream_id AND w.created_by_user_id = ?
             WHERE s.connection_id = ? AND s.slack_team_id = ? AND s.slack_user_id = ?
               AND s.execution_scope = 'workspace'
               ${assignmentGuard}
           )`,
      ).bind(userId, userId, connectionId, teamId, slackUserId, ...guardBindings),
      // Symmetrically, a member a correction displaced is still a participant
      // but no longer the creator.
      this.env.DB.prepare(
        `UPDATE workstream_participants
         SET participation_reason = 'explicit'
         WHERE participation_reason = 'creator' AND user_id <> ?
           AND workstream_id IN (
             SELECT s.workstream_id FROM slack_agent_sessions s
             JOIN workstreams w ON w.id = s.workstream_id AND w.created_by_user_id = ?
             WHERE s.connection_id = ? AND s.slack_team_id = ? AND s.slack_user_id = ?
               AND s.execution_scope = 'workspace'
               ${assignmentGuard}
           )`,
      ).bind(userId, userId, connectionId, teamId, slackUserId, ...guardBindings),
    ]);
    return Number(results[2]?.meta.changes ?? 0);
  }

  async previewLink(auth: AuthContext, token: string): Promise<{ teamId: string; slackUserId: string; workspaceName: string }> {
    const challenge = await this.loadLinkChallenge(auth, await sha256(token));
    return {
      teamId: String(challenge.slack_team_id),
      slackUserId: String(challenge.slack_user_id),
      workspaceName: String(challenge.display_name),
    };
  }

  private async loadLinkChallenge(auth: AuthContext, tokenHash: string): Promise<Record<string, unknown>> {
    const challenge = await this.env.DB.prepare(
      `SELECT c.*, cc.workspace_id, cc.provider_account_id
              , cc.display_name
       FROM slack_link_challenges c
       JOIN connector_connections cc ON cc.id = c.connection_id
       WHERE c.token_hash = ? AND c.consumed_at IS NULL AND c.expires_at > ?
         AND cc.connector_type = 'slack' AND cc.scope = 'workspace' AND cc.status = 'healthy'`,
    ).bind(tokenHash, nowIso()).first<Record<string, unknown>>();
    if (!challenge) throw new ApiError(404, "slack_link_expired", "This Slack link has expired; open Avalon Home in Slack for a new link");
    if (challenge.workspace_id !== auth.workspaceId) throw new ApiError(409, "slack_link_workspace_mismatch", "This Slack installation belongs to another Avalon workspace");
    return challenge;
  }

  async deliverWorkstreamOutcome(
    workspaceId: string,
    workstreamId: string,
    text: string,
    deliveryKey: string,
    outcomeStatus: "completed" | "needs_input" | "failed" | "stopped",
  ): Promise<void> {
    const session = await this.env.DB.prepare(
      `SELECT * FROM slack_agent_sessions WHERE workspace_id = ? AND workstream_id = ?`,
    ).bind(workspaceId, workstreamId).first<SlackSessionRow>();
    if (!session) return;
    if (session.last_delivery_key === deliveryKey) return;
    const connection = await this.connectionById(session.connection_id);
    const token = await this.botToken(connection);
    const openElicitation = outcomeStatus === "needs_input"
      ? await this.env.DB.prepare(
          `SELECT prompt, target_user_id FROM elicitations
           WHERE workspace_id = ? AND workstream_id = ? AND status = 'open'
           ORDER BY created_at ASC LIMIT 1`,
        ).bind(workspaceId, workstreamId).first<{ prompt: string; target_user_id: string | null }>()
      : null;
    const responseText = openElicitation?.prompt || text || "Avalon completed the task without a text response.";
    let delivered = false;
    let streamContentComplete = false;
    let deliveryError: unknown;
    try {
      if (session.slack_stream_ts) {
        for (const chunk of splitSlackText(responseText, 12_000)) {
          await slackApi(token, "chat.appendStream", { channel: session.slack_channel_id, ts: session.slack_stream_ts, markdown_text: chunk }, AbortSignal.timeout(10_000));
        }
        streamContentComplete = true;
        await slackApi(token, "chat.stopStream", {
          channel: session.slack_channel_id,
          ts: session.slack_stream_ts,
          blocks: responseActionBlocks(workstreamId, this.env.PUBLIC_WEB_BASE_URL, session.linked_user_id !== null),
        }, AbortSignal.timeout(10_000));
        delivered = true;
      }
    } catch (error) {
      logWarn(this.env, "slack_stream_delivery_failed", { fallback: "thread_reply", workspace_id: workspaceId, workstream_id: workstreamId, reason: error instanceof Error ? error.message : "unknown" });
      try {
        // An append may have reached Slack even when its response was lost.
        // Close the known stream before posting the idempotent full fallback so
        // the Agent UI never remains indefinitely in a streaming state.
        await slackApi(token, "chat.stopStream", {
          channel: session.slack_channel_id,
          ts: session.slack_stream_ts!,
        }, AbortSignal.timeout(5_000));
        // If every append was acknowledged, this retry finalized the complete
        // stream and a fallback reply would only duplicate the result.
        if (streamContentComplete) delivered = true;
      } catch (stopError) {
        if (stopError instanceof ConnectorError && stopError.message === "message_not_in_streaming_state") {
          // This is conclusive only when all append responses were received;
          // otherwise the closed stream may contain a partial result.
          if (streamContentComplete) delivered = true;
        } else {
          logWarn(this.env, "slack_stream_close_failed", {
            workspace_id: workspaceId,
            workstream_id: workstreamId,
            reason: stopError instanceof Error ? stopError.message : "unknown",
          });
        }
      }
    }
    try {
      if (!delivered) {
        await postSlackTextChunks(token, session.slack_channel_id, responseText, session.slack_thread_ts, `${session.id}:${deliveryKey}:result`);
        await slackApi(token, "chat.postMessage", {
          channel: session.slack_channel_id,
          thread_ts: session.slack_thread_ts,
          client_msg_id: await stableUuid(`${session.id}:${deliveryKey}:controls`),
          text: "Avalon task controls",
          blocks: responseActionBlocks(workstreamId, this.env.PUBLIC_WEB_BASE_URL, session.linked_user_id !== null),
        }, AbortSignal.timeout(10_000));
      }
      if (outcomeStatus === "needs_input" && session.execution_scope === "workspace") {
        const dmChannel = await this.openDm(token, session.slack_user_id);
        const link = await this.createLink(connection, session.slack_user_id);
        await slackApi(token, "chat.postMessage", {
          channel: dmChannel,
          client_msg_id: await stableUuid(`${session.id}:${deliveryKey}:claim-link`),
          text: `This workspace-owned task needs personal Avalon authority. Connect your Avalon account to claim it: ${link}`,
        }, AbortSignal.timeout(10_000));
        if (dmChannel !== session.slack_channel_id) {
          await slackApi(token, "chat.postMessage", {
            channel: session.slack_channel_id,
            thread_ts: session.slack_thread_ts,
            client_msg_id: await stableUuid(`${session.id}:${deliveryKey}:claim-notice`),
            text: openElicitation?.target_user_id
              ? "This task needs input from a specific Avalon workspace member. The targeted member must connect, explicitly claim the task, and then reply here."
              : "This task needs personal Avalon authority. A connected Avalon workspace member can explicitly claim it, then reply here to continue.",
            blocks: workspaceClaimBlocks(session.id, false),
          }, AbortSignal.timeout(10_000));
        }
      }
      await this.env.DB.prepare(
        "UPDATE slack_agent_sessions SET last_delivery_key = ?, updated_at = ? WHERE id = ?",
      ).bind(deliveryKey, nowIso(), session.id).run();
    } catch (error) {
      deliveryError = error;
      logWarn(this.env, "slack_workstream_delivery_failed", { workspace_id: workspaceId, workstream_id: workstreamId, reason: error instanceof Error ? error.message : "unknown" });
    } finally {
      try {
        await slackApi(token, "assistant.threads.setStatus", { channel_id: session.slack_channel_id, thread_ts: session.slack_thread_ts, status: "" }, AbortSignal.timeout(5_000));
      } catch (error) {
        logWarn(this.env, "slack_thread_status_cleanup_failed", { workspace_id: workspaceId, workstream_id: workstreamId, reason: error instanceof Error ? error.message : "unknown" });
      }
      await this.env.DB.prepare(
        "UPDATE slack_agent_sessions SET slack_stream_ts = NULL, updated_at = ? WHERE id = ?",
      ).bind(nowIso(), session.id).run();
    }
    if (deliveryError) throw deliveryError;
  }

  async deliverAutomationResult(input: {
    workspaceId: string;
    automationSubscriptionId: string;
    workstreamId: string;
    title: string;
    text: string;
    outcomeStatus: "completed" | "needs_input" | "failed" | "stopped";
  }): Promise<void> {
    if (shouldSuppressAutomationResult(input.text)) return;
    const rawTarget = await this.env.DB.prepare(
      `SELECT dt.*, cc.encrypted_credentials, cc.credential_iv, cc.status AS connection_status
       FROM automation_delivery_targets dt
       JOIN connector_connections cc ON cc.id = dt.connection_id
       JOIN workspace_members wm ON wm.workspace_id = dt.workspace_id AND wm.user_id = dt.user_id AND wm.status = 'active'
       JOIN slack_user_links link ON link.connection_id = dt.connection_id AND link.user_id = dt.user_id
         AND link.slack_user_id = dt.slack_user_id AND link.status = 'active'
       LEFT JOIN slack_delivery_preferences pref
         ON pref.connection_id = dt.connection_id AND pref.user_id = dt.user_id
       WHERE dt.workspace_id = ? AND dt.automation_subscription_id = ?
         AND dt.target_type = 'slack_agent_dm' AND dt.status IN ('active', 'needs_input')
         AND CASE WHEN ? = 'needs_input'
           THEN COALESCE(pref.notify_needs_input, 1)
           ELSE COALESCE(pref.notify_automation_completed, 1)
         END = 1`,
    ).bind(input.workspaceId, input.automationSubscriptionId, input.outcomeStatus).first<Record<string, unknown>>();
    if (!rawTarget) return;
    const target = SlackAutomationTargetSchema.parse(rawTarget);
    if (target.last_delivered_workstream_id === input.workstreamId) return;
    if (target.connection_status !== "healthy") {
      await this.markAutomationDelivery(target, "needs_input", new Error("Slack installation needs reconnect"));
      return;
    }
    try {
      const token = await this.tokenFromEncrypted(target);
      const opened = await slackApi(token, "conversations.open", { users: target.slack_user_id }, AbortSignal.timeout(10_000));
      const channelId = opened.channel.id;
      const title = input.outcomeStatus === "needs_input" ? `Action needed · ${input.title}` : input.title;
      const deliveryKey = `${target.id}:${input.workstreamId}`;
      const threadTs = await postSlackTextChunks(token, channelId, `${title}\n${input.text}`, undefined, `${deliveryKey}:result`);
      await slackApi(token, "chat.postMessage", {
        channel: channelId,
        thread_ts: threadTs,
        client_msg_id: await stableUuid(`${deliveryKey}:controls`),
        text: "Open the full Avalon result",
        blocks: automationActionBlocks(title, input.workstreamId, this.env.PUBLIC_WEB_BASE_URL),
      }, AbortSignal.timeout(10_000));
      await this.env.DB.prepare(
        `UPDATE automation_delivery_targets SET status = 'active', last_delivered_at = ?,
           last_delivered_workstream_id = ?, last_error_json = NULL, updated_at = ? WHERE id = ?`,
      ).bind(nowIso(), input.workstreamId, nowIso(), target.id).run();
      try {
        await slackApi(token, "assistant.threads.setTitle", { channel_id: channelId, thread_ts: threadTs, title: input.title }, AbortSignal.timeout(5_000));
      } catch (error) {
        logWarn(this.env, "slack_automation_thread_title_failed", { target_id: target.id, reason: error instanceof Error ? error.message : "unknown" });
      }
    } catch (error) {
      const reconnectRequired = (error instanceof ConnectorError && error.code === "unauthorized")
        || (error instanceof ApiError && error.status === 401);
      await this.markAutomationDelivery(target, reconnectRequired ? "needs_input" : "active", error);
      if (!reconnectRequired) throw error;
    }
  }

  /**
   * Sends one written digest to a person's Avalon Agent DM.
   *
   * Unlike an automation result, a digest is not a work stream anybody should be
   * sent to — the run that wrote it lives in hidden machinery — so this posts the
   * text and nothing else. The identity is re-checked against a live
   * `slack_user_links` row rather than trusted from the frozen target: a person
   * who has since unlinked their Slack account must stop receiving DMs at once.
   */
  async deliverDigest(input: {
    workspaceId: string;
    userId: string;
    deliveryId: string;
    targetId: string;
    connectionId: string;
    slackUserId: string;
    title: string;
    markdown: string;
  }): Promise<void> {
    const rawConnection = await this.env.DB.prepare(
      `SELECT cc.*, cc.status AS connection_status
         FROM connector_connections cc
         JOIN slack_user_links link ON link.connection_id = cc.id
           AND link.workspace_id = cc.workspace_id AND link.user_id = ?
           AND link.slack_user_id = ? AND link.status = 'active'
        WHERE cc.id = ? AND cc.workspace_id = ?`,
    ).bind(input.userId, input.slackUserId, input.connectionId, input.workspaceId)
      .first<Record<string, unknown>>();
    if (!rawConnection) {
      throw new ApiError(422, "slack_digest_target_unavailable", "The Slack destination is no longer linked", {
        retryable: false,
      });
    }
    if (rawConnection.connection_status !== "healthy") {
      throw new ApiError(503, "slack_connection_unhealthy", "The Slack installation needs to be reconnected", {
        retryable: false,
      });
    }
    const token = await this.tokenFromEncrypted({ ...rawConnection, connection_id: input.connectionId });
    const opened = await slackApi(token, "conversations.open", { users: input.slackUserId }, AbortSignal.timeout(10_000));
    await postSlackTextChunks(
      token,
      opened.channel.id,
      `*${input.title}*\n${input.markdown}`,
      undefined,
      `digest:${input.targetId}:${input.deliveryId}`,
    );
  }

  private async markAutomationDelivery(target: Record<string, unknown>, status: "active" | "needs_input", error: unknown): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE automation_delivery_targets SET status = ?, last_error_json = ?, updated_at = ? WHERE id = ?`,
    ).bind(status, JSON.stringify({ code: "slack_delivery_failed", message: error instanceof Error ? error.message : "Slack delivery failed" }), nowIso(), target.id).run();
  }

  private async dispatchEvent(teamId: string, envelope: SlackIngressEnvelope, bodyHash: string): Promise<void> {
    const event = envelope.event!;
    const type = String(event.type ?? "");
    if (type === "avalon_public_channel_sync") {
      const connection = await this.connectionForTeam(teamId);
      let summary;
      try {
        // A cancellable deadline: this runs inside the activity queue consumer,
        // whose invocation ends when the batch handler returns. An uncancellable
        // three-minute timer would hold that invocation open for the remainder
        // after a sync that finished in seconds, and the runtime would cancel it
        // as a hang.
        const token = await this.botToken(connection);
        summary = await withDeadline(3 * 60_000, (signal) => joinAllSlackPublicChannels(token, signal));
      } catch (error) {
        if (!slackReconnectRequired(error)) throw error;
        await this.markSlackReconnectRequired(connection.id, slackErrorReason(error));
        return;
      }
      if (!summary.complete) {
        await this.schedulePublicChannelSync(connection.id, summary.retryAfterMs);
        logInfo(this.env, "slack_public_channel_sync_continued", {
          connection_id: connection.id,
          team_id: teamId,
          ...publicChannelSyncFields(summary),
        });
        return;
      }
      logInfo(this.env, "slack_public_channel_sync_completed", {
        connection_id: connection.id,
        team_id: teamId,
        ...publicChannelSyncFields(summary),
      });
      return;
    }
    const activityChannelResolution = await this.persistSlackEventActivity(teamId, envelope, bodyHash);
    if (type === "channel_created") {
      const channelId = asRecord(event.channel).id;
      if (typeof channelId !== "string" || !channelId) return;
      const connection = await this.connectionForTeam(teamId);
      let result;
      try {
        result = await joinSlackPublicChannel(
          await this.botToken(connection),
          channelId,
          AbortSignal.timeout(10_000),
        );
      } catch (error) {
        if (!slackReconnectRequired(error)) throw error;
        await this.markSlackReconnectRequired(connection.id, slackErrorReason(error));
        return;
      }
      if (result === "skipped") {
        // Slack refused the join for one of the allowlisted unjoinable reasons
        // — archived, restricted, too many members. That is the expected
        // outcome for those channels, and the bulk sync counts it under
        // `skipped` too, so it must not read as a failure to a view built on
        // the event name.
        logWarn(this.env, "slack_public_channel_join_skipped", {
          connection_id: connection.id,
          team_id: teamId,
          channel_id: channelId,
        });
      }
      return;
    }
    if (type === "app_home_opened") {
      const userId = String(event.user ?? "");
      if (userId && event.context) await this.storeSlackAppContext(teamId, userId, event.context);
      if (event.tab !== "home") return;
      const viewHash = typeof asRecord(event.view).hash === "string" ? String(asRecord(event.view).hash) : undefined;
      if (userId) await this.publishHome(teamId, userId, viewHash);
      return;
    }
    if (type === "app_context_changed") {
      const userId = String(event.user ?? "");
      if (userId) await this.storeSlackAppContext(teamId, userId, event.context);
      return;
    }
    if (type === "app_uninstalled") {
      const connection = await this.connectionForTeam(teamId);
      await this.env.DB.prepare(
        `UPDATE connector_connections SET status = 'needs_reconnect', updated_at = ?
         WHERE id = ? AND connector_type = 'slack' AND scope = 'workspace'`,
      ).bind(nowIso(), connection.id).run();
      await this.deactivateTeamRoute(connection);
      return;
    }
    if (type === "tokens_revoked") {
      const tokens = asRecord(event.tokens);
      const botUsers = Array.isArray(tokens.bot) ? tokens.bot.filter((value): value is string => typeof value === "string") : [];
      const oauthUsers = Array.isArray(tokens.oauth) ? tokens.oauth.filter((value): value is string => typeof value === "string") : [];
      if (botUsers.length) {
        const connection = await this.connectionForTeam(teamId);
        await this.env.DB.prepare(
          `UPDATE connector_connections SET status = 'needs_reconnect', updated_at = ?
           WHERE id = ? AND connector_type = 'slack' AND scope = 'workspace'`,
        ).bind(nowIso(), connection.id).run();
        await this.deactivateTeamRoute(connection);
      }
      for (const userId of oauthUsers) {
        await this.env.DB.prepare(
          `UPDATE connector_connections SET status = 'needs_reconnect', updated_at = ?
           WHERE connector_type = 'slack' AND scope = 'personal' AND provider_account_id = ?`,
        ).bind(nowIso(), `${teamId}:${userId}`).run();
      }
      return;
    }
    if (type === "link_shared") {
      await this.unfurlAvalonLinks(teamId, event);
      return;
    }
    if (type !== "message" && type !== "app_mention") return;
    if (event.bot_id
      || (event.subtype && event.subtype !== "thread_broadcast")
      || !event.user
      || !event.channel
      || !event.ts) return;
    const invocation = parseSlackAgentInvocation({ kind: "event", envelope });
    const slackUserId = String(event.user);
    if (event.app_context) await this.storeSlackAppContext(teamId, slackUserId, event.app_context);
    const channelId = String(event.channel);
    const rootTs = typeof event.thread_ts === "string" ? event.thread_ts : String(event.ts);
    const connection = await this.connectionForTeam(teamId);
    const token = await this.botToken(connection);
    const directMessage = type === "message" && isDirectSlackMessageEvent(event);
    const existingSession = !directMessage
      ? await this.loadSession(connection.id, channelId, rootTs)
      : null;
    const pendingPrompt = !directMessage && !existingSession
      ? await this.loadPendingPrompt(connection.id, channelId, rootTs, slackUserId)
      : null;
    const botUserId = type === "app_mention" || !directMessage
      ? authorizedBotUserId(envelope) ?? await this.botUserId(connection)
      : null;
    let prompt = (botUserId
      ? String(event.text ?? "").replaceAll(`<@${botUserId}>`, "")
      : String(event.text ?? "")).trim();
    if (!prompt) return;
    if (type === "message" && !directMessage && !existingSession && !pendingPrompt) return;
    if (type === "app_mention" && !existingSession && !pendingPrompt && isSlackRetryPrompt(prompt)) {
      const recovered = await this.recoverLegacyDeniedPrompt(
        token,
        connection,
        channelId,
        rootTs,
        slackUserId,
      );
      if (!recovered) {
        await slackApi(token, "chat.postMessage", {
          channel: channelId,
          thread_ts: rootTs,
          text: SLACK_RETRY_PROMPT_MISSING_TEXT,
        }, AbortSignal.timeout(5_000));
        return;
      }
      prompt = recovered;
    }
    if (/^(?:help|\/help)$/iu.test(prompt)) {
      await slackApi(token, "chat.postMessage", {
        channel: channelId,
        thread_ts: rootTs,
        text: "Ask Avalon to investigate, summarize, coordinate, or create an automation. Use /avalon anywhere, a shortcut on a message, or Start a task in App Home. Open App Home to connect your Avalon account and manage notifications.",
      }, AbortSignal.timeout(5_000));
      return;
    }
    const channelResolution = existingSession
      && (existingSession.channel_type === "public" || existingSession.channel_type === "private")
      ? { channelType: existingSession.channel_type, channelName: null, failure: null }
      : activityChannelResolution
        ?? await resolveSlackChannelType(this.env, token, channelId, event.channel_type);
    await this.startFromPrompt(
      teamId,
      slackUserId,
      channelId,
      rootTs,
      prompt,
      `event:${envelope.event_id}`,
      {
        kind: type === "app_mention" || !directMessage ? "app_mention" : "direct_message",
        channelType: channelResolution.channelType,
        channelResolutionFailure: channelResolution.failure,
        channelId,
        channelName: channelResolution.channelName,
        threadTs: rootTs,
        messageTs: String(event.ts),
        attachments: slackOriginAttachments(event),
      },
      slackEventSearchAuthorization(event),
      invocation,
    );
  }

  private async startFromPrompt(
    teamId: string,
    slackUserId: string,
    channelId: string | null,
    threadTs: string | null,
    prompt: string,
    clientMessageId: string,
    source: SlackPromptSource,
    slackSearchAuthorization?: SlackSearchAuthorization,
    activationInvocation?: SlackAgentInvocation,
  ): Promise<void> {
    const connection = await this.connectionForTeam(teamId);
    const token = await this.botToken(connection);
    const pendingPrompt = channelId && threadTs && isSlackRetryPrompt(prompt)
      ? await this.loadPendingPrompt(connection.id, channelId, threadTs, slackUserId)
      : null;
    const requestedPrompt = pendingPrompt?.prompt ?? prompt;
    if (connection.status !== "healthy") {
      const targetChannel = channelId ?? await this.openDm(token, slackUserId);
      if (threadTs) {
        await this.rememberPendingPrompt(
          connection.id,
          targetChannel,
          threadTs,
          slackUserId,
          requestedPrompt,
          "connection",
        );
      }
      await slackApi(token, "chat.postMessage", {
        channel: targetChannel,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        text: SLACK_CONNECTION_DENIAL_TEXT,
      }, AbortSignal.timeout(5_000));
      return;
    }
    const identity = await this.linkedIdentity(teamId, slackUserId);
    let actor: ExternalActor | null = null;
    let matchedWorkspaceUserId: string | null = identity?.auth.userId ?? null;
    let matchedVerification: ConnectorActorVerification | null = identity ? "account_link" : null;
    if (!identity) {
      if (source.channelResolutionFailure) {
        const targetChannel = channelId ?? await this.openDm(token, slackUserId);
        const resolutionDenial = slackChannelResolutionDenial(source.channelResolutionFailure);
        if (resolutionDenial.reconnectRequired) await this.markSlackReconnectRequired(connection.id);
        if (threadTs) {
          await this.rememberPendingPrompt(
            connection.id,
            targetChannel,
            threadTs,
            slackUserId,
            requestedPrompt,
            "channel_resolution",
          );
        }
        await slackApi(token, "chat.postMessage", {
          channel: targetChannel,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          text: resolutionDenial.text,
        }, AbortSignal.timeout(5_000));
        return;
      }
      const externalIdentity = await this.externalSlackActor(
        token,
        connection.workspace_id,
        teamId,
        slackUserId,
      );
      actor = externalIdentity.actor;
      matchedWorkspaceUserId = externalIdentity.matchedWorkspaceUserId;
      matchedVerification = externalIdentity.matchedVerification;
    }
    if (activationInvocation) {
      const adapter = connectorRegistryForEnv(this.env).get("slack").messagingAgent;
      if (!adapter) throw new ApiError(500, "slack_agent_adapter_missing", "Slack Agent is not configured");
      const activationConnection: ConnectorConnectionContext = {
        id: connection.id,
        workspaceId: connection.workspace_id,
        scope: "workspace",
        ownerUserId: null,
        grantedScopes: parseGrantedScopes(connection.granted_scopes_json),
        credentials: { botAccessToken: token },
        cursor: {},
        config: {},
      };
      try {
        await acknowledgeConnectorAgentActivation(adapter, activationInvocation, {
          connection: activationConnection,
          signal: AbortSignal.timeout(5_000),
        });
      } catch (error) {
        // The host contract and capability checks remain fail-closed. Once the
        // provider call begins, however, a supplemental reaction must not drop
        // a durably accepted user request.
        if (!(error instanceof ConnectorError)
          || (error.code !== "provider_error" && error.code !== "unauthorized")) {
          throw error;
        }
        if (slackReconnectRequired(error)) {
          await this.markSlackReconnectRequired(connection.id, slackErrorReason(error));
        }
        logWarn(this.env, "slack_activation_ack_failed", {
          connection_id: connection.id,
          team_id: teamId,
          event_id: activationInvocation.kind === "event" ? activationInvocation.eventId : null,
          reason: slackErrorReason(error),
        });
      }
    }
    const slackOrigin = await this.slackOriginContext(
      connection.id,
      teamId,
      slackUserId,
      source,
      matchedWorkspaceUserId,
    );
    const channel = channelId ?? await this.openDm(token, slackUserId);
    const thread = threadTs ?? await this.createUserPromptRoot(token, channel, requestedPrompt);
    const openingClientMessageId = clientMessageId.slice(0, 120);
    let session = await this.loadSession(connection.id, channel, thread);
    if (session?.opening_client_message_id === openingClientMessageId) return;
    await slackApi(token, "assistant.threads.setStatus", {
      channel_id: channel,
      thread_ts: thread,
      status: "Working…",
    }, AbortSignal.timeout(5_000));
    let sessionCreatedThisCall = false;
    if (!session) {
      const claimId = await this.claimThread(connection.id, channel, thread);
      if (!claimId) {
        session = await this.waitForSession(connection.id, channel, thread);
        if (!session) throw new ApiError(503, "slack_thread_busy", "This Slack thread is still being initialized");
      } else {
        try {
          session = await this.loadSession(connection.id, channel, thread);
          if (!session) {
            session = await this.createSlackWorkstreamSession({
              connection,
              identity,
              actor,
              matchedWorkspaceUserId,
              matchedVerification,
              teamId,
              slackUserId,
              channel,
              thread,
              prompt: requestedPrompt,
              clientMessageId,
              source,
              slackOrigin,
              ...(slackSearchAuthorization ? { slackSearchAuthorization } : {}),
            });
            sessionCreatedThisCall = true;
            try {
              await slackApi(token, "assistant.threads.setTitle", {
                channel_id: channel,
                thread_ts: thread,
                title: requestedPrompt,
              }, AbortSignal.timeout(5_000));
            } catch (error) {
              logWarn(this.env, "slack_thread_title_failed", {
                session_id: session.id,
                reason: error instanceof Error ? error.message : "unknown",
              });
            }
          }
        } finally {
          await this.releaseThreadClaim(connection.id, channel, thread, claimId);
        }
      }
    }
    if (session) {
      await this.clearPendingPrompt(connection.id, channel, thread, slackUserId);
    }
    if (session && session.workstream_id) {
      const justCreated = session.opening_client_message_id === openingClientMessageId;
      if (justCreated && !sessionCreatedThisCall) return;
      const openElicitation = justCreated
        ? null
        : await this.openElicitationTarget(session.workstream_id);
      if (!justCreated) {
        if (openElicitation?.targetUserId
          && openElicitation.targetUserId !== identity?.auth.userId) {
          if (!identity) await this.sendPrivateClaimLink(connection, slackUserId, token);
          await slackApi(token, "chat.postMessage", {
            channel,
            thread_ts: thread,
            text: identity
              ? "This question is targeted to another Avalon workspace member, so only that member can answer it."
              : "This question is targeted to a specific Avalon workspace member. Only that linked member can answer it; I sent you a private link in case that member is you.",
          }, AbortSignal.timeout(5_000));
          return;
        }
      }
      if (!justCreated && session.execution_scope === "workspace") {
        if (openElicitation?.targetUserId) {
          await slackApi(token, "chat.postMessage", {
            channel,
            thread_ts: thread,
            text: identity
              ? "This question requires the targeted Avalon member’s personal authority. Use the claim button before replying."
              : "This question requires the targeted Avalon member’s personal authority. Connect your Avalon account, then use the claim button before replying.",
            blocks: workspaceClaimBlocks(session.id, identity === null),
          }, AbortSignal.timeout(5_000));
          if (!identity) await this.sendPrivateClaimLink(connection, slackUserId, token);
          return;
        }
        const externalIdentity = actor
          ? { actor }
          : await this.externalSlackActor(token, connection.workspace_id, teamId, slackUserId);
        const workspaceService = new SlackWorkspaceWorkstreamService(this.env, connection.workspace_id);
        const externalInput = {
          actor: externalIdentity.actor,
          text: requestedPrompt,
          clientMessageId: clientMessageId.slice(0, 120),
          slackOrigin,
          ...(slackSearchAuthorization ? { slackSearchAuthorization } : {}),
        };
        if (!await workspaceService.answerOpenElicitation(session.workstream_id, externalInput)) {
          await workspaceService.createMessage(session.workstream_id, externalInput);
        }
      } else if (!justCreated && identity) {
        if (session.execution_scope === "user" && session.linked_user_id !== identity.auth.userId) {
          await slackApi(token, "chat.postMessage", {
            channel,
            thread_ts: thread,
            text: "This thread is already running with another Avalon member’s personal authority. Start a new Avalon task to keep identities and connected accounts separate.",
          }, AbortSignal.timeout(5_000));
          return;
        }
        const service = new WorkstreamService(this.env, identity.auth);
        if (!await this.answerOpenElicitationAsUser(
          service,
          session.workstream_id,
          requestedPrompt,
          clientMessageId.slice(0, 120),
          slackOrigin,
          slackSearchAuthorization,
        )) {
          await service.createMessage(session.workstream_id, {
            text: requestedPrompt,
            clientMessageId: clientMessageId.slice(0, 120),
            mentions: [],
            confirmedParticipantUserIds: [],
            attachmentIds: [],
          }, slackOrigin, slackSearchAuthorization);
        }
      } else if (!justCreated) {
        if (session.execution_scope !== "workspace") {
          await slackApi(token, "chat.postMessage", {
            channel,
            thread_ts: thread,
            text: "This thread uses a connected Avalon member’s personal authority, so an unlinked Slack member cannot continue it. Start a new Avalon task or connect in App Home.",
          }, AbortSignal.timeout(5_000));
          return;
        }
        throw new ApiError(500, "slack_workspace_actor_missing", "The Slack workspace actor is missing");
      }
    }
    if (session && !session.slack_stream_ts) {
      try {
        const started = await slackApi(token, "chat.startStream", {
          channel,
          thread_ts: thread,
          markdown_text: "",
          recipient_user_id: slackUserId,
          recipient_team_id: teamId,
          task_display_mode: "plan",
        }, AbortSignal.timeout(5_000));
        if (typeof started.ts === "string") {
          await this.env.DB.prepare(
            "UPDATE slack_agent_sessions SET slack_stream_ts = ?, updated_at = ? WHERE id = ?",
          ).bind(started.ts, nowIso(), session.id).run();
        }
      } catch {
        // A final ordinary thread reply is the compatibility fallback.
      }
    }
  }

  private async createSlackWorkstreamSession(input: {
    connection: SlackConnectionRow;
    identity: SlackIdentity | null;
    actor: ExternalActor | null;
    matchedWorkspaceUserId: string | null;
    matchedVerification: ConnectorActorVerification | null;
    teamId: string;
    slackUserId: string;
    channel: string;
    thread: string;
    prompt: string;
    clientMessageId: string;
    source: SlackPromptSource;
    slackOrigin: SlackOriginContext;
    slackSearchAuthorization?: SlackSearchAuthorization;
  }): Promise<SlackSessionRow> {
    // Neither branch passes a title. Both derive the same provisional one from
    // the objective, and leaving it to them is what lets the naming agent
    // replace it — a title supplied here would read as a deliberate choice.
    const created = input.identity
      ? await new WorkstreamService(this.env, input.identity.auth).create({
          objective: input.prompt.slice(0, 4_000),
          participantUserIds: [],
          openingMessage: input.prompt,
          clientMessageId: input.clientMessageId.slice(0, 120),
          attachmentIds: [],
        }, input.slackOrigin, input.slackSearchAuthorization)
      : await new SlackWorkspaceWorkstreamService(this.env, input.connection.workspace_id).create({
          actor: ExternalActorSchema.parse(input.actor),
          objective: input.prompt.slice(0, 4_000),
          text: input.prompt,
          clientMessageId: input.clientMessageId.slice(0, 120),
          // The Slack member is not a linked Avalon identity, but when the
          // installation resolves them to a workspace member the work stream
          // is theirs rather than ownerless.
          creatorUserId: input.matchedWorkspaceUserId,
          slackOrigin: input.slackOrigin,
          ...(input.slackSearchAuthorization
            ? { slackSearchAuthorization: input.slackSearchAuthorization }
            : {}),
        });
    const id = newId();
    const at = nowIso();
    await this.env.DB.prepare(
      `INSERT INTO slack_agent_sessions
       (id, workspace_id, connection_id, linked_user_id, execution_scope,
        slack_team_id, slack_user_id, slack_channel_id, slack_thread_ts,
        opening_client_message_id, workstream_id, invocation_kind, channel_type,
        assigned_user_id, assigned_at, assignment_method,
        claimed_by_slack_user_id, claimed_at, context_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      input.connection.workspace_id,
      input.connection.id,
      input.identity?.auth.userId ?? null,
      input.identity ? "user" : "workspace",
      input.teamId,
      input.slackUserId,
      input.channel,
      input.thread,
      input.clientMessageId.slice(0, 120),
      created.workstream.id,
      input.source.kind,
      input.source.channelType,
      input.identity?.auth.userId ?? null,
      input.identity ? at : null,
      input.identity ? "explicit_link" : null,
      input.identity ? input.slackUserId : null,
      input.identity ? at : null,
      JSON.stringify({
        source: input.source,
        externalActor: input.actor,
        slackOrigin: input.slackOrigin,
      }),
      at,
      at,
    ).run();
    if (!input.identity && input.matchedWorkspaceUserId) {
      // The recorded method has to name the mapping that actually resolved the
      // member: it is what a later assignment consults before overwriting.
      await this.assignWorkspaceSessions(
        input.connection.id,
        input.teamId,
        input.slackUserId,
        input.matchedWorkspaceUserId,
        input.matchedVerification === "verified_email" ? "verified_email" : "explicit_link",
      );
    }
    const session = await this.env.DB.prepare(
      "SELECT * FROM slack_agent_sessions WHERE id = ?",
    ).bind(id).first<SlackSessionRow>();
    if (!session) throw new ApiError(500, "slack_session_write_failed", "The Slack task session could not be stored");
    return session;
  }

  private async loadSession(
    connectionId: string,
    channelId: string,
    threadTs: string,
  ): Promise<SlackSessionRow | null> {
    return this.env.DB.prepare(
      `SELECT * FROM slack_agent_sessions
       WHERE connection_id = ? AND slack_channel_id = ? AND slack_thread_ts = ?`,
    ).bind(connectionId, channelId, threadTs).first<SlackSessionRow>();
  }

  private async shouldEnqueueSlackMessage(
    teamId: string,
    event: Record<string, unknown>,
    authorizedBotId: string | null,
    activityEventType: string | null,
  ): Promise<boolean> {
    const subtype = typeof event.subtype === "string" ? event.subtype : null;
    const changedMessage = asRecord(event.message);
    const previousMessage = asRecord(event.previous_message);
    const hasMessageTimestamp = Boolean(
      event.ts || event.deleted_ts || changedMessage.ts || previousMessage.ts,
    );
    if (event.bot_id
      || changedMessage.bot_id
      || previousMessage.bot_id
      || (subtype && subtype !== "thread_broadcast" && subtype !== "message_changed" && subtype !== "message_deleted")
      || !event.channel
      || !hasMessageTimestamp) return false;
    const lifecycleMessage = subtype === "message_changed" || subtype === "message_deleted";
    if (!lifecycleMessage && !event.user) return false;
    if (!lifecycleMessage && isDirectSlackMessageEvent(event)) return true;
    const connection = await this.connectionForTeam(teamId);
    const activitySubscribed = activityEventType
      ? await this.hasSubscribedSlackActivity(connection, activityEventType)
      : false;
    if (lifecycleMessage) return activitySubscribed;
    if (typeof event.thread_ts !== "string" || !event.thread_ts) return activitySubscribed;
    const channelId = String(event.channel);
    const threadTs = event.thread_ts;
    const slackUserId = String(event.user);
    const text = String(event.text ?? "");
    if (text.includes("<@")) {
      const botUserId = authorizedBotId ?? await this.botUserId(connection);
      if (botUserId && text.includes(`<@${botUserId}>`)) return false;
    }
    const routable = await this.env.DB.prepare(
      `SELECT 1 AS routable
       WHERE EXISTS (
         SELECT 1 FROM slack_agent_sessions
         WHERE connection_id = ? AND slack_channel_id = ? AND slack_thread_ts = ?
       ) OR EXISTS (
         SELECT 1 FROM slack_agent_pending_prompts
         WHERE connection_id = ? AND slack_channel_id = ? AND slack_thread_ts = ?
           AND slack_user_id = ? AND expires_at > ?
       )`,
    ).bind(
      connection.id,
      channelId,
      threadTs,
      connection.id,
      channelId,
      threadTs,
      slackUserId,
      nowIso(),
    ).first<{ routable: number }>();
    return Boolean(routable) || activitySubscribed;
  }

  private async persistSlackEventActivity(
    teamId: string,
    envelope: SlackIngressEnvelope,
    bodyHash: string,
  ): Promise<Awaited<ReturnType<typeof resolveSlackChannelType>> | null> {
    if (!slackActivityEventType(envelope)) return null;
    const event = envelope.event ?? {};
    const connection = await this.connectionForTeam(teamId);
    const botUserId = authorizedBotUserId(envelope) ?? await this.botUserId(connection);
    if (botUserId && slackEventActorUserIds(event).includes(botUserId)) return null;
    const context: ConnectorConnectionContext = {
      id: connection.id,
      workspaceId: connection.workspace_id,
      scope: "workspace",
      ownerUserId: null,
      grantedScopes: parseGrantedScopes(connection.granted_scopes_json),
      credentials: {},
      cursor: {},
      config: { region: this.env.AVALON_REGION, teamId },
    };
    const normalized = normalizeSlackActivity(context, envelope, null);
    if (!normalized) return null;
    const activitySubscribed = await this.hasSubscribedSlackActivity(connection, normalized.eventType);
    if (!activitySubscribed) return null;

    const channelId = typeof normalized.metadata.channelId === "string"
      ? normalized.metadata.channelId
      : null;
    const channelObject = asRecord(event.channel);
    const channelHint = channelObject.is_private === true
      ? "private"
      : channelObject.is_private === false
        ? "public"
        : event.type === "channel_created"
          ? "public"
          : event.channel_type ?? asRecord(event.item).channel_type;
    const rootTs = typeof event.thread_ts === "string"
      ? event.thread_ts
      : typeof event.ts === "string"
        ? event.ts
        : null;
    const existingSession = channelId && rootTs && (event.type === "message" || event.type === "app_mention")
      ? await this.loadSession(connection.id, channelId, rootTs)
      : null;
    const channelResolution = existingSession
      && (existingSession.channel_type === "public" || existingSession.channel_type === "private")
      ? { channelType: existingSession.channel_type, channelName: null, failure: null }
      : channelId
      ? event.type === "channel_created"
        ? {
            channelType: "public" as const,
            channelName: typeof normalized.metadata.channelName === "string"
              ? normalized.metadata.channelName
              : null,
            failure: null,
          }
        : await resolveSlackChannelType(this.env, await this.botToken(connection), channelId, channelHint)
      : { channelType: "unknown" as const, channelName: null, failure: null };
    const workspaceAutomationAllowed = channelResolution.channelType === "public";
    const allowedUserIds = workspaceAutomationAllowed
      ? []
      : await this.linkedAvalonUsersForSlackPeople(
          connection,
          normalized.externalPeople?.flatMap((person) => person.providerUserId ? [person.providerUserId] : []) ?? [],
        );
    if (!workspaceAutomationAllowed && allowedUserIds.length === 0) return channelResolution;

    await persistNormalizedActivity(this.env, {
      ...normalized,
      rawContentHash: bodyHash,
      visibility: {
        ...normalized.visibility,
        channelType: channelResolution.channelType,
        workspaceAutomationAllowed,
        ...(allowedUserIds.length > 0 ? { allowedUserIds } : {}),
      },
      targetUserIds: allowedUserIds,
      metadata: {
        ...normalized.metadata,
        channelType: channelResolution.channelType,
        ...(channelResolution.channelName ? { channelName: channelResolution.channelName } : {}),
      },
    });
    return channelResolution;
  }

  private async linkedAvalonUsersForSlackPeople(
    connection: SlackConnectionRow,
    slackUserIds: string[],
  ): Promise<string[]> {
    const uniqueIds = [...new Set(slackUserIds.filter(Boolean))];
    if (uniqueIds.length === 0) return [];
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const linked = await this.env.DB.prepare(
      `SELECT DISTINCT l.user_id
       FROM slack_user_links l
       JOIN workspace_members wm
         ON wm.workspace_id = l.workspace_id AND wm.user_id = l.user_id
       WHERE l.connection_id = ? AND l.status = 'active' AND wm.status = 'active'
         AND l.slack_user_id IN (${placeholders})`,
    ).bind(connection.id, ...uniqueIds).all<{ user_id: string }>();
    return linked.results.map((row) => row.user_id);
  }

  private async hasSubscribedSlackActivity(
    connection: SlackConnectionRow,
    eventType: string,
  ): Promise<boolean> {
    const subscriptions = await this.env.DB.prepare(
      `SELECT s.connector_bindings_json, s.activity_trigger_bindings_json,
              v.trigger_definitions_json
       FROM automation_subscriptions s
       JOIN automation_template_versions v ON v.id = s.template_version_id
       WHERE s.workspace_id = ? AND s.status = 'active' AND s.lifecycle_state = 'visible'
         AND EXISTS (
           SELECT 1 FROM json_each(s.connector_bindings_json)
           WHERE json_each.value = ?
         )`,
    ).bind(connection.workspace_id, connection.id).all<{
      connector_bindings_json: string;
      activity_trigger_bindings_json: string;
      trigger_definitions_json: string;
    }>();
    return subscriptions.results.some((subscription) => {
      const parsed = z.array(TriggerDefinitionSchema).safeParse(parseSlackJson(subscription.trigger_definitions_json, []));
      if (!parsed.success) return false;
      const connectorBindings = parseSlackJson<Record<string, string>>(subscription.connector_bindings_json, {});
      const sourceBindings = parseSlackJson<Record<string, string>>(subscription.activity_trigger_bindings_json, {});
      return parsed.data.some((trigger) => {
        if (trigger.type !== "connector_activity" && trigger.type !== "semantic_activity") return false;
        if (trigger.connectorType !== "slack") return false;
        if (trigger.sourceBindingKey) {
          const pluginId = sourceBindings[trigger.sourceBindingKey];
          if (!pluginId || connectorBindings[pluginId] !== connection.id) return false;
        } else if (!Object.values(connectorBindings).includes(connection.id)) {
          return false;
        }
        if (trigger.type === "connector_activity") return trigger.eventTypes.includes(eventType);
        const prefilterEventType = trigger.deterministicPrefilter.eventType;
        return typeof prefilterEventType === "string" && prefilterEventType === eventType;
      });
    });
  }

  private async loadPendingPrompt(
    connectionId: string,
    channelId: string,
    threadTs: string,
    slackUserId: string,
  ): Promise<{ prompt: string } | null> {
    return this.env.DB.prepare(
      `SELECT prompt FROM slack_agent_pending_prompts
       WHERE connection_id = ? AND slack_channel_id = ? AND slack_thread_ts = ?
         AND slack_user_id = ? AND expires_at > ?`,
    ).bind(connectionId, channelId, threadTs, slackUserId, nowIso()).first<{ prompt: string }>();
  }

  private async rememberPendingPrompt(
    connectionId: string,
    channelId: string,
    threadTs: string,
    slackUserId: string,
    prompt: string,
    denialReason: SlackPendingDenialReason,
  ): Promise<void> {
    const retainedPrompt = prompt.trim().slice(0, 40_000);
    if (!retainedPrompt) return;
    const at = nowIso();
    await this.env.DB.prepare(
      `INSERT INTO slack_agent_pending_prompts
       (connection_id, slack_channel_id, slack_thread_ts, slack_user_id, prompt,
        denial_reason, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(connection_id, slack_channel_id, slack_thread_ts, slack_user_id)
       DO UPDATE SET prompt = excluded.prompt, denial_reason = excluded.denial_reason,
         expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
    ).bind(
      connectionId,
      channelId,
      threadTs,
      slackUserId,
      retainedPrompt,
      denialReason,
      new Date(Date.now() + SLACK_PENDING_PROMPT_TTL_MS).toISOString(),
      at,
      at,
    ).run();
  }

  private async clearPendingPrompt(
    connectionId: string,
    channelId: string,
    threadTs: string,
    slackUserId: string,
  ): Promise<void> {
    await this.env.DB.prepare(
      `DELETE FROM slack_agent_pending_prompts
       WHERE connection_id = ? AND slack_channel_id = ? AND slack_thread_ts = ?
         AND slack_user_id = ?`,
    ).bind(connectionId, channelId, threadTs, slackUserId).run();
  }

  private async recoverLegacyDeniedPrompt(
    token: string,
    connection: SlackConnectionRow,
    channelId: string,
    threadTs: string,
    slackUserId: string,
  ): Promise<string | null> {
    const botUserId = await this.botUserId(connection);
    if (!botUserId) return null;
    const result = await slackApi(token, "conversations.replies", {
      channel: channelId,
      ts: threadTs,
      limit: 15,
    }, AbortSignal.timeout(8_000));
    return recoverSlackDeniedPrompt(result.messages, slackUserId, botUserId);
  }

  private async answerOpenElicitationAsUser(
    service: WorkstreamService,
    workstreamId: string,
    response: string,
    clientMessageId: string,
    slackOrigin: SlackOriginContext,
    slackSearchAuthorization?: SlackSearchAuthorization,
  ): Promise<boolean> {
    const elicitation = await this.env.DB.prepare(
      `SELECT id, response_type, options_json FROM elicitations
       WHERE workstream_id = ? AND status = 'open' ORDER BY created_at ASC LIMIT 1`,
    ).bind(workstreamId).first<{
      id: string;
      response_type: "text" | "radio" | "single_select" | "multi_select";
      options_json: string;
    }>();
    if (!elicitation) return false;
    await service.answerElicitation(
      workstreamId,
      elicitation.id,
      slackElicitationRequest(elicitation, response),
      clientMessageId,
      slackOrigin,
      slackSearchAuthorization,
    );
    return true;
  }

  private async handleWorkspaceClaim(
    teamId: string,
    slackUserId: string,
    sessionId: string,
  ): Promise<void> {
    const connection = await this.connectionForTeam(teamId);
    const token = await this.botToken(connection);
    const session = await this.env.DB.prepare(
      `SELECT * FROM slack_agent_sessions
       WHERE id = ? AND connection_id = ? AND workspace_id = ? AND slack_team_id = ?`,
    ).bind(sessionId, connection.id, connection.workspace_id, teamId).first<SlackSessionRow>();
    if (!session) throw new ApiError(404, "slack_session_not_found", "This Slack task is no longer available");
    const identity = await this.linkedIdentity(teamId, slackUserId);
    if (!identity) {
      await this.sendPrivateClaimLink(connection, slackUserId, token);
      return;
    }
    let status: "claimed" | "already_claimed";
    try {
      status = await claimWorkspaceSession(this.env, identity, session);
    } catch (error) {
      if (!(error instanceof ApiError)
        || (error.code !== "slack_claim_target_mismatch" && error.code !== "slack_claim_conflict")) {
        throw error;
      }
      await slackApi(token, "chat.postMessage", {
        channel: session.slack_channel_id,
        thread_ts: session.slack_thread_ts,
        client_msg_id: await stableUuid(`${session.id}:${identity.auth.userId}:claim-denied`),
        text: error.code === "slack_claim_target_mismatch"
          ? "This question is targeted to another Avalon workspace member, so only that member can claim it."
          : "Another Avalon member already claimed this task.",
      }, AbortSignal.timeout(5_000));
      return;
    }
    await slackApi(token, "chat.postMessage", {
      channel: session.slack_channel_id,
      thread_ts: session.slack_thread_ts,
      client_msg_id: await stableUuid(`${session.id}:${identity.auth.userId}:claimed`),
      text: status === "claimed"
        ? "This task is now using your Avalon authority for future work. Reply with the requested input to continue."
        : "You already claimed this task. Reply with the requested input to continue.",
    }, AbortSignal.timeout(5_000));
  }

  private async openElicitationTarget(
    workstreamId: string,
  ): Promise<{ id: string; targetUserId: string | null } | null> {
    const row = await this.env.DB.prepare(
      `SELECT id, target_user_id FROM elicitations
       WHERE workstream_id = ? AND status = 'open' ORDER BY created_at ASC LIMIT 1`,
    ).bind(workstreamId).first<{ id: string; target_user_id: string | null }>();
    return row ? { id: row.id, targetUserId: row.target_user_id } : null;
  }

  private async sendPrivateClaimLink(
    connection: SlackConnectionRow,
    slackUserId: string,
    token: string,
  ): Promise<void> {
    const link = await this.createLink(connection, slackUserId);
    await slackApi(token, "chat.postMessage", {
      channel: await this.openDm(token, slackUserId),
      text: `Connect your Avalon account to claim this workspace-owned task: ${link}`,
    }, AbortSignal.timeout(5_000));
  }

  private async markSlackReconnectRequired(connectionId: string, reason = "missing_scope"): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE connector_connections
       SET status = 'needs_reconnect', error_json = ?, updated_at = ?
       WHERE id = ? AND connector_type = 'slack' AND scope = 'workspace' AND status <> 'disabled'`,
    ).bind(JSON.stringify({
      code: "slack_bot_scope_missing",
      message: `Slack workspace authorization needs reconnect (${reason})`,
      reconnectRequired: true,
    }), nowIso(), connectionId).run();
  }

  private async externalSlackActor(
    token: string,
    workspaceId: string,
    teamId: string,
    slackUserId: string,
  ): Promise<{
    actor: ExternalActor;
    matchedWorkspaceUserId: string | null;
    matchedVerification: ConnectorActorVerification | null;
  }> {
    const result = await slackApi(token, "users.info", { user: slackUserId }, AbortSignal.timeout(10_000));
    if (!validSlackHuman(result.user, teamId) || result.user.id !== slackUserId) {
      throw new ApiError(403, "slack_actor_invalid", "Slack did not return an active human workspace member");
    }
    const profile = result.user.profile;
    const actor = ExternalActorSchema.parse({
      provider: "slack",
      providerAccountId: teamId,
      providerUserId: slackUserId,
      displayName: slackHumanDisplayName(result.user),
      avatarUrl: profile?.image_192 ?? profile?.image_72 ?? null,
    });
    // The shared connector mapping, not a Slack-only lookup: an account link,
    // this member's own personal Slack connection, or their verified email.
    const identity = await resolveConnectorActorIdentity(this.env, workspaceId, actor, profile?.email ?? null);
    if (identity) {
      await recordConnectorActorIdentity(this.env, workspaceId, actor, identity, profile?.email ?? null);
    }
    return {
      actor,
      matchedWorkspaceUserId: identity?.userId ?? null,
      matchedVerification: identity?.verification ?? null,
    };
  }

  private async slackOriginContext(
    connectionId: string,
    teamId: string,
    slackUserId: string,
    source: SlackPromptSource,
    matchedAvalonUserId: string | null,
  ): Promise<SlackOriginContext> {
    // Slack Agent policy prohibits durable storage of provider content
    // obtained for surrounding context. Persist only origin metadata; Slack
    // content can be fetched by authorized tools for the active run.
    const storedContext = await this.env.DB.prepare(
      `SELECT context_json FROM slack_agent_contexts
       WHERE connection_id = ? AND slack_user_id = ?`,
    ).bind(connectionId, slackUserId).first<{ context_json: string }>();
    return SlackOriginContextSchema.parse({
      teamId,
      channelId: source.channelId,
      channelName: source.channelName,
      threadTs: source.threadTs,
      invocationType: source.kind,
      channelType: source.channelType,
      matchedAvalonUserId,
      nearbyMessagesStatus: "not_applicable",
      nearbyMessages: [],
      attachments: source.attachments,
      appContext: storedContext ? parseStoredSlackAppContext(storedContext.context_json) : null,
    });
  }

  private async storeSlackAppContext(teamId: string, slackUserId: string, value: unknown): Promise<void> {
    const context = slackAppContext(value);
    const connection = await this.connectionForTeam(teamId);
    await this.env.DB.prepare(
      `INSERT INTO slack_agent_contexts (connection_id, slack_user_id, context_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(connection_id, slack_user_id)
       DO UPDATE SET context_json = excluded.context_json, updated_at = excluded.updated_at`,
    ).bind(connection.id, slackUserId, JSON.stringify(context), nowIso()).run();
  }

  private async nearbySlackMessages(
    token: string,
    source: SlackPromptSource,
  ): Promise<{
    status: SlackOriginContext["nearbyMessagesStatus"];
    messages: SlackOriginNearbyMessage[];
  }> {
    if (!source.channelId || !source.messageTs) {
      return { status: "not_applicable", messages: [] };
    }
    try {
      const result = source.threadTs && source.threadTs !== source.messageTs
        ? await slackApi(token, "conversations.replies", {
            channel: source.channelId,
            ts: source.threadTs,
            latest: source.messageTs,
            inclusive: false,
            limit: 8,
          }, AbortSignal.timeout(5_000))
        : await slackApi(token, "conversations.history", {
            channel: source.channelId,
            latest: source.messageTs,
            inclusive: false,
            limit: 8,
          }, AbortSignal.timeout(5_000));
      const messages = result.messages
        .filter((message) => message.ts !== source.messageTs)
        .map(slackOriginNearbyMessage)
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
        .slice(-8);
      return { status: "available", messages };
    } catch (error) {
      logWarn(this.env, "slack_nearby_context_lookup_failed", {
        channel_id: source.channelId,
        thread_ts: source.threadTs,
        reason: slackErrorReason(error),
      });
      return { status: "unavailable", messages: [] };
    }
  }

  private async claimThread(connectionId: string, channelId: string, threadTs: string): Promise<string | null> {
    const leaseId = crypto.randomUUID();
    const at = nowIso();
    const claimed = await this.env.DB.prepare(
      `INSERT INTO slack_agent_thread_claims
       (connection_id, slack_channel_id, slack_thread_ts, lease_id, lease_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(connection_id, slack_channel_id, slack_thread_ts) DO UPDATE SET
         lease_id = excluded.lease_id,
         lease_expires_at = excluded.lease_expires_at,
         updated_at = excluded.updated_at
       WHERE slack_agent_thread_claims.lease_expires_at < ?
       RETURNING lease_id`,
    ).bind(connectionId, channelId, threadTs, leaseId, new Date(Date.now() + 5 * 60_000).toISOString(), at, at, at)
      .first<{ lease_id: string }>();
    return claimed?.lease_id === leaseId ? leaseId : null;
  }

  private async waitForSession(connectionId: string, channelId: string, threadTs: string): Promise<SlackSessionRow | null> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const session = await this.env.DB.prepare(
        `SELECT * FROM slack_agent_sessions WHERE connection_id = ? AND slack_channel_id = ? AND slack_thread_ts = ?`,
      ).bind(connectionId, channelId, threadTs).first<SlackSessionRow>();
      if (session) return session;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  private async releaseThreadClaim(connectionId: string, channelId: string, threadTs: string, leaseId: string): Promise<void> {
    await this.env.DB.prepare(
      `DELETE FROM slack_agent_thread_claims
       WHERE connection_id = ? AND slack_channel_id = ? AND slack_thread_ts = ? AND lease_id = ?`,
    ).bind(connectionId, channelId, threadTs, leaseId).run();
  }

  private async publishHome(teamId: string, slackUserId: string, viewHash?: string): Promise<void> {
    const connection = await this.connectionForTeam(teamId);
    const token = await this.botToken(connection);
    const link = await this.env.DB.prepare(
      `SELECT l.user_id, u.name, u.timezone, wm.role
       FROM slack_user_links l
       JOIN users u ON u.id = l.user_id
       JOIN workspace_members wm ON wm.workspace_id = l.workspace_id AND wm.user_id = l.user_id
       WHERE l.connection_id = ? AND l.slack_user_id = ? AND l.status = 'active' AND wm.status = 'active'`,
    ).bind(connection.id, slackUserId).first<{ user_id: string; name: string; timezone: string; role: string }>();
    let blocks: Record<string, unknown>[];
    if (!link) {
      const url = await this.createLink(connection, slackUserId);
      blocks = unlinkedHome(url);
    } else {
      const [tasks, automations, personalSlack] = await Promise.all([
        this.env.DB.prepare(
          // `system_kind` is machinery — a digest run's transcript, say. The
          // owner participates in it, so the join alone would list it here, and
          // Slack has no equivalent of the desktop's Debug enabled to hide it.
          `SELECT w.id, w.title, w.harness_status FROM workstreams w
           JOIN workstream_participants p ON p.workstream_id = w.id
           WHERE w.workspace_id = ? AND p.user_id = ? AND p.removed_at IS NULL
             AND w.archived_at IS NULL AND w.system_kind IS NULL
           ORDER BY CASE w.harness_status WHEN 'needs_input' THEN 0 WHEN 'running' THEN 1 ELSE 2 END,
             w.last_activity_at DESC LIMIT 6`,
        ).bind(connection.workspace_id, link.user_id).all<Record<string, unknown>>(),
        this.env.DB.prepare(
          `SELECT s.id, t.name, s.status, s.next_run_at FROM automation_subscriptions s
           JOIN automation_templates t ON t.id = s.template_id
           WHERE s.workspace_id = ? AND s.owner_user_id = ? AND s.lifecycle_state = 'visible'
           ORDER BY s.updated_at DESC LIMIT 5`,
        ).bind(connection.workspace_id, link.user_id).all<Record<string, unknown>>(),
        this.env.DB.prepare(
          `SELECT display_name, status FROM connector_connections
           WHERE workspace_id = ? AND connector_type = 'slack' AND scope = 'personal'
             AND owner_user_id = ? AND provider_account_id LIKE ? AND status <> 'disabled'
           ORDER BY updated_at DESC LIMIT 1`,
        ).bind(connection.workspace_id, link.user_id, `${teamId}:%`).first<{ display_name: string; status: string }>(),
      ]);
      blocks = linkedHome(
        this.env,
        link.name,
        tasks.results ?? [],
        automations.results ?? [],
        this.env.PUBLIC_WEB_BASE_URL,
        personalSlack,
        link.role === "owner" || link.role === "admin" ? { teamId, status: connection.status } : null,
      );
    }
    try {
      await slackApi(token, "views.publish", { user_id: slackUserId, view: { type: "home", blocks }, ...(viewHash ? { hash: viewHash } : {}) }, AbortSignal.timeout(10_000));
    } catch (error) {
      if (viewHash && error instanceof ConnectorError && error.message === "hash_conflict") return;
      throw error;
    }
  }

  private async unfurlAvalonLinks(teamId: string, event: Record<string, unknown>): Promise<void> {
    const channel = typeof event.channel === "string" ? event.channel : null;
    const ts = typeof event.message_ts === "string" ? event.message_ts : null;
    const links = Array.isArray(event.links) ? event.links.filter((link): link is Record<string, unknown> => Boolean(link) && typeof link === "object") : [];
    if (!channel || !ts || links.length === 0) return;
    const connection = await this.connectionForTeam(teamId);
    const linkedWorkstreams = new Map<string, string>();
    for (const link of links) {
      if (typeof link.url !== "string" || linkedWorkstreams.size >= SLACK_UNFURL_MAX_LINKS) continue;
      // Slack only delivers link_shared for the app's registered unfurl domain,
      // so only the HTTPS shapes below can ever arrive here. The shared parser
      // still accepts the raw deep link, and it never throws on a malformed URL.
      const workstreamId = parseWorkstreamLink(link.url, { webBaseUrl: this.env.PUBLIC_WEB_BASE_URL });
      if (workstreamId) linkedWorkstreams.set(link.url, workstreamId);
    }
    if (linkedWorkstreams.size === 0) return;
    const token = await this.botToken(connection);
    // Summary detail is withheld only where Slack itself has put another
    // company in the room. Every conversation inside the workspace — public,
    // private, DM, group DM — sees it, and an audience lookup that fails falls
    // back to the anonymous card rather than dropping the unfurl.
    // Posting a new card fails closed: an audience we could not confirm is
    // treated as external. The refresh sweep deliberately does the opposite.
    const externallyShared = await slackChannelIsExternallyShared(this.env, token, channel);
    const summaries = externallyShared !== false
      ? new Map<string, WorkstreamUnfurlSummary>()
      : await this.workstreamUnfurlSummaries(connection.workspace_id, [...new Set(linkedWorkstreams.values())]);
    // Keep the rendered blocks: recording hashes exactly what was posted, so
    // the sweep compares against the real attachment rather than a re-derivation
    // that could quietly diverge from it.
    const rendered = new Map<string, Record<string, unknown>[]>();
    const unfurls: Record<string, unknown> = {};
    for (const [url, workstreamId] of linkedWorkstreams) {
      const blocks = workstreamUnfurlBlocks(
        summaries.get(workstreamId) ?? null,
        workstreamCanonicalUrl(this.env.PUBLIC_WEB_BASE_URL, workstreamId),
      );
      rendered.set(url, blocks);
      unfurls[url] = { blocks };
    }
    try {
      await slackApi(token, "chat.unfurl", { channel, ts, unfurls }, AbortSignal.timeout(5_000));
    } catch (error) {
      // A message that can never carry an unfurl is not a failed job. Letting
      // it throw marks the `link_shared` ingress job non-retryable, which pins
      // its attempt count at the ceiling and reads downstream as a job that
      // exhausted its retry budget — an alert nobody can act on. Anything else
      // still throws, so a rate limit or outage keeps its durable retry.
      if (!TERMINAL_UNFURL_REASONS.has(slackErrorReason(error))) throw error;
      logInfo(this.env, "slack_unfurl_declined", {
        team_id: teamId,
        channel_id: channel,
        reason: slackErrorReason(error),
      });
      return;
    }
    await this.recordUnfurledLinks(connection, channel, ts, linkedWorkstreams, summaries, rendered);
  }

  /**
   * Remember which message carries which work-stream link, so the maintenance
   * sweep can rewrite the card when the work stream moves on.
   *
   * This is the only chance to learn it: Slack reports a shared link once, in
   * `link_shared`, and only permits `chat.unfurl` for a URL whose event the app
   * acknowledged. There is no API to re-enumerate past events, so a link that
   * is not recorded here can never be refreshed.
   *
   * Only links that were rendered with a summary are recorded. A card that
   * showed nothing has nothing to keep current, and recording a work stream
   * that resolved outside this workspace would give the sweep a row it must
   * never act on.
   */
  private async recordUnfurledLinks(
    connection: SlackConnectionRow,
    channel: string,
    ts: string,
    linkedWorkstreams: Map<string, string>,
    summaries: Map<string, WorkstreamUnfurlSummary>,
    rendered: Map<string, Record<string, unknown>[]>,
  ): Promise<void> {
    const at = nowIso();
    const recordable = recordableUnfurlLinks(this.env, linkedWorkstreams, summaries);
    const hashes = await Promise.all(
      recordable.map(({ url }) => workstreamUnfurlCardHash(rendered.get(url) ?? [])),
    );
    const statements = recordable
      .map(({ url, workstreamId, summary }, index) => this.env.DB.prepare(
        `INSERT INTO slack_unfurled_links
         (connection_id, slack_channel_id, slack_message_ts, url, workspace_id, workstream_id,
          rendered_status, rendered_anonymous, rendered_hash, audience_checked_at,
          shared_at, refreshed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?9, ?8, ?8, ?8)
         ON CONFLICT(connection_id, slack_channel_id, slack_message_ts, url)
         DO UPDATE SET rendered_status = excluded.rendered_status,
                       rendered_anonymous = 0,
                       rendered_hash = excluded.rendered_hash,
                       audience_checked_at = excluded.audience_checked_at,
                       refreshed_at = excluded.refreshed_at`,
      ).bind(
        connection.id,
        channel,
        ts,
        url,
        connection.workspace_id,
        workstreamId,
        summary.harnessStatus,
        at,
        hashes[index]!,
      ));
    if (statements.length) await this.env.DB.batch(statements);
  }

  private async workstreamUnfurlSummaries(
    workspaceId: string,
    workstreamIds: string[],
  ): Promise<Map<string, WorkstreamUnfurlSummary>> {
    if (!workstreamIds.length) return new Map();
    // Scoping to the connection's own workspace is the one check here that is
    // not a matter of taste: a link to another Avalon workspace's work stream
    // must fall through to the anonymous card rather than be named in this
    // Slack team. A miss is indistinguishable from a link that never existed.
    const rows = await this.env.DB.prepare(
      // Archiving retires a work stream from view, including App Home's own
      // task list, so an archived one falls through to the anonymous card
      // rather than keeping its title alive in Slack.
      `SELECT w.id, ${WORKSTREAM_UNFURL_COLUMNS}
         FROM workstreams w
         ${WORKSTREAM_UNFURL_JOINS}
        WHERE w.workspace_id = ? AND w.archived_at IS NULL
          AND w.id IN (${workstreamIds.map(() => "?").join(", ")})`,
    ).bind(workspaceId, ...workstreamIds).all<Record<string, unknown>>();
    return new Map((rows.results ?? []).map((row) => [String(row.id), workstreamUnfurlSummary(row)]));
  }

  private async linkedIdentity(teamId: string, slackUserId: string): Promise<SlackIdentity | null> {
    const linked = await this.linkedAccount(teamId, slackUserId);
    return linked ? { ...linked, token: await this.botToken(linked.connection) } : null;
  }

  private async linkedAccount(teamId: string, slackUserId: string): Promise<SlackLinkedAccount | null> {
    const row = await this.env.DB.prepare(
      `SELECT l.user_id, l.workspace_id, l.connection_id, wm.role, wm.status AS member_status,
              cc.provider_account_id, cc.encrypted_credentials, cc.credential_iv,
              cc.granted_scopes_json, cc.status
       FROM slack_user_links l
       JOIN connector_connections cc ON cc.id = l.connection_id
       JOIN workspace_members wm ON wm.workspace_id = l.workspace_id AND wm.user_id = l.user_id
       WHERE l.slack_team_id = ? AND l.slack_user_id = ? AND l.status = 'active'
         AND cc.connector_type = 'slack' AND cc.scope = 'workspace' AND cc.status = 'healthy'`,
    ).bind(teamId, slackUserId).first<Record<string, unknown>>();
    if (!row || row.member_status !== "active") return null;
    const connection: SlackConnectionRow = {
      id: String(row.connection_id),
      workspace_id: String(row.workspace_id),
      provider_account_id: String(row.provider_account_id),
      encrypted_credentials: String(row.encrypted_credentials),
      credential_iv: String(row.credential_iv),
      granted_scopes_json: String(row.granted_scopes_json),
      status: String(row.status),
    };
    return { auth: { sessionId: `slack:${teamId}:${slackUserId}`, userId: String(row.user_id), workspaceId: String(row.workspace_id), region: this.env.AVALON_REGION, role: String(row.role) as AuthContext["role"] }, connection, slackUserId, teamId };
  }

  private async connectionForTeam(teamId: string): Promise<SlackConnectionRow> {
    const row = await this.env.DB.prepare(
      `SELECT id, workspace_id, provider_account_id, encrypted_credentials, credential_iv, credential_key_version,
              granted_scopes_json, status
       FROM connector_connections
       WHERE connector_type = 'slack' AND scope = 'workspace' AND provider_account_id = ? AND status <> 'disabled'`,
    ).bind(teamId).first<SlackConnectionRow>();
    if (!row) throw new ApiError(404, "slack_installation_not_found", "Slack workspace is not connected to Avalon");
    return row;
  }

  private async connectionById(id: string): Promise<SlackConnectionRow> {
    const row = await this.env.DB.prepare(
      `SELECT id, workspace_id, provider_account_id, encrypted_credentials, credential_iv, credential_key_version,
              granted_scopes_json, status
       FROM connector_connections WHERE id = ? AND connector_type = 'slack' AND scope = 'workspace'`,
    ).bind(id).first<SlackConnectionRow>();
    if (!row) throw new ApiError(404, "slack_installation_not_found", "Slack workspace is not connected to Avalon");
    return row;
  }

  private async botToken(connection: SlackConnectionRow, signal = AbortSignal.timeout(10_000)): Promise<string> {
    return this.tokenFromEncrypted(connection, signal);
  }

  private async botTokenForTrigger(connection: SlackConnectionRow): Promise<string> {
    const credentials = await this.credentialsFromEncrypted(connection);
    const expiresAt = typeof credentials.expiresAt === "string" ? Date.parse(credentials.expiresAt) : Number.POSITIVE_INFINITY;
    if (Number.isFinite(expiresAt) && expiresAt < Date.now() + 5_000) {
      throw new ApiError(409, "slack_trigger_token_expiring", "Slack authorization is refreshing; try the action again");
    }
    if (typeof credentials.botAccessToken !== "string") throw new ApiError(401, "slack_token_missing", "Slack authorization needs reconnect");
    return credentials.botAccessToken;
  }

  private async botUserId(connection: SlackConnectionRow): Promise<string | null> {
    const credentials = z.record(z.string(), z.unknown()).parse(JSON.parse(
      await decryptVersionedConnectorCredentials(this.env, connection),
    ));
    return typeof credentials.botUserId === "string" ? credentials.botUserId : null;
  }

  private async tokenFromEncrypted(
    row: Record<string, unknown>,
    signal = AbortSignal.timeout(10_000),
    minimumValidityMs = 60_000,
  ): Promise<string> {
    const additionalData = typeof row.connection_id === "string" ? row.connection_id : String(row.id);
    const credentials = await this.credentialsFromEncrypted(row);
    const context = {
      id: additionalData,
      workspaceId: String(row.workspace_id),
      scope: "workspace" as const,
      ownerUserId: null,
      grantedScopes: [],
      credentials,
      cursor: {},
      config: {},
    };
    await ensureFreshConnectorCredentials(this.env, context, connectorRegistryForEnv(this.env).get("slack"), signal, minimumValidityMs);
    if (typeof context.credentials.botAccessToken !== "string") throw new ApiError(401, "slack_token_missing", "Slack authorization needs reconnect");
    return context.credentials.botAccessToken;
  }

  private async credentialsFromEncrypted(row: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (typeof row.encrypted_credentials !== "string" || typeof row.credential_iv !== "string") throw new ApiError(401, "slack_token_missing", "Slack authorization needs reconnect");
    const additionalData = typeof row.connection_id === "string" ? row.connection_id : String(row.id);
    return z.record(z.string(), z.unknown()).parse(JSON.parse(
      await decryptVersionedConnectorCredentials(this.env, {
        id: additionalData,
        encrypted_credentials: row.encrypted_credentials,
        credential_iv: row.credential_iv,
        credential_key_version: Number(row.credential_key_version || 1),
      }),
    ));
  }

  private async createLink(connection: SlackConnectionRow, slackUserId: string): Promise<string> {
    const token = randomToken(32);
    const at = nowIso();
    await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE slack_link_challenges SET consumed_at = ?
         WHERE connection_id = ? AND slack_user_id = ? AND consumed_at IS NULL`,
      ).bind(at, connection.id, slackUserId),
      this.env.DB.prepare(
        `INSERT INTO slack_link_challenges
         (token_hash, connection_id, slack_team_id, slack_user_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(await sha256(token), connection.id, connection.provider_account_id, slackUserId, new Date(Date.now() + 15 * 60_000).toISOString(), at),
    ]);
    const url = new URL("/slack/link", this.env.PUBLIC_WEB_BASE_URL);
    url.hash = new URLSearchParams({ token }).toString();
    return url.toString();
  }

  private async deactivateTeamRoute(connection: SlackConnectionRow): Promise<void> {
    const input = {
      teamId: connection.provider_account_id,
      region: this.env.AVALON_REGION,
      workspaceId: connection.workspace_id,
      connectionId: connection.id,
      status: "disabled" as const,
    };
    try {
      if (this.env.AVALON_REGION === "global") {
        await this.env.DB.prepare(
          `UPDATE slack_installation_routes SET status = 'disabled', disabled_at = ?, updated_at = ?
           WHERE team_id = ? AND workspace_id = ? AND connection_id = ?`,
        ).bind(nowIso(), nowIso(), input.teamId, input.workspaceId, input.connectionId).run();
      } else if (this.env.GLOBAL_SLACK_ROUTER) {
        await this.env.GLOBAL_SLACK_ROUTER.setSlackRouteStatus(input);
      }
    } catch (error) {
      logWarn(this.env, "slack_route_deactivation_after_revocation_failed", {
        connection_id: connection.id,
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  private async openDm(token: string, slackUserId: string): Promise<string> {
    const result = await slackApi(token, "conversations.open", { users: slackUserId }, AbortSignal.timeout(5_000));
    return result.channel.id;
  }

  private async createUserPromptRoot(token: string, channel: string, prompt: string): Promise<string> {
    return postSlackTextChunks(token, channel, prompt);
  }

}

async function claimWorkspaceSession(
  env: Env,
  identity: SlackIdentity,
  session: SlackSessionRow,
): Promise<"claimed" | "already_claimed"> {
  if (session.workspace_id !== identity.auth.workspaceId
    || session.connection_id !== identity.connection.id
    || session.slack_team_id !== identity.teamId) {
    throw new ApiError(403, "slack_claim_workspace_mismatch", "This Slack task belongs to another Avalon workspace");
  }
  if (session.execution_scope === "user") {
    if (session.linked_user_id === identity.auth.userId) return "already_claimed";
    throw new ApiError(409, "slack_claim_conflict", "Another Avalon member already claimed this task");
  }
  const at = nowIso();
  const auditId = await stableUuid(`slack-claim:${session.id}:${identity.auth.userId}`);
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE slack_agent_sessions
       SET execution_scope = 'user', linked_user_id = ?, assigned_user_id = ?,
           assigned_at = ?, assignment_method = 'explicit_link',
           claimed_by_slack_user_id = ?, claimed_at = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND connection_id = ? AND execution_scope = 'workspace'
         AND NOT EXISTS (
           SELECT 1 FROM elicitations e
           WHERE e.workstream_id = slack_agent_sessions.workstream_id
             AND e.status = 'open' AND e.target_user_id IS NOT NULL
             AND e.target_user_id <> ?
         )`,
    ).bind(
      identity.auth.userId,
      identity.auth.userId,
      at,
      identity.slackUserId,
      at,
      at,
      session.id,
      identity.auth.workspaceId,
      identity.connection.id,
      identity.auth.userId,
    ),
    env.DB.prepare(
      `INSERT INTO workstream_participants
       (workstream_id, user_id, added_by_user_id, participation_reason, joined_at, removed_at)
       SELECT workstream_id, ?, ?, 'explicit', ?, NULL
       FROM slack_agent_sessions
       WHERE id = ? AND linked_user_id = ? AND claimed_at = ?
       ON CONFLICT(workstream_id, user_id) DO UPDATE SET
         removed_at = NULL,
         joined_at = COALESCE(workstream_participants.joined_at, excluded.joined_at)`,
    ).bind(identity.auth.userId, identity.auth.userId, at, session.id, identity.auth.userId, at),
    // The claimer owns an ownerless work stream only when they are the Slack
    // member who started it; any other claimer is a participant, not its
    // creator.
    env.DB.prepare(
      `UPDATE workstreams
       SET created_by_user_id = ?, updated_at = ?
       WHERE created_by_user_id IS NULL
         AND id IN (
           SELECT workstream_id FROM slack_agent_sessions
           WHERE id = ? AND linked_user_id = ? AND claimed_at = ? AND slack_user_id = ?
         )`,
    ).bind(identity.auth.userId, at, session.id, identity.auth.userId, at, identity.slackUserId),
    env.DB.prepare(
      `UPDATE workstream_participants
       SET participation_reason = 'creator'
       WHERE user_id = ? AND participation_reason <> 'creator'
         AND workstream_id IN (
           SELECT s.workstream_id FROM slack_agent_sessions s
           JOIN workstreams w ON w.id = s.workstream_id AND w.created_by_user_id = ?
           WHERE s.id = ?
         )`,
    ).bind(identity.auth.userId, identity.auth.userId, session.id),
    env.DB.prepare(
      `INSERT INTO audit_events
       (id, workspace_id, actor_type, actor_user_id, workstream_id, action,
        target_type, target_id, metadata_json, created_at)
       SELECT ?, workspace_id, 'user', ?, workstream_id,
              'slack.workspace_workstream.claimed', 'slack_agent_session', id, ?, ?
       FROM slack_agent_sessions
       WHERE id = ? AND linked_user_id = ? AND claimed_at = ?
       ON CONFLICT(id) DO NOTHING`,
    ).bind(
      auditId,
      identity.auth.userId,
      JSON.stringify({
        slackTeamId: identity.teamId,
        slackUserId: identity.slackUserId,
        explicit: true,
      }),
      at,
      session.id,
      identity.auth.userId,
      at,
    ),
  ]);
  if (Number(results[0]?.meta.changes ?? 0) === 1) return "claimed";
  const current = await env.DB.prepare(
    "SELECT execution_scope, linked_user_id FROM slack_agent_sessions WHERE id = ?",
  ).bind(session.id).first<{ execution_scope: "workspace" | "user"; linked_user_id: string | null }>();
  if (current?.execution_scope === "user" && current.linked_user_id === identity.auth.userId) {
    return "already_claimed";
  }
  if (current?.execution_scope === "workspace") {
    throw new ApiError(403, "slack_claim_target_mismatch", "This question is targeted to another Avalon member");
  }
  throw new ApiError(409, "slack_claim_conflict", "Another Avalon member already claimed this task");
}

const SlackResponseMessageSchema = z.object({
  response_type: z.enum(["ephemeral", "in_channel"]),
  replace_original: z.boolean(),
  text: z.string().min(1),
}).strict();

async function postSlackResponse(responseUrl: string, message: z.input<typeof SlackResponseMessageSchema>): Promise<void> {
  const url = new URL(responseUrl);
  if (url.protocol !== "https:" || url.hostname !== "hooks.slack.com" || url.username || url.password || url.port) {
    throw new ApiError(422, "slack_response_url_invalid", "Slack response URL must use the Slack hooks host");
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(SlackResponseMessageSchema.parse(message)),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new ApiError(502, "slack_response_failed", `Slack response URL returned HTTP ${response.status}`);
}

async function postSlackTextChunks(token: string, channel: string, text: string, threadTs?: string, clientMessageKey?: string): Promise<string> {
  const chunks = splitSlackText(text || "Avalon completed the task without a text response.", 40_000);
  let rootTs = threadTs;
  let firstMessageTs: string | null = null;
  for (const [index, chunk] of chunks.entries()) {
    const result = await slackApi(token, "chat.postMessage", {
      channel,
      ...(rootTs ? { thread_ts: rootTs } : {}),
      ...(clientMessageKey ? { client_msg_id: await stableUuid(`${clientMessageKey}:${index}`) } : {}),
      text: chunk,
    }, AbortSignal.timeout(10_000));
    firstMessageTs ??= result.ts;
    rootTs ??= result.ts;
  }
  if (!firstMessageTs) throw new ApiError(502, "slack_message_failed", "Slack did not return a message timestamp");
  return firstMessageTs;
}

async function stableUuid(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function splitSlackText(value: string, maximum: number): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const character of value) {
    if (chunk.length + character.length > maximum) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks.length ? chunks : ["Avalon completed the task without a text response."];
}

function slackChannelType(value: unknown): SlackPromptSource["channelType"] {
  if (typeof value !== "string") return "unknown";
  if (value === "channel" || value === "public_channel" || value === "public") return "public";
  if (value === "group" || value === "private_channel" || value === "private" || value === "privategroup" || value === "mpim") return "private";
  if (value === "im" || value === "directmessage" || value.startsWith("D")) return "im";
  return "unknown";
}

function parseSlackJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function isDirectSlackMessageEvent(event: Record<string, unknown>): boolean {
  return slackChannelType(event.channel_type) === "im"
    || (typeof event.channel === "string" && event.channel.startsWith("D"));
}

function isSlackRetryPrompt(value: string): boolean {
  return /^(?:please\s+)?(?:retry|try\s+again)[.!]?$/iu.test(value.trim());
}

function recoverSlackDeniedPrompt(
  messages: readonly Record<string, unknown>[],
  slackUserId: string,
  botUserId: string,
): string | null {
  let denialIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const text = typeof message.text === "string" ? message.text : "";
    if (message.user === botUserId
      && SLACK_RETRYABLE_DENIAL_PREFIXES.some((prefix) => text.startsWith(prefix))) {
      denialIndex = index;
      break;
    }
  }
  if (denialIndex < 0) return null;
  for (let index = denialIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.user !== slackUserId || typeof message.text !== "string") continue;
    if (!message.text.includes(`<@${botUserId}>`)) continue;
    const prompt = message.text.replaceAll(`<@${botUserId}>`, "").trim();
    if (prompt) return prompt;
  }
  return null;
}

async function resolveSlackChannelType(
  env: LogEnv,
  token: string,
  channelId: string,
  hint: unknown,
): Promise<{
  channelType: SlackPromptSource["channelType"];
  channelName: string | null;
  failure: SlackPromptSource["channelResolutionFailure"];
}> {
  const hinted = slackChannelType(hint);
  if (hinted === "im" || channelId.startsWith("D")) {
    return { channelType: "im", channelName: null, failure: null };
  }
  try {
    const result = await slackApi(token, "conversations.info", {
      channel: channelId,
    }, AbortSignal.timeout(5_000));
    const channelName = result.channel.name?.trim().slice(0, 255) || null;
    if (result.channel.is_im === true) return { channelType: "im", channelName, failure: null };
    // `is_private` is optional on the wire. Only an explicit `false` classifies
    // a conversation as public; anything else stays private, because this
    // classification gates whether Avalon will start a workspace task here.
    if (result.channel.is_mpim === true || result.channel.is_private !== false) {
      return { channelType: "private", channelName, failure: null };
    }
    return { channelType: "public", channelName, failure: null };
  } catch (error) {
    const reason = slackErrorReason(error);
    logWarn(env, "slack_conversation_privacy_lookup_failed", {
      channel_id: channelId,
      reason,
    });
    return {
      channelType: "unknown",
      channelName: null,
      failure: reason === "missing_scope" ? "missing_scope" : "lookup_failed",
    };
  }
}

function slackChannelResolutionDenial(
  failure: Exclude<SlackPromptSource["channelResolutionFailure"], null>,
): { text: string; reconnectRequired: boolean } {
  if (failure === "missing_scope") {
    return {
      text: "Avalon needs updated Slack permissions before it can start workspace tasks here. Ask an Avalon workspace admin to reconnect the Slack workspace in Avalon Settings, then reply `try again` in this thread. You can also connect your Avalon account in App Home.",
      reconnectRequired: true,
    };
  }
  return {
    text: "Avalon couldn’t verify whether this Slack channel is public or private, so it did not start a workspace task. Reply `try again` in this thread; if this continues, ask an Avalon workspace admin to test the Slack connection in Avalon Settings. You can also connect your Avalon account in App Home.",
    reconnectRequired: false,
  };
}

function modalPromptSource(value: unknown): SlackPromptSource | null {
  if (typeof value === "string" && value) {
    try {
      return SlackModalContextSchema.parse(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return null;
}

function validSlackHuman(
  user: {
    team_id: string;
    deleted?: boolean | undefined;
    is_bot?: boolean | undefined;
    is_app_user?: boolean | undefined;
    is_restricted?: boolean | undefined;
    is_ultra_restricted?: boolean | undefined;
  },
  expectedTeamId: string,
): boolean {
  return user.team_id === expectedTeamId
    && user.deleted !== true
    && user.is_bot !== true
    && user.is_app_user !== true
    && user.is_restricted !== true
    && user.is_ultra_restricted !== true;
}

function slackHumanDisplayName(user: {
  id: string;
  name?: string | undefined;
  real_name?: string | undefined;
  profile?: { display_name?: string | undefined; real_name?: string | undefined } | undefined;
}): string {
  return user.profile?.display_name?.trim()
    || user.profile?.real_name?.trim()
    || user.real_name?.trim()
    || user.name?.trim()
    || user.id;
}

function slackElicitationRequest(
  elicitation: {
    response_type: "text" | "radio" | "single_select" | "multi_select";
    options_json: string;
  },
  rawResponse: string,
): { answer: string | string[]; customResponse?: string } {
  const response = rawResponse.trim();
  if (!response) throw new ApiError(422, "slack_prompt_missing", "The Slack response is empty");
  if (elicitation.response_type === "text") return { answer: response };
  const rawOptions: unknown = (() => {
    try {
      return JSON.parse(elicitation.options_json);
    } catch {
      return [];
    }
  })();
  const options = z.array(z.object({ value: z.string(), label: z.string() }).passthrough())
    .catch([])
    .parse(rawOptions);
  const byLabel = new Map(options.flatMap((option) => [
    [option.value.toLocaleLowerCase(), option.value] as const,
    [option.label.toLocaleLowerCase(), option.value] as const,
  ]));
  if (elicitation.response_type !== "multi_select") {
    const selected = byLabel.get(response.toLocaleLowerCase());
    return selected ? { answer: selected } : { answer: response, customResponse: response };
  }
  const requested = response.split(/\s*,\s*/u).filter(Boolean);
  const matched: string[] = [];
  const unknown: string[] = [];
  for (const selection of requested) {
    const value = byLabel.get(selection.toLocaleLowerCase());
    if (value) matched.push(value);
    else unknown.push(selection);
  }
  if (unknown.length === 0) return { answer: matched };
  const customResponse = unknown.join(", ");
  return { answer: [...matched, customResponse], customResponse };
}

// The connector returns its sync tally in camelCase. Log fields are
// snake_case, so map it here rather than spreading the interface into an entry
// and indexing `alreadyMember` beside `already_member` elsewhere.
function publicChannelSyncFields(summary: SlackPublicChannelSyncResult): Record<string, unknown> {
  return {
    joined: summary.joined,
    already_member: summary.alreadyMember,
    skipped: summary.skipped,
    complete: summary.complete,
    ...(summary.retryAfterMs === undefined ? {} : { retry_after_ms: summary.retryAfterMs }),
  };
}

function slackErrorReason(error: unknown): string {
  if (error instanceof ConnectorError) {
    const details = error.details;
    if (details && typeof details === "object" && typeof (details as { error?: unknown }).error === "string") {
      return String((details as { error: string }).error);
    }
    return error.code;
  }
  if (error instanceof z.ZodError) return "invalid_slack_data";
  return error instanceof Error ? error.name : "unknown_error";
}

function startTaskModal(
  initial: string,
  source: z.infer<typeof SlackModalContextSchema> = {
    kind: "shortcut",
    channelType: "unknown",
    channelResolutionFailure: null,
    channelId: null,
    channelName: null,
    threadTs: null,
    messageTs: null,
    attachments: [],
  },
): Record<string, unknown> {
  return { type: "modal", callback_id: "avalon_start_task_submit", private_metadata: JSON.stringify(SlackModalContextSchema.parse(source)), title: { type: "plain_text", text: "Start an Avalon task" }, submit: { type: "plain_text", text: "Start" }, close: { type: "plain_text", text: "Cancel" }, blocks: [{ type: "input", block_id: "prompt", label: { type: "plain_text", text: "What should Avalon do?" }, element: { type: "plain_text_input", action_id: "value", multiline: true, initial_value: initial.slice(0, 3_000), placeholder: { type: "plain_text", text: "Summarize this, investigate an issue, or coordinate work…" } } }] };
}

function preferencesModal(notifyNeedsInput: boolean, notifyAutomationCompleted: boolean): Record<string, unknown> {
  const options = [{ text: { type: "plain_text", text: "When a task needs input" }, value: "needs_input" }, { text: { type: "plain_text", text: "When an automation completes" }, value: "automation_completed" }];
  const initialOptions = options.filter((option) => option.value === "needs_input" ? notifyNeedsInput : notifyAutomationCompleted);
  return { type: "modal", callback_id: "avalon_preferences_submit", title: { type: "plain_text", text: "Avalon notifications" }, submit: { type: "plain_text", text: "Save" }, close: { type: "plain_text", text: "Cancel" }, blocks: [{ type: "input", optional: true, block_id: "delivery", label: { type: "plain_text", text: "Notify me in Slack" }, element: { type: "checkboxes", action_id: "value", options, ...(initialOptions.length ? { initial_options: initialOptions } : {}) } }] };
}

function feedbackModal(workstreamId: string): Record<string, unknown> {
  return { type: "modal", callback_id: "avalon_feedback_submit", private_metadata: workstreamId.slice(0, 3000), title: { type: "plain_text", text: "Feedback for Avalon" }, submit: { type: "plain_text", text: "Send" }, close: { type: "plain_text", text: "Cancel" }, blocks: [
    { type: "input", block_id: "rating", label: { type: "plain_text", text: "How was this result?" }, element: { type: "radio_buttons", action_id: "value", options: [{ text: { type: "plain_text", text: "Helpful" }, value: "helpful" }, { text: { type: "plain_text", text: "Needs improvement" }, value: "needs_improvement" }] } },
    { type: "input", optional: true, block_id: "comment", label: { type: "plain_text", text: "What should improve?" }, element: { type: "plain_text_input", action_id: "value", multiline: true, max_length: 2000 } },
  ] };
}

function unlinkedHome(link: string): Record<string, unknown>[] {
  return [
    { type: "header", text: { type: "plain_text", text: "Meet Avalon" } },
    { type: "section", text: { type: "mrkdwn", text: "Start workspace-authorized tasks directly from Slack. They use only shared Avalon workspace tools and remain attributed to your Slack identity. Avalon uses bounded Slack activity and task-specific context for requested work and configured automations; it does not recreate Slack as a parallel inbox or searchable workspace." } },
    { type: "section", text: { type: "mrkdwn", text: "Connect your Avalon account to claim tasks that need personal authority, use your personal connectors, and see assigned work in Avalon." } },
    { type: "actions", elements: [{ type: "button", style: "primary", text: { type: "plain_text", text: "Connect Avalon" }, url: link, action_id: "avalon_connect" }] },
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: "*Try now*\n• Summarize this thread and propose next steps\n• Investigate this issue with workspace tools\n• Draft a status update for this channel\n\nAfter connecting: create personal automations such as “Check my Gmail every morning and send my top 3 emails here.”" } },
    { type: "context", elements: [{ type: "mrkdwn", text: "Avalon Agent features require paid Slack and Avalon plans." }] },
    { type: "context", elements: [{ type: "mrkdwn", text: "AI can make mistakes. Review important actions. <https://with-avalon.com/privacy|Privacy> · <https://with-avalon.com/support|Help>" }] },
  ];
}

function linkedHome(env: LogEnv, name: string, tasks: Record<string, unknown>[], automations: Record<string, unknown>[], webBase: string, personalSlack: { display_name: string; status: string } | null, administration: { teamId: string; status: string } | null): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [
    { type: "header", text: { type: "plain_text", text: `Welcome, ${name}`.slice(0, 150) } },
    { type: "actions", elements: [
      { type: "button", style: "primary", text: { type: "plain_text", text: "Start a task" }, action_id: "avalon_start_task" },
      { type: "button", text: { type: "plain_text", text: "Create automation" }, url: desktopHandoffUrl(webBase, "avalon://automations/new"), action_id: "avalon_create_automation" },
      { type: "button", text: { type: "plain_text", text: "Notifications" }, action_id: "avalon_preferences" },
    ] },
    { type: "divider" },
    { type: "header", text: { type: "plain_text", text: "Needs attention & recent tasks" } },
  ];
  if (!tasks.length) blocks.push({ type: "section", text: { type: "mrkdwn", text: "_Nothing needs your attention right now._" } });
  for (const task of tasks) {
    const workstreamId = String(task.id);
    // Minting a link is strict on purpose, but this is a list: one row that
    // cannot produce a link must cost that row, not the whole App Home. The
    // throw would otherwise escape `views.publish` and fail account linking.
    if (!isWorkstreamId(workstreamId)) {
      logWarn(env, "slack_app_home_task_skipped", {
        workstream_id: workstreamId,
      });
      continue;
    }
    const status = task.harness_status === "needs_input"
      ? ":warning: Needs your input"
      : task.harness_status === "running"
        ? ":large_green_circle: Running"
        : `Recent · ${escapeMrkdwn(String(task.harness_status).replaceAll("_", " "))}`;
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*<${workstreamCanonicalUrl(webBase, workstreamId)}|${escapeMrkdwn(String(task.title))}>*\n${status}` } });
  }
  blocks.push({ type: "divider" }, { type: "header", text: { type: "plain_text", text: "Automations" } });
  if (!automations.length) blocks.push({ type: "section", text: { type: "mrkdwn", text: "Create a recurring automation—like a 9 AM stack-ranked Gmail briefing delivered to your Avalon DM." } });
  for (const automation of automations) blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${escapeMrkdwn(String(automation.name))}* · ${escapeMrkdwn(String(automation.status))}\n${automation.next_run_at ? `Next run: ${escapeMrkdwn(String(automation.next_run_at))}` : "No scheduled run"}` } });
  blocks.push(
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: `*Personal Slack tools*\n${personalSlack ? `${personalSlack.status === "healthy" ? ":large_green_circle:" : ":warning:"} ${escapeMrkdwn(personalSlack.display_name)} · ${escapeMrkdwn(personalSlack.status)}` : "Not connected · connect to search Slack and act with your own permissions."}` }, accessory: { type: "button", text: { type: "plain_text", text: personalSlack ? "Manage" : "Connect" }, url: desktopHandoffUrl(webBase, "avalon://settings/connections"), action_id: "avalon_open_personal_tools" } },
  );
  if (administration) blocks.push(
    { type: "divider" },
    { type: "header", text: { type: "plain_text", text: "Workspace administration" } },
    { type: "section", text: { type: "mrkdwn", text: `Slack workspace ${escapeMrkdwn(administration.teamId)} · ${administration.status === "healthy" ? ":large_green_circle: Healthy" : ":warning: Needs attention"}` }, accessory: { type: "button", text: { type: "plain_text", text: "Manage" }, url: desktopHandoffUrl(webBase, "avalon://settings/connections"), action_id: "avalon_open_admin" } },
  );
  blocks.push({ type: "divider" }, { type: "context", elements: [{ type: "mrkdwn", text: "Avalon Agent features require paid Slack and Avalon plans. Personal Slack tools use your own Slack permissions when connected. <https://with-avalon.com/privacy|Privacy> · <https://with-avalon.com/support|Support>" }] });
  return blocks;
}

function responseActionBlocks(workstreamId: string, webBase: string, linked: boolean): Record<string, unknown>[] {
  return [{ type: "actions", elements: [
    { type: "button", text: { type: "plain_text", text: "Open task" }, url: workstreamCanonicalUrl(webBase, workstreamId), action_id: "avalon_open_task" },
    ...(linked ? [{ type: "button", text: { type: "plain_text", text: "Give feedback" }, action_id: "avalon_feedback", value: workstreamId }] : []),
  ] }, aiResponseDisclaimerBlock()];
}

function workspaceClaimBlocks(sessionId: string, includeConnectHint: boolean): Record<string, unknown>[] {
  return [
    ...(includeConnectHint
      ? [{ type: "section", text: { type: "mrkdwn", text: "Connect your Avalon account before claiming this task." } }]
      : []),
    {
      type: "actions",
      elements: [{
        type: "button",
        style: "primary",
        text: { type: "plain_text", text: "Claim with my Avalon account" },
        action_id: "avalon_claim_workstream",
        value: sessionId,
      }],
    },
  ];
}

function automationActionBlocks(title: string, workstreamId: string, webBase: string): Record<string, unknown>[] {
  return [{ type: "header", text: { type: "plain_text", text: title.slice(0, 150) } }, { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open full result" }, url: workstreamCanonicalUrl(webBase, workstreamId), action_id: "avalon_open_automation_result" }] }, aiResponseDisclaimerBlock()];
}

function aiResponseDisclaimerBlock(): Record<string, unknown> {
  return {
    type: "context",
    elements: [{
      type: "mrkdwn",
      text: "Generated by AI. Review important facts, decisions, and external actions.",
    }],
  };
}

function desktopHandoffUrl(webBase: string, target: string): string {
  const url = new URL("/open", webBase);
  url.hash = new URLSearchParams({ target }).toString();
  return url.toString();
}

export function shouldSuppressAutomationResult(text: string): boolean {
  const normalized = text.trim();
  return !normalized || /\b(?:no|zero)\s+(?:qualifying|actionable|matching)\s+(?:emails?|messages?)\b/iu.test(normalized);
}

function modalPrompt(state: unknown): string | null {
  const values = asRecord(asRecord(state).values);
  const prompt = asRecord(values.prompt);
  const value = asRecord(prompt.value).value;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function modalSelectedValues(state: unknown, blockId: string, actionId: string): string[] {
  const action = asRecord(asRecord(asRecord(state).values)[blockId])[actionId];
  const value = asRecord(action);
  if (Array.isArray(value.selected_options)) return value.selected_options.flatMap((option) => typeof asRecord(option).value === "string" ? [String(asRecord(option).value)] : []);
  const selected = asRecord(value.selected_option).value;
  return typeof selected === "string" ? [selected] : [];
}

function modalTextValue(state: unknown, blockId: string, actionId: string): string | null {
  const value = asRecord(asRecord(asRecord(asRecord(state).values)[blockId])[actionId]).value;
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 2000) : null;
}

function nestedString(value: Record<string, unknown>, key: string, nested: string): string | null {
  const child = asRecord(value[key]);
  return typeof child[nested] === "string" ? child[nested] : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function slackAppContext(value: unknown): { entities: Array<{ type: string; value: string; teamId: string | null }> } {
  const context = asRecord(value);
  const entities = Array.isArray(context.entities) ? context.entities : [];
  return {
    entities: entities.flatMap((candidate) => {
      const entity = asRecord(candidate);
      const type = typeof entity.type === "string" ? entity.type.trim().slice(0, 255) : "";
      const entityValue = typeof entity.value === "string" ? entity.value.trim().slice(0, 1_000) : "";
      if (!type || !entityValue) return [];
      return [{
        type,
        value: entityValue,
        teamId: typeof (entity.team_id ?? entity.teamId) === "string" && String(entity.team_id ?? entity.teamId).trim()
          ? String(entity.team_id ?? entity.teamId).trim().slice(0, 255)
          : null,
      }];
    }).slice(0, 32),
  };
}

function parseStoredSlackAppContext(value: string) {
  try {
    return slackAppContext(JSON.parse(value) as unknown);
  } catch {
    return { entities: [] };
  }
}

function slackOriginNearbyMessage(value: unknown): SlackOriginNearbyMessage {
  const message = asRecord(value);
  const userId = typeof message.user === "string" && message.user
    ? message.user
    : typeof message.bot_id === "string" && message.bot_id
      ? message.bot_id
      : null;
  return {
    timestamp: String(message.ts ?? "unknown").slice(0, 80),
    userId,
    text: String(message.text ?? "").slice(0, 2_000),
    attachments: slackOriginAttachments(message),
  };
}

function slackOriginAttachments(value: unknown): SlackOriginAttachment[] {
  const message = asRecord(value);
  const attachments: SlackOriginAttachment[] = [];
  if (Array.isArray(message.files)) {
    for (const rawFile of message.files.slice(0, 10)) {
      const file = asRecord(rawFile);
      const name = slackBoundedString(file.name, 500)
        ?? slackBoundedString(file.title, 500)
        ?? "Slack file";
      attachments.push({
        id: slackBoundedString(file.id, 255),
        name,
        title: slackBoundedString(file.title, 500),
        mimeType: slackBoundedString(file.mimetype, 255),
        fileType: slackBoundedString(file.filetype, 120),
        permalink: slackHttpUrl(file.permalink),
      });
    }
  }
  if (Array.isArray(message.attachments)) {
    for (const rawAttachment of message.attachments.slice(0, Math.max(0, 10 - attachments.length))) {
      const attachment = asRecord(rawAttachment);
      const name = slackBoundedString(attachment.title, 500)
        ?? slackBoundedString(attachment.fallback, 500)
        ?? "Slack attachment";
      attachments.push({
        id: slackBoundedString(attachment.id, 255),
        name,
        title: slackBoundedString(attachment.title, 500),
        mimeType: null,
        fileType: null,
        permalink: slackHttpUrl(attachment.title_link ?? attachment.from_url),
      });
    }
  }
  return attachments;
}

function slackEventSearchAuthorization(event: Record<string, unknown>): SlackSearchAuthorization | undefined {
  const actionToken = typeof event.action_token === "string" ? event.action_token : null;
  if (!actionToken) return undefined;
  const parsed = SlackSearchAuthorizationSchema.safeParse({ actionToken });
  return parsed.success ? parsed.data : undefined;
}

function slackBoundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maximum)
    : null;
}

function slackHttpUrl(value: unknown): string | null {
  const raw = slackBoundedString(value, 2_000);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? raw : null;
  } catch {
    return null;
  }
}

function authorizedBotUserId(envelope: SlackIngressEnvelope): string | null {
  for (const authorization of envelope.authorizations ?? []) {
    if (authorization.team_id !== envelope.team_id || authorization.is_bot !== true) continue;
    if (typeof authorization.user_id === "string" && authorization.user_id) return authorization.user_id;
  }
  return null;
}

function slackEventActorUserIds(event: Record<string, unknown>): string[] {
  const channel = asRecord(event.channel);
  return [...new Set([event.user, event.user_id, channel.creator]
    .filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function slackReconnectRequired(error: unknown): boolean {
  const reason = slackErrorReason(error);
  return (error instanceof ConnectorError
      && ((error.code === "unauthorized" && reason !== "token_expired") || reason === "missing_scope"))
    || (error instanceof ApiError && error.status === 401);
}

function parseGrantedScopes(value: string): string[] {
  try {
    return z.array(z.string()).parse(JSON.parse(value));
  } catch {
    return [];
  }
}

function slackIngressRetryable(error: unknown): boolean {
  if (error instanceof z.ZodError) return false;
  if (error instanceof ApiError) return error.status === 429 || error.status >= 500;
  if (!(error instanceof ConnectorError)) return true;
  const reason = slackErrorReason(error);
  // An access token can expire between proactive refresh and the provider
  // request. Preserve the connection and let the durable retry refresh it.
  if (reason === "token_expired") return true;
  if (error.code !== "provider_error") return false;
  const details = error.details && typeof error.details === "object"
    ? error.details as { status?: unknown }
    : {};
  const status = typeof details.status === "number" ? details.status : 0;
  return status === 429
    || status >= 500
    || new Set(["fatal_error", "internal_error", "ratelimited", "rate_limited", "request_timeout", "service_unavailable"]).has(reason);
}

function slackIngressErrorCode(error: unknown): string {
  if (error instanceof ApiError) return error.code;
  const reason = slackErrorReason(error);
  return reason && reason !== "Error" ? reason.slice(0, 120) : "slack_ingress_failed";
}

function escapeMrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Mirrors the `length(url) BETWEEN 1 AND 2000` check in `0055_slack_unfurled_links.sql`. */
const SLACK_UNFURL_MAX_URL_LENGTH = 2_000;

/**
 * Decide which of a message's work-stream links are worth recording for refresh.
 *
 * The stored URL is the key `chat.unfurl` is later called with, so it has to
 * match what Slack reported byte for byte. Trimming one to fit the column would
 * store a key that can never match again: the refresh would look like it
 * succeeded while the message kept its stale card. Skipping instead costs only
 * the ability to refresh that one link — its card is still posted.
 *
 * Over-long links are reachable, not hypothetical: a canonical link is about
 * seventy characters, but the legacy `/open#target=…` form this still accepts
 * tolerates arbitrary extra fragment parameters.
 */
function recordableUnfurlLinks(
  env: LogEnv,
  linkedWorkstreams: Map<string, string>,
  summaries: Map<string, WorkstreamUnfurlSummary>,
): { url: string; workstreamId: string; summary: WorkstreamUnfurlSummary }[] {
  return [...linkedWorkstreams].flatMap(([url, workstreamId]) => {
    const summary = summaries.get(workstreamId);
    if (!summary) return [];
    if (url.length > SLACK_UNFURL_MAX_URL_LENGTH) {
      logWarn(env, "slack_workstream_link_too_long", {
        workstream_id: workstreamId,
        url_length: url.length,
      });
      return [];
    }
    return [{ url, workstreamId, summary }];
  });
}

export const __slackAgentTesting = {
  claimWorkspaceSession,
  isDirectSlackMessageEvent,
  isSlackRetryPrompt,
  modalPromptSource,
  recoverSlackDeniedPrompt,
  resolveSlackChannelType,
  slackAppContext,
  slackOriginAttachments,
  slackOriginNearbyMessage,
  slackEventSearchAuthorization,
  slackEventActorUserIds,
  slackChannelResolutionDenial,
  slackChannelType,
  linkedHome,
  recordableUnfurlLinks,
  slackIngressRetryable,
  slackReconnectRequired,
};
