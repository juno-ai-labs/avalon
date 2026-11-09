import type { Region } from "@rally/contracts/regions";
import type { AdmitExternalMessageInput } from "../durable-objects/workstream-external-message-protocol";
import {
  ConnectorError,
  joinSlackPublicChannel,
  normalizeSlackActivity,
  slackInstallationId,
  slackMessagePath,
  parseSlackAgentInvocation,
  parseSlackEventEnvelope,
  resolveSlackReactions,
  slackApi,
  slackActivityEventType,
  slackMarkdownMessages,
  SLACK_DEFAULT_REACTIONS,
  type ConnectorConnectionContext,
  type SlackAgentReactionCommand,
  type SlackAgentReactionResult,
  type SlackIngressEnvelope,
} from "@rally/connectors";
import {
  AutomationSummarySchema,
  ExternalActorSchema,
  SlackOriginContextSchema,
  asWorkstreamId,
  SlackIngressQueueMessageSchema,
  LEGACY_LINK_ORIGINS,
  asUserId,
  asWorkspaceId,
  addWorkspaceTarget,
  sidekickCanonicalUrl,
  type AutomationSummary,
  type ExternalActor,
  type SlackOriginAttachment,
  type SlackOriginNearbyMessage,
} from "@rally/contracts";
import { codeShaped, describeZodIssues, isCodeShaped } from "@rally/contracts/zod-diagnostics";
import { HttpsUrlSchema, httpsUrlSchema } from "@rally/contracts/url-schemas";
import { newId, nowIso } from "@rally/db";
import {
  TERMINAL_UNFURL_REASONS,
  linkUnfurlBlocks,
  slackChannelIsExternallyShared,
  slackUnfurlLinkTargets,
} from "./slack-workstream-card";
import { z } from "zod";
import type { AuthContext, Env } from "../env";
import { workspaceDOName } from "../durable-objects/names";
import { ApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { diagnosticErrorCode, logError, logInfo, logWarn, type LogEnv } from "../observability/logger";
import { notifyOps } from "../observability/ops-slack-notifier";
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

import { admitExternalWorkstreamMessage } from "./workstream-service";

import {
  withWorkspaceRuntimeDatabase,
  workspaceRegionalDatabase,
} from "./workspace-runtime-database";
import {
  SLACK_INGRESS_ATTEMPT_LIMIT,
  SLACK_SIDEKICK_SOURCE_JOIN_EVENT,
  WorkspaceSlackIngressClaimResultSchema,
  WorkspaceSlackIngressEnqueueResultSchema,
  WorkspaceSlackIngressFailResultSchema,
  WorkspaceSlackIngressRecoverableResultSchema,
  WorkspaceSlackIngressSweepResultSchema,
  WorkspaceSlackThreadRoutableResultSchema,
} from "../durable-objects/workspace-slack-protocol";
import {
  ExternalBindingLatestOutboundResultSchema,
  ExternalBindingMoveResultSchema,
  ExternalBindingResolutionSchema,
  ExternalBindingSuspendResultSchema,
  type ExternalBindingConversationTarget,
  type ExternalBindingResolution,
  type ExternalBindingSuspensionReason,
} from "../durable-objects/workspace-external-binding-protocol";

import { SLACK_THREAD_CLAIM_LEASE_MS } from "../durable-objects/workspace-slack-storage";

import { hostedParentStub } from "./conversation-parent-client";
import { sendInteractive } from "./interactive-queue";

interface SlackConnectionRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  provider_account_id: string;
  encrypted_credentials: string;
  credential_iv: string;
  credential_key_version?: number;
  granted_scopes_json: string;
  /** Free-form connector configuration; carries the reaction override. */
  config_json?: string;
  status: string;
}

interface SlackLinkedAccount {
  auth: AuthContext;
  connection: SlackConnectionRow;
  slackUserId: string;
  teamId: string;
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
  /**
   * False for a conversation Slack marks `is_non_threadable`: every Rally
   * message there is top-level, and the Agent thread APIs are not called.
   */
  threadable?: boolean;
};

const SlackModalContextSchema = z.strictObject({
  kind: z.enum(["shortcut", "slash_command"]),
  channelType: z.enum(["public", "private", "im", "unknown"]),
  channelResolutionFailure: z.enum(["missing_scope", "lookup_failed"]).nullable().optional().default(null),
  channelId: z.string().min(1).nullable(),
  channelName: z.string().min(1).max(255).nullable().optional().default(null),
  threadTs: z.string().min(1).nullable(),
  messageTs: z.string().min(1).nullable().optional().default(null),
  attachments: z.array(z.strictObject({
    id: z.string().min(1).max(255).nullable(),
    name: z.string().min(1).max(500),
    title: z.string().max(500).nullable(),
    mimeType: z.string().max(255).nullable(),
    fileType: z.string().max(120).nullable(),
    permalink: httpsUrlSchema(2000).nullable(),
  })).max(10).optional().default([]),
});

/**
 * How long a spent link challenge — expired or consumed — is kept.
 *
 * Long enough that a late click is refused with its reason
 * (`slack_link_expired`, `slack_link_consumed`) rather than as a link Avalon
 * has never seen, and nothing more: the hash is single-use and the row holds
 * no other value. The workspace alarm counts a challenge as due at exactly
 * this horizon (`workspace-schedule-execution.ts`, the `slack_ingress` arm);
 * the two must agree, because a reap that leaves behind what the schedule
 * counts is the hot loop of 2026-08-22.
 */
export const SLACK_LINK_CHALLENGE_GRACE_MS = 24 * 60 * 60_000;
/**
 * How long one installation's exhausted jobs count as one episode.
 *
 * A broken installation fails every event it receives the same way — the
 * `session_revoked` of 2026-08-22 killed each `@Avalon` mention on its first
 * attempt — and a notice per job would track the channel's message volume for
 * as long as the installation stayed broken. One notice per connection and
 * error code within this window is the episode; every job still writes its
 * own `error` row.
 */
const SLACK_EXHAUSTION_NOTICE_WINDOW_MS = 60 * 60_000;
/**
 * The `error_code` values a job carries when it failed on authorization, and so
 * the only ones a later reauthorization can plausibly repair.
 *
 * Written as an allowlist rather than "anything that failed", so a job that died
 * on malformed data is not re-driven every time its connection's token rotates.
 * The values are what `slackIngressErrorCode` produces: Slack's own
 * authorization vocabulary as `details.error`, the bare `unauthorized` of a
 * `ConnectorError` that carries no provider word, and the one `ApiError` code
 * raised when a stored token is absent. A code outside the set simply is not
 * re-driven, which is the conservative direction.
 */
const SLACK_AUTHORIZATION_ERROR_CODES = [
  "account_inactive",
  "invalid_auth",
  "invalid_refresh_token",
  "missing_scope",
  "not_authed",
  "slack_token_missing",
  "token_expired",
  "token_revoked",
  "unauthorized",
] as const;
const SLACK_RETRYABLE_DENIAL_PREFIXES = [
  "Rally needs updated Slack permissions before it can start workspace tasks here",
  "Rally couldn’t verify whether this Slack channel is public or private",
  "Avalon’s Slack workspace connection needs attention",
  "Avalon workspace tasks are not enabled for this Slack surface",
  "Avalon needs updated Slack permissions before it can start workspace tasks here",
  "Avalon couldn’t verify whether this Slack channel is public or private",
] as const;

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

/** The prefix every Slack action id and modal callback id is minted with. */
const SLACK_INTERACTION_PREFIX = "rally_";

/**
 * Prefixes still honoured inbound, and deliberately never emitted.
 *
 * A Slack action id is not a request header: it is baked into a surface that
 * persists on Slack's side. An App Home view published before a deploy, a
 * posted message with a button, and a modal already on someone's screen all
 * keep the id they were minted with, and Slack echoes it back on the click. So
 * the rename is only safe if the superseded spelling keeps resolving —
 * otherwise every one of those buttons silently falls past its branch and
 * opens the generic task modal instead.
 *
 * Removed once no surface minted before the rename can still be clicked, which
 * is a fact about Slack's retained views rather than about this repository.
 */
const SUPERSEDED_SLACK_INTERACTION_PREFIXES: readonly string[] = Object.freeze([
  "avalon_",
]);

/**
 * An inbound action or callback id in its canonical spelling, so every branch
 * below compares against one form. Anything not carrying a known prefix is
 * returned unchanged and falls through as it did before.
 */
function canonicalSlackInteractionId(value: string): string {
  for (const prefix of SUPERSEDED_SLACK_INTERACTION_PREFIXES) {
    if (value.startsWith(prefix)) {
      return `${SLACK_INTERACTION_PREFIX}${value.slice(prefix.length)}`;
    }
  }
  return value;
}

/**
 * The block actions that do something. Every other one — a `url` button
 * (`rally_open_*`, **Create Sidekick**), which Slack follows itself, or a
 * button a superseded view still shows — is acknowledged and ignored.
 */
const SLACK_HANDLED_BLOCK_ACTIONS: ReadonlySet<string> = new Set(["rally_connect", "rally_preferences", "rally_feedback"]);

export class SlackAgentService {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * After an installation is authorized again, bring back the bindings its
   * disconnect suspended. Rally no longer joins public channels on
   * installation: it appears only where it is invited, and where a Slack
   * automation source names a conversation.
   */
  async reactivateInstallationBindings(connectionId: string): Promise<void> {
    await this.reactivateBindingsFor(await this.connectionById(connectionId), "reauthorized");
  }

  private async reactivateBindingsFor(
    connection: SlackConnectionRow,
    trigger: "reauthorized" | "event_received",
  ): Promise<void> {
    const reactivated = ExternalBindingSuspendResultSchema.parse(
      await (await this.workspaceDirectory(connection.workspace_id)).reactivateExternalConversationBindings({
        workspaceId: connection.workspace_id,
        installationId: slackInstallationId(connection.provider_account_id),
        at: nowIso(),
      }),
    );
    if (reactivated.suspended.length > 0) {
      logInfo(this.env, "external_bindings_reactivated", {
        connection_id: connection.id,
        trigger,
        count: reactivated.suspended.length,
      });
    }
  }

  async maintainIngress(workspaceId: string, limit = 100): Promise<void> {
    // Required, and required by the compiler: the recovery scan and the sweep
    // are typed WorkspaceDO methods, and there is no object to ask without
    // knowing whose it is. This took the id as a trailing optional with a
    // runtime throw behind it, which is a guard no caller can reach and no
    // test can cover; `tsc` gives the same guarantee at build time instead.
    this.env = withWorkspaceRuntimeDatabase(this.env, workspaceId);
    await this.prewarmWorkspaceCredentials();
    const at = nowIso();
    await this.redriveReauthorizedIngress(limit);
    const staleBefore = new Date(Date.now() - 2 * 60_000).toISOString();
    const workspace = await this.workspaceDirectory(workspaceId);
    const recoverable = WorkspaceSlackIngressRecoverableResultSchema.parse(
      await workspace.recoverableSlackIngressJobs({ workspaceId, staleBefore, at, limit }),
    );
    for (const jobId of recoverable.jobIds) {
      try {
        await sendInteractive(this.env, SlackIngressQueueMessageSchema.parse({
          kind: "slack_ingress",
          region: this.env.AVALON_REGION,
          workspaceId,
          jobId,
        }));
      } catch (error) {
        logWarn(this.env, "slack_ingress_recovery_enqueue_failed", {
          job_id: jobId,
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
    }
    const retentionCutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
    // `spentBefore` is bound to the grace horizon, not `retentionCutoff`. The
    // workspace alarm counts a challenge as due a day after it was spent, so
    // the sweep has to remove exactly what that expression counts, the way the
    // claim and pending-prompt reaps do. Holding a challenge for the 30-day
    // retention instead left every expired 15-minute token "due" for a month,
    // and the alarm hot-looped on the gap (2026-08-22, ~1.5 fires a second for
    // hours).
    const spentBefore = new Date(Date.now() - SLACK_LINK_CHALLENGE_GRACE_MS).toISOString();
    const swept = WorkspaceSlackIngressSweepResultSchema.parse(
      await workspace.sweepSlackIngress({
        workspaceId,
        at,
        retentionCutoff,
        spentBefore,
        exhaustedReportLimit: limit,
      }),
    );
    // One row per pass. The moment a job exhausts is logged at `error` and
    // reported by `processQueuedIngress`; this is the standing count, and one
    // error row per job per pass is what buried the 2026-08-22 incident under
    // fifty thousand lines an hour.
    if (swept.exhausted.length > 0) {
      logWarn(this.env, "slack_ingress_exhausted_jobs", {
        count: swept.exhausted.length,
        job_ids: swept.exhausted.slice(0, 10).map((job) => job.jobId),
        error_codes: [...new Set(swept.exhausted.map((job) => job.errorCode ?? "unknown"))],
      });
    }
  }

  /**
   * Give a job that failed on authorization another run once the installation
   * has been reauthorized.
   *
   * An authorization failure is classified non-retryable and pins
   * `attempt_count` at the ceiling, which is right while the grant is dead —
   * but nothing ever lifted it. The events that arrived during an outage stayed
   * failed forever with their payload still on the row, and the recovery sweep
   * skipped them by the same ceiling that stopped the pointless retries. A
   * member who reconnected got no repair, only silence: a `link_shared` Slack
   * reports exactly once is not redelivered, so the message keeps its bare URL
   * permanently.
   *
   * Two conditions, and both are load-bearing. `c.status = 'healthy'` is the
   * reauthorization signal: only the OAuth commit and an explicit connection
   * test return a marked row to healthy, and every marking write requires
   * `status = 'healthy'`, so a row that is still broken cannot be written back
   * into the selection set by its own failures. `c.updated_at > j.updated_at`
   * then narrows it to jobs that failed *before* that recovery.
   *
   * Together they terminate by construction. A re-driven job that fails again
   * either marks the row — which removes it from `healthy` and empties the set
   * — or leaves the row alone, in which case the job's own newer `updated_at`
   * excludes it. An earlier draft selected on `updated_at` alone against any
   * non-disabled row, which does not terminate: every failure bumped the
   * connection's `updated_at` through the marking write, so N stranded jobs
   * re-drove each other forever, on a signal that meant "something failed
   * again" rather than "someone reconnected".
   *
   * Bounded by age as well. Replaying a `link_shared` from three weeks ago
   * unfurls a message nobody is looking at, and Slack may refuse it outright;
   * a day is past the length of the outage this was written for.
   */
  private static readonly REDRIVE_MAX_AGE_MS = 24 * 60 * 60_000;

  private async redriveReauthorizedIngress(limit: number): Promise<void> {
    const redriven = await this.env.DB.prepare(
      `UPDATE slack_ingress_jobs SET status = 'queued', attempt_count = 0,
         lease_id = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id IN (
         SELECT j.id FROM slack_ingress_jobs j
         JOIN connector_connections c ON c.id = j.connection_id
         WHERE j.payload_json IS NOT NULL AND j.status = 'failed'
           AND j.attempt_count >= ${SLACK_INGRESS_ATTEMPT_LIMIT} AND j.error_code IN (${SLACK_AUTHORIZATION_ERROR_CODES.map(() => "?").join(", ")})
           AND j.received_at > ?
           AND c.status = 'healthy' AND c.updated_at > j.updated_at
         ORDER BY j.received_at ASC LIMIT ?
       )
       RETURNING id, workspace_id`,
    ).bind(
      nowIso(),
      ...SLACK_AUTHORIZATION_ERROR_CODES,
      new Date(Date.now() - SlackAgentService.REDRIVE_MAX_AGE_MS).toISOString(),
      limit,
    ).all<{ id: string; workspace_id: string }>();
    for (const job of redriven.results ?? []) {
      try {
        await sendInteractive(this.env, SlackIngressQueueMessageSchema.parse({
          kind: "slack_ingress",
          region: this.env.AVALON_REGION,
          workspaceId: job.workspace_id,
          jobId: job.id,
        }));
      } catch (error) {
        logWarn(this.env, "slack_ingress_redrive_enqueue_failed", {
          job_id: job.id,
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
    }
    if (redriven.results?.length) {
      logInfo(this.env, "slack_ingress_redriven_after_reauthorization", { count: redriven.results.length });
    }
  }

  private async prewarmWorkspaceCredentials(): Promise<void> {
    let afterId = "";
    while (true) {
      const page = await this.env.DB.prepare(
        `SELECT id, workspace_id, provider_account_id, encrypted_credentials, credential_iv, credential_key_version,
                granted_scopes_json, config_json, status
         FROM connector_connections
         WHERE connector_type = 'slack' AND scope = 'workspace' AND status <> 'disabled' AND id > ?
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
    const lifecycleType = SLACK_BINDING_LIFECYCLE_EVENTS.has(String(invocation.event.type ?? ""));
    if (lifecycleType || (activityEventType
      && invocation.event.type !== "message"
      && invocation.event.type !== "app_mention")) {
      const connection = await this.connectionForTeam(invocation.teamId);
      const botUserId = authorizedBotUserId(envelope) ?? await this.botUserId(connection);
      // The bot joining or leaving, and a room archived or renumbered, move a
      // binding whatever any automation subscribes to, so they are queued
      // before the subscription gate and the bot's own-actor filter.
      if (lifecycleType && slackBindingLifecycleApplies(invocation.event, botUserId)) {
        return this.enqueueIngressJob({
          id: `event:${invocation.eventId}`,
          teamId: invocation.teamId,
          bodyHash,
          kind: "event",
          payload: envelope,
        });
      }
      if (!activityEventType) return { ok: true };
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
      if (canonicalSlackInteractionId(String(view.callback_id ?? "")) === "rally_start_task_submit") {
        const prompt = modalPrompt(view.state);
        if (!prompt) return { response_action: "errors", errors: { prompt: "Describe what Rally should do." } };
        if (!modalPromptSource(view.private_metadata)) {
          return {
            response_action: "errors",
            errors: { prompt: "This Slack task context expired. Close this window and start the task again." },
          };
        }
        await this.enqueueIngressJob({ id: `interaction:${bodyHash}`, teamId, bodyHash, kind: "interaction", payload });
        return { response_action: "clear" };
      }
      if (canonicalSlackInteractionId(String(view.callback_id ?? "")) === "rally_preferences_submit") {
        if (!await this.linkedAccount(teamId, slackUserId)) return { response_action: "errors", errors: { delivery: "Connect your Rally account first." } };
        await this.enqueueIngressJob({ id: `interaction:${bodyHash}`, teamId, bodyHash, kind: "interaction", payload });
        return { response_action: "clear" };
      }
      if (canonicalSlackInteractionId(String(view.callback_id ?? "")) === "rally_feedback_submit") {
        // Every task this modal rated was a Thread's Slack session, and both
        // are retired: no session is written any more, so a modal opened from
        // an old card has nothing left to rate.
        return { response_action: "errors", errors: { rating: "This task is no longer available." } };
      }
      return {};
    }

    const action = Array.isArray(payload.actions) && payload.actions[0] && typeof payload.actions[0] === "object"
      ? payload.actions[0] as Record<string, unknown>
      : null;
    // Every one of Avalon's own buttons is matched on the action id, and none
    // on `payload.callback_id`. A block action raised from inside a view can
    // carry that view's callback id, which would shadow the button's own — a
    // connect button placed in a modal would miss its branch and fall through
    // to the shortcut path, and a handoff button would open a task modal on top
    // of the link it just followed. The action id is the button, whatever it is
    // embedded in. Only the two manifest shortcuts reach the task modal below;
    // a block action no branch names is acknowledged and does nothing, so a
    // button a superseded view still shows (App Home's retired **Start a
    // task**, `rally_start_task`) opens nothing.
    const actionId = canonicalSlackInteractionId(String(action?.action_id ?? ""));
    // Slack follows a `url` button's link itself, so the interaction it also
    // sends needs nothing but an acknowledgement, and neither does a stale
    // button. Decided before the installation is read: an ack needs no token.
    if (type === "block_actions" && !SLACK_HANDLED_BLOCK_ACTIONS.has(actionId)) return {};
    if ((type === "shortcut" || type === "message_action" || type === "block_actions") && triggerId) {
      const connection = await this.connectionForTeam(teamId);
      const token = await this.botTokenForTrigger(connection);
      if (actionId === "rally_connect") {
        // No status gate. Reaching here means the bot token just opened a
        // Slack view, so the installation demonstrably works; refusing to mint
        // a link on a stored belief sent a member to ask an admin to fix
        // something that was not broken. If the grant really is dead,
        // `createLink` and the `views.open` below fail on Slack's word.
        // The click is the mint. Slack signed this payload and named the member
        // in it, which is the same authority App Home had when it published the
        // button — but a challenge issued now is redeemed seconds later instead
        // of however long the view has been on screen.
        const challenge = await this.createLink(connection, slackUserId);
        await slackApi(token, "views.open", {
          trigger_id: triggerId,
          view: connectModal(challenge.url),
        }, AbortSignal.timeout(1_500));
        await this.supersedeLinksMintedBefore(connection.id, slackUserId, challenge.createdAt);
        return {};
      }
      if (actionId === "rally_preferences") {
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
      if (actionId === "rally_feedback") {
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
      return { response_type: "ephemeral", text: "Opening Rally…" };
    }
    if (/^help$/iu.test(commandForm.text.trim())) {
      // What the command does now: nothing it is asked starts work.
      return { response_type: "ephemeral", text: "Rally no longer starts work from Slack. Start a Canvas in Rally, or set up a Sidekick to work from Slack for you. Open Rally's App Home to connect your account, see your Sidekicks and what they are waiting on, and manage notifications." };
    }
    await this.enqueueIngressJob({ id: `command:${bodyHash}`, teamId, bodyHash, kind: "command", payload: commandForm });
    return { response_type: "ephemeral", text: "Rally queued your request. I’ll continue in your Agent conversation." };
  }

  async processQueuedIngress(workspaceId: string, jobId: string): Promise<void> {
    this.env = withWorkspaceRuntimeDatabase(this.env, workspaceId);
    const workspace = await this.workspaceDirectory(workspaceId);
    // The claim's attempt ceiling and lease live in the object: a job at the
    // ceiling is not claimable — the Queue redelivers a message whose
    // processing threw, and without that bound every redelivery re-ran a dead
    // job, pinned it again, and reported it again. Only the reauthorization
    // re-drive, which resets the count, brings one back. A worker that died
    // mid-attempt (`processing`, lease expired) is reclaimed regardless,
    // because its attempt was never recorded as a failure.
    const claim = WorkspaceSlackIngressClaimResultSchema.parse(
      await workspace.claimSlackIngressJob({ workspaceId, jobId, at: nowIso() }),
    );
    if (claim.outcome === "unavailable") return;
    const { job, leaseId } = claim;
    // Outside the `try`, as the row-shape parse it replaces was: a claimed job
    // with no payload is a defect that should hold its lease until it expires
    // rather than be settled as a failure it did not have.
    if (job.payloadJson === null) throw new Error("slack_ingress_payload_missing");
    try {
      const rawPayload: unknown = JSON.parse(job.payloadJson);
      if (job.kind === "event") {
        const envelope = parseSlackEventEnvelope(rawPayload, this.env.SLACK_APP_ID);
        await this.dispatchEvent(job.teamId, envelope, job.bodyHash);
      } else if (job.kind === "interaction") {
        await this.dispatchQueuedInteraction(SlackInteractionPayloadSchema.parse(rawPayload), job.jobId);
      } else {
        await this.dispatchQueuedCommand(SlackCommandFormSchema.parse(rawPayload));
      }
      await workspace.completeSlackIngressJob({ workspaceId, jobId, leaseId, at: nowIso() });
    } catch (error) {
      const retryable = slackIngressRetryable(error);
      if (slackReconnectRequired(error)) {
        await this.markSlackReconnectRequired(job.connectionId, slackErrorReason(error));
      }
      const code = slackIngressErrorCode(error);
      // The ceiling the recovery sweep and the claim stop at, so a job that
      // reaches it here is not coming back on its own: only a reauthorization
      // re-drive lifts it, or Slack delivering the event again. Two `@Avalon`
      // mentions died this way on 2026-08-22, and the only record was an
      // error row nobody was reading — hence the row, then the notice, in
      // that order. The failure write and the one-notice-per-episode check
      // are a single transaction in the object.
      const failed = WorkspaceSlackIngressFailResultSchema.parse(
        await workspace.failSlackIngressJob({
          workspaceId,
          jobId,
          leaseId,
          errorCode: code,
          retryable,
          exhaustionEpisodeStartedAt:
            new Date(Date.now() - SLACK_EXHAUSTION_NOTICE_WINDOW_MS).toISOString(),
          at: nowIso(),
        }),
      );
      if (failed.outcome === "failed" && failed.exhausted) {
        const fields = { workspace_id: workspaceId, job_id: jobId, kind: job.kind, code, retryable };
        logError(this.env, "slack_ingress_job_exhausted", fields);
        if (failed.firstExhaustionReport) {
          await notifyOps(this.env, {
            event: "slack_ingress_job_exhausted",
            summary: "A Slack event was given up on after its retry budget. Nothing will process it again unless the installation is reauthorized, which re-drives it, or Slack delivers the event afresh; fix the cause first. Further jobs on this installation failing the same way within the hour are logged but not reported again.",
            fields,
          });
        }
      }
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
    // The insert and its duplicate check are one transaction in the object,
    // decided by the row's own witness rather than the adapter's
    // `meta.changes` — the physical-write counter this repository forbids
    // deciding a logical outcome from.
    const admitted = WorkspaceSlackIngressEnqueueResultSchema.parse(
      await (await this.workspaceDirectory(connection.workspace_id)).enqueueSlackIngressJob({
        workspaceId: connection.workspace_id,
        jobId: input.id,
        connectionId: connection.id,
        teamId: input.teamId,
        bodyHash: input.bodyHash,
        kind: input.kind,
        payloadJson: JSON.stringify(input.payload),
        at,
      }),
    );
    if (admitted.outcome === "conflict") {
      throw new ApiError(409, "slack_ingress_conflict", "Slack reused an ingress identity with different content");
    }
    const duplicate = admitted.outcome === "replayed";
    if (admitted.outcome === "replayed" && admitted.status === "completed") {
      return { ok: true, duplicate: true };
    }
    const message = SlackIngressQueueMessageSchema.parse({
      kind: "slack_ingress",
      region: this.env.AVALON_REGION,
      workspaceId: connection.workspace_id,
      jobId: input.id,
    });
    try {
      await sendInteractive(this.env, message,
        input.queueDelaySeconds == null ? {} : { delaySeconds: input.queueDelaySeconds });
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
    if (payload.type !== "view_submission") return;
    const view = asRecord(payload.view);
    if (canonicalSlackInteractionId(String(view.callback_id ?? "")) === "rally_start_task_submit") {
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
      );
      return;
    }
    const identity = await this.linkedAccount(teamId, slackUserId);
    if (!identity) throw new ApiError(409, "slack_link_missing", "The Slack user link is no longer active");
    if (canonicalSlackInteractionId(String(view.callback_id ?? "")) === "rally_preferences_submit") {
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
  }

  private async dispatchQueuedCommand(form: z.infer<typeof SlackCommandFormSchema>): Promise<void> {
    await this.startFromPrompt(form.team_id, form.user_id, null, null, form.text.trim(), `command:${form.trigger_id}`);
  }

  /**
   * Deliberately absent: a personal Slack connection does **not** establish the
   * identity link.
   *
   * It was written that way — Slack ran the OAuth and named the user, which
   * reads like a stronger proof than a challenge Avalon minted — and it is
   * unsafe, because the connector OAuth callback is mounted before the auth
   * middleware (`app.ts`) and completes from its `state` alone. Nothing proves
   * the browser redeeming it belongs to the Avalon user in the `oauth_states`
   * row. A member can therefore start a personal flow, send the resulting
   * `slack.com` consent URL to a colleague, and have that colleague's genuine
   * click write `slack_user_links(workspace, connection, *sender*, *colleague's
   * Slack id*) `— after which the colleague's Slack messages resolve to the
   * sender's Avalon identity.
   *
   * The link challenge is the only artifact that carries a Slack-signed
   * statement of *who clicked*, so it stays the only thing that can mint a
   * link. One click still accomplishes both halves — the desktop continues from
   * the redeemed challenge into the personal authorization — but only in that
   * direction, because only that direction is authenticated at both ends.
   * Reinstating the reverse needs the connector OAuth start bound to its
   * initiating client the way `AuthService.beginIdentity` binds a desktop
   * attempt, which is a change to a pre-existing gap rather than to this one.
   */

  async linkUser(auth: AuthContext, token: string): Promise<{ linked: true; teamId: string; slackUserId: string }> {
    this.env = withWorkspaceRuntimeDatabase(this.env, auth.workspaceId);
    const tokenHash = await sha256(token);
    const challenge = await this.loadLinkChallenge(auth, tokenHash);
    const at = nowIso();
    let results: D1Result<Record<string, unknown>>[];
    try {
      results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE slack_link_challenges SET consumed_at = ?, consumed_by_user_id = ?
         WHERE token_hash = ? AND consumed_at IS NULL
         RETURNING token_hash`,
      ).bind(at, auth.userId, tokenHash),
      this.env.DB.prepare(
        `INSERT INTO slack_user_links
         (id, workspace_id, connection_id, user_id, slack_team_id, slack_user_id, status, created_at, updated_at)
         SELECT ?, cc.workspace_id, c.connection_id, ?, c.slack_team_id, c.slack_user_id, 'active', ?, ?
         FROM slack_link_challenges c
         JOIN connector_connections cc ON cc.id = c.connection_id
         WHERE c.token_hash = ? AND c.consumed_at = ? AND c.consumed_by_user_id = ?
           AND cc.workspace_id = ? AND cc.connector_type = 'slack'
           AND cc.scope = 'workspace' AND cc.status <> 'disabled'
         ON CONFLICT(workspace_id, connection_id, user_id) DO UPDATE SET
           slack_team_id = excluded.slack_team_id,
           slack_user_id = excluded.slack_user_id,
           status = 'active',
           updated_at = excluded.updated_at
         RETURNING workspace_id, user_id, slack_team_id, slack_user_id`,
      ).bind(newId(), auth.userId, at, at, tokenHash, at, auth.userId, auth.workspaceId),
      ]);
    } catch (error) {
      // Narrowly the unique violation. The looser `/constraint/` test this
      // replaced also matched FOREIGN KEY and NOT NULL failures, reporting a
      // genuine bug to the member as "already connected to another Avalon
      // user" — advice that can never resolve.
      if (isSlackUniqueConstraintError(error)) {
        throw new ApiError(409, "slack_identity_already_linked", "This Slack identity is already connected to another Rally user");
      }
      throw error;
    }
    const [claimed, linked] = results;
    if (!claimed || !linked) throw new ApiError(500, "slack_link_failed", "Slack could not be connected");
    const claimedRow = claimed.results[0];
    const linkedRow = linked.results[0];
    if (claimedRow?.token_hash !== tokenHash
      || linkedRow?.workspace_id !== auth.workspaceId
      || linkedRow.user_id !== auth.userId
      || linkedRow.slack_team_id !== challenge.slack_team_id
      || linkedRow.slack_user_id !== challenge.slack_user_id) {
      throw new ApiError(409, "slack_link_consumed", "This Slack connection link was already used or replaced by a newer one; click Connect Rally in Slack to get a new one");
    }
    await this.publishHome(String(challenge.slack_team_id), String(challenge.slack_user_id));
    return { linked: true, teamId: String(challenge.slack_team_id), slackUserId: String(challenge.slack_user_id) };
  }

  /**
   * Records the Slack identity a person who just joined holds, found by their
   * verified email, in the shared connector directory. It does not create a
   * personal Slack connection. It used to also seat the person on the Slack
   * sessions that identity opened; those were Threads' sessions, and nothing
   * writes one since Threads were retired.
   */
  async recordSlackIdentityForMember(
    workspaceId: string,
    userId: string,
    verifiedEmail: string,
  ): Promise<void> {
    const membership = await workspaceRegionalDatabase(this.env).prepare(
      `SELECT 1 AS active FROM workspace_members
       WHERE workspace_id = ? AND user_id = ? AND status = 'active'`,
    ).bind(workspaceId, userId).first<{ active: number }>();
    if (!membership) return;
    this.env = withWorkspaceRuntimeDatabase(this.env, workspaceId);
    const rawConnections = await this.env.DB.prepare(
      `SELECT id, workspace_id, provider_account_id, encrypted_credentials, credential_iv, credential_key_version,
              granted_scopes_json, config_json, status
       FROM connector_connections
       WHERE workspace_id = ? AND connector_type = 'slack' AND scope = 'workspace'
         AND status <> 'disabled' ORDER BY id`,
    ).bind(workspaceId).all<SlackConnectionRow>();
    for (const connection of rawConnections.results ?? []) {
      // Only the provider conversation is guarded. What this catch knows how to
      // interpret is a Slack answer — a member who is not in the workspace, an
      // installation that needs reconnecting — and it reports whatever it
      // catches as one of those.
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
  }

  async previewLink(auth: AuthContext, token: string): Promise<{ teamId: string; slackUserId: string; workspaceName: string }> {
    this.env = withWorkspaceRuntimeDatabase(this.env, auth.workspaceId);
    const challenge = await this.loadLinkChallenge(auth, await sha256(token));
    return {
      teamId: String(challenge.slack_team_id),
      slackUserId: String(challenge.slack_user_id),
      workspaceName: String(challenge.display_name),
    };
  }

  /**
   * Loads a challenge and says precisely why it cannot be redeemed.
   *
   * The conditions are checked one at a time rather than folded into the
   * `WHERE` clause, because a single row-not-found reports every one of them as
   * expiry — including an installation that needs reconnecting, which no new
   * link will fix and which the member cannot resolve themselves.
   */
  private async loadLinkChallenge(auth: AuthContext, tokenHash: string): Promise<Record<string, unknown>> {
    const challenge = await this.env.DB.prepare(
      `SELECT c.*, cc.workspace_id, cc.provider_account_id
              , cc.display_name, cc.status AS connection_status
       FROM slack_link_challenges c
       JOIN connector_connections cc ON cc.id = c.connection_id
       WHERE c.token_hash = ?
         AND cc.connector_type = 'slack' AND cc.scope = 'workspace'`,
    ).bind(tokenHash).first<Record<string, unknown>>();
    // Scheduled maintenance keeps a spent row for a day past its expiry or
    // consumption, far beyond the 15-minute lifetime, so nothing that merely
    // aged out arrives here as a missing row.
    if (!challenge) throw new ApiError(404, "slack_link_unknown", "Rally does not recognize this Slack connection link; click Connect Rally in Slack to get a new one");
    // Ahead of the state checks: their answers are not owed to a caller who
    // holds a token minted for a different Avalon workspace.
    if (challenge.workspace_id !== auth.workspaceId) throw new ApiError(409, "slack_link_workspace_mismatch", "This Slack installation belongs to another Rally workspace");
    if (typeof challenge.consumed_at === "string") throw new ApiError(409, "slack_link_consumed", "This Slack connection link was already used or replaced by a newer one; click Connect Rally in Slack to get a new one");
    // Still a 404, as an unusable challenge always was: `ApiError` curates the
    // statuses this API emits, and the honest 410 is not worth widening it for
    // when the distinction clients act on is the code.
    if (String(challenge.expires_at) <= nowIso()) throw new ApiError(404, "slack_link_expired", "This Slack connection link has expired; click Connect Rally in Slack to get a new one");
    // A stale belief does not refuse this — linking an identity is a row in
    // `slack_user_links`, it neither spends the installation's credential nor
    // needs it to be sound, and refusing on `needs_reconnect` stranded a member
    // who had a valid challenge in hand behind an admin they had to go find.
    //
    // `disabled` is different, and an earlier draft of this wrongly waived it
    // too. It is a person's decision rather than an observation, and honouring
    // it here is not merely consistency: disabling clears the credentials and
    // drops the row from `connectionForTeam`, so redeeming would commit the
    // identity link and then fail publishing App Home — leaving the member
    // looking at an error for a mutation that had already landed.
    if (challenge.connection_status === "disabled") {
      throw new ApiError(409, "slack_installation_disabled", "This Slack workspace's Rally installation has been disabled; a Rally workspace owner or admin can reconnect it under Settings → Connections");
    }
    return challenge;
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
    this.env = withWorkspaceRuntimeDatabase(this.env, input.workspaceId);
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
    if (rawConnection.connection_status === "disabled") {
      throw new ApiError(503, "slack_connection_disabled", "The Slack installation has been disabled", {
        retryable: false,
      });
    }
    const token = await this.tokenFromEncrypted({ ...rawConnection, connection_id: input.connectionId });
    const opened = await slackApi(token, "conversations.open", { users: input.slackUserId }, AbortSignal.timeout(10_000));
    await postSlackTextChunks(
      token,
      opened.channel.id,
      input.markdown,
      undefined,
      `digest:${input.targetId}:${input.deliveryId}`,
      input.title,
    );
  }

  private async dispatchEvent(teamId: string, envelope: SlackIngressEnvelope, bodyHash: string): Promise<void> {
    const event = envelope.event!;
    const type = String(event.type ?? "");
    // Rally no longer joins every public channel. A chunked sync enqueued by
    // a Worker from before that change is still in the queue under one of
    // these types; it completes as a no-op rather than failing its job.
    if (type === "rally_public_channel_sync" || type === "avalon_public_channel_sync") {
      logInfo(this.env, "slack_public_channel_sync_retired", { team_id: teamId });
      return;
    }
    if (type === SLACK_SIDEKICK_SOURCE_JOIN_EVENT) {
      await this.joinSidekickSourceConversations(teamId, event);
      return;
    }
    await this.persistSlackEventActivity(teamId, envelope, bodyHash);
    if (await this.applyBindingLifecycle(teamId, envelope)) return;
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
        // No `error_json`, so nothing is overwritten and any non-disabled row
        // may be marked — Slack saying the app is gone is a fact, not a
        // diagnosis. The `disabled` guard stops an uninstall resurrecting a
        // connection somebody had turned off.
        `UPDATE connector_connections SET status = 'needs_reconnect', updated_at = ?
         WHERE id = ? AND connector_type = 'slack' AND scope = 'workspace' AND status <> 'disabled'`,
      ).bind(nowIso(), connection.id).run();
      await this.suspendInstallationBindings(connection, "connection_disconnected");
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
           WHERE id = ? AND connector_type = 'slack' AND scope = 'workspace' AND status <> 'disabled'`,
        ).bind(nowIso(), connection.id).run();
        await this.suspendInstallationBindings(connection, "connection_disconnected");
        await this.deactivateTeamRoute(connection);
      }
      for (const userId of oauthUsers) {
        await this.env.DB.prepare(
          `UPDATE connector_connections SET status = 'needs_reconnect', updated_at = ?
           WHERE connector_type = 'slack' AND scope = 'personal' AND provider_account_id = ?
             AND status <> 'disabled'`,
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
    const slackUserId = String(event.user);
    if (event.app_context) await this.storeSlackAppContext(teamId, slackUserId, event.app_context);
    const channelId = String(event.channel);
    const threadTs = typeof event.thread_ts === "string" && event.thread_ts ? event.thread_ts : null;
    const rootTs = threadTs ?? String(event.ts);
    const connection = await this.connectionForTeam(teamId);
    const token = await this.botToken(connection);
    const directMessage = type === "message" && isDirectSlackMessageEvent(event);
    const botUserId = type === "app_mention" || !directMessage
      ? authorizedBotUserId(envelope) ?? await this.botUserId(connection)
      : null;
    const prompt = (botUserId
      ? String(event.text ?? "").replaceAll(`<@${botUserId}>`, "")
      : String(event.text ?? "")).trim();
    if (!prompt) return;

    // One routing step: the message's external path against its bindings.
    const installationId = slackInstallationId(teamId);
    const path = slackMessagePath({ channelId, threadTs, messageTs: String(event.ts) });
    const claimKey = `event:${envelope.event_id}`;
    const resolution = await this.resolveBinding(connection, installationId, path, type === "app_mention", claimKey);
    if (resolution.outcome === "suspended") {
      logInfo(this.env, "binding_suspended", {
        workspace_id: connection.workspace_id,
        connection_id: connection.id,
        channel_id: channelId,
        suspended_depth: resolution.path.length,
        reason: resolution.reason,
      });
      return;
    }
    if (resolution.outcome === "hold") {
      throw new ApiError(503, "external_binding_held", "This Slack thread's Rally thread is still being created");
    }
    if (resolution.outcome === "deliver" && resolution.target.parentKind === "automation") {
      await this.deliverToRunChild(connection, token, teamId, slackUserId, resolution.target, {
        channelId, threadTs: rootTs, messageTs: String(event.ts), text: prompt, clientMessageId: claimKey,
        channelType: directMessage ? "im" : slackChannelType(event.channel_type),
      });
      return;
    }
    // An unbound message in a DM with the bot: a top-level one, or a reply
    // under the prompt below (every other DM thread is bound to a Sidekick
    // run). While a Sidekick run that sent a request here is still open, the
    // answer belongs in that request's thread: ask for it there, once per
    // event, and create no work. Once it has finished, the DM gets the
    // answer that Rally no longer starts work from Slack.
    if (directMessage && resolution.outcome === "none"
      && await this.promptForBoundDmThread(connection, token, teamId, installationId, channelId, rootTs, claimKey)) {
      return;
    }
    // An unaddressed message in a shared room that no binding claims is not
    // Rally's.
    if (type === "message" && !directMessage) return;
    // A mention, or a message in a DM with the bot, once started a Rally
    // Thread. Slack no longer creates a conversation (plan step C-2); it is
    // answered, once per event, with where work starts now.
    await this.answerRetiredIngress(connection, token, channelId, rootTs, claimKey);
  }

  /** Resolve one message's external path through the Organization's bindings. */
  private async resolveBinding(
    connection: SlackConnectionRow,
    installationId: string,
    path: string[],
    addressed: boolean,
    claimKey: string,
  ): Promise<ExternalBindingResolution> {
    const resolve = async () => ExternalBindingResolutionSchema.parse(
      await (await this.workspaceDirectory(connection.workspace_id)).resolveExternalConversation({
        workspaceId: connection.workspace_id,
        installationId,
        path,
        addressed,
        claimKey,
        pendingStaleBefore: new Date(Date.now() - SLACK_THREAD_CLAIM_LEASE_MS).toISOString(),
      }),
    );
    const resolution = await resolve();
    if (resolution.outcome !== "suspended" || resolution.reason !== "connection_disconnected") return resolution;
    // Slack signed and delivered this event for the installation, so it is
    // installed and connected now. The reconnect's own reactivation is one
    // best-effort call, and a revocation that arrives late suspends an
    // installation that has since reconnected; either way the next message is
    // where the suspension is found stale and lifted.
    await this.reactivateBindingsFor(connection, "event_received");
    return resolve();
  }

  /**
   * The room lifecycle events that move a binding: the bot invited, the bot
   * removed, the room archived, and a Slack Connect room renumbered. Returns
   * whether the event was one of them and has been handled.
   *
   * A member other than the bot joining or leaving changes no binding: a
   * person who leaves a private room keeps their Rally access until it is
   * changed in Rally.
   */
  private async applyBindingLifecycle(teamId: string, envelope: SlackIngressEnvelope): Promise<boolean> {
    const event = envelope.event ?? {};
    const type = String(event.type ?? "");
    if (!SLACK_BINDING_LIFECYCLE_EVENTS.has(type)) return false;
    const connection = await this.connectionForTeam(teamId);
    const botUserId = authorizedBotUserId(envelope) ?? await this.botUserId(connection);
    if (!slackBindingLifecycleApplies(event, botUserId)) return false;
    const installationId = slackInstallationId(teamId);
    const workspace = await this.workspaceDirectory(connection.workspace_id);
    if (type === "channel_id_changed") {
      const from = typeof event.old_channel_id === "string" ? event.old_channel_id : null;
      const to = typeof event.new_channel_id === "string" ? event.new_channel_id : null;
      if (!from || !to) return true;
      const moved = ExternalBindingMoveResultSchema.parse(await workspace.moveExternalConversationBindings({
        workspaceId: connection.workspace_id,
        installationId,
        from: [from],
        to: [to],
        at: nowIso(),
      }));
      (moved.outcome === "moved" ? logInfo : logWarn)(this.env, "slack_room_id_changed", {
        workspace_id: connection.workspace_id,
        connection_id: connection.id,
        outcome: moved.outcome,
        moved_count: moved.outcome === "moved" ? moved.count : 0,
      });
      return true;
    }
    const channelId = typeof event.channel === "string" ? event.channel : null;
    if (!channelId) return true;
    if (type === "member_joined_channel") {
      // A room invitation linked the room to a Rally Channel, whose Slack
      // threads became Rally Threads. Both are retired (plan step C-2), so an
      // invitation links nothing; a Sidekick still joins the rooms it watches.
      logInfo(this.env, "slack_room_invitation", {
        workspace_id: connection.workspace_id,
        connection_id: connection.id,
        channel_id: channelId,
        outcome: "ignored",
        reason: "room_bindings_retired",
      });
      return true;
    }
    const reason: ExternalBindingSuspensionReason = type === "channel_archive" || type === "group_archive"
      ? "provider_room_archived"
      : "provider_membership_ended";
    const suspended = ExternalBindingSuspendResultSchema.parse(await workspace.suspendExternalConversationBindings({
      workspaceId: connection.workspace_id,
      installationId,
      path: [channelId],
      reason,
      at: nowIso(),
    }));
    logInfo(this.env, "slack_room_binding_suspended", {
      workspace_id: connection.workspace_id,
      connection_id: connection.id,
      channel_id: channelId,
      reason,
      suspended: suspended.suspended.length,
    });
    return true;
  }

  /** Stop every binding of an installation that has disconnected, keeping each for reconnection. */
  private async suspendInstallationBindings(
    connection: SlackConnectionRow,
    reason: "connection_disconnected",
  ): Promise<void> {
    const suspended = ExternalBindingSuspendResultSchema.parse(
      await (await this.workspaceDirectory(connection.workspace_id)).suspendExternalConversationBindings({
        workspaceId: connection.workspace_id,
        installationId: slackInstallationId(connection.provider_account_id),
        reason,
        at: nowIso(),
      }),
    );
    logInfo(this.env, "external_bindings_suspended", {
      connection_id: connection.id,
      reason,
      count: suspended.suspended.length,
    });
  }

  /**
   * A message that could not be placed says so in its thread, rather than
   * vanishing. The message identity is the event's, so a retried job posts
   * it once.
   */
  private async postRoutingFailure(
    token: string,
    channelId: string,
    threadTs: string | undefined,
    reason: string,
    eventKey: string,
  ): Promise<void> {
    await slackApi(token, "chat.postMessage", {
      channel: channelId,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      client_msg_id: await stableUuid(`routing-failure:${eventKey}`),
      text: slackRoutingFailureText(reason),
    }, AbortSignal.timeout(5_000));
  }

  /**
   * One-to-one DM policy: a top-level message in a bot DM that holds an open
   * request a Sidekick run sent gets one reply, asking the person to answer in
   * that request's thread (the most recent one), and creates no Rally work.
   * Returns false when the DM holds no such request, so today's one-to-one
   * Agent behavior applies. The reply is keyed on the provider event, so a
   * Slack retry does not ask twice.
   */
  private async promptForBoundDmThread(
    connection: SlackConnectionRow,
    token: string,
    teamId: string,
    installationId: string,
    channelId: string,
    messageTs: string,
    claimKey: string,
  ): Promise<boolean> {
    const latest = ExternalBindingLatestOutboundResultSchema.parse(
      await (await this.workspaceDirectory(connection.workspace_id)).latestOutboundExternalConversation({
        workspaceId: connection.workspace_id,
        installationId,
        prefix: [channelId],
      }),
    ).latest;
    const requestTs = latest?.path[1];
    if (!latest || !requestTs) return false;
    const run = await this.sidekickRunState(connection, latest.sidekickId, latest.runId);
    if (!run || run.state === "completed" || run.state === "failed" || run.state === "stopped") return false;
    await slackApi(token, "chat.postMessage", {
      channel: channelId,
      thread_ts: messageTs,
      client_msg_id: await stableUuid(`dm-thread-prompt:${claimKey}`),
      text: `Please reply in the thread of my request so your answer reaches it: ${slackMessagePermalink(teamId, channelId, requestTs)}`,
    }, AbortSignal.timeout(5_000));
    logInfo(this.env, "slack_dm_thread_prompt_sent", {
      workspace_id: connection.workspace_id,
      connection_id: connection.id,
    });
    return true;
  }

  /**
   * A reply in a thread bound to a Sidekick run child: delivered to that run
   * through ordinary message admission, as an external message attributed to
   * its Slack sender, so the run child's loop wakes. The run's own authority,
   * not the sender's, is what continues it; the sender is only the author.
   */
  private async deliverToRunChild(
    connection: SlackConnectionRow,
    token: string,
    teamId: string,
    slackUserId: string,
    target: ExternalBindingConversationTarget,
    message: {
      channelId: string;
      threadTs: string;
      messageTs: string;
      text: string;
      clientMessageId: string;
      channelType: SlackPromptSource["channelType"];
    },
  ): Promise<void> {
    const external = await this.externalSlackActor(token, connection.workspace_id, teamId, slackUserId);
    await admitExternalWorkstreamMessage(this.env, externalBindingReplyAdmission({
      workspaceId: connection.workspace_id,
      teamId,
      slackUserId,
      actor: external.actor,
      matchedWorkspaceUserId: external.matchedWorkspaceUserId,
      target,
      message,
      now: Date.now(),
    }));
    logInfo(this.env, "external_binding_delivered", {
      workspace_id: connection.workspace_id,
      parent_kind: target.parentKind,
      parent_id: target.parentId,
      substream_id: target.substreamId,
    });
    // The reply reached the run; the person who wrote it sees that on their
    // message. A paused Sidekick holds it rather than acting on it, and the
    // reaction says so instead.
    const reactions = resolveSlackReactions(slackConnectionReactionOverride(connection));
    try {
      const run = target.parentKind === "automation"
        ? await this.sidekickRunState(connection, target.parentId, target.substreamId)
        : null;
      const paused = run !== null && run.lifecycle !== "active";
      await this.executeSlackReaction(connection, token, {
        kind: "reaction",
        channelId: message.channelId,
        timestamp: message.messageTs,
        add: paused ? reactions.outcomes.stopped : reactions.acknowledgement,
        remove: null,
        fallback: paused ? SLACK_DEFAULT_REACTIONS.outcomes.stopped : SLACK_DEFAULT_REACTIONS.acknowledgement,
      });
    } catch (error) {
      // The reply is admitted; a reaction that cannot be placed does not undo that.
      logWarn(this.env, "external_binding_acknowledgement_failed", {
        workspace_id: connection.workspace_id,
        reason: diagnosticErrorCode(error, "external_binding_acknowledgement_failed"),
      });
    }
  }

  /** A Sidekick run's state and its Sidekick's lifecycle, from the Sidekick object. */
  private async sidekickRunState(connection: SlackConnectionRow, sidekickId: string, runId: string) {
    return (await hostedParentStub(this.env, connection.workspace_id)).sidekickReadRunState({
      workspaceId: asWorkspaceId(connection.workspace_id),
      automationId: sidekickId,
      runId,
    });
  }

  /**
   * Join the bot to the conversations a Slack automation source names, so a
   * Slack-triggered Sidekick keeps receiving their events. Such a join is not
   * an invitation and links no Space. A private conversation cannot be joined
   * by the bot and is skipped: somebody has to invite it there.
   */
  private async joinSidekickSourceConversations(teamId: string, event: Record<string, unknown>): Promise<void> {
    const channelIds = Array.isArray(event.channel_ids)
      ? event.channel_ids.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    if (channelIds.length === 0) return;
    const connection = await this.connectionForTeam(teamId);
    let token: string;
    try {
      token = await this.botToken(connection);
    } catch (error) {
      if (!slackReconnectRequired(error)) throw error;
      await this.markSlackReconnectRequired(connection.id, slackErrorReason(error));
      return;
    }
    for (const channelId of new Set(channelIds)) {
      try {
        const result = await joinSlackPublicChannel(token, channelId, AbortSignal.timeout(10_000));
        logInfo(this.env, "slack_sidekick_source_joined", {
          connection_id: connection.id,
          channel_id: channelId,
          outcome: result,
        });
      } catch (error) {
        if (!slackReconnectRequired(error)) throw error;
        await this.markSlackReconnectRequired(connection.id, slackErrorReason(error));
        return;
      }
    }
  }

  /**
   * A task asked for from the slash command or a shortcut's task modal. Each
   * once started a Rally Thread; Slack no longer creates a conversation (plan
   * step C-2), so the person is told where work starts now.
   */
  private async startFromPrompt(
    teamId: string,
    slackUserId: string,
    channelId: string | null,
    threadTs: string | null,
    _prompt: string,
    clientMessageId: string,
  ): Promise<void> {
    const connection = await this.connectionForTeam(teamId);
    const token = await this.botToken(connection);
    const targetChannel = channelId ?? await this.openDm(token, slackUserId);
    await this.answerRetiredIngress(connection, token, targetChannel, threadTs ?? undefined, clientMessageId);
  }

  /** One reply per event: Slack starts no conversation now, and where one starts. */
  private async answerRetiredIngress(
    connection: SlackConnectionRow,
    token: string,
    channelId: string,
    threadTs: string | undefined,
    eventKey: string,
  ): Promise<void> {
    logInfo(this.env, "slack_prompt_not_started", {
      workspace_id: connection.workspace_id,
      connection_id: connection.id,
      reason: "conversation_ingress_retired",
    });
    await this.postRoutingFailure(token, channelId, threadTs, "conversation_ingress_retired", eventKey);
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
    const routable = WorkspaceSlackThreadRoutableResultSchema.parse(
      await (await this.workspaceDirectory(connection.workspace_id)).slackThreadRoutable({
        workspaceId: connection.workspace_id,
        connectionId: connection.id,
        installationId: slackInstallationId(teamId),
        channelId,
        threadTs,
        slackUserId,
        at: nowIso(),
      }),
    );
    if (routable.suspended) {
      // A reply to a suspended binding creates no Rally work. It is not queued
      // for the Agent at all; an automation subscribed to the activity still
      // receives it.
      logInfo(this.env, "binding_suspended", {
        workspace_id: connection.workspace_id,
        connection_id: connection.id,
        channel_id: channelId,
      });
    }
    return routable.routable || activitySubscribed;
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
    const channelResolution = channelId
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
    }, "slack");
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
       WHERE l.connection_id = ? AND l.status = 'active'
         AND l.slack_user_id IN (${placeholders})`,
    ).bind(connection.id, ...uniqueIds).all<{ user_id: string }>();
    if (linked.results.length === 0) return [];
    const active = await workspaceRegionalDatabase(this.env).prepare(
      `SELECT user_id FROM workspace_members
        WHERE workspace_id = ? AND status = 'active'
          AND user_id IN (${linked.results.map(() => "?").join(",")})`,
    ).bind(connection.workspace_id, ...linked.results.map((row) => row.user_id))
      .all<{ user_id: string }>();
    return active.results.map((row) => row.user_id);
  }

  private async hasSubscribedSlackActivity(
    connection: SlackConnectionRow,
    eventType: string,
  ): Promise<boolean> {
    // Focused unit tests construct partial Worker environments. Production
    // cannot take this path because the environment contract requires the
    // WorkspaceDO binding; a partial environment simply has no durable
    // registration authority to report a subscriber.
    if (!this.env.WORKSPACE_DOS) return false;
    const result = await this.workspaceDirectory(connection.workspace_id)
      .then((workspace) => workspace.hasActiveExternalEventRegistration({
        workspaceId: connection.workspace_id,
        connectionId: connection.id,
        eventType,
      }));
    return result.active;
  }

  private async markSlackReconnectRequired(connectionId: string, reason = "missing_scope"): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE connector_connections
       SET status = 'needs_reconnect', error_json = ?, updated_at = ?
       WHERE id = ? AND connector_type = 'slack' AND scope = 'workspace' AND status IN ('healthy', 'error')`,
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
    mayJoinWorkstream: boolean;
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
      mayJoinWorkstream: identity !== null && identity.accessClass !== "guest",
    };
  }

  private async storeSlackAppContext(teamId: string, slackUserId: string, value: unknown): Promise<void> {
    const context = slackAppContext(value);
    const connection = await this.connectionForTeam(teamId);
    await (await this.workspaceDirectory(connection.workspace_id)).storeSlackAppContext({
      workspaceId: connection.workspace_id,
      connectionId: connection.id,
      slackUserId,
      contextJson: JSON.stringify(context),
      at: nowIso(),
    });
  }

  private async publishHome(teamId: string, slackUserId: string, viewHash?: string): Promise<void> {
    const connection = await this.connectionForTeam(teamId);
    const token = await this.botToken(connection);
    const localLink = await this.env.DB.prepare(
      `SELECT user_id FROM slack_user_links
        WHERE connection_id = ? AND slack_user_id = ? AND status = 'active'`,
    ).bind(connection.id, slackUserId).first<{ user_id: string }>();
    const link = localLink ? await workspaceRegionalDatabase(this.env).prepare(
      `SELECT user.id AS user_id, user.name, user.timezone, member.role
         FROM users user JOIN workspace_members member ON member.user_id = user.id
        WHERE member.workspace_id = ? AND member.user_id = ? AND member.status = 'active'`,
    ).bind(connection.workspace_id, localLink.user_id)
      .first<{ user_id: string; name: string; timezone: string; role: string }>() : null;
    let blocks: Record<string, unknown>[];
    if (!link) {
      // No challenge is minted here. App Home is a published document with no
      // expiry of its own, so a token embedded in it dies where the member can
      // still see it; `rally_connect` mints one against the click instead.
      blocks = unlinkedHome();
    } else {
      // The person's Sidekicks, as their sidebar lists them, and what any of
      // them waits on.
      const [sidekicks, personalSlack] = await Promise.all([
        this.workspaceDirectory(connection.workspace_id)
          .then((workspace) => workspace.listAutomationDirectory({
            workspaceId: connection.workspace_id,
            userId: link.user_id,
          }))
          .then((page) => sidekicksForHome(page.items)),
        this.env.DB.prepare(
          `SELECT display_name, status FROM connector_connections
           WHERE workspace_id = ? AND connector_type = 'slack' AND scope = 'personal'
             AND owner_user_id = ? AND provider_account_id LIKE ? AND status <> 'disabled'
           ORDER BY updated_at DESC LIMIT 1`,
        ).bind(connection.workspace_id, link.user_id, `${teamId}:%`).first<{ display_name: string; status: string }>(),
      ]);
      blocks = linkedHome(
        link.name,
        sidekicks,
        this.env.PUBLIC_WEB_BASE_URL,
        this.env.AVALON_REGION,
        connection.workspace_id,
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
    // Slack only delivers link_shared for the app's registered unfurl
    // domains, and it registers both site domains without knowing which one a
    // link in channel history was minted on, so both are read.
    const linked = slackUnfurlLinkTargets(links, {
      webBaseUrls: [this.env.PUBLIC_WEB_BASE_URL, ...LEGACY_LINK_ORIGINS],
      region: this.env.AVALON_REGION, workspaceId: connection.workspace_id,
    });
    if (linked.size === 0) return;
    const token = await this.botToken(connection);
    // The name is withheld only where Slack itself has put another company in
    // the room. Every conversation inside the workspace — public, private, DM,
    // group DM — sees it, and an audience lookup that fails falls back to the
    // anonymous card rather than dropping the unfurl. Posting fails closed: an
    // audience we could not confirm is treated as external.
    const externallyShared = await slackChannelIsExternallyShared(this.env, token, channel);
    const workspace = externallyShared !== false ? null : await this.workspaceDirectory(connection.workspace_id);
    const unfurls: Record<string, unknown> = {};
    for (const [url, target] of linked) {
      // The name the handoff page shows for the same link, and nothing more:
      // a Canvas or a Sidekick card carries no status, so nothing rewrites it
      // later and nothing is recorded for the refresh sweep.
      const { title } = workspace ? await workspace.linkTitle({ workspaceId: connection.workspace_id,
        target: target.kind === "canvas" ? { kind: "canvas", canvasId: target.canvasId } : { kind: "sidekick", sidekickId: target.sidekickId } })
        : { title: null };
      unfurls[url] = { blocks: linkUnfurlBlocks(title, url) };
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
    }
  }

  private workspaceDirectory(workspaceId: string) {
    return durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      workspaceId,
      workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(workspaceId)),
    );
  }

  private async linkedAccount(teamId: string, slackUserId: string): Promise<SlackLinkedAccount | null> {
    let routed: SlackConnectionRow;
    try {
      routed = await this.connectionForTeam(teamId);
    } catch (error) {
      if (error instanceof ApiError && error.code === "slack_installation_not_found") return null;
      throw error;
    }
    // Bound to the routed connection, and the link's workspace to the
    // connection's: the auth this resolves is what the work-stream object
    // trusts as the member's identity, so which workspace it names must be
    // asserted by the query rather than inherited from whichever link row an
    // unordered scan happened to return.
    const row = await this.env.DB.prepare(
      `SELECT l.user_id, l.workspace_id, l.connection_id,
              cc.provider_account_id, cc.encrypted_credentials, cc.credential_iv,
              cc.granted_scopes_json, cc.status
       FROM slack_user_links l
       JOIN connector_connections cc
         ON cc.id = l.connection_id AND cc.workspace_id = l.workspace_id
       WHERE l.slack_team_id = ? AND l.slack_user_id = ? AND l.status = 'active'
         AND l.connection_id = ?
         AND cc.connector_type = 'slack' AND cc.scope = 'workspace' AND cc.status <> 'disabled'`,
    ).bind(teamId, slackUserId, routed.id).first<Record<string, unknown>>();
    if (!row) return null;
    const membership = await workspaceRegionalDatabase(this.env).prepare(
      `SELECT role FROM workspace_members
        WHERE workspace_id = ? AND user_id = ? AND status = 'active'`,
    ).bind(row.workspace_id, row.user_id).first<{ role: AuthContext["role"] }>();
    if (!membership) return null;
    const connection: SlackConnectionRow = {
      id: String(row.connection_id),
      workspace_id: String(row.workspace_id),
      provider_account_id: String(row.provider_account_id),
      encrypted_credentials: String(row.encrypted_credentials),
      credential_iv: String(row.credential_iv),
      granted_scopes_json: String(row.granted_scopes_json),
      status: String(row.status),
    };
    // `principal: "connector"` is what makes this authority honest: the
    // sessionId below is a correlation label, not a `sessions` row, and without
    // the marker the product objects look it up there and refuse every linked
    // member's message as `session_revoked` — which is exactly what happened to
    // every `@Avalon` mention after the object cutover (2026-08-22). The link
    // row and active membership verified just above are the authority; the
    // objects re-check the membership half themselves on every request.
    return { auth: { sessionId: `slack:${teamId}:${slackUserId}`, userId: asUserId(String(row.user_id)), workspaceId: asWorkspaceId(String(row.workspace_id)), region: this.env.AVALON_REGION, role: membership.role, principal: "connector" }, connection, slackUserId, teamId };
  }

  /** Runs one reaction transition through the connector's agent control plane. */
  private async executeSlackReaction(
    connection: SlackConnectionRow,
    token: string,
    command: SlackAgentReactionCommand,
  ): Promise<SlackAgentReactionResult> {
    const adapter = connectorRegistryForEnv(this.env).get("slack").messagingAgent;
    if (!adapter) throw new ApiError(500, "slack_agent_adapter_missing", "Slack Agent is not configured");
    const context: ConnectorConnectionContext = {
      id: connection.id,
      workspaceId: connection.workspace_id,
      scope: "workspace",
      ownerUserId: null,
      grantedScopes: parseGrantedScopes(connection.granted_scopes_json),
      credentials: { botAccessToken: token },
      cursor: {},
      config: {},
    };
    return await adapter.execute(command, {
      connection: context,
      signal: AbortSignal.timeout(5_000),
    }) as SlackAgentReactionResult;
  }

  private async connectionForTeam(teamId: string): Promise<SlackConnectionRow> {
    const route = await workspaceRegionalDatabase(this.env).prepare(
      `SELECT workspace_id, connection_id FROM slack_installation_routes
        WHERE team_id = ? AND region = ? AND status = 'active'`,
    ).bind(teamId, this.env.AVALON_REGION).first<{ workspace_id: string; connection_id: string }>();
    if (!route && !this.env.WORKSPACE_DOS) {
      const legacy = await this.env.DB.prepare(
        `SELECT id, workspace_id, provider_account_id, encrypted_credentials, credential_iv,
                credential_key_version, granted_scopes_json, status
           FROM connector_connections
          WHERE connector_type = 'slack' AND scope = 'workspace'
            AND provider_account_id = ? AND status <> 'disabled'`,
      ).bind(teamId).first<SlackConnectionRow>();
      if (legacy) return legacy;
    }
    if (!route) throw new ApiError(404, "slack_installation_not_found", "Slack workspace is not connected to Rally");
    this.env = withWorkspaceRuntimeDatabase(this.env, route.workspace_id);
    const row = await this.env.DB.prepare(
      `SELECT id, workspace_id, provider_account_id, encrypted_credentials, credential_iv, credential_key_version,
              granted_scopes_json, config_json, status
       FROM connector_connections
       WHERE id = ? AND workspace_id = ? AND connector_type = 'slack'
         AND scope = 'workspace' AND provider_account_id = ? AND status <> 'disabled'`,
    ).bind(route.connection_id, route.workspace_id, teamId).first<SlackConnectionRow>();
    if (!row) throw new ApiError(404, "slack_installation_not_found", "Slack workspace is not connected to Rally");
    return row;
  }

  private async connectionById(id: string): Promise<SlackConnectionRow> {
    const route = await workspaceRegionalDatabase(this.env).prepare(
      `SELECT workspace_id FROM slack_installation_routes
        WHERE connection_id = ? AND region = ? AND status = 'active'`,
    ).bind(id, this.env.AVALON_REGION).first<{ workspace_id: string }>();
    if (!route && !this.env.WORKSPACE_DOS) {
      const legacy = await this.env.DB.prepare(
        `SELECT id, workspace_id, provider_account_id, encrypted_credentials, credential_iv,
                credential_key_version, granted_scopes_json, status
           FROM connector_connections
          WHERE id = ? AND connector_type = 'slack' AND scope = 'workspace'`,
      ).bind(id).first<SlackConnectionRow>();
      if (legacy) return legacy;
    }
    if (!route) throw new ApiError(404, "slack_installation_not_found", "Slack workspace is not connected to Rally");
    this.env = withWorkspaceRuntimeDatabase(this.env, route.workspace_id);
    const row = await this.env.DB.prepare(
      `SELECT id, workspace_id, provider_account_id, encrypted_credentials, credential_iv, credential_key_version,
              granted_scopes_json, config_json, status
       FROM connector_connections WHERE id = ? AND workspace_id = ?
         AND connector_type = 'slack' AND scope = 'workspace'`,
    ).bind(id, route.workspace_id).first<SlackConnectionRow>();
    if (!row) throw new ApiError(404, "slack_installation_not_found", "Slack workspace is not connected to Rally");
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

  private async createLink(
    connection: SlackConnectionRow,
    slackUserId: string,
  ): Promise<{ url: string; createdAt: string }> {
    const token = randomToken(32);
    const tokenHash = await sha256(token);
    const at = nowIso();
    await this.env.DB.prepare(
      `INSERT INTO slack_link_challenges
       (token_hash, connection_id, slack_team_id, slack_user_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(tokenHash, connection.id, connection.provider_account_id, slackUserId, new Date(Date.now() + 15 * 60_000).toISOString(), at).run();
    const url = new URL("/slack/link", this.env.PUBLIC_WEB_BASE_URL);
    url.hash = new URLSearchParams({
      token,
      region: this.env.AVALON_REGION,
      workspace: connection.workspace_id,
    }).toString();
    return { url: url.toString(), createdAt: at };
  }

  /**
   * Retires the member's *earlier* challenges, once a newer one has reached
   * them. Two rules here, each paid for by a distinct way of stranding someone.
   *
   * It is separate from minting, and runs only after the modal carrying the new
   * link has opened. Minting used to invalidate in the same batch, so a
   * `views.open` that failed — an abort, a Slack error, a spent ack budget —
   * took the previous modal's still-valid link down with it.
   *
   * And it is bounded by mint time rather than retiring every token but the one
   * just issued. Two clicks in flight together both insert and both open a
   * modal, and each would then retire the other's token: two modals on screen,
   * neither link redeemable. Comparing `created_at` makes the outcome the same
   * whichever request finishes last — the newest link survives — and two mints
   * that land in the same millisecond leave both alive, which is the harmless
   * direction to fail in.
   */
  private async supersedeLinksMintedBefore(connectionId: string, slackUserId: string, createdAt: string): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE slack_link_challenges SET consumed_at = ?
       WHERE connection_id = ? AND slack_user_id = ? AND consumed_at IS NULL AND created_at < ?`,
    ).bind(nowIso(), connectionId, slackUserId, createdAt).run();
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

}

/**
 * The Slack events that move an external conversation binding. A member event
 * counts only when the member is the bot itself; see
 * `slackBindingLifecycleApplies`.
 */
const SLACK_BINDING_LIFECYCLE_EVENTS: ReadonlySet<string> = new Set([
  "member_joined_channel",
  "member_left_channel",
  "channel_left",
  "group_left",
  "channel_archive",
  "group_archive",
  "channel_id_changed",
]);

function slackBindingLifecycleApplies(event: Record<string, unknown>, botUserId: string | null): boolean {
  const type = String(event.type ?? "");
  if (type === "member_joined_channel" || type === "member_left_channel") {
    return botUserId !== null && event.user === botUserId;
  }
  return SLACK_BINDING_LIFECYCLE_EVENTS.has(type);
}

/**
 * Where a Slack thread's message goes, decided by its binding before a
 * Channel is looked up or created. `bound`: the thread already routes to a
 * Channel. `spawn`: an addressed message under a linked room creates a
 * Channel in the room's Space, claiming the thread's binding with its birth.
 */
/** What a thread is told when Rally could not place its message, by reason. */
/**
 * The admission a reply in a thread bound to a Sidekick run child becomes:
 * the run child's own address (the Sidekick parent, the run's substream), the
 * Slack sender as the external actor, and the reply's source (installation,
 * channel, thread, message and a link back) on its Slack origin. The run's
 * authority, not the sender's, continues it; the principal here only carries
 * the message to the loop, which restores the run.
 */
export function externalBindingReplyAdmission(input: {
  workspaceId: string;
  teamId: string;
  slackUserId: string;
  actor: ExternalActor;
  matchedWorkspaceUserId: string | null;
  target: ExternalBindingConversationTarget;
  message: {
    channelId: string;
    threadTs: string;
    messageTs: string;
    text: string;
    clientMessageId: string;
    channelType: SlackPromptSource["channelType"];
  };
  now: number;
}): AdmitExternalMessageInput {
  const workspaceId = asWorkspaceId(input.workspaceId);
  return {
    workspaceId,
    workstreamId: asWorkstreamId(input.target.parentId),
    substreamId: input.target.substreamId,
    messageId: newId(),
    clientMessageId: input.message.clientMessageId.slice(0, 120),
    actor: input.actor,
    messageType: "text",
    text: input.message.text,
    structuredContentJson: null,
    origin: "external_conversation_binding",
    executionPrincipal: { type: "workspace", workspaceId },
    slackOrigin: SlackOriginContextSchema.parse({
      teamId: input.teamId,
      actorSlackUserId: input.slackUserId,
      channelId: input.message.channelId,
      channelName: null,
      threadTs: input.message.threadTs,
      messageTs: input.message.messageTs,
      permalink: slackMessagePermalink(
        input.teamId, input.message.channelId, input.message.messageTs, input.message.threadTs,
      ),
      invocationType: input.message.channelType === "im" ? "direct_message" : "app_mention",
      channelType: input.message.channelType,
      matchedAvalonUserId: input.matchedWorkspaceUserId,
      nearbyMessagesStatus: "not_applicable",
      nearbyMessages: [],
      attachments: [],
    }),
    runMode: "steer",
    now: input.now,
  };
}

function slackRoutingFailureText(reason: string): string {
  switch (reason) {
    case "conversation_ingress_retired":
      return "Rally no longer starts work from Slack. Start a Canvas in Rally, or set up a Sidekick to work from Slack for you.";
    default:
      return `Rally couldn't start work here (${reason}). Mention Rally again to retry, or ask a Rally admin if it keeps happening.`;
  }
}

type SlackChannelResolution = {
  channelType: SlackPromptSource["channelType"];
  channelName: string | null;
  failure: SlackPromptSource["channelResolutionFailure"];
  /** Absent reads as threadable: only Slack's explicit flag turns threads off. */
  threadable?: boolean;
  /** Shared through Slack Connect; absent when the source did not ask Slack. */
  externallyShared?: boolean;
};

/**
 * A browser link to one Slack message. Slack resolves `slack.com/archives`
 * links against the viewer's own workspace, so the team is carried only for
 * Slack's redirect, and a reply's link names its thread.
 */
function slackMessagePermalink(teamId: string, channelId: string, messageTs: string, threadTs?: string): string {
  const url = new URL(`https://slack.com/archives/${encodeURIComponent(channelId)}/p${messageTs.replace(".", "")}`);
  if (threadTs && threadTs !== messageTs) {
    url.searchParams.set("thread_ts", threadTs);
    url.searchParams.set("cid", channelId);
  }
  url.searchParams.set("team", teamId);
  return url.toString();
}

/**
 * Posts agent markdown into Slack as rendered blocks.
 *
 * The `text` field carries only the notification fallback. It is parsed as
 * mrkdwn, a dialect with no headings and no tables, and sending agent output
 * through it was what put literal `###` characters in front of members while the
 * streaming path — which has always used `markdown_text` — rendered the same
 * output correctly. Both paths now render through the same `markdown` block.
 */
async function postSlackTextChunks(
  token: string,
  channel: string,
  text: string,
  threadTs?: string,
  clientMessageKey?: string,
  header?: string,
  threadable = true,
): Promise<string> {
  const messages = slackMarkdownMessages(text, { ...(header ? { header } : {}), fallback: SLACK_EMPTY_RESULT_TEXT });
  let rootTs = threadTs;
  let firstMessageTs: string | null = null;
  for (const [index, message] of messages.entries()) {
    const result = await slackApi(token, "chat.postMessage", {
      channel,
      ...(rootTs ? { thread_ts: rootTs } : {}),
      ...(clientMessageKey ? { client_msg_id: await stableUuid(`${clientMessageKey}:${index}`) } : {}),
      text: message.text,
      blocks: message.blocks,
    }, AbortSignal.timeout(10_000));
    firstMessageTs ??= result.ts;
    if (threadable) rootTs ??= result.ts;
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

/** What a run with no text response says, rather than posting nothing at all. */
const SLACK_EMPTY_RESULT_TEXT = "Rally completed the task without a text response.";

/**
 * The reaction vocabulary a workspace installation has configured, if any.
 *
 * Unparseable configuration reads as none rather than throwing: `resolveSlackReactions`
 * already falls back to the defaults, and a member's run must not fail over a
 * malformed emoji list an administrator saved months ago.
 */
function slackConnectionReactionOverride(connection: SlackConnectionRow): unknown {
  try {
    const config: unknown = JSON.parse(connection.config_json || "{}");
    return config && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, unknown>).reactions
      : null;
  } catch {
    return null;
  }
}

function slackChannelType(value: unknown): SlackPromptSource["channelType"] {
  if (typeof value !== "string") return "unknown";
  if (value === "channel" || value === "public_channel" || value === "public") return "public";
  if (value === "group" || value === "private_channel" || value === "private" || value === "privategroup" || value === "mpim") return "private";
  if (value === "im" || value === "directmessage" || value.startsWith("D")) return "im";
  return "unknown";
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
): Promise<SlackChannelResolution> {
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
    const threadable = result.channel.is_non_threadable !== true;
    const externallyShared = result.channel.is_ext_shared === true || result.channel.is_pending_ext_shared === true;
    if (result.channel.is_mpim === true || result.channel.is_private !== false) {
      return { channelType: "private", channelName, failure: null, threadable, externallyShared };
    }
    return { channelType: "public", channelName, failure: null, threadable, externallyShared };
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

// The connector returns its sync tally in camelCase. Log fields are
// snake_case, so map it here rather than spreading the interface into an entry
// and indexing `alreadyMember` beside `already_member` elsewhere.

/** The unique violation alone — never a FOREIGN KEY, NOT NULL, or CHECK failure. */
function isSlackUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /unique constraint failed|constraint_unique/iu.test(error.message);
}

function slackErrorReason(error: unknown): string {
  if (error instanceof ConnectorError) {
    const details = error.details;
    if (details && typeof details === "object" && typeof (details as { error?: unknown }).error === "string") {
      return String((details as { error: string }).error);
    }
    // A malformed Slack body arrives as `provider_error` with the failing
    // paths the adapter attached, not as a raw `ZodError`: the adapter parses
    // the response and wraps the rejection. The word `provider_error` alone
    // is what a network fault also says.
    const responseIssues = details && typeof details === "object" ? (details as { responseIssues?: unknown }).responseIssues : undefined;
    if (typeof responseIssues === "string" && isCodeShaped(responseIssues)) return codeShaped(`invalid_slack_data:${responseIssues}`);
    return error.code;
  }
  // Slack answered with a body this binary does not model. The failing path
  // is the diagnosis and is schema shape; the body's values stay behind.
  if (error instanceof z.ZodError) return codeShaped(`invalid_slack_data:${describeZodIssues(error)}`);
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
  return { type: "modal", callback_id: "rally_start_task_submit", private_metadata: JSON.stringify(SlackModalContextSchema.parse(source)), title: { type: "plain_text", text: "Start a Rally task" }, submit: { type: "plain_text", text: "Start" }, close: { type: "plain_text", text: "Cancel" }, blocks: [{ type: "input", block_id: "prompt", label: { type: "plain_text", text: "What should Rally do?" }, element: { type: "plain_text_input", action_id: "value", multiline: true, initial_value: initial.slice(0, 3_000), placeholder: { type: "plain_text", text: "Summarize this, investigate an issue, or coordinate work…" } } }] };
}

function preferencesModal(notifyNeedsInput: boolean, notifyAutomationCompleted: boolean): Record<string, unknown> {
  const options = [{ text: { type: "plain_text", text: "When a Sidekick needs input" }, value: "needs_input" }, { text: { type: "plain_text", text: "When a Sidekick run finishes" }, value: "automation_completed" }];
  const initialOptions = options.filter((option) => option.value === "needs_input" ? notifyNeedsInput : notifyAutomationCompleted);
  return { type: "modal", callback_id: "rally_preferences_submit", title: { type: "plain_text", text: "Rally notifications" }, submit: { type: "plain_text", text: "Save" }, close: { type: "plain_text", text: "Cancel" }, blocks: [{ type: "input", optional: true, block_id: "delivery", label: { type: "plain_text", text: "Notify me in Slack" }, element: { type: "checkboxes", action_id: "value", options, ...(initialOptions.length ? { initial_options: initialOptions } : {}) } }] };
}

function feedbackModal(workstreamId: string): Record<string, unknown> {
  return { type: "modal", callback_id: "rally_feedback_submit", private_metadata: workstreamId.slice(0, 3000), title: { type: "plain_text", text: "Feedback for Rally" }, submit: { type: "plain_text", text: "Send" }, close: { type: "plain_text", text: "Cancel" }, blocks: [
    { type: "input", block_id: "rating", label: { type: "plain_text", text: "How was this result?" }, element: { type: "radio_buttons", action_id: "value", options: [{ text: { type: "plain_text", text: "Helpful" }, value: "helpful" }, { text: { type: "plain_text", text: "Needs improvement" }, value: "needs_improvement" }] } },
    { type: "input", optional: true, block_id: "comment", label: { type: "plain_text", text: "What should improve?" }, element: { type: "plain_text_input", action_id: "value", multiline: true, max_length: 2000 } },
  ] };
}

// Every surface that asks an unlinked member to connect carries this button and
// no URL, so no Slack surface holds a challenge that can go stale on it.
// The one place a link challenge is ever rendered. It is opened in response to
// the click that minted it, so its lifetime is a member deciding whether to
// continue rather than however long App Home has been sitting published.
function connectModal(link: string): Record<string, unknown> {
  return { type: "modal", callback_id: "rally_connect_link", title: { type: "plain_text", text: "Connect Rally" }, close: { type: "plain_text", text: "Cancel" }, blocks: [
    { type: "section", text: { type: "mrkdwn", text: "Opening Rally connects this Slack account to the Rally account you are signed in to on this device." } },
    { type: "actions", elements: [{ type: "button", style: "primary", text: { type: "plain_text", text: "Open Rally" }, url: link, action_id: "rally_open_connect" }] },
    { type: "context", elements: [{ type: "mrkdwn", text: "This link works once and expires in 15 minutes. Click *Connect Rally* again for a new one." }] },
  ] };
}

/**
 * What Rally does from Slack today, said once at the top of either view: a
 * Sidekick can work from Slack, and nothing a person types to Rally in Slack
 * starts work (`conversation_ingress_retired`).
 */
const SLACK_HOME_SUMMARY = "A Sidekick can work from Slack for you: it can start from Slack activity and send what it finds back here. Mentioning Rally or sending it a DM does not start work; start a Canvas or set up a Sidekick in Rally.";

/**
 * How many rows each App Home list shows. The six is the number App Home's
 * automation list already used, carried over unchanged; it is the team's to
 * set. It also keeps a view inside Slack's 100-block ceiling.
 */
const SLACK_HOME_ROW_LIMIT = 6;

/** Slack's ceiling on a section's text. */
const SLACK_SECTION_TEXT_LIMIT = 3_000;

function unlinkedHome(): Record<string, unknown>[] {
  return [
    { type: "header", text: { type: "plain_text", text: "Meet Rally" } },
    { type: "section", text: { type: "mrkdwn", text: SLACK_HOME_SUMMARY } },
    { type: "section", text: { type: "mrkdwn", text: "Connect your Rally account to see your Sidekicks here, along with anything they are waiting on you for. The same step connects personal Slack tools, so Rally can search and act in Slack with your own permissions. Rally uses bounded Slack activity for the Sidekicks you set up; it does not recreate Slack as a parallel inbox or searchable workspace." } },
    // Deliberately not a `url` button: the handoff URL carries a single-use
    // challenge, and this view outlives any expiry short enough to be safe.
    { type: "actions", elements: [{ type: "button", style: "primary", text: { type: "plain_text", text: "Connect Rally" }, action_id: "rally_connect" }] },
    { type: "divider" },
    { type: "context", elements: [{ type: "mrkdwn", text: "Rally Agent features require paid Slack and Rally plans." }] },
    { type: "context", elements: [{ type: "mrkdwn", text: "AI can make mistakes. Review important actions. <https://rallywith.ai/privacy|Privacy> · <https://rallywith.ai/help/|Help>" }] },
  ];
}

function linkedHome(name: string, sidekicks: AutomationSummary[], webBase: string, region: Region, workspaceId: string, personalSlack: { display_name: string; status: string } | null, administration: { teamId: string; status: string } | null): Record<string, unknown>[] {
  const automationsTarget = addWorkspaceTarget(new URL("rallywithai://automations/new"), { region, workspaceId }).toString();
  const connectionsTarget = addWorkspaceTarget(new URL("rallywithai://settings/connections"), { region, workspaceId }).toString();
  const link = (sidekick: AutomationSummary) => `*<${sidekickCanonicalUrl(webBase, { region, workspaceId, sidekickId: sidekick.id })}|${escapeMrkdwn(sidekick.name)}>*`;
  const waiting = sidekicks.filter(sidekickNeedsInput).slice(0, SLACK_HOME_ROW_LIMIT);
  const blocks: Record<string, unknown>[] = [
    { type: "header", text: { type: "plain_text", text: `Welcome, ${name}`.slice(0, 150) } },
    { type: "section", text: { type: "mrkdwn", text: SLACK_HOME_SUMMARY } },
    // `rally_create_automation` keeps the id every published view carries.
    { type: "actions", elements: [
      { type: "button", style: "primary", text: { type: "plain_text", text: "Create Sidekick" }, url: desktopHandoffUrl(webBase, automationsTarget), action_id: "rally_create_automation" },
      { type: "button", text: { type: "plain_text", text: "Notifications" }, action_id: "rally_preferences" },
    ] },
  ];
  // A Sidekick waiting on someone: its run's question when one asked, or a
  // pointer to Rally when what it waits on is its delegation.
  if (waiting.length) {
    blocks.push({ type: "divider" }, { type: "header", text: { type: "plain_text", text: "Needs input" } });
    for (const sidekick of waiting) {
      blocks.push(section(`${link(sidekick)}\n${sidekick.pendingQuestion ? escapeMrkdwn(sidekick.pendingQuestion) : "Open it in Rally to see what it needs."}`));
    }
  }
  blocks.push({ type: "divider" }, { type: "header", text: { type: "plain_text", text: "Sidekicks" } });
  if (!sidekicks.length) blocks.push(section("No Sidekicks yet. Create one in Rally to have it work from Slack for you."));
  for (const sidekick of sidekicks.slice(0, SLACK_HOME_ROW_LIMIT)) {
    blocks.push(section(`${link(sidekick)}\n${sidekickHomeState(sidekick)} · ${sidekickHomeLastRun(sidekick.lastRunAt)}`));
  }
  blocks.push(
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: `*Personal Slack tools*\n${personalSlack ? `${personalSlack.status === "healthy" ? ":large_green_circle:" : ":warning:"} ${escapeMrkdwn(personalSlack.display_name)} · ${escapeMrkdwn(personalSlack.status)}` : "Not connected — connecting your Rally account normally does this too. Finish it to let Rally search and act in Slack with your own permissions."}` }, accessory: { type: "button", text: { type: "plain_text", text: personalSlack ? "Manage" : "Finish connecting" }, url: desktopHandoffUrl(webBase, connectionsTarget), action_id: "rally_open_personal_tools" } },
  );
  if (administration) blocks.push(
    { type: "divider" },
    { type: "header", text: { type: "plain_text", text: "Workspace administration" } },
    { type: "section", text: { type: "mrkdwn", text: `Slack workspace ${escapeMrkdwn(administration.teamId)} · ${administration.status === "healthy" ? ":large_green_circle: Healthy" : ":warning: Needs attention"}` }, accessory: { type: "button", text: { type: "plain_text", text: "Manage" }, url: desktopHandoffUrl(webBase, connectionsTarget), action_id: "rally_open_admin" } },
  );
  blocks.push({ type: "divider" }, { type: "context", elements: [{ type: "mrkdwn", text: "Rally Agent features require paid Slack and Rally plans. Personal Slack tools use your own Slack permissions when connected. <https://rallywith.ai/privacy|Privacy> · <https://rallywith.ai/help/|Help>" }] });
  return blocks;
}

/** A section of mrkdwn, cut to Slack's ceiling rather than refused by it. */
function section(text: string): Record<string, unknown> {
  return { type: "section", text: { type: "mrkdwn", text: text.length > SLACK_SECTION_TEXT_LIMIT ? `${text.slice(0, SLACK_SECTION_TEXT_LIMIT - 1)}…` : text } };
}

/** Waiting on someone, as the desktop's `sidekickStatus` reads it. */
function sidekickNeedsInput(sidekick: AutomationSummary): boolean {
  return sidekick.needsInput === true || sidekick.runState === "needs_input";
}

/** The state a Sidekick row shows, in the desktop's words for it. */
function sidekickHomeState(sidekick: AutomationSummary): string {
  if (sidekickNeedsInput(sidekick)) return ":warning: Needs input";
  if (sidekick.runState === "working") return ":large_green_circle: Working";
  return sidekick.status === "paused" ? "Paused" : "Active";
}

/** When it last ran, in the reader's own zone through Slack's date token. */
function sidekickHomeLastRun(lastRunAt: string | null): string {
  if (!lastRunAt) return "Not run yet";
  const at = new Date(lastRunAt);
  return `<!date^${Math.floor(at.getTime() / 1000)}^Last run {date_short_pretty} at {time}|Last run ${at.toISOString().slice(0, 16).replace("T", " ")} UTC>`;
}

/** The Sidekicks App Home lists: the person's sidebar list, drafts left out. */
function sidekicksForHome(items: unknown): AutomationSummary[] {
  return z.array(AutomationSummarySchema).parse(items).filter((sidekick) => sidekick.status !== "draft");
}

function desktopHandoffUrl(webBase: string, target: string): string {
  const url = new URL("/open", webBase);
  url.hash = new URLSearchParams({ target }).toString();
  return url.toString();
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
    // A 401 usually means the installation's grant is broken — but the two
    // codes the work-stream object refuses *one member's* request with say
    // nothing about the installation, and reading them as a grant failure
    // marks the whole workspace's Slack connection `needs_reconnect` and
    // pages an operator to reauthorize an installation that is healthy.
    || (error instanceof ApiError && error.status === 401
      && error.code !== "connector_member_revoked" && error.code !== "session_revoked");
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
  // Two object-refusal codes are transient by construction and self-heal on
  // the durable retry, which re-reads `linkedAccount` fresh:
  // `connector_member_revoked` is reachable only as a race — a membership or
  // role change landing between the ingress's link read and the object's
  // re-check, since a member already removed resolves to no link and takes
  // the workspace-principal path — and the retry either runs at the new role
  // or answers under the workspace principal. `invalid_product_request` is
  // the one-deploy skew window where a new Worker names a principal an old
  // object script's strict schema refuses; the retry outlives the window.
  // Classifying either as terminal permanently drops a member's message and
  // pages an operator for a condition no operator can fix.
  if (error instanceof ApiError) {
    return error.status === 429 || error.status >= 500
      || error.code === "connector_member_revoked"
      || error.code === "invalid_product_request";
  }
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
  // The persisted code keys the exhausted-job notice's once-per-hour dedup on
  // exact equality, and a rejection's path carries the index of the array
  // element that failed. Slack's origin shapes are bounded arrays of strict
  // objects, so one contract drift would be a different code — and a
  // separate page — per slot. The log row keeps the exact path; the persisted
  // code folds every index to `n`.
  return reason && reason !== "Error" ? reason.replace(/\.\d+(?=[.:]|$)/gu, ".n").slice(0, 120) : "slack_ingress_failed";
}

function escapeMrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export const __slackAgentTesting = {
  SLACK_AUTHORIZATION_ERROR_CODES,
  slackErrorReason,
  slackIngressErrorCode,
  isDirectSlackMessageEvent,
  isSlackRetryPrompt,
  modalPromptSource,
  recoverSlackDeniedPrompt,
  resolveSlackChannelType,
  slackAppContext,
  slackOriginAttachments,
  slackOriginNearbyMessage,
  slackEventActorUserIds,
  slackChannelType,
  linkedHome,
  unlinkedHome,
  sidekicksForHome,
  slackIngressRetryable,
  slackReconnectRequired,
};
