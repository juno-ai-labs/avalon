import type { WorkspaceNotificationIntentDelivery } from "../durable-objects/workspace-notification-intent-protocol";
import { enqueuePushDelivery } from "./push-delivery-service";
import { asSubstreamId, asUserId, asWorkspaceId } from "@rally/contracts";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { logInfo, logWarn } from "../observability/logger";
import {
  ParentEffectEnvelopeSchema,
  WorkstreamMentionNotificationEffectSchema,
  WorkstreamParticipantNotificationEffectSchema,
  conversationEffectHash,
  isDirectoryEffect,
  type ParentEffectEnvelope,
} from "@rally/contracts/conversation-effects";
import { workspaceDOName } from "../durable-objects/names";
import {
  WorkspaceDirectoryNotificationStateSchema,
  WorkspaceRegionalEffectApplyResultSchema,
} from "../durable-objects/workspace-directory-protocol";
import {
  WorkspaceNotificationIntentClaimResultSchema,
  WorkspaceNotificationIntentTransitionResultSchema,
  type WorkspaceNotificationIntentTransitionRequest,
  type WorkspaceNotificationIntentTransitionResult,
} from "../durable-objects/workspace-notification-intent-protocol";
import { conversationLink } from "./conversation-link-service";
import { sendWorkstreamMentionEmail } from "./mention-email-service";
import { sendWorkstreamParticipantAddedEmail } from "./participant-email-service";
import {
  sendWorkstreamMentionSlack,
  sendWorkstreamParticipantAddedSlack,
} from "./slack-notification-service";
import { workspaceRegionalDatabase } from "./workspace-runtime-database";

interface NotificationRecipientIdentity {
  recipient_email: string;
  recipient_name: string;
  workspace_name: string;
}

interface NotificationIntentTransitionPort {
  transitionWorkstreamNotificationIntent(
    input: WorkspaceNotificationIntentTransitionRequest,
  ): Promise<unknown>;
}

export interface WorkstreamRegionalEffectResult {
  replayed: boolean;
  notificationIntentId: string | null;
}

/**
 * Apply one parent's activity or notification effect to the regional delivery
 * plane. Product state commits idempotently in WorkspaceDO together with its
 * receipt; a redelivery converges on the same event or intent identity.
 * Directory effects never enter here.
 */
export async function applyWorkstreamRegionalEffect(
  env: Env,
  input: ParentEffectEnvelope,
): Promise<WorkstreamRegionalEffectResult> {
  const message = ParentEffectEnvelopeSchema.parse(input);
  if (message.region !== env.AVALON_REGION) throw new Error("workstream_effect_region_mismatch");
  if (
    conversationEffectHash(message.effect, message.requiredProjectionVersion)
    !== message.payloadHash
  ) {
    throw new Error("workstream_effect_payload_hash_mismatch");
  }
  if (isDirectoryEffect(message.effect) || message.effect.kind === "directory_automation" || message.effect.kind === "scope_grant_directory") {
    throw new Error("workspace_owned_effect_misdirected_to_regional_queue");
  }

  const route = await env.DB.prepare(
    `SELECT generation, state FROM workstream_authority_routes
      WHERE workspace_id = ? AND workstream_id = ?`,
  ).bind(message.workspaceId, message.parentId).first<{ generation: number; state: string }>();
  if (route?.state === "active" && route.generation > message.generation) {
    // A previous authority generation can still have Queue messages in flight.
    // Its state was superseded at cutover, so acknowledging it is the only
    // terminal and safe outcome; applying it would regress the current owner.
    logInfo(env, "workstream_regional_effect_apply_terminal", {
      workspace_id: message.workspaceId,
      workstream_id: message.parentId,
      message_id: message.messageId,
      effect_kind: message.effect.kind,
      outcome: "skipped",
      reason: "authority_generation_superseded",
      message_generation: message.generation,
      active_generation: route.generation,
    });
    return { replayed: true, notificationIntentId: null };
  }
  if (route?.state !== "active" || route.generation !== message.generation) {
    throw new Error("workstream_effect_route_not_active");
  }

  // Current regional identity crosses into the object as data: the actor and
  // targets that still exist, and whether the mention recipient is still an
  // active member. The object commits the product row and its replay receipt
  // in one transaction — invariant 14's "effect and receipt together" — so
  // there is no longer a regional D1 receipt that can disagree with it. A
  // same-source re-emission under a new message ID converges on the product
  // identities (event dedupe key, intent identity) instead of a receipt row.
  let actorUserId: string | null = null;
  let targetUserIds: string[] = [];
  let recipientIsActiveMember = false;
  if (message.effect.kind === "activity_event") {
    const effect = message.effect;
    const currentActor = effect.actorUserId
      ? await env.DB.prepare(`SELECT id FROM users WHERE id = ?`)
        .bind(effect.actorUserId).first<{ id: string }>()
      : null;
    actorUserId = currentActor?.id ?? null;
    if (effect.targets.length > 0) {
      const placeholders = effect.targets.map(() => "?").join(",");
      const users = await env.DB.prepare(
        `SELECT id FROM users WHERE id IN (${placeholders})`,
      ).bind(...effect.targets.map((target) => target.userId)).all<{ id: string }>();
      targetUserIds = (users.results ?? []).map((user) => user.id);
    }
  } else {
    const activeMember = await env.DB.prepare(
      `SELECT 1 FROM workspace_members
        WHERE workspace_id = ? AND user_id = ? AND status = 'active'`,
    ).bind(message.workspaceId, message.effect.recipientUserId).first();
    recipientIsActiveMember = Boolean(activeMember);
  }

  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    message.workspaceId,
    workspaceDOName(message.region, message.workspaceId),
  );
  const applied = WorkspaceRegionalEffectApplyResultSchema.parse(
    await workspace.applyWorkstreamRegionalEffect({
      workspaceId: message.workspaceId,
      envelope: message,
      actorUserId,
      targetUserIds,
      recipientIsActiveMember,
    }),
  );

  if (message.effect.kind !== "activity_event" && !applied.notificationIntentId) {
    logInfo(env, "workstream_notification_terminal", {
      workspace_id: message.workspaceId,
      workstream_id: message.parentId,
      message_id: message.messageId,
      kind: message.effect.kind,
      recipient_user_id: message.effect.recipientUserId,
      outcome: "skipped",
      reason: recipientIsActiveMember ? "notification_intent_not_created" : "recipient_inactive",
      replayed: applied.replayed,
    });
  }

  return {
    replayed: applied.replayed,
    notificationIntentId: applied.notificationIntentId,
  };
}

/** Resolve current regional identity/delivery state and execute one intent. */
export async function notificationDeliveryContext(env: Env, row: WorkspaceNotificationIntentDelivery) {
  const typedWorkspaceId = asWorkspaceId(row.workspaceId);
  const workspaceId = row.workspaceId;
  const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, typedWorkspaceId, workspaceDOName(env.AVALON_REGION, typedWorkspaceId));
  const identity = await workspaceRegionalDatabase(env).prepare(
    `SELECT user.email AS recipient_email, user.name AS recipient_name,
            workspace.name AS workspace_name
       FROM users user JOIN workspaces workspace ON workspace.id = ?
       JOIN workspace_members member ON member.workspace_id = workspace.id
        AND member.user_id = user.id AND member.status = 'active'
      WHERE user.id = ?`,
  ).bind(workspaceId, row.recipientUserId).first<NotificationRecipientIdentity>();
  if (!identity) return { outcome: "skipped" as const, reason: "recipient_inactive_or_identity_missing" };
  const payload: unknown = JSON.parse(row.payloadJson);
  const participantAdded = row.notificationKind === "participant_added";
  const effect = participantAdded
    ? WorkstreamParticipantNotificationEffectSchema.parse(payload)
    : WorkstreamMentionNotificationEffectSchema.parse(payload);
  const childId = effect.substreamId && effect.substreamId !== "0" ? effect.substreamId : null;
  if (childId) {
    const parent = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, typedWorkspaceId,
      workspaceDOName(env.AVALON_REGION, asWorkspaceId(typedWorkspaceId)));
    const access = await parent.authorizeViewer({ workspaceId: typedWorkspaceId, parentId: row.workstreamId,
      userId: asUserId(row.recipientUserId), substreamId: asSubstreamId(childId) });
    if (!access.authorized || access.archived) {
      return { outcome: "skipped" as const, reason: "access_revoked" };
    }
  }

  const rawDirectoryState = await workspace.notificationDirectoryState({
    workspaceId: row.workspaceId,
    workstreamId: row.workstreamId,
    userId: row.recipientUserId,
  });
  const viewer = rawDirectoryState
    ? WorkspaceDirectoryNotificationStateSchema.parse(rawDirectoryState)
    : null;
  // Neither a Canvas nor a Sidekick: a retired Thread's intent, which nobody can open.
  if (!viewer) return { outcome: "skipped" as const, reason: "notification_parent_missing" };
  // The parent was replaced after the effect was written: wait for this
  // object to hear of the generation the conversation spoke from.
  if (viewer.authorityGeneration < row.sourceGeneration) {
    return { outcome: "pending" as const, reason: "notification_parent_generation_pending", viewer };
  }
  if (!childId && !viewer.listable) return { outcome: "skipped" as const, reason: "recipient_not_listable" };
  const originator = effect.kind === "mention_notification" ? effect.authorUserId : effect.actorUserId;
  if (effect.recipientUserId === originator) return { outcome: "skipped" as const, reason: "self_notification" };
  return { outcome: "ready" as const, identity, effect, childId, viewer };
}

export async function processWorkstreamNotificationIntent(
  env: Env,
  workspaceId: string,
  intentId: string,
): Promise<"delivered" | "skipped" | "busy"> {
  const typedWorkspaceId = asWorkspaceId(workspaceId);
  const workspace = await durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    typedWorkspaceId,
    workspaceDOName(env.AVALON_REGION, typedWorkspaceId),
  );
  const claim = WorkspaceNotificationIntentClaimResultSchema.parse(
    await workspace.claimWorkstreamNotificationIntent({ workspaceId: typedWorkspaceId, intentId }),
  );
  if (claim.outcome === "missing") {
    logInfo(env, "workstream_notification_terminal", {
      workspace_id: workspaceId,
      notification_intent_id: intentId,
      outcome: "skipped",
      reason: "notification_intent_missing",
    });
    return "skipped";
  }
  if (claim.outcome === "terminal") {
    logInfo(env, "workstream_notification_terminal", {
      workspace_id: workspaceId,
      workstream_id: claim.intent.workstreamId,
      notification_intent_id: intentId,
      kind: claim.intent.notificationKind,
      recipient_user_id: claim.intent.recipientUserId,
      outcome: claim.intent.state,
      reason: claim.intent.state === "delivered"
        ? "notification_already_delivered"
        : "notification_already_skipped",
      replayed: true,
    });
    return claim.intent.state;
  }
  if (claim.outcome === "busy") {
    logInfo(env, "workstream_notification_deferred", {
      workspace_id: workspaceId,
      workstream_id: claim.intent.workstreamId,
      notification_intent_id: intentId,
      kind: claim.intent.notificationKind,
      recipient_user_id: claim.intent.recipientUserId,
      outcome: "busy",
      reason: "notification_lease_active",
      state: claim.intent.state,
    });
    return "busy";
  }

  const row = claim.intent;
  const leaseId = claim.leaseId;
  const context = await notificationDeliveryContext(env, row);
  if (context.outcome !== "ready") {
    if (context.outcome === "pending") {
      const transition = await transitionNotificationIntent(workspace, {
        workspaceId: typedWorkspaceId, intentId, leaseId, transition: "defer", errorCode: context.reason,
      });
      logInfo(env, "workstream_notification_deferred", {
        workspace_id: row.workspaceId, workstream_id: row.workstreamId, notification_intent_id: intentId,
        kind: row.notificationKind, recipient_user_id: row.recipientUserId,
        outcome: transition.outcome === "applied" ? "busy" : transition.outcome,
        reason: transition.outcome === "applied" ? context.reason : "notification_lease_lost_before_defer",
        required_generation: row.sourceGeneration, current_generation: context.viewer?.authorityGeneration ?? null,
        current_state: transition.outcome === "lease_lost" ? transition.state : null,
      });
      if (transition.outcome === "lease_lost" && (transition.state === "delivered" || transition.state === "skipped")) return transition.state;
    } else {
      await requireNotificationIntentTransition(workspace, { workspaceId: typedWorkspaceId, intentId, leaseId, transition: "settle", state: "skipped" });
    }
    if (context.outcome === "skipped") logInfo(env, "workstream_notification_terminal", {
      workspace_id: workspaceId, workstream_id: row.workstreamId, notification_intent_id: intentId,
      kind: row.notificationKind, recipient_user_id: row.recipientUserId, outcome: "skipped", reason: context.reason,
    });
    return context.outcome === "pending" ? "busy" : "skipped";
  }
  const { identity, effect, childId, viewer } = context;
  try {
    // Each channel the person chose for this kind, and only those. Nothing
    // falls back to another: an empty choice means Activity and the digest.
    const preferences = await workspace.memberPreferences({ workspaceId: typedWorkspaceId, userId: row.recipientUserId });
    const channels = preferences.notify[row.notificationKind === "participant_added" ? "added" : "mentions"];
    // One lookup for the Slack and email transports, which both carry the
    // Canvas's or Sidekick's link; a Thread has none, so neither sends.
    const link = channels.includes("slack_agent_dm") || channels.includes("email")
      ? await conversationLink(env, { region: env.AVALON_REGION, workspaceId: row.workspaceId, parentId: row.workstreamId })
      : null;
    const linkless = link !== null && link.url === null;
    const push = channels.includes("push") && await enqueuePushDelivery(env, { region: env.AVALON_REGION, workspaceId: row.workspaceId,
      recipientUserId: row.recipientUserId, intentId });
    const recipient = {
      recipientUserId: effect.recipientUserId,
      recipientEmail: identity.recipient_email,
      workspaceId: row.workspaceId,
      workspaceName: identity.workspace_name,
      workstreamId: row.workstreamId,
      workstreamTitle: effect.workstreamTitleSnapshot,
      ...(childId ? { substreamId: childId } : {}),
      ...(link?.url ? { url: link.url } : {}),
    };
    const sourceId = effect.kind === "participant_notification" ? effect.sourceId : effect.messageId;
    const slack = !channels.includes("slack_agent_dm") || linkless ? "skipped" as const
      : effect.kind === "participant_notification"
      ? await sendWorkstreamParticipantAddedSlack(env, {
        ...recipient,
        sourceId: effect.sourceId,
        actorName: effect.actorNameSnapshot,
        workstreamObjective: effect.workstreamObjectiveSnapshot,
        titleIsProvisional: effect.titleIsProvisional,
      })
      : await sendWorkstreamMentionSlack(env, {
        ...recipient,
        messageId: effect.messageId,
        authorName: effect.authorNameSnapshot,
        messageText: effect.messageText,
      });
    logInfo(env, "workstream_notification_transport_terminal", {
      workspace_id: row.workspaceId,
      workstream_id: row.workstreamId,
      notification_intent_id: intentId,
      kind: row.notificationKind,
      source_id: sourceId,
      recipient_user_id: effect.recipientUserId,
      channel: "slack",
      outcome: slack,
      reason: slack === "sent" ? "provider_accepted" : !channels.includes("slack_agent_dm") ? "channel_not_chosen"
        : linkless ? "conversation_not_linkable" : "not_delivered",
      ...(linkless ? { parent_kind: link.kind ?? "missing" } : {}),
    });
    let email: "sent" | "skipped" | null = null;
    if (channels.includes("email") && linkless) {
      email = "skipped";
      logInfo(env, "workstream_notification_transport_terminal", {
        workspace_id: row.workspaceId, workstream_id: row.workstreamId, notification_intent_id: intentId,
        kind: row.notificationKind, source_id: sourceId, recipient_user_id: effect.recipientUserId,
        channel: "email", outcome: email, reason: "conversation_not_linkable", parent_kind: link.kind ?? "missing",
      });
    } else if (channels.includes("email")) {
      const fallback = {
        ...recipient,
        recipientName: identity.recipient_name,
        workstreamEmailAddress: viewer.emailAddress,
        region: env.AVALON_REGION,
      };
      if (effect.kind === "participant_notification") {
        email = await sendWorkstreamParticipantAddedEmail(env, {
          ...fallback,
          sourceId: effect.sourceId,
          actorName: effect.actorNameSnapshot,
          workstreamObjective: effect.workstreamObjectiveSnapshot,
          titleIsProvisional: effect.titleIsProvisional,
        });
      } else {
        email = await sendWorkstreamMentionEmail(env, {
          ...fallback,
          messageId: effect.messageId,
          authorName: effect.authorNameSnapshot,
          messageText: effect.messageText,
        });
      }
      logInfo(env, "workstream_notification_transport_terminal", {
        workspace_id: row.workspaceId,
        workstream_id: row.workstreamId,
        notification_intent_id: intentId,
        kind: row.notificationKind,
        source_id: sourceId,
        recipient_user_id: effect.recipientUserId,
        channel: "email",
        outcome: email,
        reason: email === "sent" ? "provider_accepted" : "transport_disabled_for_environment",
      });
    }
    await requireNotificationIntentTransition(workspace, {
      workspaceId: typedWorkspaceId,
      intentId,
      leaseId,
      transition: "settle",
      state: "delivered",
      retainPayload: push,
    });
    logInfo(env, "workstream_notification_terminal", {
      workspace_id: row.workspaceId,
      workstream_id: row.workstreamId,
      notification_intent_id: intentId,
      kind: row.notificationKind,
      source_id: sourceId,
      recipient_user_id: effect.recipientUserId,
      outcome: "delivered",
      reason: channels.length ? "chosen_channels_attempted" : "no_channel_chosen",
      channels: channels.join(","),
      push_enqueued: push,
      slack_outcome: slack,
      email_outcome: email,
    });
    return "delivered";
  } catch (error) {
    const code = error instanceof ApiError ? error.code : "notification_delivery_failed";
    const transition = await transitionNotificationIntent(workspace, {
      workspaceId: typedWorkspaceId,
      intentId,
      leaseId,
      transition: "fail",
      errorCode: code,
    });
    logWarn(env, "workstream_notification_failed", {
      workspace_id: row.workspaceId,
      workstream_id: row.workstreamId,
      notification_intent_id: intentId,
      kind: row.notificationKind,
      recipient_user_id: row.recipientUserId,
      outcome: "failed",
      reason: code,
      error_name: error instanceof Error ? error.name : "Error",
      transition_outcome: transition.outcome,
      current_state: transition.outcome === "lease_lost" ? transition.state : null,
    });
    throw error;
  }
}

async function transitionNotificationIntent(
  workspace: NotificationIntentTransitionPort,
  input: WorkspaceNotificationIntentTransitionRequest,
): Promise<WorkspaceNotificationIntentTransitionResult> {
  return WorkspaceNotificationIntentTransitionResultSchema.parse(
    await workspace.transitionWorkstreamNotificationIntent(input),
  );
}

async function requireNotificationIntentTransition(
  workspace: NotificationIntentTransitionPort,
  input: WorkspaceNotificationIntentTransitionRequest,
): Promise<void> {
  const result = await transitionNotificationIntent(workspace, input);
  if (result.outcome === "applied") return;
  if (
    input.transition === "settle"
    && result.outcome === "lease_lost"
    && result.state === input.state
  ) return;
  throw new Error(`workstream_notification_transition_not_applied:${result.outcome}`);
}
