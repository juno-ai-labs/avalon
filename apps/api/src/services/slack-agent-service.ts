import { ConnectorError, parseSlackAgentInvocation, parseSlackEventEnvelope, slackApi, type SlackIngressEnvelope } from "@avalon/connectors";
import { SlackIngressQueueMessageSchema } from "@avalon/contracts";
import { newId, nowIso } from "@avalon/db";
import { z } from "zod";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { decryptString, randomToken, sha256 } from "../lib/crypto";
import { connectorRegistryForEnv } from "../lib/connector-registry";
import { ensureFreshConnectorCredentials } from "./connector-credential-refresh";
import { WorkstreamService } from "./workstream-service";

interface SlackConnectionRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  provider_account_id: string;
  encrypted_credentials: string;
  credential_iv: string;
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
  user_id: string;
  slack_team_id: string;
  slack_user_id: string;
  slack_channel_id: string;
  slack_thread_ts: string;
  slack_stream_ts: string | null;
  workstream_id: string;
  last_delivery_key: string | null;
}

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
  response_url: z.string().url().optional(),
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
        console.warn("Slack ingress recovery enqueue failed", {
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
      console.error("Slack ingress exhausted its retry budget", {
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
        `SELECT id, workspace_id, provider_account_id, encrypted_credentials, credential_iv, status
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
            console.warn("Slack workspace credential pre-warm failed", {
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
        if (!await this.linkedAccount(teamId, slackUserId)) return { response_action: "errors", errors: { prompt: "Connect your Avalon account in App Home first." } };
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
          `SELECT id FROM slack_agent_sessions WHERE workspace_id = ? AND workstream_id = ? AND user_id = ? AND connection_id = ?`,
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
      const sourceText = type === "message_action" && asRecord(payload.message).text
        ? String(asRecord(payload.message).text)
        : "";
      await slackApi(token, "views.open", { trigger_id: triggerId, view: startTaskModal(sourceText) }, AbortSignal.timeout(1_500));
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
    const { teamId, userId: slackUserId } = invocation;
    if (!commandForm.text.trim()) {
      const connection = await this.connectionForTeam(teamId);
      await slackApi(await this.botTokenForTrigger(connection), "views.open", {
        trigger_id: commandForm.trigger_id,
        view: startTaskModal(""),
      }, AbortSignal.timeout(1_500));
      return { response_type: "ephemeral", text: "Opening Avalon…" };
    }
    if (/^help$/iu.test(commandForm.text.trim())) {
      return { response_type: "ephemeral", text: "Ask Avalon to investigate, summarize, coordinate, or create an automation. Run /avalon without text to open the task modal, or open App Home to connect and manage notifications." };
    }
    if (!await this.linkedAccount(teamId, slackUserId)) {
      return { response_type: "ephemeral", text: "Connect your Avalon account from Avalon App Home, then run this command again." };
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
        await this.dispatchEvent(job.team_id, envelope);
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
      await this.env.DB.prepare(
        `UPDATE slack_ingress_jobs SET status = 'failed', lease_id = NULL,
           lease_expires_at = NULL, error_code = ?, updated_at = ?
         WHERE id = ? AND lease_id = ?`,
      ).bind(error instanceof ApiError ? error.code : "slack_ingress_failed", nowIso(), job.id, leaseId).run();
      throw error;
    }
  }

  private async enqueueIngressJob(input: {
    id: string;
    teamId: string;
    bodyHash: string;
    kind: "event" | "interaction" | "command";
    payload: unknown;
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
    await this.env.ACTIVITY_QUEUE.send(SlackIngressQueueMessageSchema.parse({
      kind: "slack_ingress",
      region: this.env.AVALON_REGION,
      workspaceId: connection.workspace_id,
      jobId: input.id,
    }));
    return { ok: true, ...(duplicate ? { duplicate: true } : {}) };
  }

  private async dispatchQueuedInteraction(payload: Record<string, unknown>, jobId: string): Promise<void> {
    if (payload.type !== "view_submission") return;
    const teamId = nestedString(payload, "team", "id");
    const slackUserId = nestedString(payload, "user", "id");
    const view = asRecord(payload.view);
    if (!teamId || !slackUserId) throw new ApiError(422, "slack_interaction_invalid", "Slack interaction identity is missing");
    if (view.callback_id === "avalon_start_task_submit") {
      const prompt = modalPrompt(view.state);
      if (!prompt) throw new ApiError(422, "slack_prompt_missing", "The Slack task prompt is missing");
      await this.startFromPrompt(teamId, slackUserId, null, null, prompt, `view:${String(view.id ?? jobId)}`);
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
    await this.startFromPrompt(form.team_id, form.user_id, null, null, form.text.trim(), `command:${form.trigger_id}`);
    if (form.response_url) {
      try {
        await postSlackResponse(form.response_url, {
          response_type: "ephemeral",
          replace_original: false,
          text: "Avalon started your task in the Agent conversation.",
        });
      } catch (error) {
        console.warn("Slack command follow-up failed", { reason: error instanceof Error ? error.message : "unknown" });
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
    await this.publishHome(String(challenge.slack_team_id), String(challenge.slack_user_id));
    return { linked: true, teamId: String(challenge.slack_team_id), slackUserId: String(challenge.slack_user_id) };
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

  async deliverWorkstreamOutcome(workspaceId: string, workstreamId: string, text: string, deliveryKey: string): Promise<void> {
    const session = await this.env.DB.prepare(
      `SELECT * FROM slack_agent_sessions WHERE workspace_id = ? AND workstream_id = ?`,
    ).bind(workspaceId, workstreamId).first<SlackSessionRow>();
    if (!session) return;
    if (session.last_delivery_key === deliveryKey) return;
    const connection = await this.connectionById(session.connection_id);
    const token = await this.botToken(connection);
    const responseText = text || "Avalon completed the task without a text response.";
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
          blocks: responseActionBlocks(workstreamId, this.env.PUBLIC_WEB_BASE_URL),
        }, AbortSignal.timeout(10_000));
        delivered = true;
      }
    } catch (error) {
      console.warn("Slack stream delivery failed; using a thread reply", { workspace_id: workspaceId, workstream_id: workstreamId, reason: error instanceof Error ? error.message : "unknown" });
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
          console.warn("Slack failed to close an interrupted stream", {
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
          blocks: responseActionBlocks(workstreamId, this.env.PUBLIC_WEB_BASE_URL),
        }, AbortSignal.timeout(10_000));
      }
      await this.env.DB.prepare(
        "UPDATE slack_agent_sessions SET last_delivery_key = ?, updated_at = ? WHERE id = ?",
      ).bind(deliveryKey, nowIso(), session.id).run();
    } catch (error) {
      deliveryError = error;
      console.warn("Slack workstream delivery failed", { workspace_id: workspaceId, workstream_id: workstreamId, reason: error instanceof Error ? error.message : "unknown" });
    } finally {
      try {
        await slackApi(token, "assistant.threads.setStatus", { channel_id: session.slack_channel_id, thread_ts: session.slack_thread_ts, status: "" }, AbortSignal.timeout(5_000));
      } catch (error) {
        console.warn("Slack thread status cleanup failed", { workspace_id: workspaceId, workstream_id: workstreamId, reason: error instanceof Error ? error.message : "unknown" });
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
        console.warn("Slack automation thread title failed", { target_id: target.id, reason: error instanceof Error ? error.message : "unknown" });
      }
    } catch (error) {
      const reconnectRequired = (error instanceof ConnectorError && error.code === "unauthorized")
        || (error instanceof ApiError && error.status === 401);
      await this.markAutomationDelivery(target, reconnectRequired ? "needs_input" : "active", error);
      if (!reconnectRequired) throw error;
    }
  }

  private async markAutomationDelivery(target: Record<string, unknown>, status: "active" | "needs_input", error: unknown): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE automation_delivery_targets SET status = ?, last_error_json = ?, updated_at = ? WHERE id = ?`,
    ).bind(status, JSON.stringify({ code: "slack_delivery_failed", message: error instanceof Error ? error.message : "Slack delivery failed" }), nowIso(), target.id).run();
  }

  private async dispatchEvent(teamId: string, envelope: SlackIngressEnvelope): Promise<void> {
    const event = envelope.event!;
    const type = String(event.type ?? "");
    if (type === "app_home_opened") {
      const userId = String(event.user ?? "");
      if (userId && event.context) await this.storeActiveContext(teamId, userId, event.context);
      if (event.tab !== "home") return;
      const viewHash = typeof asRecord(event.view).hash === "string" ? String(asRecord(event.view).hash) : undefined;
      if (userId) await this.publishHome(teamId, userId, viewHash);
      return;
    }
    if (type === "app_context_changed") {
      const userId = authorizedUserId(envelope);
      if (userId) await this.storeActiveContext(teamId, userId, event.context ?? {});
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
    if (event.bot_id || event.subtype || !event.user || !event.channel || !event.ts) return;
    const slackUserId = String(event.user);
    const channelId = String(event.channel);
    const rootTs = typeof event.thread_ts === "string" ? event.thread_ts : String(event.ts);
    const botUserId = type === "app_mention"
      ? authorizedBotUserId(envelope) ?? await this.botUserId(await this.connectionForTeam(teamId))
      : null;
    const prompt = (botUserId
      ? String(event.text ?? "").replaceAll(`<@${botUserId}>`, "")
      : String(event.text ?? "")).trim();
    if (!prompt) return;
    if (/^(?:help|\/help)$/iu.test(prompt)) {
      const connection = await this.connectionForTeam(teamId);
      await slackApi(await this.botToken(connection), "chat.postMessage", {
        channel: channelId,
        thread_ts: rootTs,
        text: "Ask Avalon to investigate, summarize, coordinate, or create an automation. Use /avalon anywhere, a shortcut on a message, or Start a task in App Home. Open App Home to connect your Avalon account and manage notifications.",
      }, AbortSignal.timeout(5_000));
      return;
    }
    const activeContext = event.app_context ?? event.context;
    if (activeContext) await this.storeActiveContext(teamId, slackUserId, activeContext);
    const effectivePrompt = await this.augmentPromptWithSlackContext(teamId, slackUserId, event, prompt);
    await this.startFromPrompt(teamId, slackUserId, channelId, rootTs, effectivePrompt, `event:${envelope.event_id}`);
  }

  private async startFromPrompt(teamId: string, slackUserId: string, channelId: string | null, threadTs: string | null, prompt: string, clientMessageId: string): Promise<void> {
    const identity = await this.linkedIdentity(teamId, slackUserId);
    if (!identity) {
      const connection = await this.connectionForTeam(teamId);
      const token = await this.botToken(connection);
      const link = await this.createLink(connection, slackUserId);
      const dmChannel = await this.openDm(token, slackUserId);
      await slackApi(token, "chat.postMessage", { channel: dmChannel, text: `Connect your Avalon account to continue: ${link}` }, AbortSignal.timeout(5_000));
      if (channelId && channelId !== dmChannel) {
        await slackApi(token, "chat.postMessage", {
          channel: channelId,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          text: "I sent you a private message with the Avalon connection link.",
        }, AbortSignal.timeout(5_000));
      }
      return;
    }
    const channel = channelId ?? await this.openDm(identity.token, slackUserId);
    const thread = threadTs ?? await this.createUserPromptRoot(identity.token, channel, prompt);
    await slackApi(identity.token, "assistant.threads.setStatus", { channel_id: channel, thread_ts: thread, status: "Working…" }, AbortSignal.timeout(5_000));
    let session = await this.env.DB.prepare(
      `SELECT * FROM slack_agent_sessions WHERE connection_id = ? AND slack_channel_id = ? AND slack_thread_ts = ?`,
    ).bind(identity.connection.id, channel, thread).first<SlackSessionRow>();
    const service = new WorkstreamService(this.env, identity.auth);
    if (session) {
      await service.createMessage(session.workstream_id, { text: prompt, clientMessageId: clientMessageId.slice(0, 120), mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] });
    } else {
      const claimId = await this.claimThread(identity.connection.id, channel, thread);
      if (!claimId) {
        session = await this.waitForSession(identity.connection.id, channel, thread);
        if (!session) throw new ApiError(503, "slack_thread_busy", "This Slack thread is still being initialized");
        await service.createMessage(session.workstream_id, { text: prompt, clientMessageId: clientMessageId.slice(0, 120), mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] });
      } else {
        try {
          session = await this.env.DB.prepare(
            `SELECT * FROM slack_agent_sessions WHERE connection_id = ? AND slack_channel_id = ? AND slack_thread_ts = ?`,
          ).bind(identity.connection.id, channel, thread).first<SlackSessionRow>();
          if (session) {
            await service.createMessage(session.workstream_id, { text: prompt, clientMessageId: clientMessageId.slice(0, 120), mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] });
          } else {
            const created = await service.create({ title: prompt.split(/\r?\n/u)[0]!.slice(0, 180), objective: prompt.slice(0, 4_000), participantUserIds: [], openingMessage: prompt, clientMessageId: clientMessageId.slice(0, 120) });
            const sessionId = newId();
            await this.env.DB.prepare(
              `INSERT INTO slack_agent_sessions
               (id, workspace_id, connection_id, user_id, slack_team_id, slack_user_id,
                slack_channel_id, slack_thread_ts, workstream_id, context_json, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
            ).bind(sessionId, identity.auth.workspaceId, identity.connection.id, identity.auth.userId, teamId, slackUserId, channel, thread, created.workstream.id, nowIso(), nowIso()).run();
            session = await this.env.DB.prepare("SELECT * FROM slack_agent_sessions WHERE id = ?").bind(sessionId).first<SlackSessionRow>();
            try {
              await slackApi(identity.token, "assistant.threads.setTitle", { channel_id: channel, thread_ts: thread, title: prompt }, AbortSignal.timeout(5_000));
            } catch (error) {
              console.warn("Slack thread title failed", { session_id: sessionId, reason: error instanceof Error ? error.message : "unknown" });
            }
          }
        } finally {
          await this.releaseThreadClaim(identity.connection.id, channel, thread, claimId);
        }
      }
    }
    if (session && !session.slack_stream_ts) {
      try {
        const started = await slackApi(identity.token, "chat.startStream", { channel, thread_ts: thread, markdown_text: "", recipient_user_id: slackUserId, recipient_team_id: teamId, task_display_mode: "plan" }, AbortSignal.timeout(5_000));
        if (typeof started.ts === "string") await this.env.DB.prepare("UPDATE slack_agent_sessions SET slack_stream_ts = ?, updated_at = ? WHERE id = ?").bind(started.ts, nowIso(), session.id).run();
      } catch {
        // A final ordinary thread reply is the compatibility fallback.
      }
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
          `SELECT w.id, w.title, w.harness_status FROM workstreams w
           JOIN workstream_participants p ON p.workstream_id = w.id
           WHERE w.workspace_id = ? AND p.user_id = ? AND p.removed_at IS NULL
             AND w.archived_at IS NULL
           ORDER BY CASE w.harness_status WHEN 'needs_input' THEN 0 WHEN 'running' THEN 1 ELSE 2 END,
             w.last_activity_at DESC LIMIT 6`,
        ).bind(connection.workspace_id, link.user_id).all<Record<string, unknown>>(),
        this.env.DB.prepare(
          `SELECT s.id, t.name, s.status, s.next_run_at FROM automation_subscriptions s
           JOIN automation_templates t ON t.id = s.template_id
           WHERE s.workspace_id = ? AND s.owner_user_id = ? ORDER BY s.updated_at DESC LIMIT 5`,
        ).bind(connection.workspace_id, link.user_id).all<Record<string, unknown>>(),
        this.env.DB.prepare(
          `SELECT display_name, status FROM connector_connections
           WHERE workspace_id = ? AND connector_type = 'slack' AND scope = 'personal'
             AND owner_user_id = ? AND provider_account_id LIKE ? AND status <> 'disabled'
           ORDER BY updated_at DESC LIMIT 1`,
        ).bind(connection.workspace_id, link.user_id, `${teamId}:%`).first<{ display_name: string; status: string }>(),
      ]);
      blocks = linkedHome(
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

  private async storeActiveContext(teamId: string, slackUserId: string, context: unknown): Promise<void> {
    const connection = await this.connectionForTeam(teamId);
    await this.env.DB.prepare(
      `INSERT INTO slack_agent_contexts (connection_id, slack_user_id, context_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(connection_id, slack_user_id) DO UPDATE SET
         context_json = excluded.context_json, updated_at = excluded.updated_at`,
    ).bind(connection.id, slackUserId, JSON.stringify(context), nowIso()).run();
  }

  private async augmentPromptWithSlackContext(
    teamId: string,
    slackUserId: string,
    event: Record<string, unknown>,
    prompt: string,
  ): Promise<string> {
    const actionToken = typeof event.action_token === "string" ? event.action_token : null;
    if (!/\b(this|that|current|here|above|viewing|channel|thread|conversation)\b/iu.test(prompt)) return prompt;
    const connection = await this.connectionForTeam(teamId);
    if (actionToken) {
      try {
        const result = await slackApi(await this.botToken(connection), "assistant.search.context", {
          query: prompt,
          action_token: actionToken,
          channel_types: ["public_channel"],
          content_types: ["messages", "files", "channels", "users"],
        }, AbortSignal.timeout(8_000));
        return `${prompt}\n\n<slack_context trust="untrusted" source="assistant.search.context">${safeJson(result)}</slack_context>`;
      } catch {
        // The latest App context remains a useful fallback when search context is unavailable.
      }
    }
    const stored = await this.env.DB.prepare(
      "SELECT context_json FROM slack_agent_contexts WHERE connection_id = ? AND slack_user_id = ?",
    ).bind(connection.id, slackUserId).first<{ context_json: string }>();
    return stored?.context_json
      ? `${prompt}\n\n<slack_context trust="untrusted" source="app_context">${safeJson(JSON.parse(stored.context_json))}</slack_context>`
      : prompt;
  }

  private async unfurlAvalonLinks(teamId: string, event: Record<string, unknown>): Promise<void> {
    const channel = typeof event.channel === "string" ? event.channel : null;
    const ts = typeof event.message_ts === "string" ? event.message_ts : null;
    const links = Array.isArray(event.links) ? event.links.filter((link): link is Record<string, unknown> => Boolean(link) && typeof link === "object") : [];
    if (!channel || !ts || links.length === 0) return;
    const connection = await this.connectionForTeam(teamId);
    const unfurls: Record<string, unknown> = {};
    for (const link of links) {
      if (typeof link.url !== "string") continue;
      const url = new URL(link.url);
      if (url.origin !== new URL(this.env.PUBLIC_WEB_BASE_URL).origin) continue;
      const match = /^\/workstreams\/([0-9a-f-]{36})$/iu.exec(url.pathname);
      if (!match) continue;
      unfurls[link.url] = { blocks: [{ type: "section", text: { type: "mrkdwn", text: "*Avalon*\nOpen this item in Avalon to view it with your existing workspace permissions." } }, { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open in Avalon" }, url: desktopHandoffUrl(this.env.PUBLIC_WEB_BASE_URL, `avalon://workstreams/${match[1]}`), action_id: "avalon_open_unfurl" }] }] };
    }
    if (Object.keys(unfurls).length) await slackApi(await this.botToken(connection), "chat.unfurl", { channel, ts, unfurls }, AbortSignal.timeout(5_000));
  }

  private async linkedIdentity(teamId: string, slackUserId: string): Promise<SlackIdentity | null> {
    const linked = await this.linkedAccount(teamId, slackUserId);
    return linked ? { ...linked, token: await this.botToken(linked.connection) } : null;
  }

  private async linkedAccount(teamId: string, slackUserId: string): Promise<SlackLinkedAccount | null> {
    const row = await this.env.DB.prepare(
      `SELECT l.user_id, l.workspace_id, l.connection_id, wm.role, wm.status AS member_status,
              cc.provider_account_id, cc.encrypted_credentials, cc.credential_iv, cc.status
       FROM slack_user_links l
       JOIN connector_connections cc ON cc.id = l.connection_id
       JOIN workspace_members wm ON wm.workspace_id = l.workspace_id AND wm.user_id = l.user_id
       WHERE l.slack_team_id = ? AND l.slack_user_id = ? AND l.status = 'active'
         AND cc.connector_type = 'slack' AND cc.scope = 'workspace' AND cc.status = 'healthy'`,
    ).bind(teamId, slackUserId).first<Record<string, unknown>>();
    if (!row || row.member_status !== "active") return null;
    const connection: SlackConnectionRow = { id: String(row.connection_id), workspace_id: String(row.workspace_id), provider_account_id: String(row.provider_account_id), encrypted_credentials: String(row.encrypted_credentials), credential_iv: String(row.credential_iv), status: String(row.status) };
    return { auth: { sessionId: `slack:${teamId}:${slackUserId}`, userId: String(row.user_id), workspaceId: String(row.workspace_id), region: this.env.AVALON_REGION, role: String(row.role) as AuthContext["role"] }, connection, slackUserId, teamId };
  }

  private async connectionForTeam(teamId: string): Promise<SlackConnectionRow> {
    const row = await this.env.DB.prepare(
      `SELECT id, workspace_id, provider_account_id, encrypted_credentials, credential_iv, status
       FROM connector_connections
       WHERE connector_type = 'slack' AND scope = 'workspace' AND provider_account_id = ? AND status <> 'disabled'`,
    ).bind(teamId).first<SlackConnectionRow>();
    if (!row) throw new ApiError(404, "slack_installation_not_found", "Slack workspace is not connected to Avalon");
    return row;
  }

  private async connectionById(id: string): Promise<SlackConnectionRow> {
    const row = await this.env.DB.prepare(
      `SELECT id, workspace_id, provider_account_id, encrypted_credentials, credential_iv, status
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
      await decryptString(connection.encrypted_credentials, connection.credential_iv, this.env.CONNECTOR_CREDENTIALS_KEY, connection.id),
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
      await decryptString(row.encrypted_credentials, row.credential_iv, this.env.CONNECTOR_CREDENTIALS_KEY, additionalData),
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
      console.warn("Slack route deactivation after revocation failed", {
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

function startTaskModal(initial: string): Record<string, unknown> {
  return { type: "modal", callback_id: "avalon_start_task_submit", title: { type: "plain_text", text: "Start an Avalon task" }, submit: { type: "plain_text", text: "Start" }, close: { type: "plain_text", text: "Cancel" }, blocks: [{ type: "input", block_id: "prompt", label: { type: "plain_text", text: "What should Avalon do?" }, element: { type: "plain_text_input", action_id: "value", multiline: true, initial_value: initial.slice(0, 3_000), placeholder: { type: "plain_text", text: "Summarize this, investigate an issue, or coordinate work…" } } }] };
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
    { type: "section", text: { type: "mrkdwn", text: "Connect your Avalon account to start and continue durable tasks from Slack. Avalon only reads Slack context when you ask it to; it does not mirror or scrape your workspace." } },
    { type: "actions", elements: [{ type: "button", style: "primary", text: { type: "plain_text", text: "Connect Avalon" }, url: link, action_id: "avalon_connect" }] },
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: "*Try after connecting*\n• Summarize this thread and propose next steps\n• Check my Gmail every morning and send my top 3 emails here\n• Investigate this issue and keep me posted" } },
    { type: "context", elements: [{ type: "mrkdwn", text: "Avalon Agent features require paid Slack and Avalon plans." }] },
    { type: "context", elements: [{ type: "mrkdwn", text: "AI can make mistakes. Review important actions. <https://with-avalon.com/privacy|Privacy> · <https://with-avalon.com/support|Help>" }] },
  ];
}

function linkedHome(name: string, tasks: Record<string, unknown>[], automations: Record<string, unknown>[], webBase: string, personalSlack: { display_name: string; status: string } | null, administration: { teamId: string; status: string } | null): Record<string, unknown>[] {
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
    const status = task.harness_status === "needs_input"
      ? ":warning: Needs your input"
      : task.harness_status === "running"
        ? ":large_green_circle: Running"
        : `Recent · ${escapeMrkdwn(String(task.harness_status).replaceAll("_", " "))}`;
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*<${desktopHandoffUrl(webBase, `avalon://workstreams/${String(task.id)}`)}|${escapeMrkdwn(String(task.title))}>*\n${status}` } });
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

function responseActionBlocks(workstreamId: string, webBase: string): Record<string, unknown>[] {
  return [{ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open task" }, url: desktopHandoffUrl(webBase, `avalon://workstreams/${workstreamId}`), action_id: "avalon_open_task" }, { type: "button", text: { type: "plain_text", text: "Give feedback" }, action_id: "avalon_feedback", value: workstreamId }] }];
}

function automationActionBlocks(title: string, workstreamId: string, webBase: string): Record<string, unknown>[] {
  return [{ type: "header", text: { type: "plain_text", text: title.slice(0, 150) } }, { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open full result" }, url: desktopHandoffUrl(webBase, `avalon://workstreams/${workstreamId}`), action_id: "avalon_open_automation_result" }] }];
}

function desktopHandoffUrl(webBase: string, target: string): string {
  const url = new URL("/open", webBase);
  url.hash = new URLSearchParams({ target }).toString();
  return url.toString();
}

function shouldSuppressAutomationResult(text: string): boolean {
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

function authorizedUserId(envelope: SlackIngressEnvelope): string | null {
  const matches = (envelope.authorizations ?? []).filter((authorization) =>
    authorization.team_id === envelope.team_id
      && typeof authorization.user_id === "string"
      && authorization.user_id,
  );
  const authorization = matches.find((candidate) => candidate.is_bot !== true) ?? matches[0];
  return authorization ? String(authorization.user_id) : null;
}

function authorizedBotUserId(envelope: SlackIngressEnvelope): string | null {
  for (const authorization of envelope.authorizations ?? []) {
    if (authorization.team_id !== envelope.team_id || authorization.is_bot !== true) continue;
    if (typeof authorization.user_id === "string" && authorization.user_id) return authorization.user_id;
  }
  return null;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function escapeMrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
